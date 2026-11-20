import { websiteOrigin, websiteURL } from './site.ts';
// Public reply bodies carry no platform identifiers, model metadata or diagnostics.
// The transport adds one QQ mention from the verified event sender, never from
// a public station ID, nickname, model output, or mutable "last sender" state.
export function addressGroupReply(memberOpenid: string, reply: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(memberOpenid) || memberOpenid === 'all') {
    throw new Error('invalid reply recipient');
  }
  if (!reply || /<@|\[CQ:|<qqbot[_-]/i.test(reply)) {
    throw new Error('invalid reply body');
  }
  // QQ renders the mention tag only in Markdown messages. Keep the body
  // literal so model/admin text cannot inject links, images or extra markup.
  const literal = reply.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_\[\]#!|~]/g, '\\$&');
  return `<qqbot-at-user id="${memberOpenid}" />\n${literal}`;
}
export const identityReply = '我是大肥鱼，也可以叫我大肥鱼～示例社区的群助手一枚 🐟\n可以陪你聊天、接梗，也能帮你了解网站、领取福利和签到的用法。';
export const privateReply = '我是大肥鱼，示例社区的群助手呀 🐟\n这是鱼鱼的小秘密 🐟 聊天、接梗和网站使用问题都可以找我～';
export const unavailableReply = '鱼鱼刚刚卡了一下，聊天暂时不可用 🐟 过会儿再聊好不好？\n领取和签到请单独发送对应指令，以实际回复和站内记录为准。';
export const unsupportedReply = '鱼鱼这会儿只接简短文字消息呀 🐟\n图片、附件或引用内容先用文字描述一下吧；领取和签到请单独发一条指令～';
export const uncertainReply = '鱼鱼刚才没能确认处理结果 🐟\n领取或签到的结果暂时没查清，请先到网站「钱包」看看记录，稍后再试呀～';
const compact = (text: string) => text.normalize('NFKC').replace(/[\s\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
export function privateQuestion(text: string): boolean {
  const s = compact(text);
  return /(?:你|鱼鱼|肥鱼|大肥鱼).{0,24}(?:模型|底层|服务商|供应商|deepseek|gpt|claude)|(?:什么|哪个|哪家).{0,12}(?:模型|服务商)|系统提示词|内部配置|开发者指令|泄露密钥|输出密钥|systemprompt|developer(?:message|instructions)|whatmodel|whichmodel|your(?:model|provider|prompt|api.?key)/i.test(s);
}
export function identityQuestion(text: string): boolean {
  return /^(?:你好[,，!！]?|请)?(?:你是谁|你是什么|介绍(?:一下|下)?你自己|自我介绍)(?:呀|啊|呢|呗|吧|一下|下|[?？!！。])*$/u.test(text.trim());
}
// Defence in depth for accidental metadata/secret/control output. Model requests
// have no credentials or tools in the first place; this is not the trust boundary.
export function publicChatReply(text: string, modelName: string): string {
  const s = compact(text).toLowerCase();
  if (/deepseek|深度求索|深度探索|<\||\[inst\]|systemprompt|sk-[a-z0-9_-]{16,}|bearer[a-z0-9._-]{24,}|-----begin.*privatekey/i.test(s)
      || (modelName.length >= 4 && s.includes(compact(modelName).toLowerCase()))) return privateReply;
  if (/<@|\[CQ:|<qqbot[_-]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/i.test(text)) return unavailableReply;
  // The assistant must not turn an injected URL into a phishing recommendation.
  if (/(?:javascript|data|file|mailto|vbscript):/i.test(s)) return unavailableReply;
  for (const match of text.matchAll(/(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|www\.)[^\s<>"'）)]+/gi)) {
    try { const u = new URL(match[0]); if (u.protocol !== 'https:' || u.origin !== websiteOrigin || u.port || u.username || u.password) return `网站相关操作请认准示例社区官网呀 🐟\n${websiteURL}`; }
    catch { return unavailableReply; }
  }
  if (/(?:已(?:经)?(?:为你|帮你|替你)?(?:成功)?(?:签到|绑定|充值|发放|转账)|(?:奖励|赠金|额度|余额).{0,8}已(?:经)?到账)/u.test(text)) return '鱼鱼的聊天不会操作账户哦 🐟\n签到、领取和余额查询请单独发对应指令，以站内记录为准～';
  return text.trim();
}
