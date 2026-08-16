// forge-d caveat enforcement (prx-0wsf): narrows what a signed grant may
// request, not just who may present it. `buildForgeAuthorizer` (grant-gate.ts)
// only checks signature/audience/exp/door — a grant that passes it could
// otherwise lease a token for ANY repositories/permissions the installation
// holds. This closes that gap using guest-room's existing macaroon-style
// caveat system (`checkCaveats`) — no new JWT/claims format needed.
import { checkCaveats, type CaveatVerifiers } from "@bounded-systems/guest-room";
import type { RequestAuthorizer, RequestEnvelope } from "@bounded-systems/guest-room/protocol";

/** The subset of a lease request a caveat verifier judges. */
export interface ForgeDCaveatContext {
  readonly repositories?: string[];
  readonly permissions?: Record<string, string>;
}

function caveatSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Caveat verifiers for forge-d lease requests. Each caveat owns its value
 * grammar — a comma-separated OR-set, per guest-room's documented convention:
 *   - `repos=<owner/repo>,...`  every requested repository must be in the set
 *   - `perms=<key>:<value>,...` every requested permission entry must be in it
 *
 * A grant with neither caveat is unattenuated (the installation's full
 * scope, unchanged from before this existed). A grant that DOES carry one of
 * these caveats denies a request that omits the corresponding field — asking
 * for "everything" must not be a way to bypass narrowing by omission.
 */
export const FORGE_D_CAVEAT_VERIFIERS: CaveatVerifiers<ForgeDCaveatContext> = {
  repos: (value, ctx) => {
    const allowed = caveatSet(value);
    const requested = ctx.repositories ?? [];
    return requested.length > 0 && requested.every((r) => allowed.has(r));
  },
  perms: (value, ctx) => {
    const allowed = caveatSet(value);
    const requested = Object.entries(ctx.permissions ?? {});
    return requested.length > 0 && requested.every(([k, v]) => allowed.has(`${k}:${v}`));
  },
};

/**
 * Wrap forge-d's base `RequestAuthorizer` (signature/audience/exp/door) with
 * caveat enforcement: the base check runs first — a bad grant is denied
 * before its caveats are even read — then the presented grant's caveats are
 * checked against the request's `repositories`/`permissions`, the exact
 * fields `handleForgeDRequest` forwards unmodified into the minted
 * installation token. This is what makes a `repos=`/`perms=`-attenuated grant
 * actually narrow what can be minted, not just who may ask.
 */
export function withForgeCaveats(base: RequestAuthorizer): RequestAuthorizer {
  return (req: RequestEnvelope) => {
    if (!base(req)) return false;
    if (!req.grant) return false;
    const repositories = req.params?.repositories as string[] | undefined;
    const permissions = req.params?.permissions as Record<string, string> | undefined;
    const ctx: ForgeDCaveatContext = {
      ...(repositories ? { repositories } : {}),
      ...(permissions ? { permissions } : {}),
    };
    return checkCaveats(req.grant, ctx, FORGE_D_CAVEAT_VERIFIERS).ok;
  };
}
