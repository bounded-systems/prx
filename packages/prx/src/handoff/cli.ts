// GH-1397 — `prx handoff` CLI surface.
//
// Five subcommands:
//
//   prx handoff enqueue --target <actor> --verb <v> [...]
//   prx handoff status  [--target <actor>] [--work-unit GH-N] [--state <st>] [--show-stale]
//   prx handoff drain   --actor <name> [--once] [--max <N>]
//   prx handoff replay  <id>   (re-enqueue an abandoned row with fresh state)
//
// All four ride the same `enqueueHandoff` / `listHandoffs` / `drain` core.
// Operator entry point: the agent (or human) calls `prx handoff enqueue`
// from inside a session that just hit a flag-layer deny.

import { readFileSync } from "node:fs";

import {
  handoffTargetActor,
  type HandoffEnvelope,
  type HandoffStatus,
  type WorkUnitId,
} from "@bounded-systems/machine-schema";

import { drain, emitHandoffEvent, type DrainDeps } from "./drain.ts";
import { enqueueFromFlagLayerDeny } from "./from-deny.ts";
import {
  enqueueHandoff,
  getHandoff,
  listHandoffs,
  type HandoffStoreDeps,
} from "./store.ts";

// ── shared output shape ────────────────────────────────────────────────────

export type HandoffCliOutput = {
  log: (line: string) => void;
  error: (line: string) => void;
};

/**
 * Injectable seams for the handoff verbs. All optional, defaulting to the real
 * bd/CAS/audit-backed implementations, so production call sites pass nothing —
 * they exist so the verbs are exercisable without a live bd substrate.
 */
export type HandoffCliDeps = {
  /** bd/CAS store seam for enqueue / list / get / replay. */
  store?: HandoffStoreDeps;
  /** Drain engine seam (bd + policy + audit). */
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
  const target = handoffTargetActor.safeParse(opts.target);
  if (!target.success) {
    output.error(
      `handoff enqueue: --target must be one of ${handoffTargetActor.options.join("|")}, got "${opts.target}"`,
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
      output.log(
        formatEnvelope(result.envelope, opts.format, "duplicate"),
      );
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
  opts: HandoffStatusOptions,
  output: HandoffCliOutput,
  deps: HandoffCliDeps = {},
): Promise<number> {
  let target: HandoffEnvelope["targetActor"] | undefined;
  if (opts.target) {
    const parsed = handoffTargetActor.safeParse(opts.target);
    if (!parsed.success) {
      output.error(
        `handoff status: --target must be one of ${handoffTargetActor.options.join("|")}, got "${opts.target}"`,
      );
      return 2;
    }
    target = parsed.data;
  }
  const envelopes = await listHandoffs(
    {
      ...(target ? { target } : {}),
      ...(opts.workUnitId ? { workUnitId: opts.workUnitId } : {}),
      ...(opts.state ? { status: opts.state } : {}),
    },
    deps.store,
  );

  if (opts.format === "json") {
    output.log(JSON.stringify(envelopes, null, 2));
    return 0;
  }
  if (envelopes.length === 0) {
    output.log("handoff status: no rows");
    return 0;
  }
  for (const env of envelopes) {
    output.log(
      `${env.id}  ${env.status.padEnd(10)} ${env.targetActor.padEnd(10)} ${env.intent.verb}  uow=${env.workUnitId ?? "-"}  attempts=${env.attempts}`,
    );
  }
  return 0;
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
  const parsed = handoffTargetActor.safeParse(opts.actor);
  if (!parsed.success) {
    output.error(
      `handoff drain: --actor must be one of ${handoffTargetActor.options.join("|")}, got "${opts.actor}"`,
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
  deps: HandoffCliDeps = {},
): Promise<number> {
  const existing = await getHandoff(opts.id, deps.store);
  if (!existing) {
    output.error(`handoff replay: no row found for id ${opts.id}`);
    return 1;
  }
  if (existing.status !== "abandoned" && existing.status !== "failed") {
    output.error(
      `handoff replay: row ${opts.id} status is "${existing.status}"; only abandoned/failed rows are replayable`,
    );
    return 2;
  }

  const result = await enqueueHandoff(
    {
      workUnitId: existing.workUnitId,
      repoSlug: existing.repoSlug,
      sourceActor: existing.sourceActor,
      ...(existing.sourceSessionId
        ? { sourceSessionId: existing.sourceSessionId }
        : {}),
      targetActor: existing.targetActor,
      intent: existing.intent,
      inputRefs: existing.inputRefs,
      denialReason: existing.denialReason,
      ...(existing.policyKey ? { policyKey: existing.policyKey } : {}),
      ...(existing.workTreeRef ? { workTreeRef: existing.workTreeRef } : {}),
      ...(existing.causedBy ? { causedBy: existing.causedBy } : {}),
      maxAttempts: existing.maxAttempts,
    },
    deps.store,
  );

  switch (result.kind) {
    case "created":
      emitHandoffEvent("HANDOFF_ENQUEUED", result.envelope, deps.appendAuditRow);
      output.log(formatEnvelope(result.envelope, opts.format, "replayed"));
      return 0;
    case "duplicate":
      output.log(formatEnvelope(result.envelope, opts.format, "duplicate"));
      return 0;
    case "bd-unprovisioned":
      output.error(`handoff replay: bd unprovisioned (${result.error})`);
      return 3;
    case "cross-repo-refused":
      output.error(
        `handoff replay: cross-repo refused (got ${result.got}, expected ${result.expected})`,
      );
      return 4;
  }
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
