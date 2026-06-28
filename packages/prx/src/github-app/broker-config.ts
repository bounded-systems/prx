// Resolve whether a GitHub App is configured for prx, and into what credentials.
// Fail-open by design: when nothing is configured we return null and prx keeps
// using the operator's personal `gh` auth. See ./apply.ts for the startup glue
// and ./broker.ts for the minting cache.
//
// Reads env via @bounded-systems/env (the ambient-authority seam — never the
// raw global). The only filesystem need (reading a PEM file) is injected as
// `readFile`, defaulted at the CLI script edge, so this module imports no
// node:fs and stays pure/extractable.
import { getEnv as defaultGetEnv } from "@bounded-systems/env";

/** The bounded-systems org installation of the bounded-systems-prx app. */
const DEFAULT_INSTALLATION_ID = "138039680";

/** Resolved App credentials, ready for ./broker.ts. `privateKeyPem` is secret. */
export interface BrokerConfig {
  /** App ID or Client ID — GitHub honors either as the JWT `iss`. */
  readonly issuer: string;
  /** The App private-key PEM contents (never logged). */
  readonly privateKeyPem: string;
  readonly installationId: string;
  /** Where the PEM came from — non-secret, for diagnostics. */
  readonly source: "inline" | "file";
  /** Optional least-privilege attenuation (PRX_GH_APP_REPOSITORIES, comma-sep). */
  readonly repositories?: readonly string[];
  /** Optional least-privilege attenuation (PRX_GH_APP_PERMISSIONS, JSON object). */
  readonly permissions?: Readonly<Record<string, string>>;
}

export interface ResolveBrokerConfigDeps {
  /** Env reader seam; defaults to @bounded-systems/env getEnv. */
  readonly getEnv?: (key: string) => string | undefined;
  /** fs-seam: read the PEM file. Injected so this module imports no node:fs. */
  readonly readFile?: (path: string) => string;
}

/** Thrown when the App is configured but the credentials are unusable. */
export class BrokerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerConfigError";
  }
}

/**
 * Returns null when NO App is configured (fail-open). Throws BrokerConfigError
 * only when an issuer IS set but no private key resolves — a misconfiguration
 * the operator must see, not silently degrade past.
 *
 * PEM precedence: inline env (PRX_GH_APP_PRIVATE_KEY — the cloud-agent shape,
 * secrets injected as env vars) wins over a file path (PRX_GH_APP_KEY_FILE —
 * the nix/VM/podman-tmpfs shape).
 */
export function resolveBrokerConfig(deps: ResolveBrokerConfigDeps = {}): BrokerConfig | null {
  const getEnv = deps.getEnv ?? defaultGetEnv;

  const issuer = getEnv("PRX_GH_APP_ID") ?? getEnv("PRX_GH_APP_CLIENT_ID");
  if (!issuer) return null; // fail-open: prx uses personal `gh` auth

  const inline = getEnv("PRX_GH_APP_PRIVATE_KEY");
  const keyFile = getEnv("PRX_GH_APP_KEY_FILE");

  let privateKeyPem: string;
  let source: "inline" | "file";
  if (inline && inline.trim().length > 0) {
    privateKeyPem = inline;
    source = "inline";
  } else if (keyFile) {
    if (!deps.readFile) {
      throw new BrokerConfigError(
        "PRX_GH_APP_KEY_FILE is set but no readFile dependency was provided to read it",
      );
    }
    try {
      privateKeyPem = deps.readFile(keyFile);
    } catch (e) {
      throw new BrokerConfigError(
        `cannot read PRX_GH_APP_KEY_FILE (${keyFile}): ${(e as Error).message}`,
      );
    }
    source = "file";
  } else {
    throw new BrokerConfigError(
      "PRX_GH_APP_ID is set but neither PRX_GH_APP_PRIVATE_KEY nor PRX_GH_APP_KEY_FILE resolves a key",
    );
  }

  const installationId = getEnv("PRX_GH_INSTALLATION_ID") ?? DEFAULT_INSTALLATION_ID;

  // Optional least-privilege attenuation. Both default to absent (full
  // installation scope) so the broker stays back-compatible when unset.
  const reposRaw = getEnv("PRX_GH_APP_REPOSITORIES");
  const repositories = reposRaw
    ? reposRaw.split(",").map((r) => r.trim()).filter((r) => r.length > 0)
    : undefined;

  const permsRaw = getEnv("PRX_GH_APP_PERMISSIONS");
  let permissions: Record<string, string> | undefined;
  if (permsRaw) {
    try {
      permissions = JSON.parse(permsRaw) as Record<string, string>;
    } catch (e) {
      throw new BrokerConfigError(
        `PRX_GH_APP_PERMISSIONS is not valid JSON: ${(e as Error).message}`,
      );
    }
  }

  return {
    issuer,
    privateKeyPem,
    installationId,
    source,
    ...(repositories && repositories.length > 0 ? { repositories } : {}),
    ...(permissions ? { permissions } : {}),
  };
}
