# Native message boundary

The paired phone sends typed or transcribed text to its fixed **desktop Codex thread**. The gateway transports messages directly to desktop Codex. Codex decides how to fulfill the request with its own native tools. MoeCast does not supply tool lists, coordinator roles, business routing, target selection, model overrides or approval overrides.

Only a short source/language hint precedes the unchanged user text:

- 中文：`消息来自 MoeCast。默认用中文回复；用户明确指定其他语言时遵从用户请求。`
- English: `Message from MoeCast. Reply in English by default; follow any language the user explicitly requests.`

Phone locale selects the default. The actual final Codex answer is returned. Delivery uses one native client message ID; completion is correlated to that user message's completed turn and final message IDs. A delayed reply is recovered by reading history under that same ID, including after a gateway restart. Recovery never submits the message again.

First pairing embeds the selected existing desktop thread, machine and directory. Only the canonical native thread ID is accepted; session aliases and old executor paths are unsupported. A missing binding requires fixing the connection on the computer. Before issuing a pairing invitation, the connector checks native metadata, that the desktop app is running, and the queue-list endpoint. That does not prove queue-add, URI wake, execution or any cross-chat tool invocation works. Verify these separately under the applicable authorization, and report the actual failure rather than assuming a version incompatibility.

Historical custom-tool results are retained only as old display/evidence data. They cannot establish success of the current native path. Do not restore deleted adapters, setup injection or executor recovery to make a test pass.


## Cross-chat capabilities and evidence

Cross-chat work must use the desktop's native Codex tools. Reading Codex databases, simulating the UI, or starting another executor is not a replacement for an unavailable native tool. Do not infer that Windows lacks cross-chat support merely because pairing passed but a tool is missing.

Separate evidence for connection/pairing, native tool registration in the actual chat, and successful invocation. Inspect the available schemas for `list_projects`, `list_threads`, `read_thread`, `wait_threads`, `send_message_to_thread`, `create_thread`, `handoff_thread` and `fork_thread`. Record each as available/unavailable and invoked/not invoked; list visibility alone is not invocation success. Use returned project/thread/host IDs; do not guess them.

If the default `list_threads` call hangs, use the same native tool with explicit local Codex history selection, where supported by its schema: `list_threads({mode:"history", source:"codex"})`. The calling host is the default; specify `hostId` only when it is a known real host. A successful explicit query does not prove that the default mode was repaired.

Read-only discovery and checks do not authorize sending messages, creating/forking chats, handing off or interrupting work, or deleting anything. Perform such tests only when the user's request authorizes that exact action; do not dispatch test work just to prove a connection.

For missing tools, examine the native plugin's registration, startup diagnostics and effective configuration, then report the concrete failing stage. Back up configuration before a repair. Restore the packaged native integration only from verified local definitions; do not introduce custom tools as a substitute. See the [Windows local case](windows.md#windows-local-case-native-plugin-registration) before proposing a Windows configuration workaround.
