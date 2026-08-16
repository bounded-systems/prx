// dep-research per-run XState actors (GH-1275) — the fromPromise actor bodies
// and loadPrevSnapshot. Each actor is driven to completion through createActor
// with hermetic inputs: an injected fetcher, a tmp baseDir, and on-disk snapshot
// fixtures written via writeSnapshot. No real git/curl, no network.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createActor, type AnyActorLogic } from "xstate";

import {
  buildAndWriteSnapshotActor,
  fetchSourceActor,
  loadPrevAndDiffActor,
  loadPrevSnapshot,
} from "../../src/dep-research/actors.ts";
import { buildSnapshot, writeSnapshot } from "../../src/dep-research/snapshot.ts";
import type { DepManifestEntry } from "../../src/dep-research/schemas.ts";
import type { FetchResult } from "../../src/dep-research/fetch.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

// Drive a fromPromise actor to settlement and return its output (or throw).
function runActor<T>(logic: AnyActorLogic, input: unknown): Promise<T> {
  const actor = createActor(logic, { input } as never);
  return new Promise<T>((resolve, reject) => {
    actor.subscribe((s) => {
      if (s.status === "done") resolve(s.output as T);
      else if (s.status === "error") reject(s.error);
    });
    actor.start();
  });
}

const HINTS = { schema: [], state: [], cli: [], config: [] };

function gitEntry(): DepManifestEntry {
  return {
    name: "xstate",
    source: { kind: "git", url: "https://github.com/statelyai/xstate", paths: ["a.ts"] },
    classification_hints: HINTS,
  } as DepManifestEntry;
}

const snap = (dep: string, runId: string, content = "hello") =>
  buildSnapshot({
    dep,
    runId,
    fetchedAt: "2026-05-05T12:00:00.000Z",
    fetched: { "a.ts": Buffer.from(content, "utf8") },
    failures: {},
  });

// ── fetchSourceActor ────────────────────────────────────────────────────────

describe("fetchSourceActor", () => {
  test("delegates to the injected fetcher and returns its FetchResult", async () => {
    const fetched: FetchResult = { paths: { "a.ts": Buffer.from("x") }, failures: {} };
    const result = await runActor<FetchResult>(fetchSourceActor, {
      entry: gitEntry(),
      destDir: tmp("dra-fetch-"),
      fetcher: async () => fetched,
    });
    expect(result.paths["a.ts"]).toBeInstanceOf(Buffer);
    expect(result.failures).toEqual({});
  });
});

// ── buildAndWriteSnapshotActor ──────────────────────────────────────────────

describe("buildAndWriteSnapshotActor", () => {
  test("builds the snapshot and writes it under baseDir", async () => {
    const baseDir = tmp("dra-snap-");
    const result = await runActor<{ snapshot: { dep: string }; path: string }>(
      buildAndWriteSnapshotActor,
      {
        dep: "xstate",
        runId: "20260505T120000Z",
        fetchedAt: "2026-05-05T12:00:00.000Z",
        fetched: { "a.ts": Buffer.from("hello", "utf8") },
        failures: {},
        baseDir,
      },
    );
    expect(result.snapshot.dep).toBe("xstate");
    expect(result.path).toContain(join("xstate", "20260505T120000Z"));
  });
});

// ── loadPrevAndDiffActor ────────────────────────────────────────────────────

describe("loadPrevAndDiffActor", () => {
  test("loads the previous snapshot and diffs it against the current one", async () => {
    const baseDir = tmp("dra-diff-");
    const dep = "xstate";
    writeSnapshot(snap(dep, "20260101T000000Z", "old"), baseDir);
    const curr = snap(dep, "20260505T120000Z", "new");
    const delta = await runActor<{ dep: string }>(loadPrevAndDiffActor, {
      baseDir,
      dep,
      currSnapshot: curr,
      hints: HINTS,
    });
    expect(delta.dep).toBe(dep);
  });

  test("first-run-for-dep diffs against a null previous snapshot", async () => {
    const baseDir = tmp("dra-diff2-");
    const dep = "beads";
    const curr = snap(dep, "20260505T120000Z");
    const delta = await runActor<{ dep: string }>(loadPrevAndDiffActor, {
      baseDir,
      dep,
      currSnapshot: curr,
      hints: HINTS,
    });
    expect(delta.dep).toBe(dep);
  });
});

// ── loadPrevSnapshot (the exported fs helper) ───────────────────────────────

describe("loadPrevSnapshot", () => {
  test("returns null when the dep directory does not exist", () => {
    expect(loadPrevSnapshot(tmp("dra-none-"), "ghost", "20260505T120000Z")).toBeNull();
  });

  test("returns null when no run precedes the current run id", () => {
    const baseDir = tmp("dra-noprev-");
    writeSnapshot(snap("xstate", "20260505T120000Z"), baseDir);
    // Only run is the current one → nothing strictly-less precedes it.
    expect(loadPrevSnapshot(baseDir, "xstate", "20260505T120000Z")).toBeNull();
  });

  test("returns the lex-greatest run strictly less than the current id", () => {
    const baseDir = tmp("dra-prev-");
    const dep = "xstate";
    writeSnapshot(snap(dep, "20260101T000000Z", "a"), baseDir);
    writeSnapshot(snap(dep, "20260301T000000Z", "b"), baseDir);
    const prev = loadPrevSnapshot(baseDir, dep, "20260505T120000Z");
    expect(prev).not.toBeNull();
    expect(prev!.run_id).toBe("20260301T000000Z"); // the more recent of the two priors
  });

  test("ignores dotfiles and non-directory entries when picking the prior run", () => {
    const baseDir = tmp("dra-mixed-");
    const dep = "xstate";
    const depDir = join(baseDir, dep);
    mkdirSync(depDir, { recursive: true });
    writeSnapshot(snap(dep, "20260101T000000Z", "real"), baseDir);
    writeFileSync(join(depDir, "20260201T000000Z"), "i am a file, not a run dir");
    writeFileSync(join(depDir, ".hidden"), "x");
    const prev = loadPrevSnapshot(baseDir, dep, "20260505T120000Z");
    expect(prev!.run_id).toBe("20260101T000000Z"); // the file/dotfile are skipped
  });

  test("a broken symlink entry is skipped (statSync throws → filtered out)", () => {
    const baseDir = tmp("dra-symlink-");
    const dep = "xstate";
    const depDir = join(baseDir, dep);
    mkdirSync(depDir, { recursive: true });
    writeSnapshot(snap(dep, "20260101T000000Z", "real"), baseDir);
    // A dangling symlink — statSync follows it and throws ENOENT.
    symlinkSync(join(depDir, "does-not-exist"), join(depDir, "20260201T000000Z"));
    const prev = loadPrevSnapshot(baseDir, dep, "20260505T120000Z");
    expect(prev!.run_id).toBe("20260101T000000Z");
  });

  test("returns null when the prior run dir has no snapshot.json", () => {
    const baseDir = tmp("dra-nofile-");
    const dep = "xstate";
    mkdirSync(join(baseDir, dep, "20260101T000000Z"), { recursive: true });
    expect(loadPrevSnapshot(baseDir, dep, "20260505T120000Z")).toBeNull();
  });
});
