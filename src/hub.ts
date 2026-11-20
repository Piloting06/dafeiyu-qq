import { readFile } from 'node:fs/promises';
import {
  closedPolicy,
  validatePolicy,
  type Policy,
  type OfficialRequest,
  type BusinessReply,
} from './adapter.ts';

export interface HubSnapshot {
  config: {
    enabled: boolean;
    app_id: string;
    chat_enabled: boolean;
    persona: string;
    website_reply: string;
    groups: { openid: string; enabled: boolean }[];
  };
  policy: {
    enabled: boolean;
    binding_enabled: boolean;
    claim_enabled: boolean;
    checkin_enabled: boolean;
    balance_enabled?: boolean;
    help_enabled: boolean;
    join_enabled: boolean;
    quiet_enabled: boolean;
    quiet_start: number;
    quiet_end: number;
    reply_interval: number;
    group_interval: number;
    user_cooldown: number;
    queue_limit: number;
    replies: Record<string, string>;
  };
}
// Fixed capability endpoints only. No redirects, arbitrary URLs, user tokens,
// automatic retries or response/error bodies in logs.
export class HubClient {
  private base: URL;
  private token: () => Promise<string>;
  private transport: typeof fetch;
  constructor(base: string, token: () => Promise<string>, transport: typeof fetch = fetch) {
    this.token = token;
    this.transport = transport;
    this.base = new URL(base);
    if (
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      (this.base.protocol !== 'https:' &&
        !(this.base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(this.base.hostname)))
    )
      throw new Error('invalid Hub address');
    this.base.pathname = '/api/qq-community/official/';
  }
  async call<T>(
    path: 'policy' | 'message' | 'join' | 'join/result' | 'discover',
    body: unknown = {},
  ): Promise<T> {
    if (!['policy', 'message', 'join', 'join/result', 'discover'].includes(path)) throw new Error('invalid capability');
    const token = (await this.token()).trim();
    if (token.length < 32 || token.length > 4096 || /\s/.test(token))
      throw new Error('bridge unavailable');
    const response = await this.transport(new URL(path, this.base), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('bridge unavailable');
    if (!response.body) throw new Error('bridge unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '', size = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) { await reader.cancel(); throw new Error('bridge unavailable'); }
        text += decoder.decode(value, {stream: true});
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    const value = JSON.parse(text) as { success: boolean; data: T };
    if (value.success !== true) throw new Error('bridge unavailable');
    return value.data;
  }
  snapshot(): Promise<HubSnapshot> {
    return this.call('policy');
  }
  async execute(request: OfficialRequest): Promise<BusinessReply> {
    const value = await this.call<BusinessReply>('message', request);
    if (
      !value ||
      typeof value.reply !== 'string' ||
      value.reply.length > 1500 ||
      (value.silent !== undefined && typeof value.silent !== 'boolean') ||
      (value.status !== undefined && (typeof value.status !== 'string' || !/^[a-z_]{1,48}$/.test(value.status)))
    )
      throw new Error('invalid bridge response');
    return value;
  }
}
export function configuredHub(): HubClient | undefined {
  const base = process.env.DAFEIYU_HUB_URL,
    file = process.env.DAFEIYU_HUB_TOKEN_FILE;
  if (!base && !file) return;
  if (!base || !file) throw new Error('incomplete Hub configuration');
  return new HubClient(base, () => readFile(file, 'utf8'));
}
export function hubPolicy(snapshot: HubSnapshot, appId: string): Policy {
  const { config: c, policy: p } = snapshot;
  if (!c || !p || c.app_id !== appId) return closedPolicy;
  return validatePolicy({
    enabled: c.enabled && p.enabled,
    chat_enabled: c.chat_enabled,
    claim_enabled: p.claim_enabled,
    checkin_enabled: p.checkin_enabled,
    balance_enabled: p.balance_enabled === true,
    help_enabled: p.help_enabled,
    quiet_enabled: p.quiet_enabled,
    quiet_start: p.quiet_start,
    quiet_end: p.quiet_end,
    allowed_groups: c.groups.filter((g) => g.enabled).map((g) => g.openid),
    reply_interval_ms: p.reply_interval * 1000,
    group_interval_ms: p.group_interval * 1000,
    user_cooldown_ms: p.user_cooldown * 1000,
    queue_limit: p.queue_limit,
    persona: c.persona,
    help_reply: p.replies.help,
    website_reply: c.website_reply,
    paused_reply: p.replies.paused,
  });
}
