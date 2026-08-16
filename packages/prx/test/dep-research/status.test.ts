// GH-1275 (PR-3 of GH-1261): `loadDepStatus` happy path + missing-dir +
// single-run cases.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDepStatus } from "../../src/dep-research/status.ts";
import type { DepSnapshot } from "../../src/dep-research/schemas.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "dep-status-"));
}

function writeManifest(root: string): void {
  mkdirSync(join(root, ".prx", "dep-research"), { recursive: true });
  writeFileSync(
    join(root, ".prx", "dep-research", "manifest.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          name: "xstate",
          source: {
            kind: "git",
            url: "https://github.com/statelyai/xstate",
            paths: ["packages/core/src/types.ts"],
          },
          classification_hints: {
            schema: ["types\\.ts$"],
            state: [],
            cli: [],
            config: [],
          },
        },
      ],
    }),
    "utf8",
  );
}

function writeSnap(
  root: string,
  dep: string,
  runId: string,
  shas: Record<string, string>,
  runState: "ok" | "failed" = "ok",
): DepSnapshot {
  const dir = join(root, ".prx", "dep-research", dep, runId);
  mkdirSync(dir, { recursive: true });
  const byteLen: Record<string, number> = {};
  for (const k of Object.keys(shas)) byteLen[k] = 1;
  const snap: DepSnapshot = {
    dep,
    run_id: runId,
    fetched_at: "2026-05-05T12:00:00.000Z",
    source_sha256: shas,
    source_byte_len: byteLen,
    run_state: runState,
  };
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify(snap, null, 2));
  return snap;
}

describe("loadDepStatus", () => {
  test("never run: dep with no snapshot dir reports run_state 'never'", () => {
    const root = makeRepo();
    writeManifest(root);
    const rows = loadDepStatus(root);
    expect(rows).toEqual([
      {
        dep: "xstate",
        last_run_id: null,
        prev_run_id: null,
        fetched_at: null,
        run_state: "never",
        classification: null,
      },
    ]);
  });

  test("single run: classification computed against null prev (every path added)", () => {
    const root = makeRepo();
    writeManifest(root);
    writeSnap(root, "xstate", "20260102T000000Z", {
      "packages/core/src/types.ts": SHA_A,
    });
    const rows = loadDepStatus(root);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.dep).toBe("xstate");
    expect(row.last_run_id).toBe("20260102T000000Z");
    expect(row.prev_run_id).toBeNull();
    expect(row.run_state).toBe("ok");
    // First-run added path matches the schema hint => classification "schema".
    expect(row.classification).toBe("schema");
  });

  test("two runs: classification reads from diff(prev, curr)", () => {
    const root = makeRepo();
    writeManifest(root);
    writeSnap(root, "xstate", "20260101T000000Z", {
      "packages/core/src/types.ts": SHA_A,
    });
    writeSnap(root, "xstate", "20260102T000000Z", {
      "packages/core/src/types.ts": SHA_B,
    });
    const rows = loadDepStatus(root);
    const row = rows[0]!;
    expect(row.last_run_id).toBe("20260102T000000Z");
    expect(row.prev_run_id).toBe("20260101T000000Z");
    expect(row.classification).toBe("schema");
  });

  test("two runs with identical content classify as 'none'", () => {
    const root = makeRepo();
    writeManifest(root);
    writeSnap(root, "xstate", "20260101T000000Z", {
      "packages/core/src/types.ts": SHA_A,
    });
    writeSnap(root, "xstate", "20260102T000000Z", {
      "packages/core/src/types.ts": SHA_A,
    });
    const rows = loadDepStatus(root);
    expect(rows[0]!.classification).toBe("none");
  });

  test("failed last snapshot surfaces run_state 'failed'", () => {
    const root = makeRepo();
    writeManifest(root);
    writeSnap(root, "xstate", "20260102T000000Z", {}, "failed");
    const rows = loadDepStatus(root);
    expect(rows[0]!.run_state).toBe("failed");
  });
});
