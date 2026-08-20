import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflowPath = resolve(repoRoot, ".github/workflows/release-cut.yml");

/**
 * #1068: release-cut cuts the release tag in CI, so its guards are the only
 * thing standing between a dispatch and an IRREVERSIBLE act — a public GitHub
 * Release and an immutable JSR version.
 *
 * These tests run the workflow's REAL guard script, extracted from the YAML at
 * test time rather than copied here, so the test cannot drift from the thing it
 * claims to check. Each guard is exercised in both directions: a guard only
 * proven to pass is not evidence, it is a guard-shaped hole (the same mistake
 * `hm-module-provenance-default.test.ts` was rewritten to avoid).
 *
 * The fixtures are a real local git repo with a real bare remote, because guard
 * 2 checks `git ls-remote` — pointing it at a fake would test the fake.
 */

function extractGuardScript(): string {
  const doc = Bun.YAML.parse(readFileSync(workflowPath, "utf8")) as {
    jobs: { cut: { steps: Array<{ name: string; run?: string }> } };
  };
  const step = doc.jobs.cut.steps.find((s) => s.name === "Guards");
  expect(step, "release-cut.yml must have a step named 'Guards'").toBeDefined();
  expect(step?.run, "the Guards step must be a run: script").toBeTruthy();
  return step!.run!;
}

interface Fixture {
  version?: string;
  changelogVersion?: string | null;
  pendingChangesets?: string[];
  localTags?: string[];
  remoteTags?: string[];
}

/** Build a throwaway repo+remote, then run the real guard script against it. */
function runGuards(expectVersion: string, fx: Fixture = {}) {
  const {
    version = "1.0.0",
    changelogVersion = version,
    pendingChangesets = [],
    localTags = [],
    remoteTags = [],
  } = fx;

  const root = mkdtempSync(join(tmpdir(), "release-cut-"));
  const work = join(root, "work");
  const bare = join(root, "remote.git");
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r;
  };

  try {
    spawnSync("git", ["init", "--bare", "-q", bare]);
    mkdirSync(work);
    git(work, "init", "-q");
    git(work, "config", "user.email", "t@example.com");
    git(work, "config", "user.name", "t");

    mkdirSync(join(work, "packages/prx"), { recursive: true });
    mkdirSync(join(work, ".changeset"), { recursive: true });
    writeFileSync(join(work, "packages/prx/package.json"), JSON.stringify({ version }));
    writeFileSync(
      join(work, "packages/prx/CHANGELOG.md"),
      `# @bounded-systems/prx\n\n${changelogVersion ? `## ${changelogVersion}\n\nnotes\n` : ""}`,
    );
    // changesets' own scaffolding — must NOT count as a pending intent.
    writeFileSync(join(work, ".changeset/README.md"), "scaffolding\n");
    writeFileSync(join(work, ".changeset/config.json"), "{}\n");
    for (const name of pendingChangesets) {
      writeFileSync(join(work, `.changeset/${name}`), "---\n---\n\nintent\n");
    }

    git(work, "add", "-A");
    git(work, "commit", "-qm", "fixture");
    git(work, "remote", "add", "origin", bare);
    git(work, "push", "-q", "origin", "HEAD:refs/heads/main");

    for (const t of remoteTags) {
      git(work, "tag", "-a", t, "-m", t);
      git(work, "push", "-q", "origin", `refs/tags/${t}`);
      git(work, "tag", "-d", t); // remote-only: prove the REMOTE check fires
    }
    for (const t of localTags) git(work, "tag", "-a", t, "-m", t);

    const outFile = join(root, "gh_output");
    writeFileSync(outFile, "");
    const sumFile = join(root, "gh_summary");
    writeFileSync(sumFile, "");

    const r = spawnSync("bash", ["-c", extractGuardScript()], {
      cwd: work,
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECT: expectVersion,
        GITHUB_OUTPUT: outFile,
        GITHUB_STEP_SUMMARY: sumFile,
      },
    });
    return {
      status: r.status,
      stderr: r.stderr ?? "",
      outputs: readFileSync(outFile, "utf8"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("release-cut guards (#1068)", () => {
  test("all guards satisfied → passes and emits version + tag", () => {
    const r = runGuards("1.0.0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.outputs).toContain("version=1.0.0");
    expect(r.outputs).toContain("tag=v1.0.0");
  });

  test("guard 1: manifest version disagrees with expect-version → blocks", () => {
    const r = runGuards("0.9.9", { version: "1.0.0" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("version mismatch");
  });

  test("guard 2: tag already exists locally → blocks", () => {
    const r = runGuards("1.0.0", { localTags: ["v1.0.0"] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("already exists locally");
  });

  test("guard 2: tag exists only on the remote → still blocks", () => {
    // The case a local-only check would wave through, re-cutting an immutable
    // published version.
    const r = runGuards("1.0.0", { remoteTags: ["v1.0.0"] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("already exists on the remote");
  });

  test("guard 3: an unconsumed changeset → blocks", () => {
    const r = runGuards("1.0.0", { pendingChangesets: ["gh999-something.md"] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unconsumed changesets");
    expect(r.stderr).toContain("gh999-something.md");
  });

  test("guard 3: README.md and config.json are not mistaken for intents", () => {
    // Both always exist in .changeset/; counting either would make every cut
    // impossible — a guard that never passes is as broken as one that never fails.
    const r = runGuards("1.0.0", { pendingChangesets: [] });
    expect(r.status, r.stderr).toBe(0);
  });

  test("guard 4: CHANGELOG has no section for this version → blocks", () => {
    const r = runGuards("1.0.0", { changelogVersion: null });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no '## 1.0.0' section");
  });

  test("guard 4: a prefix match does not satisfy the changelog check", () => {
    // '## 1.0.0' must not be satisfied by '## 1.0.0-rc.1' or '## 1.0.01'.
    const r = runGuards("1.0.0", { changelogVersion: "1.0.0-rc.1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no '## 1.0.0' section");
  });
});
