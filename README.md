# KeyForge TCO Bot

面向 Keyteki 兼容服务器的实验性策略与浏览器自动打牌工具。包含代码策略、原生玩家视角适配、本机策略宿主、浏览器桥接、看门狗、房间生命周期管理和顺序连续对局。

本仓是独立整理的客户端与策略项目，保留策略使用的静态卡牌知识。原私有项目的 KF 复刻引擎、游戏服务端、游戏界面和历史实战原始数据不在本仓中。

[English](README.en.md) · [架构](docs/architecture.md) ·
[卡牌知识](docs/card-knowledge.md) · [使用与恢复](docs/operations.md) ·
[策略选单与历史 Elo](docs/strategy-guide.md) · [国际服与英文聊天](docs/international-tco.md) · [线路实测与后续对局](docs/international-network.md) · [验证记录](docs/validation.md)

## 包含哪些能力

- 基于己方可见信息和对手公开信息的代码策略，包含 Engine V3 策略系列。
- 原生玩家状态投影、菜单导航、物理卡牌身份绑定、分配操作和原生命令编译。
- 仅监听本机回环地址的策略宿主，通过页面文档身份和发送凭证管理控制权，并分别记录“已准备”“已进入浏览器队列”“已观察到效果”。
- 带明确请求期限的浏览器桥接和独立看门狗。精确的已观察回执对账不会重放送达情况不明的命令。
- 单席加入/建房、自然终局退场、账号锁、连续对局健康检查、显式暂停和有明确适用条件的恢复流程。
- 国际服可选的原生断线退出：等待服务器明确提供无损离桌，并将这类离席独立于自然胜负记账。
- 显式选择浏览器直连或代理，并为连续对局设置自然局数、尝试次数和累计时间上限；到限后停止发起新局。
- 包内 Chromium 管理与显式本地配置。运行不依赖 OpenClaw、订阅凭据或原研究仓库；可选的牌桌聊天功能默认关闭。

## 兼容范围

已适配福州服与国际服 TCO。本机本轮国际服实测建议优先使用代理线路：较大前端资源加载更稳定，但直连的 WebSocket 往返延迟更低，结论不代表所有网络。配置方法见[国际服指南](docs/international-tco.md)。

当前 **0.5.1** 冻结源码 `365f06a` 的公开回归已完成：一场 **3:1 自然获胜，133／133 条指令确认**；另一次对手在准备阶段退出，站点以 0:0 判本方胜，单列为非自然终局，不计策略胜率。两次尝试合计 **134／134 条指令确认、6 条英文原生聊天回显、4,012 tokens**，均自动离桌并释放资源，批次达到上限后正常退出。旧版三场自然负局仍按原版本保留；这些小样本不构成新的 Elo 或策略增强证明。

上一批国际服真人观察（源码 `80c3cd3`）已完成 **3 场自然终局，0 胜 3 负**，比分依次为 1:3、1:3、2:3；**483／483 条动作确认**，三局均自动离桌并释放运行资源。随后第 4 局在开局准备阶段遇到对手断线，已由操作员按页面提供的无损 `Leave Game` 正常离桌，单独保留人工处置记录，不计策略胜负。该批次已经结束并暂停，旧预算没有重置。三场自然局有 17 次真实模型调用和 17 条本方原生聊天回显，其中 16 条包含英文内容，1 条仅含两个双引号，后者属于聊天质量问题。

本轮扩展自有账号私房另有 **3 场自然终局并自动收尾**，1 场技术失败及人工清理；各阶段使用的源码分别保留，不混算成当前版本战绩。这些样本用于适配验证，尚不支持新的 Elo 或真人胜率结论。

**0.5.1** 增加可选的“对手持续断线后正常离桌”：确认原生断线、无损离桌提示和没有待发操作，再等待连续 120 秒；实际离席与资源退出均确认后才允许下一局。真实自有账号私房已验证一次完整自动退出：连续断线约 145.3 秒后正常离桌，原生命令、服务端离席、资源和驱动退出均确认。功能默认关闭，启用方式、现场验证与完整批次记录见[断线退出与最新实测](docs/international-disconnected-exit.md)。

最新完整测试 **298／298** 通过。后台 CLI 面向 **Linux 或 WSL 内的 Linux**，需要 Node.js **22.12–24.x**、Python 3 和 Chromium；原生 Windows、macOS 的后台监督尚未验证。完整能力边界见[验证说明](docs/validation.md)。

## 安装

```sh
git clone https://github.com/AxelHu/keyforge-tco-bot.git
cd keyforge-tco-bot
npm ci
npm run build
npx playwright install chromium
node bin/kf-auto.mjs --help
```

也可以显式配置系统中已有的 Chromium 可执行文件。安装依赖、构建和运行离线测试不会登录服务器或开始对局。

## 快速启动

本仓已经包含独立运行所需的策略、静态知识、桥接和后台工具。在支持的 Linux 环境完成依赖、构建及本地配置后，可以直接通过 CLI 启动，不需要原私有 KF 引擎或 OpenClaw。目标站点仍需兼容当前支持的登录、选牌及房间协议；使用国际服前请阅读[适配与验收状态](docs/international-tco.md)。

创建自己的新配置：

```sh
node bin/kf-auto.mjs init \
  --directory "$PWD/.local/my-bot" \
  --origin 'https://your-keyteki.example' \
  --account 'YourAccount' \
  --server-deck-id 12345 \
  --deck-name 'Your deck name' \
  --policy tactical-style-engine-v3
```

`init` 默认生成 `room.gameType: "beginner"`。需要公开休闲房时，在尚未启动的 `seat.json` 中将其改为 `"casual"`，保持 `room.gameFormat: "normal"`，房间名保留 `AI` 标识。房型通过配置字段选择，具体示例见[操作指南](docs/operations.md)。

在本地生成的 `credentials.json` 中填入实际密码，再执行：

```sh
node bin/kf-auto.mjs preflight \
  --config "$PWD/.local/my-bot/seat.json" \
  --create-public

node bin/kf-auto.mjs seat create \
  --config "$PWD/.local/my-bot/seat.json"
```

预检查不读密码、不登录，也不认证站点界面；`seat create` 才会打开浏览器并尝试建房。加入已有房间、冻结运行时和连续对局见[操作指南](docs/operations.md)。将真实配置、浏览器 profile 和决策日志放在 Git 忽略的 `.local/` 下，凭据文件只允许其所有者访问。

## 策略选单

```sh
node bin/kf-auto.mjs strategies list
node bin/kf-auto.mjs strategies list --all
node bin/kf-auto.mjs strategies show tactical-style-engine-v3
```

默认常用菜单包含 **Engine V3（默认）、ToC V2、Cycle V2、Effects V4、Control V2**。原项目注册的 **89 个代码策略全部保留**，专项、实验和历史版本可在完整列表中查看。

选单不连接服务器、不打开浏览器、不改已有配置。初始化时可用 `--policy ID`，或在交互终端用 `--choose-policy` 按编号选择；两者互斥。尚未启动的席位配置也可以修改 `self.codePolicy`。各策略用途、局限与 **2026-11-13 历史 Elo 表**见[策略指南](docs/strategy-guide.md)；历史分数绑定当时的冻结实现，不代表当前代码的新评级。

## 策略与卡牌知识

策略基于当前观察进行启发式评分，远端服务器负责动作合法性与实际规则结算。默认知识包保留原目录中全部 2,546 份静态卡牌定义、`summary` 说明和 `ruleInterpretations` 解释标注。这些内容是只读的策略输入；本包不包含用于本地运行对局的规则引擎。

策略估计器只能处理其中一部分效果。保留一张牌的完整定义，不等于已经完整模拟它的所有交互；未知效果、额外规则和估计的不确定性仍需要明确处理，不能当作确定的零影响。

[卡牌知识说明](docs/card-knowledge.md)介绍静态数据、估值能力、未支持的效果和扩展接口。策略数据中的卡名、卡文和解释标注保留原语言，不随中文文档翻译。

## 开发

```sh
npm test
npm run check:package
```

离线回归使用合成观察、计时器、传输和 HTTP 边界，直接覆盖生产组件；不会构造私有引擎中的 Game，也不会连接公开游戏服务器。包边界检查还会核对相对模块依赖，以及是否意外带入引擎或私有数据路径。

前身曾在一个固定外部对手/牌组上完成 20 场自然对局，17 胜 3 负，另有一次技术认输。该战绩属于当时的冻结构建，**不属于这个独立发布包**，也不能估计本包当前的胜率。已经实际完成的检查见[验证记录](docs/validation.md)。

## 许可

原创代码按 [MIT](LICENSE) 提供。第三方依赖许可、协议参考及独立标注的来源卡文见 [NOTICE](NOTICE.md)；项目的 MIT 声明不对第三方文字另授许可。这是非官方项目，与游戏发行方及 The Crucible Online 运营方没有隶属或背书关系。
