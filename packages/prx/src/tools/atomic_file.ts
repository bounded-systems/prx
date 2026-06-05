import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Read a file and conditionally rewrite it atomically, creating it when absent.
 *
 * Replaces the `existsSync(p) ? readFileSync(p) : default` → `writeFileSync(p)`
 * shape, which CodeQL flags as `js/file-system-race`. A single `a+` open
 * (create-or-open, read+write) avoids any existence probe — there's no
 * check-then-act — and the read and rewrite share one descriptor, so they
 * refer to the same inode.
 *
 * `transform` receives the current contents, or `null` when the file is brand
 * new or empty, and returns the new contents — or `null` to leave it as-is.
 * (Callers here always return content for the `null` case; a `null` return for
 * a freshly-created file would leave an empty file behind.) Missing parent
 * directories are created. Returns whether the file already had content and
 * whether a write happened.
 */
export function rewriteFileAtomic(
  path: string,
  transform: (current: string | null) => string | null,
): { existed: boolean; wrote: boolean } {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a+");
  try {
    const current = readFileSync(fd, "utf8");
    const existed = current.length > 0;
    const next = transform(existed ? current : null);
    if (next === null || next === current) {
      return { existed, wrote: false };
    }
    ftruncateSync(fd, 0);
    writeSync(fd, next);
    return { existed, wrote: true };
  } finally {
    closeSync(fd);
  }
}

/**
 * Like {@link rewriteFileAtomic} but never creates the file: a missing path is
 * a no-op. Uses a single `r+` descriptor (read + in-place rewrite), so there's
 * no existence check that a later write could race (`js/file-system-race`).
 * `transform` receives the current contents and returns the new contents, or
 * `null` to leave the file untouched. Returns whether a write happened.
 */
export function rewriteExistingFileAtomic(
  path: string,
  transform: (current: string) => string | null,
): boolean {
  let fd: number;
  try {
    fd = openSync(path, "r+");
  } catch {
    return false;
  }
  try {
    const current = readFileSync(fd, "utf8");
    const next = transform(current);
    if (next === null || next === current) return false;
    ftruncateSync(fd, 0);
    writeSync(fd, next);
    return true;
  } finally {
    closeSync(fd);
  }
}
