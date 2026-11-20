import type { Middleware } from '@tencent-connect/qqbot-nodejs';
import { normalize } from './adapter.ts';
import { addressGroupReply } from './replies.ts';

// Reuse the authenticated DSH settings page's expiring group invitation. This
// only discovers a group; the separate community policy still decides access.
export interface GroupEnrollmentService {
  pairing: { validate(code: string): { ok: boolean; purpose?: string } };
  beginClaimFromMessage(scope: 'group', peerId: string, code: string, senderId: string): { ok: boolean };
  endPairCode(code: string, purpose: 'allow-group'): void;
}

export function createGroupEnrollment(
  appId: string, service?: GroupEnrollmentService, now = Date.now,
): Middleware {
  return async (ctx, next) => {
    const diagnostic = (stage: string, flags: Record<string, boolean> = {}) => {
      if (process.env.DAFEIYU_ENROLLMENT_DIAGNOSTICS === '1') {
        console.info('[dafeiyu-enrollment]', stage, JSON.stringify(flags));
      }
    };
    const event = normalize(ctx, appId, now());
    diagnostic('received', { normalized: !!event, service: !!service,
      group: ctx.message.kind === 'group', groupAt: ctx.message.rawEventType === 'GROUP_AT_MESSAGE_CREATE',
      groupMessage: ctx.message.rawEventType === 'GROUP_MESSAGE_CREATE',
      selfMention: Array.isArray(ctx.message.mentions) && ctx.message.mentions.some(m => m?.is_you === true),
      appMatches: ctx.bot.appId === appId, unsupported: event?.parsed === 'unsupported',
      aborted: ctx.signal.aborted,
      otherMention: !!event?.text.includes('<@'),
      attachments: !!ctx.message.attachments?.length, quote: !!ctx.message.refMsgIdx,
      elements: !!ctx.message.msgElements?.length,
      controlTag: !!event && /\[CQ:|<qqbot_|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/i.test(event.text) });
    if (!service || !event || event.parsed === 'unsupported' || ctx.signal.aborted || !event.text || event.text.length > 32) {
      await next(); return;
    }
    let active = false;
    try {
      const challenge = service.pairing.validate(event.text);
      diagnostic('challenge', { valid: challenge.ok, group: challenge.purpose === 'allow-group' });
      if (!challenge.ok) { await next(); return; }
      active = true;
      ctx.stop('community-group-enrollment');
      // Command-owner and private-chat invitations must never be claimed here
      // or sent to the text model. No user identity binding is created.
      if (challenge.purpose !== 'allow-group') return;
      const result = service.beginClaimFromMessage('group', event.request.group_openid,
        event.text, event.request.member_openid);
      diagnostic('claim', { ok: result.ok });
      // Consume synchronously before awaiting a reply: a code admits one group.
      if (result.ok) service.endPairCode(event.text, 'allow-group');
      if (!ctx.signal.aborted) await ctx.bot.sendMarkdown(ctx.replyTarget, addressGroupReply(event.request.member_openid, result.ok
        ? '活动群已登记。请等待管理员开启测试；本次没有绑定站内账号或发放赠金。'
        : '测试群暂未登记成功，请回到本地设置页检查。'));
    } catch {
      diagnostic('failed', { active });
      // Never expose a pairing code, platform identity or raw storage error.
      ctx.stop(active ? 'community-enrollment-unconfirmed' : 'community-enrollment-unavailable');
    }
  };
}
