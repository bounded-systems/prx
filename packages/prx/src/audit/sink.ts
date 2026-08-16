// GH-1403 — unified runtime audit sink.
//
// Single daily NDJSON file under `$XDG_STATE_HOME/prx/audit/<YYYY-MM-DD>.ndjson`
// (with `$XDG_STATE_HOME` defaulting to `~/.local/state`). Every per-verb row
// (apply / promote / prioritize / type-pass / prioritize-bulk / drift-fix /
// migrate-axis-value / promote-children) and every machine
// state-transition event routes through `appendAuditRow`.
//
// Boundary contract (per `reference_zod_boundary_layer`): rows are validated
// against `auditRowSchema` on the way in. Invalid shapes throw — this is
// intentional, the caller is the trust boundary.
//
// `makeAuditInspector` adapts XState's `inspect` callback into machine-event
// rows. It filters to root-actor snapshots only (rootId === actorRef.id) so
// child actors invoked by individual states do not flood the sink.

import { processEnv } from "@bounded-systems/env";
import { appendFileSync, mkdirSync } from "node:fs";
import { homeDir } from "@bounded-systems/host";
import { dirname, join } from "node:path";

import type { InspectionEvent } from "xstate";

import { auditRowSchema, type AuditRow } from "../triage/schemas/audit.ts";

export type AuditAppendFn = (path: string, line: string) => void;
export type AuditEnsureDirFn = (path: string) => void;
export type AuditStdoutFn = (line: string) => void;

export type AuditSinkDeps = {
  now?: () => Date;
  /** Override the resolved state dir (skips the homedir + XDG_STATE_HOME walk). */
  stateDirOverride?: string;
  appendFn?: AuditAppendFn;
  ensureDir?: AuditEnsureDirFn;
  /**
   * Sink for the `PRX_AUDIT_STDOUT=1` mirror. Defaults to
   * `process.stdout.write`. Tests inject a capture array.
   */
  stdoutFn?: AuditStdoutFn;
  /** Override `processEnv()`. Tests use this to flip `PRX_AUDIT_STDOUT`. */
  env?: NodeJS.ProcessEnv;
};

export type AuditSinkPathOptions = {
  stateDirOverride?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
};

function resolveStateDir(opts: AuditSinkPathOptions = {}): string {
  if (opts.stateDirOverride) return opts.stateDirOverride;
  const env = opts.env ?? processEnv();
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg && xdg.length > 0) return xdg;
  return join(homeDir(), ".local", "state");
}

/**
 * Resolve the daily NDJSON sink path. The bucket is `YYYY-MM-DD` derived from
 * the supplied `date` so a long-running session that crosses midnight rolls
 * naturally without explicit rotation.
 */
export function auditSinkPath(date: Date, opts: AuditSinkPathOptions = {}): string {
  const stateDir = resolveStateDir(opts);
  const day = date.toISOString().slice(0, 10);
  return join(stateDir, "prx", "audit", `${day}.ndjson`);
}

/**
 * Append one validated NDJSON row to the daily sink.
 *
 * Throws when `row` does not match `auditRowSchema`; that is the design — the
 * caller is the trust boundary and a wrong-shape row in production is a bug,
 * not a runtime condition to soft-handle.
 *
 * The serialized line is the original `row` rather than `auditRowSchema`'s
 * parsed output. `auditRowSchema` is a `z.union(...)` of overlapping per-verb
 * shapes, and Zod strips unknown fields against the first matching arm —
 * which would silently drop legitimate per-verb fields (e.g. `decision` on a
 * prioritize-bulk row when the type-pass arm matches first). The verb files
 * already keep their TS types as the authoritative declaration; the union is
 * used as a gate, not as a structural transform.
 */
export function appendAuditRow(row: unknown, deps: AuditSinkDeps = {}): void {
  auditRowSchema.parse(row);
  const now = (deps.now ?? (() => new Date()))();
  const path = auditSinkPath(now, {
    stateDirOverride: deps.stateDirOverride,
    env: deps.env,
  });
  const line = `${JSON.stringify(row)}\n`;

  const ensure = deps.ensureDir ?? ((p: string) => mkdirSync(p, { recursive: true }));
  ensure(dirname(path));

  const append = deps.appendFn ?? ((p: string, l: string) => appendFileSync(p, l, "utf8"));
  append(path, line);

  const env = deps.env ?? processEnv();
  if (env.PRX_AUDIT_STDOUT === "1") {
    const stdout = deps.stdoutFn ?? ((l: string) => process.stdout.write(l));
    stdout(line);
  }
}

export type MakeAuditInspectorOptions = {
  workUnitId?: string | undefined;
  /** Sink DI seam — forwarded to `appendAuditRow`. */
  deps?: AuditSinkDeps | undefined;
};

/**
 * Build an XState `inspect` callback that emits one audit row per root-actor
 * state change. Tracks the previous state in closure so each transition fires
 * an `exit` row for the prior state followed by an `entry` row for the new
 * state, with `durationMs` populated on the exit row.
 *
 * Filters on `inspectionEvent.actorRef.id === inspectionEvent.rootId` so child
 * actors invoked by individual machine states do not produce rows. The
 * inspector is intentionally side-effect-only: any throw inside
 * `appendAuditRow` is swallowed so a sink-side write failure does not abort
 * the underlying machine run.
 */
export function makeAuditInspector(
  // GH-360: `pilot`/`fleet` added so the autonomous machines' own state
  // transitions reach the audit sink (the monitor already greps machine:pilot) —
  // without them a pilot retreat loop is invisible.
  machine: "triage" | "session-entry" | "pilot" | "fleet",
  opts: MakeAuditInspectorOptions = {},
): (event: InspectionEvent) => void {
  let prevState: string | undefined;
  let entryAt: number | undefined;

  return (event: InspectionEvent): void => {
    if (event.type !== "@xstate.snapshot") return;
    const ref = event.actorRef as { id?: string } | undefined;
    if (!ref || ref.id !== event.rootId) return;

    const snap = event.snapshot as { value?: unknown };
    const state = formatStateValue(snap.value);
    if (state === prevState) return;

    const now = (opts.deps?.now ?? (() => new Date()))();
    const tsNow = now.toISOString();

    if (prevState !== undefined) {
      const exitRow = {
        ts: tsNow,
        machine,
        kind: "exit" as const,
        state: prevState,
        actor: "claude-code",
        ...(opts.workUnitId ? { workUnitId: opts.workUnitId } : {}),
        ...(entryAt !== undefined ? { durationMs: Math.max(0, now.getTime() - entryAt) } : {}),
      };
      try {
        appendAuditRow(exitRow, opts.deps);
      } catch {
        // sink-side errors are intentionally swallowed
      }
    }

    const entryRow = {
      ts: tsNow,
      machine,
      kind: "entry" as const,
      state,
      actor: "claude-code",
      ...(opts.workUnitId ? { workUnitId: opts.workUnitId } : {}),
      ...(prevState !== undefined ? { prevState } : {}),
      ...(event.event?.type ? { event: String(event.event.type) } : {}),
    };
    try {
      appendAuditRow(entryRow, opts.deps);
    } catch {
      // sink-side errors are intentionally swallowed
    }

    prevState = state;
    entryAt = now.getTime();
  };
}

function formatStateValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}
