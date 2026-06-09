---
"@bounded-systems/prx": patch
---

fix(beadsd): resolve the runtime repo root from cwd, not the binary dir (prx-ag7)

beadsd's `client-factory` used `findRepoRoot()` — the build-time `.git`-marker
walk whose default start is `import.meta.dir` — as its *runtime* fallback. In a
`bun --compile` binary (e.g. prx inside claude-box) that's `/$bunfs/root`, so
repo-scoped verbs crashed with `findRepoRoot: no .git ancestor of /$bunfs/root`.
Use `getRepoRoot()` (the `git rev-parse --show-toplevel` cwd resolver) for the
runtime path; `findRepoRoot` stays for build/codegen.
