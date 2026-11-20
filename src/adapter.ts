import { websiteURL } from './site.ts';
import { createHash } from 'node:crypto';
import { addressGroupReply, unsupportedReply, uncertainReply } from './replies.ts';
import type { Middleware, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

const opaqueID = /^[A-Za-z0-9_-]{1,128}$/;
const campaignID = /^[a-z0-9-]{1,48}$/;
const ttl = 60_000;
const clockSkew = 5_000;

export interface Policy {
  enabled: boolean;
  chat_enabled: boolean;
  claim_enabled: boolean;
  checkin_enabled: boolean;
  balance_enabled?: boolean;
  help_enabled: boolean;
  quiet_enabled: boolean;
  quiet_start: number;
  quiet_end: number;
  allowed_groups: string[];
  reply_interval_ms: number;
  group_interval_ms: number;
  user_cooldown_ms: number;
  queue_limit: number;
  persona?: string;
  help_reply?: string;
  website_reply?: string;
  paused_reply?: string;
}

// Deliberately not QQGroupRequest: OpenIDs must never be converted into QQ numbers.
// The Hub integration must resolve this scope and preserve legacy ledger history.
export interface OfficialRequest {
  protocol: 'dafeiyu.qq-official.v1';
  app_id: string;
  identity_scope: 'group_member';
  group_openid: string;
  member_openid: string;
  event_key: string;
  sent_at: number;
  action: 'claim' | 'checkin' | 'help' | 'website' | 'balance';
  user_id: string;
  campaign?: string;
}

export interface BusinessReply { reply: string; silent?: boolean; status?: string }
export interface Options {
  appId: string;
  policy: () => Policy | Promise<Policy>;
  // No default money endpoint. Installed preview never supplies this callback.
  execute?: (request: OfficialRequest) => Promise<BusinessReply>;
  // Text-only callback. Never forward public messages into the host agent pipeline.
  chat?: (text: string, signal: AbortSignal, policy?: Policy) => Promise<BusinessReply>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const closedPolicy: Policy = {
  enabled: false, chat_enabled: false, claim_enabled: false,
  checkin_enabled: false, help_enabled: true, quiet_enabled: true,
  quiet_start: 150, quiet_end: 420, allowed_groups: [],
  reply_interval_ms: 3000, group_interval_ms: 5000,
  user_cooldown_ms: 15000, queue_limit: 50,
};

export function validatePolicy(value: unknown): Policy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid policy');
  const p = value as Policy;
  if (p.balance_enabled !== undefined && typeof p.balance_enabled !== 'boolean') throw new Error('invalid balance policy');
  for (const key of ['enabled', 'chat_enabled', 'claim_enabled', 'checkin_enabled', 'help_enabled', 'quiet_enabled'] as const) {
    if (typeof p[key] !== 'boolean') throw new Error('invalid policy');
  }
  for (const key of ['quiet_start', 'quiet_end'] as const) {
    if (!Number.isInteger(p[key]) || p[key] < 0 || p[key] > 1439) throw new Error('invalid quiet time');
  }
  for (const key of ['reply_interval_ms', 'group_interval_ms', 'user_cooldown_ms'] as const) {
    if (!Number.isInteger(p[key]) || p[key] < 0 || p[key] > 3_600_000) throw new Error('invalid interval');
  }
  if (!Number.isInteger(p.queue_limit) || p.queue_limit < 1 || p.queue_limit > 200) throw new Error('invalid queue');
  if (!Array.isArray(p.allowed_groups) || p.allowed_groups.length > 100 ||
      p.allowed_groups.some(id => typeof id !== 'string' || !opaqueID.test(id))) throw new Error('invalid groups');
  for (const key of ['persona','help_reply','website_reply','paused_reply'] as const) {
    if (p[key] !== undefined && (typeof p[key] !== 'string' || p[key]!.length > (key === 'persona' ? 3000 : 1500))) throw new Error('invalid text');
  }
  return { ...p, allowed_groups: [...p.allowed_groups] };
}

export function isQuiet(p: Policy, now: number): boolean {
  if (!p.quiet_enabled) return false;
  const d = new Date(now + 8 * 3600_000);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  // Equal endpoints are all-day quiet, matching existing Hub policy behavior.
  return p.quiet_start < p.quiet_end
    ? minute >= p.quiet_start && minute < p.quiet_end
    : minute >= p.quiet_start || minute < p.quiet_end;
}

const clockText = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
export function quietReply(p: Policy, action: string): string {
  const operation = action === 'claim' ? '领取活动福利' : '签到';
  if (p.quiet_start === p.quiet_end) return `鱼鱼休息中 💤 目前不能${operation}，恢复时间请留意群内通知呀～`;
  return `鱼鱼休息中 💤
现在不能${operation}，请在北京时间 ${clockText(p.quiet_end)} 后再来呀～
这次还没有${operation}，醒来后记得再找我呀～`;
}
export function helpReply(p: Policy, body: string): string {
  if (!p.quiet_enabled) return body;
  const hours = p.quiet_start === p.quiet_end ? '全天' : `${clockText(p.quiet_start)}—${clockText(p.quiet_end)}`;
  return `${body}\n\n💤 北京时间 ${hours}，鱼鱼休息，暂不签到、领福利或陪聊。\n打个招呼、查帮助和网址${p.balance_enabled ? "、查余额" : ""}都可以哦～`;
}

type Command = Pick<OfficialRequest, 'action' | 'user_id' | 'campaign'>;
type Parsed = Command | 'chat' | 'invalid' | 'unsupported';

// Accept whole, unambiguous commands only. Prose/negation/multiple accounts
// never become a money operation, even when they contain a command keyword.
export function parseCommand(content: string): Parsed {
  if (!content.trim()) return { action: 'checkin', user_id: '' };
  const text = content.normalize('NFKC').trim().replace(/[!。~～]+$/u, '').trim();
  if (!text) return 'chat';
  if (/^(帮助|help)$/i.test(text)) return { action: 'help', user_id: '' };
  if (/^(余额|查询余额|查余额|我的余额|余额查询)$/.test(text)) return { action: 'balance', user_id: '' };
  if (/余额/.test(text) && /[0-9]|ID|别人的|他人/i.test(text)) return 'invalid';
  if (['网站', '网址', '官网', '网站多少'].includes(text)) return { action: 'website', user_id: '' };
  const id = '(?:[A-Za-z]11[0-9]{4}|[1-9][0-9]{0,18})';
  const label = '(?:(?:(?:用户|站内|中转站)\\s*)?ID\\s*[:：]?\\s*|编号\\s*[:：]?\\s*|#)?';
  const account = `${label}(${id})`;
  const claim = '(?:领取(?:福利)?|领福利)';
  const checkin = '(?:签到|打卡)';
  if (new RegExp(`^${claim}$`).test(text)) return { action: 'claim', user_id: '' };
  if (new RegExp(`^${checkin}$`).test(text)) return { action: 'checkin', user_id: '' };
  // Preserve the explicit named-campaign syntax; never infer campaign from chat.
  const named = text.match(new RegExp(`^领取\\s+(${id})\\s+([a-z0-9-]{1,48})$`, 'i'));
  if (named && campaignID.test(named[2]!)) return { action: 'claim', user_id: named[1]!, campaign: named[2]! };
  for (const [verb, action] of [[claim, 'claim'], [checkin, 'checkin']] as const) {
    const match = text.match(new RegExp(`^${verb}\\s*[:：]?\\s*${account}$`, 'i'))
      ?? text.match(new RegExp(`^${account}\\s*${verb}$`, 'i'));
    if (match) return { action, user_id: match[1]! };
  }
  const only = text.match(new RegExp(`^${account}$`, 'i'));
  if (only) return { action: 'checkin', user_id: only[1]! };
  if (/[?？]|有什么|为什么|怎么|以后|是不是|能不能/.test(text)) return 'chat';
  // Deterministic guidance for attempted business requests, not model-generated
  // claims that the user forgot to @ or that a binding/credit already happened.
  if (/领取|领福利|签到|打卡|绑定|^(?:(?:用户|站内|中转站)\s*)?ID(?:[\s:：0-9]|$)|^[A-Za-z]11|^[0-9]+$|^\//i.test(text)) return 'invalid';
  return 'chat';
}

export function greetingReply(text: string, now = Date.now()): string | undefined {
  const greeting = text.normalize('NFKC').trim().replace(/[，,。.!！~～\s]/g, '');
  const morning = /^(早安|早上好|上午好|早呀|早啊|早)(呀|啊|啦|哦|哟|喵)?$/.test(greeting);
  const afternoon = /^(午安|中午好|午好|下午好)(呀|啊|啦|哦|哟|喵)?$/.test(greeting);
  const night = /^(晚安|晚上好)(呀|啊|啦|哦|哟|喵)?$/.test(greeting);
  if (!morning && !afternoon && !night) return undefined;
  const hour = new Date(now + 8 * 3600_000).getUTCHours();
  if (hour >= 7 && hour < 12) return morning
    ? '早安呀 ☀️ 鱼鱼祝你今天顺顺利利～'
    : '北京时间还是上午呢 ☀️ 先送你一份元气，今天也要好好照顾自己呀～';
  if (hour >= 12 && hour < 18) return afternoon
    ? '下午好呀 🐟 记得喝口水，给自己充充电～'
    : '北京时间已经下午啦 🐟 这份问候鱼鱼收下了，陪你把剩下半天过得开心一点～';
  return night
    ? (greeting.startsWith('晚安') ? '晚安呀 🌙 盖好小被子，做个甜甜的梦～' : '晚上好呀 🌙 辛苦一天啦，放松一下～')
    : '北京时间还是夜间呢 🌙 鱼鱼收到你的问候啦，记得给自己留点休息时间哦～';
}
export function smallTalkReply(text: string): string | undefined {
  const value = text.normalize('NFKC').trim().replace(/[，,。.!！~～\s]/g, '');
  if (/^(在吗|在不在|鱼鱼在吗|大肥鱼在吗|你好|嗨|哈喽|hello|hi)[呀啊呢]?$/i.test(value)) return '在呢在呢，鱼鱼冒个泡 🫧 想聊什么呀？';
  if (/^(谢谢|谢谢你|谢啦|多谢|辛苦了|辛苦啦)[呀啊哦]?$/u.test(value)) return '收到这份暖意啦 🐟 鱼鱼的快乐电量又满格了～';
  if (/^(抱抱|贴贴|摸摸)[呀啊]?$/u.test(value)) return '给你一个云抱抱 🫧 今天也要对自己温柔一点呀～';
  if (/^(哈哈+|嘿嘿+|笑死|笑死了)$/u.test(value)) return '快乐接收成功～鱼鱼的尾巴也跟着摇起来啦 🐟';
  if (/^(加油|一起加油)[呀啊]?$/u.test(value)) return '一起加油呀 🐟 不用一口气游到终点，往前一点点也很棒～';
  return undefined;
}
function quietChatReply(p: Policy, text: string, now: number): string {
  const when = p.quiet_start === p.quiet_end ? '恢复时间请留意群内通知呀～' : `北京时间 ${clockText(p.quiet_end)} 后再来找我玩呀～`;
  return `${greetingReply(text, now) ?? '鱼鱼收到啦 🐟'}\n我正在休息，${when}`;
}

const digest = (values: string[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const chinaDay = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

export function normalize(ctx: MiddlewareContext, appId: string, now: number):
  { request: OfficialRequest; parsed: Parsed; sentAt: number; text: string } | undefined {
  const m = ctx.message;
  // Full-message groups use GROUP_MESSAGE_CREATE. Only the platform's structured
  // self-mention flag can authorize that event; a text marker alone cannot.
  const selfMention = Array.isArray(m.mentions) && m.mentions.some(mention => mention?.is_you === true);
  const mentionedEvent = m.rawEventType === 'GROUP_AT_MESSAGE_CREATE' ||
    (m.rawEventType === 'GROUP_MESSAGE_CREATE' && selfMention);
  if (ctx.bot.appId !== appId || m.senderIsBot || m.kind !== 'group' || !mentionedEvent ||
      typeof m.senderId !== 'string' || !opaqueID.test(m.senderId) ||
      typeof m.groupOpenid !== 'string' || !opaqueID.test(m.groupOpenid) ||
      typeof m.messageId !== 'string' || !m.messageId || m.messageId.length > 256 ||
      typeof m.timestamp !== 'string' || typeof m.content !== 'string' ||
      ctx.replyTarget.scope !== 'group' || ctx.replyTarget.targetId !== m.groupOpenid ||
      ctx.replyTarget.msgId !== m.messageId) return;
  const sentAt = Date.parse(m.timestamp);
  if (!Number.isFinite(sentAt) || sentAt > now + clockSkew || now - sentAt > ttl || chinaDay(now) !== chinaDay(sentAt)) return;
  if (m.content.length > 4000) return { parsed: 'unsupported', sentAt, text: '', request: {
    protocol: 'dafeiyu.qq-official.v1', app_id: appId, identity_scope: 'group_member',
    group_openid: m.groupOpenid, member_openid: m.senderId,
    event_key: digest([appId, m.groupOpenid, m.senderId, m.messageId]),
    sent_at: Math.floor(sentAt / 1000), action: 'help', user_id: '',
  } };
  let text = m.content.trim();
  const mentionIDs = new Set([appId]);
  for (const mention of m.mentions ?? []) {
    if (mention?.is_you !== true) continue;
    for (const id of [mention.id, mention.user_openid, mention.member_openid]) {
      if (typeof id === 'string' && opaqueID.test(id)) mentionIDs.add(id);
    }
  }
  const prefixes = [...mentionIDs].flatMap(id => [`<@!${id}>`, `<@${id}>`]);
  for (const prefix of prefixes) {
    text = text.split(prefix).join(' ').trim();
  }
  // Other mentions, CQ tags and quoted requests are not a money instruction.
  const unsupported = /<@|\[CQ:|<qqbot_|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i.test(text) || m.attachments?.length || m.refMsgIdx || m.msgElements?.length;
  const parsed = unsupported ? 'unsupported' : parseCommand(text);
  const command = typeof parsed === 'string' ? { action: 'help' as const, user_id: '' } : parsed;
  return {
    parsed, sentAt, text,
    request: {
      protocol: 'dafeiyu.qq-official.v1', app_id: appId, identity_scope: 'group_member',
      group_openid: m.groupOpenid, member_openid: m.senderId,
      event_key: digest([appId, m.groupOpenid, m.senderId, m.messageId]),
      sent_at: Math.floor(sentAt / 1000), ...command,
    },
  };
}

const instructions = `大肥鱼在这里 🐟\n\n🎁 领福利：@大肥鱼 领取\n☀️ 每日签到：@大肥鱼 签到\n💰 查余额：@大肥鱼 余额\n余额会显示在群里，也可以到网站钱包私下查看。\n\n第一次领取或签到？\n在指令后带上自己的站内 ID，例如：\n@大肥鱼 签到 你的ID\n成功后，下次就不用再带 ID 啦～\n\n每个活动只领一次，签到每天北京时间 0 点刷新。\n\n💬 想聊天？@大肥鱼，说点什么吧～\n\n官网：${websiteURL}`;

export function createCommunityMiddleware(options: Options): Middleware {
  if (!/^[1-9][0-9]{0,19}$/.test(options.appId)) throw new Error('invalid app ID');
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let tail = Promise.resolve();
  let pending = 0;
  let lastReply = -Infinity;
  const groups = new Map<string, number>();
  const cooldowns = new Map<string, { at: number; completeIDUntil?: number }>();
  const seen = new Map<string, number>();
  const ingress = new Map<string, { at: number; count: number }>();
  let ingressWindow = now(), ingressCount = 0;
  let observationWindow = now(), observations = 0;
  async function policy(): Promise<Policy> { return validatePolicy(await options.policy()); }
  const enabledGroup = (p: Policy, group: string) => p.enabled && p.allowed_groups.includes(group);

  return async (ctx, _next) => {
    const normalized = normalize(ctx, options.appId, now());
    // Only finite outcome names and durations: never content, IDs, keys or SDK errors.
    const observe = (outcome: string) => {
      if (now() - observationWindow >= 60_000) { observationWindow = now(); observations = 0; }
      if (++observations > 120) return; // Bound logging even when invalid events flood.
      const action = normalized && typeof normalized.parsed !== 'string' ? normalized.parsed.action : 'text';
      try { ctx.log.info('[dafeiyu-community]', { action, outcome }); } catch { /* observability cannot break delivery */ }
    };
    const stop = (reason: string) => { observe(reason); ctx.stop(reason); };
    if (!normalized) { stop('community-invalid-event'); return; }
    const { request, parsed, sentAt, text } = normalized;
    // Bound work before fetching policy: an authenticated group user can flood
    // messages without possessing a Hub credential. Drop excess without replies.
    if (now() - ingressWindow >= 10_000) { ingressWindow = now(); ingressCount = 0; }
    if (++ingressCount > 20 || pending >= 200 || seen.has(request.event_key)) {
      stop('community-ingress-limited'); return;
    }
    for (const [key, value] of ingress) if (now() - value.at >= 10_000) ingress.delete(key);
    const ingressKey = digest([request.app_id, request.group_openid, request.member_openid]);
    const bucket = ingress.get(ingressKey);
    if ((bucket && ++bucket.count > 8) || (!bucket && ingress.size >= 10_000)) {
      stop('community-sender-limited'); return;
    }
    if (!bucket) ingress.set(ingressKey, { at: now(), count: 1 });
    let p: Policy;
    try { p = await policy(); } catch { stop('community-policy-unavailable'); return; }
    const rewardCommand = typeof parsed !== 'string' && (parsed.action === 'claim' || parsed.action === 'checkin');
    const informationCommand = typeof parsed !== 'string' && (parsed.action === 'help' || parsed.action === 'website' || parsed.action === 'balance');
    const enteredQuiet = isQuiet(p, now()) || isQuiet(p, sentAt);
    if (!enabledGroup(p, request.group_openid) || (enteredQuiet && !rewardCommand && !informationCommand && parsed !== 'chat')) { stop('community-disabled'); return; }
    // Bounded process-local suppression; durable award idempotency belongs in Hub.
    for (const [key, at] of seen) if (now() - at > ttl + clockSkew) seen.delete(key);
    for (const [key, state] of cooldowns) if (now() - state.at > 3_600_000) cooldowns.delete(key);
    for (const [key, at] of groups) if (now() - at > 3_600_000) groups.delete(key);
    if (seen.has(request.event_key) || seen.size >= 10_000 || pending >= p.queue_limit) {
      stop('community-duplicate-or-full'); return;
    }
    const action = typeof parsed === 'string' ? parsed : parsed.action;
    const senderKey = digest([request.app_id, request.group_openid, request.member_openid, action]);
    const previous = cooldowns.get(senderKey);
    // A confirmed Hub need_id reply permits one immediate, explicit ID completion.
    // Same sender/action only; it never relaxes ingress, queue, quiet-hour or award guards.
    const completingID = rewardCommand && !enteredQuiet && request.user_id !== ''
      && now() < (previous?.completeIDUntil ?? -Infinity);
    if (!completingID && now() - (previous?.at ?? -Infinity) < (enteredQuiet ? Math.max(p.user_cooldown_ms, 60_000) : p.user_cooldown_ms)) {
      stop('community-cooldown'); return;
    }
    seen.set(request.event_key, now());
    const cooldown: { at: number; completeIDUntil?: number } = { at: now() };
    cooldowns.set(senderKey, cooldown); // Atomically consume any completion allowance.
    pending++;
    let sendAttempted = false;
    const preceding = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await preceding;
    try {
      p = await policy();
      const wait = Math.max(0, lastReply + p.reply_interval_ms - now(),
        (groups.get(request.group_openid) ?? -Infinity) + p.group_interval_ms - now());
      if (wait) await sleep(wait);
      p = await policy();
      if (ctx.signal.aborted || !enabledGroup(p, request.group_openid) || now() - sentAt > ttl || chinaDay(now()) !== chinaDay(sentAt)) {
        stop('community-expired-or-disabled'); return;
      }
      stop('community-command');
      let result: BusinessReply;
      let balanceRead = false;
      // Fixed help/website replies remain available across quiet-hour boundaries.
      const quietNotice = !informationCommand && (enteredQuiet || isQuiet(p, now()) || isQuiet(p, sentAt));
      if (quietNotice) {
        if (!isQuiet(p, now())) return; // Never replay a night request after reopening.
        if (parsed === 'chat') {
          if (!p.chat_enabled) return;
          result = { reply: quietChatReply(p, text, now()) };
        } else {
          if (!rewardCommand) return;
          result = { reply: quietReply(p, action) };
        }
      } else if (parsed === 'chat') {
        if (!p.chat_enabled) { stop('community-chat-disabled'); return; }
        const greeting = greetingReply(text, now()) ?? smallTalkReply(text);
        result = greeting ? { reply: greeting } : options.chat ? await options.chat(text, ctx.signal, p) : { reply: '鱼鱼的聊天频道暂时打了个盹 🐟 帮助、签到和领取可以单独发指令试试呀～' };
      } else {
        if ((action === 'help' || action === 'website' || parsed === 'invalid' || parsed === 'unsupported') && !p.help_enabled) return;
        if (parsed === 'unsupported') result = { reply: unsupportedReply };
        else if (parsed === 'invalid') result = { reply: '鱼鱼收到啦 🐟 这条指令可以这样发：\n' + helpReply(p, p.help_reply ?? instructions) };
        else if (parsed.action === 'help') result = { reply: helpReply(p, p.help_reply ?? instructions) };
        else if (parsed.action === 'website') result = { reply: p.website_reply ?? `示例社区 官网\n${websiteURL}` };
        else if ((parsed.action === 'balance' && !p.balance_enabled) || (parsed.action === 'claim' && !p.claim_enabled) || (parsed.action === 'checkin' && !p.checkin_enabled)) {
          result = { reply: p.paused_reply ?? '该功能暂未开放，请关注群内通知。' };
        } else if (!options.execute) {
          result = { reply: '当前为官方接入测试模式，指令已识别，尚未绑定账号或发放赠金。' };
        } else {
          balanceRead = action === 'balance';
          observe('business-started');
          result = await options.execute(request);
          observe(result.silent ? 'business-silent' : 'business-replied');
        }
      }
      // No optimistic success, no automatic credit retry after an uncertain result.
      p = await policy();
      if ((parsed === 'chat' && !p.chat_enabled) || result.silent || ctx.signal.aborted || !enabledGroup(p, request.group_openid) ||
          (informationCommand ? (action === 'balance' ? balanceRead && !p.balance_enabled : !p.help_enabled) : (quietNotice ? !isQuiet(p, now()) : isQuiet(p, now()))) ||
          now() - sentAt > ttl || chinaDay(now()) !== chinaDay(sentAt)) { observe('reply-expired-or-disabled'); return; }
      if (typeof result.reply !== 'string' || !result.reply || result.reply.length > 1500) { observe('invalid-reply'); return; }
      lastReply = now(); groups.set(request.group_openid, now());
      if (/<@|\[CQ:|<qqbot[_-]/i.test(result.reply)) return;
      observe('send-started');
      sendAttempted = true;
      await ctx.bot.sendMarkdown(ctx.replyTarget, addressGroupReply(request.member_openid, result.reply));
      observe('send-confirmed');
      if (rewardCommand && !quietNotice && request.user_id === '' && result.status === 'need_id'
          && cooldowns.get(senderKey) === cooldown) {
        cooldown.completeIDUntil = now() + ttl;
      }
    } catch {
      // SDK outer handler must not echo raw upstream errors, identity or secrets.
      stop(sendAttempted ? 'community-send-unconfirmed' : 'community-unavailable');
      // Never retry the business call or a send of uncertain outcome. A fixed
      // error reply is allowed only after another successful policy check.
      if (!sendAttempted) {
        try {
          const current = await policy();
          if (!ctx.signal.aborted && enabledGroup(current, request.group_openid) &&
              (informationCommand ? (action === 'balance' ? current.balance_enabled === true : current.help_enabled) : !isQuiet(current, now())) &&
              now() - sentAt <= ttl && chinaDay(now()) === chinaDay(sentAt)) {
            lastReply = now(); groups.set(request.group_openid, now());
            await ctx.bot.sendMarkdown(ctx.replyTarget, addressGroupReply(request.member_openid, uncertainReply));
          }
        } catch { /* No upstream details or fallback agent. */ }
      }
    } finally {
      pending--; release();
    }
  };
}
