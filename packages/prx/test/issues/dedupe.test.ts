// GH-1538 — `byDomainExternalId` index on `BeadsLookup`. The post-amendment
// shape: `domain → externalId → record` driven by `BeadsRecord.externalRefs`.

import { describe, expect, test } from "bun:test";

import { buildBeadsLookup, extractIssueNumber, lookupBead } from "../../src/issues/dedupe.ts";
import type { BeadsRecord } from "../../src/triage/triage.ts";

function bead(overrides: Partial<BeadsRecord> = {}): BeadsRecord {
  return {
    id: "ai-home-fixture",
    title: "stub",
    description: "",
    status: "open",
    priority: null,
    issueType: "task",
    externalRef: null,
    externalRefs: {},
    metadata: null,
    externalIssueNumber: null,
    sourceSystem: null,
    ...overrides,
  };
}

describe("extractIssueNumber", () => {
  test("parses /issues/<n> suffixes", () => {
    expect(extractIssueNumber("https://github.com/o/r/issues/42")).toBe(42);
    expect(extractIssueNumber("https://github.com/o/r/issues/42?source=ui")).toBe(42);
  });

  test("null/undefined/non-matching → null", () => {
    expect(extractIssueNumber(null)).toBeNull();
    expect(extractIssueNumber(undefined)).toBeNull();
    expect(extractIssueNumber("GH-42")).toBeNull();
  });
});

describe("buildBeadsLookup — byDomainExternalId", () => {
  test("populates `gh` from `externalRefs.gh`; URL key is lowercased", () => {
    const url = "https://github.com/O/R/issues/204";
    const records: BeadsRecord[] = [
      bead({
        id: "ai-home-a",
        externalRef: url,
        externalRefs: { gh: url },
        externalIssueNumber: 204,
      }),
    ];
    const lookup = buildBeadsLookup(records);
    const gh = lookup.byDomainExternalId.get("gh");
    expect(gh).toBeDefined();
    expect(gh!.get(url.toLowerCase())?.id).toBe("ai-home-a");
    // The legacy GH-only index stays populated for current callsites.
    expect(lookup.byUrl.get(url.toLowerCase())?.id).toBe("ai-home-a");
    expect(lookup.byIssueNumber.get(204)?.id).toBe("ai-home-a");
  });

  test("populates a `notion` per-domain map when `externalRefs.notion` is set", () => {
    const notionUrl = "https://www.notion.so/0123456789abcdef0123456789abcdef";
    const records: BeadsRecord[] = [
      bead({
        id: "ai-home-b",
        externalRef: null,
        externalRefs: { notion: notionUrl },
      }),
    ];
    const lookup = buildBeadsLookup(records);
    const notion = lookup.byDomainExternalId.get("notion");
    expect(notion).toBeDefined();
    expect(notion!.get(notionUrl.toLowerCase())?.id).toBe("ai-home-b");
    // `gh` slot stays empty; the legacy `byUrl` index too (no `externalRef`).
    expect(lookup.byDomainExternalId.get("gh")).toBeUndefined();
    expect(lookup.byUrl.size).toBe(0);
  });

  test("handles a multi-domain record (both `gh` and `notion` pinned)", () => {
    const ghUrl = "https://github.com/o/r/issues/1";
    const notionUrl = "https://www.notion.so/abc";
    const records: BeadsRecord[] = [
      bead({
        id: "ai-home-c",
        externalRef: ghUrl,
        externalRefs: { gh: ghUrl, notion: notionUrl },
        externalIssueNumber: 1,
      }),
    ];
    const lookup = buildBeadsLookup(records);
    expect(lookup.byDomainExternalId.get("gh")?.get(ghUrl.toLowerCase())?.id).toBe("ai-home-c");
    expect(lookup.byDomainExternalId.get("notion")?.get(notionUrl.toLowerCase())?.id).toBe(
      "ai-home-c",
    );
  });

  test("records with empty `externalRefs` produce no domain entries", () => {
    const lookup = buildBeadsLookup([bead({ id: "ai-home-d" })]);
    expect(lookup.byDomainExternalId.size).toBe(0);
  });
});

describe("lookupBead — unchanged GH-only contract", () => {
  test("returns the record by URL or by issue number", () => {
    const lookup = buildBeadsLookup([
      bead({
        id: "ai-home-a",
        externalRef: "https://github.com/o/r/issues/9",
        externalRefs: { gh: "https://github.com/o/r/issues/9" },
        externalIssueNumber: 9,
      }),
    ]);
    expect(lookupBead({ number: 9, url: "https://github.com/o/r/issues/9" }, lookup)?.id).toBe(
      "ai-home-a",
    );
    expect(lookupBead({ number: 9 }, lookup)?.id).toBe("ai-home-a");
    expect(lookupBead({ number: 12 }, lookup)).toBeNull();
  });
});
