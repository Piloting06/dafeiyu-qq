import { configuredHub, hubPolicy } from './hub.ts';
import { readFile } from 'node:fs/promises';
import type { Options } from './adapter.ts';
import { closedPolicy, createCommunityMiddleware, validatePolicy } from './adapter.ts';

// Hub mode supplies only the dedicated official capability client. Without Hub
// configuration, the original local preview has no reward executor.
export interface GroupAccessService {
  currentAccess(): { groupMode: string; groupAllow: string[] };
}

export function createDafeiyuPreview(appId: string, chat?: Options['chat'], access?: GroupAccessService) {
  // A configured but unavailable Hub never falls back to the preview JSON.
  let hub: ReturnType<typeof configuredHub>;
  let invalidHub = false;
  try { hub = configuredHub(); } catch { invalidHub = true; }
  let discovered = "";
  return createCommunityMiddleware({
    appId, chat, execute: hub ? request => hub!.execute(request) : undefined,
    policy: async () => {
      if (invalidHub) return closedPolicy;
      if (hub) {
        const a0 = access?.currentAccess();
        const groups = a0?.groupMode === 'allowlist' ? a0.groupAllow : [];
        const stamp = JSON.stringify(groups);
        if (stamp !== discovered) {
          await hub.call('discover', {app_id: appId, groups}); discovered = stamp;
        }
        const policy = hubPolicy(await hub.snapshot(), appId);
        const a = access?.currentAccess();
        const allowed = a?.groupMode === 'allowlist' ? a.groupAllow : [];
        return {...policy, allowed_groups: policy.allowed_groups.filter(id => allowed.includes(id)), chat_enabled: policy.chat_enabled && chat !== undefined};
      }
      const file = process.env.DAFEIYU_DSH_POLICY_FILE;
      if (!file) return closedPolicy;
      const content = await readFile(file, 'utf8');
      if (content.length > 16_384) throw new Error('policy too large');
      const policy = validatePolicy(JSON.parse(content));
      const membership = access?.currentAccess();
      // The authenticated settings page can revoke access even when the separate
      // preview policy still lists the group. Open mode never discovers groups.
      const allowed = membership?.groupMode === 'allowlist' ? membership.groupAllow : [];
      // Explicit code-injected text callback is required; JSON cannot enable host agents.
      return { ...policy, allowed_groups: policy.allowed_groups.filter(id => allowed.includes(id)),
        chat_enabled: policy.chat_enabled && chat !== undefined };
    },
  });
}
