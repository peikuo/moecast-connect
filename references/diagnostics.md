# Connection diagnostics

Run the bundled helper's `doctor` first. It reports booleans, never credentials. Do not dump private logs, pairing files, settings, environment variables or account files into the conversation. If more detail is needed, inspect only the failing event and summarize a sanitized error code.

| Check / symptom | Action |
| --- | --- |
| Node missing / version <22 | Install Node from the official distribution or the user's existing trusted package manager, then rerun. |
| Unsupported platform | This preview supports macOS Apple Silicon only. Do not force a binary for another architecture. |
| Runtime, dependencies or HAPI missing | Run `install`. HAPI 0.30.7 is downloaded from its pinned npm package, verified with a pinned SHA-512; installation does not start a Hub or create a work thread. |
| Integrity failure | Stop owned services, reinstall the trusted package, then rerun doctor. Do not edit stored checksum expectations to accept a changed binary. |
| Foreign process on 3316/3317 | Identify its owner and report the conflict. Do not stop another installation or reuse its authentication. |
| Codex missing / logged out | Locate the installed CLI, perform its official login with the user, then rerun doctor. Never ask the user to copy an account credential into MoeCast. |
| Owned Hub, Runner, gateway or tunnel stopped | Run `repair`. Saved scopes, Hub identity, tunnel key, device grants and outbox remain. |
| Local health works but public HTTPS fails | Check network availability, DNS, system proxy, relay registration and trusted certificate errors. Preserve the user's proxy configuration. Do not modify proxy rules, inject routing libraries, bind a physical interface to bypass routing, or use insecure TLS. Diagnose and report the failing network stage. Retry once after an actual fix; unchanged repeated failures require a clear blocker report. |
| First certificate / CA rate limit | First setup can take several minutes; wait for trusted HTTPS readiness before pairing. The pinned MoeCast tunwg patch stops primary ACME retries on 429, respects its Retry-After cooldown and uses the existing alternate issuer. If both issuers fail, report the sanitized cause; never copy another identity, modify proxy rules or disable certificate validation. |
| Runner offline after startup | Inspect only the sanitized Runner startup/health failure, then restart this installation's services if appropriate. Do not kill active work Agent processes. |
| Phone explicitly reports revoked authorization | Confirm intended device, generate a fresh `pair` code and scan again. Do not revoke other devices. |
| Retained session runtime / EXISTING_EXECUTOR_REATTACH_REQUIRED | Run repair to verify the exact installation, PID generation, protected IPC endpoint, original thread and cwd. Normal Hub restarts reconnect the original executor. A stuck, exclusively owned idle runtime may be gracefully recycled only after verifying no pending turn, queue or approval; the same session, native thread and permissions must be restored and verified against its actual new executor. Busy, shared or uncertain runtimes remain untouched and are reported as blocked. Never delete locks, force-kill or create a replacement chat. |
| Phone reconnects but previous thread is missing | Check exact machine, canonical cwd and original Codex thread ID. Restore the original mapping; never silently fork/create another thread. Active desktop executor takeover is not established by historical thread resumption. |
| Unknown delivery / lost receipt | Preserve request ID and reconcile with server/history. Do not resend the message to see whether it works. |

After repair, rerun doctor, ask the phone to retry its saved connection and verify the same device/chat. If only local/public health was checked, say that phone recovery remains unverified. A new QR is not needed for an ordinary service restart.

Expected limitations: the first public TLS setup can be slow, GitHub/npm or the relay may be unavailable, shared runtimes may need reattachment after a Hub restart, and an offline/locked computer cannot be repaired by the phone itself. No background supervisor or startup registration will bring a stopped service back automatically.
