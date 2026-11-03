# Windows x64: installation and verification

The user has reported a successful Windows setup with this connection; this is not a guarantee for every app version or proof that all acceptance scenarios were run. Platform selection belongs to the Skill: detect it with `doctor`, and never ask users to choose the OS, CPU, branch or tunnel binary. It does **not** establish that the installed Windows Codex build supports the existing queue and wake interfaces. Stop at a failed capability check and keep the same thread; do not substitute an executor. Record the commit, Windows / Codex / Node versions and the failed stage without credentials.

## Phone compatibility prerequisite

Use a current MoeCast build that accepts Windows drive and UNC paths in the bound desktop metadata. Older builds that only accept POSIX paths can reject pairing as `HAPI_PROTOCOL_MISMATCH` even when the Windows service is healthy. Check the installed build against the Windows-path compatibility source/patch or known build evidence; if it lacks the change, update through a trusted current distribution while preserving app data. A newer compatible build does not need to be replaced by the original test APK.

The initial compatibility candidate was `MoeCast-0.2.0-code5-windows-host-signed.apk`, SHA256 `aa0e4710e97ca3159d46823d07e27e9ca124b9dbca73a256fb5ea5b32b135892`. This is historical provenance, not the required current download. Its source change is in [`patches/android-windows-paths.patch`](https://github.com/peikuo/moecast-connect/blob/main/patches/android-windows-paths.patch); that patch is not a general phone-installation command. Do not overwrite a newer compatible APK with this early candidate or infer the exact installed build from pairing alone.

## First connection

1. Open the installed Codex desktop App, sign in and open the existing **local Windows** chat you want as the phone entry. The agent must run in native PowerShell with Windows Node.js 22+ (`node -p "process.platform + '-' + process.arch"` must return `win32-x64`). Web/cloud/WSL chats are not this entry.
2. Install/update `skills/moecast-codex-connect` from the repository default branch; no platform-specific branch is required. Run its helper by absolute path: `node "C:\absolute\skill\scripts\connect.mjs" doctor`. Do not copy the example path literally.
3. If missing, run `install`, then `doctor`. The installer checks a bundled, pinned Windows x64 tunnel and installs only gateway dependencies. Its state remains `%USERPROFILE%\.local\share\moecast-connect`; keep saved identity and pairing. `icacls` protects that installation for the current Windows user; the local administration pipe also requires its private capability. No administrator elevation, firewall change, URL-handler registration or startup task is added.
4. Run `start --thread <the exact current desktop thread UUID>`. `CODEX_THREAD_ID` is acceptable when it is the trusted current chat ID. The installed desktop must be running. Before issuing the QR, the helper checks metadata, that desktop Codex is running, and `thread/queue/list`. This does not enqueue a message or exercise `codex://threads/wake/<id>`; actual queue delivery, wake and final reply need separate authorized verification on this Windows build.
5. Wait for trusted HTTPS readiness, show the generated PNG QR code and scan with MoeCast. A QR expires after two minutes. Refresh for the **same thread** with `pair --thread <id>`; do not paste secrets into chat.
6. Run `devices` to confirm pairing. The phone saves this computer / thread as its fixed entry. Changing computers may replace the phone’s active pairing. Follow the user’s intended switch, preserve stored per-computer history, and do not clear or revoke unrelated devices just to run a test.

## User-device checks (not inherited from Mac or CI)

| Check | Expected result |
| --- | --- |
| Phone sends a harmless greeting explicitly chosen by the user | Exactly one user message appears in the selected desktop chat; desktop executes it and its final reply reaches the phone. |
| Desktop closed | `doctor` reports desktop unavailable; it does not create a CLI executor or declare readiness. Open the original desktop and repair. |
| Queue or wake unsupported | Report the failing stage. If enqueue may have succeeded, inspect saved history / client message ID; never automatically resend. |
| Restart only the owned connection service | Saved machine identity, pairing and fixed thread remain. `repair` does not recreate a chat. |
| Windows path contains spaces / Chinese | Install, logs and generated QR paths still work. Invoke Node scripts with quoted absolute paths. |
| Attachment explicitly linked by that desktop reply | Download and open the correct file; verify hash. Image thumbnails are optional on Windows; originals must remain available. |
| Computer sleeps or loses network | Phone explains that the computer cannot be reached. Wake the same computer; old uncertain requests are not replayed automatically. |

`doctor` alone verifies local prerequisites and service checks, not a complete phone conversation. Keep phone tests silent unless the user explicitly performs a listening test. No real model or work message is sent as an automatic connection probe.

## Provenance

- The Windows tunnel is cross-compiled from the same pinned upstream revision and narrow certificate patch as Mac; see `assets/runtime/scripts/connect/tunwg/win32-x64/build-manifest.json` and dependency notices.
- [Official OpenAI Windows documentation](https://learn.chatgpt.com/docs/windows/windows-app) explains native PowerShell versus WSL environments.
- Windows wake uses the OS URI association through [PowerShell Start-Process](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process), with an existing validated thread UUID; the connector never registers a replacement protocol handler.


## Windows local case: native plugin registration

On 2026-11-03 the user reported a successful Windows debugging session with this sequence: bundled plugin synchronization was skipped, the native app-tools plugin was not installed, and writing an enable flag alone did not load its tools. Supplying the complete native MCP definition restored the integration on that machine. This is a user-reported local case; individual tool-call logs and the app version/path are not included here. It does not establish that every Windows installation needs a manual MCP definition or that every listed operation was exercised.

When the same symptoms appear:

1. Confirm pairing separately from native tool discovery and invocation. Use the [cross-chat evidence rules](frontdesk.md#cross-chat-capabilities-and-evidence) and record the eight tools individually.
2. Inspect plugin registration, whether bundled synchronization ran or was skipped, plugin installation state, startup errors and the actual effective configuration. Do not assume an enable flag creates a missing registration.
3. Before editing, back up the relevant configuration outside active configuration/plugin discovery paths. Preserve unrelated entries and use the verified native integration's executable, arguments and full required MCP definition for this installed version. An incomplete flag is not a substitute for the definition; an invented custom MCP is not the native integration.
4. A direct reference into an app-version directory is a temporary local workaround. Record the app version and referenced path without secrets, and recheck registration and a read-only native invocation after an app update. Prefer the app's maintained plugin mechanism when it is available.
5. Verify read-only native queries first. For sending, creating, forking, handing off or deleting, obtain authorization from the user's actual requested action; never run a mutation automatically as acceptance testing. Report unsupported schema, absent registration, startup failure or failed invocation specifically rather than declaring cross-chat unsupported.

Do not apply this workaround to machines whose native tools already load. This case does not change the connector's normal installation or grant it permission to rewrite Codex configuration automatically.
