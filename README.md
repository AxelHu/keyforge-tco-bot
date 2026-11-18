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

<!-- hand-opportunity-063:start -->
### 0.6.3 的回收搭档与弃牌选择

在同一局的四个公开位置，0.6.2 率先选择弃牌；0.6.3 将正常出牌腾出的补牌位计入相同比较，四张牌的首选均变为打出。多张回收先共享本轮出牌次数、费用和许可，再对留手牌的同势力搭档计分。离线回归通过 579/579。

开发集合计 49 胜 47 负（51.04%），确认集合计 197 胜 187 负（51.30%）。两个家族的确认区间都覆盖 50%，这批对照未能区分稳定的胜率变化。 [完整报告](docs/hand-opportunity-evaluation.md) · [公开数据](docs/evidence/hand-opportunity-2026-11-18.json)
<!-- hand-opportunity-063:end -->

<!-- card-lifecycle-062:start -->
### 0.6.2 的牌区转移估值

**0.6.2** 按公开的实际目的地与再次使用窗口，比较弃牌、清除、回收、归档和进手前后的机会，并在整次候选动作中统一计算一次正常补牌差分。普通牌质量复用已有公开效果估值与回退；时间折价仍是启发式，未建立完整牌组组合搜索。源码 `ead3992` 通过完整离线回归 **549／549**，包含原有 483 项与本轮新增 **66 项**（区域模型 28、回收窗口 19、消费者整合 19）。

改动前的 **32 局冻结 0.6.1 诊断**保留实际公开决策和全部候选评分；受控 Witch 第三钥匙反例、Labwork 窗口及公开输入重放另列，不把受控反例当成自然局频率。本轮固定比较设计为对冻结 0.6.1 的 **96 局开发 + 384 局确认**，仅比较 **Engine V3 与 Card Effects V3** 两个家族各自的新旧实现。经共享路径调用的派生策略也可继承改动；两个家族的样本不构成全部 89 个策略或常用五项的新排名。

固定比较已完整结束：开发 **46 胜 50 负**，确认 **192 胜 192 负（50.00%）**，两阶段均自然完赛、技术终止与异常为零。两个策略家族的确认区间均包含 50%；本轮没有证实稳定的整体胜率提升，同时新增估值增加了决策耗时。

方法、边界和最终对照结果统一见[牌区转移与再次使用估值](docs/card-lifecycle-evaluation.md)，核验数据见[公开证据摘要](docs/evidence/card-lifecycle-2026-11-18.json)。局部修复与专项通过不能推出稳定胜率提高；本轮没有新增线上战绩或 Elo。
<!-- card-lifecycle-062:end -->

<!-- contextual-formulas-061:start -->
### 0.6.1 的历史公式验证

**0.6.1** 扩充当前公开场面的公式求值、连续状态依赖及有公开概率模型的随机估值。最终候选通过完整离线回归 **483／483**，新增 **57 项**专项已计入总数；另有 **94 项**独立检查与 **97 次**公共输入不变性断言。

固定 12 副牌组的本地比较中，对 0.6.0 的开发集为 **51 胜 45 负**，确认集为 **201 胜 183 负（52.34%）**；对 0.5.3 的单独参照组为 **102 胜 90 负（53.12%）**。各批次分别报告，source01／source02 的 849 局中间候选结果不计入最终 672 局。修复案例、分策略区间、重复种子及冻结计划元数据差异见[动态公式与对照测试](docs/contextual-formula-evaluation.md)。该版本没有新增线上战绩或 Elo。
<!-- contextual-formulas-061:end -->

已适配福州服与国际服 TCO。当前维护测试以**福州服和自有账号对局**为主；国际服真人匹配自 2026-11-17 起暂停，适配器和英文聊天配置继续保留。

0.6.3 的验证涵盖回收搭档、即时出牌和弃牌估值。0.6.2 的验证聚焦生命周期估值、公开输入回放与固定本地对照；0.6.1 的公式验证保留历史归属。既有线上验证包括 0.5.3 的中文捕获分配、0.5.2 的准备超时退出与送达恢复；这些记录保留各自的源码版本和适用范围。当前版本的结果、历次失败与线上验证详情统一见[验证说明](docs/validation.md)。

后台 CLI 面向 **Linux 或 WSL 内的 Linux**，需要 Node.js **22.12–24.x**、Python 3 和 Chromium；原生 Windows、macOS 的后台监督尚未验证。

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
