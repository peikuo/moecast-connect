# Connection diagnostics

Run `doctor` first. Report sanitized failing stages, never credentials, complete state files or private logs.

| Symptom | Action |
| --- | --- |
| Node missing / below 22 | Use an official distribution or the user's trusted package manager. |
| Unsupported platform | Preview supports macOS Apple Silicon and Windows x64 candidate; report other platforms. Windows requires native PowerShell / Windows Node, not WSL. |
| Missing runtime / integrity failure | Install the trusted package. Never weaken checksum verification. |
| Desktop Codex closed or signed out | Open/sign in on the computer, then retry the saved connection. CLI login alone is insufficient. |
| Native queue/wake unavailable | Report the failing stage and exact sanitized error. Check desktop availability, endpoint/schema support and the OS URI handler as applicable; call it version incompatibility only when evidence establishes that. Missing cross-chat tools are a separate plugin-registration check. Do not start another executor or add custom tools. |
| Paired but cross-chat native tools missing / default thread listing hangs | Separate pairing from native registration and invocation. Inspect plugin sync/install, startup logs and effective configuration. Use the same native thread-list tool with explicit local Codex history selection when its schema supports it. See the Windows local case; do not assume Windows lacks the capability or automatically inject configuration. |
| Fixed entry missing | Run pairing from the intended existing desktop chat with its exact `--thread` ID. Do not select or create a business target on the phone. |
| Owned gateway or tunnel stopped | Run `repair` for connection services only. Preserve device credentials and native binding. |
| Foreign process on 3316/3317 | Identify the conflict; do not stop another installation or reuse its credentials. |
| HTTPS failure | Check network, DNS, relay and certificate stage. Preserve proxy settings; never bypass TLS or inject routing changes. Retry after an actual fix. |
| First certificate / CA limit | Allow several minutes. The pinned tunnel honors cooldown and alternate issuer; report failures without borrowing another identity. |
| Phone fails when computer sleeps | Tell the user to wake the computer and open Codex; the phone cannot wake stopped connection services. |
| Explicitly revoked pairing | Pair the intended device again. Do not revoke other devices. |
| Lost or delayed reply | Read by the saved native client message ID. Pending/busy/read outages are not proof of failure; never resend to test delivery. |

Windows: `icacls`, CIM process ownership, per-installation authenticated named pipe, desktop running / queue / wake and the bundled x64 tunnel are separate checks. Permission or capability failures must remain visible; do not elevate, change the default URL handler, use a different thread or launch a replacement executor.

After repair verify the same device and chat. Local/public health alone does not verify phone recovery. There is no automatic startup registration or Codex executor recycling.
