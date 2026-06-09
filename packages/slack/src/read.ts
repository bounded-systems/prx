// slack .5 (prx-z93) — execSlackRead: the gated, provenance-ready read pipeline.
//
//   1. policy gate    checkPolicy("slack", op, state, role) — hard-block + allowlist
//   2. mint key       a per-read ScopedSlackKey scoped to exactly {op, channel},
//                     short TTL — least authority for this one read
//   3. transport      transport.call(op, params, key) — the key authorizes the
//                     underlying request; the secret never appears here
//   4. content-addr   sha256 of the canonical {op, params, result} envelope
//
// Auth-free and env-free: state/role arrive via deps (the composition root reads
// PRX_CAPABILITY_STATE / PRX_AGENT_ROLE through @bounded-systems/env and passes
// them); this module never reads the ambient environment itself. The keymaker +
// transport are injected, so the whole pipeline is testable with fakes.

import { sha256BareHex } from "@bounded-systems/cas";
import {
  checkPolicy,
  type PolicyDecision,
  type PolicyRole,
  type PolicyState,
} from "@bounded-systems/policy";

import { canonicalJson } from "./canonical.ts";
import type { SlackKeymaker, SlackKeyScope } from "./keymaker.ts";
import type { SlackReadTransport } from "./transport.ts";
import {
  SLACK_READ_OPS,
  SlackReadError,
  type SlackReadOp,
  type SlackRawResult,
  type SlackReadParams,
} from "./types.ts";

/** Default lifetime of a per-read minted key — short, by design. */
export const DEFAULT_KEY_TTL_MS = 60_000;

export interface ExecSlackReadDeps {
  /** Mints the per-read scoped credential (composition root: slackScopedKeymaker(createServiceKeymaker("slack"))). */
  keymaker: SlackKeymaker;
  /** The backend (mcp | cli | webapi adapter). */
  transport: SlackReadTransport;
  /** Policy state; defaults to "validating". Supplied by the composition root, never read from env here. */
  state?: PolicyState | undefined;
  /** Policy role; defaults to "executor". */
  role?: PolicyRole | undefined;
  /** Minted-key TTL; defaults to {@link DEFAULT_KEY_TTL_MS}. */
  ttlMs?: number | undefined;
}

/** The content-addressed result of one read, ready for the provenance bridge (.6). */
export interface SlackReadEnvelope<Op extends SlackReadOp = SlackReadOp> {
  op: Op;
  params: SlackReadParams[Op];
  result: SlackRawResult;
  /** Bare-hex sha256 of the canonical {op, params, result} envelope. */
  sha256: string;
  /** Provenance attribution from the key that authorized this read (non-secret). */
  keyId: string;
  scope: SlackKeyScope;
  expiresAt: number;
  /** The allow decision that gated the read. */
  policy: PolicyDecision;
}

/** A string param field, or undefined when absent/non-string. */
function strField(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * The org/channel/thread a read reaches, for the least-authority per-read
 * scope: `team_id` → org (workspace/enterprise), `channel` → channel, and the
 * thread parent ts (`thread_ts`, or the `ts` of a `thread`/replies read).
 * Each is undefined when the read doesn't reach that level (org ⊃ channel ⊃
 * thread).
 */
function targetOf(
  op: SlackReadOp,
  params: Record<string, unknown>,
): { org?: string; channel?: string; thread?: string } {
  const org = strField(params, "team_id");
  const channel = strField(params, "channel");
  const thread = strField(params, "thread_ts") ?? (op === "thread" ? strField(params, "ts") : undefined);
  const target: { org?: string; channel?: string; thread?: string } = {};
  if (org !== undefined) target.org = org;
  if (channel !== undefined) target.channel = channel;
  if (thread !== undefined) target.thread = thread;
  return target;
}

export async function execSlackRead<Op extends SlackReadOp>(
  op: Op,
  params: SlackReadParams[Op],
  deps: ExecSlackReadDeps,
): Promise<SlackReadEnvelope<Op>> {
  if (!SLACK_READ_OPS.includes(op)) {
    throw new SlackReadError(`unknown slack read op: ${String(op)}`, "MISSING_PARAM");
  }

  const state: PolicyState = deps.state ?? "validating";
  const role: PolicyRole = deps.role ?? "executor";
  const policy = checkPolicy("slack", op, state, role);
  if (!policy.allowed) {
    throw new SlackReadError(
      `slack read '${op}' blocked for state '${state}' role '${role}'`,
      "POLICY_BLOCKED",
    );
  }

  // Mint a key scoped to exactly this read: this op, and the org/channel/thread
  // it reaches — least authority across all three dimensions.
  const { org, channel, thread } = targetOf(op, params as Record<string, unknown>);
  const scope: SlackKeyScope = {
    ops: [op],
    ...(org !== undefined ? { orgs: [org] } : {}),
    ...(channel !== undefined ? { channels: [channel] } : {}),
    ...(thread !== undefined ? { threads: [thread] } : {}),
  };
  const key = deps.keymaker.mint({ scope, ttlMs: deps.ttlMs ?? DEFAULT_KEY_TTL_MS });

  const result = await deps.transport.call(op, params, key);

  // Content-address the DATA envelope (op + params + result). Key metadata is
  // provenance attribution, deliberately NOT part of the hash, so the same read
  // yields the same address regardless of which key authorized it.
  const sha256 = sha256BareHex(canonicalJson({ op, params, result }));

  return {
    op,
    params,
    result,
    sha256,
    keyId: key.keyId,
    scope: key.scope,
    expiresAt: key.expiresAt,
    policy,
  };
}

/** Serialize an envelope to canonical JSON (for CAS storage / handles). */
export function formatSlackReadEnvelope(envelope: SlackReadEnvelope): string {
  return canonicalJson(envelope) + "\n";
}
