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
   * Org / workspace allowlist — Slack team (`T…`) or enterprise (`E…`) id. The
   * broadest target dimension (org ⊃ channel ⊃ thread). `undefined` = any org
   * within the root grant; a list = exactly those. This is the seam slackd
   * (prx-tgy) mints an org-scoped grant against.
   */
  orgs?: readonly string[] | undefined;
  /**
   * Channel allowlist. `undefined` = any channel within the root grant;
   * a list = exactly those. Enforced capability-side by {@link ScopedSlackKey.authorize}.
   */
  channels?: readonly string[] | undefined;
  /**
   * Thread allowlist — parent-message ts of a `conversations.replies` read.
   * The narrowest dimension. `undefined` = any thread within the channel grant;
   * a list = exactly those.
   */
  threads?: readonly string[] | undefined;
}

/**
 * What a single read targets — the context {@link ScopedSlackKey.authorize}
 * checks against the key's {@link SlackKeyScope}. `org`/`channel`/`thread` are
 * each `undefined` when the read doesn't reach that level (a `users` read has
 * no channel; a single-workspace token may declare no org). An undefined
 * target dimension is unconstrained — uniform across all three (org ⊃ channel
 * ⊃ thread).
 */
export interface SlackAuthTarget {
  op: SlackReadOp;
  org?: string | undefined;
  channel?: string | undefined;
  thread?: string | undefined;
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
 * any op/org/channel/thread outside {@link scope} or past {@link expiresAt}.
 * The secret is never exposed; `keyId` is a provenance handle (anchored into
 * the read's Derivation), NOT the credential itself.
 */
export interface ScopedSlackKey {
  /** Stable, non-secret identifier for provenance attribution. */
  readonly keyId: string;
  readonly scope: SlackKeyScope;
  /** Expiry, epoch ms. Real TTL via Slack OAuth token rotation (spike prx-5u1). */
  readonly expiresAt: number;
  /**
   * Attach authorization to a request, refusing expired or out-of-scope use.
   * The {@link SlackAuthTarget} carries the op + the org/channel/thread the
   * read reaches; each dimension is checked against {@link scope}.
   * @throws SlackReadError SCOPE_DENIED | KEY_EXPIRED
   */
  authorize(target: SlackAuthTarget, req: SlackRequest): AuthorizedSlackRequest;
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
        authorize(target: SlackAuthTarget, req: SlackRequest): AuthorizedSlackRequest {
          if (now() >= credential.expiresAt) {
            throw new SlackReadError(`slack key ${credential.keyId} expired`, "KEY_EXPIRED");
          }
          if (!scope.ops.includes(target.op)) {
            throw new SlackReadError(
              `slack key ${credential.keyId} is not scoped for op '${target.op}'`,
              "SCOPE_DENIED",
            );
          }
          // org ⊃ channel ⊃ thread. Refuse only when the key constrains a
          // dimension AND the read targets it — an undefined scope (any) or an
          // undefined target (level not reached) passes. Same rule for all three.
          const denyIfOutside = (
            dim: "org" | "channel" | "thread",
            allow: readonly string[] | undefined,
            value: string | undefined,
          ): void => {
            if (allow !== undefined && value !== undefined && !allow.includes(value)) {
              throw new SlackReadError(
                `slack key ${credential.keyId} is not scoped for ${dim} '${value}'`,
                "SCOPE_DENIED",
              );
            }
          };
          denyIfOutside("org", scope.orgs, target.org);
          denyIfOutside("channel", scope.channels, target.channel);
          denyIfOutside("thread", scope.threads, target.thread);
          return credential.authorize(req);
        },
      };
    },
  };
}
