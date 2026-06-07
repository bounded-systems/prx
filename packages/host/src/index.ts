/**
 * @bounded-systems/host — the host/OS-ambient capability.
 *
 * The ONE place `node:os` ambient queries (home directory, temp directory,
 * hostname) are read. Like @bounded-systems/env for `process.env`, routing these
 * through an explicit import turns a hidden edge into a visible one: a package
 * that depends on the host's home/temp/hostname declares @bounded-systems/host in
 * its imports rather than reaching into `node:os`. (The ambient-authority guard
 * forbids raw `node:os` everywhere else in prx/src.)
 *
 * Why this is more than a passthrough: `os.homedir()` resolves the home from the
 * password database and IGNORES `$HOME` on macOS, which makes it impossible to
 * redirect in a test or a sandboxed run. {@link homeDir} honors an explicit
 * `$HOME` override first (routed through @bounded-systems/env), falling back to
 * `os.homedir()` — in production `$HOME` is the real home so the value is
 * unchanged, but a test can now point it at a tmpdir.
 */

import { homedir, hostname, tmpdir } from "node:os";

import { getEnv } from "@bounded-systems/env";

/**
 * The current user's home directory. Honors an explicit `$HOME` override
 * (so tests / sandboxes can redirect it), falling back to `os.homedir()`.
 */
export function homeDir(): string {
  const explicit = getEnv("HOME");
  return explicit && explicit.length > 0 ? explicit : homedir();
}

/**
 * The OS temp directory (`os.tmpdir()`), which already honors `$TMPDIR`/`$TMP`/
 * `$TEMP`. Wrapped so the ambient read is a visible @bounded-systems/host edge.
 */
export function tmpDir(): string {
  return tmpdir();
}

/** The host's network name (`os.hostname()`). */
export function hostName(): string {
  return hostname();
}
