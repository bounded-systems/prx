#!/usr/bin/env bun
/**
 * keeperd VM deploy-key bootstrap (GH-201, live slice 3b).
 *
 * Generates an ed25519 SSH **deploy key** (the in-VM push credential) inside the
 * Lima VM and prints ONLY its public half. Thin wrapper over the shared
 * {@link ./vm-keygen.runVmKeygenCli}; pins github.com's host key since this key
 * is used for the (first, non-interactive) push.
 *
 * Usage: `bun scripts/keeperd/setup-vm-deploy-key.ts [--vm NAME] [--key REL] [--comment C] [--force]`
 */

import { runVmKeygenCli } from "./vm-keygen.ts";

runVmKeygenCli(process.argv.slice(2), {
  kind: "deploy key",
  defaultKeyRel: ".ssh/keeper_deploy",
  defaultComment: "keeperd@lima-devshell",
  pinGithubHostKey: true,
  registerHint:
    "gh repo deploy-key add <pubfile> --repo bounded-systems/keeperd-push-sandbox --allow-write --title keeperd-lima-devshell",
  scriptPath: "scripts/keeperd/setup-vm-deploy-key.ts",
});
