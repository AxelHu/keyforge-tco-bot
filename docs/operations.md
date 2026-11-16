# 使用与恢复

本指南介绍如何在 Keyteki 兼容服务器上运行一个受控席位，假设已经完成安装和构建。浏览器归属、支持的操作系统和恢复的具体边界见[运行环境与边界](runtime-notes.md)。

## 1. 创建本地配置

填写自己的服务器、账号，以及服务器选牌界面使用的牌组 ID：

```sh
node bin/kf-auto.mjs init \
  --directory "$PWD/.local/my-bot" \
  --origin 'https://your-keyteki.example' \
  --account 'YourAccount' \
  --server-deck-id 12345 \
  --deck-name 'Your deck name'
```

该命令创建私有目录、`seat.json` 和密码为空的 `credentials.json`。在本地凭据文件中填写密码。初始化不会打开浏览器，也不会覆盖已有目标目录。真实账号文件不要放进 `examples/`。

origin 必须是精确的 HTTP(S) 源地址。服务器牌组 ID 不一定是 Master Vault UUID。如果部署的游戏 socket 位于另一个 origin，使用 `--game-socket-path` 显式提供每一个完整的 HTTP(S) socket 路径；默认只允许同源连接。包中没有内置前身使用的服务器地址。

默认策略为 `tactical-style-engine-v3`，属于代码策略，不需要语言模型密钥。牌桌聊天默认关闭。`ownAccountNames` 应列出自己拥有的全部账号，方便匹配时排除。

## 2. 检查配置

```sh
node bin/kf-auto.mjs preflight \
  --config "$PWD/.local/my-bot/seat.json" \
  --create-public
```

检查输出中的 `readyForExplicitRun`。预检查会核对必要文件、凭据文件权限和输出目录是否为新目录；它不会读取密码、访问站点、验证登录成功或认证当前站点界面。空密码模板也可以通过文件系统检查，因此实际运行前仍须填写密码。

后台运行需要 Linux（包括 WSL 内的 Linux）、Node 22.12–24.x、带 `fcntl` 和 pidfd 支持的 Python 3，以及直接可执行的 Chromium 二进制。默认使用 Playwright 对应版本的 Chromium。`KF_BOT_CHROME` 可以选择直接 ELF 二进制；shell 启动包装脚本会被拒绝。

## 3. 启动单局

创建一个明确标注 AI 的公开新手房间，并等待非己方账号的对手：

```sh
node bin/kf-auto.mjs seat create \
  --config "$PWD/.local/my-bot/seat.json"
```

启动器会在激活策略前，核对已选账号和牌组、房间身份、参与者及首份原生游戏视角。它只控制一个账号；对手的隐藏手牌和未知牌序不进入策略输入。

加入已经观察到的房间时，使用新的席位配置，填写准确的 `room.gameId`、`room.opponentName`、房间名和类型。先执行不带 `--create-public` 的 preflight，再执行 `seat run`。旧输出目录不会被静默复用于另一局。

登录、选牌和房间自动操作以一个本地化的 Keyteki 部署为开发依据。本独立版尚未验证公开 TCO 当前站点的无人值守登录和大厅流程；配置 origin 或匹配用户脚本网址都不能扩大该兼容性结论。

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
  --id my-campaign
```

这两个命令都只准备本地文件，不会开始对局。冻结包含公开运行时和生产 npm 依赖，并对选定的 Node、Python 和 Chromium 安装内容计算哈希；不会复制凭据、浏览器 profile 或连续对局数据。这是内容快照，不是容器或完整操作系统镜像。

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
