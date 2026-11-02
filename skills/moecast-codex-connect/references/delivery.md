# Attachment delivery

Before returning a completed native reply, the computer automatically verifies and snapshots its linked attachments for the current paired device/request. The reply includes attachment metadata so the phone can show a card immediately. Video bytes are transferred only when the user opens the attachment, never merely from opening history. Phone lookup requests supply an assistant request ID and optional display name, never a filesystem path.

For current native replies, evidence is the request's saved native client message ID, its completed turn, and exact final message IDs. The final message must contain an absolute Markdown file link, such as `[result](</absolute/project/output.png>)`. Files must be inside a verified canonical working directory with no traversal, symlink components or hardlinks. A file from another chat’s workspace can use an observed native `read_thread`/working directory, or a canonical project root found in the CURRENT Codex directory that this device is authorized to access. The latter records the source thread and rechecks its grants and project identity for every chunk. A remembered link no longer requires a redundant same-turn read_thread call. Unregistered paths remain denied. Commentary, another request's final message and arbitrary paths cannot supply evidence.

New installations pair as new devices; their own completed requests go through the same automatic preparation with no inherited delivery IDs or manual file grants. Preparation status is persisted with the reply and history. A crash/outage can resume preparation by read-only reconciliation without resubmitting the user message. Partial failures preserve text and report attachment errors.

An explicit local publish is also available for exceptional computer-authorized files outside those recognized sources; normal native replies do not need it:

`node <skill-directory>/scripts/connect.mjs deliver --device <device-id> --request <assistant-request-id> --message <final-message-id> --file /absolute/project/output.png`

Use exact device/request/message identities, never the most recently active phone. Publishing does not authorize messaging another chat or executing a task. Historical accepted receipts remain readable for old attachments; new native replies do not need a custom dispatch receipt or `readOnly/toolCalls` envelope.

If the human explicitly requests delivery of the linked file and the completed reply lacks same-turn workspace evidence, the trusted local command may add `--authorize-file`. This authorizes only that exact absolute file already linked in that request's exact final message, for that device/request. Canonical path, symlink/hardlink, size and immutable snapshot checks still apply. The phone cannot set this flag, and it grants no access to neighboring files or later requests. Do not use it to authorize an arbitrary unmentioned path.

Files above **50 MiB are rejected on the computer before reading file contents**: no snapshot or chunk transfer. Images also have a 20 MiB limit; per-device quota is 200 MiB/100 items. Smaller files are immutable snapshots, normally available for 24 hours. The phone obtains authenticated 256 KiB chunks, verifies hashes and can resume the same artifact. MP4/WebM may play inside chat after download; unknown formats use octet-stream. No raw authenticated file URLs, native save/share or PDF preview are added.

Expiry, revocation, changed grants and corrupted snapshots remain explicit failures. Do not claim transfer means the user read or saved a file. Do not add a background result watcher or automatic task polling.

Completed phone files are cached per hub/device/artifact/variant/digest with a 100 MiB / 10-file LRU bound and expiry cleanup. Reopening verifies local SHA-256 and sends an empty EOF chunk request to check live authorization; it does not transfer video contents again. Source permission revocation and expiry still prevent access.
