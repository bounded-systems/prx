// GH-1768 — `prx derive <verb>` handler.
//
// Verbs:
//   ready                — list ready units
//   drift                — list drifted chains with the violated invariant
//   eligible [<issue>]   — which actors are eligible
//   why <relation> [<arg> ...] — provenance tree for any derived fact
//   dump-facts [--issue <id>]  — emit projected fact set as JSONL
//
// The handler is read-only with respect to the workflow machine. It
// emits three observability events (DERIVE_FACTS_PROJECTED,
// DERIVE_QUERY_RUN, DERIVE_TRACE_EMITTED) through the existing audit
// sink path — no machine-event emits, no mutating verbs.
//
// Input mode is selected by the presence of `--fixture <path>`:
//   - `--fixture <path>` (`fixturePath` set) — deterministic opt-in.
//     Reads a JSON fixture from disk (the original v0 demo path; kept
//     verbatim as the regression net for the engine tests).
//   - default (no `--fixture`) — live mode. Reads `RawStateV1` for the
//     current unit via `buildDomainState`, all beads via `loadAllBeads`,
//     and the transition log from `.prx/transitions.jsonl`. Synthetic
//     inputs (`actorAllowedInPhase`, `scopeOwns`, `changedTree`) have
//     no live producer — they stay empty, so the `eligibility` and
//     `cache_scope` rules are silently empty in live mode. The promote
//     ticket (GH-1809 / ai-home-jyvxo) narrows scope to `why`; other
//     verbs run but see only the current unit's projection.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  allRules,
  projectAndRun,
  queryDrift,
  queryEligible,
  queryReady,
  queryWhy,
  type DerivedView,
} from "./index.ts";
import { factColumns, type FactRelation } from "./schemas/relations.ts";
import { parseRawStateV1 } from "@bounded-systems/machine-schema";
import { evaluate, factKey, type Constant, type Fact } from "./engine.ts";
import {
  projectFacts,
  type BeadsEntry,
  type ProjectInput,
  type SyntheticInputs,
  type TransitionEntryLite,
} from "./project.ts";
import { formatDerivationTree } from "./rules/provenance.ts";
import { buildDomainState as defaultBuildDomainState } from "../pr-state/domain_state.ts";
import { readTransitionLog as defaultReadTransitionLog } from "../pr-state/transition_log.ts";
import { loadAllBeads as defaultLoadAllBeads, type BeadsRecord } from "../triage/triage.ts";

export type DeriveVerb = "ready" | "drift" | "eligible" | "why" | "dump-facts";

const fixtureSchema = z
  .object({
    rawStates: z.array(z.unknown().transform(parseRawStateV1)).default([]),
    beads: z
      .array(
        z
          .object({
            id: z.string(),
            open: z.boolean(),
            closed: z.boolean(),
            blockedBy: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .default([]),
    transitions: z
      .array(
        z
          .object({
            id: z.string(),
            issueId: z.string().nullable(),
            fromState: z.string(),
            toState: z.string(),
            actor: z.string(),
            timestamp: z.string(),
          })
          .strict(),
      )
      .default([]),
    synthetic: z
      .object({
        actorAllowedInPhase: z
          .array(z.object({ actor: z.string(), phase: z.string() }).strict())
          .default([]),
        scopeOwns: z.array(z.object({ scope: z.string(), tree: z.string() }).strict()).default([]),
        changedTree: z.array(z.object({ sha: z.string(), tree: z.string() }).strict()).default([]),
      })
      .partial()
      .optional(),
  })
  .strict();

export type DeriveCliInput = {
  verb: DeriveVerb;
  fixturePath?: string | undefined;
  /** Live-mode repo root. Defaults to `process.cwd()` when absent. */
  repoPath?: string | undefined;
  args: string[];
  issueFilter?: string | undefined;
  format: "json" | "jsonl" | "tree" | "table";
};

export type DeriveCliOutput = {
  log: (line: string) => void;
  error: (line: string) => void;
  /** Optional emit hook for the observability events. Tests inject. */
  emit?: (event: DeriveEmitEvent) => void;
};

/**
 * Live-mode producer injection slot. Mirrors the `buildDomainState?:` deps
 * pattern at `src/pr-state/cli.ts:2094` so tests can supply fixed
 * `RawStateV1` / beads / transitions without touching disk or the network.
 */
export type DeriveCliDeps = {
  buildDomainState?: typeof defaultBuildDomainState;
  loadAllBeads?: typeof defaultLoadAllBeads;
  readTransitionLog?: typeof defaultReadTransitionLog;
};

export type DeriveEmitEvent =
  | { type: "DERIVE_FACTS_PROJECTED"; factCount: number }
  | { type: "DERIVE_QUERY_RUN"; verb: DeriveVerb; resultCount: number }
  | { type: "DERIVE_TRACE_EMITTED"; goal: string };

export class DeriveCliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode = 65,
  ) {
    super(message);
    this.name = "DeriveCliError";
  }
}

function loadFixture(path: string): ProjectInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new DeriveCliError(
      "BAD_FIXTURE",
      `failed to read fixture ${path}: ${(err as Error).message}`,
      64,
    );
  }
  const v = fixtureSchema.parse(parsed);
  const beads: BeadsEntry[] = (v.beads ?? []).map((b) => ({
    id: b.id,
    open: b.open,
    closed: b.closed,
    blockedBy: b.blockedBy ?? [],
  }));
  const transitions: TransitionEntryLite[] = v.transitions ?? [];
  const synthetic: SyntheticInputs = {
    actorAllowedInPhase: v.synthetic?.actorAllowedInPhase ?? [],
    scopeOwns: v.synthetic?.scopeOwns ?? [],
    changedTree: v.synthetic?.changedTree ?? [],
  };
  return { rawStates: v.rawStates ?? [], beads, transitions, synthetic };
}

// Mirrors `TRANSITION_LOG_REL_PATH` at `src/pr-state/next_work.ts:132`.
// Inlined here to match the existing `cli.ts:4373/6085/6137` pattern and
// avoid expanding scope into a transition_log.ts export refactor.
const TRANSITION_LOG_REL_PATH = ".prx/transitions.jsonl";

function loadLive(repoPath: string, deps: DeriveCliDeps): ProjectInput {
  const buildDomainState = deps.buildDomainState ?? defaultBuildDomainState;
  const loadAllBeads = deps.loadAllBeads ?? defaultLoadAllBeads;
  const readTransitionLog = deps.readTransitionLog ?? defaultReadTransitionLog;

  const domain = buildDomainState(repoPath);
  const allBeads = loadAllBeads();
  const beads = beadsRecordsToEntries(allBeads);
  const transitions = readTransitionLog(join(repoPath, TRANSITION_LOG_REL_PATH)).map((t) => ({
    id: t.id,
    issueId: t.issue,
    fromState: t.state_from,
    toState: t.state_to,
    actor: t.actor,
    timestamp: t.timestamp,
  }));
  return {
    rawStates: [domain.rawState],
    beads,
    transitions,
    // No live producers exist for these — see file-header note.
    synthetic: { actorAllowedInPhase: [], scopeOwns: [], changedTree: [] },
  };
}

function beadsRecordsToEntries(records: BeadsRecord[]): BeadsEntry[] {
  // Build a reverse index: for each issue, the set of issues that block it.
  // bd's outgoing edges live on the blocker (`issueId blocks dependsOnId`),
  // so `blockedBy[X]` = `{r.id : r.dependencies has {dependsOnId:X, type:"blocks"}}`.
  const blockerIndex = new Map<string, Set<string>>();
  for (const r of records) {
    for (const d of r.dependencies ?? []) {
      if (d.type !== "blocks") continue;
      let set = blockerIndex.get(d.dependsOnId);
      if (!set) {
        set = new Set();
        blockerIndex.set(d.dependsOnId, set);
      }
      set.add(d.issueId);
    }
  }
  return records.map((r) => {
    const closed = r.status === "closed";
    return {
      id: r.id,
      open: !closed,
      closed,
      blockedBy: [...(blockerIndex.get(r.id) ?? [])],
    };
  });
}

function emitEvent(out: DeriveCliOutput, event: DeriveEmitEvent): void {
  out.emit?.(event);
}

function parseLiteral(s: string): Constant {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

export function runDeriveCli(
  input: DeriveCliInput,
  out: DeriveCliOutput,
  deps: DeriveCliDeps = {},
): number {
  const project = input.fixturePath
    ? loadFixture(input.fixturePath)
    : loadLive(input.repoPath ?? process.cwd(), deps);
  const { edb, view } = projectAndRun(project, { rules: allRules });
  emitEvent(out, { type: "DERIVE_FACTS_PROJECTED", factCount: edb.length });

  switch (input.verb) {
    case "ready":
      return handleReady(view, input, out);
    case "drift":
      return handleDrift(view, input, out);
    case "eligible":
      return handleEligible(view, input, out);
    case "why":
      return handleWhy(view, input, out);
    case "dump-facts":
      return handleDumpFacts(view, edb, input, out);
  }
}

function handleReady(view: DerivedView, input: DeriveCliInput, out: DeriveCliOutput): number {
  const rows = queryReady(view).filter(
    (r) => !input.issueFilter || r.issueId === input.issueFilter,
  );
  emitEvent(out, { type: "DERIVE_QUERY_RUN", verb: "ready", resultCount: rows.length });
  if (input.format === "json") {
    out.log(JSON.stringify({ ready: rows }, null, 2));
  } else {
    for (const r of rows) out.log(r.issueId);
  }
  return 0;
}

function handleDrift(view: DerivedView, input: DeriveCliInput, out: DeriveCliOutput): number {
  const rows = queryDrift(view).filter(
    (r) => !input.issueFilter || r.issueId === input.issueFilter,
  );
  emitEvent(out, { type: "DERIVE_QUERY_RUN", verb: "drift", resultCount: rows.length });
  if (input.format === "json") {
    out.log(JSON.stringify({ drift: rows }, null, 2));
  } else {
    for (const r of rows) out.log(`${r.issueId}\t${r.code}`);
  }
  return 0;
}

function handleEligible(view: DerivedView, input: DeriveCliInput, out: DeriveCliOutput): number {
  const issueId = input.args[0] ?? input.issueFilter;
  const rows = queryEligible(view, issueId);
  emitEvent(out, { type: "DERIVE_QUERY_RUN", verb: "eligible", resultCount: rows.length });
  if (input.format === "json") {
    out.log(JSON.stringify({ eligible: rows }, null, 2));
  } else {
    for (const r of rows) out.log(`${r.actor}\t${r.issueId}`);
  }
  return 0;
}

function handleWhy(view: DerivedView, input: DeriveCliInput, out: DeriveCliOutput): number {
  const [relation, ...rest] = input.args;
  if (!relation) {
    throw new DeriveCliError(
      "MISSING_GOAL",
      "derive why requires <relation> <arg>... (e.g., `prx derive why ready GH-1768`)",
      64,
    );
  }
  const cols = (factColumns as Record<string, readonly string[]>)[relation];
  if (cols && rest.length !== cols.length) {
    throw new DeriveCliError(
      "ARITY_MISMATCH",
      `relation ${relation} takes ${cols.length} args; got ${rest.length}`,
      64,
    );
  }
  const args = rest.map(parseLiteral);
  const goal: Fact = { relation, args };
  const tree = queryWhy(view, goal);
  emitEvent(out, { type: "DERIVE_QUERY_RUN", verb: "why", resultCount: tree ? 1 : 0 });
  if (!tree) {
    out.error(`derive why: ${factKey(goal)} not derived`);
    return 65;
  }
  emitEvent(out, { type: "DERIVE_TRACE_EMITTED", goal: factKey(goal) });
  if (input.format === "json") {
    out.log(JSON.stringify(tree, null, 2));
  } else {
    out.log(formatDerivationTree(tree));
  }
  return 0;
}

function handleDumpFacts(
  view: DerivedView,
  edb: Fact[],
  input: DeriveCliInput,
  out: DeriveCliOutput,
): number {
  const all = view.facts.all().filter((f) => {
    if (!input.issueFilter) return true;
    return f.args.includes(input.issueFilter);
  });
  emitEvent(out, { type: "DERIVE_QUERY_RUN", verb: "dump-facts", resultCount: all.length });
  if (input.format === "json") {
    const grouped: Record<string, Fact[]> = {};
    for (const f of all) {
      if (!grouped[f.relation]) grouped[f.relation] = [];
      grouped[f.relation]!.push(f);
    }
    out.log(
      JSON.stringify(
        {
          edb: edb.length,
          relations: Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length])),
          facts: all,
        },
        null,
        2,
      ),
    );
  } else {
    for (const f of all) out.log(factKey(f));
  }
  return 0;
}

// Surface the engine + rule entry points for non-CLI consumers (tests,
// future actor registrations) without round-tripping through argv.
export { allRules, evaluate, projectAndRun, projectFacts, type DerivedView };
