import { test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSeam } from "@bounded-systems/seam-check";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// prx-config is a leaf: it depends on nothing in the repo. Prod files touch the
// zod peer dependency and node:fs (the parser reads/writes config files) only.
// The harness proves that edge and the no-ambient thesis — any other edge means
// the config parser has grown an upward dependency.
test("@bounded-systems/prx-config upholds its seam claim", () => {
  assertSeam({
    root: SRC,
    prod: ["zod", "node:fs"],
    test: ["@bounded-systems/prx-config", "@bounded-systems/seam-check"],
  });
});
