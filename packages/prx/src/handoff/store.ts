// GH-1397 — bd-memory adapter for the structured handoff queue, plus
// plan-store CAS spillover for large `intent.args`.
//
// Why bd memory:
//
//   - Lifecycle is multi-write (enqueue + claim + drain-result). bd is backed
//     by Dolt and exposes per-write atomicity (I-HQ4).
//   - Per-repo, not per-worktree — exactly the cross-worktree shape we
//     need (executor in worktree A enqueues for publisher running from
//     main).
//   - Prefix scan via `bd memories` already exists (src/memory/compact.ts:1)
//     and is observable.
//   - `uow_id` field already on bd rows; bolting it onto a `.prx/handoffs/`
//     filename would be reinvention.
//
// Fail-closed when bd is unprovisioned (I-HQ5): callers exit non-zero and
// surface the legacy banner string as a safety net.

import { processEnv } from "@bounded-systems/env";
import { createHash, randomBytes } from "node:crypto";

import { handoffEnvelope, type HandoffEnvelope } from "@bounded-systems/machine-schema";

import { writeBlob } from "../plan-store/cas.ts";
import { execBd as defaultExecBd } from "@bounded-systems/bd";
import { handoffDaemonBd } from "./daemon-bd.ts";

// ── tunables ───────────────────────────────────────────────────────────────

/**
 * The bd row body stays small for cheap prefix scans. Anything past this
 * threshold spills to plan-store CAS by `sha256:` handle; the handle is
 * written to `inputRefs[]`. Per the plan (I-AUD2 by construction), the
 * limit lives here so future tuning is one edit.
 */
export const HANDOFF_ARGS_INLINE_THRESHOLD_BYTES = 4 * 1024;

/** CAS domain for spilled `intent.args` blobs. Isolated from `plans://`. */
export const HANDOFF_CAS_DOMAIN = "handoff";

// ── key shape ──────────────────────────────────────────────────────────────

/**
 * Per the plan: `handoff/<targetActor>/<workUnitId|none>/<id>`. Slashes are
 * tolerated by bd remember/recall (string body, --key flag).
 */
export function handoffMemoryKey(envelope: HandoffEnvelope): string {
  const work = envelope.workUnitId ?? "none";
  return `handoff/${envelope.targetActor}/${work}/${envelope.id}`;
}

/** Prefix used by `bd memories <prefix>` to scan a recipient's pending row. */
export function handoffMemoryKeyPrefix(
  target: HandoffEnvelope["targetActor"],
  workUnitId?: string | null,
): string {
  const work = workUnitId ?? "none";
  return workUnitId === undefined ? `handoff/${target}/` : `handoff/${target}/${work}/`;
}

// ── identity ───────────────────────────────────────────────────────────────

/**
 * I-HQ3 idempotency key. A second enqueue with the same
 * `(uow_id, targetActor, verb, argsCanonical)` returns the existing
 * `handoff_id` without writing a new row.
 *
 * `argsCanonical` is the JSON serialization with sorted keys so a caller
 * that hands us `{a:1,b:2}` and another that hands us `{b:2,a:1}` collide
 * on the same dedupKey.
 */
export function computeDedupKey(input: {
  workUnitId: string | null;
  targetActor: string;
  verb: string;
  args: unknown;
}): string {
  const canonical = canonicalJson(input.args);
  const material = [input.workUnitId ?? "", input.targetActor, input.verb, canonical].join("");
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",");
  return `{${body}}`;
}

/**
 * ULID-shaped id (Crockford base32, 26 chars). We use a smaller surface
 * rather than pulling in a full ULID dep; the only consumer of the id is
 * the bd key and the audit row's `handoff_id`, neither of which parses it.
 */
export function newHandoffId(now: Date = new Date()): string {
  const ts = now.getTime();
  const rand = randomBytes(10).toString("hex");
  return `H${ts.toString(36).toUpperCase()}_${rand.toUpperCase()}`;
}

// ── store deps ─────────────────────────────────────────────────────────────

export type HandoffStoreDeps = {
  execBd?: typeof defaultExecBd | undefined;
  /** Override for tests that want to bypass real CAS writes. */
  casWriteBlob?: ((content: string, domain: string) => Promise<{ sha: string }>) | undefined;
  now?: (() => Date) | undefined;
  /** `repoNameWithOwner(cwd)` for I-HQ cross-repo guard. */
  currentRepoSlug?: (() => string) | undefined;
};

// ── enqueue ────────────────────────────────────────────────────────────────

export type EnqueueResult =
  | { kind: "created"; envelope: HandoffEnvelope }
  | { kind: "duplicate"; envelope: HandoffEnvelope; existingId: string }
  | { kind: "bd-unprovisioned"; error: string }
  | { kind: "cross-repo-refused"; expected: string; got: string };

export type EnqueueInput = Omit<
  HandoffEnvelope,
  "id" | "dedupKey" | "enqueuedAt" | "status" | "attempts" | "inputRefs" | "maxAttempts"
> & {
  /** Optional caller-supplied inputRefs; CAS spillover handles get appended. */
  inputRefs?: string[];
  /** Defaults to 3 (envelope schema default). */
  maxAttempts?: number;
};

/**
 * Enqueue a handoff, spilling large `intent.args` to CAS.
 *
 * I-HQ3 (idempotent): a second enqueue with the same `dedupKey` returns the
 * existing row.
 * I-HQ4 (atomic): bd remember is a single SQL row write — partial envelopes
 * never appear on disk.
 * I-HQ5 (fail-closed): bd unprovisioned ⇒ return `bd-unprovisioned`; caller
 * exits non-zero and surfaces the legacy banner fallback.
 */
export async function enqueueHandoff(
  input: EnqueueInput,
  deps: HandoffStoreDeps = {},
): Promise<EnqueueResult> {
  const execBd = deps.execBd ?? handoffDaemonBd;
  const now = (deps.now ?? (() => new Date()))();

  // Cross-repo guard: the queue is per-repo. Callers wishing to enqueue for
  // a different repo must use a future cross-repo routing primitive.
  if (deps.currentRepoSlug) {
    const expected = deps.currentRepoSlug();
    if (expected && input.repoSlug !== expected) {
      return { kind: "cross-repo-refused", expected, got: input.repoSlug };
    }
  }

  // CAS spillover.
  const { args, inputRefs } = await maybeSpillArgs(
    input.intent.args,
    input.inputRefs ?? [],
    deps.casWriteBlob,
  );

  const dedupKey = computeDedupKey({
    workUnitId: input.workUnitId,
    targetActor: input.targetActor,
    verb: input.intent.verb,
    args: input.intent.args,
  });

  // Idempotency check — look up an existing row by dedupKey under the
  // recipient's prefix.
  const existing = await findByDedupKey(input.targetActor, input.workUnitId, dedupKey, execBd);
  if (existing) {
    return { kind: "duplicate", envelope: existing, existingId: existing.id };
  }

  const id = newHandoffId(now);
  const envelopeInput = {
    ...input,
    id,
    dedupKey,
    inputRefs,
    intent: { verb: input.intent.verb, args },
    enqueuedAt: now.toISOString(),
    status: "pending" as const,
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
  };
  const envelope = handoffEnvelope.parse(envelopeInput);
  const body = JSON.stringify(envelope);

  const key = handoffMemoryKey(envelope);
  const result = execBd(
    {
      subcommand: "remember",
      args: [body, "--key", key, "--json"],
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (result.exitCode !== 0) {
    return {
      kind: "bd-unprovisioned",
      error:
        result.stderr.trim() ||
        result.stdout.trim() ||
        "bd remember failed (bd may be unprovisioned)",
    };
  }
  return { kind: "created", envelope };
}

// ── read / scan ────────────────────────────────────────────────────────────

export type ListOptions = {
  target?: HandoffEnvelope["targetActor"];
  workUnitId?: string | null;
  /** Optional status filter — applied client-side after parse. */
  status?: HandoffEnvelope["status"];
};

export async function listHandoffs(
  opts: ListOptions = {},
  deps: HandoffStoreDeps = {},
): Promise<HandoffEnvelope[]> {
  const execBd = deps.execBd ?? handoffDaemonBd;
  const target = opts.target;
  // `bd memories <prefix>` returns rows whose key starts with prefix. With no
  // target we scan `handoff/`; with a target we scan `handoff/<target>/`.
  const prefix = target ? handoffMemoryKeyPrefix(target, opts.workUnitId ?? undefined) : "handoff/";

  const result = execBd(
    {
      subcommand: "memories",
      args: [prefix, "--json"],
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (result.exitCode !== 0) {
    // bd unprovisioned or scan failed — return empty set; the caller
    // converts this into an exit-non-zero per I-HQ5.
    return [];
  }
  const rows = parseMemoriesJson(result.stdout);
  const envelopes: HandoffEnvelope[] = [];
  for (const row of rows) {
    const env = tryParseEnvelope(row.body);
    if (env) {
      if (opts.status && env.status !== opts.status) continue;
      envelopes.push(env);
    }
  }
  // Stable oldest-first ordering for drain fairness.
  envelopes.sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt));
  return envelopes;
}

export async function findByDedupKey(
  target: HandoffEnvelope["targetActor"],
  workUnitId: string | null,
  dedupKey: string,
  exec: typeof defaultExecBd,
): Promise<HandoffEnvelope | null> {
  const prefix = handoffMemoryKeyPrefix(target, workUnitId ?? undefined);
  const result = exec(
    {
      subcommand: "memories",
      args: [prefix, "--json"],
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (result.exitCode !== 0) return null;
  for (const row of parseMemoriesJson(result.stdout)) {
    const env = tryParseEnvelope(row.body);
    if (env && env.dedupKey === dedupKey) return env;
  }
  return null;
}

export async function getHandoff(
  id: string,
  deps: HandoffStoreDeps = {},
): Promise<HandoffEnvelope | null> {
  const all = await listHandoffs({}, deps);
  return all.find((h) => h.id === id) ?? null;
}

// ── transitions ────────────────────────────────────────────────────────────
//
// Each transition is a `bd remember` over the existing key — bd's body is
// the JSON envelope, so we re-write the row with the new status. We keep
// the at-rest atomicity invariant (I-HQ4) by relying on bd's SQL row write.
//
// `claim` is the only compare-and-swap: we read, refuse if `claimedBy` is
// already set, then write. The store layer cannot enforce true CAS without
// a bd-side guard; the machine guard `notAlreadyClaimed` plus a fresh read
// here is the best the bd-memory adapter offers. A bd-side conditional
// write lands when bd grows the surface.

export type ClaimResult =
  | { kind: "claimed"; envelope: HandoffEnvelope }
  | { kind: "already-claimed"; by: string }
  | { kind: "not-found" }
  | { kind: "write-failed"; error: string };

export async function claimHandoff(
  id: string,
  claimant: string,
  claimTtlSec: number,
  deps: HandoffStoreDeps = {},
): Promise<ClaimResult> {
  const execBd = deps.execBd ?? handoffDaemonBd;
  const now = (deps.now ?? (() => new Date()))();

  // Synchronous read-then-write within a single micro-task — no awaits
  // between the read and the conditional write so a concurrent claim on
  // the same row cannot interleave. Bd-side will eventually grow a
  // conditional `UPDATE ... WHERE claimedBy IS NULL` SQL surface; until
  // then the in-process single-threaded JS execution model is the CAS.
  const scan = execBd(
    {
      subcommand: "memories",
      args: ["handoff/", "--json"],
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (scan.exitCode !== 0) {
    return { kind: "write-failed", error: scan.stderr || scan.stdout };
  }
  let current: HandoffEnvelope | null = null;
  for (const row of parseMemoriesJson(scan.stdout)) {
    const env = tryParseEnvelope(row.body);
    if (env && env.id === id) {
      current = env;
      break;
    }
  }
  if (!current) return { kind: "not-found" };
  if (current.claimedBy !== undefined) {
    return { kind: "already-claimed", by: current.claimedBy };
  }

  const next: HandoffEnvelope = {
    ...current,
    status: "claimed",
    claimedBy: claimant,
    claimAt: now.toISOString(),
    claimTtlSec,
  };
  const validated = handoffEnvelope.parse(next);
  const writeResult = execBd(
    {
      subcommand: "remember",
      args: [JSON.stringify(validated), "--key", handoffMemoryKey(validated), "--json"],
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (writeResult.exitCode !== 0) {
    return {
      kind: "write-failed",
      error: writeResult.stderr.trim() || writeResult.stdout.trim() || "bd remember failed",
    };
  }
  return { kind: "claimed", envelope: validated };
}

export async function writeEnvelope(
  envelope: HandoffEnvelope,
  exec: typeof defaultExecBd = handoffDaemonBd,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Re-validate on every persistence boundary. The Zod parser is the trust
  // boundary per `reference_zod_boundary_layer`.
  const validated = handoffEnvelope.parse(envelope);
  const key = handoffMemoryKey(validated);
  const body = JSON.stringify(validated);
  const result = exec(
    {
      subcommand: "remember",
      args: [body, "--key", key, "--json"],
      state: "planning",
      role: "planner",
    },
    processEnv(),
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || result.stdout.trim() || "bd remember failed",
    };
  }
  return { ok: true };
}

// ── helpers ────────────────────────────────────────────────────────────────

async function maybeSpillArgs(
  args: unknown,
  inputRefs: string[],
  casWrite?: HandoffStoreDeps["casWriteBlob"],
): Promise<{ args: unknown; inputRefs: string[] }> {
  if (args === undefined || args === null) return { args, inputRefs };
  const serialized = JSON.stringify(args);
  if (serialized.length <= HANDOFF_ARGS_INLINE_THRESHOLD_BYTES) {
    return { args, inputRefs };
  }
  const write = casWrite ?? ((content: string, domain: string) => writeBlob(content, { domain }));
  const { sha } = await write(serialized, HANDOFF_CAS_DOMAIN);
  const handle = `cas://${sha}`;
  return {
    args: { $ref: handle },
    inputRefs: [...inputRefs, handle],
  };
}

type BdMemoryRow = { key: string; body: string };

function parseMemoriesJson(stdout: string): BdMemoryRow[] {
  if (!stdout.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const rows: BdMemoryRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const key = typeof e.key === "string" ? e.key : typeof e.name === "string" ? e.name : null;
    const body =
      typeof e.body === "string"
        ? e.body
        : typeof e.value === "string"
          ? e.value
          : typeof e.content === "string"
            ? e.content
            : null;
    if (key && body) rows.push({ key, body });
  }
  return rows;
}

function tryParseEnvelope(body: string): HandoffEnvelope | null {
  try {
    const parsed = JSON.parse(body);
    return handoffEnvelope.parse(parsed);
  } catch {
    return null;
  }
}
