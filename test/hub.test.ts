import test from 'node:test';
import assert from 'node:assert/strict';
import { HubClient, hubPolicy, type HubSnapshot } from '../src/hub.ts';
import { createJoinHandler } from '../src/join.ts';
import type { RawEventContext } from '@tencent-connect/qqbot-nodejs';
const token = async () => 'synthetic-bridge-token-000000000000000';
const snapshot: HubSnapshot = {
  config: {
    enabled: true,
    app_id: '123456',
    chat_enabled: true,
    persona: '合成身份',
    website_reply: '合成官网',
    groups: [{ openid: 'GROUP', enabled: true }],
  },
  policy: {
    enabled: true,
    binding_enabled: true,
    claim_enabled: true,
    checkin_enabled: true,
    help_enabled: true,
    join_enabled: true,
    quiet_enabled: false,
    quiet_start: 150,
    quiet_end: 420,
    reply_interval: 3,
    group_interval: 5,
    user_cooldown: 3600,
    queue_limit: 200,
    replies: { help: '合成帮助', paused: '未开放' },
  },
};
test('Hub capability uses fixed HTTPS endpoint, bearer auth, no redirects and no retries', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const h = new HubClient('https://hub.example/ignored', token, async (url, options) => {
    calls.push({ url: String(url), options: options! });
    return new Response(JSON.stringify({ success: true, data: snapshot }));
  });
  const p = hubPolicy(await h.snapshot(), '123456');
  assert.equal(p.user_cooldown_ms, 3600000);
  assert.equal(p.queue_limit, 200);
  assert.equal(p.help_reply, '合成帮助');
  assert.equal(p.enabled, true);
  assert.equal(calls[0]!.url, 'https://hub.example/api/qq-community/official/policy');
  assert.equal(calls[0]!.options.redirect, 'error');
  assert.match((calls[0]!.options.headers as Record<string, string>).Authorization!, /^Bearer /);
  for (const url of ['http://example.com', 'https://name:password@example.com', 'file:///tmp/x'])
    assert.throws(() => new HubClient(url, token));
  assert.equal(hubPolicy(snapshot, '654321').enabled, false);
  let tries = 0;
  const broken = new HubClient('http://127.0.0.1:9000', token, async () => {
    tries++;
    throw Error('private upstream details');
  });
  await assert.rejects(() => broken.snapshot());
  assert.equal(tries, 1);
});
test('invalid and unsuccessful Hub results fail closed', async () => {
  for (const data of [
    { success: false, data: snapshot },
    { success: true, data: { reply: 4 } },
    { success: true, data: { reply: 'x', silent: 'yes' } },
    { success: true, data: { reply: 'x', status: { need_id: true } } },
    { success: true, data: { reply: 'x', status: 'need_id extra' } },
  ]) {
    const h = new HubClient(
      'https://hub.example',
      token,
      async () => new Response(JSON.stringify(data)),
    );
    await assert.rejects(() =>
      h.execute({
        protocol: 'dafeiyu.qq-official.v1',
        app_id: '123456',
        identity_scope: 'group_member',
        group_openid: 'GROUP',
        member_openid: 'MEMBER',
        event_key: 'a'.repeat(64),
        sent_at: 1,
        action: 'checkin',
        user_id: '1',
      }),
    );
  }
});
function joinHarness() {
  let now = Date.parse('2026-11-19T12:00:00+08:00');
  let fail = false;
  let enabled = true;
  let attempted = false;
  const bodies: { path: string; body: Record<string, unknown> }[] = [];
  const approvals: unknown[] = [];
  const hub = new HubClient('https://hub.example', token, async (url, init) => {
    const path = new URL(String(url)).pathname.split('/').slice(-2).join('/');
    const body = JSON.parse(String(init!.body));
    bodies.push({ path, body });
    let data: unknown = {};
    if (path === 'official/policy') data = { ...snapshot, config: { ...snapshot.config, enabled } };
    if (path === 'official/join') {
      data = { key: 'b'.repeat(64), status: attempted ? 'hold' : 'approve' };
      attempted = true;
    }
    return new Response(JSON.stringify({ success: true, data }));
  });
  const handler = createJoinHandler(
    '123456',
    hub,
    { currentAccess: () => ({ groupMode: 'allowlist', groupAllow: ['GROUP'] }) },
    () => now,
  );
  const ctx = {
    bot: {
      appId: '123456',
      api: {
        post: async (path: string, body: unknown) => {
          approvals.push({ path, body });
          if (fail) throw Error('private');
          return {};
        },
      },
    },
    eventType: 'GROUP_JOIN_REQUEST',
    receivedAt: now,
    state: {},
    data: {
      group_openid: 'GROUP',
      member_openid: 'MEMBER',
      join_request_id: 'request1',
      apply_at: new Date(now).toISOString(),
      apply_source: 'self_apply',
      username: 'must-not-match-this',
      verify_info: { method: 'verify_message', verify_message: 'ID:528' },
    },
  } as unknown as RawEventContext;
  return {
    ctx,
    handler,
    bodies,
    approvals,
    advance: () => {
      now += 2000;
    },
    fail: () => {
      fail = true;
    },
    disable: () => {
      enabled = false;
    },
  };
}
test('admission uses verification answer, never QQ nickname; one approve attempt and result report', async () => {
  const h = joinHarness();
  await h.handler(h.ctx);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.bodies.find((b) => b.path === 'official/join')?.body.comment, 'ID:528');
  assert.equal(h.bodies.at(-1)?.body.status, 'approved');
  h.advance();
  await h.handler(h.ctx);
  assert.equal(h.approvals.length, 1);
});
test('unknown admission result is recorded without retry or rejection', async () => {
  const h = joinHarness();
  h.fail();
  await h.handler(h.ctx);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.bodies.at(-1)?.body.status, 'unknown');
  h.advance();
  await h.handler(h.ctx);
  assert.equal(h.approvals.length, 1);
});
test('invites, multiple answers, automated approvals, risk flags, stale requests and disabled groups stay manual', async () => {
  for (const change of [
    { apply_source: 'invited' },
    {
      verify_info: {
        method: 'admin_review_qa',
        review_qa_list: [{ answer: '528' }, { answer: '529' }],
      },
    },
    { auto_approved: {} },
    { risk_tips: 'risk' },
    { apply_at: '2000-01-01T00:00:00Z' },
    { verify_info: { method: 'verify_message', verify_message: '' } },
  ]) {
    const h = joinHarness();
    await h.handler({ ...h.ctx, data: { ...(h.ctx.data as object), ...change } });
    assert.equal(h.approvals.length, 0);
    assert.equal(h.bodies.length, 0);
  }
  const h = joinHarness();
  h.disable();
  await h.handler(h.ctx);
  assert.equal(h.approvals.length, 0);
});

test('oversized streaming Hub responses are cancelled before unbounded buffering', async () => {
  let cancelled = false;
  const client = new HubClient('https://hub.example', token, async () => new Response(new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(32769)); }, cancel() { cancelled = true; },
  })));
  await assert.rejects(() => client.snapshot()); assert.equal(cancelled, true);
});

test('runtime capability names cannot be turned into arbitrary URLs', async () => {
  let called = false;
  const client = new HubClient('https://hub.example', token, async () => {called = true; return new Response('{}');});
  await assert.rejects(() => client.call('https://other.example' as 'policy'));
  assert.equal(called, false);
});
