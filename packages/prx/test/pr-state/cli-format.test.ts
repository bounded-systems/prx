// pr-state/cli-format — the pure help/renderer surface. These are string
// builders with no IO; we assert they produce non-empty output (and valid JSON
// where a `json` format branch exists).

import { describe, expect, test } from "bun:test";

import {
  formatBinaryUpdateWarning,
  formatCreateCommand,
  formatFullCommandCatalogHelp,
  formatHelp,
  formatIntakeNamespaceHelp,
  formatPlanNamespaceHelp,
  formatReadyCommand,
  formatSessionHelp,
  formatUnknownError,
  formatVerbHelp,
} from "../../src/pr-state/cli-format.ts";

describe("cli-format help surface", () => {
  test("the namespace/help renderers produce non-empty text", () => {
    for (const out of [
      formatHelp(),
      formatFullCommandCatalogHelp(),
      formatPlanNamespaceHelp(),
      formatIntakeNamespaceHelp(),
      formatSessionHelp(),
      formatVerbHelp("status"),
    ]) {
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
    }
  });

  test("formatVerbHelp tolerates an unknown verb", () => {
    expect(typeof formatVerbHelp("totally-not-a-verb")).toBe("string");
  });
});

describe("cli-format small renderers", () => {
  test("formatUnknownError handles Error and non-Error", () => {
    expect(formatUnknownError(new Error("boom"))).toContain("boom");
    expect(formatUnknownError("plain string")).toContain("plain string");
  });

  test("formatBinaryUpdateWarning names the versions", () => {
    const out = formatBinaryUpdateWarning({ current: "1.0.0", latest: "1.2.0" });
    expect(out).toContain("1.0.0");
    expect(out).toContain("1.2.0");
  });

  test("formatCreateCommand / formatReadyCommand render command strings", () => {
    expect(typeof formatCreateCommand("dev" as never)).toBe("string");
    expect(typeof formatReadyCommand("dev" as never, "merge_ready" as never, "GH-1")).toBe("string");
  });
});
