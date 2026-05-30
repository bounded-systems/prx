import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const pkgRoot = resolve(repoRoot, "packages", "prx");
const prStateScript = join(pkgRoot, "scripts/pr_state.ts");
const validateScript = join(repoRoot, "skills/pr-contract/scripts/validate_pr_contract.ts");
const renderScript = join(repoRoot, "skills/pr-contract/scripts/render_pr_body.ts");
const openModeWrapper = join(pkgRoot, "scripts/pr_open_mode");

function makeAgentWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "pr-state-agent-"));
  const prDir = join(workspace, ".pr", "local");
  mkdirSync(prDir, { recursive: true });
  const contractPath = join(prDir, "pr.json");
  const renderedPath = join(prDir, "pr.md");
  cpSync(join(repoRoot, "skills/pr-contract/example.pr.json"), contractPath);
  return { workspace, contractPath, renderedPath };
}

function stdoutText(result: Bun.SyncSubprocess) {
  return new TextDecoder().decode(result.stdout).trim();
}

function stderrText(result: Bun.SyncSubprocess) {
  return new TextDecoder().decode(result.stderr).trim();
}

describe("agent workflow compatibility", () => {
  test("package pr-state entrypoint delegates to the Bun state command", () => {
    const { contractPath } = makeAgentWorkspace();

    const result = Bun.spawnSync({
      cmd: ["bun", "run", "pr-state", "--", "status", "--contract", contractPath, "--format", "json"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(result))).toMatchObject({
      mode: "draft",
      state: "drafting",
    });
  });

  test("Claude-documented validate and render commands succeed on the local working artifact", () => {
    const { contractPath, renderedPath } = makeAgentWorkspace();

    const validateResult = Bun.spawnSync({
      cmd: ["bun", validateScript, contractPath],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(validateResult.exitCode).toBe(0);
    expect(stdoutText(validateResult)).toBe("PASS");

    const renderResult = Bun.spawnSync({
      cmd: ["bun", renderScript, contractPath, "--output", renderedPath, "--emit-hook-block"],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(renderResult.exitCode).toBe(0);
    expect(existsSync(renderedPath)).toBeTrue();

    const rendered = readFileSync(renderedPath, "utf8");
    expect(rendered).toContain("## Summary");
    expect(rendered).toContain("## Behavior Delta");
    expect(rendered).toContain("## Run / Verify");
    expect(rendered).toContain("## Contract (machine-readable)");
    expect(rendered).toContain("<details>");
    expect(rendered).toContain("<!-- pr-contract:start -->");
    expect(rendered).toContain("<!-- pr-contract:end -->");

    const markdownValidateResult = Bun.spawnSync({
      cmd: ["bun", validateScript, renderedPath],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(markdownValidateResult.exitCode).toBe(0);
    expect(stdoutText(markdownValidateResult)).toBe("PASS");
  });

  test("Codex state command honors the default .pr/local/pr.json path from the working directory", () => {
    const { workspace } = makeAgentWorkspace();

    const result = Bun.spawnSync({
      cmd: ["bun", "run", prStateScript, "status", "--format", "json"],
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutText(result))).toMatchObject({
      mode: "draft",
      state: "drafting",
    });
  });

  test("Codex-compatible wrapper delegates to the Bun state command", () => {
    const { workspace } = makeAgentWorkspace();

    const result = Bun.spawnSync({
      cmd: [openModeWrapper, "--format", "mode"],
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(stdoutText(result)).toBe("draft");
    expect(stderrText(result)).toBe("");
  });

  test("Claude-facing pr-state command doc points at full graph and local status", () => {
    const commandDoc = readFileSync(join(repoRoot, "claude", "commands", "pr-state.md"), "utf8");

    expect(commandDoc).toContain("# /pr:state");
    expect(commandDoc).toContain("prx model graph");
    expect(commandDoc).toContain("prx contract status --format json");
  });

  test("Claude-facing pr-update command doc exists", () => {
    const commandDoc = readFileSync(join(repoRoot, "claude", "commands", "pr-update.md"), "utf8");

    expect(commandDoc).toContain("# /pr:update");
    expect(commandDoc).toContain("prx contract update --apply");
    expect(commandDoc).toContain(".pr/local/pr.json");
    expect(commandDoc).toContain(".pr/local/pr.md");
  });

  test("Claude-facing pr-overview command doc exists", () => {
    const commandDoc = readFileSync(join(repoRoot, "claude", "commands", "pr-overview.md"), "utf8");

    expect(commandDoc).toContain("# /pr:overview");
    expect(commandDoc).toContain("prx scout overview");
    expect(commandDoc).toContain("--format json");
  });

  test("Claude-facing pr-runtime-profile command doc exists", () => {
    const commandDoc = readFileSync(join(repoRoot, "claude", "commands", "pr-runtime-profile.md"), "utf8");

    expect(commandDoc).toContain("# /pr:runtime-profile");
    expect(commandDoc).toContain("prx run profile --format plain");
    expect(commandDoc).toContain("--strict-mcp-config");
  });
});
