// slack .2 (prx-src) — read-op types for the Slack read surface.
//
// READ-ONLY by construction: this surface admits only the four read ops below.
// Every Slack *write* verb (post/send/update/delete/invite/kick/archive…) is
// hard-blocked in @bounded-systems/policy (slack .3); it has no representation
// here at all. Params are bounded, scout-style.

/** The closed set of read ops this surface exposes. */
export type SlackReadOp = "channels" | "history" | "thread" | "users";

/** Runtime mirror of {@link SlackReadOp} for allowlist/iteration. */
export const SLACK_READ_OPS: readonly SlackReadOp[] = [
  "channels",
  "history",
  "thread",
  "users",
] as const;

/** `conversations.list` — enumerate channels the token can see. */
export interface SlackChannelsParams {
  /** Pagination cursor from a prior page's `nextCursor`. */
  cursor?: string | undefined;
  /** Page size; transport clamps to provider limits. */
  limit?: number | undefined;
  /** Conversation kinds, e.g. "public_channel,private_channel". */
  types?: string | undefined;
}

/** `conversations.history` — messages in one channel. */
export interface SlackHistoryParams {
  /** Channel id (e.g. "C0123…"). Required. */
  channel: string;
  cursor?: string | undefined;
  limit?: number | undefined;
  /** Inclusive lower bound (Slack ts). */
  oldest?: string | undefined;
  /** Inclusive upper bound (Slack ts). */
  latest?: string | undefined;
}

/** `conversations.replies` — one thread's reply chain. */
export interface SlackThreadParams {
  channel: string;
  /** Parent message ts identifying the thread. Required. */
  ts: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** `users.list` / `users.info` — resolve users. */
export interface SlackUsersParams {
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** Map each op to its parameter shape (drives the typed transport port). */
export interface SlackReadParams {
  channels: SlackChannelsParams;
  history: SlackHistoryParams;
  thread: SlackThreadParams;
  users: SlackUsersParams;
}

/**
 * Provider-shaped payload returned by a transport. Deliberately opaque (`data:
 * unknown`): the surface content-addresses + records provenance over the
 * envelope without interpreting Slack's schema. `cursor` carries forward
 * pagination when present.
 */
export interface SlackRawResult {
  ok: boolean;
  data: unknown;
  cursor?: string | null | undefined;
}

export type SlackReadErrorCode =
  | "POLICY_BLOCKED"
  | "MISSING_PARAM"
  | "SCOPE_DENIED"
  | "KEY_EXPIRED"
  | "UNAUTHORIZED"
  | "TRANSPORT_FAILED";

/** Typed failure for every stage of the read pipeline (gate → mint → call). */
export class SlackReadError extends Error {
  readonly code: SlackReadErrorCode;
  constructor(message: string, code: SlackReadErrorCode) {
    super(message);
    this.name = "SlackReadError";
    this.code = code;
  }
}
