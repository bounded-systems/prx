import { describe, expect, test } from "bun:test";

import { buildAgentsMd } from "../../src/init/agents_md.ts";

describe("buildAgentsMd", () => {
  test("renders deterministically", () => {
    expect(buildAgentsMd()).toBe(buildAgentsMd());
  });

  test("matches snapshot", () => {
    expect(buildAgentsMd()).toMatchSnapshot();
  });

  test("documents the per-agent discovery table", () => {
    const md = buildAgentsMd();
    expect(md).toContain("Per-agent discovery knobs");
    expect(md).toContain("Claude Code");
    expect(md).toContain("Codex CLI");
    expect(md).toContain("GitHub Copilot");
    expect(md).toContain("Gemini CLI");
    expect(md).toContain("Cursor");
    expect(md).toContain("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
    expect(md).toContain("project_root_markers");
    expect(md).toContain("COPILOT_CUSTOM_INSTRUCTIONS_DIRS");
    expect(md).toContain("GEMINI_SYSTEM_MD");
    expect(md).toContain("CURSOR_PROJECT_DIR");
  });

  test("promotes the prx workflow entry points", () => {
    const md = buildAgentsMd();
    expect(md).toContain("prx tui");
    expect(md).toContain("prx plan session");
    expect(md).toContain("prx next");
    expect(md).toContain("prx do");
    expect(md).toContain("prx review");
    expect(md).toContain("prx plan handoff");
  });
});
