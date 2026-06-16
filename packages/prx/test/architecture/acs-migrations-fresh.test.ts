// Drift guard for packages/anchored-chain-sqlite/src/migrations.generated.ts —
// the embedded drizzle migration SQL. Generated from the .sql files (drizzle's
// source of truth); this fails if a migration changed without regenerating, so
// the embedded copy can't diverge from the on-disk .sql. Regenerate:
// `bun run acs:migrations`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../../scripts/gen-acs-migrations.ts";

const GENERATED = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../anchored-chain-sqlite/src/migrations.generated.ts",
);

describe("anchored-chain-sqlite/src/migrations.generated.ts", () => {
  test("is up to date with `bun run acs:migrations`", () => {
    const onDisk = readFileSync(GENERATED, "utf8");
    expect(onDisk, "stale embedded migrations — run `bun run acs:migrations` and commit").toBe(
      render(),
    );
  });
});
