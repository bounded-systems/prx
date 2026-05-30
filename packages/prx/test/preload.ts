import { mkdirSync } from "node:fs";
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
