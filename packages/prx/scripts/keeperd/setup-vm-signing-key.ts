#!/usr/bin/env bun
/**
 * keeperd VM signing-key bootstrap (GH-236, slice 4 — security review APPROVED
 * with conditions a+b).
 *
 * Generates an ed25519 **signing key** inside the Lima VM and prints ONLY its
 * public half. The private key is born in the VM and never leaves it (hard gate:
 * "private key provably absent from the host"). This key is the keeper's
 * signer — it backs the prx provenance signature (`PRX_PROVENANCE_KEY`, verified
 * against the in-VM public key) and, registered as an SSH signing key, GitHub-
 * Verified signatures.
 *
 * This is step 1 only: generate + export the public half. It does NOT register or
 * wire the key — those are separate, reviewed steps:
 *   - register the public half to the operator account (near-term, impersonate-me)
 *     via `gh api user/ssh_signing_keys` — **sandbox-repo-only** per #236 cond (a),
 *   - wire `PRX_PROVENANCE_KEY` from the in-VM key in keeperd.
 * End-state: a dedicated keeper App-bot identity (#215 spike) replaces the
 * impersonate-operator near-term posture. Encryption-at-rest / tmpfs is the
 * #236 cond (b) hardening, revisited before any production repo.
 *
 * Unlike the deploy key, this key never pushes, so github.com's host key is not
 * pinned. Thin wrapper over {@link ./vm-keygen.runVmKeygenCli}.
 *
 * Usage: `bun scripts/keeperd/setup-vm-signing-key.ts [--vm NAME] [--key REL] [--comment C] [--force]`
 */

import { runVmKeygenCli } from "./vm-keygen.ts";

runVmKeygenCli(process.argv.slice(2), {
  kind: "signing key",
  defaultKeyRel: ".ssh/keeper_signing",
  defaultComment: "keeper-signing@lima-devshell",
  pinGithubHostKey: false,
  registerHint:
    'gh api user/ssh_signing_keys -f title=keeper-lima-devshell -f key="$(cat <pubfile>)"  (sandbox-only per GH-236 cond a; dedicated App-bot identity is the GH-215 spike)',
  scriptPath: "scripts/keeperd/setup-vm-signing-key.ts",
});
