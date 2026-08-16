// CLI surface for `prx scout read --provenance` / `--ledger` (the provenance
// wiring over src/scout/provenance.ts). Spawns the real entrypoint so the parse
// → dispatch → ledger path matches production.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openAnchoredChain } from "@bounded-systems/anchored-chain-sqlite";
import type { Digest } from "@bounded-systems/anchored-chain";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = join(repoRoot, "scripts/pr_state.ts");

function runCli(args: string[], cwd: string) {
  const r = Bun.spawnSync({
    cmd: ["bun", "run", scriptPath, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

function makeRepo(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "scout-read-cli-"));
  const file = join(dir, "note.md");
  writeFileSync(file, "# title\n\nbody line\n");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("prx scout read --provenance", () => {
  test("emits a SLSA Provenance v1 statement bound to the read", () => {
    const { dir, file, cleanup } = makeRepo();
    try {
      const res = runCli(["scout", "read", file, "--provenance"], dir);
      expect(res.code).toBe(0);
      const stmt = JSON.parse(res.stdout);
      expect(stmt.predicateType).toBe("https://slsa.dev/provenance/v1");
      expect(stmt.subject[0].name).toBe("envelope");
      // The lone resolved dependency is the source file's content digest.
      const dep = stmt.predicate.buildDefinition.resolvedDependencies[0];
      expect(dep.name).toBe("source");
      expect(dep.digest.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(stmt.predicate.buildDefinition.externalParameters.path).toBe(file);
    } finally {
      cleanup();
    }
  });
});

describe("prx scout read --ledger", () => {
  test("records the read as a derivation while still emitting the envelope", async () => {
    const { dir, file, cleanup } = makeRepo();
    const ledger = join(dir, "ledger.db");
    try {
      const res = runCli(["scout", "read", file, "--ledger", ledger], dir);
      expect(res.code).toBe(0);
      // stdout is still the read envelope (recording is a side effect).
      const envelope = JSON.parse(res.stdout);
      expect(envelope.path).toBe(file);
      expect(envelope.sha256).toMatch(/^[0-9a-f]{64}$/);

      // The derivation landed in the ledger: descendants of the file's content
      // digest include the recorded read.
      const store = openAnchoredChain(ledger);
      try {
        const consumers = await store.invalidate.descendants(`sha256:${envelope.sha256}` as Digest);
        expect(consumers.length).toBe(1);
      } finally {
        store.close();
      }
    } finally {
      cleanup();
    }
  });
});
