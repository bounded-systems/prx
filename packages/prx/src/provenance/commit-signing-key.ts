/**
 * prx-e7cl: prx's OWN commit-signing key — internal to prx, never the host's
 * `~/.ssh` or a cloud KMS.
 *
 * Mirrors {@link ./dev-key.ts}: a dedicated ed25519 SSH key persisted under the
 * prx state dir (`<state>/prx/signing/id_ed25519`), generate-on-first-use via
 * `ssh-keygen` (through the proc seam — no hand-rolled OpenSSH crypto), reused
 * thereafter. Its path becomes `PRX_COMMIT_SIGNING_KEY`, so the
 * `@bounded-systems/git` seam SSH-signs every keeper commit/tag/commit-tree
 * headlessly — no operator agent, no 1Password.
 *
 * Register the printed PUBLIC key with GitHub ONCE for the "Verified" badge; the
 * PRIVATE key never leaves the prx state dir (written `0o600`). This is the only
 * separate identity from the ed25519 provenance chain — git verified-signatures
 * and provenance attestation are different concerns.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getEnv } from "@bounded-systems/env";
import { spawnCapture } from "@bounded-systems/proc";

/** Subdirectory (under `<state>/prx/`) that holds the commit-signing key. */
export const SIGNING_KEY_DIR = "signing";
/** Filename of the ed25519 SSH private key within {@link SIGNING_KEY_DIR}. */
export const SIGNING_KEY_FILE = "id_ed25519";

export class CommitSigningKeyError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "CommitSigningKeyError";
    this.code = code;
  }
}

export interface CommitSigningKey {
  /** Absolute path to the ed25519 SSH PRIVATE key — the `PRX_COMMIT_SIGNING_KEY` value. */
  readonly privateKeyPath: string;
  /** The OpenSSH PUBLIC key line — register this with GitHub for verified signatures. */
  readonly publicKey: string;
}

/** Mints an ed25519 SSH key at `path` (+ `path.pub`). Injectable for tests. */
export type Keygen = (path: string) => void;

/** Precedence mirrors {@link ./dev-key.ts}: XDG_STATE_HOME, else HOME/.local/state. */
function resolveSigningDir(env: (key: string) => string | undefined): string {
  const xdg = env("XDG_STATE_HOME");
  if (xdg && xdg.length > 0) return join(xdg, "prx", SIGNING_KEY_DIR);
  const home = env("HOME");
  if (home && home.length > 0) return join(home, ".local", "state", "prx", SIGNING_KEY_DIR);
  throw new CommitSigningKeyError(
    "no prx state root for the commit-signing key: set XDG_STATE_HOME or HOME",
    "NO_STATE_ROOT",
  );
}

/** Absolute path to prx's commit-signing private key (whether or not it exists yet). */
export function resolveCommitSigningKeyPath(
  env: (key: string) => string | undefined = getEnv,
): string {
  return join(resolveSigningDir(env), SIGNING_KEY_FILE);
}

/** Mint an ed25519 SSH key at `path` via ssh-keygen (no passphrase, headless). */
const sshKeygen: Keygen = (path) => {
  const res = spawnCapture(
    ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "prx-keeper-commit-signing", "-f", path],
    {},
  );
  if (res.status !== 0) {
    throw new CommitSigningKeyError(
      `ssh-keygen failed (status ${res.status ?? "null"}): ${res.stderr.trim()}`,
      "KEYGEN_FAILED",
    );
  }
};

/**
 * prx's own commit-signing key: load the persisted one, or generate + persist it
 * on first use. Generation writes to a unique temp path then atomically renames
 * into place, so concurrent first-use generators converge on the rename winner
 * rather than clobbering each other.
 */
export function loadOrCreateCommitSigningKey(
  env: (key: string) => string | undefined = getEnv,
  keygen: Keygen = sshKeygen,
): CommitSigningKey {
  const dir = resolveSigningDir(env);
  const keyPath = join(dir, SIGNING_KEY_FILE);
  const pubPath = `${keyPath}.pub`;
  if (existsSync(keyPath) && existsSync(pubPath)) {
    return { privateKeyPath: keyPath, publicKey: readFileSync(pubPath, "utf8").trim() };
  }
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.id_ed25519-${randomBytes(8).toString("hex")}.tmp`);
  const tmpPub = `${tmp}.pub`;
  try {
    keygen(tmp);
    if (!existsSync(keyPath)) renameSync(tmp, keyPath);
    if (!existsSync(pubPath)) renameSync(tmpPub, pubPath);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(tmpPub, { force: true });
  }
  chmodSync(keyPath, 0o600);
  return { privateKeyPath: keyPath, publicKey: readFileSync(pubPath, "utf8").trim() };
}

// Activation note (prx-e7cl): a keeper launch makes signing default-on by
// resolving this key and adding `PRX_COMMIT_SIGNING_KEY` to the *child git env
// object* it builds (`{ ...processEnv(), PRX_COMMIT_SIGNING_KEY: path }`) — never
// by mutating the ambient process environment (the repo-wide guard forbids raw
// env writes in src/; env flows through @bounded-systems/env). That wiring is a
// deliberate follow-up; the keeper already honors the var + fails closed.
