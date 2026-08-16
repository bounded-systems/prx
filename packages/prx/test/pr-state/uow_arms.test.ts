// pr-state/uow — loadTicketOverlay's fall-through arms (absent path, unreadable
// file, a JSON payload that's neither a legacy array nor a `{ tickets }` object).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTicketOverlay } from "../../src/pr-state/uow.ts";

const cleanups: string[] = [];
afterEach(() => {
  for (const p of cleanups.splice(0)) rmSync(p, { recursive: true, force: true });
});
function tmpFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "uow-arms-"));
  cleanups.push(dir);
  const p = join(dir, "tickets.json");
  writeFileSync(p, contents);
  return p;
}

describe("loadTicketOverlay — fall-through arms", () => {
  test("an empty path returns no overlays", () => {
    expect(loadTicketOverlay("")).toEqual([]);
  });
  test("a non-existent path returns no overlays", () => {
    expect(loadTicketOverlay("/no/such/tickets.json")).toEqual([]);
  });
  test("an unreadable / malformed file returns no overlays", () => {
    expect(loadTicketOverlay(tmpFile("{ not valid json"))).toEqual([]);
  });
  test("a JSON object that is neither an array nor `{ tickets }` returns no overlays", () => {
    expect(loadTicketOverlay(tmpFile(JSON.stringify({ foo: 1 })))).toEqual([]);
  });
  test("a row missing a valid id is dropped from a legacy array payload", () => {
    const overlays = loadTicketOverlay(
      tmpFile(JSON.stringify([{ id: "  " }, { id: "GH-1", title: "ok" }])),
    );
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.id).toBe("GH-1");
  });
});
