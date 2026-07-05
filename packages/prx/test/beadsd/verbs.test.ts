/**
 * beadsd verbspec interface — drift guards.
 *
 * The verb registry is a projection of the wire contract (BeadsRequestSchema);
 * these pin that it stays a faithful, complete projection and that the committed
 * OpenRPC artifact can't go stale.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beadsdVerbs, beadsdOpenRpc } from "../../src/beadsd/verbs.ts";
import {
  BeadsRequestSchema,
  BEADS_REQUEST_KINDS,
  isBeadsWriteKind,
} from "../../src/beadsd/contract.ts";

const unionKinds = (BeadsRequestSchema.options as readonly { shape: { kind: { value: string } } }[])
  .map((o) => o.shape.kind.value)
  .sort();

describe("beadsd verbspec interface", () => {
  test("registry covers exactly the wire contract's request kinds (no drift)", () => {
    expect(Object.keys(beadsdVerbs).sort()).toEqual([...BEADS_REQUEST_KINDS].sort());
    // ...and the same kinds the discriminated union actually carries.
    expect(Object.keys(beadsdVerbs).sort()).toEqual(unionKinds);
  });

  test("each verb id equals its key, has a summary and an input/output schema", () => {
    for (const [key, v] of Object.entries(beadsdVerbs)) {
      expect(v.id).toBe(key);
      expect(typeof v.summary).toBe("string");
      expect(v.summary.length).toBeGreaterThan(0);
      expect(v.input).toBeDefined();
      expect(v.output).toBeDefined();
    }
  });

  test("verb actor tracks the read/write split the daemon gates on", () => {
    for (const [kind, v] of Object.entries(beadsdVerbs)) {
      expect(v.actor).toBe(isBeadsWriteKind(kind as never) ? "beads-write" : "beads-read");
    }
  });

  test("OpenRPC doc is 1.3.2 with one method per verb, each carrying params + result", () => {
    const doc = beadsdOpenRpc as {
      openrpc: string;
      methods: { name: string; params: unknown[]; result: unknown }[];
    };
    expect(doc.openrpc).toBe("1.3.2");
    expect(doc.methods.map((m) => m.name).sort()).toEqual([...BEADS_REQUEST_KINDS].sort());
    for (const m of doc.methods) {
      expect(Array.isArray(m.params)).toBe(true);
      expect(m.result).toBeDefined();
    }
  });

  test("committed beadsd.openrpc.json matches the generated doc (regen guard)", () => {
    const path = join(import.meta.dir, "..", "..", "src", "beadsd", "beadsd.openrpc.json");
    const committed = JSON.parse(readFileSync(path, "utf8"));
    expect(committed).toEqual(beadsdOpenRpc);
  });
});
