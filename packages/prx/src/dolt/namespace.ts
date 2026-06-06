/**
 * Dolt-database namespace resolver (GH-303).
 *
 * Maps a repo origin slug (`owner/repo`) to the dolt database name. The naming
 * SCHEME is a policy — reverse-DNS (`io_github_<owner>_<repo>`) is the default
 * (a personal config), not a property of bd/dolt — so it lives here, in one
 * pluggable place, rather than baked into the plumbing (`start.ts`,
 * `github.ts`) or, worse, conflated with the SQL-safety guard
 * (`create_database.ts`). bd / dolt / beadsd just receive a resolved name.
 *
 * Two concerns, deliberately separated:
 *   - {@link resolveDoltDatabaseName} — the naming POLICY (swap the scheme).
 *   - {@link isSafeDoltIdentifier} — the SQL-safety CONSTRAINT (always enforced,
 *     scheme-agnostic): the only thing `create_database.ts` actually needs
 *     before interpolating the name into SQL.
 */

/** A naming scheme: repo origin slug (`owner/repo`) → dolt database name. */
export type DoltNamespaceScheme = (originSlug: string) => string;

/**
 * The reverse-DNS scheme (the default / personal config):
 * `bounded-systems/prx` → `io_github_bounded_systems_prx`.
 */
export const reverseDnsScheme: DoltNamespaceScheme = (originSlug) =>
  `io_github_${originSlug.replace(/[/-]/g, "_")}`;

/** The default scheme when a config supplies none. */
export const DEFAULT_NAMESPACE_SCHEME: DoltNamespaceScheme = reverseDnsScheme;

export interface ResolveDoltDatabaseOptions {
  /** Override the naming scheme (e.g. a per-config map `owner/repo → prx`). */
  scheme?: DoltNamespaceScheme | undefined;
}

/**
 * The SQL-safety constraint for a dolt database identifier — scheme-agnostic.
 * Lowercase alphanumeric + underscore, leading alnum: the actual requirement
 * before a name is interpolated into `SHOW DATABASES LIKE '<name>'` / `CREATE
 * DATABASE`. Reverse-DNS names satisfy it; so do plain names like `prx`.
 */
const SAFE_DOLT_IDENTIFIER = /^[a-z0-9][a-z0-9_]*$/;

/** True iff `name` is a safe dolt SQL identifier (the injection guard). */
export function isSafeDoltIdentifier(name: string): boolean {
  return SAFE_DOLT_IDENTIFIER.test(name);
}

/**
 * Resolve a repo origin slug to its dolt database name via the configured
 * scheme (default reverse-DNS). Defensive: a scheme that produces an unsafe
 * identifier is a hard error here, never a name that reaches SQL.
 */
export function resolveDoltDatabaseName(
  originSlug: string,
  opts: ResolveDoltDatabaseOptions = {},
): string {
  const name = (opts.scheme ?? DEFAULT_NAMESPACE_SCHEME)(originSlug);
  if (!isSafeDoltIdentifier(name)) {
    throw new Error(
      `namespace resolver produced an unsafe dolt database name: ${JSON.stringify(name)} ` +
        `(from origin ${JSON.stringify(originSlug)})`,
    );
  }
  return name;
}
