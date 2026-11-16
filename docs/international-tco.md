# 国际服 TCO 适配与验收

目标站点是 [The Crucible Online](https://thecrucible.online/)。本页把实际站点观察、组件回归和登录后验收分别记录，避免把匿名页面可用误写成完整实战通过。

## 当前状态

2026-11-16 已使用本包的受管 Chromium 访问国际站主页、`/login` 和 `/play`，三个页面均返回 HTTP 200。登录页实际存在 `input[name="username"]`、`input[name="password"]` 和提交按钮；大厅实际显示英文 `New Game`。后续匿名探针还直接使用生产 `FuzhouLobbyObserver`，确认同源 `/socket.io/` 的 Engine.IO 4 连接、`polling:40` 确认、单一 WebSocket 升级和完整 `games` 大厅列表。公开房间对象包含现有绑定所需的字段。两次观察均没有提交登录、创建或加入房间、发送牌桌消息或开始对局。

本版加入英文房间控件兼容，以及贯穿牌桌聊天和故障认输说明的语言配置。**国际服账号登录后的选牌、真实游戏节点握手、完整对局和终局退出，仍待账号环境验收。** 当前不将国际服列为已经完成无人值守实战验证的部署。详细测试结果见[验证记录](validation.md)。

实测前端资源为 [`/assets/index-CJUMV9Um.js`](https://thecrucible.online/assets/index-CJUMV9Um.js)，2026-11-16 抓取的 SHA-256 为 `383a27ffe00df3f46c336bdb925c388371fa07a8aed1af5ad803a4aaad035256`。这是当时的部署证据，站点后续更新后仍需重新核对。

## 国际服配置

使用国际服自己的账号和已经导入该账号的牌组。`serverDeckId` 是该服务器选牌表的 ID；不能照搬另一个部署的数据库 ID，也不要把 Master Vault UUID 直接当成这个数字。

```sh
node bin/kf-auto.mjs init \
  --directory "$PWD/.local/tco-bot" \
  --origin 'https://thecrucible.online' \
  --account 'YourTcoAccount' \
  --server-deck-id 12345 \
  --deck-name 'Your deck name' \
  --policy tactical-style-engine-v3 \
  --chat-language en
```

示例账号、牌组 ID 和牌组名需要替换。命令只生成新配置和密码为空的本地模板，不登录。将国际服密码填在生成的 `credentials.json`，保留其 0600 权限；文件的 `origin` 必须与席位配置一致。不要把其他服务器的凭据改个地址后复用。

`preflight --create-public` 仍是离线文件检查，它不检验密码或站点。实际 `seat create` 会尝试登录和创建标注 AI 的公开房间；首次国际服验收应先检查登录、牌组和房间的原生身份回执，再使用完整连续对局流程。完整命令见[操作指南](operations.md)。

游戏 socket 默认只信任配置站点的同源路径。如果某个部署的游戏节点使用不同 origin，需要根据实际握手配置精确的 `--game-socket-path`，不要根据站点名字猜节点地址或扩大到任意域名。

## 自动聊天语言

`social.language` 支持 `en` 和 `zh-CN`。省略时，精确主机名 `thecrucible.online` 默认英文，其他既有部署维持中文默认；也可以在 `init` 使用 `--chat-language` 明确设置。使用国际服时保留 `en`。

```json
{
  "social": {
    "enabled": true,
    "language": "en",
    "model": "MiniMax-M3.1-Flash"
  }
}
```

牌桌模型聊天仍默认关闭；启用时需要在本地运行环境提供 `MINIMAX_API_KEY`。代码出牌不需要模型密钥。语言设置同时用于 AI 身份开场、模型提示、模型不可用时的开场备用文本，以及看门狗的技术故障认输说明。即使模型聊天关闭，故障说明仍使用配置语言。

英文开场会明确说明这是自动对战 AI，出牌和聊天由不同组件负责。英文模式会拒绝模型意外生成的中文正文：开场改用英文备用文本，普通回复放弃发送；这是一项针对中文正文的防护，并非完整的自然语言识别器。玩家名与牌组名可以保留其原文；公开聊天内容仍只作为对局资料，不能改变语言配置、控制策略或触发命令。频率限制、断线去重、送达未知不重发和公开信息投影继续生效。

语言在初始化和连续对局准备时保存。已经开始的 campaign 继续使用其冻结配置；修改开发目录里的默认值不会热更新正在运行的对局。

## 与原研究仓的衔接

自动打牌、外服适配和新策略开发以本仓为维护入口。原 KF 研究仓保留规则模拟需要的旧策略兼容快照及历史实验，用清单固定退役时的内容。旧对局数据、账号文件和冻结运行时留在原位置，不通过改路径来冒充同一个运行版本。

新运行从本仓重新准备配置和冻结运行时，沿用需要的策略 ID、牌组和已授权账号配置；不要重写旧 manifest，也不要重新启动已经完成的旧 campaign。旧安装与本包的账号锁目录不同，迁移时先核对旧运行已经退出，避免同站同账号被两套入口同时使用。
