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

## 兼容范围与当前验证

已适配福州服与国际服 TCO。当前维护测试以**福州服和自有账号对局**为主，国际服真人匹配自 2026-11-17 起暂停。国际服适配与英文聊天配置继续保留；这里记录的是本项目当前的测试安排。

**0.5.2** 修复了自建房选牌准备超时后长期保留运行进程的问题，补齐 HTTP polling 下的选牌观察，区分 SPA 内部跳转与真正换文档，过滤聊天模型产生的空引号、纯标点回复，并取消关闭聊天时无意义的终局等待。本方准备异常在安全释放资源后仍会暂停批次；只有证据完整的中性等待取消才可继续。策略评分和卡牌算法本次没有改变。

完整离线回归 **386／386** 通过，失败、跳过、取消均为 0，并已完成独立代码复核。新增 88 项测试已包含在总数内。福州自有私房已通过准备超时退出专项及两场自然完整生命周期检查；最终源码的一局为 3:1，203／203 条入队指令得到确认。真实自有账号验证、历史批次收尾和修复的适用范围见[准备阶段修复与福州自测](docs/preparation-retirement.md)。

同一 **0.5.2** 生产源码另完成一次真实延迟故障专项：浏览器超时后，迟到响应被隔离，看门狗凭精确的已观察送达证据自行恢复；旧指令只发送一次、确认数没有虚增，恢复后自然 **3:0** 结束，**193／193** 条指令确认，资源全部退役。本次没有修改策略或增加 Elo 样本。范围、计时和辅助收据程序的原始失败见[请求截止与送达恢复验收](docs/recovery-validation.md)。

历史国际服真人自然战绩按实际源码分开记录：0.5.0 为 **0 胜 3 负**，0.5.1 为 **1 胜 1 负**，合计 **1 胜 4 负**。站点 0:0 判胜、无人入席和准备失败均不加入自然胜负。最后一个 0.5.1 后台批次包括 1 场自然负局、3 次无人入席和 1 次准备失败；失败尝试已人工释放资源，旧分类和预算保留。这些小样本未用于更新 Elo。

0.5.1 的可选对手断线退出已在真实自有私房中验证一次，连续断线约 145.3 秒后正常离桌并完成资源退役；默认关闭。此前扩展私房也保留了三场自然自动通过及一次技术失败的实际版本归属。历史记录见[国际服验收](docs/international-tco.md)和[断线退出验证](docs/international-disconnected-exit.md)。

后台 CLI 面向 **Linux 或 WSL 内的 Linux**，需要 Node.js **22.12–24.x**、Python 3 和 Chromium；原生 Windows、macOS 的后台监督尚未验证。完整能力边界见[验证说明](docs/validation.md)。

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
