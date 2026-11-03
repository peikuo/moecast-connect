---
name: moecast-codex-connect
description: Automatically detect macOS Apple Silicon or Windows x64 and install, start, diagnose, repair or remove the connection from the MoeCast phone app to an existing desktop Codex chat, and deliver that chat's explicitly linked files. Use for phone pairing, connection failures and attachment delivery, not project work or API provider configuration.
---

# MoeCast Codex Connect

Read the installed version from `release.json.version` and supported targets from `release.json.platforms`. Refresh stale local Skill files instead of relying on a cached Mac-only summary or an older website archive.

The local gateway and HTTPS relay carry messages to one existing desktop Codex chat. Desktop Codex does the work using its own capabilities and settings. The connection does not register chat tools, choose business targets, change the model or permissions, start a second executor, or resume a chat in another runtime.

This preview supports macOS Apple Silicon and provides a Windows x64 candidate awaiting user-device acceptance. Use Node.js 22+ and the signed-in Codex desktop app **running** on the same computer. On Windows use native PowerShell and Windows Node, not WSL; local Windows and WSL session stores are different. Web/cloud chats cannot install this local connection. A CLI login alone is insufficient. The native inbox uses `thread/queue/add` and desktop `codex://threads/wake`; availability must be checked on the installed version. Do not substitute a custom tool or another executor if unsupported.

Use an absolute path: `node <skill-directory>/scripts/connect.mjs <command>`. The Skill name is `moecast-codex-connect`. The existing installation/state directory keeps its original name to preserve pairing and history. Installation/state live under `~/.local/share/moecast-connect`; `MOECAST_CONNECT_HOME` is for an isolated test installation. Never point tests at a user's installation.

## Connect

1. Use the existing desktop chat the user wants as their fixed phone entry. Determine its exact thread ID from trusted chat context; do not guess by title, create a replacement, or ask the phone to select a work target. Pairing grants this computer's chat access; Codex handles any subsequent cross-chat request.
2. Run `doctor` to detect the local OS and CPU architecture. The helper automatically selects the matching runtime and tunnel; do not ask the user to choose a platform, architecture, branch or binary. Install/update this Skill from the repository default branch, not a platform-specific test branch. If unsupported, explain the detected limit instead of asking the user to pick another platform. Install if needed. Open/sign in to desktop Codex if necessary. `install` does not create or execute a chat.
3. Run `start --thread <existing-desktop-thread-id>`. In that chat, `CODEX_THREAD_ID` may supply the same ID. Pairing checks the native metadata, desktop availability and queue capability, then includes the canonical fixed selection in the invitation. A saved binding can be reused by `pair`; use an explicit ID when changing the entry.
4. Wait for trusted public HTTPS readiness. Show `qrPngFile` inline or open that local image. Do not paste codes, payloads or credentials. Codes expire after two minutes and are single-use; refresh with `pair --thread <same-id>`.
5. Check `devices` before claiming the phone paired. The phone saves and opens the supplied fixed entry; no frontend model selection is needed. Health checks alone do not prove a scan or message succeeded. Pairing also does not prove desktop native tools are loaded or callable; check those separately when investigating a cross-chat failure.

On Windows read [Windows testing](references/windows.md) before installation or diagnosing native wake / cross-chat tool failures. It includes a user-reported plugin-registration case, not a universal installation step.

Startup adds no login item, supervisor or recurring task. Normal reconnection preserves device identity, history and fixed binding. The gateway owns its computer identity in gateway/identity.json and connects directly to desktop Codex; it does not install or start an HAPI Hub or Runner. No work is sent as a connection probe.

## Repair and remove

Run `doctor`, then `repair` for owned connection services. Never stop, recycle or resume a Codex executor, modify approvals, replace an existing chat, or resend an uncertain message. A sleeping computer must be woken and desktop Codex reopened on the computer. Verify the same device/chat after repair; use a new QR only for an intended new/revoked pairing.

`stop` stops only owned connection services. `uninstall` removes the installation as implemented by the helper; inspect the intended installation first. Preserve user project files and Codex history.

Read [diagnostics](references/diagnostics.md) for failures, [message boundaries](references/frontdesk.md) for native delivery and language, and [attachments](references/delivery.md) for file evidence and limits. Sanitize all reported errors; never dump state, authentication files or environment variables.
