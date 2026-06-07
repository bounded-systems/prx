import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  adapterForCanonicalId,
  type AdapterCommandRunner,
} from "../../src/adapters/domain-adapter.ts";
import {
  GH_OWNED_ON_PULL,
  GhDomainAdapter,
  GhDomainAdapterError,
  githubDomainAdapter,
} from "../../src/adapters/github.ts";
import { GraphQLBudgetExhaustedError, type BudgetSnapshot } from "@bounded-systems/github-budget";
import type { BdExecOptions, BdExecResult } from "@bounded-systems/bd";
import type { BeadsRecord } from "../../src/triage/triage.ts";
import {
  type execGhIssueEdit,
  type GhIssueEditOptions,
  type GhIssueEditResult,
} from "../../src/tools/gh_issue_edit.ts";

// GH-2382 — capture the `gh issue edit` chokepoint calls. The linked push
// routes its edit through `execGhIssueEdit` (not the raw runner), so edit
// assertions read the captured `GhIssueEditOptions` rather than a gh argv.
function recordingEdit(
  result: GhIssueEditResult = { exitCode: 0, stdout: "", stderr: "" },
): { edit: typeof execGhIssueEdit; calls: GhIssueEditOptions[] } {
  const calls: GhIssueEditOptions[] = [];
  const edit = ((opts: GhIssueEditOptions) => {
    calls.push(opts);
    return result;
  }) as typeof execGhIssueEdit;
  return { edit, calls };
}

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-x",
    title: "My issue",
    description: "body text",
    status: "open",
    priority: 1,
    issueType: "bug",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    ...overrides,
  };
}

type GhCall = { cmd: string[]; cwd?: string | undefined };

function recordingRunner(
  responder: (cmd: string[]) => { stdout: string; stderr: string; status: number },
): { runner: AdapterCommandRunner; calls: GhCall[] } {
  const calls: GhCall[] = [];
  const runner: AdapterCommandRunner = (cmd, options) => {
    calls.push({ cmd: [...cmd], cwd: options?.cwd });
    return responder(cmd);
  };
  return { runner, calls };
}

function recordingBdExec(
  result: BdExecResult = { exitCode: 0, stdout: "", stderr: "", policy: null },
): { exec: (opts: BdExecOptions) => BdExecResult; calls: BdExecOptions[] } {
  const calls: BdExecOptions[] = [];
  return {
    exec: (opts: BdExecOptions) => {
      calls.push(opts);
      return result;
    },
    calls,
  };
}

describe("GhDomainAdapter — config / ownedOnPull pin", () => {
  // The ADR doc-drift assertion reads ai-home's docs/spikes/GH-1500-authority.md (absent in prx).
  test.skipIf(!existsSync(join(import.meta.dir, "..", "..", "..", "..", "docs", "spikes", "GH-1500-authority.md")))("ADR §2 GitHub column is the literal ownedOnPull declaration", () => {
    // If you change this list you MUST also update docs/spikes/GH-1500-authority.md §2.
    // GH-1874: `assignees` moved to bd-canonical and left this set.
    expect(GH_OWNED_ON_PULL).toEqual(["externalIssueNumber", "milestone", "status"]);
    expect(githubDomainAdapter.config.ownedOnPull).toEqual([
      "externalIssueNumber",
      "milestone",
      "status",
    ]);
    // The ADR §2 doc pins the same literal — keeps the doc and the adapter from drifting.
    const adr = readFileSync(
      join(import.meta.dir, "..", "..", "..", "..", "docs", "spikes", "GH-1500-authority.md"),
      "utf8",
    );
    expect(adr).toContain('["externalIssueNumber", "milestone", "status"]');
  });

  test("config: domain gh, surfaceIdPattern /^GH-\\d+$/, externalIdShape issue-url", () => {
    expect(githubDomainAdapter.config.domain).toBe("gh");
    expect(githubDomainAdapter.config.surfaceIdPattern.source).toBe("^GH-\\d+$");
    expect(githubDomainAdapter.config.externalIdShape).toBe("issue-url");
  });

  test("registered under domain 'gh' and resolvable by canonical id", () => {
    expect(adapterForCanonicalId("GH-1536")).toBe(githubDomainAdapter);
  });

  test("matchesSurfaceId / surfaceIdToExternalId", () => {
    const adapter = new GhDomainAdapter({ repoNameWithOwner: () => "o/r", cwd: () => "/repo" });
    expect(adapter.matchesSurfaceId("GH-1")).toBe(true);
    expect(adapter.matchesSurfaceId(" GH-1 ")).toBe(true);
    expect(adapter.matchesSurfaceId("GH-x")).toBe(false);
    expect(adapter.matchesSurfaceId("NOTION-1")).toBe(false);
    expect(adapter.surfaceIdToExternalId("GH-456")).toBe("https://github.com/o/r/issues/456");
    expect(adapter.surfaceIdToExternalId("GH-456", { repo: "x/y" })).toBe(
      "https://github.com/x/y/issues/456",
    );
    expect(() => adapter.surfaceIdToExternalId("bd-123")).toThrow(GhDomainAdapterError);
  });
});

describe("GhDomainAdapter.pull", () => {
  test("parses gh issue view --json into the GitHub-owned patch", async () => {
    const { runner, calls } = recordingRunner(() => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        number: 204,
        url: "https://github.com/o/r/issues/204",
        state: "OPEN",
        assignees: [{ login: "alice" }, { login: "bob" }],
        milestone: { title: "v2" },
      }),
    }));
    const adapter = new GhDomainAdapter({ runner, cwd: () => "/repo" });
    const patch = await adapter.pull("https://github.com/o/r/issues/204");
    expect(patch).toEqual({
      externalIssueNumber: 204,
      status: "open",
      assignees: ["alice", "bob"],
      milestone: "v2",
    });
    expect(calls).toEqual([
      {
        cmd: [
          "gh",
          "issue",
          "view",
          "204",
          "--json",
          "number,url,state,assignees,milestone",
          "-R",
          "o/r",
        ],
        cwd: "/repo",
      },
    ]);
  });

  test("closed issue with no assignees / milestone", async () => {
    const { runner } = recordingRunner(() => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify({ number: 9, state: "CLOSED", assignees: [], milestone: null }),
    }));
    const adapter = new GhDomainAdapter({ runner, cwd: () => "/repo" });
    expect(await adapter.pull("GH-9")).toEqual({
      externalIssueNumber: 9,
      status: "closed",
      assignees: [],
      milestone: null,
    });
  });

  test("budget-exhaustion errors propagate typed", async () => {
    const snapshot: BudgetSnapshot = {
      bucket: "graphql",
      limit: 5000,
      remaining: 0,
      resetAt: Date.now() + 60_000,
      fetchedAt: Date.now(),
    };
    const runner: AdapterCommandRunner = () => {
      throw new GraphQLBudgetExhaustedError(snapshot, ["gh", "issue", "view", "1"]);
    };
    const adapter = new GhDomainAdapter({ runner, cwd: () => "/repo" });
    await expect(adapter.pull("GH-1")).rejects.toBeInstanceOf(GraphQLBudgetExhaustedError);
  });

  test("non-zero exit raises a GhDomainAdapterError", async () => {
    const { runner } = recordingRunner(() => ({ status: 1, stderr: "not found", stdout: "" }));
    const adapter = new GhDomainAdapter({ runner, cwd: () => "/repo" });
    await expect(adapter.pull("GH-7")).rejects.toThrow(/gh adapter pull: not found/i);
  });
});

describe("GhDomainAdapter.pull — conditional reads (GH-296 / prx-lzw lever 1)", () => {
  // An in-memory GhConditionalReadCache.
  function memCache(): {
    cache: { get: (id: string) => { etag: string; value: string } | undefined; set: (id: string, e: { etag: string; value: string }) => void };
    map: Map<string, { etag: string; value: string }>;
  } {
    const map = new Map<string, { etag: string; value: string }>();
    return { map, cache: { get: (id) => map.get(id), set: (id, e) => void map.set(id, e) } };
  }

  // `gh api -i` 200 response: status line, headers, blank, JSON body.
  const resp200 = (etag: string, body: object) => ({
    status: 0,
    stderr: "",
    stdout: `HTTP/2.0 200 OK\nEtag: ${etag}\n\n${JSON.stringify(body)}`,
  });
  // `gh api -i -H If-None-Match` on an unchanged issue: 304, exit 1, no body.
  const resp304 = (etag: string) => ({
    status: 1,
    stderr: "gh: HTTP 304",
    stdout: `HTTP/2.0 304 Not Modified\nEtag: ${etag}\n`,
  });

  test("cold read: no If-None-Match, hits gh api -i, parses + caches {etag, patch}", async () => {
    const { cache, map } = memCache();
    const { runner, calls } = recordingRunner(() =>
      resp200('W/"v1"', { number: 204, state: "open", assignees: [{ login: "alice" }], milestone: { title: "v2" } }),
    );
    const adapter = new GhDomainAdapter({ runner, cwd: () => "/repo", conditionalRead: cache });
    const patch = await adapter.pull("https://github.com/o/r/issues/204");
    expect(patch).toEqual({ externalIssueNumber: 204, status: "open", assignees: ["alice"], milestone: "v2" });
    // gh api against the REST issue path, with -i, and NO If-None-Match (cold).
    expect(calls[0]!.cmd).toEqual(["gh", "api", "repos/o/r/issues/204", "-i"]);
    // cached for next tick.
    expect(map.get("https://github.com/o/r/issues/204")).toEqual({
      etag: 'W/"v1"',
      value: JSON.stringify(patch),
    });
  });

  test("warm read: sends If-None-Match, a free 304 reuses the cached patch (no body parse)", async () => {
    const { cache, map } = memCache();
    const cachedPatch = { externalIssueNumber: 204, status: "open", assignees: ["alice"], milestone: "v2" };
    map.set("https://github.com/o/r/issues/204", { etag: 'W/"v1"', value: JSON.stringify(cachedPatch) });
    const { runner, calls } = recordingRunner(() => resp304('W/"v1"'));
    const adapter = new GhDomainAdapter({ runner, cwd: () => "/repo", conditionalRead: cache });
    const patch = await adapter.pull("https://github.com/o/r/issues/204");
    expect(patch).toEqual(cachedPatch); // reused, NOT an error despite exit 1
    expect(calls[0]!.cmd).toEqual([
      "gh", "api", "repos/o/r/issues/204", "-i", "-H", 'If-None-Match: W/"v1"',
    ]);
  });

  test("warm read that CHANGED (200) re-parses fresh state and updates the cache", async () => {
    const { cache, map } = memCache();
    map.set("https://github.com/o/r/issues/204", {
      etag: 'W/"v1"',
      value: JSON.stringify({ externalIssueNumber: 204, status: "open", assignees: [], milestone: null }),
    });
    const { runner } = recordingRunner(() => resp200('W/"v2"', { number: 204, state: "closed", assignees: [], milestone: null }));
    const adapter = new GhDomainAdapter({ runner, cwd: () => "/repo", conditionalRead: cache });
    const patch = await adapter.pull("https://github.com/o/r/issues/204");
    expect(patch.status).toBe("closed"); // REST lowercase state maps through
    expect(map.get("https://github.com/o/r/issues/204")!.etag).toBe('W/"v2"');
  });

  test("a genuine error (404, also exit 1) throws — not mistaken for a 304", async () => {
    const { cache } = memCache();
    const { runner } = recordingRunner(() => ({
      status: 1,
      stderr: "gh: HTTP 404",
      stdout: 'HTTP/2.0 404 Not Found\n\n{"message":"Not Found"}',
    }));
    const adapter = new GhDomainAdapter({ runner, cwd: () => "/repo", conditionalRead: cache });
    await expect(adapter.pull("https://github.com/o/r/issues/9")).rejects.toThrow(/gh adapter pull/i);
  });

  test("304 with an unusable cached value refetches unconditionally and re-derives", async () => {
    const { cache, map } = memCache();
    map.set("https://github.com/o/r/issues/204", { etag: 'W/"v1"', value: "{corrupt" });
    let n = 0;
    const { runner, calls } = recordingRunner(() => {
      n += 1;
      return n === 1
        ? resp304('W/"v1"') // first (conditional) → 304 but cache is corrupt
        : resp200('W/"v3"', { number: 204, state: "open", assignees: [], milestone: null }); // refetch
    });
    const adapter = new GhDomainAdapter({ runner, cwd: () => "/repo", conditionalRead: cache });
    const patch = await adapter.pull("https://github.com/o/r/issues/204");
    expect(patch.status).toBe("open");
    // second call is the unconditional refetch (no If-None-Match).
    expect(calls[1]!.cmd).toEqual(["gh", "api", "repos/o/r/issues/204", "-i"]);
    expect(map.get("https://github.com/o/r/issues/204")!.etag).toBe('W/"v3"');
  });
});

describe("GhDomainAdapter.push", () => {
  test("create path: dedup-clean → gh issue create + bd write-back", async () => {
    const { runner, calls } = recordingRunner((cmd) => {
      if (cmd.includes("create")) {
        return { status: 0, stderr: "", stdout: "https://github.com/o/r/issues/999\n" };
      }
      throw new Error(`unexpected gh call: ${cmd.join(" ")}`);
    });
    const bd = recordingBdExec();
    const adapter = new GhDomainAdapter({
      runner,
      loadAllBeads: () => [],
      execBd: bd.exec,
      // GH-296: write-back routes through the daemon helper; record the
      // equivalent old `bd update --external-ref` shape for the assertion.
      updateBead: (async (id: string, fields: { externalRef?: string }) => {
        bd.calls.push({
          subcommand: "update",
          args: [id, "--external-ref", fields.externalRef ?? ""],
          state: "planning",
          role: "planner",
        } as never);
        return null;
      }) as never,
      repoNameWithOwner: () => "o/r",
      cwd: () => "/repo",
    });
    const result = await adapter.push(bead(), {
      title: "My issue",
      body: "body text",
      labels: ["type::bug", "priority::high"],
    });
    expect(result).toEqual({
      externalId: "https://github.com/o/r/issues/999",
      created: true,
      edited: true,
    });
    expect(calls).toEqual([
      {
        cmd: [
          "gh",
          "issue",
          "create",
          "-R",
          "o/r",
          "--title",
          "My issue",
          "--body",
          "body text",
          "--label",
          "type::bug",
          "--label",
          "priority::high",
        ],
        cwd: "/repo",
      },
    ]);
    expect(bd.calls).toEqual([
      {
        subcommand: "update",
        args: ["ai-home-x", "--external-ref", "https://github.com/o/r/issues/999"],
        state: "planning",
        role: "planner",
      },
    ]);
  });

  test("create path: refuses to create a duplicate when a same-title bd is already mirrored", async () => {
    const { runner, calls } = recordingRunner(() => {
      throw new Error("gh should not be called");
    });
    const bd = recordingBdExec();
    const adapter = new GhDomainAdapter({
      runner,
      loadAllBeads: () => [
        bead({
          id: "ai-home-other",
          title: "My issue",
          externalIssueNumber: 42,
          externalRef: "https://github.com/o/r/issues/42",
        }),
      ],
      execBd: bd.exec,
      repoNameWithOwner: () => "o/r",
      cwd: () => "/repo",
    });
    await expect(adapter.push(bead(), { title: "My issue" })).rejects.toThrow(
      /refusing to create a duplicate GitHub issue/i,
    );
    expect(calls).toEqual([]);
    expect(bd.calls).toEqual([]);
  });

  test("linked path: idempotent edit of only the requested fields; no bd write-back", async () => {
    // GH-2382: the linked edit reads the live issue (title + labels here) and
    // routes the edit through the `execGhIssueEdit` chokepoint, not the raw
    // runner. Title differs → rewritten; `agent::executor` is a foreign label
    // → added; no managed-axis label to strip.
    const { runner, calls } = recordingRunner((cmd) => {
      if (cmd.includes("view")) {
        return { status: 0, stderr: "", stdout: JSON.stringify({ title: "Old", labels: [] }) };
      }
      throw new Error(`unexpected gh call: ${cmd.join(" ")}`);
    });
    const { edit, calls: editCalls } = recordingEdit();
    const bd = recordingBdExec();
    const adapter = new GhDomainAdapter({
      runner,
      execGhIssueEdit: edit,
      execBd: bd.exec,
      cwd: () => "/repo",
    });
    const result = await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/999" }),
      { title: "Renamed", labels: ["agent::executor"] },
    );
    expect(result).toEqual({
      externalId: "https://github.com/o/r/issues/999",
      created: false,
      edited: true,
    });
    expect(calls[0]?.cmd).toEqual([
      "gh",
      "issue",
      "view",
      "999",
      "--json",
      "title,labels",
      "-R",
      "o/r",
    ]);
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]).toEqual({
      number: 999,
      repo: "o/r",
      title: "Renamed",
      addLabels: ["agent::executor"],
      cwd: "/repo",
    });
    // Direction-lock (I-DS-PRIO / I-PROJ1): no bd write-back from a linked reconcile.
    expect(bd.calls).toEqual([]);
  });

  test("linked path: title already matches live → not rewritten (real no-op, GH-2382)", async () => {
    const { runner } = recordingRunner((cmd) => {
      if (cmd.includes("view")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({ title: "Same", body: "Same body" }),
        };
      }
      throw new Error(`unexpected gh call: ${cmd.join(" ")}`);
    });
    const { edit, calls: editCalls } = recordingEdit();
    const adapter = new GhDomainAdapter({ runner, execGhIssueEdit: edit, cwd: () => "/repo" });
    const result = await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/999" }),
      { title: "Same", body: "Same body" },
    );
    expect(result.edited).toBe(false);
    expect(editCalls).toEqual([]);
  });

  test("linked path: no requested fields → no gh call, still a successful no-op", async () => {
    const { runner, calls } = recordingRunner(() => {
      throw new Error("gh should not be called");
    });
    const { edit, calls: editCalls } = recordingEdit();
    const adapter = new GhDomainAdapter({ runner, execGhIssueEdit: edit, cwd: () => "/repo" });
    const result = await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/999" }),
      {},
    );
    expect(result).toEqual({
      externalId: "https://github.com/o/r/issues/999",
      created: false,
      edited: false,
    });
    expect(calls).toEqual([]);
    expect(editCalls).toEqual([]);
  });

  // GH-2382 — the bug repro: a bd priority bump (P3→P2) must swap the GH rung
  // losslessly: add `priority::medium`, remove the stale `priority::low`, while
  // preserving foreign + unmanaged-axis labels.
  test("linked path: priority bump swaps the rung (add new, remove stale), preserves foreign labels", async () => {
    const { runner, calls } = recordingRunner((cmd) => {
      if (cmd.includes("view")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({
            labels: [
              { name: "type::task" },
              { name: "priority::low" },
              { name: "area::prx" },
              { name: "needs-triage" },
            ],
          }),
        };
      }
      throw new Error(`unexpected gh call: ${cmd.join(" ")}`);
    });
    const { edit, calls: editCalls } = recordingEdit();
    const adapter = new GhDomainAdapter({ runner, execGhIssueEdit: edit, cwd: () => "/repo" });
    const result = await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/999" }),
      { labels: ["type::task", "priority::medium"] },
    );
    expect(result.edited).toBe(true);
    expect(calls[0]?.cmd).toEqual([
      "gh",
      "issue",
      "view",
      "999",
      "--json",
      "labels",
      "-R",
      "o/r",
    ]);
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.addLabels).toEqual(["priority::medium"]);
    expect(editCalls[0]?.removeLabels).toEqual(["priority::low"]);
  });

  test("linked path: labels already in sync → no edit (real no-op)", async () => {
    const { runner } = recordingRunner((cmd) => {
      if (cmd.includes("view")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({ labels: [{ name: "type::task" }, { name: "priority::medium" }] }),
        };
      }
      throw new Error(`unexpected gh call: ${cmd.join(" ")}`);
    });
    const { edit, calls: editCalls } = recordingEdit();
    const adapter = new GhDomainAdapter({ runner, execGhIssueEdit: edit, cwd: () => "/repo" });
    const result = await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/999" }),
      { labels: ["type::task", "priority::medium"] },
    );
    expect(result.edited).toBe(false);
    expect(editCalls).toEqual([]);
  });

  test("linked path: GH-only type::spike marker is preserved across a push (GH-2382)", async () => {
    const { runner } = recordingRunner((cmd) => {
      if (cmd.includes("view")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({ labels: [{ name: "type::task" }, { name: "type::spike" }] }),
        };
      }
      throw new Error(`unexpected gh call: ${cmd.join(" ")}`);
    });
    const { edit, calls: editCalls } = recordingEdit();
    const adapter = new GhDomainAdapter({ runner, execGhIssueEdit: edit, cwd: () => "/repo" });
    await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/999" }),
      { labels: ["type::task", "priority::high"] },
    );
    // Only `priority::high` is added; `type::spike` (GH-only marker, not in
    // BD_TYPE_ENUM) is never stripped, and `type::task` already matches.
    expect(editCalls[0]?.addLabels).toEqual(["priority::high"]);
    expect(editCalls[0]?.removeLabels).toBeUndefined();
  });

  // GH-1874: assignee projection. bd is canonical for the assignee column;
  // push() takes the desired set from the caller, reads current GH state, and
  // emits the minimal `addAssignees`/`removeAssignees` delta through the edit
  // chokepoint.
  test("linked path: assignees set — adds missing, no remove when GH was empty", async () => {
    const { runner, calls } = recordingRunner((cmd) => {
      if (cmd.includes("view")) {
        return { status: 0, stderr: "", stdout: JSON.stringify({ assignees: [] }) };
      }
      throw new Error(`unexpected gh call: ${cmd.join(" ")}`);
    });
    const { edit, calls: editCalls } = recordingEdit();
    const adapter = new GhDomainAdapter({ runner, execGhIssueEdit: edit, cwd: () => "/repo" });
    const result = await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/999" }),
      { assignees: ["alice"] },
    );
    expect(result).toEqual({
      externalId: "https://github.com/o/r/issues/999",
      created: false,
      edited: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toEqual([
      "gh",
      "issue",
      "view",
      "999",
      "--json",
      "assignees",
      "-R",
      "o/r",
    ]);
    expect(editCalls[0]?.addAssignees).toEqual(["alice"]);
    expect(editCalls[0]?.removeAssignees).toBeUndefined();
  });

  test("linked path: assignees [] clears the current set", async () => {
    const { runner } = recordingRunner((cmd) => {
      if (cmd.includes("view")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({ assignees: [{ login: "alice" }, { login: "bob" }] }),
        };
      }
      throw new Error(`unexpected gh call: ${cmd.join(" ")}`);
    });
    const { edit, calls: editCalls } = recordingEdit();
    const adapter = new GhDomainAdapter({ runner, execGhIssueEdit: edit, cwd: () => "/repo" });
    await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/999" }),
      { assignees: [] },
    );
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.removeAssignees?.slice().sort()).toEqual(["alice", "bob"]);
    expect(editCalls[0]?.addAssignees).toBeUndefined();
  });

  test("linked path: assignees ['alice'] when GH already has ['alice', 'bob'] → remove bob only", async () => {
    const { runner } = recordingRunner((cmd) => {
      if (cmd.includes("view")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({ assignees: [{ login: "alice" }, { login: "bob" }] }),
        };
      }
      throw new Error(`unexpected gh call: ${cmd.join(" ")}`);
    });
    const { edit, calls: editCalls } = recordingEdit();
    const adapter = new GhDomainAdapter({ runner, execGhIssueEdit: edit, cwd: () => "/repo" });
    await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/999" }),
      { assignees: ["alice"] },
    );
    expect(editCalls[0]?.removeAssignees).toEqual(["bob"]);
    expect(editCalls[0]?.addAssignees).toBeUndefined();
  });

  test("linked path: assignees match GH state exactly → no edit call", async () => {
    const { runner, calls } = recordingRunner((cmd) => {
      if (cmd.includes("view")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({ assignees: [{ login: "alice" }] }),
        };
      }
      throw new Error(`unexpected gh call: ${cmd.join(" ")}`);
    });
    const { edit, calls: editCalls } = recordingEdit();
    const adapter = new GhDomainAdapter({ runner, execGhIssueEdit: edit, cwd: () => "/repo" });
    const result = await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/999" }),
      { assignees: ["alice"] },
    );
    // Only the view call — no edit, since the diff is empty.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd[2]).toBe("view");
    expect(editCalls).toEqual([]);
    expect(result.edited).toBe(false);
  });

  test("linked path: status reopen when bd is open but GH is closed (GH-2382)", async () => {
    const { runner, calls } = recordingRunner((cmd) => {
      if (cmd.includes("view")) {
        return { status: 0, stderr: "", stdout: JSON.stringify({ state: "CLOSED" }) };
      }
      if (cmd.includes("reopen")) return { status: 0, stderr: "", stdout: "" };
      throw new Error(`unexpected gh call: ${cmd.join(" ")}`);
    });
    const { edit, calls: editCalls } = recordingEdit();
    const adapter = new GhDomainAdapter({ runner, execGhIssueEdit: edit, cwd: () => "/repo" });
    const result = await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/999" }),
      { status: "open" },
    );
    expect(result.edited).toBe(true);
    // Status is a distinct `gh issue reopen` subcommand, not `gh issue edit`.
    expect(editCalls).toEqual([]);
    expect(calls.map((c) => c.cmd[1])).toEqual(["issue", "issue"]);
    expect(calls[1]?.cmd).toEqual(["gh", "issue", "reopen", "999", "-R", "o/r"]);
  });

  test("linked path: undefined fields are a no-op (idempotency preserved)", async () => {
    const { runner, calls } = recordingRunner(() => {
      throw new Error("gh should not be called");
    });
    const { edit, calls: editCalls } = recordingEdit();
    const adapter = new GhDomainAdapter({ runner, execGhIssueEdit: edit, cwd: () => "/repo" });
    const result = await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/999" }),
      {},
    );
    expect(calls).toEqual([]);
    expect(editCalls).toEqual([]);
    expect(result.edited).toBe(false);
  });

  test("linked path: dryRun via reconcileLinked computes the swap but writes nothing", () => {
    const { runner, calls } = recordingRunner((cmd) => {
      if (cmd.includes("view")) {
        return {
          status: 0,
          stderr: "",
          stdout: JSON.stringify({ labels: [{ name: "type::task" }, { name: "priority::low" }] }),
        };
      }
      throw new Error(`unexpected gh call: ${cmd.join(" ")}`);
    });
    const { edit, calls: editCalls } = recordingEdit();
    const adapter = new GhDomainAdapter({ runner, execGhIssueEdit: edit, cwd: () => "/repo" });
    const planned = adapter.reconcileLinked(
      "https://github.com/o/r/issues/999",
      { labels: ["type::task", "priority::medium"] },
      { dryRun: true },
    );
    expect(planned.edited).toBe(true);
    expect(planned.addLabels).toEqual(["priority::medium"]);
    expect(planned.removeLabels).toEqual(["priority::low"]);
    // The read happened, but no edit was written.
    expect(calls).toHaveLength(1);
    expect(editCalls).toEqual([]);
  });
});

describe("GhDomainAdapter.recognizesExternalId", () => {
  const adapter = new GhDomainAdapter({ cwd: () => "/repo" });

  test("true for full GitHub issue URLs (incl. trailing fragment/query)", () => {
    expect(adapter.recognizesExternalId("https://github.com/o/r/issues/1")).toBe(true);
    expect(
      adapter.recognizesExternalId("https://github.com/o/r/issues/1?source=intake"),
    ).toBe(true);
    expect(adapter.recognizesExternalId(" HTTPS://GITHUB.COM/o/r/issues/2 ")).toBe(true);
  });

  test("false for GH-N / #N / bare numbers / non-GH URLs / empty", () => {
    expect(adapter.recognizesExternalId("GH-456")).toBe(false);
    expect(adapter.recognizesExternalId("#42")).toBe(false);
    expect(adapter.recognizesExternalId("42")).toBe(false);
    expect(adapter.recognizesExternalId("https://www.notion.so/page-abc")).toBe(false);
    expect(adapter.recognizesExternalId("")).toBe(false);
  });
});

describe("GhDomainAdapter.resolve / resolveFromBeads", () => {
  const records: BeadsRecord[] = [
    bead({
      id: "ai-home-a",
      externalRef: "https://github.com/o/r/issues/204",
      externalRefs: { gh: "https://github.com/o/r/issues/204" },
      externalIssueNumber: 204,
    }),
    bead({ id: "ai-home-b", externalRef: null, externalIssueNumber: 99 }),
  ];

  function adapter(): GhDomainAdapter {
    return new GhDomainAdapter({ loadAllBeads: () => records, cwd: () => "/repo" });
  }

  test("URL match → bd short-id", async () => {
    expect(await adapter().resolve("https://github.com/o/r/issues/204")).toBe("ai-home-a");
  });

  test("issue-number fallback (GH-N / #N / bare N) → bd short-id", async () => {
    expect(await adapter().resolve("GH-99")).toBe("ai-home-b");
    expect(await adapter().resolve("#99")).toBe("ai-home-b");
    expect(await adapter().resolve("99")).toBe("ai-home-b");
  });

  test("no mirror → null", async () => {
    expect(await adapter().resolve("https://github.com/o/r/issues/777")).toBeNull();
    expect(await adapter().resolve("GH-777")).toBeNull();
  });

  test("never prefix-matches a bd long-id (non-GH input → null, not self)", async () => {
    expect(await adapter().resolve("ai-home-a")).toBeNull();
    expect(await adapter().resolve("not-an-id")).toBeNull();
  });

  test("`resolveFromBeads` is the sync sibling of `resolve` — same dispatch contract", () => {
    // Pass beads directly (no `loadAllBeads` dep) to confirm the sync seam.
    const sync = new GhDomainAdapter({ cwd: () => "/repo" });
    expect(sync.resolveFromBeads("https://github.com/o/r/issues/204", records)).toBe(
      "ai-home-a",
    );
    expect(sync.resolveFromBeads("GH-99", records)).toBe("ai-home-b");
    expect(sync.resolveFromBeads("https://github.com/o/r/issues/777", records)).toBeNull();
    expect(sync.resolveFromBeads("ai-home-a", records)).toBeNull();
  });

  test("`resolveFromBeads` looks up via the `byDomainExternalId.get(\"gh\")` index — not legacy `byUrl`", () => {
    // A record whose legacy `externalRef` is set but `externalRefs.gh` is NOT
    // populated represents a "loaded before GH-1538" snapshot. `resolveFromBeads`
    // is the post-GH-1538 contract: it dispatches via `externalRefs`, so this
    // record should NOT be resolvable via URL match — only via the
    // issue-number fallback. Documents that `loadAllBeads` is responsible for
    // promoting legacy `external_ref` into `externalRefs.gh`.
    const legacyOnly: BeadsRecord[] = [
      bead({
        id: "ai-home-legacy",
        externalRef: "https://github.com/o/r/issues/555",
        externalRefs: {},
        externalIssueNumber: 555,
      }),
    ];
    const sync = new GhDomainAdapter({ cwd: () => "/repo" });
    // URL path → byDomainExternalId miss → falls back to byIssueNumber.
    expect(
      sync.resolveFromBeads("https://github.com/o/r/issues/555", legacyOnly),
    ).toBe("ai-home-legacy");
  });
});

describe("GhDomainAdapter — BeadsCache sharing (GH-1595)", () => {
  test("N `push()` calls in one process read beads exactly once when a shared cache is wired", async () => {
    // The `prx beads sync` bulk loop calls `adapter.push` once per pinned
    // pair; before GH-1595 each call ran a fresh `bd list --all --json
    // --limit 0` to check the unlinked-dedup invariant. The cache wires the
    // adapter to a memoized loader: subsequent `push`es reuse the snapshot.
    const { createBeadsCache } = await import("../../src/triage/beads_cache.ts");
    let reads = 0;
    const cache = createBeadsCache({
      loadAllBeads: () => {
        reads += 1;
        return [];
      },
    });

    const { runner } = recordingRunner(() => ({
      status: 0,
      stderr: "",
      stdout: "https://github.com/o/r/issues/1\n",
    }));
    const bd = recordingBdExec();
    const adapter = new GhDomainAdapter({
      runner,
      loadAllBeads: () => cache.load(),
      invalidateBeadsCache: cache.invalidate,
      execBd: bd.exec,
      updateBead: (async () => null) as never,
      repoNameWithOwner: () => "o/r",
      cwd: () => "/repo",
    });

    // Unlinked path runs `loadBeads()` for the dedup scan + then writes back;
    // the write-back invalidates the cache, so each iteration re-reads.
    await adapter.push(bead({ id: "ai-home-1" }), { title: "t1" });
    expect(reads).toBe(1);

    // After invalidation the next call re-reads; that's the correctness
    // promise. But within a single un-invalidated window (e.g., back-to-back
    // resolve()s), reads stay capped at 1.
    await adapter.resolve("https://github.com/o/r/issues/1");
    await adapter.resolve("https://github.com/o/r/issues/1");
    expect(reads).toBe(2);
  });

  test("push() write-back path invokes `invalidateBeadsCache` exactly once on success", async () => {
    let invalidations = 0;
    // Unlinked create returns a URL on stdout; the linked view returns JSON.
    const { runner } = recordingRunner((cmd) => {
      if (cmd.includes("view")) {
        return { status: 0, stderr: "", stdout: JSON.stringify({ title: "old" }) };
      }
      return { status: 0, stderr: "", stdout: "https://github.com/o/r/issues/42\n" };
    });
    const { edit } = recordingEdit();
    const bd = recordingBdExec();
    const adapter = new GhDomainAdapter({
      runner,
      execGhIssueEdit: edit,
      loadAllBeads: () => [],
      invalidateBeadsCache: () => {
        invalidations += 1;
      },
      execBd: bd.exec,
      updateBead: (async () => null) as never,
      repoNameWithOwner: () => "o/r",
      cwd: () => "/repo",
    });

    await adapter.push(bead({ id: "ai-home-x" }), { title: "t" });
    expect(invalidations).toBe(1);

    // Linked path is idempotent — no bd write-back → no invalidate.
    await adapter.push(
      bead({ externalRef: "https://github.com/o/r/issues/42" }),
      { title: "renamed" },
    );
    expect(invalidations).toBe(1);
  });
});

// GH-2011: GH adapter's `bulkClose` now loops the narrow `execBdIssueClose`
// wrapper instead of dispatching repo-wide via the retired
// `bd github sync --pull-only --prefer-github` shell-out. The destructive
// shell-out dropped bd-only writes for `issue_type` / `assignee` /
// `state` / `close_reason`; the per-id close stays inside the
// bd-canonical authority boundary.
describe("GhDomainAdapter.bulkClose (GH-2011)", () => {
  type CloseCall = { id: string; cwd: string | undefined; reason: string | undefined };

  function recordingClose(
    response: (call: CloseCall) => { exitCode: number; stdout: string; stderr: string } = () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }),
  ): {
    execBdIssueClose: (opts: { id: string; cwd?: string; reason?: string }) => {
      exitCode: number;
      stdout: string;
      stderr: string;
    };
    calls: CloseCall[];
  } {
    const calls: CloseCall[] = [];
    return {
      calls,
      execBdIssueClose: (opts) => {
        const call: CloseCall = { id: opts.id, cwd: opts.cwd, reason: opts.reason };
        calls.push(call);
        return response(call);
      },
    };
  }

  test("invokes execBdIssueClose once per bead id with reason='closed-by-pull'", () => {
    const { execBdIssueClose, calls } = recordingClose();
    const adapter = new GhDomainAdapter({
      execBdIssueClose,
      cwd: () => "/default",
    });
    const result = adapter.bulkClose({
      cwd: "/repo",
      beadIds: ["ai-home-1", "ai-home-2"],
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      { id: "ai-home-1", cwd: "/repo", reason: "closed-by-pull" },
      { id: "ai-home-2", cwd: "/repo", reason: "closed-by-pull" },
    ]);
  });

  test("does not invoke any `bd github sync` shell-out (GH-2011 regression)", () => {
    let bdSpawnCount = 0;
    const adapter = new GhDomainAdapter({
      execBdIssueClose: () => {
        // Replaces the previous repo-wide reconcile that would have spawned
        // `bd github sync --pull-only --prefer-github` once. With the per-id
        // close path, the only bd spawn shape is `bd close <id>`.
        bdSpawnCount += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      cwd: () => "/repo",
    });
    adapter.bulkClose({ cwd: "/repo", beadIds: ["ai-home-9"] });
    expect(bdSpawnCount).toBe(1);
  });

  test("empty beadIds → no spawns, exit 0", () => {
    const { execBdIssueClose, calls } = recordingClose();
    const adapter = new GhDomainAdapter({
      execBdIssueClose,
      cwd: () => "/repo",
    });
    expect(adapter.bulkClose({ cwd: "/repo", beadIds: [] })).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(calls).toEqual([]);
  });

  test("propagates first non-zero exit code", () => {
    const { execBdIssueClose } = recordingClose((call) => {
      if (call.id === "ai-home-bad") {
        return { exitCode: 2, stdout: "", stderr: "bd: close refused" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    });
    const adapter = new GhDomainAdapter({
      execBdIssueClose,
      cwd: () => "/repo",
    });
    const result = adapter.bulkClose({
      cwd: "/repo",
      beadIds: ["ai-home-bad", "ai-home-ok"],
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("bd: close refused");
  });
});

describe("GhDomainAdapter.enumerate (GH-1469)", () => {
  test("returns one ExternalRecordRef per issue in [from,to], via the gated runner", async () => {
    const { runner, calls } = recordingRunner((cmd) => {
      // `gh issue list --json number,url,state` — returns issues only (gh
      // excludes PRs). Includes records outside the range to prove the filter.
      expect(cmd.slice(0, 3)).toEqual(["gh", "issue", "list"]);
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify([
          { number: 1466, url: "https://github.com/o/r/issues/1466", state: "OPEN" },
          { number: 1403, url: "https://github.com/o/r/issues/1403", state: "CLOSED" },
          { number: 1259, url: "https://github.com/o/r/issues/1259", state: "OPEN" },
          { number: 874, url: "https://github.com/o/r/issues/874", state: "CLOSED" },
          { number: 2000, url: "https://github.com/o/r/issues/2000", state: "OPEN" },
        ]),
      };
    });
    const adapter = new GhDomainAdapter({ runner, repoNameWithOwner: () => "o/r", cwd: () => "/repo" });
    const refs = await adapter.enumerate({ from: 1259, to: 1466 });

    // 874 (below) and 2000 (above) filtered out; sorted ascending by number.
    expect(refs).toEqual([
      { externalId: "https://github.com/o/r/issues/1259", surfaceId: "GH-1259", number: 1259, state: "open" },
      { externalId: "https://github.com/o/r/issues/1403", surfaceId: "GH-1403", number: 1403, state: "closed" },
      { externalId: "https://github.com/o/r/issues/1466", surfaceId: "GH-1466", number: 1466, state: "open" },
    ]);

    // Gated runner usage: one `gh issue list` with --state all and the JSON fields.
    expect(calls).toHaveLength(1);
    const cmd = calls[0]!.cmd;
    expect(cmd).toContain("--state");
    expect(cmd).toContain("all");
    expect(cmd).toContain("-R");
    expect(cmd).toContain("o/r");
    expect(cmd).toContain("--json");
    expect(cmd).toContain("number,url,state");
    expect(calls[0]!.cwd).toBe("/repo");
  });

  test("a non-zero gh exit throws a typed GhDomainAdapterError", async () => {
    const { runner } = recordingRunner(() => ({ status: 1, stderr: "gh: not found", stdout: "" }));
    const adapter = new GhDomainAdapter({ runner, repoNameWithOwner: () => "o/r", cwd: () => "/repo" });
    await expect(adapter.enumerate({ from: 1, to: 10 })).rejects.toThrow(GhDomainAdapterError);
  });
});
