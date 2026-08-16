import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCommitRangeBundle, importBundleIntoRepo } from "../../src/keeperd/bundle.ts";

// Real-git integration: the bundle functions call the policy-aware execGit
// (role=keeper) against real temp repos. Setup commits pass `-c
// commit.gpgsign=false` so a signing-enabled host env can't hang the run; the
// bundle/fetch/switch ops themselves never commit, so they need no such guard.

const dirs: string[] = [];
function mkrepo(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function gitIn(dir: string): (args: string[]) => string {
  return (args) =>
    execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("keeperd object transfer — bundle round-trip (model A)", () => {
  test("ships only the new commit; the VM imports it to the exact tip", () => {
    // Host: a base commit (the parent the VM will already have).
    const host = mkrepo("keeper-host-");
    const hg = gitIn(host);
    hg(["init", "-q", "-b", "main"]);
    hg(["config", "user.name", "Test"]);
    hg(["config", "user.email", "test@example.com"]);
    writeFileSync(join(host, "base.txt"), "base\n");
    hg(["add", "-A"]);
    hg(["commit", "-qm", "base"]);
    const parentSha = hg(["rev-parse", "HEAD"]).trim();

    // VM stand-in: a clone taken AT the parent — it has parentSha, not the new work.
    const vm = mkrepo("keeper-vm-");
    execFileSync("git", ["clone", "-q", host, vm], { encoding: "utf8" });
    const vg = gitIn(vm);
    vg(["config", "user.name", "Test"]);
    vg(["config", "user.email", "test@example.com"]);

    // Host: the keeper commit on the work-unit branch.
    hg(["switch", "-qC", "GH-456"]);
    writeFileSync(join(host, "feature.txt"), "feat\n");
    hg(["add", "-A"]);
    hg(["commit", "-qm", "feat"]);
    const commitSha = hg(["rev-parse", "HEAD"]).trim();

    // Export the (parent, branch] range and import it into the VM.
    const bundle = createCommitRangeBundle({ cwd: host, parentSha, branch: "GH-456" });
    expect(bundle.length).toBeGreaterThan(0);

    importBundleIntoRepo({ cwd: vm, bundleBase64: bundle, branch: "GH-456", commitSha });

    // The VM is now at the exact commit, with the new file — objects crossed intact.
    expect(vg(["rev-parse", "HEAD"]).trim()).toBe(commitSha);
    expect(vg(["rev-parse", "GH-456"]).trim()).toBe(commitSha);
    expect(existsSync(join(vm, "feature.txt"))).toBe(true);
    expect(vg(["log", "-1", "--format=%s"]).trim()).toBe("feat");
  });

  test("rejects a commitSha the imported bundle does not contain", () => {
    const host = mkrepo("keeper-host-");
    const hg = gitIn(host);
    hg(["init", "-q", "-b", "main"]);
    hg(["config", "user.name", "Test"]);
    hg(["config", "user.email", "test@example.com"]);
    writeFileSync(join(host, "base.txt"), "base\n");
    hg(["add", "-A"]);
    hg(["commit", "-qm", "base"]);
    const parentSha = hg(["rev-parse", "HEAD"]).trim();

    const vm = mkrepo("keeper-vm-");
    execFileSync("git", ["clone", "-q", host, vm], { encoding: "utf8" });
    gitIn(vm)(["config", "user.email", "test@example.com"]);

    hg(["switch", "-qC", "GH-456"]);
    writeFileSync(join(host, "feature.txt"), "feat\n");
    hg(["add", "-A"]);
    hg(["commit", "-qm", "feat"]);
    const bundle = createCommitRangeBundle({ cwd: host, parentSha, branch: "GH-456" });

    expect(() =>
      importBundleIntoRepo({
        cwd: vm,
        bundleBase64: bundle,
        branch: "GH-456",
        commitSha: "d".repeat(40), // not in the bundle
      }),
    ).toThrow();
  });

  test("rejects a non-40-hex commitSha before touching git", () => {
    const vm = mkrepo("keeper-vm-");
    expect(() =>
      importBundleIntoRepo({ cwd: vm, bundleBase64: "x", branch: "b", commitSha: "nope" }),
    ).toThrow(/40-hex/);
  });

  test("surfaces a corrupt bundle as a fetch failure", () => {
    const host = mkrepo("keeper-host-");
    const hg = gitIn(host);
    hg(["init", "-q", "-b", "main"]);
    hg(["config", "user.name", "Test"]);
    hg(["config", "user.email", "test@example.com"]);
    writeFileSync(join(host, "base.txt"), "base\n");
    hg(["add", "-A"]);
    hg(["commit", "-qm", "base"]);

    expect(() =>
      importBundleIntoRepo({
        cwd: host,
        bundleBase64: Buffer.from("not a real bundle").toString("base64"),
        branch: "GH-456",
        commitSha: "a".repeat(40),
      }),
    ).toThrow();
  });
});
