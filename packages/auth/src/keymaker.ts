/**
 * @bounded-systems/auth — the keymaker (credential broker).
 *
 * A keymaker does NOT authenticate (the OAuth login / token issuance upstream
 * does that). It ATTENUATES an already-held root authority into scoped,
 * self-expiring keys — the ocap "use, don't read" discipline. This is the
 * generic, service-agnostic core (github / notion / slack can all use it): it
 * holds the root token in a closure, stamps a TTL, and injects the credential
 * into a request at call time. The token is NEVER exposed as a value — callers
 * get a capability whose only power is `authorize()`.
 *
 * Service-specific SCOPE typing + enforcement (e.g. "this key may only read
 * Slack channel C in op `history`") layers ON TOP of this, in the consuming
 * package, by wrapping a CredentialKeymaker — so the secret never enters that
 * package. See packages/slack/src/keymaker.ts (slackScopedKeymaker) and the
 * keymaker prior-art / enforcement-level memories.
 *
 * ENFORCEMENT LEVEL (do not overclaim): "token never exposed" is an in-process
 * DISCIPLINE guarantee at the Bun source/lint layer, not isolation — in-process
 * code can still read the closure. Isolation is a layered profile (Lima microVM
 * under --vm; SES/Deno/WASI are the in-process upgrade paths). TTL + (if wired)
 * network egress proxy bound a leaked key's blast radius, not sandboxing.
 */
import { requireAuthToken, type AuthService } from "./index.ts";

/** A request the credential injects authorization into. */
export interface CredentialRequest {
  url?: string | undefined;
  headers?: Record<string, string> | undefined;
}

/** A request after the credential has attached its authorization. */
export interface AuthorizedCredentialRequest extends CredentialRequest {
  headers: Record<string, string>;
}

/** Raised by {@link ScopedCredential.authorize} when the key has expired. */
export class CredentialExpiredError extends Error {
  readonly keyId: string;
  readonly expiresAt: number;
  constructor(keyId: string, expiresAt: number) {
    super(`credential ${keyId} expired at ${new Date(expiresAt).toISOString()}`);
    this.name = "CredentialExpiredError";
    this.keyId = keyId;
    this.expiresAt = expiresAt;
  }
}

/**
 * A minted credential capability — use, don't read. Self-expiring; the root
 * token lives only in the minting closure. `keyId` is a non-secret provenance
 * handle.
 */
export interface ScopedCredential {
  readonly keyId: string;
  /** Expiry, epoch ms. */
  readonly expiresAt: number;
  /** Attach authorization to a request; throws {@link CredentialExpiredError} if expired. */
  authorize(req: CredentialRequest): AuthorizedCredentialRequest;
}

/** A request to mint a credential: how long it lives (+ an optional explicit id). */
export interface CredentialGrant {
  ttlMs: number;
  keyId?: string | undefined;
}

/** The broker: mints least-authority, expiring credentials from a held root token. */
export interface CredentialKeymaker {
  mint(grant: CredentialGrant): ScopedCredential;
}

export interface ServiceKeymakerOptions {
  /** Injectable env seam (hermetic tests). Defaults to the ambient env via auth. */
  env?: NodeJS.ProcessEnv;
  /** Injectable clock for TTL. Defaults to Date.now. */
  now?: () => number;
  /** Injectable key-id generator (non-secret, for provenance). */
  genKeyId?: (mintedAt: number) => string;
}

/**
 * Build a keymaker for a service. Reads the root token ONCE (via the sanctioned
 * authToken reader) and seals it in the returned keymaker's closure — the token
 * string never escapes this function. Throws immediately if no credential is
 * configured (fail fast at composition time, not mid-read).
 */
export function createServiceKeymaker(
  service: AuthService,
  opts: ServiceKeymakerOptions = {},
): CredentialKeymaker {
  const now = opts.now ?? (() => Date.now());
  // Sealed in closure; never returned or stored as a property.
  const token = requireAuthToken(service, opts.env);
  let seq = 0;
  return {
    mint(grant: CredentialGrant): ScopedCredential {
      const mintedAt = now();
      const expiresAt = mintedAt + grant.ttlMs;
      const keyId =
        grant.keyId ?? opts.genKeyId?.(mintedAt) ?? `${service}-k${++seq}-${mintedAt}`;
      return {
        keyId,
        expiresAt,
        authorize(req: CredentialRequest): AuthorizedCredentialRequest {
          if (now() >= expiresAt) throw new CredentialExpiredError(keyId, expiresAt);
          return {
            ...req,
            headers: { ...(req.headers ?? {}), Authorization: `Bearer ${token}` },
          };
        },
      };
    },
  };
}
