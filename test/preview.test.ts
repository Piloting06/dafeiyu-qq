import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QQBot, runMiddlewareChain } from '@tencent-connect/qqbot-nodejs';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { createMiddlewareContext } from '../node_modules/@tencent-connect/qqbot-nodejs/dist/middleware/types.js';
import { createDafeiyuPreview } from '../src/preview.ts';
import { closedPolicy } from '../src/adapter.ts';

test('installed preview is closed without config and cannot enable model or money with JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dafeiyu-test-test-'));
  const previous = process.env.DAFEIYU_DSH_POLICY_FILE;
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const bot = new QQBot({ appId: '123456', appSecret: 'synthetic-only', logger: log });
  const sent: string[] = [];
  bot.sendMarkdown = async (_target, reply) => { sent.push(reply); return { id: 'synthetic' } as never; };
  let modelCalls = 0;
  let sequence = 0;
  const membership = { groupMode: 'allowlist', groupAllow: ['SYNTHETIC_GROUP'] };
  const access = { currentAccess: () => membership };
  const middleware = createDafeiyuPreview('123456', undefined, access);
  const run = async (content: string) => {
    const message = {
      kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderId: 'SYNTHETIC_MEMBER',
      groupOpenid: 'SYNTHETIC_GROUP', messageId: `synthetic-${++sequence}`,
      timestamp: new Date().toISOString(), content,
    } as QQBotInboundMessage;
    message.replyTarget = { scope: 'group', targetId: message.groupOpenid!, msgId: message.messageId };
    const ctx = createMiddlewareContext({ bot, message, log });
    await runMiddlewareChain([middleware, async () => { modelCalls++; }], ctx);
  };
  try {
    delete process.env.DAFEIYU_DSH_POLICY_FILE;
    await run('领取 528'); assert.equal(sent.length, 0);
    const file = join(directory, 'policy.json');
    process.env.DAFEIYU_DSH_POLICY_FILE = file;
    await writeFile(file, JSON.stringify({ ...closedPolicy, enabled: true, chat_enabled: true,
      claim_enabled: true, quiet_enabled: false, allowed_groups: ['SYNTHETIC_GROUP'],
      user_cooldown_ms: 0, group_interval_ms: 0, reply_interval_ms: 0,
      execute: 'pretend-to-enable-real-money' }));
    await run('讲个笑话'); assert.equal(modelCalls, 0);
    await run('领取 528'); assert.match(sent[0]!, /测试模式/);
    // Even with policy enabled, only the explicitly supplied text function can run.
    let textCalls = 0;
    const safe = createDafeiyuPreview('123456', async text => {
      assert.equal(text, '讲个笑话'); textCalls++; return { reply: '合成聊天回复' };
    }, access);
    const m = {
      kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', senderId: 'SYNTHETIC_MEMBER',
      groupOpenid: 'SYNTHETIC_GROUP', messageId: 'text-test', timestamp: new Date().toISOString(), content: '讲个笑话',
      replyTarget: { scope: 'group', targetId: 'SYNTHETIC_GROUP', msgId: 'text-test' },
    } as QQBotInboundMessage;
    await runMiddlewareChain([safe, async () => { assert.fail('host agent reached'); }], createMiddlewareContext({ bot, message: m, log }));
    assert.equal(textCalls, 1); assert.match(sent[1]!, /^<qqbot-at-user id="[^"]+" \/>\n合成聊天回复$/);
    for (const mode of ['disabled', 'open']) {
      membership.groupMode = mode;
      await run('帮助'); assert.equal(sent.length, 2);
    }
    membership.groupMode = 'allowlist'; membership.groupAllow = [];
    await run('帮助'); assert.equal(sent.length, 2);
    membership.groupAllow = ['SYNTHETIC_GROUP'];
    await writeFile(file, '{broken'); await run('帮助'); assert.equal(sent.length, 2);
  } finally {
    if (previous === undefined) delete process.env.DAFEIYU_DSH_POLICY_FILE;
    else process.env.DAFEIYU_DSH_POLICY_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
