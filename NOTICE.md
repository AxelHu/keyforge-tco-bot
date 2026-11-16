# 来源、署名与许可范围

本项目的原创实现、声明式规则知识和项目自写的行为摘要，按 [MIT 许可](LICENSE) 提供。第三方依赖保留各自许可。下述第三方游戏原文有独立来源，本项目不通过 MIT 声明对这些文字重新授权。

## 本仓公开的内容

本仓包含玩家视角适配、策略估值、完整静态卡牌知识，以及浏览器和后台对局管理。静态知识是只读数据：它保留条件、效果声明、说明和研究约定，方便策略读取与迭代。

本仓没有带入原项目的 Game、状态推进器、规则结算队列、游戏服务端、游戏界面或回放执行器。完整知识数据不等于完整游戏程序，也不表示当前策略已经理解和准确估值所有效果。

## 项目自写的知识与研究说明

规则结构与大部分英文 `summary` 使用本项目自己的声明格式和行为说明。它们与来源卡牌的事实交叉核对，但不包含上游卡牌类、动作框架或游戏执行程序。

研究解释继续保留 `research-convention` 等原始限定。它们是项目采用的解释或待裁定约定，不应改写成出版方已明确确认的规则。数据范围和迭代入口见 [卡牌知识说明](docs/card-knowledge.md)。

## 默认知识使用的第三方原文

`src/knowledge/printed-text.ts` 单独保存默认目录实际使用的来源文本，并记录相应卡牌标识、来源包和文本校验值。它与项目自写摘要分开：

- Tokens of Change：55 条普通卡牌说明，以及 28 个衍生物来源值，其中 Guardian 的来源文本为空。
- Winds of Exchange：25 条非空衍生物说明。
- 合计 **107 条非空来源原文和 1 个必要空值**。另外 3 个 WoE 空规则说明使用项目原有自写回退文案。
- 未使用的完整原文表、卡图、风味文字、全部语言包及原始卡包文件没有随本仓发布。

这些文字从原项目已有数据中恢复，保持当时策略输入的字节内容与语义。其相关版权仍属于各自权利人；这里的来源记录不是本项目对第三方文字作出的新许可授予。

直接来源为 Keyteki 固定提交
`361c085bcd401c20976ee9bcc4e4e5b8c061d56c` 的数据文件：

| 来源 | SHA-256 |
| --- | --- |
| [ToC.json](https://github.com/keyteki/keyteki/blob/361c085bcd401c20976ee9bcc4e4e5b8c061d56c/master-vault-data/packs/ToC.json) | `c7c847f1204d4b5dcc7796d4e55ef10161d927b8c52ef225bac634d035fb9010` |
| [WoE.json](https://github.com/keyteki/keyteki/blob/361c085bcd401c20976ee9bcc4e4e5b8c061d56c/master-vault-data/packs/WoE.json) | `2e9c981d05cbc3c47bd9dfda232cf043f3c7fc4c781cc8659966552dc95b7e9d` |

上游 [Master Vault Data README](https://github.com/keyteki/keyteki/blob/361c085bcd401c20976ee9bcc4e4e5b8c061d56c/master-vault-data/README.md) 描述了 Master Vault API 数据及其他预览来源的导入方式。在这个固定版本中，根 [LICENSE](https://github.com/keyteki/keyteki/blob/361c085bcd401c20976ee9bcc4e4e5b8c061d56c/LICENSE) 是 AGPLv3，而 [package.json](https://github.com/keyteki/keyteki/blob/361c085bcd401c20976ee9bcc4e4e5b8c061d56c/package.json) 的许可字段为 MIT；数据目录没有独立的许可文件。本仓如实记录这些来源信息，没有把该字段差异解释为游戏出版文字获得新的 MIT 授权。

## 协议参考与名称

适配器参考上述固定 Keyteki 版本的玩家协议。上游游戏应用没有作为本仓运行依赖或程序源码捆绑。

KeyForge、The Crucible Online 及相关名称用于识别和兼容性说明。本项目为非官方项目，与游戏出版方或 TCO 运营方没有隶属或背书关系。官方卡图、标志和完整规则书不随包提供。

## 私有运行数据

真实凭据、浏览器 profile、原始实战玩家视图、个人套牌收藏和原私有 Git 历史不在本仓中。示例账户和回归夹具为合成数据。运行后生成的日志可能包含使用者自己的手牌或档案信息，应保留在忽略的本地运行目录中。

## 第三方依赖

依赖按 `package-lock.json` 安装，原许可和声明保留在各自包中。Playwright、TypeScript 及传递依赖 diff-match-patch 使用 Apache-2.0；jsondiffpatch、Socket.IO 和 Node.js 类型声明使用 MIT。Socket.IO 只用于离线测试夹具。本仓不分发 Chromium 二进制，浏览器由使用者单独安装。

## English scope note

The MIT grant covers this project's original implementation, authored rule declarations and authored summaries. The separately identified third-party game text in `src/knowledge/printed-text.ts` retains its source attribution and underlying rights; this project does not relicense that text under MIT. Dependency licenses remain separate. This repository contains static strategy knowledge and a client runner, not the authoritative game engine or the upstream application.
