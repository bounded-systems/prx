// GH-1537 — `pullActor` / `pushActor` unit coverage. The adapter is injected
// (the GH-1536 `DomainAdapter` seam) so no real `gh` / `bd` is touched.

import { describe, expect, test } from "bun:test";
import { createActor, type AnyActorLogic } from "xstate";

import {
  GH_SURFACE_ID_PATTERN,
  type DomainAdapter,
  type DomainPushFields,
  type ResolvedWorkUnitPatch,
} from "../../src/adapters/domain-adapter.ts";
import { pullActor, pushActor } from "../../src/sync/actors.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "bd-204",
    title: "Periodic beads↔external sync",
    description: "the body",
    status: "open",
    priority: 1,
    issueType: "task",
    externalRef: "https://github.com/bdelanghe/ai-home/issues/204",
    externalRefs: { gh: "https://github.com/bdelanghe/ai-home/issues/204" },
    metadata: null,
    externalIssueNumber: 204,
    sourceSystem: null,
    ...overrides,
  };
}

function fakeAdapter(overrides: Partial<DomainAdapter> = {}): DomainAdapter {
  return {
    config: {
      domain: "gh",
      surfaceIdPattern: GH_SURFACE_ID_PATTERN,
      externalIdShape: "issue-url",
      ownedOnPull: [],
    },
    matchesSurfaceId: () => true,
    recognizesExternalId: () => true,
    surfaceIdToExternalId: (id) => id,
    pull: async (): Promise<ResolvedWorkUnitPatch> => ({ status: "open" }),
    push: async (bd) => ({ externalId: bd.externalRef ?? "x", created: false, edited: false }),
    enumerate: async () => [],
    resolve: async () => null,
    resolveFromBeads: () => null,
    ...overrides,
  };
}

async function runActor<TOutput>(logic: AnyActorLogic, input: unknown): Promise<TOutput> {
  const actor = createActor(logic, { input: input as never });
  return new Promise<TOutput>((resolve, reject) => {
    actor.subscribe({
      complete: () => resolve(actor.getSnapshot().output as TOutput),
      error: (err) => reject(err),
    });
    actor.start();
  });
}

describe("pullActor", () => {
  test("GH issue CLOSED + bead open ⇒ needsClose: true", async () => {
    const adapter = fakeAdapter({ pull: async () => ({ status: "closed" }) });
    const out = await runActor<{ needsClose: boolean; externalStatus: string }>(pullActor, {
      beadId: "bd-204",
      domain: "gh",
      externalId: "https://github.com/bdelanghe/ai-home/issues/204",
      beadStatus: "open",
      adapter,
    });
    expect(out.externalStatus).toBe("closed");
    expect(out.needsClose).toBe(true);
  });

  test("GH issue OPEN ⇒ needsClose: false", async () => {
    const out = await runActor<{ needsClose: boolean; externalStatus: string }>(pullActor, {
      beadId: "bd-204",
      domain: "gh",
      externalId: "https://github.com/bdelanghe/ai-home/issues/204",
      beadStatus: "open",
      adapter: fakeAdapter({ pull: async () => ({ status: "open" }) }),
    });
    expect(out.externalStatus).toBe("open");
    expect(out.needsClose).toBe(false);
  });

  test("GH issue CLOSED but bead already closed ⇒ needsClose: false", async () => {
    const out = await runActor<{ needsClose: boolean }>(pullActor, {
      beadId: "bd-204",
      domain: "gh",
      externalId: "https://github.com/bdelanghe/ai-home/issues/204",
      beadStatus: "closed",
      adapter: fakeAdapter({ pull: async () => ({ status: "closed" }) }),
    });
    expect(out.needsClose).toBe(false);
  });

  test("missing/unknown external status normalises to 'unknown'", async () => {
    const out = await runActor<{ needsClose: boolean; externalStatus: string }>(pullActor, {
      beadId: "bd-204",
      domain: "gh",
      externalId: "https://github.com/bdelanghe/ai-home/issues/204",
      beadStatus: "open",
      adapter: fakeAdapter({ pull: async () => ({}) }),
    });
    expect(out.externalStatus).toBe("unknown");
    expect(out.needsClose).toBe(false);
  });
});

describe("pushActor", () => {
  test("calls adapter.push with the bd-authoritative title + body + labels + assignees", async () => {
    let seen: { bd: BeadsRecord; fields: DomainPushFields } | undefined;
    const adapter = fakeAdapter({
      push: async (bd, fields) => {
        seen = { bd, fields };
        return { externalId: "https://github.com/bdelanghe/ai-home/issues/204", created: false, edited: true };
      },
    });
    const out = await runActor<{ edited: boolean; externalId: string }>(pushActor, {
      bead: bead(),
      domain: "gh",
      externalId: "https://github.com/bdelanghe/ai-home/issues/204",
      dryRun: false,
      adapter,
    });
    // GH-2382: pushActor surfaces the adapter's *real* `edited` flag.
    expect(out.edited).toBe(true);
    expect(out.externalId).toBe("https://github.com/bdelanghe/ai-home/issues/204");
    // GH-1874: bd's `assignee` column projects through as the desired set.
    // Unset bd assignee → `[]` (clears the GH side; the adapter's diff
    // produces a no-op when GH is also empty). GH-2382: the bd-axis labels
    // (`type::task` from issueType, `priority::high` from priority 1) project
    // through as the desired managed-axis set.
    expect(seen?.fields).toEqual({
      title: "Periodic beads↔external sync",
      body: "the body",
      labels: ["type::task", "priority::high"],
      assignees: [],
    });
    expect(seen?.bd.id).toBe("bd-204");
  });

  test("surfaces edited:false when the adapter reports no change (GH-2382)", async () => {
    const adapter = fakeAdapter({
      push: async () => ({
        externalId: "https://github.com/bdelanghe/ai-home/issues/204",
        created: false,
        edited: false,
      }),
    });
    const out = await runActor<{ edited: boolean }>(pushActor, {
      bead: bead(),
      domain: "gh",
      externalId: "https://github.com/bdelanghe/ai-home/issues/204",
      dryRun: false,
      adapter,
    });
    expect(out.edited).toBe(false);
  });

  test("projects bd's `assignee` column when set", async () => {
    let seen: { fields: DomainPushFields } | undefined;
    const adapter = fakeAdapter({
      push: async (_bd, fields) => {
        seen = { fields };
        return { externalId: "https://github.com/bdelanghe/ai-home/issues/204", created: false, edited: true };
      },
    });
    await runActor<{ edited: boolean }>(pushActor, {
      bead: bead({ assignee: "alice" }),
      domain: "gh",
      externalId: "https://github.com/bdelanghe/ai-home/issues/204",
      dryRun: false,
      adapter,
    });
    expect(seen?.fields.assignees).toEqual(["alice"]);
  });

  test("dry-run skips adapter.push and returns the planned external id", async () => {
    let called = false;
    const adapter = fakeAdapter({
      push: async () => {
        called = true;
        return { externalId: "x", created: false, edited: true };
      },
    });
    const out = await runActor<{ edited: boolean; externalId: string }>(pushActor, {
      bead: bead(),
      domain: "gh",
      externalId: "https://github.com/bdelanghe/ai-home/issues/204",
      dryRun: true,
      adapter,
    });
    expect(called).toBe(false);
    expect(out.edited).toBe(false);
    expect(out.externalId).toBe("https://github.com/bdelanghe/ai-home/issues/204");
  });

  test("threads `externalId` from input rather than reading `bead.externalRef`", async () => {
    // Regression: pushActor previously read `bead.externalRef` (GH-only slot)
    // which threw zod min(1) for non-gh domains. Notion beads pin via
    // `externalRefs.notion`, surfaced through the machine context's
    // `externalId` → actor input, never via `externalRef`.
    let seen: { externalId: string } | undefined;
    const notionBead = bead({
      externalRef: null,
      externalRefs: { notion: "page-uuid-aaaa" },
    });
    const adapter = fakeAdapter({
      push: async (_bd, _fields) => {
        return { externalId: "page-uuid-aaaa", created: false, edited: true };
      },
    });
    const out = await runActor<{ edited: boolean; externalId: string }>(pushActor, {
      bead: notionBead,
      domain: "notion",
      externalId: "page-uuid-aaaa",
      dryRun: false,
      adapter,
    });
    seen = { externalId: out.externalId };
    expect(seen.externalId).toBe("page-uuid-aaaa");
    expect(out.edited).toBe(true);
  });
});
