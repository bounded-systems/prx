// A1 of the prx→guest-room convergence (see .github-private
// docs/convergence-prx-claude-box.md): describe prx's keeper door using the
// published @bounded-systems/guest-room capability model instead of an ad-hoc
// local description. This is the first real dependency edge from prx onto
// guest-room — the same model that powers claude-box now describes prx's door.
//
// Scope: ADDITIVE. It does not change the keeperd transport (still the bespoke
// client in ../keeperd/); it makes the door's *definition + rulebook* come from
// the guest-room contract. The endpoint env stays sourced from
// ../keeperd/endpoint.ts, so there is still one source of truth for the socket.

import {
  capabilityPreamble,
  deniedDoors,
  type DoorCatalog,
  type DoorGrant,
  deniedDoorSection,
  type Env,
  grantedDoorLines,
  resolveDoor,
} from "@bounded-systems/guest-room";
import { processEnv } from "@bounded-systems/env";

import { DEFAULT_LOCAL_KEEPER_SOCKET } from "../keeperd/endpoint.ts";

/**
 * prx's door catalog, expressed in the guest-room model. Today it is the keeper
 * door (signed git-writes via keeperd); the other prx doors (beads, …) join here
 * as they move onto the runtime.
 */
export const prxDoorCatalog: DoorCatalog = {
  keeper: {
    flag: "--keeper",
    inBox: "/run/prx/doors/keeperd.sock",
    env: "PRX_KEEPER_SOCKET",
    hostDefault: DEFAULT_LOCAL_KEEPER_SOCKET,
    grants: "signed git writes via keeperd",
    use: "Route every git write through the keeper door; keeperd imports the commit and performs the signed push.",
    deny: "No git-write authority in this room — relaunch with the keeper door.",
  },
};

/** Resolve prx's keeper door to a concrete grant via the guest-room engine. */
export function keeperDoorGrant(env: Env = processEnv()): DoorGrant {
  return resolveDoor(prxDoorCatalog, "keeper", undefined, env);
}

/**
 * Render the honest rulebook for a prx room over the given granted doors, using
 * guest-room's renderer: the capability preamble, a card per granted door, and
 * the denied section — so the surface is honest about what is absent, not only
 * what is present.
 */
export function renderPrxRulebook(
  workcell: string,
  grantedDoorNames: readonly string[],
  env: Env = processEnv(),
): string {
  const granted = grantedDoorNames.map((n) => resolveDoor(prxDoorCatalog, n, undefined, env));
  const denied = deniedDoors(prxDoorCatalog, new Set(grantedDoorNames));
  return [
    ...capabilityPreamble(workcell),
    ...grantedDoorLines(granted),
    ...deniedDoorSection(denied),
  ].join("\n");
}
