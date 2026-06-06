import { describe, expect, test } from "bun:test";

import {
  DEFAULT_NAMESPACE_SCHEME,
  isSafeDoltIdentifier,
  resolveDoltDatabaseName,
  reverseDnsScheme,
  type DoltNamespaceScheme,
} from "../../src/dolt/namespace.ts";

describe("reverseDnsScheme (the default policy)", () => {
  test("owner/repo → io_github_owner_repo", () => {
    expect(reverseDnsScheme("bounded-systems/prx")).toBe("io_github_bounded_systems_prx");
    expect(reverseDnsScheme("pushd/supply-plan-design")).toBe("io_github_pushd_supply_plan_design");
  });

  test("is the default scheme", () => {
    expect(DEFAULT_NAMESPACE_SCHEME).toBe(reverseDnsScheme);
  });
});

describe("resolveDoltDatabaseName", () => {
  test("defaults to reverse-DNS", () => {
    expect(resolveDoltDatabaseName("bounded-systems/prx")).toBe("io_github_bounded_systems_prx");
  });

  test("honors a custom scheme (multiple configs)", () => {
    const flat: DoltNamespaceScheme = (slug) => slug.split("/")[1] ?? slug;
    expect(resolveDoltDatabaseName("bounded-systems/prx", { scheme: flat })).toBe("prx");
    const fixed: DoltNamespaceScheme = () => "beads";
    expect(resolveDoltDatabaseName("anything/here", { scheme: fixed })).toBe("beads");
  });

  test("rejects a scheme that produces an unsafe identifier (fail closed)", () => {
    const unsafe: DoltNamespaceScheme = () => "robert'); DROP DATABASE x;--";
    expect(() => resolveDoltDatabaseName("o/r", { scheme: unsafe })).toThrow(/unsafe dolt database name/);
    // a scheme leaking the raw slug's hyphens/uppercase is also caught
    const raw: DoltNamespaceScheme = (slug) => slug;
    expect(() => resolveDoltDatabaseName("Bounded-Systems/PRX", { scheme: raw })).toThrow(/unsafe/);
  });
});

describe("isSafeDoltIdentifier (the SQL-safety guard)", () => {
  test("accepts reverse-DNS and plain names (leading digit is safe, just unusual)", () => {
    for (const ok of ["io_github_bounded_systems_prx", "prx", "beads", "a", "a1_b2", "1leading_digit"]) {
      expect(isSafeDoltIdentifier(ok)).toBe(true);
    }
  });

  test("rejects injection-shaped / unsafe names", () => {
    for (const bad of [
      "",
      "_leading_underscore",
      "Has-Uppercase",
      "has-hyphen",
      "has space",
      "has.dot",
      "drop;table",
      "name'--",
      "x`y",
      'q"x',
    ]) {
      expect(isSafeDoltIdentifier(bad)).toBe(false);
    }
  });
});
