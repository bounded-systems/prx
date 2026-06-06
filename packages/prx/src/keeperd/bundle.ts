/**
 * keeperd object transfer (GH-201, slice 3b-i).
 *
 * The host→VM object-ship for the chosen isolation model: the host does the
 * local, keyless, networkless git-writes (`write-tree`/`commit-tree`) and ships
 * the resulting commits as a git **bundle**; the in-VM keeper imports them and
 * performs ONLY the security-sensitive step — the signed push (App token +
 * in-VM key). So the genuinely dangerous capabilities (network + signing key)
 * live in the VM, while the harmless object packing stays simple.
 *
 * Both ends route through the policy-aware `execGit` as `role=keeper`:
 *   - export: `git bundle create` (GH-201 added `bundle` to keeper's read caps),
 *   - import: `git fetch <bundle>` (already in keeper's caps).
 * The binary bundle is moved as base64 in the wire contract; here it is staged
 * through a temp file (execGit captures stdout as text, which would corrupt
 * binary), cleaned up in a `finally`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execGit } from "@bounded-systems/git";

import { KeeperGitError } from "../pr-state/keeper.ts";

/** Injectable git seam (defaults to `execGit`); tests stub it offline. */
export interface BundleDeps {
  git?: typeof execGit | undefined;
}

const SHA1_RE = /^[0-9a-f]{40}$/;

/**
 * Host side: export the commits `(parentSha, branch]` as a base64 git bundle.
 * `parentSha` becomes the bundle's prerequisite (excluded), so the importing
 * repo must already have it — which the VM does (it keeps a repo clone). Only
 * the new commits cross the wire.
 */
export function createCommitRangeBundle(
  input: { cwd: string; parentSha: string; branch: string },
  deps: BundleDeps = {},
): string {
  const git = deps.git ?? execGit;
  const dir = mkdtempSync(join(tmpdir(), "keeper-bundle-"));
  const file = join(dir, "range.bundle");
  try {
    const created = git({
      subcommand: "bundle",
      args: ["create", file, `${input.parentSha}..${input.branch}`],
      cwd: input.cwd,
      role: "keeper",
    });
    if (created.exitCode !== 0) {
      throw new KeeperGitError(
        `keeper bundle create failed (${created.exitCode}): ${created.stderr.trim()}`,
        created.exitCode,
      );
    }
    return readFileSync(file).toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * VM side: import a base64 commit-range bundle and make `commitSha` the checked-
 * out tip of `branch` (the subject `attestingGit` will push). Verifies the tip
 * matches `commitSha` so a corrupted/wrong bundle is caught before the push.
 * Idempotent: re-importing the same bundle is a no-op fetch + a same-value reset.
 */
export function importBundleIntoRepo(
  input: { cwd: string; bundleBase64: string; branch: string; commitSha: string },
  deps: BundleDeps = {},
): void {
  if (!SHA1_RE.test(input.commitSha)) {
    throw new KeeperGitError(`keeper import: expected a 40-hex commitSha, got '${input.commitSha}'`);
  }
  const git = deps.git ?? execGit;
  const dir = mkdtempSync(join(tmpdir(), "keeper-import-"));
  const file = join(dir, "range.bundle");
  try {
    writeFileSync(file, Buffer.from(input.bundleBase64, "base64"));
    const fetched = git({
      subcommand: "fetch",
      args: [file, `+refs/heads/${input.branch}:refs/heads/${input.branch}`],
      cwd: input.cwd,
      role: "keeper",
    });
    if (fetched.exitCode !== 0) {
      throw new KeeperGitError(
        `keeper import: git fetch from bundle failed (${fetched.exitCode}): ${fetched.stderr.trim()}`,
        fetched.exitCode,
      );
    }
    // Make commitSha the checked-out HEAD on `branch` (the attested push subject).
    const switched = git({
      subcommand: "switch",
      args: ["-C", input.branch, input.commitSha],
      cwd: input.cwd,
      role: "keeper",
    });
    if (switched.exitCode !== 0) {
      throw new KeeperGitError(
        `keeper import: git switch -C ${input.branch} ${input.commitSha} failed (${switched.exitCode}): ${switched.stderr.trim()}`,
        switched.exitCode,
      );
    }
    const head = git({ subcommand: "rev-parse", args: ["HEAD"], cwd: input.cwd, role: "keeper" });
    const tip = head.stdout.trim();
    if (tip !== input.commitSha) {
      throw new KeeperGitError(
        `keeper import: imported tip ${tip} does not match requested commit ${input.commitSha}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
