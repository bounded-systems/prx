import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { graphVerb } from "../../src/pr-state/graph-verb.ts";

// The `graph` command migrated off the cli.ts monolith to a spec-driven
// VerbSpec (ADR docs/prx/cli-decomposition.md). These cover the side effects
// and the CLI `render` projection at the verb boundary; the format catalog
// itself (plain/json/xstate/mermaid/…) is exercised end-to-end through the
// compiled CLI in cli.test.ts.

describe("graph verb", () => {
  test("validates and writes the graph to --output, render reports json-ok", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-verb-"));
    const outputPath = join(dir, "machine.json");

    const out = graphVerb.run({
      format: "xstate-system-json",
      output: outputPath,
      validate: true,
      open: false,
      url: "https://stately.ai/registry/editor/",
    }) as { graph: string; wrotePath?: string };

    expect(out.wrotePath).toBe(outputPath);
    expect(JSON.parse(readFileSync(outputPath, "utf8")).id).toBe("prSystem");

    const rendered = graphVerb.render!(out, {
      format: "xstate-system-json",
      output: outputPath,
      validate: true,
      open: false,
      url: "https://stately.ai/registry/editor/",
    });
    expect(rendered).toContain(`Wrote graph output to ${outputPath}`);
    expect(rendered).toContain("json-ok");
  });

  test("--validate refuses a non-JSON format", () => {
    expect(() =>
      graphVerb.run({
        format: "mermaid",
        output: undefined,
        validate: true,
        open: false,
        url: "https://stately.ai/registry/editor/",
      }),
    ).toThrow("--validate requires a JSON graph format");
  });

  test("without --output the render is the raw graph text", () => {
    const out = graphVerb.run({
      format: "mermaid",
      output: undefined,
      validate: false,
      open: false,
      url: "https://stately.ai/registry/editor/",
    }) as { graph: string; wrotePath?: string };

    expect(out.wrotePath).toBeUndefined();
    const rendered = graphVerb.render!(out, {
      format: "mermaid",
      output: undefined,
      validate: false,
      open: false,
      url: "https://stately.ai/registry/editor/",
    });
    expect(rendered).toBe(out.graph);
    expect(rendered.length).toBeGreaterThan(0);
  });
});
