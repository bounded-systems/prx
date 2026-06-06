// Compatibility shim — repo-root resolution now lives in the
// @bounded-systems/repo-root capability (the one sanctioned root-resolution
// point). Importing this module has NO side effect: the eager `REPO_ROOT` const
// that crashed the compiled binary (bun's virtual fs has no `.git` ancestor) is
// gone. Build/codegen scripts and tests call `findRepoRoot()` explicitly; the
// runtime CLI uses the lazy, git-based `getRepoRoot()`.

export { findRepoRoot, getRepoRoot, resetRepoRootCache } from "@bounded-systems/repo-root";
