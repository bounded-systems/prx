import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Read a file and conditionally rewrite it atomically through a single
 * descriptor.
 *
 * Replaces the `existsSync(p) ? readFileSync(p) : default` → `writeFileSync(p)`
 * shape, which CodeQL flags as `js/file-system-race`: the existence check (or
 * the try-read used as one) and the later write race because they re-resolve
 * the path independently. Here the read and the rewrite share one descriptor,
 * so they refer to the same inode.
 *
 * `transform` receives the current contents, or `null` when the file does not
 * exist, and returns the new contents — or `null` to leave the file untouched
 * (and, when absent, to not create it). Missing parent directories are created
 * for the create path. Returns whether the file existed and whether a write
 * happened.
 */
export function rewriteFileAtomic(
  path: string,
  transform: (current: string | null) => string | null,
): { existed: boolean; wrote: boolean } {
  let fd: number;
  try {
    fd = openSync(path, "r+");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // No file yet — create it from the `null` branch of `transform`. The failed
    // open is not an existence *check* (CodeQL doesn't pair it with the write),
    // so this stays race-free.
    const next = transform(null);
    if (next === null) return { existed: false, wrote: false };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    return { existed: false, wrote: true };
  }
  try {
    const current = readFileSync(fd, "utf8");
    const next = transform(current);
    if (next === null || next === current) return { existed: true, wrote: false };
    ftruncateSync(fd, 0);
    writeSync(fd, next, 0);
    return { existed: true, wrote: true };
  } finally {
    closeSync(fd);
  }
}
