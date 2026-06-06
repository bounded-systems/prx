/**
 * Host-side keeper orchestrator (GH-201, slice 3b-ii).
 *
 * The host counterpart of {@link ./daemon.handleKeeperRequest}: it performs the
 * local, keyless, networkless git-writes (`write-tree`/`commit-tree`) — model A
 * keeps these on the host because they need neither the network nor a signing
 * key — then ships the resulting commits as a commit-range bundle and asks the
 * in-VM keeper (via {@link ./client.IsolatedKeeperClient}) to import + signed-push
 * them. So the genuinely sensitive capabilities (push credential + signing key)
 * stay isolated in the VM, while the harmless object packing stays on the host.
 *
 * This is the single host entry mirroring `runKeeperPush`/`runKeeperCommitTree`:
 * give it a staged worktree + the lineage parent and it returns the daemon's
 * typed verdict. All effects (git, bundle) are injected seams, so it is fully
 * offline-testable with a fake git + a fake transport — no VM, no keys.
 */

import { execGit } from "@bounded-systems/git";

import { runKeeperCommitTree, runKeeperWriteTree } from "../pr-state/keeper.ts";
import { createCommitRangeBundle } from "./bundle.ts";
import { IsolatedKeeperClient } from "./client.ts";
import type { KeeperRemoteRequest, KeeperRemoteResponse } from "./contract.ts";

/** One host keeper unit of work: stage → commit → bundle → ask the VM to push. */
export interface KeeperRemoteInput {
  /** The staged worktree the host commits from (and bundles the range out of). */
  cwd: string;
  /** Lineage parent — the resolved base commit; the bundle's prerequisite. */
  parentSha: string;
  /** Synthetic commit message (derived from workUnitId + summary). */
  message: string;
  /** ISO timestamp pinned to BOTH author and committer date (reproducible SHA). */
  date: string;
  /** Branch to point at the materialized commit and push. */
  branch: string;
  /** Push remote (e.g. `origin`). */
  remote: string;
  /** Extra `git push` args appended after `<remote> <branch>` (e.g. `--force-with-lease`). */
  pushArgs?: string[] | undefined;
  /** Opt-in attestation ledger ref (the in-VM signer emits `push/v1` here — slice 4). */
  ledgerRef?: string | undefined;
}

/** Injectable host effects (all default to the real impls; tests stub them offline). */
export interface KeeperRemoteDeps {
  /** Git seam for the host-side `add`/`write-tree`/`commit-tree`/`bundle` writes. */
  git?: typeof execGit | undefined;
  /** Commit-range bundle producer (defaults to {@link ./bundle.createCommitRangeBundle}). */
  bundle?: typeof createCommitRangeBundle | undefined;
}

/**
 * Run a host keeper unit of work end-to-end against the isolated keeper: stage +
 * `commit-tree` locally (host, keyless), export the `(parent, branch]` range as a
 * bundle, and hand it to `client.importAndPush` for the in-VM import + signed
 * push. Returns the daemon's verdict; only a wire-contract violation throws (via
 * the client) — a daemon `error` is returned as data.
 */
export async function runKeeperRemote(
  input: KeeperRemoteInput,
  client: IsolatedKeeperClient,
  deps: KeeperRemoteDeps = {},
): Promise<KeeperRemoteResponse> {
  const git = deps.git ?? execGit;
  const bundle = deps.bundle ?? createCommitRangeBundle;

  const treeSha = await runKeeperWriteTree(input.cwd, { git });
  const commitSha = await runKeeperCommitTree(
    {
      treeSha,
      parentSha: input.parentSha,
      message: input.message,
      date: input.date,
      branch: input.branch,
    },
    input.cwd,
    { git },
  );
  const bundleBase64 = bundle({ cwd: input.cwd, parentSha: input.parentSha, branch: input.branch }, { git });

  const request: KeeperRemoteRequest = {
    kind: "import-and-push",
    bundleBase64,
    commitSha,
    branch: input.branch,
    remote: input.remote,
    ...(input.pushArgs !== undefined ? { pushArgs: input.pushArgs } : {}),
    ...(input.ledgerRef !== undefined ? { ledgerRef: input.ledgerRef } : {}),
  };
  return client.importAndPush(request);
}
