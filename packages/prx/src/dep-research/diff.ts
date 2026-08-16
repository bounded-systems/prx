// dep-research diff (GH-1275, PR-3 of GH-1261).
//
// Pure: no IO, no clock, no randomness. Compares two snapshots of the same
// dep and classifies the delta on the schema > state > cli > config > breaking
// axis. PR-4 will fill `excerpt` from CAS-stored bytes; here it is empty.
//
// Per memory `reference_zod_boundary_layer`, the result is round-tripped
// through `DepDelta.parse` so callers can rely on the boundary contract.

import {
  DepDelta,
  type DepClassification,
  type DepClassificationHints,
  type DepDeltaChange,
  type DepSnapshot,
} from "./schemas.ts";

/**
 * Axis precedence for the aggregate classification. The leftmost axis hit by
 * any change wins; `breaking` is the bucket for changes that don't match any
 * declared hint (or for changes when the hint set is entirely empty).
 */
const AXIS_PRECEDENCE = ["schema", "state", "cli", "config", "breaking"] as const;
type Axis = (typeof AXIS_PRECEDENCE)[number];

/**
 * Compute the delta between two dep snapshots. `prev` is `null` on the very
 * first run for a dep — every path in `curr` surfaces as `added`.
 */
export function diffSnapshots(
  prev: DepSnapshot | null,
  curr: DepSnapshot,
  hints: DepClassificationHints,
): DepDelta {
  const prevShas = prev?.source_sha256 ?? {};
  const currShas = curr.source_sha256;
  const compiled = compileHints(hints);

  const changes: DepDeltaChange[] = [];
  const seen = new Set<string>();

  for (const path of Object.keys(currShas).sort()) {
    seen.add(path);
    const prevSha = prevShas[path];
    const currSha = currShas[path]!;
    if (prevSha === undefined) {
      changes.push({ path, kind: "added", excerpt: "" });
    } else if (prevSha !== currSha) {
      changes.push({ path, kind: "modified", excerpt: "" });
    }
  }
  for (const path of Object.keys(prevShas).sort()) {
    if (seen.has(path)) continue;
    changes.push({ path, kind: "removed", excerpt: "" });
  }

  let aggregateRank: number = AXIS_PRECEDENCE.length;
  for (const change of changes) {
    const axis = classifyPath(change.path, compiled);
    const rank = AXIS_PRECEDENCE.indexOf(axis);
    if (rank < aggregateRank) aggregateRank = rank;
    if (aggregateRank === 0) break;
  }

  const classification: DepClassification =
    changes.length === 0 ? "none" : AXIS_PRECEDENCE[aggregateRank]!;

  return DepDelta.parse({
    dep: curr.dep,
    prev_run_id: prev?.run_id ?? null,
    curr_run_id: curr.run_id,
    classification,
    changes,
  });
}

type CompiledHints = {
  schema: RegExp[];
  state: RegExp[];
  cli: RegExp[];
  config: RegExp[];
};

function compileHints(hints: DepClassificationHints): CompiledHints {
  return {
    schema: hints.schema.map((src) => new RegExp(src)),
    state: hints.state.map((src) => new RegExp(src)),
    cli: hints.cli.map((src) => new RegExp(src)),
    config: hints.config.map((src) => new RegExp(src)),
  };
}

function classifyPath(path: string, compiled: CompiledHints): Axis {
  if (compiled.schema.some((re) => re.test(path))) return "schema";
  if (compiled.state.some((re) => re.test(path))) return "state";
  if (compiled.cli.some((re) => re.test(path))) return "cli";
  if (compiled.config.some((re) => re.test(path))) return "config";
  return "breaking";
}
