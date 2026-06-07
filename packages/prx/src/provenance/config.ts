/**
 * prx-keymaker slice 3: the deployment-secret seam + the public trust map.
 *
 * "More deployment, less config." The split:
 *   - the per-actor signing MASTER is a *deployment secret* — sops/agenix
 *     decrypts it to a runtime file at `home-manager switch`; prx reads it from
 *     {@link resolveProvenanceMaster}. It is NEVER in config, never in the nix
 *     store world-readable, never in env (the env carries only a *path*).
 *   - the trust map (actor → PUBLIC key) is declarative config — safe to commit,
 *     read by {@link readProvenanceTrustMap}. Public keys verify; they don't sign.
 *
 * The dev path stays the zero-config fallback: with no secret file configured,
 * the master is the persisted dev seed (`loadOrCreateDevMaster`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { getEnv } from "@bounded-systems/env";

import { loadOrCreateDevMaster } from "./dev-key.ts";

/** Env var pointing at the decrypted per-actor master secret (sops/agenix target). */
export const PROVENANCE_MASTER_FILE_ENV = "PRX_PROVENANCE_MASTER_FILE";

/** The `~/.config/prx/config.json` path (where the public trust map lives). */
export function provenanceConfigPath(env: EnvReader = getEnv): string {
  const home = env("HOME") ?? homedir();
  return join(home, ".config", "prx", "config.json");
}

type EnvReader = (key: string) => string | undefined;

interface ProvenanceConfigBlock {
  /** Path to the deployment-secret master (overridden by the env var). */
  masterFile?: string;
  /** actor → `ed25519:<base64 pub>` — the public verification keys. */
  trust?: Record<string, string>;
}

/** Read `~/.config/prx/config.json` `provenance` block (public material only). */
export function readProvenanceConfig(
  env: EnvReader = getEnv,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
  exists: (path: string) => boolean = existsSync,
): ProvenanceConfigBlock {
  const home = env("HOME") ?? homedir();
  if (!home) return {};
  const path = join(home, ".config", "prx", "config.json");
  if (!exists(path)) return {};
  try {
    const parsed = JSON.parse(read(path)) as { provenance?: ProvenanceConfigBlock };
    return parsed.provenance ?? {};
  } catch {
    // A malformed config must not break signing/verification — treat as absent.
    return {};
  }
}

/** The actor → public-key trust map (config), or `{}` when unconfigured. */
export function readProvenanceTrustMap(
  env: EnvReader = getEnv,
  read?: (path: string) => string,
  exists?: (path: string) => boolean,
): Record<string, string> {
  return readProvenanceConfig(env, read, exists).trust ?? {};
}

/**
 * Resolve the per-actor signing master. Precedence:
 *   1. `PRX_PROVENANCE_MASTER_FILE` (the deployment-secret path) — env wins.
 *   2. `provenance.masterFile` in `~/.config/prx/config.json`.
 *   3. the persisted dev seed (`loadOrCreateDevMaster`) — the zero-config dev
 *      fallback.
 * The secret file holds base64 key material (a 32-byte master); a missing or
 * unreadable configured file falls through to the dev master rather than
 * throwing, so a half-provisioned deploy degrades to dev rather than failing.
 */
/** Where the resolved master comes from — for `prx provenance status`. Mirrors
 *  the precedence in {@link resolveProvenanceMaster} without reading the bytes. */
export function resolveMasterSource(
  env: EnvReader = getEnv,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
  exists: (path: string) => boolean = existsSync,
): { source: "operator-file" | "config-file" | "dev-bootstrap"; path: string | null } {
  const envFile = env(PROVENANCE_MASTER_FILE_ENV);
  if (envFile && exists(envFile)) return { source: "operator-file", path: envFile };
  const cfgFile = readProvenanceConfig(env, read, exists).masterFile;
  if (cfgFile && exists(cfgFile)) return { source: "config-file", path: cfgFile };
  return { source: "dev-bootstrap", path: null };
}

export function resolveProvenanceMaster(
  env: EnvReader = getEnv,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
  exists: (path: string) => boolean = existsSync,
): Buffer {
  const file = env(PROVENANCE_MASTER_FILE_ENV) ?? readProvenanceConfig(env, read, exists).masterFile;
  if (file && exists(file)) {
    try {
      return Buffer.from(read(file).trim(), "base64");
    } catch {
      // fall through to dev master
    }
  }
  return loadOrCreateDevMaster(env);
}

/**
 * Merge a trust map into `provenance.trust` in `~/.config/prx/config.json`,
 * preserving every other field (other repo-inventory keys, `provenance.masterFile`).
 * Returns the config path written. The keymaker `register` verb's only effect.
 */
export function writeProvenanceTrustMap(
  trust: Record<string, string>,
  env: EnvReader = getEnv,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
  exists: (path: string) => boolean = existsSync,
  write: (path: string, data: string) => void = (p, d) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, d);
  },
): string {
  const path = provenanceConfigPath(env);
  let config: Record<string, unknown> = {};
  if (exists(path)) {
    try {
      config = JSON.parse(read(path)) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }
  const prov =
    typeof config.provenance === "object" && config.provenance !== null
      ? (config.provenance as Record<string, unknown>)
      : {};
  config.provenance = { ...prov, trust };
  write(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}
