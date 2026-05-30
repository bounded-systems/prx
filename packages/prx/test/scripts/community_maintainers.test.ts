import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const monoRoot = resolve(repoRoot, "..", "..");
const scriptsDir = join(monoRoot, "skills/security-ownership-map/scripts");
const tsBuild = join(scriptsDir, "build_ownership_map.ts");
const tsRun = join(scriptsDir, "run_ownership_map.ts");
const tsCM = join(scriptsDir, "community_maintainers.ts");
const fixtures = join(repoRoot, "test/scripts/fixtures/community_maintainers");

/**
 * M2.4/M2.5 (functional-ripple): community_maintainers.ts + run_ownership_map.ts.
 *
 * PYTHON-FREE. The CSV goldens in test/scripts/fixtures/community_maintainers/
 * were captured from the TS impl and verified byte-identical to python 3.9.6
 * during the port; they are frozen here so the test depends only on bun + git,
 * not on whichever python the CI env happens to ship (which is being removed +
 * denied, GH-696 M2.5). The fixture history is deterministic (fixed dates/
 * authors/content), so cm output is reproducible run-to-run.
 */

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
const golden = (name: string) => readFileSync(join(fixtures, name), "utf8");

beforeAll(() => {
  gitRepo = mkdtempSync(join(tmpdir(), "som-cm-git-"));
  sh(["git", "init", "-q"], gitRepo);
  sh(["git", "config", "commit.gpgsign", "false"], gitRepo);
  w("auth/login.ts", "v1"); commit("Alice", "alice@corp.dev", "2025-01-05T10:00:00-05:00");
  w("crypto/tls.ts", "v1"); commit("Bob", "bob@corp.dev", "2025-01-15T09:30:00+01:00");
  w("auth/login.ts", "v2"); w("crypto/tls.ts", "v2"); commit("Carol", "carol@corp.dev", "2025-02-02T08:00:00-05:00");
  w("auth/login.ts", "v3"); w("crypto/tls.ts", "v3"); commit("Alice", "alice@corp.dev", "2025-03-03T08:00:00-05:00");
  w("auth/login.ts", "v4"); w("crypto/tls.ts", "v4"); commit("Bob", "bob@corp.dev", "2025-04-04T08:00:00+01:00");
  w("auth/login.ts", "v5"); w("crypto/tls.ts", "v5"); commit("Alice", "alice@corp.dev", "2025-05-05T08:00:00-05:00");

  dataDir = mkdtempSync(join(tmpdir(), "som-cm-out-"));
  const b = sh(["bun", tsBuild, "--repo", gitRepo, "--out", dataDir, "--cochange-min-count", "1", "--emit-commits"], repoRoot);
  if (b.exitCode !== 0) throw new Error("ts build: " + dec(b.stderr));
});

afterAll(() => {
  if (gitRepo) rmSync(gitRepo, { recursive: true, force: true });
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const VARIANTS: { flags: string[]; gold: string }[] = [
  { flags: ["--file", "auth/login.ts"], gold: "file.txt" },
  { flags: ["--file", "auth/login.ts", "--bucket", "quarter"], gold: "quarter.txt" },
  { flags: ["--file", "auth/login.ts", "--weight", "recency"], gold: "recency.txt" },
  { flags: ["--file", "auth/login.ts", "--touch-mode", "file", "--top", "2"], gold: "touchfile.txt" },
  { flags: ["--community-id", "1"], gold: "cid1.txt" },
];

describe("community_maintainers (golden, python-free)", () => {
  for (const v of VARIANTS) {
    test(`cm ${v.flags.join(" ")}`, () => {
      const r = sh(["bun", tsCM, "--data-dir", dataDir, ...v.flags], repoRoot);
      expect(r.exitCode, `stderr: ${dec(r.stderr)}`).toBe(0);
      expect(dec(r.stdout)).toBe(golden(v.gold));
    });
  }

  test("error: missing file in graph → exit 2 + message", () => {
    const r = sh(["bun", tsCM, "--data-dir", dataDir, "--file", "does/not/exist"], repoRoot);
    expect(r.exitCode).toBe(2);
    expect(dec(r.stderr)).toBe("File not found in graph: does/not/exist\n");
  });
});

describe("run_ownership_map orchestrator", () => {
  test("produces the same deterministic artifacts as a direct build", () => {
    const runOut = mkdtempSync(join(tmpdir(), "som-run-"));
    const directOut = mkdtempSync(join(tmpdir(), "som-direct-"));
    try {
      expect(sh(["bun", tsRun, "--repo", gitRepo, "--out", runOut, "--cochange-min-count", "1"], repoRoot).exitCode).toBe(0);
      expect(sh(["bun", tsBuild, "--repo", gitRepo, "--out", directOut, "--cochange-min-count", "1", "--community-top-owners", "5", "--bus-factor-threshold", "1", "--stale-days", "365", "--owner-threshold", "0.5", "--cochange-max-files", "50"], repoRoot).exitCode).toBe(0);
      for (const f of ["people.csv", "files.csv", "cochange_edges.csv", "communities.json"]) {
        if (existsSync(join(runOut, f))) expect(readFileSync(join(runOut, f), "utf8")).toBe(readFileSync(join(directOut, f), "utf8"));
      }
    } finally {
      rmSync(runOut, { recursive: true, force: true });
      rmSync(directOut, { recursive: true, force: true });
    }
  });
});
