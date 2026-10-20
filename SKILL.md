---
name: moecast-connect
description: Install, start, diagnose, repair or remove the HAPI gateway that connects the MoeCast phone app to this computer's Codex chats. Use for phone pairing and connection failures; not for doing project work or configuring API providers.
---

# MoeCast Connect

This Skill manages a local HAPI + MoeCast device gateway. It requires no MoeCast desktop app or MCP server. The current preview supports macOS Apple Silicon with Node.js 22+ and an installed, signed-in Codex CLI.

Run the bundled helper using an **absolute path** from this Skill directory:

`node <skill-directory>/scripts/connect.mjs <command>`

The helper installs program files and state under `~/.local/share/moecast-connect`; `MOECAST_CONNECT_HOME` overrides that directory for isolated testing. Do not point tests at an existing user's installation.

## First connection

1. Determine the intended project directory from the user's request/current project. Briefly explain that the phone can read chats and dispatch work in that scope, using the target Agent's existing permissions. Both capabilities are enabled by default; do not add separate permission toggles. If the intended project is unclear, ask which project to connect. Do not authorize the filesystem root or silently add unrelated projects.
2. Run `doctor`. Reuse an existing healthy installation. If installation is needed, run `install`. If Node is missing, obtain Node 22+ from its official distribution or an existing trusted package manager; do not pretend the helper can run without Node. If Codex is missing or signed out, guide the user through installing/signing in with the official CLI, then check again.
3. Run `start --project /absolute/project/path`. First certificate issuance may take several minutes; wait for trusted HTTPS readiness before presenting a pairing code. Repeat `--project` only for projects the user intends to expose. This starts connection processes for this use; it adds no login item, launch agent, scheduled task or process supervisor.
4. A successful response gives `qrPngFile` and `expiresAt`. Show the local PNG inline if the host supports images, otherwise open the file. Tell the user to scan it with the MoeCast phone app's connection scanner. Do not paste the payload, code or owner/device credentials into the chat. Codes expire after two minutes and can be used once; use `pair` to refresh an expired code.
5. Check `devices` for a newly paired non-revoked device before claiming pairing succeeded. Service readiness is not proof the phone scanned successfully. If the phone build lacks a scanner, state that limitation; do not claim a diagnostic injection is the user-facing flow.

The phone selects/saves its frontend model if needed and restores its previously selected Codex thread. This helper does not pick a model or create a work thread. Never send a test message to an existing work chat just to check the connection.

## Connection failure

For requests such as “调用 MoeCast Connect Skill，排查并修复手机连接问题”, read [diagnostics](references/diagnostics.md), run `doctor`, and repair the failing stage. Perform supported repairs directly within the user's request. Use `repair` to restart missing services with the saved project scope; it preserves device credentials and does not generate an unnecessary new pairing code.

Keep the same computer identity, authorization, original thread IDs and outbox. Re-pair only when authorization was explicitly revoked, app data was erased, or the computer identity was reset. Timeouts, stopped processes, DNS and TLS errors are not revocation. Do not reset state or automatically repeat a task whose delivery is unknown.

## Management

- `doctor`: sanitized installation, process ownership, Codex login, local/public health and Runner checks. No credential output. `serviceReady` does not prove phone delivery or target-task completion.
- `devices`: list device IDs and scopes. `revoke <device-id>`: revoke only the intended device; disambiguate if needed.
- `stop`: stop this installation's gateway, tunnel, Hub and Runner, retaining state and existing work chats. Do not kill foreign processes to free a port.
- `install`: installs/updates the pinned runtime; stop this installation first when it is running. State is kept separate from code.
- `uninstall`: removes installed application code after stopping its services; retains pairing/history state so removal is recoverable. Do not erase saved state without an explicit request.

The bundled tunnel tool is built from a pinned upstream source revision with a narrow ACME retry/fallback patch. Its build manifest, patch, source hash, tests and MIT license are included; it changes no proxy settings or routing. Go is required only for maintainers rebuilding the tool, not end users.

Never disable global proxies, TLS validation or approval protections to make the test pass. Never expose the underlying Hub owner endpoint publicly. Do not register autostart or automatic crash recovery. Public distribution/search indexing is a release step; a locally generated Skill is not automatically available through Find Skills.
