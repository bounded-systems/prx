// GH-2074 PR-3 / ai-home-udqx2.10 (.3.2) — per-unit CAS+TTL projection store.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deleteEnv, getEnv, setEnv } from "@bounded-systems/env";

import {
  digestOf,
  getUnit,
  invalidateUnit,
  projectionBypass,
  putUnit,
} from "../../src/pr-state/projection.ts";

type Snap = { issue: { number: number; state?: string | null } | null; beads: { id: string } | null };

const SCOPE = "repo-scope-abc";
const SNAP: Snap = { issue: { number: 2084, state: "OPEN" }, beads: { id: "ai-home-udqx2.10" } };

function refPath(dir: string): string {
  const refs = join(dir, "refs");
  const files = readdirSync(refs);
  return join(refs, files[0]!);
}

describe("projection store (per-unit CAS + TTL)", () => {
  let dir: string;
  let savedDisable: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prx-proj-"));
    savedDisable = getEnv("PRX_PROJECTION_DISABLE");
    deleteEnv("PRX_PROJECTION_DISABLE");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedDisable === undefined) deleteEnv("PRX_PROJECTION_DISABLE");
    else setEnv("PRX_PROJECTION_DISABLE", savedDisable);
  });

  test("put → get round-trips the snapshot", () => {
    putUnit(SCOPE, "ai-home-udqx2.10", SNAP, dir);
    expect(getUnit<Snap>(SCOPE, "ai-home-udqx2.10", dir)).toEqual(SNAP);
  });

  test("absent unit reads null (caller raises ProjectionMiss)", () => {
    expect(getUnit<Snap>(SCOPE, "never-hydrated", dir)).toBeNull();
  });

  test("a unit scoped to a different repo does not collide", () => {
    putUnit(SCOPE, "GH-1", SNAP, dir);
    expect(getUnit<Snap>("other-repo", "GH-1", dir)).toBeNull();
  });

  test("stale entry (past TTL) reads null", () => {
    putUnit(SCOPE, "ai-home-udqx2.10", SNAP, dir);
    // Backdate the ref's writtenAt to 10s ago; default TTL is 5s.
    const ref = JSON.parse(readFileSync(refPath(dir), "utf8"));
    ref.writtenAt = Date.now() - 10_000;
    writeFileSync(refPath(dir), JSON.stringify(ref));
    expect(getUnit<Snap>(SCOPE, "ai-home-udqx2.10", dir)).toBeNull();
    // A generous explicit TTL re-admits it (proves it was TTL, not corruption).
    expect(getUnit<Snap>(SCOPE, "ai-home-udqx2.10", dir, 60_000)).toEqual(SNAP);
  });

  test("content-addressed: same value → same sha + deduped blob", () => {
    const shaA = putUnit(SCOPE, "GH-1", SNAP, dir);
    const shaB = putUnit("other-repo", "GH-2", SNAP, dir); // same content, different unit
    expect(shaA).toBe(digestOf(SNAP));
    expect(shaB).toBe(shaA);
    const blobs = readdirSync(join(dir, "blobs"));
    expect(blobs.length).toBe(1); // one physical blob for identical content
  });

  test("CAS integrity: a tampered blob reads null (sha mismatch)", () => {
    const sha = putUnit(SCOPE, "GH-1", SNAP, dir);
    writeFileSync(join(dir, "blobs", `${sha}.json`), JSON.stringify({ issue: { number: 9999 }, beads: null }));
    expect(getUnit<Snap>(SCOPE, "GH-1", dir)).toBeNull();
  });

  test("invalidateUnit drops the entry → subsequent read null", () => {
    putUnit(SCOPE, "GH-1", SNAP, dir);
    invalidateUnit(SCOPE, "GH-1", dir);
    expect(getUnit<Snap>(SCOPE, "GH-1", dir)).toBeNull();
  });

  test("projectionBypass reflects the disable env knobs but does NOT kill reads", () => {
    putUnit(SCOPE, "GH-1", SNAP, dir);
    setEnv("PRX_PROJECTION_DISABLE", "1");
    expect(projectionBypass()).toBe(true);
    // The store is dumb and still reads: bypass tells the HYDRATOR to re-fetch
    // (always fresh), it is not a read kill-switch — so hydrate-then-read works.
    expect(getUnit<Snap>(SCOPE, "GH-1", dir)).toEqual(SNAP);
  });
});
