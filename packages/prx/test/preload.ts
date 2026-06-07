import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = join(repoRoot, ".tmp", "bun-tests");

mkdirSync(tempRoot, { recursive: true });

for (const key of ["TMPDIR", "TMP", "TEMP"] as const) {
  process.env[key] = tempRoot;
}

// `prx session open` sets PRX_SESSION_OPEN in its try/finally to guard against
// re-entrancy. If an earlier invocation crashed before the finally ran (rare
// but possible), the env var can leak into whatever shell launches the test
// runner next — and then every test that hits session open will trip the
// re-entrancy guard with exit code 1. Unset it at test startup so tests are
// hermetic against an upstream leak.
delete process.env.PRX_SESSION_OPEN;

// GH-360: many tests `git commit` throwaway fixture repos. Those FRESH repos fall
// back to the operator's GLOBAL git config (~/.config/git/config), which may enable
// commit signing with an interactive signer (e.g. 1Password SSH) — that fails
// headless ("1Password: agent returned an error" → "failed to write commit
// object"), failing `prx ci` and so the pilot's local `checking` gate, causing the
// autonomous pipeline to retreat-loop and abandon (GH-360). Point the test
// process's git global/system config at a HERMETIC file (identity set, signing
// off) so every `spawnSync("git", …)` is isolated from the operator's setup;
// repo-local config (e.g. the bare repo's) still applies.
const hermeticGitConfig = join(tempRoot, "hermetic.gitconfig");
writeFileSync(
  hermeticGitConfig,
  ["[user]", "\tname = prx-test", "\temail = prx-test@example.com", "[commit]", "\tgpgsign = false", "[tag]", "\tgpgsign = false", ""].join("\n"),
);
process.env.GIT_CONFIG_GLOBAL = hermeticGitConfig;
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
