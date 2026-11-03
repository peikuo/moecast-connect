# MoeCast Connect

MoeCast 的电脑连接 Skill 集合。仓库名为 `moecast-connect`；每个具体连接器使用独立的 Skill 名称，按目标工具选择安装。

| Skill | 目标 | 当前状态 |
| --- | --- | --- |
| [`moecast-codex-connect`](skills/moecast-codex-connect/SKILL.md) | 桌面 Codex | Mac Apple Silicon／Windows x64（已有用户调通反馈） |
| `moecast-claude-connect` | Claude | 未来规划，尚无可安装实现 |
| `moecast-grok-connect` | Grok | 未来规划，尚无可安装实现 |

目录按 `skills/<skill-name>/` 组织；暂不创建 Claude、Grok 的占位 Skill，以免被安装工具误判为可用。

## 安装 Codex 连接器

Mac 和 Windows 都使用同一个 Skill 和默认安装入口。将以下指令交给电脑 Codex：

> 请从 https://github.com/peikuo/moecast-connect 安装或更新 `moecast-codex-connect` Skill，并调用它连接手机和当前聊天。请自动检测本机环境，保留已有聊天和配置。

使用 Skills CLI 时，明确选择具体 Skill：

```sh
npx skills add peikuo/moecast-connect --skill moecast-codex-connect --agent codex
```

Skill 会自动检测系统和 CPU 架构，选择对应安装组件，用户无需选择平台、分支或二进制。目前支持 Mac Apple Silicon 和 Windows x64，已有用户 Windows 调通反馈；不同桌面版本仍需按实际能力验证。两者都需要 Node.js 22+、已登录且正在运行的本机 Codex 桌面 App。Windows 请在原生 PowerShell 环境操作，不能使用网页版聊天或 WSL 代替本机入口。CLI 登录本身不足以建立原生桌面连接；Windows 聊天唤起、配对、原生工具和附件等应按本机逐项记录，不能仅据配对成功或 Mac 成绩推断全部通过。详见 [Windows 测试步骤](skills/moecast-codex-connect/references/windows.md)。

用户已报告一台 Windows 机器调试成功。配对、原生工具加载和实际调用应分别记录；该机器的插件注册临时修复见 [Windows 本机排障案例](skills/moecast-codex-connect/references/windows.md#windows-local-case-native-plugin-registration)，不能推广为所有机器的安装步骤。

连接器负责配对、消息、实时回复和附件传输；任务由已有桌面 Codex 聊天以其自身设置执行。当前路径不安装或启动 HAPI Hub／Runner，不新增执行器，不更改桌面模型或权限。具体操作见 [Codex Skill](skills/moecast-codex-connect/SKILL.md)。

## 已有安装和发布范围

Codex 连接器暂时沿用现有 `~/.local/share/moecast-connect` 状态目录及 `MOECAST_CONNECT_HOME`，改名不迁移或清空配对、身份和聊天记录。未来 Claude、Grok 连接器应分别设计状态与权限边界，不能直接复用 Codex 的凭据目录。

Windows 连接还需要本轮单独交付的手机 Windows 路径兼容 APK，旧手机包会拒绝 Windows 目录；对应源码补丁与包校验记录在 [patches](patches/phone-compatibility.json)。本轮不修改现用 Mac 连接或官网正式归档；官网 preview.8 与当前 GitHub preview.9 候选分别记录。主机协议测试、交叉编译和 GitHub Windows CI 不代表真实 Windows Codex／手机已验收。

## 维护

每个 Skill 独立包含 `SKILL.md`、界面元数据、安装脚本、必要的引用及显式白名单运行时。仓库根目录作为索引，不再声明一个名为 `moecast-connect` 的通用 Skill。

Windows x64 隧道随 Skill 提供，安装时校验固定 SHA256；Mac 隧道继续按固定 HTTPS 地址下载并校验。许可及固定源码信息保留在相应 Skill 的运行时目录。完整归档的生成、验证与发布是独立步骤，不修改既有归档冒充新版本。

只提交连接器所需代码与许可。不要提交账号数据、设备凭据、二维码、模型权重、私人日志或聊天记录。

## 版本与更新

当前连接 Skill 为 **0.2.0-preview.10**，支持自动识别 Mac Apple Silicon 和 Windows x64。`doctor` 输出 `skillVersion` 与 `installedVersion`，请以实际文件和检查结果为准。若本地旧 Skill 仍声称只支持 Mac，将旧 Skill 备份到 skills 搜索目录之外后，从本仓库重新安装，并重新读取新 SKILL.md；不要清理位于 Skill 目录之外的配对、配置或聊天。

默认分支与 `main` 安装兼容入口发布同一版本，用户无需选择分支。旧的 preview.8 完整包仅作为历史归档，不能用于 Windows。

## 安全与权限

安装前请阅读 [安全说明](SECURITY.md)。默认扫码授权是电脑级 Codex 查看与派活，固定聊天是入口，并不将能力限制在该聊天。连接沿用桌面 Codex 的既有权限；目前没有独立安全审计，也不宣称绝对安全。
