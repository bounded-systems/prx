// `prx builder up | register` — the nix remote BUILDER as a pinned podman
// container (prx-zj8 capstone), replacing the Lima `provision-builder` verb.
//   - `up`: ensure the builder keypair + run the nix-builder container.
//   - `register`: print the `/etc/nix/machines` line + ssh-config block the
//     operator applies (prx never edits /etc/nix/* itself).
// The render layer (container-builder.ts) is pure + unit-tested; these verbs are
// the thin live drivers.

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";
import { defineVerb } from "@bounded-systems/verbspec";
import { spawnCapture } from "@bounded-systems/proc";

import { spawnPodman } from "../room/podman-runtime.ts";
import {
  BUILDER_CONTAINER_NAME,
  builderKeyPath,
  renderBuilderRunArgs,
  renderBuilderMachineLine,
  renderBuilderSshConfig,
} from "./container-builder.ts";
import { NIX_BUILDER_SSH_PORT } from "../room/nix-builder-service.ts";

/** Ensure the builder keypair exists (host privkey nix dials with; pubkey is
 *  mounted into the container as authorized_keys). Returns the pubkey path. */
function ensureBuilderKey(): string {
  const keyPath = builderKeyPath();
  if (!existsSync(keyPath)) {
    mkdirSync(dirname(keyPath), { recursive: true });
    spawnCapture(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "prx-nix-builder", "-f", keyPath]);
  }
  return `${keyPath}.pub`;
}

export const builderUpVerb = defineVerb({
  id: "builder up",
  summary: "Run the nix-builder container (sshd + nix) as the local remote builder.",
  actor: "work",
  input: z.object({}),
  output: z.object({
    container: z.string().describe("The podman container name"),
    sshPort: z.number().describe("Host port the builder's sshd is published on"),
    pubKey: z.string().describe("Host path of the public key mounted as authorized_keys"),
  }),
  run: async () => {
    const pubKeyPath = ensureBuilderKey();
    const res = spawnPodman(renderBuilderRunArgs({ pubKeyPath }));
    if (res.status !== 0) {
      throw new Error(`podman run nix-builder failed (${res.status}): ${res.stderr.trim()}`);
    }
    return { container: BUILDER_CONTAINER_NAME, sshPort: NIX_BUILDER_SSH_PORT, pubKey: pubKeyPath };
  },
});

export const builderRegisterVerb = defineVerb({
  id: "builder register",
  summary: "Print the /etc/nix/machines line + ssh-config to register the builder.",
  actor: "work",
  input: z.object({}),
  output: z.object({
    machinesLine: z.string().describe("The /etc/nix/machines line for the container builder"),
    sshConfig: z.string().describe("The ssh-config alias block for the builder"),
  }),
  run: async () => {
    const keyPath = builderKeyPath();
    return {
      machinesLine: renderBuilderMachineLine({ keyPath }),
      sshConfig: renderBuilderSshConfig({ keyPath }),
    };
  },
});
