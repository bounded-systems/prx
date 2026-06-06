// The repo description is not free prose — it rests on the value-prop claims
// listed in community.json `project.claims`, and this guard enforces that every
// one of those is an actual value prop that is BACKED (a green forcing function
// with a gherkin feature behind it — see features/*.feature). So the description
// can never assert something prx can't prove; tighten/loosen it only by moving a
// value prop's backing, not by editing prose.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { findRepoRoot } from "../../src/repo-root.ts";
import { VALUE_PROPS, isValuePropBacked } from "../../src/value_props.ts";

const REPO_ROOT = findRepoRoot();
const community = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages/prx/community/community.json"), "utf8"),
) as { project: { claims: string[] } };

describe("repo description rests only on backed value-prop claims", () => {
  test("every project.claims entry is a backed value prop", () => {
    for (const claim of community.project.claims) {
      const vp = VALUE_PROPS.find((v) => v.claim === claim);
      expect(vp, `project.claims has no matching value prop: "${claim}"`).toBeDefined();
      expect(isValuePropBacked(vp!), `value prop is not backed: "${claim}"`).toBe(true);
    }
  });
});
