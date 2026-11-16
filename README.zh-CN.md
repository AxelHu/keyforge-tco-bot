# KeyForge TCO Bot

面向 Keyteki 兼容服务器的实验性策略与浏览器自动打牌工具。包含代码策略、玩家视角适配、
本机策略宿主、浏览器桥接、看门狗、建房/加入/退场、连续对局及恢复机制。

本仓是独立整理的客户端与策略项目。原私有项目的 KF 复刻引擎、游戏服务端、游戏界面和
历史实战原始数据不在本仓中。

[English](README.md) · [架构](docs/architecture.md) · [卡牌知识范围](docs/card-knowledge.md) ·
[使用与恢复](docs/operations.md) · [验证记录](docs/validation.md)

## 包含的能力

- 读取自己的可见手牌/档案与对手公开信息，使用包含 Engine V3 在内的代码策略。
- 原生状态投影、合法菜单导航、物理卡牌身份绑定、分配动作和原生命令编译。
- 区分“准备决定”“进入浏览器队列”“已观察到效果”，通过文档身份、代次和发送凭证防止重复发送。
- 请求超时、独立原生观察看门狗、精确回执对账、受控刷新和正常终局退场。
- 单席加入/建房、顺序连续对局、账号锁、健康阈值、暂停及明确的恢复入口。
- 包内 Chromium 管理和使用者自行填写的配置。运行不依赖 OpenClaw 或原私有仓库；社交聊天默认关闭。

## 安装

首版后台运行支持 Linux 或 WSL 内的 Linux，需要 Node.js 22.12–24.x、Python 3 和 Chromium。
恢复流程使用 Linux 进程身份与内核锁，没有宣称原生 Windows/macOS 后台监督已可用。

```sh
git clone https://github.com/AxelHu/keyforge-tco-bot.git
cd keyforge-tco-bot
npm ci
npm run build
npx playwright install chromium
node bin/kf-auto.mjs --help
```

也可显式配置已安装的 Chromium。安装、构建和离线测试不会登录游戏服务器或开局。
根据 [操作说明](docs/operations.md) 和 `examples/` 填写自己的服务器、账号、牌组和凭据路径，
将真实配置、浏览器 profile 和决策记录放在忽略的 `.local/` 下。先执行 preflight，再显式启动。

## 兼容与策略范围

适配器以固定 Keyteki 协议版本开发，前身在一个 Keyteki 衍生部署做过实战。
用户脚本有 TCO 匹配规则，但这不等于公开 TCO 当前登录、大厅和选牌界面已完成无人值守验收；
本次独立提取版本的实际验证范围见 [验证记录](docs/validation.md)。

服务器负责合法性与规则结算。策略使用独立的公开元数据和有限估值知识；
未建模的效果、额外规则和不确定性会保留，不会通过删除字段把它们变成“已完全理解”。
完整规则执行库及批量上游卡文不随包发布，具体覆盖见 [知识格式](docs/card-knowledge.md)。

前身曾在固定对手/牌组上完成 20 场自然对局，17 胜 3 负，另有一次技术认输。
这份战绩属于当时的冻结版本，**不属于本次独立提取包**，也不构成此版本长期胜率承诺。

## 开发与授权

```sh
npm test
npm run check:package
```

离线回归使用合成玩家视角、计时器、HTTP 和原生传输边界；不会载入私有复刻 Game 或连接实服。
源码按 [MIT](LICENSE) 提供，第三方依赖及协议参考见 [NOTICE](NOTICE.md)。本项目为非官方项目。
