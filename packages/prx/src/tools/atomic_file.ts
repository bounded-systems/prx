import { closeSync, ftruncateSync, openSync, readFileSync, writeSync } from "node:fs";

/**
 * Rewrite an existing file atomically through a single descriptor.
 *
 * Opens the file once (`r+`), reads it, and — when `transform` returns new
 * content — truncates and writes through the SAME descriptor. Because the path
 * is resolved exactly once, there is no `existsSync`/read → write TOCTOU window
 * for CodeQL to flag as `js/file-system-race`: the read and the rewrite refer
 * to the same inode.
 *
 * A missing file is a no-op — this helper updates files that already exist (the
 * beads-init metadata patchers only ever rewrite an existing `metadata.json`,
 * never create it), so it deliberately does NOT create. `transform` receives
 * the current contents and returns the new contents, or `null` to leave the
 * file untouched. Returns whether the file existed and whether a write
 * happened.
 */
export function rewriteFileAtomic(
  path: string,
  transform: (current: string) => string | null,
): { existed: boolean; wrote: boolean } {
  let fd: number;
  try {
    fd = openSync(path, "r+");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { existed: false, wrote: false };
    }
    throw err;
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
