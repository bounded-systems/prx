/**
 * prx-pe1 (slice 4b): the implement artifact — `prx implement agent` pins what it
 * produced (`<unit>:implement@latest`) instead of leaving a bare git commit.
 *
 * The artifact is keyed by the COMMIT (ground truth), which joins to the signed
 * `checks/v1` attestation (prx-ux2) by subject — so verification is an
 * attestation lookup, not a self-reported boolean. These tests are the contract:
 * a clean run pins the commit + files; a bad commit is rejected by the contract
 * and not pinned; a run with no commit pins nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { consumeArtifact } from "../../src/pipeline/edge.ts";
import {
  captureImplementArtifact,
  finalizeImplementRun,
  implementArtifactEdge,
} from "../../src/pipeline/implement-artifact.ts";

const COMMIT = "1234567890abcdef1234567890abcdef12345678";

let prevRoot: string | undefined;
beforeAll(() => {
  prevRoot = process.env.PRX_CAS_ROOT;
  process.env.PRX_CAS_ROOT = mkdtempSync(join(tmpdir(), "prx-implement-artifact-"));
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.PRX_CAS_ROOT;
  else process.env.PRX_CAS_ROOT = prevRoot;
});

describe("implement artifact (prx-pe1 slice 4b)", () => {
  test("captureImplementArtifact pins <unit>:implement@latest, joinable by commit", async () => {
    const { ref, diagnostics } = await captureImplementArtifact({
      unit: "prx-0v5",
      commit: COMMIT,
      summary: "Updated the README.",
      filesChanged: ["README.md"],
    });
    expect(diagnostics).toEqual([]);
    expect(ref).toBe("prx-0v5:implement@latest");

    const got = await consumeArtifact(implementArtifactEdge, "prx-0v5");
    expect(got.value).toEqual({
      unit: "prx-0v5",
      commit: COMMIT,
      summary: "Updated the README.",
      files_changed: ["README.md"],
    });
  });

  test("a non-sha commit is rejected by the contract and NOT pinned", async () => {
    const { ref, diagnostics } = await captureImplementArtifact({
      unit: "prx-bad",
      commit: "not-a-sha",
      summary: "x",
      filesChanged: [],
    });
    // The schema's 40-hex regex catches it first → schema-invalid; either way
    // the contract rejects and nothing is pinned.
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(ref).toBe("");
  });

  test("finalizeImplementRun resolves HEAD + files, attests checks, pins the artifact", async () => {
    const attested: string[] = [];
    const result = await finalizeImplementRun(
      { unit: "prx-fin", summary: "did the work", cwd: "/repo" },
      {
        resolveHead: () => COMMIT,
        listChangedFiles: () => ["a.ts", "b.ts"],
        attestChecks: async (_cwd, commit) => {
          attested.push(commit);
          return true;
        },
      },
    );
    expect(result.ref).toBe("prx-fin:implement@latest");
    expect(result.checksAttested).toBe(true);
    expect(attested[0]).toBe(COMMIT); // checks attested against the produced commit
    expect(result.artifact?.files_changed).toEqual(["a.ts", "b.ts"]);
  });

  test("finalizeImplementRun pins the artifact even when attestChecks THROWS (prx-pl3)", async () => {
    // The commit record is primary; a checks failure (bun absent, ledger hiccup)
    // must never lose the implement link.
    const result = await finalizeImplementRun(
      { unit: "prx-checkfail", summary: "did it", cwd: "/repo" },
      {
        resolveHead: () => COMMIT,
        listChangedFiles: () => ["a.ts"],
        attestChecks: async () => {
          throw new Error("bun: command not found");
        },
      },
    );
    expect(result.ref).toBe("prx-checkfail:implement@latest");
    expect(result.checksAttested).toBe(false);
    expect(result.artifact?.commit).toBe(COMMIT);
  });

  test("finalizeImplementRun pins nothing when the run produced no commit", async () => {
    const result = await finalizeImplementRun(
      { unit: "prx-nocommit", summary: "", cwd: "/repo" },
      {
        resolveHead: () => null,
        listChangedFiles: () => [],
      },
    );
    expect(result.ref).toBe("");
    expect(result.artifact).toBeNull();
    expect(result.checksAttested).toBe(false);
  });

  test("finalizeImplementRun still pins the artifact when no attestChecks seam is given", async () => {
    // No signer/ledger configured → checks aren't attested here, but the
    // artifact (the commit) is still recorded; absence of a checks/v1 for the
    // commit is the downstream 'not verified' signal.
    const result = await finalizeImplementRun(
      { unit: "prx-noattest", summary: "s", cwd: "/repo" },
      {
        resolveHead: () => COMMIT,
        listChangedFiles: () => ["x.ts"],
      },
    );
    expect(result.ref).toBe("prx-noattest:implement@latest");
    expect(result.checksAttested).toBe(false);
  });
});
