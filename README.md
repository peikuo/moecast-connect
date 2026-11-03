# MoeCast Connect

MoeCast 的电脑连接 Skill 集合。仓库名为 `moecast-connect`；每个具体连接器使用独立的 Skill 名称，按目标工具选择安装。

| Skill | 目标 | 当前状态 |
| --- | --- | --- |
| [`moecast-codex-connect`](skills/moecast-codex-connect/SKILL.md) | 桌面 Codex | Mac Apple Silicon 预览；Windows x64 测试候选 |
| `moecast-claude-connect` | Claude | 未来规划，尚无可安装实现 |
| `moecast-grok-connect` | Grok | 未来规划，尚无可安装实现 |

目录按 `skills/<skill-name>/` 组织；暂不创建 Claude、Grok 的占位 Skill，以免被安装工具误判为可用。

## 安装 Codex 连接器

将以下指令交给电脑 Codex：

> 请从 https://github.com/peikuo/moecast-connect 安装其中的 `moecast-codex-connect` Skill（目录 `skills/moecast-codex-connect`），并调用它连接 MoeCast 手机与电脑上已有的 Codex 聊天。已有配对和聊天请保留。

使用 Skills CLI 时，明确选择具体 Skill：

```sh
npx skills add peikuo/moecast-connect --skill moecast-codex-connect --agent codex
```

当前提供 Mac Apple Silicon 预览和 Windows x64 测试候选。两者都需要 Node.js 22+、已登录且正在运行的本机 Codex 桌面 App。Windows 请在原生 PowerShell 环境操作，不能使用网页版聊天或 WSL 代替本机入口。CLI 登录本身不足以建立原生桌面连接；Windows 原生聊天唤起、手机配对和附件仍需实机验收，不能沿用 Mac 成绩。详见 [Windows 测试步骤](skills/moecast-codex-connect/references/windows.md)。

连接器负责配对、消息、实时回复和附件传输；任务由已有桌面 Codex 聊天以其自身设置执行。当前路径不安装或启动 HAPI Hub／Runner，不新增执行器，不更改桌面模型或权限。具体操作见 [Codex Skill](skills/moecast-codex-connect/SKILL.md)。

## 已有安装和发布范围

Codex 连接器暂时沿用现有 `~/.local/share/moecast-connect` 状态目录及 `MOECAST_CONNECT_HOME`，改名不迁移或清空配对、身份和聊天记录。未来 Claude、Grok 连接器应分别设计状态与权限边界，不能直接复用 Codex 的凭据目录。

Windows 连接还需要本轮单独交付的手机 Windows 路径兼容 APK，旧手机包会拒绝 Windows 目录；对应源码补丁与包校验记录在 [patches](patches/phone-compatibility.json)。本轮不修改现用 Mac 连接或官网正式归档；官网 preview.8 与当前 GitHub preview.9 候选分别记录。主机协议测试、交叉编译和 GitHub Windows CI 不代表真实 Windows Codex／手机已验收。

## 维护

每个 Skill 独立包含 `SKILL.md`、界面元数据、安装脚本、必要的引用及显式白名单运行时。仓库根目录作为索引，不再声明一个名为 `moecast-connect` 的通用 Skill。

Windows x64 隧道包含在本测试分支中，安装时校验固定 SHA256；Mac 隧道继续按固定 HTTPS 地址下载并校验。许可及固定源码信息保留在相应 Skill 的运行时目录。完整归档的生成、验证与发布是独立步骤，不修改既有归档冒充新版本。

只提交连接器所需代码与许可。不要提交账号数据、设备凭据、二维码、模型权重、私人日志或聊天记录。
