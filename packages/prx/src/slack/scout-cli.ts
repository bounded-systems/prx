// Shared composition root for the slack read surface (prx-hkm). Used by BOTH the
// `prx scout slack` verb (pr-state/cli.ts) and the standalone `slack-scout`
// binary (bin.ts) — so the wiring lives in exactly one place.
//
// This is where authority enters: createServiceKeymaker reads the Slack
// credential and seals it into the keymaker's closure; the transport stays
// auth-free. Lives in prx (not @bounded-systems/slack) so the slack package
// keeps zero authority logic. Future: swap webApiSlackTransport for a
// daemon-routed transport (slackd, prx-tgy) — no change here beyond the factory.

import { createServiceKeymaker } from "@bounded-systems/auth";
import { openAnchoredChain } from "@bounded-systems/anchored-chain-sqlite";
import {
  execSlackRead,
  recordSlackReadDerivation,
  slackReadProvenance,
  slackScopedKeymaker,
  webApiSlackTransport,
  type SlackReadOp,
} from "@bounded-systems/slack";

export interface SlackScoutInput {
  op: SlackReadOp;
  channel?: string | undefined;
  ts?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  types?: string | undefined;
  /** `history` only — inclusive lower bound (Slack ts); the fetch watermark. */
  oldest?: string | undefined;
  /** `history` only — inclusive upper bound (Slack ts). */
  latest?: string | undefined;
  /** Emit the SLSA Provenance v1 statement instead of the read envelope. */
  provenance?: boolean | undefined;
  /** Record the read as a slack.read/v1 derivation in the anchored-chain ledger at this path. */
  ledger?: string | undefined;
}

/**
 * Run one Slack read through the full surface (policy gate → per-read scoped
 * key → Web API transport → content address), returning the JSON to emit.
 * Throws SlackReadError (or a credential Error if no token is configured).
 */
export async function execSlackScoutRead(input: SlackScoutInput): Promise<string> {
  const params: Record<string, unknown> = {};
  if (input.channel !== undefined) params.channel = input.channel;
  if (input.ts !== undefined) params.ts = input.ts;
  if (input.limit !== undefined) params.limit = input.limit;
  if (input.cursor !== undefined) params.cursor = input.cursor;
  if (input.types !== undefined) params.types = input.types;
  if (input.oldest !== undefined) params.oldest = input.oldest;
  if (input.latest !== undefined) params.latest = input.latest;

  const keymaker = slackScopedKeymaker(createServiceKeymaker("slack"));
  const transport = webApiSlackTransport();
  const envelope = await execSlackRead(
    input.op,
    params as Parameters<typeof execSlackRead>[1],
    { keymaker, transport },
  );

  if (input.ledger !== undefined) {
    const store = openAnchoredChain(input.ledger);
    try {
      await recordSlackReadDerivation(store.derivations, envelope);
    } finally {
      store.close();
    }
  }

  return input.provenance
    ? JSON.stringify(slackReadProvenance(envelope))
    : JSON.stringify(envelope);
}
