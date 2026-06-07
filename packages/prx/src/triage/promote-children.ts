// `prx triage promote-children <staging-dir>` (GH-1351) — single-pass,
// idempotent verb that consumes a Zod-typed staging-dir manifest, files each
// child via in-process `runIntake`, and walks declared dep edges via
// `execBd dep add`.
//
// Mirror context:
//   - Sibling of `prx triage promote` (src/triage/promote.ts). Same actor lane
//     (planning tier, operator-initiated), same JSONL audit shape, same
//     "scan + apply" posture. No XState wiring (operator-initiated, no
//     PR-lifecycle event).
//   - Producer of the manifest is `prx plan supply` (GH-1186). v1 refuses on
//     legacy README + 09-deps.sh staging dirs — they predate the contract.
//
// Idempotency model:
//   - `<dir>/.filed.json` records `{ slot, number, url }` per filed body.
//   - On re-entry, slots already present in `.filed.json` are skipped.
//   - Dep wiring re-runs unconditionally; bd's typed-dep store dedupes
//     identical (from, to, type) edges.
//
// Resolver (deps[].from / deps[].to → bd ID):
//   - manifest slot          → look up `.filed.json` row → GH-N → beads lookup
//                              by external_ref → bd id
//   - literal `GH-N`         → beads lookup by external_ref → bd id
//   - canonical bd long-id   → pass through verbatim (workspace-prefixed
//                              ts-seq-hex8; exact-match safe — bd never fuzzes
//                              a full long id)
//   - short `ai-home-N`      → resolve via beads `byIssueNumber.get(N)`
//                              (GH-1473). N is the GH issue number the operator
//                              encoded as `ai-home-${gh_num}`. A short id MUST
//                              NOT reach bd: bd's prefix-ID resolver
//                              substring-matches it against the timestamp
//                              segment of an unrelated long id (e.g.
//                              `ai-home-1463` ⊂ `ai-home-1777491131463-…`) and
//                              silently miswires the edge. Honors invariant
//                              I-BF1 (resolve via (domain, external_id), never
//                              short-id prefix matching). Upstream Go resolver
//                              fix is tracked at GH-1479.

import { existsSync, readFileSync as defaultReadFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

import { z } from "zod";

import {
  appendAuditRow,
  auditSinkPath,
  type AuditSinkDeps,
} from "../audit/sink.ts";

import { runIntake as defaultRunIntake } from "../intake/intake.ts";
import type { IntakeOptions } from "../intake/intake.ts";
import { execBd as defaultExecBd } from "@bounded-systems/bd";
import { defaultRunner as procRunner, type CommandRunner } from "@bounded-systems/proc";
import { loadAllBeads, type BeadsRecord } from "./triage.ts";
import {
  buildBeadsLookup,
  type BeadsLookup,
} from "../issues/dedupe.ts";
import {
  promoteChildrenManifestSchema,
  promoteChildrenFiledStateSchema,
  type PromoteChildrenManifest,
  type PromoteChildrenFiledRow,
  type PromoteChildrenFiledState,
  type PromoteChildrenAuditEntry,
  type PromoteChildBody,
  type PromoteChildDep,
} from "./schemas/promote-children.ts";

export const triagePromoteChildrenOptionsSchema = z.object({
  dir: z.string().trim().min(1),
  dryRun: z.boolean().default(false),
  only: z.string().trim().min(1).optional(),
  limit: z.number().int().min(0).default(0),
});

export type TriagePromoteChildrenOptions = z.infer<
  typeof triagePromoteChildrenOptionsSchema
>;

export type ReadTextFile = (path: string, encoding: "utf8") => string;

export type TriagePromoteChildrenDeps = {
  runIntake?: typeof defaultRunIntake;
  execBd?: typeof defaultExecBd;
  /** GH-296 / prx-82b — sync runner for daemon-routed `prx beads dep add`. */
  run?: CommandRunner;
  loadAllBeads?: (exec: typeof defaultExecBd) => BeadsRecord[];
  readFileSync?: ReadTextFile;
  writeFileSyncFn?: (path: string, data: string) => void;
  existsSyncFn?: (path: string) => boolean;
  /** GH-1403 — sink-side DI for the unified daily NDJSON audit. */
  auditSink?: AuditSinkDeps;
  now?: () => Date;
};

type Output = {
  log: (line: string) => void;
  error: (line: string) => void;
};

const GH_REF_RE = /^GH-(\d+)$/;
const AI_HOME_REF_RE = /^ai-home-/;
// Short `ai-home-N` — the fuzzy-matchable form (GH-1473). `N` is the GH issue
// number; resolved through `lookup.byIssueNumber`, never handed to bd.
const AI_HOME_SHORT_REF_RE = /^ai-home-(\d+)$/;
// Canonical bd long-id shape (workspace-prefixed ts-seq-hex8). Mirror of
// `BD_LONG_ID_RE` in src/adapters/beads.ts; an exact long id is safe to pass
// to bd verbatim. Kept local to avoid pulling the adapter's side-effect
// registration into this operator-initiated verb.
const BD_LONG_ID_RE = /^[a-z][a-z0-9-]*-\d{13,}-\d+-[0-9a-f]{8}$/i;


function loadManifest(
  manifestPath: string,
  read: ReadTextFile,
  output: Output,
): PromoteChildrenManifest | null {
  let raw: string;
  try {
    raw = read(manifestPath, "utf8");
  } catch {
    output.error(
      `triage promote-children: missing manifest.json — staging dir must be produced by prx plan supply (GH-1186)`,
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    output.error(`triage promote-children: manifest.json is not valid JSON`);
    return null;
  }
  try {
    return promoteChildrenManifestSchema.parse(parsed);
  } catch (err) {
    output.error(
      `triage promote-children: manifest.json failed schema validation: ${(err as Error).message}`,
    );
    return null;
  }
}

function loadFiledState(
  filedPath: string,
  read: ReadTextFile,
  exists: (path: string) => boolean,
): PromoteChildrenFiledState {
  if (!exists(filedPath)) return { rows: [] };
  let raw: string;
  try {
    raw = read(filedPath, "utf8");
  } catch {
    return { rows: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    return promoteChildrenFiledStateSchema.parse(parsed);
  } catch {
    return { rows: [] };
  }
}

function writeFiledState(
  filedPath: string,
  state: PromoteChildrenFiledState,
  writer: (path: string, data: string) => void,
): void {
  writer(filedPath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Resolve a manifest dep ref to a bd identifier. Returns null when the ref
 * names a slot that hasn't been filed yet (caller skips the edge with an
 * audit row), or when a `GH-N` ref has no matching beads row.
 */
function resolveDepRef(
  ref: string,
  filedBySlot: Map<string, PromoteChildrenFiledRow>,
  lookup: BeadsLookup,
  dryRun: boolean,
): { ok: true; bdId: string; ghNumber: number | null } | { ok: false; reason: string } {
  if (AI_HOME_REF_RE.test(ref)) {
    // Canonical long-id → exact-match safe, pass through verbatim.
    if (BD_LONG_ID_RE.test(ref)) {
      return { ok: true, bdId: ref, ghNumber: null };
    }
    // GH-1473: a short `ai-home-N` ref must never reach bd (silent miswire via
    // prefix-substring fuzzing). `N` is the GH issue number — resolve through
    // `byIssueNumber` exactly like the GH-N branch below.
    const shortMatch = ref.match(AI_HOME_SHORT_REF_RE);
    if (shortMatch) {
      const number = Number(shortMatch[1]);
      const bead = lookup.byIssueNumber.get(number);
      if (bead) return { ok: true, bdId: bead.id, ghNumber: number };
      if (dryRun) return { ok: true, bdId: `(dry-run:${ref})`, ghNumber: number };
      return {
        ok: false,
        reason: `no beads row found for ${ref} (sync may be lagging)`,
      };
    }
    // Neither a canonical long id nor a short `ai-home-N` — refuse rather than
    // hand bd an unrecognized ref it might fuzzy-match.
    return {
      ok: false,
      reason: `unrecognized ai-home ref '${ref}' — expected a canonical long id or 'ai-home-<gh-number>'`,
    };
  }
  const ghMatch = ref.match(GH_REF_RE);
  if (ghMatch) {
    const number = Number(ghMatch[1]);
    const bead = lookup.byIssueNumber.get(number);
    if (bead) return { ok: true, bdId: bead.id, ghNumber: number };
    if (dryRun) return { ok: true, bdId: `(dry-run:${ref})`, ghNumber: number };
    return {
      ok: false,
      reason: `no beads row found for ${ref} (sync may be lagging)`,
    };
  }
  const filed = filedBySlot.get(ref);
  if (!filed) {
    return { ok: false, reason: `slot '${ref}' has not been filed in this run` };
  }
  const bead = lookup.byIssueNumber.get(filed.number);
  if (bead) return { ok: true, bdId: bead.id, ghNumber: filed.number };
  if (dryRun) return { ok: true, bdId: `(dry-run:${ref})`, ghNumber: filed.number };
  return {
    ok: false,
    reason: `slot '${ref}' filed as GH-${filed.number} but no beads row found yet (sync may be lagging)`,
  };
}

/**
 * Extract the GH issue number from a `gh issue create` URL of the form
 * `https://github.com/<owner>/<repo>/issues/<n>`.
 */
function extractIssueNumberFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const match = url.match(/\/issues\/(\d+)(?:[/?#].*)?$/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

export function runTriagePromoteChildren(
  opts: TriagePromoteChildrenOptions,
  output: Output,
  deps: TriagePromoteChildrenDeps = {},
): number {
  const read: ReadTextFile =
    deps.readFileSync ?? ((p, e) => defaultReadFileSync(p, e) as string);
  const write =
    deps.writeFileSyncFn ?? ((p, d) => writeFileSync(p, d, "utf8"));
  const exists = deps.existsSyncFn ?? existsSync;
  const intake = deps.runIntake ?? defaultRunIntake;
  const bdExec = deps.execBd ?? defaultExecBd;
  const run = deps.run ?? procRunner;
  const loadBeads = deps.loadAllBeads ?? loadAllBeads;
  const now = (deps.now ?? (() => new Date()))();
  const auditSink: AuditSinkDeps = {
    ...(deps.auditSink ?? {}),
    now: deps.auditSink?.now ?? (() => now),
  };

  const dir = resolvePath(opts.dir);
  const manifestPath = join(dir, "manifest.json");
  const filedPath = join(dir, ".filed.json");

  const manifest = loadManifest(manifestPath, read, output);
  if (!manifest) return 2;

  const filedState = loadFiledState(filedPath, read, exists);
  const filedBySlot = new Map<string, PromoteChildrenFiledRow>();
  for (const row of filedState.rows) filedBySlot.set(row.slot, row);

  const logPath = auditSinkPath(now, {
    stateDirOverride: auditSink.stateDirOverride,
    env: auditSink.env,
  });

  const writeAudit = (entry: PromoteChildrenAuditEntry): void => {
    if (opts.dryRun) return;
    appendAuditRow(entry, auditSink);
  };

  let bodies: PromoteChildBody[] = manifest.bodies;
  if (opts.only) {
    const slot = opts.only;
    bodies = bodies.filter((b) => b.slot === slot);
    if (bodies.length === 0) {
      output.error(
        `triage promote-children: --only ${slot} matched no bodies in manifest`,
      );
      return 1;
    }
  }
  if (opts.limit > 0) bodies = bodies.slice(0, opts.limit);

  let creates = 0;
  let skipsBody = 0;
  let bodyErrors = 0;

  for (const body of bodies) {
    const baseBody = {
      kind: "body" as const,
      ts: now.toISOString(),
      slot: body.slot,
      title: body.title,
      type: body.type,
      actor: "claude-code" as const,
      dryRun: opts.dryRun,
    };

    if (filedBySlot.has(body.slot)) {
      const prior = filedBySlot.get(body.slot)!;
      writeAudit({
        ...baseBody,
        action: "skip",
        issue: prior.number,
        url: prior.url,
        exitCode: 0,
      });
      output.log(`skip slot=${body.slot} (already filed as GH-${prior.number})`);
      skipsBody += 1;
      continue;
    }

    const bodyFile = resolvePath(dir, body.file);
    const intakeOpts: IntakeOptions = {
      type: body.type,
      title: body.title,
      ...(body.scope ? { scope: body.scope } : {}),
      bodyFile,
      bodyStdin: false,
      labels: [],
      assignees: [],
      dryRun: opts.dryRun,
      yes: true,
      format: "json",
    };

    if (opts.dryRun) {
      writeAudit({
        ...baseBody,
        action: "create",
        exitCode: 0,
      });
      output.log(
        `dry-run slot=${body.slot} type=${body.type} title=${body.title}`,
      );
      // Stamp a placeholder so dep resolution can preview slot→slot edges
      // without an actual GH-N. The placeholder never escapes dry-run mode.
      filedBySlot.set(body.slot, {
        slot: body.slot,
        number: 0,
        url: "(dry-run)",
      });
      creates += 1;
      continue;
    }

    const intakeStdout: string[] = [];
    const intakeStderr: string[] = [];
    const intakeOutput: Output = {
      log: (l) => intakeStdout.push(l),
      error: (l) => intakeStderr.push(l),
    };

    const exitCode = intake(intakeOpts, intakeOutput);
    const stderrJoined = intakeStderr.join("\n").trim();

    if (exitCode === 2 && /title prefix/i.test(stderrJoined)) {
      writeAudit({
        ...baseBody,
        action: "title-mismatch",
        exitCode,
        ...(stderrJoined ? { stderr: stderrJoined } : {}),
      });
      output.error(
        `title-mismatch slot=${body.slot}: ${stderrJoined || "intake refused title"}`,
      );
      bodyErrors += 1;
      continue;
    }

    if (exitCode !== 0) {
      writeAudit({
        ...baseBody,
        action: "error",
        exitCode,
        ...(stderrJoined ? { stderr: stderrJoined } : {}),
      });
      output.error(
        `error slot=${body.slot}: intake exit=${exitCode}${stderrJoined ? ` ${stderrJoined}` : ""}`,
      );
      bodyErrors += 1;
      continue;
    }

    let issueUrl: string | null = null;
    let issueNumber: number | null = null;
    try {
      const parsed = JSON.parse(intakeStdout.join("\n"));
      issueUrl =
        typeof parsed?.ghResult?.issueUrl === "string"
          ? parsed.ghResult.issueUrl
          : null;
      issueNumber = extractIssueNumberFromUrl(issueUrl);
    } catch {
      // Fall through — issueNumber stays null, treated as filing-failure below.
    }

    if (!issueUrl || issueNumber === null) {
      writeAudit({
        ...baseBody,
        action: "error",
        exitCode: 1,
        stderr: "intake succeeded but issueUrl was missing or unparseable",
      });
      output.error(
        `error slot=${body.slot}: intake succeeded but issueUrl was missing or unparseable`,
      );
      bodyErrors += 1;
      continue;
    }

    const filedRow: PromoteChildrenFiledRow = {
      slot: body.slot,
      number: issueNumber,
      url: issueUrl,
    };
    filedBySlot.set(body.slot, filedRow);
    filedState.rows.push(filedRow);
    writeFiledState(filedPath, filedState, write);
    writeAudit({
      ...baseBody,
      action: "create",
      issue: issueNumber,
      url: issueUrl,
      exitCode: 0,
    });
    output.log(`create slot=${body.slot} → GH-${issueNumber}`);
    creates += 1;
  }

  // Phase 2: resolve and wire dep edges. Re-load beads after filings so the
  // lookup sees rows that just-arrived via bd github sync (best-effort; for
  // sync-lag cases the resolver returns a `skip` reason and the audit row
  // records the gap so a re-run can retry). In dry-run we skip the bd read
  // entirely and feed the resolver an empty lookup — slot/GH-N refs fall
  // through to a synthetic `(dry-run:<ref>)` bd id used only for preview.
  let lookup: BeadsLookup;
  if (opts.dryRun) {
    lookup = buildBeadsLookup([]);
  } else {
    let beads: BeadsRecord[];
    try {
      beads = loadBeads(bdExec);
    } catch (err) {
      output.error(`triage promote-children: ${(err as Error).message}`);
      return 1;
    }
    lookup = buildBeadsLookup(beads);
  }

  let depsWired = 0;
  let depsSkipped = 0;
  let depsErrors = 0;

  for (const edge of manifest.deps) {
    const baseDep = {
      kind: "dep" as const,
      ts: now.toISOString(),
      depType: edge.type,
      from: edge.from,
      to: edge.to,
      actor: "claude-code" as const,
      dryRun: opts.dryRun,
    };

    if (opts.only) {
      // --only mode is a body-filter; deps stay manifest-wide but only fire
      // when both endpoints are addressable (filed in this run or literal).
      const isAddressable = (ref: string): boolean => {
        if (AI_HOME_REF_RE.test(ref) || GH_REF_RE.test(ref)) return true;
        return filedBySlot.has(ref);
      };
      if (!isAddressable(edge.from) || !isAddressable(edge.to)) {
        writeAudit({
          ...baseDep,
          action: "skip",
          exitCode: 0,
          stderr: `--only ${opts.only}: edge endpoint outside selected slot`,
        });
        depsSkipped += 1;
        continue;
      }
    }

    const fromResolved = resolveDepRef(edge.from, filedBySlot, lookup, opts.dryRun);
    const toResolved = resolveDepRef(edge.to, filedBySlot, lookup, opts.dryRun);

    if (!fromResolved.ok || !toResolved.ok) {
      const reason = !fromResolved.ok
        ? `from: ${fromResolved.reason}`
        : `to: ${(toResolved as { ok: false; reason: string }).reason}`;
      writeAudit({
        ...baseDep,
        action: "skip",
        exitCode: 0,
        stderr: reason,
      });
      output.log(
        `skip dep ${edge.type} ${edge.from}→${edge.to}: ${reason}`,
      );
      depsSkipped += 1;
      continue;
    }

    const fromBead = fromResolved.bdId;
    const toBead = toResolved.bdId;

    if (opts.dryRun) {
      writeAudit({
        ...baseDep,
        action: "wire",
        fromBead,
        toBead,
        exitCode: 0,
      });
      output.log(
        `dry-run dep ${edge.type} ${edge.from}(${fromBead})→${edge.to}(${toBead})`,
      );
      depsWired += 1;
      continue;
    }

    // GH-296 / prx-82b: wire the edge via the daemon (single writer).
    const result = run(
      ["prx", "beads", "dep", "add", "--type", edge.type, fromBead, toBead],
      { check: false },
    );
    if (result.status !== 0) {
      const stderr =
        result.stderr.trim() || result.stdout.trim() || "prx beads dep add failed";
      writeAudit({
        ...baseDep,
        action: "error",
        fromBead,
        toBead,
        exitCode: result.status,
        stderr,
      });
      output.error(
        `error dep ${edge.type} ${edge.from}→${edge.to}: ${stderr}`,
      );
      depsErrors += 1;
      continue;
    }
    writeAudit({
      ...baseDep,
      action: "wire",
      fromBead,
      toBead,
      exitCode: 0,
    });
    output.log(`wire dep ${edge.type} ${edge.from}(${fromBead})→${edge.to}(${toBead})`);
    depsWired += 1;
  }

  output.log(
    `triage promote-children: creates=${creates} skips=${skipsBody} body-errors=${bodyErrors} deps-wired=${depsWired} deps-skipped=${depsSkipped} deps-errors=${depsErrors}${
      opts.dryRun ? "" : ` log=${logPath}`
    }`,
  );

  if (opts.dryRun) return 0;
  return bodyErrors > 0 || depsErrors > 0 || depsSkipped > 0 ? 1 : 0;
}

/**
 * Actor-shaped entry. Captures stdout/stderr and audit rows so a future
 * machine-driven flow can read structured output without re-parsing logs.
 */
export type TriagePromoteChildrenActorResult = {
  exitCode: number;
  audit: PromoteChildrenAuditEntry[];
  stdout: string[];
  stderr: string[];
  filed: PromoteChildrenFiledRow[];
};

export function runPromoteChildrenActor(
  opts: TriagePromoteChildrenOptions,
  deps: TriagePromoteChildrenDeps = {},
): TriagePromoteChildrenActorResult {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const audit: PromoteChildrenAuditEntry[] = [];

  const upstreamAppend = deps.auditSink?.appendFn;
  const captureDeps: TriagePromoteChildrenDeps = {
    ...deps,
    auditSink: {
      ...(deps.auditSink ?? {}),
      appendFn: (path, line) => {
        try {
          audit.push(JSON.parse(line.trim()) as PromoteChildrenAuditEntry);
        } catch {
          // ignore non-JSON lines
        }
        upstreamAppend?.(path, line);
      },
    },
  };
  const captureOutput: Output = {
    log: (line) => stdout.push(line),
    error: (line) => stderr.push(line),
  };

  const exitCode = runTriagePromoteChildren(opts, captureOutput, captureDeps);

  const filed = audit
    .filter(
      (e): e is Extract<PromoteChildrenAuditEntry, { kind: "body" }> =>
        e.kind === "body" && e.action === "create" && !e.dryRun,
    )
    .map((e) => ({
      slot: e.slot,
      number: e.issue!,
      url: e.url!,
    }));

  return { exitCode, audit, stdout, stderr, filed };
}

/**
 * Re-export of the dep ref resolver for the unit tests. Kept private to the
 * module otherwise; resolution shape may evolve as we accept more ref forms.
 */
export const __test = { resolveDepRef, extractIssueNumberFromUrl };
