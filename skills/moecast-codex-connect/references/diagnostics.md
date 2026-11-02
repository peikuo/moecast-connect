# Connection diagnostics

Run `doctor` first. Report sanitized failing stages, never credentials, complete state files or private logs.

| Symptom | Action |
| --- | --- |
| Node missing / below 22 | Use an official distribution or the user's trusted package manager. |
| Unsupported platform | Preview supports macOS Apple Silicon; report the limit. |
| Missing runtime / integrity failure | Install the trusted package. Never weaken checksum verification. |
| Desktop Codex closed or signed out | Open/sign in on the computer, then retry the saved connection. CLI login alone is insufficient. |
| Native queue/wake unavailable | Report installed-version incompatibility. Do not start another executor or add custom tools. |
| Fixed entry missing | Run pairing from the intended existing desktop chat with its exact `--thread` ID. Do not select or create a business target on the phone. |
| Owned gateway or tunnel stopped | Run `repair` for connection services only. Preserve device credentials and native binding. |
| Foreign process on 3316/3317 | Identify the conflict; do not stop another installation or reuse its credentials. |
| HTTPS failure | Check network, DNS, relay and certificate stage. Preserve proxy settings; never bypass TLS or inject routing changes. Retry after an actual fix. |
| First certificate / CA limit | Allow several minutes. The pinned tunnel honors cooldown and alternate issuer; report failures without borrowing another identity. |
| Phone fails when computer sleeps | Tell the user to wake the computer and open Codex; the phone cannot wake stopped connection services. |
| Explicitly revoked pairing | Pair the intended device again. Do not revoke other devices. |
| Lost or delayed reply | Read by the saved native client message ID. Pending/busy/read outages are not proof of failure; never resend to test delivery. |

After repair verify the same device and chat. Local/public health alone does not verify phone recovery. There is no automatic startup registration or Codex executor recycling.
