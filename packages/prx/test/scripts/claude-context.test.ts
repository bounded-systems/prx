// Claude context-doc drift parity — the committed .claude/context/project.md
// must match what the project graph + package.json scripts regenerate.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { CONTEXT_OUTPUT, renderContextDoc } from "../../src/claude-context/build.ts";

describe("claude context doc", () => {
  test(".claude/context/project.md matches the sources (run `bun run claude-context:render`)", () => {
    const onDisk = readFileSync(CONTEXT_OUTPUT, "utf8");
    expect(onDisk).toEqual(renderContextDoc());
  });

  test("the doc surfaces the CLI, the libraries, and the docs index", () => {
    const doc = renderContextDoc();
    expect(doc).toContain("`@bounded-systems/prx`");
    expect(doc).toContain("`@bounded-systems/cas`");
    expect(doc).toContain("## Packages");
    expect(doc).toContain("## Docs");
    expect(doc).toContain("## Commands & workflow");
    expect(doc).toContain("bun run docs:check");
  });
});
