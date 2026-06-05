/**
 * keeperd wire contract (GH-201, slice 1).
 *
 * `keeperd` is the `prx keeper` git-write/signing actor run as a persistent
 * daemon inside an isolated Lima VM: it owns the `role=keeper` git-write
 * capability, its own provenance signing key (never on the host), and the push
 * credential. The host prepares work and asks keeperd to materialize a commit
 * and signed-push it; the host itself holds no push or signing capability.
 *
 * This module is the **typed wire contract** between the host-side
 * {@link ../keeperd/client.IsolatedKeeperClient} and the in-VM daemon — a
 * spec-as-schema enforceable boundary: both ends `parse()` every frame, so a
 * malformed request or response is a validation error at the seam, never a
 * silent half-execution of a git-write.
 *
 * Slice 1 defines the contract + a host client with an injected transport seam
 * (offline-testable, no VM, no keys). The daemon (slice 2), the Lima-SSH
 * transport (slice 3), and in-VM key provisioning (slice 4, gated) consume it.
 *
 * Driver-agnostic: no `limactl`, `ssh`, socket, or git vocabulary leaks here —
 * just the request/response shapes.
 */

import { z } from "zod";

/** A 40-hex git object id (tree or commit). */
const Sha1 = z.string().regex(/^[0-9a-f]{40}$/, "expected a 40-hex sha");

/**
 * One keeper unit of work: materialize a synthetic commit from a tree artifact
 * (mirrors {@link ../pr-state/keeper.KeeperCommitTreeInput}) and push the
 * resulting branch tip. The commit inputs are pinned so the commit SHA is
 * reproducible (same tree+parent+message+date ⇒ same SHA).
 */
export const KeeperRemoteRequestSchema = z.object({
  kind: z.literal("commit-and-push"),
  /**
   * A git bundle (base64) carrying the tree object and its parent so the VM
   * materializes state with no host-worktree mount. Carried opaquely by the
   * contract; produced host-side and unpacked in-VM in slice 3. Non-empty so a
   * caller cannot request a commit over objects the daemon doesn't have.
   */
  bundleBase64: z.string().min(1),
  /** The tree object to wrap in the commit (the artifact's identity). */
  treeSha: Sha1,
  /** Lineage parent — the resolved base commit. */
  parentSha: Sha1,
  /** Synthetic commit message (derived from workUnitId + summary). */
  message: z.string().min(1),
  /** ISO timestamp pinned to BOTH author and committer date (reproducible SHA). */
  date: z.string().min(1),
  /** Branch to point at the materialized commit and push. */
  branch: z.string().min(1),
  /** Push remote (e.g. `origin`). */
  remote: z.string().min(1),
  /** Extra `git push` args appended after `<remote> <branch>` (e.g. `--force-with-lease`). */
  pushArgs: z.array(z.string()).optional(),
  /**
   * Opt-in attestation: when set, keeperd wraps the push with `attestingGit` and
   * emits a signed `push/v1` derivation into this ledger ref (the in-VM signing
   * key signs it — slice 4). Absent ⇒ a bare push, no emission.
   */
  ledgerRef: z.string().min(1).optional(),
});
export type KeeperRemoteRequest = z.infer<typeof KeeperRemoteRequestSchema>;

/**
 * keeperd's reply. A discriminated union so a caller branches on `status`
 * exhaustively: `ok` always carries the pushed identity; `error` always carries
 * a machine-branchable `code` plus a human message (and the underlying git exit
 * code when the failure was a git-write).
 */
export const KeeperRemoteResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    /** The materialized commit SHA (the provenance subject of the push). */
    commitSha: Sha1,
    /** The fully-qualified ref the push updated (e.g. `refs/heads/GH-456`). */
    pushedRef: z.string().min(1),
    /**
     * The signed `push/v1` derivation, when `ledgerRef` was requested and a
     * signer was configured. Carried opaquely (validated by the provenance
     * layer, not here) so the contract stays decoupled from the SLSA shape.
     */
    signedDerivation: z.unknown().optional(),
  }),
  z.object({
    status: z.literal("error"),
    /** Stable, branchable failure class (e.g. `git-write`, `bad-bundle`, `policy-denied`). */
    code: z.string().min(1),
    /** Human-readable detail (safe to log; never carries key material). */
    message: z.string(),
    /** The git exit code, when the failure originated from a `role=keeper` git-write. */
    exitCode: z.number().int().optional(),
  }),
]);
export type KeeperRemoteResponse = z.infer<typeof KeeperRemoteResponseSchema>;
