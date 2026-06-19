/**
 * @bounded-systems/fs — the filesystem capability.
 *
 * The ONE allowed filesystem-access point. Reading, stat-ing, or removing a
 * path is a hidden dependency on that path existing with some shape; routing
 * every touch through this capability turns those hidden edges into a visible
 * `@bounded-systems/fs` import — the same discipline `@bounded-systems/proc`
 * enforces for spawning. Boundary tests elsewhere can then forbid raw `node:fs`
 * and keep the import graph the complete dependency graph.
 *
 * The injectable {@link FileSystem} seam is the point of all this: higher
 * capabilities decorate it without leaf callers knowing. This composes most
 * naturally for reads — a content-addressed layer (`@bounded-systems/cas`) can
 * hash-and-store what's read through this seam, and a provenance/discovery
 * layer (`@bounded-systems/scout`) can record which paths were read — both by
 * wrapping {@link defaultFileSystem} rather than by every caller re-implementing
 * `node:fs`. Mutations (removal) stay plain passthrough.
 */
import * as fs from "node:fs";

export type FileStat = {
  /** Size in bytes. */
  sizeBytes: number;
  /** Last-modification time, epoch ms. */
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
};

export interface FileSystem {
  /** Stat a path; `null` when it does not exist (or is unreadable). */
  statPath(path: string): FileStat | null;
  /** Remove a file. Force semantics: no error when the path is already absent. */
  removeFile(path: string): void;
}

export const defaultFileSystem: FileSystem = {
  statPath(path) {
    try {
      const st = fs.statSync(path);
      return {
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
      };
    } catch {
      return null; // ENOENT or unreadable
    }
  },
  removeFile(path) {
    fs.rmSync(path, { force: true });
  },
};

/** Stat a path via {@link defaultFileSystem}; `null` when absent. */
export const statPath = (path: string): FileStat | null => defaultFileSystem.statPath(path);

/** Force-remove a file via {@link defaultFileSystem}. */
export const removeFile = (path: string): void => defaultFileSystem.removeFile(path);
