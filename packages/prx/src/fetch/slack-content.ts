// prx-psj — the content projection for `prx fetch slack`.
//
// A Slack message carries content (text/blocks/files) AND volatile metadata
// that churns without the content changing: reactions come and go, a thread
// parent's reply_count/latest_reply grow as replies land, read-state moves.
// We content-address on the CONTENT, so a re-fetch of an unchanged message
// dedups to nothing and only a real edit (text/blocks/files) busts its digest.
//
// `ts` stays in the projection as the message identity — without it two
// distinct messages with the same text ("lgtm", "+1") would collide into one
// CAS blob. So the digest is content + identity, minus the volatile metadata.
//
// The zod schema is the source of truth; `slackMessageContentJsonSchema` is the
// derived JSON Schema (zod 4 `z.toJSONSchema`, the same IR `cli/verbspec.ts`
// emits) — the typed contract a read-back/query surface emits against.

import { z } from "zod";

/**
 * The content+identity projection of a Slack message. Identity: `ts` (post
 * time + immutable id), `user`, `type`/`subtype`. Content: `text`, `blocks`,
 * `files`, `attachments`. Rich payloads (`blocks`/`files`/`attachments`) are
 * kept verbatim as opaque arrays — this is a projection for addressing, not a
 * full parse of Slack's block schema.
 */
export const SlackMessageContent = z.object({
  ts: z.string().min(1),
  user: z.string().optional(),
  type: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().optional(),
  blocks: z.array(z.unknown()).optional(),
  files: z.array(z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(),
});
export type SlackMessageContent = z.infer<typeof SlackMessageContent>;

/** Derived JSON Schema for {@link SlackMessageContent} (interchange / docs). */
export const slackMessageContentJsonSchema = z.toJSONSchema(SlackMessageContent);

const STRING_FIELDS = ["user", "type", "subtype", "text"] as const;
const ARRAY_FIELDS = ["blocks", "files", "attachments"] as const;

/**
 * Project a raw Slack message to its content+identity, dropping volatile
 * metadata (reactions, reply_count/latest_reply/reply_users*, subscribed,
 * is_locked, last_read, client_msg_id, team, the `edited` wrapper, …). Validated
 * through the zod schema so the projection is a typed, schema-conformant object;
 * unknown keys are stripped. Throws if `ts` is missing/empty.
 */
export function projectSlackContent(message: {
  ts: string;
  [k: string]: unknown;
}): SlackMessageContent {
  const picked: Record<string, unknown> = { ts: message.ts };
  for (const k of STRING_FIELDS) {
    if (typeof message[k] === "string") picked[k] = message[k];
  }
  for (const k of ARRAY_FIELDS) {
    if (Array.isArray(message[k])) picked[k] = message[k];
  }
  return SlackMessageContent.parse(picked);
}
