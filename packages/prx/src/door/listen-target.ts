/**
 * Resolve a door endpoint string to a `Bun.listen` target — shared by every
 * door daemon that serves over the guest-room protocol (keeperd, ghappd).
 *
 * A leading `/` (or a `unix://` prefix) is a unix socket path; otherwise it is a
 * `host:port` TCP target (an optional `tcp://` prefix is stripped). Symmetric
 * with guest-room's client-side `connectTarget`, so the same endpoint string
 * configures both ends.
 */
export type ListenTarget = { unix: string } | { hostname: string; port: number };

export function listenTarget(endpoint: string): ListenTarget {
  const stripped = endpoint.replace(/^unix:\/\//, "");
  if (!stripped.startsWith("/")) {
    const m = stripped.replace(/^tcp:\/\//, "").match(/^([^/\s]+):(\d{1,5})$/);
    if (m) return { hostname: m[1]!, port: Number(m[2]) };
  }
  return { unix: stripped };
}
