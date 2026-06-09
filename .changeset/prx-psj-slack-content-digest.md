---
"@bounded-systems/prx": minor
---

feat(fetch): content-scoped digest + SlackMessageContent zod/JSON schema for `prx fetch slack` (prx-psj)

`prx fetch slack` now content-addresses each message by a **content projection**
instead of the whole message: `sha256(canonical({channel, content}))` where
`content` = identity (`ts`, `user`, `type`/`subtype`) + content (`text`,
`blocks`, `files`, `attachments`). Volatile metadata — reactions,
`reply_count`/`latest_reply`/`reply_users*`, `subscribed`, `is_locked`,
`last_read`, `client_msg_id`, `team`, the `edited` wrapper — is dropped, so
reaction/reply churn **dedups to nothing** and only a real content edit busts a
message's digest. `ts` stays in the projection as identity (so identical text
like "lgtm" doesn't collide into one blob).

Adds `fetch/slack-content.ts`: the `SlackMessageContent` **zod** schema (source
of truth), `projectSlackContent()`, and `slackMessageContentJsonSchema` (derived
via `z.toJSONSchema`) — the typed contract a read-back/query surface can emit
against.

Migration: digests change shape, so the first fetch after this re-stores each
message once under its content digest (pre-1.0, channels are small — negligible).
Parent epic: prx-zes.
