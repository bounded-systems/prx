// Content-addressable storage substrate (GH-1174 → GH-1194). Pure storage
// primitive; no XState wiring, no CLI surface — verb tickets plug in later.
// Domain-keyed: callers pass { domain } to isolate scout://, plan://, etc.
//
// The digest is the one owned by `@bounded-systems/cas` (sha256BareHex) — this is the local,
// on-disk implementation of that substrate's content addressing; a future
// ORAS/registry-backed store is a sibling impl behind the same `BlobStore`
// port. All sha256 in the repo flows through the cas primitive.

import { getEnv } from "@bounded-systems/env";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { sha256BareHex } from "@bounded-systems/cas";

export type CasSha = string;

export interface DomainOptions {
  domain?: string;
}

export const DEFAULT_DOMAIN = "plans";

export class PlanStoreError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "PlanStoreError";
    this.code = code;
  }
}

const SHA_RE = /^sha256:[0-9a-f]{64}$/;
const DOMAIN_RE = /^[a-z][a-z0-9_-]*$/;
const MAX_BLOB_BYTES = 10 * 1024 * 1024;
const MAX_REF_NAME = 256;
const MAX_DOMAIN = 64;

function validateDomain(domain: string): string {
  if (typeof domain !== "string" || domain.length === 0) {
    throw new PlanStoreError("domain must not be empty", "INVALID_DOMAIN");
  }
  if (domain.length > MAX_DOMAIN) {
    throw new PlanStoreError(
      `domain too long (>${MAX_DOMAIN})`,
      "INVALID_DOMAIN",
    );
  }
  if (!DOMAIN_RE.test(domain)) {
    throw new PlanStoreError(
      `invalid domain: ${domain} (must match ${DOMAIN_RE.source})`,
      "INVALID_DOMAIN",
    );
  }
  return domain;
}

/**
 * Resolve the CAS store root for a domain. Precedence:
 *
 *   1. PRX_CAS_ROOT          → <root>/<domain>/{objects,refs,.tmp}/
 *   2. PRX_PLAN_STORE        → <root>/{objects,refs,.tmp}/ (plans-only flat)
 *   3. XDG_STATE_HOME ?? $HOME/.local/state → /<state>/prx/cas/<domain>
 *
 * The CAS is its OWN surface (per-operator runtime state). Neither
 * BAKED_AI_HOME_ROOT (GH-1226) nor PRX_AI_HOME_ROOT (prx-z27) is consulted:
 * both are overlay-config / source roots that can be read-only (e.g. a
 * /nix/store flake source) and so can't host a mutable store. The CAS's
 * canonical home is XDG_STATE_HOME; PRX_CAS_ROOT is the explicit override.
 */
function resolveStoreRoot(domain: string = DEFAULT_DOMAIN): string {
  return resolveStoreRootForDisplay(domain).root;
}

export interface StoreRootResolution {
  root: string;
  source:
    | "PRX_CAS_ROOT"
    | "PRX_PLAN_STORE"
    | "XDG_STATE_HOME"
    | "XDG_STATE_HOME (default)";
}

/**
 * Resolve the CAS store root and label which precedence branch fired.
 * Used by `prx plan show --paths` (GH-1226) so the operator can see the
 * resolved location and confirm overrides without re-implementing the chain.
 */
export function resolveStoreRootForDisplay(
  domain: string = DEFAULT_DOMAIN,
): StoreRootResolution {
  validateDomain(domain);
  const casRoot = getEnv("PRX_CAS_ROOT");
  if (casRoot && casRoot.length > 0) {
    return { root: join(casRoot, domain), source: "PRX_CAS_ROOT" };
  }
  // PRX_PLAN_STORE (legacy, deprecated): plans-only flat layout — root maps
  // straight to <root>/{objects,refs,.tmp}/, no domain subdir. Keeps the
  // GH-1174 contract intact for the plans domain; rejects other domains so
  // multi-domain callers must opt into PRX_CAS_ROOT or the default path.
  const planStore = getEnv("PRX_PLAN_STORE");
  if (planStore && planStore.length > 0) {
    if (domain !== DEFAULT_DOMAIN) {
      throw new PlanStoreError(
        `PRX_PLAN_STORE supports only the '${DEFAULT_DOMAIN}' domain (got '${domain}'); set PRX_CAS_ROOT for multi-domain access`,
        "DOMAIN_NOT_AVAILABLE",
      );
    }
    return { root: planStore, source: "PRX_PLAN_STORE" };
  }
  // prx-z27: the CAS is its OWN surface — per-operator runtime state homed at
  // PRX_CAS_ROOT / PRX_PLAN_STORE / XDG_STATE_HOME. It is deliberately NOT
  // resolved from PRX_AI_HOME_ROOT, the per-repo OVERLAY-CONFIG root, which is
  // legitimately read-only (e.g. the ai-home flake source under /nix/store that
  // home-manager injects) and so can't host a mutable store. prx is pre-1.0
  // with no users, so the old PRX_AI_HOME_ROOT CAS branch was removed outright
  // (no migration / no read-only-compat) — CAS owns its surface.
  // XDG_STATE_HOME: per-operator default. Per-domain subtree under XDG_STATE_HOME
  // so plans/scout/etc. coexist without colliding.
  const xdgStateHome = getEnv("XDG_STATE_HOME");
  if (xdgStateHome && xdgStateHome.length > 0) {
    return { root: join(xdgStateHome, "prx", "cas", domain), source: "XDG_STATE_HOME" };
  }
  const home = getEnv("HOME");
  if (home && home.length > 0) {
    return {
      root: join(home, ".local", "state", "prx", "cas", domain),
      source: "XDG_STATE_HOME (default)",
    };
  }
  throw new PlanStoreError(
    "no cas-store root: set PRX_CAS_ROOT, PRX_PLAN_STORE (legacy), XDG_STATE_HOME, or HOME",
    "NO_STORE_ROOT",
  );
}

export interface StagingDirResolution {
  dir: string;
  source: "XDG_CACHE_HOME" | "XDG_CACHE_HOME (default)";
}

/**
 * Resolve the plan staging directory — the operator-writable scratch path
 * where `prx plan save --from-file <path>` may read drafts that were
 * authored from a Cursor- or Claude-driven planner session. Precedence:
 *
 *   1. XDG_CACHE_HOME ?? $HOME/.cache → /<cache>/prx/plans/staging
 *
 * Throws PlanStoreError("...", "NO_STAGING_ROOT") if neither var is set.
 *
 * GH-1175: this directory is the single Write-allowlist carve-out for the
 * plan profile (`Write(<dir>/**)`). It exists because heredoc bodies trip
 * Cursor's expansion-obfuscation heuristic, so `--from-stdin` is unusable
 * from Cursor — the unblock is staging a file the planner wrote there and
 * then reading it back via `--from-file`. Cache-tier (not state-tier) on
 * purpose: drafts are intentionally throwaway between save attempts.
 *
 * Does NOT mkdir — callers (or the planner session itself) are responsible
 * for creating the directory before writing to it.
 */
export function resolvePlanStagingDir(): string {
  return resolvePlanStagingDirForDisplay().dir;
}

// GH-1175 Copilot review: the resolved staging dir is embedded into the
// plan profile's comma-delimited `--allowedTools` argument as
// `Write(<dir>/**)`. Reject any env-derived value containing characters
// that would break that parser (`,`), close the `Write(...)` glob early
// (`)`), or smuggle additional entries via newlines / control bytes —
// that would be a tool-allowlist injection vector. Forbidden set is
// intentionally tight: a normal cache root contains none of these.
function validateStagingEnvRoot(value: string, varName: string): string {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x2c /* , */ || code === 0x29 /* ) */ || code < 0x20 || code === 0x7f) {
      const hex = code.toString(16).padStart(2, "0");
      throw new PlanStoreError(
        `${varName} contains a character forbidden in the plan staging root (0x${hex}); ` +
          `pick a path without ',', ')', or control characters`,
        "INVALID_STAGING_ROOT",
      );
    }
  }
  return value;
}

/**
 * Resolve the plan staging directory and label which precedence branch
 * fired. Used by `prx plan show --paths` so the operator can confirm the
 * resolved location and override source without re-implementing the chain.
 */
export function resolvePlanStagingDirForDisplay(): StagingDirResolution {
  const xdgCacheHome = getEnv("XDG_CACHE_HOME");
  if (xdgCacheHome && xdgCacheHome.length > 0) {
    const safe = validateStagingEnvRoot(xdgCacheHome, "XDG_CACHE_HOME");
    return {
      dir: join(safe, "prx", "plans", "staging"),
      source: "XDG_CACHE_HOME",
    };
  }
  const home = getEnv("HOME");
  if (home && home.length > 0) {
    const safe = validateStagingEnvRoot(home, "HOME");
    return {
      dir: join(safe, ".cache", "prx", "plans", "staging"),
      source: "XDG_CACHE_HOME (default)",
    };
  }
  throw new PlanStoreError(
    "no plan staging root: set XDG_CACHE_HOME or HOME",
    "NO_STAGING_ROOT",
  );
}

function ensureLayout(root: string): { objects: string; refs: string; tmp: string } {
  const objects = join(root, "objects");
  const refs = join(root, "refs");
  const tmp = join(root, ".tmp");
  // prx-1ke: the resolved root may be unwritable — e.g. PRX_AI_HOME_ROOT
  // (precedence branch 3) pointed at a read-only location with PRX_CAS_ROOT
  // unset. Convert the raw filesystem error into an actionable PlanStoreError
  // that names the override env var, rather than leaking EACCES/EROFS/EPERM
  // from mkdirSync. (BAKED_AI_HOME_ROOT can't reach here — it is intentionally
  // not consulted by the resolver; see resolveStoreRootForDisplay, GH-1226.)
  try {
    mkdirSync(objects, { recursive: true });
    mkdirSync(refs, { recursive: true });
    mkdirSync(tmp, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new PlanStoreError(
        `cas store root is not writable: ${root} (${code}). The root was resolved ` +
          `from an env override (e.g. PRX_AI_HOME_ROOT) pointing at a read-only location; ` +
          `set PRX_CAS_ROOT to a writable path, or unset the override to fall back to the ` +
          `XDG_STATE_HOME per-operator default.`,
        "STORE_ROOT_NOT_WRITABLE",
      );
    }
    throw err;
  }
  return { objects, refs, tmp };
}

function objectPathFor(root: string, hex: string): { dir: string; file: string } {
  const dir = join(root, "objects", hex.slice(0, 2));
  const file = join(dir, hex.slice(2));
  return { dir, file };
}

function tmpName(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

function fsyncDir(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    // Best-effort durability — directory fsync semantics differ across
    // platforms (e.g. EINVAL on some macOS setups). The rename itself is
    // already atomic; we tolerate fsync failure rather than propagate.
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function writeAll(fd: number, buf: Buffer): void {
  let offset = 0;
  while (offset < buf.length) {
    const written = writeSync(fd, buf, offset, buf.length - offset);
    if (written <= 0) {
      throw new PlanStoreError("short write to tmp file", "IO_ERROR");
    }
    offset += written;
  }
}

function parseSha(sha: CasSha): string {
  if (typeof sha !== "string" || !SHA_RE.test(sha)) {
    throw new PlanStoreError(`invalid sha: ${String(sha)}`, "INVALID_SHA");
  }
  return sha.slice("sha256:".length);
}

function validateRefName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new PlanStoreError("ref name must not be empty", "INVALID_REF_NAME");
  }
  if (name.length > MAX_REF_NAME) {
    throw new PlanStoreError(
      `ref name too long (>${MAX_REF_NAME})`,
      "INVALID_REF_NAME",
    );
  }
  if (name.startsWith(".")) {
    throw new PlanStoreError(
      "ref name must not start with '.'",
      "INVALID_REF_NAME",
    );
  }
  if (
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new PlanStoreError(
      "ref name contains forbidden separator/sequence",
      "INVALID_REF_NAME",
    );
  }
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) < 0x20) {
      throw new PlanStoreError(
        "ref name contains control character",
        "INVALID_REF_NAME",
      );
    }
  }
}

export async function writeBlob(
  content: string | Buffer,
  opts?: DomainOptions,
): Promise<{ sha: CasSha }> {
  const domain = opts?.domain ?? DEFAULT_DOMAIN;
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (buf.length > MAX_BLOB_BYTES) {
    throw new PlanStoreError(
      `blob too large: ${buf.length} > ${MAX_BLOB_BYTES}`,
      "BLOB_TOO_LARGE",
    );
  }
  const hex = sha256BareHex(buf);
  const sha: CasSha = `sha256:${hex}`;
  const root = resolveStoreRoot(domain);
  const { tmp } = ensureLayout(root);
  const { dir, file } = objectPathFor(root, hex);
  if (existsSync(file)) {
    return { sha };
  }
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(tmp, tmpName("blob"));
  const fd = openSync(tmpPath, "wx", 0o600);
  try {
    writeAll(fd, buf);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmpPath, 0o444);
  renameSync(tmpPath, file);
  fsyncDir(dir);
  return { sha };
}

export async function readBlob(sha: CasSha, opts?: DomainOptions): Promise<Buffer> {
  const domain = opts?.domain ?? DEFAULT_DOMAIN;
  const hex = parseSha(sha);
  const root = resolveStoreRoot(domain);
  const { file } = objectPathFor(root, hex);
  if (!existsSync(file)) {
    throw new PlanStoreError(`blob not found: ${sha}`, "BLOB_NOT_FOUND");
  }
  const buf = readFileSync(file);
  const computed = sha256BareHex(buf);
  if (computed !== hex) {
    throw new PlanStoreError(
      `blob corrupt: stored content does not match sha ${sha}`,
      "BLOB_CORRUPT",
    );
  }
  return buf;
}

export async function setRef(
  name: string,
  sha: CasSha,
  opts?: DomainOptions,
): Promise<void> {
  const domain = opts?.domain ?? DEFAULT_DOMAIN;
  validateRefName(name);
  const hex = parseSha(sha);
  const root = resolveStoreRoot(domain);
  const { refs, tmp } = ensureLayout(root);
  const { file: blobFile } = objectPathFor(root, hex);
  if (!existsSync(blobFile)) {
    throw new PlanStoreError(
      `ref target blob missing: ${sha}`,
      "REF_TARGET_MISSING",
    );
  }
  const tmpPath = join(tmp, tmpName("ref"));
  const fd = openSync(tmpPath, "wx", 0o644);
  try {
    writeAll(fd, Buffer.from(`${sha}\n`, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const finalPath = join(refs, name);
  renameSync(tmpPath, finalPath);
  fsyncDir(refs);
}

export async function getRef(
  name: string,
  opts?: DomainOptions,
): Promise<CasSha | null> {
  const domain = opts?.domain ?? DEFAULT_DOMAIN;
  validateRefName(name);
  const root = resolveStoreRoot(domain);
  const refPath = join(root, "refs", name);
  if (!existsSync(refPath)) {
    return null;
  }
  const raw = readFileSync(refPath, "utf8").trim();
  if (!SHA_RE.test(raw)) {
    throw new PlanStoreError(
      `ref ${name} contains invalid sha: ${raw}`,
      "INVALID_SHA",
    );
  }
  return raw;
}

export async function listRefs(
  prefix?: string,
  opts?: DomainOptions,
): Promise<Array<{ name: string; sha: CasSha }>> {
  const domain = opts?.domain ?? DEFAULT_DOMAIN;
  const root = resolveStoreRoot(domain);
  const refsDir = join(root, "refs");
  if (!existsSync(refsDir)) {
    return [];
  }
  const entries = readdirSync(refsDir).sort();
  const out: Array<{ name: string; sha: CasSha }> = [];
  for (const name of entries) {
    if (prefix !== undefined && !name.startsWith(prefix)) {
      continue;
    }
    const raw = readFileSync(join(refsDir, name), "utf8").trim();
    if (!SHA_RE.test(raw)) {
      continue;
    }
    out.push({ name, sha: raw });
  }
  return out;
}

const SHARD_RE = /^[0-9a-f]{2}$/;
const OBJECT_NAME_RE = /^[0-9a-f]{62}$/;

/**
 * Enumerate every stored blob in a domain — `{ sha, bytes, mtimeMs }` per object
 * (GH-2312, for `prx gc cas`). Walks `<root>/objects/<shard>/<name>`; a missing
 * or empty `objects/` dir yields `[]`. Stat-only: never reads or sha-verifies
 * content, so it is cheap and never throws on a corrupt blob. `mtimeMs` lets the
 * gc driver apply an in-flight-write grace window.
 */
export async function listBlobs(
  opts?: DomainOptions,
): Promise<Array<{ sha: CasSha; bytes: number; mtimeMs: number }>> {
  const domain = opts?.domain ?? DEFAULT_DOMAIN;
  const root = resolveStoreRoot(domain);
  const objectsDir = join(root, "objects");
  if (!existsSync(objectsDir)) {
    return [];
  }
  const out: Array<{ sha: CasSha; bytes: number; mtimeMs: number }> = [];
  for (const shard of readdirSync(objectsDir)) {
    if (!SHARD_RE.test(shard)) {
      continue;
    }
    const shardDir = join(objectsDir, shard);
    let names: string[];
    try {
      names = readdirSync(shardDir);
    } catch {
      continue; // not a directory / vanished mid-walk
    }
    for (const name of names) {
      if (!OBJECT_NAME_RE.test(name)) {
        continue;
      }
      let st;
      try {
        st = statSync(join(shardDir, name));
      } catch {
        continue; // vanished mid-walk (e.g. concurrent deleteBlob)
      }
      if (!st.isFile()) {
        continue;
      }
      out.push({ sha: `sha256:${shard}${name}`, bytes: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/**
 * Delete a single content-addressed blob (GH-2312, the `prx gc cas` reclaim
 * primitive). Idempotent — an already-absent blob is a no-op. Best-effort prunes
 * the now-empty shard dir. Throws `PlanStoreError` only on an unexpected IO
 * failure (so the gc sweep can record a per-blob failure). Does NOT touch refs:
 * deleting a referenced blob is the caller's (reachability rooting) concern.
 */
export async function deleteBlob(sha: CasSha, opts?: DomainOptions): Promise<void> {
  const domain = opts?.domain ?? DEFAULT_DOMAIN;
  const hex = parseSha(sha);
  const root = resolveStoreRoot(domain);
  const { dir, file } = objectPathFor(root, hex);
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return; // already gone — idempotent
    }
    throw new PlanStoreError(
      `failed to delete blob ${sha}: ${(err as Error).message}`,
      "IO_ERROR",
    );
  }
  try {
    rmdirSync(dir); // best-effort: prune the shard if this was its last blob
  } catch {
    // ENOTEMPTY (a sibling blob remains) or ENOENT (raced) — never fatal.
  }
}
