#!/usr/bin/env bun
/**
 * gh-app-token-spike — mint a `bounded-systems-prx` GitHub App INSTALLATION
 * token locally and prove it has its own (higher) rate-limit pool.
 *
 * Thin entry point: the minting primitive lives in
 * `../src/github-app/installation-token.ts` (tested, pure over deps). This script
 * reads the key from disk, calls it, and runs the `/rate_limit` proof.
 *
 * Why: prx's GitHub ops authenticate today via a personal `gh` token capped at
 * 5,000 req/hr shared across every tool — easy to exhaust. An App installation
 * token has a separate, higher pool, a bot identity, and least-privilege scopes
 * (`.github/prx-app.manifest.json` is the def-of-record). This de-risks a future
 * keymaker-style token broker (relates the bounded-systems-prx app, prx-0qr /
 * prx-h1e). CI already mints the same way via actions/create-github-app-token
 * (front-desk-add.yml / version.yml).
 *
 * Usage:
 *   PRX_GH_APP_ID=<app-id-or-client-id> \
 *   PRX_GH_APP_KEY_FILE=/path/to/private-key.pem \
 *   [PRX_GH_INSTALLATION_ID=138039680] \
 *     bun run packages/prx/scripts/gh-app-token-spike.ts
 *
 * Point PRX_GH_APP_KEY_FILE at the app private key — ideally an agenix/sops-
 * decrypted secret (path-only in env, never baked), mirroring
 * PRX_PROVENANCE_MASTER_FILE. The CI creds are FRONT_DESK_CLIENT_ID +
 * FRONT_DESK_APP_PRIVATE_KEY.
 */
import { readFileSync } from "node:fs";

import { mintInstallationToken } from "../src/github-app/installation-token.ts";

function fail(msg: string): never {
  console.error(`gh-app-token-spike: ${msg}`);
  process.exit(1);
}

const issuer = process.env.PRX_GH_APP_ID;
const keyFile = process.env.PRX_GH_APP_KEY_FILE;
const installationId = process.env.PRX_GH_INSTALLATION_ID ?? "138039680"; // bounded-systems

if (!issuer) fail("set PRX_GH_APP_ID (the App ID or the app's Client ID)");
if (!keyFile) fail("set PRX_GH_APP_KEY_FILE (path to the app private-key PEM)");

let privateKeyPem: string;
try {
  privateKeyPem = readFileSync(keyFile, "utf8");
} catch (e) {
  fail(`cannot read PRX_GH_APP_KEY_FILE (${keyFile}): ${(e as Error).message}`);
}

const { token, expiresAt, permissions } = await mintInstallationToken({
  issuer,
  privateKeyPem,
  installationId,
}).catch((e: Error) => fail(e.message));

// Prove the pool: call /rate_limit with the installation token.
const rlRes = await fetch("https://api.github.com/rate_limit", {
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "prx-gh-app-token-spike",
  },
});
if (!rlRes.ok) fail(`GET rate_limit → ${rlRes.status} ${rlRes.statusText}: ${await rlRes.text()}`);
const rl = (await rlRes.json()) as {
  resources: {
    core: { limit: number; remaining: number };
    graphql: { limit: number; remaining: number };
  };
};

// The token is a secret — report identity, scopes, and the pool, never the token.
console.log(
  JSON.stringify(
    {
      installationId,
      tokenExpiresAt: expiresAt,
      permissions,
      rateLimit: { core: rl.resources.core, graphql: rl.resources.graphql },
    },
    null,
    2,
  ),
);
console.error(`\nOK — minted an installation token (expires ${expiresAt}); the token was not printed.`);
