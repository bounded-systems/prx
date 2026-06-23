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

import {
  attestLaunch as doorKeeperAttestLaunch,
  importAndPush as doorKeeperImportAndPush,
} from "@bounded-systems/door-kit/keeper";

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
  const bundleBase64 = bundle(
    { cwd: input.cwd, parentSha: input.parentSha, branch: input.branch },
    { git },
  );

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

/**
 * One keeper push of an ALREADY-materialized commit, routed through the door.
 *
 * Unlike {@link runKeeperRemote}, the caller has already run the local
 * `commit-tree` (e.g. the submit-publish orchestrator materializing from a CAS
 * tree artifact), so this only bundles the resulting range `(parentSha, branch]`
 * and asks keeperd to import + signed-push it via {@link withKeeperClient} — no
 * redundant write-tree/commit-tree. The door endpoint comes from the projected
 * `PRX_KEEPER_*` env; the daemon holds the push credential + signing key.
 */
export interface KeeperDoorPushInput {
  /** Worktree holding the materialized commit (its objects feed the bundle). */
  cwd: string;
  /** Lineage parent — the bundle's prerequisite (excluded from the range). */
  parentSha: string;
  /** The already-materialized commit (host `commit-tree`) keeperd imports + pushes. */
  commitSha: string;
  /** Branch to point at the imported commit and push. */
  branch: string;
  /** Push remote (e.g. `origin`). */
  remote: string;
  /** Extra `git push` args (e.g. `--force-with-lease`). */
  pushArgs?: string[] | undefined;
  /** Opt-in: the daemon emits a signed `push/v1` into this ledger ref. */
  ledgerRef?: string | undefined;
  /** Opt-in: the box's L2 launch-attestation content-address, so the L3 write
   *  links back to its launch (capability chain). The pod projects it at launch. */
  l2LaunchDigest?: string | undefined;
}

/** Injectable seams for {@link runKeeperDoorPush} (default to the real impls). */
export interface KeeperDoorPushDeps {
  bundle?: typeof createCommitRangeBundle | undefined;
  /** The door-kit keeper client (defaults to the published `importAndPush`); the
   *  door endpoint comes from `KEEPERD_SOCK`/`KEEPERD_HOST` the pod projects. */
  importAndPush?: typeof doorKeeperImportAndPush | undefined;
}

export async function runKeeperDoorPush(
  input: KeeperDoorPushInput,
  deps: KeeperDoorPushDeps = {},
): Promise<KeeperRemoteResponse> {
  const bundle = deps.bundle ?? createCommitRangeBundle;
  const importAndPush = deps.importAndPush ?? doorKeeperImportAndPush;
  const bundleBase64 = bundle({ cwd: input.cwd, parentSha: input.parentSha, branch: input.branch });
  // Consume door-kit's published keeper client (guest-room protocol). Its
  // ImportAndPushResult is the keeperd wire verdict — structurally the
  // KeeperRemoteResponse the rest of the pipeline branches on.
  const result = await importAndPush({
    bundleBase64,
    commitSha: input.commitSha,
    branch: input.branch,
    remote: input.remote,
    // Project the signed L3 onto the commit as a git note (refs/notes/provenance)
    // so provenance travels with the repo (git notes / blame → commit → note).
    notesRef: "provenance",
    ...(input.pushArgs !== undefined ? { pushArgs: input.pushArgs } : {}),
    ...(input.ledgerRef !== undefined ? { ledgerRef: input.ledgerRef } : {}),
    // Link the L3 write back to the box's L2 launch (capability chain).
    ...(input.l2LaunchDigest !== undefined ? { l2LaunchDigest: input.l2LaunchDigest } : {}),
  });
  return result as KeeperRemoteResponse;
}

/** Injectable seam for {@link runKeeperDoorAttestLaunch}. */
export interface KeeperDoorAttestLaunchDeps {
  attestLaunch?: typeof doorKeeperAttestLaunch | undefined;
}

/**
 * Produce a signed L2 launch attestation for a room via the keeper door — the
 * launcher acts THROUGH the door, so the launch key never leaves the daemon. The
 * `manifest` is the room's resolved door set (authority = held references); the
 * daemon digests it. Returns the signed L2 + its content-address
 * (`l2LaunchDigest`), which the box's later keeper push links into its L3.
 */
export async function runKeeperDoorAttestLaunch(
  input: { subject: string; manifest: unknown },
  deps: KeeperDoorAttestLaunchDeps = {},
): Promise<{
  subject: string;
  manifestDigest: string;
  l2LaunchDigest: string;
  attestation: unknown;
}> {
  const attestLaunch = deps.attestLaunch ?? doorKeeperAttestLaunch;
  const result = await attestLaunch({ subject: input.subject, manifest: input.manifest });
  if (result.status !== "ok") {
    throw new Error(`prx keeper attest-launch failed (${result.code}) ${result.message}`.trim());
  }
  return {
    subject: result.subject,
    manifestDigest: result.manifestDigest,
    l2LaunchDigest: result.l2LaunchDigest,
    attestation: result.attestation,
  };
}
