# 运行环境与边界

本包包含本机策略宿主、玩家视角适配器、浏览器桥接、单席启动器、看门狗、连续对局监督器和有明确适用条件的恢复工具。它不运行本地 KeyForge 规则服务器或竞技场。策略从观察到的原生动作中选择，远端服务器负责实际对局。

自动 UI 流程已在福州服和国际服 TCO 做过分阶段实测，包括自有私房与按实际源码分别记录的真人对局。2026-11-17 起，维护测试以福州服和自有账号为主，国际服真人公开匹配暂停；适配和英文聊天配置保留。各版本的覆盖范围见[验证记录](validation.md)和[国际服说明](international-tco.md)。配置 origin 本身不证明另一部署的登录、选牌、房间或游戏节点界面兼容；原生界面变化或缺乏支持时，程序会停止绑定，不会猜测房间、账号、牌组或动作。

## 安装

当前运行时支持 Linux、Node 22.12–24.x、带 `fcntl` 的 Python 3 和 Chromium。托管进程信号需要 Python/Linux 的 `pidfd_open` 与 `pidfd_send_signal`；能力不可用或身份无法核实时，不会降级为可能被复用的裸 PID。

```sh
npm ci
npm run build
npx playwright install chromium
node bin/kf-auto.mjs --help
```

Playwright 是包声明的依赖，不需要全局 agent 配置或额外安装的浏览器辅助程序。默认使用对应版本的 Chromium 可执行文件。要选择其他安装，将 `KF_BOT_CHROME` 设为直接 ELF Chromium 二进制；shell 启动包装脚本会被拒绝。Chromium 沙箱默认开启；确有需要的环境可以显式设置 `KF_BOT_NO_SANDBOX=1`。

## 创建本地配置

填写自己的账号和选定牌组。服务器牌组 ID 是站点选牌界面使用的原生 ID，不能猜测为 Master Vault 标识。

```sh
node bin/kf-auto.mjs init \
  --directory "$PWD/.local/demo" \
  --origin 'https://your-keyteki.example' \
  --account 'YourAccount' \
  --server-deck-id 12345 \
  --deck-name 'Your deck name'
```

该命令写入带绝对本地路径的 `seat.json` 和私有 `credentials.json` 模板。在本地凭据文件中填入实际密码。初始化不会启动浏览器，也不会覆盖已有目录。`examples/` 中的 JSON 使用占位路径描述相同配置格式；用 `init` 可以避免逐项手填绝对路径。

`origin` 必填，必须是精确的 HTTP(S) 源地址，不能包含凭据、路径、查询参数或片段。账号和牌组身份需要显式指定。`ownAccountNames` 默认只有受控账号；将自己拥有的其他账号也加入，方便匹配时排除。

默认传输策略只接受同源游戏节点路径。如果实际部署使用不同的游戏节点 origin，在 `gameSocketPaths` 中逐项配置精确的 HTTP(S) 节点路径，例如该部署上完整的 `/node1/socket.io` URL。没有隐含的 IP、端口、通配符或相邻节点例外。`init` 支持多次传入 `--game-socket-path`。

牌桌聊天默认关闭，且与纯代码策略独立。要启用可选的 MiniMax 服务，在席位配置中设置 `social.enabled`，并在进程环境中显式提供 `MINIMAX_API_KEY`。程序不会读取主目录账号存储；仅运行代码策略不需要模型密钥。

## 单席运行

```sh
node bin/kf-auto.mjs preflight --config "$PWD/.local/demo/seat.json" --create-public
node bin/kf-auto.mjs seat create --config "$PWD/.local/demo/seat.json"
```

preflight 是离线检查，核对配置、必要文件、私有凭据文件权限和全新输出目录。实际运行时仍会核验所配置的策略、真实登录、已选牌组、原生房间、双方参与者和初始玩家视角。预检查不读取密码，也不能认证登录成功。

加入房间时，在新的席位配置中填写准确观察到的 `room.gameId`、`room.opponentName`、房间名和类型，然后使用 `seat run`。公开建房默认使用名称中标明 AI 的 beginner/normal 房间，也支持显式选择 casual 类型。只控制一个席位，对手的私有手牌和未知牌组构成不进入策略输入。

本机宿主提供 `host start/status/pause/resume/stop --profile DIR`；其中 `start` 还需要 `--config FILE`，应指向启动器生成的 `bridge-config.json`，不能使用 `seat.json`。恢复宿主运行不会修复不受支持的游戏机制，也不会自动覆盖浏览器中显式的人工接管。

## 冻结并运行连续对局

```sh
node bin/kf-auto.mjs runtime freeze --output "$PWD/.local/runtime-example"
node bin/kf-auto.mjs campaign prepare \
  --seat "$PWD/.local/demo/seat.json" \
  --manifest "$PWD/.local/runtime-example/runtime-manifest.json" \
  --config "$PWD/.local/demo/campaign.json" \
  --output "$PWD/.local/demo/campaign-data" \
  --id demo-campaign
node .local/runtime-example/tools/cli.mjs campaign run --config "$PWD/.local/demo/campaign.json"
```

从 manifest 指定的冻结运行时入口启动连续对局。`campaign prepare` 绑定 manifest 的实际字节，不会启动浏览器或自动更换账号。默认代码策略为 `tactical-style-engine-v3`；可以配置其他已导出的代码策略，同时保留生命周期检查。默认选择不代表经过比较后的棋力排名。

连续对局使用内核持有的账号锁，每次尝试由独立 worker 运行。它在派发前核验运行时，观察原生匹配情况，并将尝试记录与自然对局结果分开。人工暂停、未解决发送、身份、退役和技术失败条件都会保留。现有观察阶段会在达到要求的稳定自然对局数后暂停；`campaign enable-unattended --config FILE` 只适用于符合条件的现有状态。`campaign pause --config FILE` 请求在当前尝试结束后停止。

独立包的磁盘检查默认要求 5 GiB 可用空间，可以通过 `minimumFreeBytes` 显式配置不低于 128 MiB 的值。检查发生在新尝试前，不会删除历史结果来腾出空间。该设置独立于开发仓库本身的存储策略。

## 浏览器归属与关闭

浏览器 profile 和租约使用 `keyforge-tco-bot` 命名空间。默认注册表位于 `~/.cache/keyforge-tco-bot/browsers` 下；可以通过 `KF_BOT_BROWSER_ROOT` 或精确的 `KF_BOT_BROWSER_REGISTRY` 路径覆盖。启动、释放和恢复使用相同的路径函数；同一连续对局及其恢复操作应保持一致的环境配置。

每个 profile 都有内核锁、托管进程绑定、精确 CDP 端点和逐一标识的客户端。无法确定的进程或客户端状态会保留，不会静默接管私有共享浏览器。shell 包装脚本、包含符号链接的 profile 路径、未知租约或进程身份不匹配，都不会触发替换浏览器。自动退役不会删除用户 profile 或锁文件 inode。

SIGINT/SIGTERM 保留启动器的操作者暂停行为。停止监督器不能证明原生席位、driver、宿主或托管浏览器已经消失。服务包装层必须尊重当前尝试和退役状态，不能无条件重启或批量清理进程。新连续对局不会静默替换尚未解决的 active attempt。

## 恢复与证据

普通策略请求通路与独立的原生看门狗观察通路彼此分开。一次本地请求达到期限，并不会撤销宿主已经接受的写入。未知送达恢复需要原有的精确控制方、凭证、序号和已观察效果证明；它不会从空队列推导出 ACK，也不会重发可能已经执行的游戏命令。成功对账后，旧上下文保持暂停，并使用受保护的刷新/重新附着流程。

0.5.2 已在福州自有私房完成一次真实延迟回包验证：浏览器侧超时、迟到响应隔离、已观察凭证对账、刷新后继续出牌及终局退出均有现场证据。Node fetch 中止与其他负面边界的覆盖仍单独区分，见[恢复验收](recovery-validation.md)。

`recovery storage prepare|commit` 保留配置、运行时、记录绑定及事务恢复检查。`recovery unjoined prepare|commit` 只适用于明确绑定的入座前保护版本，并要求停止回执、原件保全、零游戏发送证据、新鲜的原生无席位观察、进程/租约核验和比较后交换写入。它不能用于任意清空 checkpoint。本包的固定哈希识别本包已审查文件，不承诺迁移无关的历史安装。

连续对局输出属于私有运行状态，可能包含账号标识、端点和玩家视角诊断文件；凭据保存在另行配置的私有文件中。这些数据不要复制进公开发布包。公开示例不含真实账号、牌组 UUID、凭据或安装路径。

## 原生效果消息的语言范围

0.5.3 对捕获额度及 Hypnotic 单敌方琥珀分支，同时识别实际观察到的完整英文 `" uses "`／`" to "` 与中文 `" 使用 "`／`" 来 "` 外层词对。身份、来源、连续消息窗口、内层效果和数值约束仍需各自满足；其他未支持的效果形态仍会明确暂停。这里的语言兼容是精确协议形状的兼容，具体现场证据见[中文效果验证](localized-capture-validation.md)。

## 运行时 manifest 能证明什么

冻结使用显式允许清单：生产 `tools` JavaScript、编译后的 `dist/src`、二进制入口包装、包元数据和生产 npm 依赖闭包。测试、示例、私有状态、连续对局数据、引擎源码和 Git 元数据不在其中。编译后的复刻引擎/服务器目录和带符号链接的输入会被拒绝。已有输出目录不会被替换；文件复制完成后才发布 manifest，失败的部分输出会保留供诊断。

manifest 记录内容哈希，以及本地 Node、Python、Chromium 的执行路径。带内容指纹的新格式还会在派发前重新收集运行时及依赖的精确文件集合，防止新增模块悄悄遮蔽冻结依赖。旧格式 manifest 保留其原有、较窄的核验范围。新 manifest 在连续对局核验时还要求可执行文件选择一致，环境变量不能静默改用未绑定浏览器。Playwright 管理的安装会绑定外部浏览器资源；系统安装会绑定直接可执行文件。这不是隔离完整操作系统依赖的镜像。`sourceCommit` 为 null，不伪造 Git 提交；`sourceFingerprint` 标识冻结运行时的实际字节。

公开离线测试覆盖配置、精确端点范围、进程身份、pidfd 信号、租约身份、CLI 路由和冻结文件范围。实际测试执行与实服验收分别记录，具体见[验证记录](validation.md)；实际验收结论以对应源码版本和独立证据为准。
