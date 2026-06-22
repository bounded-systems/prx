import { describe, expect, test } from "bun:test";

import {
  type AuditOptions,
  type CoverageReport,
  type CoverageRow,
  type CoverageStatus,
  MissingTokenError,
  auditFrontDeskCoverage,
  renderReport,
} from "../../src/front-desk/coverage.ts";

/**
 * A fake `fetch` over a fixture: a single page of repos, then per-repo contents
 * lookups that 200 for repos in `present` and 404 otherwise.
 */
function fakeFetch(
  repos: ReadonlyArray<{
    name: string;
    private?: boolean;
    archived?: boolean;
    disabled?: boolean;
  }>,
  present: ReadonlySet<string>,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/repos?")) {
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const body =
        page === 1
          ? repos.map((r) => ({ archived: false, disabled: false, private: false, ...r }))
          : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.includes("/contents/")) {
      const repo = url.split("/repos/")[1]?.split("/")[1] ?? "";
      return new Response("{}", { status: present.has(repo) ? 200 : 404 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("front-desk coverage audit", () => {
  test("classifies present / missing / private / archived", async () => {
    const opts: AuditOptions = {
      org: "acme",
      token: "t",
      fetchImpl: fakeFetch(
        [
          { name: "has-it" },
          { name: "lacks-it" },
          { name: "secret", private: true },
          { name: "old", archived: true },
        ],
        new Set(["has-it"]),
      ),
    };
    const report: CoverageReport = await auditFrontDeskCoverage(opts);

    expect(report.org).toBe("acme");
    expect(report.present).toEqual(["has-it"]);
    expect(report.missing).toEqual(["lacks-it"]);
    expect(report.privateRepos).toEqual(["secret"]);
    expect(report.archived).toEqual(["old"]);

    // rows are sorted by repo name and fully classified
    const byRepo = new Map<string, CoverageStatus>(
      report.rows.map((r: CoverageRow) => [r.repo, r.status]),
    );
    expect(byRepo.get("has-it")).toBe("present");
    expect(byRepo.get("lacks-it")).toBe("missing");
  });

  test("renderReport surfaces missing public repos and the fix hint", async () => {
    const report = await auditFrontDeskCoverage({
      org: "acme",
      token: "t",
      fetchImpl: fakeFetch([{ name: "has-it" }, { name: "lacks-it" }], new Set(["has-it"])),
    });
    const text = renderReport(report);
    expect(text).toContain("MISSING");
    expect(text).toContain("- lacks-it");
    expect(text).toContain("FRONT_DESK_APP_ID");
  });

  test("throws MissingTokenError when no token is resolvable", async () => {
    await expect(
      auditFrontDeskCoverage({ org: "acme", token: "", fetchImpl: fakeFetch([], new Set()) }),
    ).rejects.toBeInstanceOf(MissingTokenError);
  });
});
