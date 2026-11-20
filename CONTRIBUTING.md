# Contributing

欢迎提交可复现的问题和小范围 PR。先看 [架构](docs/architecture.md) 与 [安全边界](docs/security.md)。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run demo
```

测试使用合成身份、注入时钟和假的模型流，不需要 QQ、模型 Key 或业务服务器。
不要提交真实聊天截图、OpenID、群号、AppID、用户资料或运行配置。

修改资金或身份边界时，写明触发条件、预期行为与失败路径，补有意义的回归；
涉及产品取舍时，在 `docs/adr/` 写一份简短决策。PR 需说明 AI 辅助情况。

提交贡献即表示你有权按项目 LICENSE 提供该贡献。不要重新许可第三方代码。
