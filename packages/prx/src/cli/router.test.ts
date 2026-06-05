import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { defineVerb, type Registry } from "./verbspec.ts";
import { dispatchTree, resolveVerb } from "./router.ts";
import { fleetVerb, pilotVerb } from "./pilot-verbs.ts";

// A registry mixing single-token (pilot/fleet) and namespaced ids.
const stub = (id: string, actor: string) =>
  defineVerb({
    id,
    summary: `stub ${id}`,
    actor,
    positionals: ["unit"],
    input: z.object({ unit: z.string().min(1) }),
    output: z.object({ ran: z.string() }),
    run: ({ unit }) => ({ ran: `${id}:${unit}` }),
  });

const reg: Registry = {
  [pilotVerb.id]: pilotVerb,
  [fleetVerb.id]: fleetVerb,
  "plan session": stub("plan session", "plan"),
  "plan ci": stub("plan ci", "plan"),
  "intake spike": stub("intake spike", "intake"),
  plan: defineVerb({
    id: "plan",
    summary: "bare plan verb (exact-wins over the namespace)",
    actor: "plan",
    positionals: ["unit"],
    input: z.object({ unit: z.string().min(1) }),
    output: z.object({ ran: z.string() }),
    run: ({ unit }) => ({ ran: `plan:${unit}` }),
  }),
};

describe("namespaced router", () => {
  test("resolves the longest matching multi-token verb id", () => {
    const r = resolveVerb(reg, ["plan", "session", "GH-5"]);
    expect(r.kind).toBe("verb");
    if (r.kind === "verb") {
      expect(r.verb.id).toBe("plan session");
      expect(r.rest).toEqual(["GH-5"]);
    }
  });

  test("an exact verb id wins over the namespace at the same prefix", () => {
    // `plan` is BOTH a verb and a namespace prefix (plan session / plan ci).
    const r = resolveVerb(reg, ["plan", "GH-9"]);
    expect(r.kind).toBe("verb");
    if (r.kind === "verb") {
      expect(r.verb.id).toBe("plan");
      expect(r.rest).toEqual(["GH-9"]);
    }
  });

  test("a bare namespace token lists its children", () => {
    // Remove the bare `plan` verb to see the namespace.
    const nsReg: Registry = { "plan session": reg["plan session"]!, "plan ci": reg["plan ci"]! };
    const r = resolveVerb(nsReg, ["plan"]);
    expect(r.kind).toBe("namespace");
    if (r.kind === "namespace") {
      expect(r.path).toEqual(["plan"]);
      expect(r.children).toEqual(["ci", "session"]);
    }
  });

  test("single-token verbs still resolve", () => {
    const r = resolveVerb(reg, ["pilot", "GH-7"]);
    expect(r.kind).toBe("verb");
    if (r.kind === "verb") expect(r.verb.id).toBe("pilot");
  });

  test("dispatchTree runs a namespaced verb and shows group help", async () => {
    const ran = await dispatchTree(reg, ["plan", "session", "GH-3"]);
    expect(ran).toMatchObject({ kind: "ok", id: "plan session" });
    if (ran.kind === "ok") expect(ran.output).toEqual({ ran: "plan session:GH-3" });

    const ns: Registry = { "plan session": reg["plan session"]!, "plan ci": reg["plan ci"]! };
    const group = await dispatchTree(ns, ["plan"]);
    expect(group.kind).toBe("namespace");
    if (group.kind === "namespace") {
      expect(group.text).toContain("prx plan <subcommand>");
      expect(group.text).toContain("session");
      expect(group.text).toContain("ci");
    }

    const help = await dispatchTree(reg, ["intake", "spike", "--help"]);
    expect(help.kind).toBe("help");
    if (help.kind === "help") expect(help.text).toContain("prx intake spike");
  });

  test("unknown leading token throws", async () => {
    let threw = "";
    try {
      await dispatchTree(reg, ["nope", "x"]);
    } catch (e) {
      threw = String(e);
    }
    expect(threw).toContain("unknown verb");
  });
});
