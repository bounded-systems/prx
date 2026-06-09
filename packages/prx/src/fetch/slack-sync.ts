// prx-agd — `prx fetch slack <channel>` composition root.
//
// Wires the pure freshness/CAS core (`runFetchSlack`, fetch/slack.ts) to its
// three production seams, each injectable so the orchestrator is testable with
// fakes (no real Slack, no real CAS, no real bd):
//
//   • read adapter — `execSlackScoutRead` (slack/scout-cli.ts), the same gated,
//     keymaker-authorized, content-addressed read surface `prx scout slack`
//     uses. We pass the channel's watermark as `oldest` and parse the Slack
//     `conversations.history` payload's `messages[]` out of the envelope.
//   • CAS store — the on-disk plan-store CAS (plan-store/cas.ts) on the `slack`
//     domain, exposed through the `BlobStore` port the core depends on.
//   • watermark — the per-channel `bd config` value (slack-watermark.ts), read
//     before the fetch and advanced to `max(ts)` after a successful one.
//
// SCOPE (v0, prx-agd): one read per run. The core does a single `readHistory`,
// so this fetches up to `limit` messages newer than the watermark and advances
// past them. Multi-page pagination (the `cursor` carry) and rate-limit/budget
// gating (Slack has no github-budget points bucket — that belongs with slackd,
// prx-tgy) are deliberate follow-ons; see the parent epic prx-zes.

import { type BlobStore, type Digest } from "@bounded-systems/cas";

import { runFetchSlack, type SlackFetchDeps, type SlackMessage } from "./slack.ts";
import {
  getSlackWatermark,
  setSlackWatermark,
} from "./slack-watermark.ts";
import { WatermarkError, type WatermarkDeps } from "./watermark.ts";
import { execSlackScoutRead } from "../slack/scout-cli.ts";
import { hasBlob, writeBlob } from "../plan-store/cas.ts";
import type { SlackReadEnvelope } from "@bounded-systems/slack";

/** CAS domain the fetched Slack messages are content-addressed under. */
const SLACK_CAS_DOMAIN = "slack";

export class FetchSlackError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "FetchSlackError";
    this.code = code;
  }
}

export interface FetchSlackInput {
  channel: string;
  /** Page size for the underlying read (default per the core). */
  limit?: number | undefined;
}

export interface FetchSlackResult {
  channel: string;
  /** Messages strictly newer than the prior watermark. */
  fetched: number;
  /** Of those, how many were already in CAS (deduped, not re-stored). */
  deduped: number;
  /** Content address of each fetched message (ts order). */
  digests: Digest[];
  watermark: {
    /** The watermark this run read (null = cold start). */
    from: string | null;
    /** The advanced watermark (undefined when the fetch was empty). */
    to: string | undefined;
    /** Whether the run advanced (and persisted) the watermark. */
    advanced: boolean;
  };
}

export type FetchSlackDeps = {
  cwd: string;
  /**
   * Read adapter. Defaults to the gated `execSlackScoutRead` surface; injected
   * in tests so the orchestrator runs without a live Slack credential.
   */
  readHistory?: SlackFetchDeps["readHistory"];
  /** CAS port. Defaults to the on-disk plan-store CAS on the `slack` domain. */
  store?: Pick<BlobStore, "put" | "has">;
  /** bd-config spawn seam for the watermark read/write (tests inject a fake). */
  watermarkRunner?: WatermarkDeps["runner"];
};

/**
 * Default read adapter: run one gated `conversations.history` read at/after
 * `oldest` and project the Slack payload's `messages[]` (keeping only entries
 * with a string `ts`, the one load-bearing field) into the core's shape.
 * A malformed envelope is a hard parse failure rather than a silent empty read.
 */
function defaultReadHistory(): SlackFetchDeps["readHistory"] {
  return async ({ channel, oldest, limit }) => {
    const json = await execSlackScoutRead({
      op: "history",
      channel,
      limit,
      ...(oldest !== undefined ? { oldest } : {}),
    });
    let envelope: SlackReadEnvelope<"history">;
    try {
      envelope = JSON.parse(json) as SlackReadEnvelope<"history">;
    } catch (err) {
      throw new FetchSlackError(
        `slack history envelope was not valid JSON: ${(err as Error).message}`,
        "SLACK_PARSE_FAILED",
      );
    }
    const data = envelope.result?.data as { messages?: unknown } | undefined;
    const raw = data?.messages;
    if (raw !== undefined && !Array.isArray(raw)) {
      throw new FetchSlackError(
        "slack history payload `messages` was not an array",
        "SLACK_PARSE_FAILED",
      );
    }
    const messages = (Array.isArray(raw) ? raw : []).filter(
      (m): m is SlackMessage =>
        typeof m === "object" && m !== null && typeof (m as { ts?: unknown }).ts === "string",
    );
    return { messages };
  };
}

/** Default CAS store: the on-disk plan-store CAS on the `slack` domain. */
function defaultStore(): Pick<BlobStore, "put" | "has"> {
  return {
    async put(bytes: Uint8Array): Promise<Digest> {
      const { sha } = await writeBlob(Buffer.from(bytes), { domain: SLACK_CAS_DOMAIN });
      return sha as Digest;
    },
    async has(digest: Digest): Promise<boolean> {
      return hasBlob(digest, { domain: SLACK_CAS_DOMAIN });
    },
  };
}

/**
 * Run the verb: read the channel watermark → fetch+persist newer messages via
 * the pure core → advance the watermark to `max(ts)` when the fetch was
 * non-empty. Idempotent end-to-end (CAS dedups, watermark is monotonic).
 *
 * Failure modes:
 *   • watermark read fails   → FetchSlackError WATERMARK_READ_FAILED
 *   • watermark write fails  → FetchSlackError WATERMARK_WRITE_FAILED (after
 *                              the messages already persisted to CAS — the
 *                              next run re-reads from the un-advanced mark and
 *                              dedups, so no data is lost)
 *   • slack read fails       → SlackReadError propagates (handler maps it)
 *   • malformed envelope     → FetchSlackError SLACK_PARSE_FAILED
 */
export async function runFetchSlackSync(
  input: FetchSlackInput,
  deps: FetchSlackDeps,
): Promise<FetchSlackResult> {
  const watermarkDeps: WatermarkDeps = {
    cwd: deps.cwd,
    ...(deps.watermarkRunner !== undefined ? { runner: deps.watermarkRunner } : {}),
  };

  let from: string | null;
  try {
    from = getSlackWatermark(input.channel, watermarkDeps).ts;
  } catch (err) {
    if (err instanceof WatermarkError) {
      throw new FetchSlackError(`watermark read failed: ${err.message}`, err.code);
    }
    throw err;
  }

  const readHistory = deps.readHistory ?? defaultReadHistory();
  const store = deps.store ?? defaultStore();

  const core = await runFetchSlack(
    {
      channel: input.channel,
      ...(from !== null ? { watermark: from } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    },
    { readHistory, store },
  );

  // Advance only when the fetch produced a strictly-newer max(ts). An empty
  // fetch leaves the core's watermark at the prior value (or undefined on a
  // cold empty start) — nothing to persist.
  const advanced =
    core.watermark !== undefined && core.watermark !== from && core.fetched > 0;
  if (advanced) {
    try {
      setSlackWatermark(input.channel, core.watermark!, watermarkDeps);
    } catch (err) {
      if (err instanceof WatermarkError) {
        throw new FetchSlackError(`watermark write failed: ${err.message}`, err.code);
      }
      throw err;
    }
  }

  return {
    channel: core.channel,
    fetched: core.fetched,
    deduped: core.deduped,
    digests: core.digests,
    watermark: { from, to: core.watermark, advanced },
  };
}

/** Render the result as a single JSON envelope for stdout (gh-issues style). */
export function formatFetchSlackJson(result: FetchSlackResult): string {
  return JSON.stringify(
    {
      _summary: {
        source: "slack",
        channel: result.channel,
        fetched: result.fetched,
        deduped: result.deduped,
        stored: result.fetched - result.deduped,
        watermarkFrom: result.watermark.from,
        watermarkTo: result.watermark.to ?? null,
        advanced: result.watermark.advanced,
        digests: result.digests,
      },
    },
    null,
    2,
  );
}
