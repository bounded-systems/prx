import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const monoRoot = resolve(repoRoot, "..", "..");
const scriptsDir = join(monoRoot, "skills/security-ownership-map/scripts");
const tsQuery = join(scriptsDir, "query_ownership.ts");
const tsBuild = join(scriptsDir, "build_ownership_map.ts");
const fixtures = join(repoRoot, "test/scripts/fixtures/query_ownership");

/**
 * M2.4/M2.5 (functional-ripple): port query_ownership.py -> .ts.
 *
 * PYTHON-FREE golden test. query reads build artifacts and emits json.dumps
 * slices; goldens were captured from the TS impl, verified == python during the
 * port. The build that produces the inputs is pinned via SOM_FAKE_NOW so the
 * recency-bearing person/file slices are deterministic. Fixtures are built fresh
 * each run from a fixed git history, so the artifacts match the golden capture.
 */

const FAKE_NOW = "2026-06-01T12:00:00+00:00";
let gitRepo: string;
let dataDir: string;

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

beforeAll(() => {
  gitRepo = mkdtempSync(join(tmpdir(), "som-q-git-"));
  sh(["git", "init", "-q"], gitRepo);
  sh(["git", "config", "commit.gpgsign", "false"], gitRepo);
  w("auth/login.ts", "v1"); commit("Alice", "alice@corp.dev", "2025-01-05T10:00:00-05:00");
  w("auth/session.ts", "v1"); commit("Alice", "alice@corp.dev", "2025-02-10T11:00:00-05:00");
  w("crypto/tls.ts", "v1"); commit("Bob", "bob@corp.dev", "2025-03-15T09:30:00+01:00");
  w("README.md", "v1"); commit("Carol", "carol@corp.dev", "2025-04-01T08:00:00-05:00");
  w("auth/login.ts", "v2"); w("crypto/tls.ts", "v2"); commit("Carol", "carol@corp.dev", "2025-04-02T08:00:00-05:00");
  w("auth/login.ts", "v3"); w("crypto/tls.ts", "v3"); commit("Alice", "alice@corp.dev", "2025-05-03T08:00:00-05:00");

  dataDir = mkdtempSync(join(tmpdir(), "som-q-out-"));
  const b = sh(["bun", tsBuild, "--repo", gitRepo, "--out", dataDir, "--no-communities", "--cochange-min-count", "1"], repoRoot, { SOM_FAKE_NOW: FAKE_NOW });
  if (b.exitCode !== 0) throw new Error("ts build: " + dec(b.stderr));
});

afterAll(() => {
  if (gitRepo) rmSync(gitRepo, { recursive: true, force: true });
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const COMMANDS: { flags: string[]; gold: string }[] = [
  { flags: ["people"], gold: "people.json" },
  { flags: ["people", "--sort", "sensitive_touches", "--min-touches", "1"], gold: "people_sorted.json" },
  { flags: ["files"], gold: "files.json" },
  { flags: ["files", "--tag", "auth", "--bus-factor-max", "2"], gold: "files_auth.json" },
  { flags: ["person", "--person", "alice@corp.dev"], gold: "person.json" },
  { flags: ["file", "--file", "auth/login.ts"], gold: "file.json" },
  { flags: ["cochange", "--file", "auth/login.ts"], gold: "cochange.json" },
  { flags: ["tag", "--tag", "crypto"], gold: "tag.json" },
  { flags: ["summary"], gold: "summary.json" },
  { flags: ["summary", "--section", "stats"], gold: "summary_stats.json" },
  { flags: ["summary", "--section", "hidden_owners"], gold: "summary_hidden.json" },
];

describe("query_ownership (golden, python-free)", () => {
  for (const c of COMMANDS) {
    test(`query ${c.flags.join(" ")}`, () => {
      const r = sh(["bun", tsQuery, "--data-dir", dataDir, ...c.flags], repoRoot);
      expect(r.exitCode, `stderr: ${dec(r.stderr)}`).toBe(0);
      // the full `summary` slice echoes summary.repo (a temp abspath) — mask it
      const out = dec(r.stdout).replace(/("repo": )".*?"/, '$1"<REPO>"');
      expect(out).toBe(golden(c.gold));
    });
  }

  test("error: unknown person → exit 2 + message", () => {
    const r = sh(["bun", tsQuery, "--data-dir", dataDir, "person", "--person", "nobody@nowhere"], repoRoot);
    expect(r.exitCode).toBe(2);
    expect(dec(r.stderr)).toBe("No match for nobody@nowhere\n");
  });

  test("error: missing data dir → exit 1", () => {
    const r = sh(["bun", tsQuery, "--data-dir", join(tmpdir(), "som-q-absent-xyz"), "people"], repoRoot);
    expect(r.exitCode).toBe(1);
    expect(dec(r.stderr)).toContain("Data directory not found:");
  });
});
