#!/usr/bin/env bun
/**
 * gh-app-token-spike — mint a `bounded-systems-prx` GitHub App INSTALLATION
 * token locally and prove it has its own (higher) rate-limit pool.
 *
 * The point: prx's GitHub ops (PR create/merge/checks) run today on a personal
 * `gh` token capped at 5,000 req/hr shared across every tool — easy to exhaust.
 * An App installation token authenticates as the org-owned app, with a separate
 * pool that scales with installed repos, plus a bot identity and least-privilege
 * scopes (the `.github/prx-app.manifest.json` is the def-of-record). This is the
 * de-risking spike before wiring a keymaker-style token broker (prx-sfco/auth
 * follow-up; relates the bounded-systems-prx app, prx-0qr / prx-h1e).
 *
 * Flow (zero deps — node:crypto + fetch only, matching prx's no-extra-deps ethos):
 *   App ID/Client ID + private key (PEM) → signed JWT (RS256, ≤10 min)
 *   → POST /app/installations/<id>/access_tokens → 1-hour installation token
 *   → GET /rate_limit with it → print the pool (proof). The token is NOT printed.
 *
 * Usage:
 *   PRX_GH_APP_ID=<app-id-or-client-id> \
 *   PRX_GH_APP_KEY_FILE=/path/to/private-key.pem \
 *   [PRX_GH_INSTALLATION_ID=138039680] \
 *     bun run packages/prx/scripts/gh-app-token-spike.ts
 *
 * Credentials already exist as repo settings for CI (FRONT_DESK_CLIENT_ID +
 * FRONT_DESK_APP_PRIVATE_KEY, used by actions/create-github-app-token in
 * front-desk-add.yml / version.yml). For local use, point PRX_GH_APP_KEY_FILE at
 * the app private key — ideally an agenix/sops-decrypted secret (path-only in
 * env, never baked), mirroring PRX_PROVENANCE_MASTER_FILE.
 *
 * `iss` accepts the numeric App ID or the App's Client ID (GitHub honors both).
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://api.github.com";
const UA = "prx-gh-app-token-spike";

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function fail(msg: string): never {
  console.error(`gh-app-token-spike: ${msg}`);
  process.exit(1);
}

/** Sign a GitHub App JWT (RS256, iss = App ID or Client ID, ≤10 min lifetime). */
function appJwt(issuer: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  // iat backdated 60s for clock skew; exp 9 min (GitHub max is 10).
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: issuer }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).end().sign(privateKeyPem);
  return `${signingInput}.${b64url(signature)}`;
}

async function gh(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      ...(init?.headers ?? {}),
    },
  });
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

const jwt = appJwt(issuer, privateKeyPem);

// 1. JWT → installation access token.
const tokenRes = await gh(`/app/installations/${installationId}/access_tokens`, jwt, { method: "POST" });
if (!tokenRes.ok) {
  fail(`POST access_tokens → ${tokenRes.status} ${tokenRes.statusText}: ${await tokenRes.text()}`);
}
const tokenJson = (await tokenRes.json()) as {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
};

// 2. Prove the pool: call /rate_limit with the installation token.
const rlRes = await gh("/rate_limit", tokenJson.token);
if (!rlRes.ok) {
  fail(`GET rate_limit → ${rlRes.status} ${rlRes.statusText}: ${await rlRes.text()}`);
}
const rl = (await rlRes.json()) as {
  resources: { core: { limit: number; remaining: number }; graphql: { limit: number; remaining: number } };
};

// Token itself is a secret — report identity + scopes + the pool, never the token.
console.log(
  JSON.stringify(
    {
      installationId,
      tokenExpiresAt: tokenJson.expires_at,
      permissions: tokenJson.permissions,
      rateLimit: { core: rl.resources.core, graphql: rl.resources.graphql },
    },
    null,
    2,
  ),
);
console.error(
  `\nOK — minted an installation token (expires ${tokenJson.expires_at}). ` +
    `To use it: export GH_TOKEN=<token from a non-printing variant> and gh/octokit run as the app.`,
);
