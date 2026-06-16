# @bounded-systems/fs

The filesystem capability seam — the one allowed filesystem-access point, behind
an injectable `FileSystem`.

Production code depends on the `FileSystem` interface, not on `node:fs` directly.
The default implementation is the real filesystem; a test (or a sandbox) injects
its own, so disk access is both enumerable and substitutable.

## Install

```sh
npm install @bounded-systems/fs
```

## Usage

```ts
import {
  defaultFileSystem,
  statPath,
  removeFile,
  type FileSystem,
  type FileStat,
} from "@bounded-systems/fs";

// Depend on the port; default to the real filesystem.
async function load(fs: FileSystem = defaultFileSystem) {
  const stat: FileStat | null = await statPath(fs, "config.json");
  // …
}

// In a test, pass an in-memory FileSystem instead.
```

## Design

- **Capability seam.** Callers receive a `FileSystem` rather than reaching for
  `node:fs`, so filesystem access is injectable and auditable.
- **Leaf package.** Touches node builtins only and carries no ambient authority
  beyond the filesystem it mediates — an extractability test enforces it.

## License

[MIT](./LICENSE) © Bounded Systems
