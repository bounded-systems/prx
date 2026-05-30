import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const monoRoot = resolve(repoRoot, "..", "..");
const scriptsDir = join(monoRoot, "skills/security-ownership-map/scripts");
const tsBuild = join(scriptsDir, "build_ownership_map.ts");
const fixtures = join(repoRoot, "test/scripts/fixtures/build_ownership_map");

/**
 * M2.4/M2.5 (functional-ripple): port build_ownership_map.py -> .ts.
 *
 * PYTHON-FREE golden test. The goldens were captured from the TS impl and
 * verified byte-identical to python (the now-merged parity proof). The wall
 * clock is pinned via SOM_FAKE_NOW so recency_weight + summary.generated_at are
 * deterministic; the only env-specific field (summary.repo, a temp abspath) is
 * masked. The fixture history is fixed, so every artifact is reproducible.
 */

const FAKE_NOW = "2026-06-01T12:00:00+00:00";
let gitRepo: string;
let outDir: string;

function sh(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  return Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
}
function w(file: string, content: string) {
  const full = join(gitRepo, file);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}
function commit(author: string, email: string, date: string) {
  sh(["git", "add", "."], gitRepo);
  sh(["git", "commit", "-m", "c"], gitRepo, {
    GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: author,
    GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
  });
}
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const golden = (f: string) => readFileSync(join(fixtures, f), "utf8");

function buildInto(out: string) {
  return sh(["bun", tsBuild, "--repo", gitRepo, "--out", out, "--cochange-min-count", "1", "--graphml"], repoRoot, { SOM_FAKE_NOW: FAKE_NOW });
}

beforeAll(() => {
  gitRepo = mkdtempSync(join(tmpdir(), "som-build-git-"));
  sh(["git", "init", "-q"], gitRepo);
  sh(["git", "config", "commit.gpgsign", "false"], gitRepo);
  w("auth/login.ts", "v1"); commit("Alice", "alice@corp.dev", "2025-01-05T10:00:00-05:00");
  w("auth/session.ts", "v1"); commit("Alice", "alice@corp.dev", "2025-02-10T11:00:00-05:00");
  w("crypto/tls.ts", "v1"); commit("Bob", "bob@corp.dev", "2025-03-15T09:30:00+01:00");
  w("docs/readme.md", "v1"); commit("Carol", "carol@corp.dev", "2025-04-01T08:00:00-05:00");
  w("auth/login.ts", "v2"); w("crypto/tls.ts", "v2"); commit("Carol", "carol@corp.dev", "2025-04-02T08:00:00-05:00");
  w("auth/login.ts", "v3"); w("crypto/tls.ts", "v3"); commit("Alice", "alice@corp.dev", "2025-05-03T08:00:00-05:00");
  w("auth/login.ts", "v4"); w("crypto/tls.ts", "v4"); commit("Bob", "bob@corp.dev", "2025-06-04T08:00:00+01:00");

  outDir = mkdtempSync(join(tmpdir(), "som-build-out-"));
  const b = buildInto(outDir);
  if (b.exitCode !== 0) throw new Error("ts build: " + dec(b.stderr));
});

afterAll(() => {
  if (gitRepo) rmSync(gitRepo, { recursive: true, force: true });
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("build_ownership_map (golden, python-free)", () => {
  for (const f of ["people.csv", "files.csv", "edges.csv", "cochange_edges.csv", "communities.json", "cochange.graph.json"]) {
    test(`${f} matches golden`, () => {
      expect(readFileSync(join(outDir, f), "utf8")).toBe(golden(f));
    });
  }

  test("summary.json matches golden (repo masked)", () => {
    const got = readFileSync(join(outDir, "summary.json"), "utf8").replace(/("repo": )".*?"/, '$1"<REPO>"');
    expect(got).toBe(golden("summary.json"));
  });

  test("graphml emitted; --no-communities emits no community/graph artifacts", () => {
    expect(existsSync(join(outDir, "cochange.graphml"))).toBe(true);
    const nc = mkdtempSync(join(tmpdir(), "som-nc-"));
    try {
      expect(sh(["bun", tsBuild, "--repo", gitRepo, "--out", nc, "--no-communities", "--cochange-min-count", "1"], repoRoot, { SOM_FAKE_NOW: FAKE_NOW }).exitCode).toBe(0);
      expect(existsSync(join(nc, "communities.json"))).toBe(false);
      expect(existsSync(join(nc, "cochange.graph.json"))).toBe(false);
      // deterministic recency-free artifacts identical with or without communities
      expect(readFileSync(join(nc, "people.csv"), "utf8")).toBe(golden("people.csv"));
    } finally {
      rmSync(nc, { recursive: true, force: true });
    }
  });

  test("build is deterministic across runs (community detection included)", () => {
    const out2 = mkdtempSync(join(tmpdir(), "som-det-"));
    try {
      expect(buildInto(out2).exitCode).toBe(0);
      for (const f of ["communities.json", "cochange.graph.json", "edges.csv"]) {
        expect(readFileSync(join(out2, f), "utf8")).toBe(readFileSync(join(outDir, f), "utf8"));
      }
    } finally {
      rmSync(out2, { recursive: true, force: true });
    }
  });
});
