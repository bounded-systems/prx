// slack .2 (prx-src) — keymaker capability PORT (interfaces only).
//
// ocap boundary: auth is factored out of the transport entirely. A keymaker is
// a credential BROKER that mints scoped, self-expiring keys from a held root
// authority — it does NOT authenticate (the OAuth login upstream does that); it
// ATTENUATES an already-held authority into least-authority keys.
//
// These are the port contracts the read surface depends on (dependency
// inversion: the consumer declares what it needs). The concrete keymaker —
// resolveSlackKeymaker() holding the root OAuth/refresh authority — lands in
// @bounded-systems/auth (slack .4b) and satisfies these structurally. Prior art
// + design rationale: spike prx-5u1 (biscuit/macaroon attenuation + Fulcio/Rekor
// provenance shape via the existing anchored-chain + RFC 8693 upgrade path).
//
// ENFORCEMENT LEVEL (honest threat model — do not overclaim). The "use,
// don't read / secret never exposed" guarantee below is a DISCIPLINE
// guarantee at the IN-PROCESS layer, not an ISOLATION one. Isolation in prx is
// a LAYERED PROFILE, not a single tier (composable defense in depth; a boundary
// is only as strong as the layer enforcing it):
//   - in-process (this code): Bun source+lint — capability seams + the package
//     extractability test. Trusts our own code; nothing stops malicious or
//     transitive in-process code from reading memory/env or spawning.
//   - agent: under `--vm` the whole agent runs in a Lima microVM (beadsd/dolt
//     already; the Claude session is being routed in — prx-69j/prx-bst). Strong.
//   - upgrade paths (fill the in-process gap): SES/hardened-JS Compartments
//     (ambient authority unreachable WITHOUT leaving Bun), Deno --allow-* gates
//     (GH-1836), WASI component model (capability-native, the structural endgame).
// Orthogonal axes bound credential USE regardless of isolation: network egress
// control (proxy → slack.com only) + this key's scope/TTL. So a leaked/minted key
// bounds blast radius by CONVENTION + short TTL + (if wired) egress, not by
// in-process sandboxing. See [[prx-capability-enforcement-level]].

import { SlackReadError } from "./types.ts";
import type { SlackReadOp } from "./types.ts";

/** The authority a single minted key grants — least authority by construction. */
export interface SlackKeyScope {
  /** Read ops this key authorizes. A `history` key cannot list `users`. */
  ops: readonly SlackReadOp[];
  /**
   * Channel allowlist. `undefined` = any channel within the root grant;
   * a list = exactly those. Enforced capability-side by {@link ScopedSlackKey.authorize}.
   */
  channels?: readonly string[] | undefined;
}

/** Request the transport hands to `authorize()` for credential injection. */
export interface SlackRequest {
  url?: string | undefined;
  headers?: Record<string, string> | undefined;
}

/** A request after the key has injected its authorization (e.g. bearer header). */
export interface AuthorizedSlackRequest extends SlackRequest {
  headers: Record<string, string>;
}

/**
 * A minted credential capability — *use, don't read*. Self-expiring and
 * scope-self-enforcing: `authorize()` throws (SCOPE_DENIED / KEY_EXPIRED) for
 * any op/channel outside {@link scope} or past {@link expiresAt}. The secret is
 * never exposed; `keyId` is a provenance handle (anchored into the read's
 * Derivation), NOT the credential itself.
 */
export interface ScopedSlackKey {
  /** Stable, non-secret identifier for provenance attribution. */
  readonly keyId: string;
  readonly scope: SlackKeyScope;
  /** Expiry, epoch ms. Real TTL via Slack OAuth token rotation (spike prx-5u1). */
  readonly expiresAt: number;
  /**
   * Attach authorization to a request, refusing out-of-scope or expired use.
   * @throws SlackReadError SCOPE_DENIED | KEY_EXPIRED
   */
  authorize(
    op: SlackReadOp,
    channel: string | undefined,
    req: SlackRequest,
  ): AuthorizedSlackRequest;
}

/** A request to mint a key: the scope to grant and how long it lives. */
export interface SlackKeyGrant {
  scope: SlackKeyScope;
  /** Time-to-live in ms; the keymaker stamps `expiresAt = now + ttlMs`. */
  ttlMs: number;
}

/**
 * The broker. Holds root authority (in its closure) and mints least-authority,
 * expiring keys on demand. Lives only in the composition root (the `prx slack`
 * verb); the read core receives a keymaker, never the root secret.
 */
export interface SlackKeymaker {
  mint(grant: SlackKeyGrant): ScopedSlackKey;
}

// ── slack-typed scope wrapper over a generic credential keymaker ────────────
//
// The secret stays out of this package: the slack keymaker WRAPS an opaque
// "base" credential keymaker (structurally `@bounded-systems/auth`'s
// CredentialKeymaker — but imported by VALUE nowhere here, only matched by
// shape) and adds the slack-specific scope typing + op/channel enforcement.
// The base holds the root token in its closure and does TTL + auth injection;
// this layer only knows ops/channels. Composition root wires them:
//   slackScopedKeymaker(createServiceKeymaker("slack"))

/** A minted base credential (structural mirror of auth's ScopedCredential). */
export interface BaseScopedCredential {
  readonly keyId: string;
  readonly expiresAt: number;
  authorize(req: SlackRequest): AuthorizedSlackRequest;
}

/** A generic credential keymaker (structural mirror of auth's CredentialKeymaker). */
export interface BaseKeymaker {
  mint(grant: { ttlMs: number; keyId?: string | undefined }): BaseScopedCredential;
}

export interface SlackScopedKeymakerOptions {
  /** Injectable clock for the scope-layer expiry check. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Wrap a generic credential keymaker into a slack-scoped one. The returned
 * keymaker mints a `ScopedSlackKey` whose `authorize()` enforces, in order:
 * not expired → op in scope → channel in scope, then delegates credential
 * injection to the base. Scope is refused (SCOPE_DENIED) BEFORE the credential
 * is touched, so an out-of-grant request never reaches the secret.
 */
export function slackScopedKeymaker(
  base: BaseKeymaker,
  opts: SlackScopedKeymakerOptions = {},
): SlackKeymaker {
  const now = opts.now ?? (() => Date.now());
  return {
    mint(grant: SlackKeyGrant): ScopedSlackKey {
      const credential = base.mint({ ttlMs: grant.ttlMs });
      const scope = grant.scope;
      return {
        keyId: credential.keyId,
        scope,
        expiresAt: credential.expiresAt,
        authorize(
          op: SlackReadOp,
          channel: string | undefined,
          req: SlackRequest,
        ): AuthorizedSlackRequest {
          if (now() >= credential.expiresAt) {
            throw new SlackReadError(
              `slack key ${credential.keyId} expired`,
              "KEY_EXPIRED",
            );
          }
          if (!scope.ops.includes(op)) {
            throw new SlackReadError(
              `slack key ${credential.keyId} is not scoped for op '${op}'`,
              "SCOPE_DENIED",
            );
          }
          if (
            scope.channels !== undefined &&
            channel !== undefined &&
            !scope.channels.includes(channel)
          ) {
            throw new SlackReadError(
              `slack key ${credential.keyId} is not scoped for channel '${channel}'`,
              "SCOPE_DENIED",
            );
          }
          return credential.authorize(req);
        },
      };
    },
  };
}
