/**
 * Persistence for the dev provenance identity (GH-2282).
 *
 * The `dev` signing mode (`PRX_PROVENANCE_KEY=dev`) used to mint a fresh,
 * ephemeral ed25519 keypair on every resolution — *signed* but NOT
 * cross-process verifiable, because the verifying key died with the call that
 * minted it. That is fine for emit-only Phase A, but it means there is no
 * zero-config way to exercise the full sign → enforce → verify loop locally or
 * in CI: you had to hand-mint an `ed25519:<seed>` and wire two env vars.
 *
 * This module closes that gap by persisting a STABLE dev keypair under the prx
 * state dir (`<state>/prx/provenance/dev-ed25519.json`), generate-on-first-use
 * and reuse thereafter. It is the *only* place — alongside {@link
 * ./signer.ts} — that reads `PRX_PROVENANCE_*` / state-dir env; the extractable
 * `@bounded-systems/anchored-chain` core stays a pure `Signer`/`Verifier` seam
 * with no env or filesystem reads.
 *
 * The on-disk file is mutable *named* state (NOT a CAS blob — do not route it
 * through `plan-store/writeBlob`). It is written with the same atomic discipline
 * as the CAS substrate: tmp in a scratch dir → fsync → chmod 0o600 →
 * `renameSync` → directory fsync. After a rename we re-read the persisted file
 * and adopt its material, so concurrent first-use generators converge on the
 * rename winner rather than diverging.
 *
 * A malformed file is a HARD ERROR, never a silent regenerate — consistent with
 * the verifier's "a misconfigured key is a hard error, not a fail-open" stance.
 */

import {
  generateEd25519Keypair,
  importEd25519PrivateKey,
  importEd25519PublicKey,
  ed25519Keyid,
  type Ed25519Keypair,
} from "@bounded-systems/anchored-chain";
import { getEnv } from "@bounded-systems/env";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { randomBytes, type KeyObject } from "node:crypto";
import { dirname, join } from "node:path";

/** Subdirectory (under `<state>/prx/`) that holds the persisted dev identity. */
export const DEV_KEY_DIR = "provenance";

/** Filename of the persisted dev keypair within {@link DEV_KEY_DIR}. */
export const DEV_KEY_FILE = "dev-ed25519.json";

export class DevKeyError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "DevKeyError";
    this.code = code;
  }
}

/**
 * On-disk shape of the persisted dev keypair. `seed`/`point` are base64 raw
 * 32-byte ed25519 material so they round-trip through the core import helpers.
 *
 * Validated by hand rather than with Zod: the `src/provenance/` modules are
 * deliberately Zod-free (see the note in `slsa.ts`) so they stay close to the
 * extractable `@bounded-systems/anchored-chain` core, and the shape here is a
 * flat record of four non-empty strings — not worth a schema dependency.
 */
export interface DevKeyFile {
  seed: string;
  point: string;
  keyid: string;
  createdAt: string;
}

const DEV_KEY_STRING_FIELDS = ["seed", "point", "keyid", "createdAt"] as const;

/** Narrow unknown parsed JSON to a {@link DevKeyFile}, or throw on any deviation. */
function parseDevKeyFile(json: unknown, path: string): DevKeyFile {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new DevKeyError(
      `dev key file ${path} is not a JSON object`,
      "MALFORMED",
    );
  }
  const rec = json as Record<string, unknown>;
  for (const field of DEV_KEY_STRING_FIELDS) {
    if (typeof rec[field] !== "string" || (rec[field] as string).length === 0) {
      throw new DevKeyError(
        `dev key file ${path} is missing or has an invalid '${field}' field`,
        "MALFORMED",
      );
    }
  }
  return {
    seed: rec.seed as string,
    point: rec.point as string,
    keyid: rec.keyid as string,
    createdAt: rec.createdAt as string,
  };
}

/** The resolved dev keypair: live `KeyObject`s plus the base64 public point. */
export interface DevKeypair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly keyid: string;
  /** base64 raw 32-byte public point — what a verifier env var would carry. */
  readonly point: string;
}

export interface DevKeyPathResolution {
  path: string;
  source: "XDG_STATE_HOME" | "XDG_STATE_HOME (default)";
}

/**
 * Resolve the absolute path to the persisted dev keypair, and label which
 * precedence branch fired. Precedence mirrors the per-operator state tier used
 * by the CAS substrate (`resolveStoreRootForDisplay`):
 *
 *   1. XDG_STATE_HOME           → <state>/prx/provenance/dev-ed25519.json
 *   2. HOME (.local/state)      → <home>/.local/state/prx/provenance/dev-ed25519.json
 *
 * `env` is injectable so tests point `XDG_STATE_HOME` at a temp dir without
 * mutating the real process environment. Deliberately narrower than the CAS
 * chain (no `PRX_CAS_ROOT` / `PRX_PLAN_STORE` overrides): the dev key is a
 * per-operator development convenience, not a relocatable content store.
 */
export function resolveDevKeyPathForDisplay(
  env: (key: string) => string | undefined = getEnv,
): DevKeyPathResolution {
  const xdgStateHome = env("XDG_STATE_HOME");
  if (xdgStateHome && xdgStateHome.length > 0) {
    return {
      path: join(xdgStateHome, "prx", DEV_KEY_DIR, DEV_KEY_FILE),
      source: "XDG_STATE_HOME",
    };
  }
  const home = env("HOME");
  if (home && home.length > 0) {
    return {
      path: join(home, ".local", "state", "prx", DEV_KEY_DIR, DEV_KEY_FILE),
      source: "XDG_STATE_HOME (default)",
    };
  }
  throw new DevKeyError(
    "no prx state root for the dev provenance key: set XDG_STATE_HOME or HOME",
    "NO_STATE_ROOT",
  );
}

/** Resolve just the path to the persisted dev keypair (see {@link resolveDevKeyPathForDisplay}). */
export function resolveDevKeyPath(
  env: (key: string) => string | undefined = getEnv,
): string {
  return resolveDevKeyPathForDisplay(env).path;
}

/** base64 raw 32-byte seed for an ed25519 private `KeyObject`. */
function rawSeedBase64(privateKey: KeyObject): string {
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string };
  if (typeof jwk.d !== "string") {
    throw new DevKeyError("ed25519 private key has no seed", "INVALID_KEY");
  }
  return Buffer.from(jwk.d, "base64url").toString("base64");
}

/** base64 raw 32-byte point for an ed25519 public `KeyObject`. */
function rawPointBase64(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
  if (typeof jwk.x !== "string") {
    throw new DevKeyError("ed25519 public key has no point", "INVALID_KEY");
  }
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

function devKeyFileFromKeypair(kp: Ed25519Keypair): DevKeyFile {
  return {
    seed: rawSeedBase64(kp.privateKey),
    point: rawPointBase64(kp.publicKey),
    keyid: kp.keyid,
    createdAt: new Date().toISOString(),
  };
}

function adoptDevKeyFile(file: DevKeyFile, path: string): DevKeypair {
  const privateKey = importEd25519PrivateKey(file.seed);
  const publicKey = importEd25519PublicKey(file.point);
  // Re-derive the keyid from the public half and cross-check the persisted
  // value: a mismatch means the file's keyid does not bind its own material, so
  // an emitter and verifier reading it would disagree. Hard error, not silent.
  const derivedKeyid = ed25519Keyid(publicKey);
  if (derivedKeyid !== file.keyid) {
    throw new DevKeyError(
      `dev key file ${path} keyid does not match its public point`,
      "KEYID_MISMATCH",
    );
  }
  return { privateKey, publicKey, keyid: file.keyid, point: file.point };
}

function readDevKeyFile(path: string): DevKeyFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new DevKeyError(
      `failed to read dev key file ${path}: ${(err as Error).message}`,
      "IO_ERROR",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DevKeyError(
      `dev key file ${path} is not valid JSON`,
      "MALFORMED",
    );
  }
  return parseDevKeyFile(json, path);
}

function writeDevKeyFileAtomic(path: string, file: DevKeyFile): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.dev-ed25519-${randomBytes(8).toString("hex")}.tmp`);
  const buf = Buffer.from(`${JSON.stringify(file, null, 2)}\n`, "utf8");
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < buf.length) {
      const written = writeSync(fd, buf, offset, buf.length - offset);
      if (written <= 0) {
        throw new DevKeyError("short write to dev key tmp file", "IO_ERROR");
      }
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  fsyncDir(dir);
}

function fsyncDir(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Best-effort: directory fsync semantics differ across platforms (e.g.
    // EINVAL on some macOS setups). The rename itself is already atomic.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Load the persisted dev keypair, or generate + persist one on first use, then
 * return the adopted material. The signing run and a later verifying run both
 * call this and converge on the SAME stable keypair, so a dev-emitted
 * derivation is verifiable in a separate process (the I-PROV1 invariant,
 * extended to dev mode).
 *
 * Concurrency: if two processes race to first-use, each writes to its own tmp
 * file; whichever `rename` wins becomes the persisted file, and BOTH re-read it
 * and adopt the winner — they never diverge. A malformed existing file throws
 * (it is never silently overwritten).
 */
export function loadOrCreateDevKeypair(
  env: (key: string) => string | undefined = getEnv,
): DevKeypair {
  const path = resolveDevKeyPath(env);
  if (existsSync(path)) {
    return adoptDevKeyFile(readDevKeyFile(path), path);
  }
  const file = devKeyFileFromKeypair(generateEd25519Keypair());
  writeDevKeyFileAtomic(path, file);
  // Re-read after the rename so a concurrent generator's winning file (not our
  // in-memory candidate) is the one we adopt.
  return adoptDevKeyFile(readDevKeyFile(path), path);
}
