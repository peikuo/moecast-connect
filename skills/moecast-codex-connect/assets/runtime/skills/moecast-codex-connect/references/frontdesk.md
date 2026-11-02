# Native message boundary

The paired phone sends typed or transcribed text to its fixed **desktop Codex thread**. The gateway transports messages directly to desktop Codex. Codex decides how to fulfill the request with its own native tools. MoeCast does not supply tool lists, coordinator roles, business routing, target selection, model overrides or approval overrides.

Only a short source/language hint precedes the unchanged user text:

- 中文：`消息来自 MoeCast。默认用中文回复；用户明确指定其他语言时遵从用户请求。`
- English: `Message from MoeCast. Reply in English by default; follow any language the user explicitly requests.`

Phone locale selects the default. The actual final Codex answer is returned. Delivery uses one native client message ID; completion is correlated to that user message's completed turn and final message IDs. A delayed reply is recovered by reading history under that same ID, including after a gateway restart. Recovery never submits the message again.

First pairing embeds the selected existing desktop thread, machine and directory. Only the canonical native thread ID is accepted; session aliases and old executor paths are unsupported. A missing binding requires fixing the connection on the computer. Native queue/wake support depends on the installed desktop version and is checked before pairing; unsupported versions remain an explicit connection failure.

Historical custom-tool results are retained only as old display/evidence data. They cannot establish success of the current native path. Do not restore deleted adapters, setup injection or executor recovery to make a test pass.
