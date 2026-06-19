// slack .8 (prx-59q) — Web API transport.
//
// Maps the four read ops to the Slack Web API methods proven against a live
// workspace (2026-06-09): conversations.list / .history / .replies, users.list.
// A pure mechanism: it receives a minted ScopedSlackKey and exercises
// `key.authorize()` to inject the bearer; it never reads env or resolves auth.
// `fetch` is injectable for hermetic tests.

import type { ScopedSlackKey, SlackAuthTarget } from "./keymaker.ts";
import type { SlackReadTransport } from "./transport.ts";
import {
  SlackReadError,
  type SlackReadOp,
  type SlackRawResult,
  type SlackReadParams,
} from "./types.ts";

const SLACK_API_BASE = "https://slack.com/api";

/** Read op -> Slack Web API method. */
const METHOD: Record<SlackReadOp, string> = {
  channels: "conversations.list",
  history: "conversations.history",
  thread: "conversations.replies",
  users: "users.list",
};

// Slack `error` strings that mean "the credential is the problem" -> UNAUTHORIZED
// (vs a request/data problem -> TRANSPORT_FAILED).
const AUTH_ERRORS = new Set<string>([
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "missing_scope",
  "ekm_access_denied",
]);

export interface WebApiTransportDeps {
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Override the API base (tests). Defaults to https://slack.com/api. */
  baseUrl?: string;
}

/** Our param names already match Slack's (channel/ts/limit/cursor/oldest/latest/types). */
function buildQuery(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function webApiSlackTransport(deps: WebApiTransportDeps = {}): SlackReadTransport {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.baseUrl ?? SLACK_API_BASE;
  return {
    async call<Op extends SlackReadOp>(
      op: Op,
      params: SlackReadParams[Op],
      key: ScopedSlackKey,
    ): Promise<SlackRawResult> {
      const method = METHOD[op];
      const record = params as Record<string, unknown>;
      const str = (k: string): string | undefined =>
        typeof record[k] === "string" ? (record[k] as string) : undefined;
      const channel = str("channel");
      const url = `${base}/${method}${buildQuery(record)}`;

      // Build the capability target from the params the read carries: team_id →
      // org (workspace/enterprise), channel, and the thread parent ts (the `ts`
      // of a conversations.replies call, or an explicit thread_ts). The key
      // enforces scope/TTL against this target before the request leaves.
      const target: SlackAuthTarget = {
        op,
        ...(str("team_id") !== undefined ? { org: str("team_id") } : {}),
        ...(channel !== undefined ? { channel } : {}),
        ...((str("thread_ts") ?? (op === "thread" ? str("ts") : undefined)) !== undefined
          ? { thread: str("thread_ts") ?? str("ts") }
          : {}),
      };
      const authed = key.authorize(target, { url, headers: {} });

      let resp: Response;
      try {
        resp = await doFetch(authed.url ?? url, { headers: authed.headers });
      } catch (err) {
        throw new SlackReadError(
          `slack ${method} request failed: ${(err as Error).message}`,
          "TRANSPORT_FAILED",
        );
      }
      if (!resp.ok) {
        throw new SlackReadError(`slack ${method} HTTP ${resp.status}`, "TRANSPORT_FAILED");
      }

      const data = (await resp.json()) as {
        ok?: boolean;
        error?: string;
        response_metadata?: { next_cursor?: string };
      };
      if (data?.ok !== true) {
        const err = data?.error ?? "unknown";
        throw new SlackReadError(
          `slack ${method} returned not-ok: ${err}`,
          AUTH_ERRORS.has(err) ? "UNAUTHORIZED" : "TRANSPORT_FAILED",
        );
      }

      const next = data.response_metadata?.next_cursor;
      return { ok: true, data, cursor: next ? next : null };
    },
  };
}
