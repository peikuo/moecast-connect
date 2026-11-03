# Windows x64 candidate: installation and acceptance

This preview adds native Windows plumbing. Platform selection belongs to the Skill: detect it with `doctor`, and never ask users to choose the OS, CPU, branch or tunnel binary. It does **not** establish that the installed Windows Codex build supports the existing queue and wake interfaces. Stop at a failed capability check and keep the same thread; do not substitute an executor. Record the commit, Windows / Codex / Node versions and the failed stage without credentials.

## Phone compatibility prerequisite

The phone must use the Windows-host compatibility APK from this development handoff. Older builds reject `C:\...` / UNC metadata as `HAPI_PROTOCOL_MISMATCH`, even when the Windows service is healthy. The signed candidate is `MoeCast-0.2.0-code5-windows-host-signed.apk`, SHA256 `aa0e4710e97ca3159d46823d07e27e9ca124b9dbca73a256fb5ea5b32b135892`, same production signing certificate. Its source change is recorded in `patches/android-windows-paths.patch` at the repository root. This candidate is not in the regular app update feed. Until installed, test only the Windows helper prerequisites; do not diagnose that old-phone rejection as a Windows service failure.

## First connection

1. Open the installed Codex desktop App, sign in and open the existing **local Windows** chat you want as the phone entry. The agent must run in native PowerShell with Windows Node.js 22+ (`node -p "process.platform + '-' + process.arch"` must return `win32-x64`). Web/cloud/WSL chats are not this entry.
2. Install/update `skills/moecast-codex-connect` from the repository default branch; no platform-specific branch is required. Run its helper by absolute path: `node "C:\absolute\skill\scripts\connect.mjs" doctor`. Do not copy the example path literally.
3. If missing, run `install`, then `doctor`. The installer checks a bundled, pinned Windows x64 tunnel and installs only gateway dependencies. Its state remains `%USERPROFILE%\.local\share\moecast-connect`; keep saved identity and pairing. `icacls` protects that installation for the current Windows user; the local administration pipe also requires its private capability. No administrator elevation, firewall change, URL-handler registration or startup task is added.
4. Run `start --thread <the exact current desktop thread UUID>`. `CODEX_THREAD_ID` is acceptable when it is the trusted current chat ID. The installed desktop must be running. Pairing checks metadata and `thread/queue/list`; actual queue delivery and `codex://threads/wake/<id>` must still be tested on this Windows build.
5. Wait for trusted HTTPS readiness, show the generated PNG QR code and scan with MoeCast. A QR expires after two minutes. Refresh for the **same thread** with `pair --thread <id>`; do not paste secrets into chat.
6. Run `devices` to confirm pairing. The phone saves this computer / thread as its fixed entry. Do not replace or clear the existing Mac pairing to test Windows; if the phone requests replacement confirmation, let the user choose intentionally.

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
