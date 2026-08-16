#!/usr/bin/env bun
/**
 * Launch-key bootstrap (capability chain, L2).
 *
 * Generates an ed25519 **launch keypair** — the key a launcher's signer door uses
 * to sign L2 launch attestations (`attest-launch`). Mirrors the keeper-key
 * discipline (`keeperd-room.ts`: `podman secret create prx-keeper-key
 * <from-1password>`), one tier up:
 *   - the PRIVATE half is stored in **1Password** (as a document, so it never
 *     touches argv) and provisioned at deploy as the `prx-launch-key` podman
 *     secret on tmpfs — never on disk in the clear, never in an image layer;
 *   - the PUBLIC half (`PRX_LAUNCH_PUBKEY`) is written for the verifier to pin
 *     and to publish under the owner's identity.
 *
 * The keygen core is pure (testable); only the CLI touches `op`/the filesystem.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface LaunchKeypair {
  /** PKCS8 PEM private key — the launcher's signer-door secret. */
  privatePem: string;
  /** SPKI PEM public key — `PRX_LAUNCH_PUBKEY`. */
  publicPem: string;
}

/** Generate an ed25519 launch keypair (PEM). Pure — no IO, no secrets leak. */
export function generateLaunchKeypair(): LaunchKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicPem: publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

interface Options {
  vault: string;
  title: string;
  pubOut: string;
  store: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    vault: "bounded-systems",
    title: "prx-launch-key",
    pubOut: join(homedir(), ".config", "prx", "launch.pub"),
    store: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault") opts.vault = argv[++i] ?? opts.vault;
    else if (a === "--title") opts.title = argv[++i] ?? opts.title;
    else if (a === "--pub-out") opts.pubOut = argv[++i] ?? opts.pubOut;
    else if (a === "--no-1password" || a === "--no-store") opts.store = false;
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    }
  }
  return opts;
}

const USAGE = `prx launch-keygen — generate the launcher signing keypair (capability chain L2)

  bun scripts/keeperd/launch-keygen.ts [--vault <1password-vault>] [--title <item>]
                                       [--pub-out <path>] [--no-1password]

Generates an ed25519 keypair; stores the PRIVATE half in 1Password (as a document)
and writes the PUBLIC half (PRX_LAUNCH_PUBKEY) to --pub-out. Prints the deploy +
verifier + publish steps. The private key never touches argv.`;

function run(): void {
  const opts = parseArgs(process.argv.slice(2));
  const { privatePem, publicPem } = generateLaunchKeypair();

  // Public half → the verifier's pin path.
  mkdirSync(dirname(opts.pubOut), { recursive: true });
  writeFileSync(opts.pubOut, publicPem, { mode: 0o644 });

  // Private half → 1Password (as a document, via a 0600 temp file so it never
  // touches argv); then shred the temp file.
  let stored = false;
  if (opts.store) {
    const keyFile = join(tmpdir(), `prx-launch-key-${process.pid}.pem`);
    writeFileSync(keyFile, privatePem, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    try {
      const res = spawnSync(
        "op",
        ["document", "create", keyFile, "--title", opts.title, "--vault", opts.vault],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      stored = res.status === 0;
      if (!stored) {
        console.error(
          `\n⚠️  1Password store failed (op exit ${res.status}); the key is at ${keyFile}`,
        );
        console.error("    Store it manually, then shred that file.");
      }
    } finally {
      if (stored) rmSync(keyFile, { force: true });
    }
  }

  console.log(`\nPUBLIC KEY (PRX_LAUNCH_PUBKEY) — written to ${opts.pubOut}:\n`);
  console.log(publicPem.trim());
  console.log("\nNext steps:");
  console.log(`  # verifier (gate): pin the public key`);
  console.log(`  export PRX_LAUNCH_PUBKEY="${opts.pubOut}"`);
  console.log(`  # launcher signer door: provision the private key as a tmpfs secret`);
  console.log(
    `  op document get "${opts.title}" --vault "${opts.vault}" | podman secret create prx-launch-key -`,
  );
  console.log(`  # publish under the owner's identity (operators pin from here)`);
  console.log(
    `  cp "${opts.pubOut}" <site>/.well-known/launch.pub   # + a Keyoxide/OIDC owner proof`,
  );
  if (opts.store && stored)
    console.log(`\n✅ private key stored in 1Password: ${opts.vault}/${opts.title}`);
}

if (import.meta.main) run();
