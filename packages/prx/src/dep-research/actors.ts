// XState `fromPromise` actors for the dep-research per-run machine
// (GH-1275, PR-3 of GH-1261).
//
// Mirrors src/triage/actors.ts: each actor wraps a Zod-validated input shape
// and delegates to the real PR-2 primitives (fetch / snapshot + write) or the
// PR-3 pure helper (diff). Tests swap actors via `depResearchMachine.provide(
// { actors })` rather than mocking module internals.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { fromPromise } from "xstate";
import { z } from "zod";

import { diffSnapshots } from "./diff.ts";
import {
  defaultFetchSource,
  fetchSources,
  type FetchResult,
  type FetchSourceFn,
} from "./fetch.ts";
import {
  DepClassificationHints,
  DepDelta,
  DepManifestEntry,
  DepSnapshot,
} from "./schemas.ts";
import { buildSnapshot, writeSnapshot } from "./snapshot.ts";

// ── fetch actor ────────────────────────────────────────────────────────────

const fetchInputDataSchema = z.object({
  entry: DepManifestEntry,
  destDir: z.string().min(1),
});

export type FetchSourceActorInput = z.infer<typeof fetchInputDataSchema> & {
  /**
   * Injected fetcher. Defaults to `defaultFetchSource()` when omitted, but
   * the per-run machine forwards the operator-provided fetcher so the
   * GH-1245 fetch-actor swap is a one-line change at the call site.
   */
  fetcher?: FetchSourceFn | undefined;
};

export const fetchSourceActor = fromPromise<FetchResult, FetchSourceActorInput>(
  async ({ input }) => {
    const data = fetchInputDataSchema.parse({
      entry: input.entry,
      destDir: input.destDir,
    });
    const fetcher = input.fetcher ?? defaultFetchSource();
    return fetchSources(data.entry, data.destDir, fetcher);
  },
);

// ── snapshot+write actor ───────────────────────────────────────────────────

const buildAndWriteInputSchema = z.object({
  dep: z.string().min(1),
  runId: z.string().min(1),
  fetchedAt: z.string().datetime(),
  fetched: z.record(z.string().min(1), z.instanceof(Buffer)),
  failures: z.record(z.string().min(1), z.string()),
  baseDir: z.string().min(1),
});

export type BuildAndWriteSnapshotActorInput = z.infer<
  typeof buildAndWriteInputSchema
>;

export type BuildAndWriteSnapshotActorResult = {
  snapshot: DepSnapshot;
  path: string;
};

export const buildAndWriteSnapshotActor = fromPromise<
  BuildAndWriteSnapshotActorResult,
  BuildAndWriteSnapshotActorInput
>(async ({ input }) => {
  const opts = buildAndWriteInputSchema.parse(input);
  const snapshot = buildSnapshot({
    dep: opts.dep,
    runId: opts.runId,
    fetchedAt: opts.fetchedAt,
    fetched: opts.fetched,
    failures: opts.failures,
  });
  const path = writeSnapshot(snapshot, opts.baseDir);
  return { snapshot, path };
});

// ── load-prev-and-diff actor ───────────────────────────────────────────────

const loadPrevAndDiffInputSchema = z.object({
  baseDir: z.string().min(1),
  dep: z.string().min(1),
  currSnapshot: DepSnapshot,
  hints: DepClassificationHints,
});

export type LoadPrevAndDiffActorInput = z.infer<
  typeof loadPrevAndDiffInputSchema
>;

export const loadPrevAndDiffActor = fromPromise<
  DepDelta,
  LoadPrevAndDiffActorInput
>(async ({ input }) => {
  const opts = loadPrevAndDiffInputSchema.parse(input);
  const prev = loadPrevSnapshot(opts.baseDir, opts.dep, opts.currSnapshot.run_id);
  return diffSnapshots(prev, opts.currSnapshot, opts.hints);
});

/**
 * Locate the snapshot of the run immediately preceding `currRunId` for a
 * given dep, parsing it through the boundary schema. Returns `null` when
 * no prior run exists (first-run-for-dep case).
 *
 * Run-id format from `formatRunId` is `YYYYMMDDTHHMMSSZ`, which is
 * lexicographically sortable; "previous" = the lex-greatest run-id strictly
 * less than `currRunId`.
 */
export function loadPrevSnapshot(
  baseDir: string,
  dep: string,
  currRunId: string,
): DepSnapshot | null {
  const depDir = join(baseDir, dep);
  let entries: string[];
  try {
    entries = readdirSync(depDir);
  } catch {
    return null;
  }
  const runIds = entries
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(join(depDir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .filter((name) => name < currRunId)
    .sort();
  const prevRunId = runIds.at(-1);
  if (!prevRunId) return null;

  const snapshotPath = join(depDir, prevRunId, "snapshot.json");
  let raw: string;
  try {
    raw = readFileSync(snapshotPath, "utf8");
  } catch {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  return DepSnapshot.parse(parsed);
}
