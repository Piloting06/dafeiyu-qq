# 安装与接入

## 先运行离线演示

推荐 Node.js **24.22.3**（完整 DSH 的最低版本要求与独立适配器不同）。

```sh
git clone https://github.com/Piloting06/dafeiyu-qq.git
cd dafeiyu-qq
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run demo
```

演示使用真实 SDK 的中间件执行器和合成消息。不会登录 QQ、访问模型、连接业务服务器或发真钱。
`npm run build` 生成 `dist/`，入口为 `dist/index.js`。本项目暂不发布 npm 包。

## SDK 宿主

将 `createCommunityMiddleware` 安装到群消息处理链前部，传入可信的 `appId`、策略读取函数和明确的
业务回调。最后不要把已处理消息继续交给有工具的宿主 Agent。演示展示了完整的组合方式。

本地 JSON 模式仅用于预览。把 `policy.example.json` 复制到仓库外，按真实事件填写**群 OpenID**，
并与宿主白名单同步，再显式打开所需开关。`enabled: false` 是默认；不是填上数字群号就能授权。

## DSH 宿主

分别安装官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与
[腾讯 DSH QQ 插件](https://github.com/tencent-connect/dsh-qqbot)，按其说明取得官方应用授权。
本项目不携带第三方运行时、应用密钥、模型 Key 或账户授权；也不需要个人 QQ 小号挂机。
模型与 QQ 官方平台可能各有费用、权限和配额要求。

准备脚本仅支持公开插件 `0.5.5`、commit `0f168b31584435515ce05824b9539597aa1eec4a`。
在**另一个可丢弃的本地源码副本**中操作：

```sh
git clone https://github.com/tencent-connect/dsh-qqbot.git /tmp/dafeiyu-qqbot-source
cd /tmp/dafeiyu-qqbot-source
git checkout 0f168b31584435515ce05824b9539597aa1eec4a
cd /path/to/dafeiyu-qq
node prepare-source.mjs /tmp/dafeiyu-qqbot-source --check
node prepare-source.mjs /tmp/dafeiyu-qqbot-source --apply
```

脚本不下载依赖、不构建、不扫码、不启动服务。随后按上游说明构建插件，并由管理员本地授权。
它只验证四个关键适配文件及包元信息，不是整个上游的供应链审计。上游升级后必须重新审查。

公开配置名称见 [配置参考](configuration.md)。`.env.example` 只作说明，不会自动加载。
有自己的后端时，同时配置 URL 与令牌文件；只配一个、后端失败或响应异常均停止，绝不退回可执行的
测试模式。令牌文件置于仓库外，权限最小化。实际业务后端需要实现 [接口契约](backend-contract.md)。

## 生产前自验

先在独立测试应用、测试群和隔离账本确认帮助、聊天、领取、同日重复签到、预算与权限撤销。
需要群审批时另行核实官方应用权限；已设为群管理员不代表自动拥有所有 API 权限。
每个应用只运行一个活动网关；重启不能清除后端去重。此项目没有自动部署到任何真实服务器。
