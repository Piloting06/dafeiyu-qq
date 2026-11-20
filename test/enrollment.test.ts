import test from 'node:test';
import assert from 'node:assert/strict';
import { QQBot, runMiddlewareChain } from '@tencent-connect/qqbot-nodejs';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { createMiddlewareContext } from '../node_modules/@tencent-connect/qqbot-nodejs/dist/middleware/types.js';
import { createGroupEnrollment } from '../src/enrollment.ts';
import { closedPolicy, createCommunityMiddleware } from '../src/adapter.ts';

function fixture() {
  const now = Date.parse('2026-11-19T12:00:00+08:00');
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const bot = new QQBot({ appId: '123456', appSecret: 'synthetic-only', logger: log });
  const replies: string[] = [];
  const groups: string[] = [];
  let purpose = 'allow-group'; let active = true; let failStore = false; let failSend = false;
  let calls = 0;
  bot.sendMarkdown = async (_target, text) => {
    if (failSend) throw new Error('sensitive-send-error');
    replies.push(text); return { id: 'synthetic' } as never;
  };
  const service = {
    pairing: { validate: (code: string) => ({ ok: active && code === 'SYNTHETIC_CODE', purpose }) },
    beginClaimFromMessage: (_scope: 'group', peerId: string) => {
      calls++; if (failStore) throw new Error('sensitive-store-error');
      groups.push(peerId); return { ok: true };
    },
    endPairCode: () => { active = false; },
  };
  const chain = [createGroupEnrollment('123456', service, () => now),
    createCommunityMiddleware({ appId: '123456', policy: () => closedPolicy, now: () => now }),
    async () => { assert.fail('message reached upstream agent'); }];
  let sequence = 0;
  async function run(changes: Partial<QQBotInboundMessage> = {}, abort = false) {
    const message = { kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      groupOpenid: 'SYNTHETIC_GROUP', senderId: 'SYNTHETIC_USER', messageId: `event-${++sequence}`,
      timestamp: new Date(now).toISOString(), content: '<@!123456> SYNTHETIC_CODE',
      ...changes } as QQBotInboundMessage;
    message.replyTarget = { scope: 'group', targetId: message.groupOpenid!, msgId: message.messageId };
    const ctx = createMiddlewareContext({ bot, message, log });
    if (abort) Object.defineProperty(ctx, 'signal', { value: AbortSignal.abort() });
    await runMiddlewareChain(chain, ctx);
  }
  return { run, replies, groups, calls: () => calls, active: () => active,
    setPurpose: (p: string) => { purpose = p; }, expire: () => { active = false; },
    failStore: () => { failStore = true; }, failSend: () => { failSend = true; } };
}

test('fresh group invitation records one group and stops before the closed business gate', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.groups, ['SYNTHETIC_GROUP']); assert.equal(f.active(), false);
  assert.match(f.replies[0]!, /^<qqbot-at-user id="SYNTHETIC_USER" \/>\n/);
  assert.match(f.replies[0]!, /没有绑定站内账号或发放赠金/);
  await f.run({ groupOpenid: 'OTHER_GROUP' });
  assert.equal(f.calls(), 1); assert.equal(f.replies.length, 1);
});

test('private, unmentioned, stale, attachment and cancelled messages cannot register groups', async () => {
  const f = fixture();
  for (const change of [{ kind: 'c2c' }, { rawEventType: 'GROUP_MESSAGE_CREATE' },
    { timestamp: '2026-11-18T12:00:00+08:00' }, { content: '<@other> SYNTHETIC_CODE' },
    { attachments: [{ content_type: 'image/png' }] }]) {
    await f.run(change as Partial<QQBotInboundMessage>);
  }
  await f.run({}, true);
  assert.equal(f.calls(), 0); assert.equal(f.replies.length, 0);
});

test('command-owner and private-chat invitations grant nothing', async () => {
  const f = fixture();
  for (const p of ['owner', 'allow-c2c']) { f.setPurpose(p); await f.run(); }
  assert.equal(f.calls(), 0); assert.equal(f.replies.length, 0);
});

test('expired or wrong invitation cannot register a group or enter agent', async () => {
  const f = fixture(); await f.run({ content: 'wrong-code' }); f.expire(); await f.run();
  assert.equal(f.calls(), 0); assert.equal(f.replies.length, 0);
});

test('concurrent messages consume an invitation only once, including an uncertain reply', async () => {
  const f = fixture(); f.failSend();
  await Promise.all([f.run(), f.run({ groupOpenid: 'OTHER_GROUP' })]);
  assert.equal(f.calls(), 1); assert.equal(f.active(), false); assert.equal(f.replies.length, 0);
});

test('storage failure gives no success reply or raw diagnostic', async () => {
  const f = fixture(); f.failStore(); await f.run();
  assert.equal(f.groups.length, 0); assert.equal(f.replies.length, 0);
});

test('full-message group requires platform-marked self mention for enrollment', async () => {
  const f = fixture();
  await f.run({ rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [{ is_you: false }] });
  await f.run({ rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [{ is_you: 'true' as never }] });
  assert.equal(f.calls(), 0);
  await f.run({ rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [{ is_you: true }] });
  assert.equal(f.calls(), 1); assert.equal(f.replies.length, 1);
});

test('opt-in enrollment diagnostics contain only fixed stages and booleans', async () => {
  const previous = process.env.DAFEIYU_ENROLLMENT_DIAGNOSTICS;
  const original = console.info; const output: string[] = [];
  process.env.DAFEIYU_ENROLLMENT_DIAGNOSTICS = '1';
  console.info = (...values: unknown[]) => { output.push(values.map(String).join(' ')); };
  try {
    const f = fixture(); await f.run();
    const failed = fixture(); failed.failStore(); await failed.run();
    assert.ok(output.some(line => line.includes('received')));
    assert.ok(output.some(line => line.includes('failed')));
    assert.ok(output.every(line => !/SYNTHETIC|sensitive|123456/.test(line)));
    for (const line of output) {
      const flags = JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>;
      assert.ok(Object.values(flags).every(value => typeof value === 'boolean'));
    }
  } finally {
    console.info = original;
    if (previous === undefined) delete process.env.DAFEIYU_ENROLLMENT_DIAGNOSTICS;
    else process.env.DAFEIYU_ENROLLMENT_DIAGNOSTICS = previous;
  }
});
