# 使用与恢复

本指南介绍如何在 Keyteki 兼容服务器上运行一个受控席位，假设已经完成安装和构建。公开仓包含独立运行所需的策略、静态知识、桥接和后台工具；目标站点还需兼容当前支持的登录、选牌与房间界面。浏览器归属、支持的操作系统和恢复的具体边界见[运行环境与边界](runtime-notes.md)。

## 1. 选择策略并创建本地配置

先查看本地策略选单：

```sh
node bin/kf-auto.mjs strategies list
node bin/kf-auto.mjs strategies list --all
node bin/kf-auto.mjs strategies show tactical-style-engine-v3
```

默认展示 Engine V3、ToC V2、Cycle V2、Effects V4、Control V2 五项，默认策略保持 Engine V3。完整列表保留原项目的全部 89 个注册 ID，包含专项、实验和历史策略；`--json` 可输出供脚本使用的数据。选单不连接服务器、不打开浏览器、不修改已有配置。用途和历史 Elo 见[策略指南](strategy-guide.md)。

填写自己的服务器、账号，以及服务器选牌界面使用的牌组 ID：

```sh
node bin/kf-auto.mjs init \
  --directory "$PWD/.local/my-bot" \
  --origin 'https://your-keyteki.example' \
  --account 'YourAccount' \
  --server-deck-id 12345 \
  --deck-name 'Your deck name' \
  --policy tactical-style-engine-v3
```

该命令创建私有目录、`seat.json` 和密码为空的 `credentials.json`。在本地凭据文件中填入实际密码。初始化不会打开浏览器，也不会覆盖已有目标目录。真实账号文件不要放进 `examples/`。

也可以把 `--policy tactical-style-engine-v3` 换成 `--choose-policy`，在交互终端按编号选择；这两个选项互斥，`--choose-policy` 只支持 TTY。自动化脚本应显式使用 `--policy ID`。选好有效策略并通过配置校验后，初始化才写入新配置；两者都不指定时仍使用 Engine V3。

origin 必须是精确的 HTTP(S) 源地址。服务器牌组 ID 不一定是 Master Vault UUID。如果部署的游戏 socket 位于另一个 origin，使用 `--game-socket-path` 显式提供每一个完整的 HTTP(S) socket 路径；默认只允许同源连接。包中没有内置前身使用的服务器地址。

这些入口运行代码策略，不需要语言模型密钥。牌桌聊天默认关闭。国际服 `thecrucible.online` 默认使用英文聊天与故障说明，可用 `init --chat-language en` 明确写入；其他部署保持中文默认。启用模型聊天和国际服验收状态见[国际服说明](international-tco.md)。`ownAccountNames` 应列出自己拥有的全部账号，方便匹配时排除。

尚未启动的席位配置可以直接修改 `self.codePolicy`，然后重新预检查；全部 89 个注册 ID 均可选择，未注册的 ID 会在配置校验阶段拒绝。不要在已经开始的 campaign 上热改策略，它绑定了配置摘要和已有记录。需要更换时，准备新的配置与输出目录，并保留原尝试的未解决状态。

## 2. 检查配置

```sh
node bin/kf-auto.mjs preflight \
  --config "$PWD/.local/my-bot/seat.json" \
  --create-public
```

检查输出中的 `readyForExplicitRun`。预检查会核对策略 ID 是否已注册、必要文件、凭据文件权限和输出目录是否为新目录；它不会读取密码、访问站点、验证登录成功或认证当前站点界面。空密码模板也可以通过文件系统检查，因此实际运行前仍须填写密码。

后台运行需要 Linux（包括 WSL 内的 Linux）、Node 22.12–24.x、带 `fcntl` 和 pidfd 支持的 Python 3，以及直接可执行的 Chromium 二进制。默认使用 Playwright 对应版本的 Chromium。`KF_BOT_CHROME` 可以选择直接 ELF 二进制；shell 启动包装脚本会被拒绝。

### 明确选择浏览器线路

席位配置支持三种 `network` 设置，省略时为 `system`，保持 Chromium 现有网络行为：

```json
{ "network": { "mode": "direct" } }
```

```json
{ "network": { "mode": "proxy", "server": "http://127.0.0.1:7890" } }
```

也可以在 `init` 使用 `--network direct`，或 `--network proxy --proxy-server http://127.0.0.1:7890`。地址仅为示例，需要填本机实际可用的代理。支持 HTTP、HTTPS 和 SOCKS5 代理；地址不能包含用户名、密码、路径、查询参数或其他浏览器开关。

此设置同时用于登录、建房、入座、大厅发现和终局席位核验所在的浏览器；本机回环地址保持直连。它不更改系统代理、VPN 或其他进程的配置，也不决定独立模型 API 请求的线路。`direct` 表示 Chromium 不使用显式代理，系统级 TUN／VPN 仍可能转发流量；比较真实线路时应另核实实际出口。

## 3. 启动单局

公开建房支持新手房 `beginner` 和休闲房 `casual`。`init` 默认生成 `beginner`；需要休闲房时，在尚未启动的 `seat.json` 中调整现有 `room` 对象的这些字段：

```json
{
  "name": "AI game",
  "gameType": "casual",
  "gameFormat": "normal"
}
```

`room.gameFormat` 保持 `normal`，房间名保留 `AI` 或 `人工智能` 标识。房型通过配置字段选择。修改后重新执行上一节的 `preflight --create-public`；其他账号、牌组和本地路径设置继续使用自己的配置。

按配置创建明确标注 AI 的公开房间，并等待非己方账号的对手：

```sh
node bin/kf-auto.mjs seat create \
  --config "$PWD/.local/my-bot/seat.json"
```

启动器会在激活策略前，核对已选账号和牌组、房间身份、参与者及首份原生游戏视角。它只控制一个账号；对手的隐藏手牌和未知牌序不进入策略输入。

加入已经观察到的房间时，使用新的席位配置，填写准确的 `room.gameId`、`room.opponentName`、房间名和类型。先执行不带 `--create-public` 的 preflight，再执行 `seat run`。旧输出目录不会被静默复用于另一局。

登录流程使用 `/login` 和 `/api/account/login`，选牌使用 `Select deck`、`Select row <serverDeckId>` 及精确牌组名。0.4.0 补充英文房间按钮适配，保留既有中文部署的控件支持。较早源码已完成两个自有账号的受控私房完整自动验收。截至 2026-11-16 08:07:29 UTC，当前 casual 增量已完成真实公开无密码房间的创建和一次无对手等待后的自动退场，匹配流程仍在继续；连同早前两次等待，共 3 次尝试、0 开局。真人游戏结果另行记录。详见[国际服配置与验收](international-tco.md)。

### 准备阶段停留或失败

公开建房尚未启动宿主时也可能遇到准备失败。新版本在 `preparePlayer` 出错且已有可用诊断时，将阶段失败信息保存在 `handoff.json` 的 `setupFailure`；检查该回执与原 hold 原因，可以区分已记录的准备阶段。原始泛化错误没有保存的阶段不能从后来的页面状态补造，也不能把空房等待或未开局的准备失败计作策略胜负。诊断信息不会自动消除 hold；后续恢复与资源处理继续遵循已绑定的状态和实际回执。

本次较早 casual 运行的后续准备失败已完成人工退役，原失败分类及不可继续标志保留，未归为自动恢复成功；操作细节见[实测处置记录](international-network.md)。该较早公开阶段累计 4 次正常无对手等待、1 次准备失败。新 r4 已完成首场真人自然负局及自动收尾，观察仍在继续；当前结果与开始新尝试的截止见[线路与对局实测](international-network.md)。

## 4. 为连续对局冻结运行时

连续对局会在开始每次尝试前，绑定精确的运行时与可执行文件：

```sh
node bin/kf-auto.mjs runtime freeze \
  --output "$PWD/.local/runtime-v1"

node bin/kf-auto.mjs campaign prepare \
  --seat "$PWD/.local/my-bot/seat.json" \
  --manifest "$PWD/.local/runtime-v1/runtime-manifest.json" \
  --config "$PWD/.local/my-bot/campaign.json" \
  --output "$PWD/.local/my-bot/campaign-data" \
  --id my-campaign \
  --max-natural-games 10 \
  --max-attempts 12 \
  --max-elapsed-ms 14400000
```

这两个命令都只准备本地文件，不会开始对局。冻结包含公开运行时和生产 npm 依赖，并对选定的 Node、Python 和 Chromium 安装内容计算哈希；不会复制凭据、浏览器 profile 或连续对局数据。这是内容快照，不是容器或完整操作系统镜像。

`campaign prepare` 把当时的席位配置（包括 `self.codePolicy`）复制进新 campaign 配置。之后修改原 `seat.json` 不会自动改变已准备的 campaign；请在准备前确定策略，运行后不要直接改其配置摘要所绑定的内容。

上述示例最多允许 10 场自然终局、12 次已发起的入座／建房尝试，或从首次启动起累计 4 小时后停止发起新尝试，任一限制先到即生效。`maxNaturalGames`、`maxAttempts` 和 `maxElapsedMs` 也可以直接写入尚未运行的 campaign JSON。空房、失败尝试和对手认输仍占用尝试次数；自然对局数仅计算已正常退场且结果明确的自然终局。

这些限额与 checkpoint 一起保留。暂停时间和进程退出期间仍计入累计时间，重启不会刷新预算。截止时已经开始的对局继续完成正常收尾；到限不会直接关闭正在打牌的浏览器。未设置限额的旧配置保持原行为，建议新批次明确设置三项上限。已有 3 场稳定自然对局后的观察暂停仍生效；总局数包含这 3 场。

从冻结的入口启动：

```sh
node .local/runtime-v1/tools/cli.mjs campaign run \
  --config "$PWD/.local/my-bot/campaign.json"
```

若用开发目录入口加载属于另一个根目录的 manifest，会被拒绝。改变已绑定的运行时或可执行文件，需要生成新快照并采用相应的连续对局配置；不要编辑旧 manifest 来掩盖不一致。

监督器持有账号锁，每次尝试启动一个 worker，检查存储与健康状态，并将自然对局结果和技术失败分别记录。默认要求 5 GiB 可用空间；可以通过 `minimumFreeBytes` 显式配置，最低为 128 MiB。空间检查不会删除旧结果。

## 5. 查看状态与暂停

对已经启动过的连续对局：

```sh
node .local/runtime-v1/tools/cli.mjs campaign status \
  --config "$PWD/.local/my-bot/campaign.json"

node .local/runtime-v1/tools/cli.mjs campaign pause \
  --config "$PWD/.local/my-bot/campaign.json"
```

暂停请求会在当前尝试结束后停止。初始观察阶段也会在满足健康条件后暂停，供操作者查看。只有符合条件的稳定状态才能使用：

```sh
node .local/runtime-v1/tools/cli.mjs campaign enable-unattended \
  --config "$PWD/.local/my-bot/campaign.json"
```

随后从同一冻结运行时重新执行 `campaign run`。该操作不会清除其他暂停原因、送达不确定的命令或未解决的尝试。尚未启动过的连续对局在查询状态时返回 `CAMPAIGN_NOT_STARTED`；准备配置不会生成虚假的运行 checkpoint。

底层的 `host status|pause|resume|stop --profile DIR` 操作已有本地桥接 profile。`host start` 使用启动器生成的 `bridge-config.json`，不能直接使用席位配置。正常的单席和连续对局流程会自行管理该宿主。

SIGINT/SIGTERM 保留操作者暂停语义。监督器停止不能证明原生席位、driver、本机宿主和托管浏览器都已退役。服务包装层不应无条件重启并覆盖尚未解决的状态；本版不提供自动服务安装。

## 6. 从受支持的状态恢复

两组命令提供现有的有条件恢复事务：

| 命令 | 用途 |
| --- | --- |
| `recovery storage prepare` | 生成绑定实际暂停配置、运行时和记录的请求。 |
| `recovery storage commit` | 重新核验并应用该明确请求。 |
| `recovery unjoined prepare` | 使用停止回执，为精确匹配已审查的入座前保护逻辑准备对账。 |
| `recovery unjoined commit` | 重新核验原生无席位、零游戏发送、进程/租约状态和文件身份，再应用事务。 |

每次 `prepare` 写入一个新请求文件；`commit` 使用 `--request FILE`。完整选项见 `node bin/kf-auto.mjs --help`。

这些入口不能用于随意删除 checkpoint 后重试。游戏命令送达不确定时，恢复需要准确的控制方、凭证、序号和已观察效果证据，不能重放可能已经被接受的命令。请求在本地超时和游戏效果是否发生，是两件独立的事。

未入座对账只适用于本包绑定的保护逻辑文件，不承诺恢复历史私有安装或其他版本。证据缺失时保留原始状态。

## 运行数据留在本地

仓库只提供合成示例和测试。实际运行输出可能包含账号名、端点、玩家视角和诊断回执，应存放在被忽略的本地目录下。报告问题时，提供错误代码、包版本和最小合成复现；分享任何日志前先检查其中的内容。
