// prx-g88.1 — the projection + drift guard for the capability-poor orchestrator
// (docs/capability-orchestrator.md §5). The committed `.claude/agents/*.md` MUST
// equal the generator's output, so the dispatch surface cannot drift from the
// policy table. Plus the structural invariants the model rests on.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../src/repo-root.ts";
import {
  POLICY_ROLES,
  allowedSubcommands,
  blockedSubcommands,
  POLICY_TOOLS,
} from "@bounded-systems/policy";
import {
  generateAllAgentDocs,
  generateRoleAgentDoc,
  generateOrchestratorDoc,
} from "../../src/agents/generate.ts";

const agentsDir = join(REPO_ROOT, ".claude", "agents");

describe("actor sub-agent codegen (prx-g88.1)", () => {
  test("every committed .claude/agents/*.md matches the generator (no drift)", () => {
    for (const [name, expected] of generateAllAgentDocs()) {
      const path = join(agentsDir, name);
      expect(existsSync(path), `.claude/agents/${name} is missing — run gen-agents.ts`).toBe(true);
      expect(
        readFileSync(path, "utf8"),
        `.claude/agents/${name} is stale — run \`bun packages/prx/scripts/gen-agents.ts\` and commit`,
      ).toBe(expected);
    }
  });

  test("one doc per policy role, plus the orchestrator", () => {
    const docs = generateAllAgentDocs();
    for (const role of POLICY_ROLES) expect(docs.has(`${role}.md`)).toBe(true);
    expect(docs.has("orchestrator.md")).toBe(true);
    expect(docs.size).toBe(POLICY_ROLES.length + 1);
  });

  test("the orchestrator is capability-poor — no Bash, only Agent + reads", () => {
    const doc = generateOrchestratorDoc();
    const tools = /^tools: (.+)$/m.exec(doc)?.[1] ?? "";
    expect(tools).not.toBe("");
    expect(tools).not.toBe("");
    expect(tools).not.toContain("Bash");
    expect(tools).toContain("Agent");
  });

  test("each role's Allowed section is exactly its policy-table projection", () => {
    for (const role of POLICY_ROLES) {
      const doc = generateRoleAgentDoc(role);
      for (const tool of POLICY_TOOLS) {
        const subs = allowedSubcommands(tool, role);
        if (subs.length > 0) {
          expect(doc).toContain(`- **${tool}** — ${subs.join(", ")}`);
        }
      }
    }
  });

  test("no hard-blocked subcommand ever appears in any role's allowlist", () => {
    for (const role of POLICY_ROLES) {
      for (const tool of POLICY_TOOLS) {
        const allowed = new Set(allowedSubcommands(tool, role));
        for (const blocked of blockedSubcommands(tool)) {
          expect(allowed.has(blocked)).toBe(false);
        }
      }
    }
  });

  // Spot-checks tying the projection to ownership (would catch a table edit that
  // moved a privileged write off its owning actor).
  test("keeper owns the git write-set; forge owns gh merge/ready", () => {
    const keeperGit = new Set(allowedSubcommands("git", "keeper"));
    expect(keeperGit.has("push")).toBe(true);
    expect(keeperGit.has("commit-tree")).toBe(true);
    const forgeGh = new Set(allowedSubcommands("gh", "forge"));
    expect(forgeGh.has("merge")).toBe(true);
    expect(forgeGh.has("ready")).toBe(true);
    // A non-owning role must NOT hold the privileged gh writes.
    expect(new Set(allowedSubcommands("gh", "executor")).has("merge")).toBe(false);
  });
});
