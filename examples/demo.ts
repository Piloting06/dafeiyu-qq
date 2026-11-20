// Synthetic SDK events only: no QQ connection, network call, model, or real funds.
import assert from 'node:assert/strict';
import { QQBot, runMiddlewareChain } from '@tencent-connect/qqbot-nodejs';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { createMiddlewareContext } from '../node_modules/@tencent-connect/qqbot-nodejs/dist/middleware/types.js';
import { closedPolicy, createCommunityMiddleware } from '../src/adapter.ts';
import type { OfficialRequest, BusinessReply } from '../src/adapter.ts';

const appId = '123456';
const group = 'SYNTHETIC_GROUP';
let clock = Date.parse('2026-01-01T12:00:00+08:00');
let bound = false, claimed = false, checked = false, cents = 0;
const noLog = { debug() {}, info() {}, warn() {}, error() {} };
const bot = new QQBot({ appId, appSecret: 'synthetic-unused', logger: noLog });
const replies: string[] = [];
bot.sendMarkdown = async (_target, text) => { replies.push(text); return { id: 'synthetic' } as never; };
const execute = async (request: OfficialRequest): Promise<BusinessReply> => {
  if (!bound) {
    if (!request.user_id) return { status: 'need_id', reply: '带上自己的示例 ID 再发一次就好啦 🐟' };
    if (request.user_id !== '42') return { status: 'invalid', reply: '演示只有合成账号 42 哦～' };
    bound = true;
  }
  if (request.action === 'balance') return { status: 'balance', reply: `演示余额：${(cents / 100).toFixed(2)} 点` };
  if (request.action === 'claim') {
    if (claimed) return { status: 'already', reply: '这份演示福利已经领过啦～' };
    claimed = true; cents += 500;
    return { status: 'credited', reply: '演示福利到账 5.00 点 🐟' };
  }
  if (request.action === 'checkin') {
    if (checked) return { status: 'already_checkin', reply: '今天已经签过到啦～' };
    checked = true; cents += 3;
    return { status: 'checked_in', reply: '演示签到获得 0.03 点 ☀️' };
  }
  return { reply: '', silent: true };
};
const middleware = createCommunityMiddleware({
  appId, now: () => clock, sleep: async () => {}, execute,
  policy: () => ({ ...closedPolicy, enabled: true, claim_enabled: true, checkin_enabled: true,
    balance_enabled: true, quiet_enabled: false, allowed_groups: [group],
    reply_interval_ms: 0, group_interval_ms: 0, user_cooldown_ms: 15000 }),
});
console.log('大肥鱼 · 离线演示（合成事件、内存积分；无任何外部连接）\n');
for (const [i, content] of ['帮助', '领取', '领取42', '领取', '签到', '签到', '余额'].entries()) {
  // Complete a missing ID immediately. Other scripted steps advance the fake clock.
  if (i !== 2) clock += 16000;
  const message = { kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    senderId: 'SYNTHETIC_MEMBER', groupOpenid: group, messageId: `demo-${i}`,
    timestamp: new Date(clock).toISOString(), content,
    replyTarget: { scope: 'group', targetId: group, msgId: `demo-${i}` },
  } as QQBotInboundMessage;
  const before = replies.length;
  await runMiddlewareChain([middleware, async () => { assert.fail('escaped into host agent'); }],
    createMiddlewareContext({ bot, message, log: noLog }));
  assert.equal(replies.length, before + 1);
  assert.match(replies.at(-1)!, /^<qqbot-at-user id="SYNTHETIC_MEMBER" \/>/);
  console.log(`用户：@大肥鱼 ${content}\n大肥鱼：${replies.at(-1)!.split('\n').slice(1).join('\n')}\n`);
}
assert.equal(cents, 503);
assert.equal(replies.length, 7);
console.log('✓ 首次补ID、活动去重、同日签到去重、本人余额、可信@：全部通过。');
console.log('演示数据随进程结束消失；生产账本必须由你自己的业务后端实现。');
