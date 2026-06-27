// Mint a GitHub App INSTALLATION access token: App ID/Client ID + private key
// → signed JWT (RS256) → `POST /app/installations/<id>/access_tokens`.
//
// The point (prx-q9yj/auth follow-up): prx's GitHub ops authenticate today via a
// personal `gh` token capped at 5,000 req/hr shared across every tool. An App
// installation token has its own (higher) pool, a bot identity, and the
// least-privilege scopes of `.github/prx-app.manifest.json` (def-of-record). This
// is the minting primitive a keymaker-style broker will hold; CI already mints
// the same way via actions/create-github-app-token (front-desk-add.yml).
//
// Pure over its deps (`fetch` + clock injected) so it is unit-testable offline
// and carries no ambient authority. Uses `node:crypto` only (no node:fs — the
// caller supplies the PEM as a string).
import { createSign } from "node:crypto";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const USER_AGENT = "prx-github-app";

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** A short-lived installation token plus the scopes/expiry GitHub returns. */
export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly permissions: Readonly<Record<string, string>>;
}

/** What identifies the app + installation to mint for. */
export interface MintInstallationTokenInput {
  /** The numeric App ID or the app's Client ID — GitHub honors either as `iss`. */
  readonly issuer: string;
  /** The app private-key PEM contents (the caller reads the file). */
  readonly privateKeyPem: string;
  /** The installation to mint for (e.g. 138039680 = the bounded-systems org). */
  readonly installationId: string;
}

/** Injected ambient effects — defaulted in production, overridden in tests. */
export interface MintInstallationTokenDeps {
  readonly fetch?: typeof fetch;
  /** Injected clock (ms since epoch) so the JWT is deterministic in tests. */
  readonly now?: () => number;
  readonly apiBaseUrl?: string;
}

/**
 * Sign a GitHub App JWT (RS256). `iss` = App ID or Client ID; lifetime is ~9 min
 * (GitHub's max is 10), with `iat` backdated 60s for clock skew.
 */
export function appJwt(
  issuer: string,
  privateKeyPem: string,
  now: () => number = Date.now,
): string {
  const iat = Math.floor(now() / 1000) - 60;
  const exp = iat + 60 + 540;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat, exp, iss: issuer }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).end().sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Mint an installation access token. Throws if GitHub rejects the JWT or the
 * installation lookup. The returned `token` is a secret — do not log it.
 */
export async function mintInstallationToken(
  input: MintInstallationTokenInput,
  deps: MintInstallationTokenDeps = {},
): Promise<InstallationToken> {
  const doFetch = deps.fetch ?? fetch;
  const apiBaseUrl = deps.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const jwt = appJwt(input.issuer, input.privateKeyPem, deps.now);

  const res = await doFetch(
    `${apiBaseUrl}/app/installations/${input.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `mintInstallationToken: POST access_tokens → ${res.status} ${res.statusText}: ${await res.text()}`,
    );
  }
  const json = (await res.json()) as {
    token: string;
    expires_at: string;
    permissions?: Record<string, string>;
  };
  return { token: json.token, expiresAt: json.expires_at, permissions: json.permissions ?? {} };
}
