// GH-1397 — `prx handoff` CLI surface.
//
// Five subcommands:
//
//   prx handoff enqueue --target <actor> --verb <v> [...]
//   prx handoff status  [--target <actor>] [--work-unit GH-N] [--state <st>] [--show-stale]
//   prx handoff drain   --actor <name> [--once] [--max <N>]
//   prx handoff replay  <id>   (re-enqueue an abandoned row with fresh state)
//
// Operator entry point: the agent (or human) calls `prx handoff enqueue`
// from inside a session that just hit a flag-layer deny.
//
// GH-1012: the durable queue (`handoff/store.ts`, bd/CAS-backed) was removed
// with the beads substrate. `enqueue`/`drain` still route through the
// surviving `from-deny.ts` / `drain.ts` seams; the store-backed reads
// (`status`, `replay`) fail closed until a non-bd store lands.

import { readFileSync } from "node:fs";

import {
  HANDOFF_TARGET_ACTOR_VALUES,
  safeParseHandoffTargetActor,
  type HandoffEnvelope,
  type HandoffStatus,
  type WorkUnitId,
} from "@bounded-systems/machine-schema";

import { drain, emitHandoffEvent, type DrainDeps } from "./drain.ts";
import { enqueueFromFlagLayerDeny } from "./from-deny.ts";

// ── shared output shape ────────────────────────────────────────────────────

export type HandoffCliOutput = {
  log: (line: string) => void;
  error: (line: string) => void;
};

/**
 * Injectable seams for the handoff verbs. All optional, defaulting to the real
 * implementations, so production call sites pass nothing — they exist so the
 * verbs are exercisable without a live substrate.
 */
export type HandoffCliDeps = {
  /** Store seam threaded to the flag-layer-deny enqueue path. */
  store?: Parameters<typeof enqueueFromFlagLayerDeny>[1];
  /** Drain engine seam (policy + audit). */
  drain?: DrainDeps;
  /** Audit-row writer for the HANDOFF_ENQUEUED telemetry on the created path. */
  appendAuditRow?: Parameters<typeof emitHandoffEvent>[2];
};

// ── enqueue ────────────────────────────────────────────────────────────────

export type HandoffEnqueueOptions = {
  target: string;
  verb: string;
  workUnitId?: string;
  argsFile?: string;
  argsLiteral?: string;
  dedupKey?: string;
  sourceActor?: string;
  format: "plain" | "json";
};

export async function runHandoffEnqueue(
  opts: HandoffEnqueueOptions,
  output: HandoffCliOutput,
  deps: HandoffCliDeps = {},
): Promise<number> {
  const target = safeParseHandoffTargetActor(opts.target);
  if (!target.success) {
    output.error(
      `handoff enqueue: --target must be one of ${HANDOFF_TARGET_ACTOR_VALUES.join("|")}, got "${opts.target}"`,
    );
    return 2;
  }

  const args = loadArgs(opts);
  const result = await enqueueFromFlagLayerDeny(
    {
      tool: opts.verb,
      args,
      target: target.data,
      // CLI ingestion seam. The envelope carrier is permissive (`min(1)`), not
      // canonical, so we brand without re-validating shape — preserving the
      // pre-GH-2098 pass-through behavior (no silent null of non-canonical ids).
      workUnitId: (opts.workUnitId ?? null) as WorkUnitId | null,
      sourceActor: opts.sourceActor,
    },
    deps.store,
  );

  switch (result.kind) {
    case "created":
      emitHandoffEvent("HANDOFF_ENQUEUED", result.envelope, deps.appendAuditRow);
      output.log(formatEnvelope(result.envelope, opts.format, "enqueued"));
      return 0;
    case "duplicate":
      output.log(formatEnvelope(result.envelope, opts.format, "duplicate"));
      return 0;
    case "bd-unprovisioned":
      // I-HQ5: fail closed. Surface the banner-string fallback so the operator
      // knows the safety net is still available.
      output.error(
        `handoff enqueue: bd unprovisioned (${result.error}); fall back to: exit and run \`prx ${target.data} session\` from a fresh shell`,
      );
      return 3;
    case "cross-repo-refused":
      output.error(
        `handoff enqueue: cross-repo refused (got ${result.got}, expected ${result.expected})`,
      );
      return 4;
  }
  // Defensive terminal return: the switch is exhaustive over the current
  // EnqueueResult union; the fallthrough keeps the verb yielding an exit code
  // if that union ever gains a kind.
  return 1;
}

// ── status ─────────────────────────────────────────────────────────────────

export type HandoffStatusOptions = {
  target?: string;
  workUnitId?: string;
  state?: HandoffStatus;
  showStale?: boolean;
  format: "plain" | "json";
};

export async function runHandoffStatus(
  _opts: HandoffStatusOptions,
  output: HandoffCliOutput,
  _deps: HandoffCliDeps = {},
): Promise<number> {
  // GH-1012: the durable handoff queue lived in `handoff/store.ts`, a
  // bd/CAS-backed store removed with the beads substrate. `status` was purely
  // a read over that store, so there is no backend left to query. Fail closed
  // rather than report a misleading empty result.
  output.error("handoff status: durable handoff store removed (GH-1012); no queue backend to read");
  return 3;
}

// ── drain ──────────────────────────────────────────────────────────────────

export type HandoffDrainOptions = {
  actor: string;
  once: boolean;
  max: number;
  format: "plain" | "json";
};

export async function runHandoffDrain(
  opts: HandoffDrainOptions,
  output: HandoffCliOutput,
  deps: HandoffCliDeps = {},
): Promise<number> {
  const parsed = safeParseHandoffTargetActor(opts.actor);
  if (!parsed.success) {
    output.error(
      `handoff drain: --actor must be one of ${HANDOFF_TARGET_ACTOR_VALUES.join("|")}, got "${opts.actor}"`,
    );
    return 2;
  }
  const result = await drain({ target: parsed.data, max: opts.max }, deps.drain);
  if (opts.format === "json") {
    output.log(JSON.stringify(result, null, 2));
  } else {
    output.log(
      `handoff drain — actor ${parsed.data} — attempted ${result.attempted}  drained ${result.drained}  failed ${result.failed}`,
    );
    for (const outcome of result.outcomes) {
      output.log(
        `  ${outcome.id} → ${outcome.outcome}${outcome.error ? `  (${outcome.error})` : ""}`,
      );
    }
  }
  return result.failed > 0 ? 1 : 0;
}

// ── replay ─────────────────────────────────────────────────────────────────

export type HandoffReplayOptions = {
  id: string;
  format: "plain" | "json";
};

export async function runHandoffReplay(
  opts: HandoffReplayOptions,
  output: HandoffCliOutput,
  _deps: HandoffCliDeps = {},
): Promise<number> {
  // GH-1012: replay re-read an existing row from the durable handoff store
  // (`handoff/store.ts`) and re-enqueued it. That bd/CAS-backed store was
  // removed with the beads substrate, so there is no row to read; fail closed.
  output.error(`handoff replay: durable handoff store removed (GH-1012); cannot replay ${opts.id}`);
  return 3;
}

// ── helpers ────────────────────────────────────────────────────────────────

function loadArgs(opts: HandoffEnqueueOptions): unknown {
  if (opts.argsLiteral !== undefined) {
    try {
      return JSON.parse(opts.argsLiteral);
    } catch (err) {
      throw new Error(
        `handoff enqueue: --args could not be parsed as JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (opts.argsFile && opts.argsFile !== "-") {
    const raw = readFileSync(opts.argsFile, "utf8");
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `handoff enqueue: --args-file ${opts.argsFile} could not be parsed as JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return null;
}

function formatEnvelope(
  envelope: HandoffEnvelope,
  format: "plain" | "json",
  label: string,
): string {
  if (format === "json") {
    return JSON.stringify({ label, envelope }, null, 2);
  }
  return `handoff ${label}: ${envelope.id}  target=${envelope.targetActor}  verb=${envelope.intent.verb}  uow=${envelope.workUnitId ?? "-"}  status=${envelope.status}`;
}
