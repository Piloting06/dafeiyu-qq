import type { QQBot, RawEventContext } from '@tencent-connect/qqbot-nodejs';
import { isQuiet } from './adapter.ts';
import { configuredHub, hubPolicy, type HubClient } from './hub.ts';
import type { GroupAccessService } from './preview.ts';
const opaque = /^[A-Za-z0-9_-]{1,128}$/;
export function createJoinHandler(
  appId: string,
  hub: HubClient,
  access: GroupAccessService,
  now = Date.now,
) {
  let active = false;
  let nextAttempt = 0;
  return async (ctx: RawEventContext) => {
    if (
      ctx.bot.appId !== appId ||
      ctx.eventType !== 'GROUP_JOIN_REQUEST' ||
      active ||
      now() < nextAttempt
    )
      return;
    const d = ctx.data as Record<string, unknown>;
    if (
      !d ||
      d.bot ||
      d.auto_approved ||
      d.apply_source !== 'self_apply' ||
      d.risk_tips ||
      typeof d.group_openid !== 'string' ||
      !opaque.test(d.group_openid) ||
      typeof d.member_openid !== 'string' ||
      !opaque.test(d.member_openid) ||
      typeof d.join_request_id !== 'string' ||
      !d.join_request_id ||
      d.join_request_id.length > 1024 ||
      typeof d.apply_at !== 'string'
    )
      return;
    const at = Date.parse(d.apply_at);
    if (!Number.isFinite(at) || now() - at > 60_000 || at > now() + 5000) return;
    const v = d.verify_info as
      | { method?: string; verify_message?: unknown; review_qa_list?: { answer?: unknown }[] }
      | undefined;
    let comment: unknown;
    if (v?.method === 'verify_message') comment = v.verify_message;
    if (
      v?.method === 'admin_review_qa' &&
      Array.isArray(v.review_qa_list) &&
      v.review_qa_list.length === 1
    )
      comment = v.review_qa_list[0]?.answer;
    if (typeof comment !== 'string' || !comment.trim() || Buffer.byteLength(comment) > 1024) return;
    const allowed = () => {
      const a = access.currentAccess();
      return a.groupMode === 'allowlist' && a.groupAllow.includes(d.group_openid as string);
    };
    if (!allowed()) return;
    active = true;
    try {
      const snapshot = await hub.snapshot();
      const p = hubPolicy(snapshot, appId);
      if (
        !p.enabled ||
        !snapshot.policy.join_enabled ||
        !p.allowed_groups.includes(d.group_openid) ||
        isQuiet(p, now()) ||
        isQuiet(p, at)
      )
        return;
      const result = await hub.call<{ status: string; key: string }>('join', {
        app_id: appId,
        group_openid: d.group_openid,
        member_openid: d.member_openid,
        request_id: d.join_request_id,
        sent_at: Math.floor(at / 1000),
        comment,
      });
      if (result.status !== 'approve' || !/^[a-f0-9]{64}$/.test(result.key)) return;
      // One platform attempt only. In doubt, preserve the request for a human.
      let status = 'unknown';
      const fresh = await hub.snapshot();
      const freshPolicy = hubPolicy(fresh, appId);
      if (
        allowed() &&
        fresh.policy.join_enabled &&
        freshPolicy.enabled &&
        freshPolicy.allowed_groups.includes(d.group_openid) &&
        !isQuiet(freshPolicy, now()) &&
        now() - at <= 60_000
      ) {
        nextAttempt = now() + 1100;
        try {
          await ctx.bot.api.post(
            `/v2/groups/${d.group_openid}/approval_join_request/${d.member_openid}`,
            { op: 'approve', join_request_id: d.join_request_id },
          );
          status = 'approved';
        } catch {
          /* no retry and no raw error logging */
        }
      }
      await hub.call('join/result', { key: result.key, status });
    } catch {
      /* fail closed; never decline */
    } finally {
      active = false;
    }
  };
}
export function installOfficialJoin(bot: QQBot, appId: string, access: GroupAccessService) {
  let hub: HubClient | undefined;
  try {
    hub = configuredHub();
  } catch {
    return;
  }
  if (hub) bot.on('rawEvent', createJoinHandler(appId, hub, access));
}
