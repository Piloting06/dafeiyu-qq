# 自建业务后端契约

适配器不带原网站后台和真实账本。`HubClient` 对以下路径发送 POST，携带 `Authorization: Bearer …`，
拒绝重定向、5秒截止、响应不超过64KiB。服务端必须验证独立令牌，并自行审查请求；不要信任可伪造的
公网调用，也不要把此令牌当模型 Key 或用户 Token。

| 路径（前缀 `/api/qq-community/official/`） | 请求 | 响应 `data` |
| --- | --- | --- |
| `policy` | `{}` | `HubSnapshot`，类型见 `src/hub.ts` |
| `discover` | `{ app_id, groups }` | 自定义空对象；只登记候选，不自动启用 |
| `message` | `OfficialRequest`，类型见 `src/adapter.ts` | `{ reply, status?, silent? }` |
| `join` | `{ app_id, group_openid, member_openid, request_id, sent_at, comment }` | `{ status, key }`，仅明确 `approve` 才尝试平台审批 |
| `join/result` | `{ key, status }` | `{}`；记录 approved/unknown，不自动重试 |

统一外层响应：`{ "success": true, "data": … }`。异常返回非2xx或success=false；勿回传原始数据库错误。
`status` 若提供，只能是小写字母/下划线，1至48字符；常见为 `need_id / credited / already / checked_in /
already_checkin / balance / budget / conflict / paused`。真正的 `need_id` 应来自后端状态，不能来自模型。

```json
{
  "protocol": "dafeiyu.qq-official.v1",
  "app_id": "123456",
  "identity_scope": "group_member",
  "group_openid": "SYNTHETIC_GROUP",
  "member_openid": "SYNTHETIC_MEMBER",
  "event_key": "0000000000000000000000000000000000000000000000000000000000000000",
  "sent_at": 0,
  "action": "claim",
  "user_id": "42"
}
```

这是合成结构示例，`sent_at: 0` 不是可接受的真实事件时间。只允许新鲜可信群事件。

后端最低要求：绑定归属核验、一对一限制、同活动/同账号唯一、同北京日期签到唯一、事件幂等、
预算行锁、奖励/余额/审计同事务、停用检查。余额仅允许查询当前发送者已绑定账号，禁止任意ID查询。
人工补款要显式归入对应活动再同步去重，不能根据“金额刚好相同”推断用途。
旧码核销、旧身份迁移、跨群身份、暂停删除和历史恢复均需独立设计，不能照抄演示内存账本。

`examples/demo.ts` 的内存执行器只有展示用途：没有认证绑定、持久化或实际经济价值。
