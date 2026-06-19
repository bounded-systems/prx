// GH-1768 — engine smoke tests.

import { describe, expect, test } from "bun:test";

import {
  atom,
  c,
  evaluate,
  explain,
  fact,
  factKey,
  not,
  rule,
  v,
} from "../../src/derive/engine.ts";

describe("engine — basic saturation", () => {
  test("derives transitive closure", () => {
    const rules = [
      rule("ancestor_direct", atom("ancestor", v("X"), v("Y")), [atom("parent", v("X"), v("Y"))]),
      rule("ancestor_transitive", atom("ancestor", v("X"), v("Z")), [
        atom("ancestor", v("X"), v("Y")),
        atom("parent", v("Y"), v("Z")),
      ]),
    ];
    const edb = [fact("parent", "a", "b"), fact("parent", "b", "c"), fact("parent", "c", "d")];
    const { facts } = evaluate(rules, edb);
    const ancestors = facts
      .get("ancestor")
      .map((f) => `${f.args[0]}->${f.args[1]}`)
      .sort();
    expect(ancestors).toEqual(["a->b", "a->c", "a->d", "b->c", "b->d", "c->d"]);
  });

  test("stratified negation", () => {
    const rules = [
      rule("needs_review", atom("needs_review", v("I")), [
        atom("issue", v("I")),
        not(atom("reviewed", v("I"))),
      ]),
    ];
    const edb = [fact("issue", "GH-1"), fact("issue", "GH-2"), fact("reviewed", "GH-1")];
    const { facts } = evaluate(rules, edb);
    expect(
      facts
        .get("needs_review")
        .map((f) => f.args[0])
        .sort(),
    ).toEqual(["GH-2"]);
  });

  test("explain — provenance tree", () => {
    const rules = [
      rule("ancestor_direct", atom("ancestor", v("X"), v("Y")), [atom("parent", v("X"), v("Y"))]),
      rule("ancestor_transitive", atom("ancestor", v("X"), v("Z")), [
        atom("ancestor", v("X"), v("Y")),
        atom("parent", v("Y"), v("Z")),
      ]),
    ];
    const edb = [fact("parent", "a", "b"), fact("parent", "b", "c")];
    const { provenance } = evaluate(rules, edb);
    const tree = explain(provenance, fact("ancestor", "a", "c"));
    expect(tree).not.toBeNull();
    // Direct EDB facts at the leaves.
    expect(tree!.children.length).toBeGreaterThan(0);
    const leaves: string[] = [];
    const walk = (n: { fact: string; rule: string; children: (typeof tree)[] }) => {
      if (n.rule === "<edb>") leaves.push(n.fact);
      else for (const ch of n.children) walk(ch as never);
    };
    walk(tree as never);
    expect(leaves.sort()).toEqual([
      factKey(fact("parent", "a", "b")),
      factKey(fact("parent", "b", "c")),
    ]);
  });

  test("rejects recursion through negation", () => {
    const bad = [
      rule("p", atom("p", v("X")), [not(atom("q", v("X")))]),
      rule("q", atom("q", v("X")), [not(atom("p", v("X")))]),
    ];
    expect(() => evaluate(bad, [])).toThrow(/not stratifiable/);
  });

  test("constant equality fails non-matches", () => {
    const rules = [rule("is_alice", atom("is_alice", v("X")), [atom("name", v("X"), c("alice"))])];
    const edb = [fact("name", "u1", "alice"), fact("name", "u2", "bob")];
    const { facts } = evaluate(rules, edb);
    expect(facts.get("is_alice").map((f) => f.args[0])).toEqual(["u1"]);
  });
});
