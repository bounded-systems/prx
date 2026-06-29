// forge-d door endpoint default. The agent-side reader is the broker's door
// backend (../github-app/door-source via apply.ts `PRX_FORGE_DOOR`); this is the
// catalog's host default, symmetric to ../keeperd/endpoint.

/** Default local forge-d socket (override with `PRX_FORGE_DOOR`). */
export const DEFAULT_LOCAL_FORGE_SOCKET = "/tmp/prx-forge-d.sock";
