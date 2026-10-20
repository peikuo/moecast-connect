# MoeCast Connect

把 MoeCast 手机前台连接到这台电脑的 Codex 工程与聊天。电脑端只需要 Codex 和这个 Skill，不需要 MoeCast 桌面 App，也不需要新加 MCP。

这是 **v0.2 预览版**，目前电脑端支持 Apple Silicon Mac。手机连接界面由 MoeCast v0.2 的其他模块提供；摄像头扫码 UI 尚未在本仓库验收，协议测试不代表 Play v0.1 已具备这些功能。

## 让 Codex 帮你安装

把这句话交给电脑上的 Codex：

> 请从 https://github.com/peikuo/moecast-connect 安装 MoeCast Connect Skill，并按 Skill 把当前工程连接到我的 MoeCast 手机。

支持 Skills CLI 的环境也可安装：

```sh
npx skills add peikuo/moecast-connect --skill moecast-connect --agent codex
```

另一官方入口：[官网下载与校验](https://moecast.aixagent.cloud/connect/)。如果 GitHub 不可访问，可让 Codex 从官网下载预览包，核对 SHA-256 后安装 Skill。

## 安装、连接与使用

1. Codex 按 Skill 检查 Apple Silicon macOS、Node.js 22+ 和 Codex 登录。缺少 Node 时使用官方发行版或已有可信包管理器安装；终端用户不需要 Go。
2. 确认要连接的工程，安装 HAPI 与受限网关，启动本次连接。不添加登录项、自启动或常驻守护。
3. 首次 HTTPS 签发可能需要几分钟；可信连接准备好后才生成一次性配对二维码。二维码两分钟内有效，单次使用。
4. 手机保存设备独立授权，默认能查看与派活；电脑端仍严格限制到授权工程。前台模型单独选择并保存，不改工作聊天的模型。
5. 说清目标就直接查进度或派活；有歧义时返回无声候选。正常重连回到原聊天，只有明确要求才新建。

服务被关闭或连接失败时，把这句话交给电脑 Codex：

> 调用 MoeCast Connect Skill，排查并修复手机连接问题。

普通断网、手机进程关闭或服务重启不要求重新配对。电脑关闭、休眠或服务停止时，手机不能替代电脑启动服务。

## 已验证与边界

- 新身份、空缓存 HTTPS 签发及 Android 信任校验通过；主 CA 限流时可切换已有备用 CA，不修改代理或关闭证书校验。
- 独立设备授权、已有聊天续接、派活去重与原上下文保留通过手机协议测试。
- 轻量远程前台模型 `gpt-6-luna`：34 道题各测两次，68/68 通过，另有恢复／工具越界／引用／别名否定补测 8/8；Android 前台协议 11 项通过，真实后端候选点选 3 项通过。不是本机小模型或语音识别成绩。
- 前台模型、查询、派活、候选选择、取消和明确新建均提供受限协议；正式 App UI 在其他模块接入。
- 长记录回执分页、证书续期与整机重启等长期恢复加固，以及忙碌/共享执行器接管继续单独验收。暂不支持 Windows、Intel Mac 或远程工程。

## 维护与来源

`SKILL.md` 是 Codex 入口。`scripts/connect.mjs` 管理安装与连接，`assets/runtime/source-manifest.json` 记录显式打包文件哈希。HAPI 固定版本独立下载并校验 SHA-512，不在本仓库分发其二进制或任何账号数据。

Git/Skills 安装保持轻量，隧道二进制从官网下载并核对固定 SHA-256；官网下载的完整归档自带该文件。隧道工具基于 tiann/tunwg 固定提交构建，仅修复 ACME 限流回退与冷却，保留 MIT 许可。构建源码地址、SHA-256、补丁和二进制哈希见 `assets/runtime/scripts/connect/tunwg/build-manifest.json`；依赖许可见同目录 `third-party-licenses/`。

本仓库只包含连接 Skill，不包含 MoeCast App 工程、设备凭据、二维码、模型权重或聊天记录。不要向 issue 提交令牌、私有日志、配对码或账号文件。
