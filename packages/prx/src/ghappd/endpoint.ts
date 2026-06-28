// ghappd door endpoint default. The agent-side reader is the broker's door
// backend (../github-app/door-source via apply.ts `PRX_GH_APP_DOOR`); this is the
// catalog's host default, symmetric to ../keeperd/endpoint.

/** Default local ghappd socket (override with `PRX_GH_APP_DOOR`). */
export const DEFAULT_LOCAL_GHAPP_SOCKET = "/tmp/prx-ghappd.sock";
