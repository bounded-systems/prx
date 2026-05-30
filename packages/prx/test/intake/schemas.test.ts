import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildIntakeJsonSchema } from "../../src/intake/schemas/export_json.ts";
import {
  INTAKE_BODY_FIELDS_META,
  INTAKE_BODY_SCHEMAS,
  INTAKE_BODY_SCHEMA_TYPES,
  validateIntakeBody,
} from "../../src/intake/schemas/index.ts";

describe("per-type Zod schemas — direct parse", () => {
  test("bug requires description + acceptance_criteria; other target fields optional", () => {
    const schema = INTAKE_BODY_SCHEMAS.bug;
    expect(
      schema.safeParse({ description: "d", acceptance_criteria: "a" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        description: "d",
        repro_steps: "r",
        expected: "e",
        actual: "a",
        environment: "env",
        acceptance_criteria: "ac",
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ description: "d" }).success).toBe(false);
    expect(schema.safeParse({ acceptance_criteria: "a" }).success).toBe(false);
  });

  test("task requires description + acceptance_criteria", () => {
    const schema = INTAKE_BODY_SCHEMAS.task;
    expect(
      schema.safeParse({ description: "d", acceptance_criteria: "a" }).success,
    ).toBe(true);
    expect(schema.safeParse({ description: "d" }).success).toBe(false);
  });

  test("feature requires description + acceptance_criteria; design + notes optional", () => {
    const schema = INTAKE_BODY_SCHEMAS.feature;
    expect(
      schema.safeParse({ description: "d", acceptance_criteria: "a" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        description: "d",
        design: "x",
        acceptance_criteria: "a",
        notes: "n",
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ description: "d", design: "x" }).success).toBe(false);
  });

  test("chore requires description + acceptance_criteria", () => {
    const schema = INTAKE_BODY_SCHEMAS.chore;
    expect(
      schema.safeParse({ description: "d", acceptance_criteria: "a" }).success,
    ).toBe(true);
    expect(schema.safeParse({ description: "d" }).success).toBe(false);
  });

  test("spike requires question + success_criteria; other target fields optional", () => {
    const schema = INTAKE_BODY_SCHEMAS.spike;
    expect(
      schema.safeParse({ question: "q", success_criteria: "s" }).success,
    ).toBe(true);
    expect(schema.safeParse({ question: "q" }).success).toBe(false);
  });

  test("epic requires description + child_decomposition + success_criteria", () => {
    const schema = INTAKE_BODY_SCHEMAS.epic;
    expect(
      schema.safeParse({
        description: "d",
        child_decomposition: "c",
        success_criteria: "s",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ description: "d", child_decomposition: "c" }).success,
    ).toBe(false);
  });
});

describe("validateIntakeBody — runtime CLI-shaped check", () => {
  test("bug missing acceptance reports CLI-shaped path", () => {
    const result = validateIntakeBody("bug", { description: "d" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.map((i) => i.path);
      expect(paths).toContain("acceptance");
      expect(paths).not.toContain("description");
      const msg = result.issues.find((i) => i.path === "acceptance")!.message;
      expect(msg).toBe("acceptance: required");
    }
  });

  test("bug missing description reports CLI-shaped path", () => {
    const result = validateIntakeBody("bug", { acceptance: "a" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.issues.map((i) => i.path);
      expect(paths).toContain("description");
    }
  });

  test("task with description+acceptance passes", () => {
    expect(
      validateIntakeBody("task", { description: "d", acceptance: "a" }),
    ).toEqual({ ok: true });
  });

  test("feature with only description+acceptance passes (design/notes optional)", () => {
    expect(
      validateIntakeBody("feature", { description: "d", acceptance: "a" }),
    ).toEqual({ ok: true });
  });

  test("chore missing acceptance fails", () => {
    const result = validateIntakeBody("chore", { description: "d" });
    expect(result.ok).toBe(false);
  });

  test("spike enforcement is deferred — always passes today", () => {
    expect(validateIntakeBody("spike", {})).toEqual({ ok: true });
    expect(validateIntakeBody("spike", { description: "d" })).toEqual({
      ok: true,
    });
  });

  test("empty-string acceptance is treated as absent (matches structuredPresent rule)", () => {
    const result = validateIntakeBody("task", {
      description: "d",
      acceptance: "",
    });
    expect(result.ok).toBe(false);
  });
});

describe("JSON Schema artifacts — checked-in vs regenerated parity", () => {
  const repoRoot = resolve(import.meta.dir, "../..");

  for (const type of INTAKE_BODY_SCHEMA_TYPES) {
    test(`${type}.json matches buildIntakeJsonSchema(${type})`, () => {
      const onDisk = JSON.parse(
        readFileSync(resolve(repoRoot, `schemas/intake/${type}.json`), "utf8"),
      );
      const regenerated = buildIntakeJsonSchema(type);
      expect(onDisk).toEqual(regenerated);
    });
  }

  test("each artifact is valid Draft-7 (has $schema and definitions)", () => {
    for (const type of INTAKE_BODY_SCHEMA_TYPES) {
      const onDisk = JSON.parse(
        readFileSync(resolve(repoRoot, `schemas/intake/${type}.json`), "utf8"),
      );
      expect(onDisk.$schema).toBe("http://json-schema.org/draft-07/schema#");
      expect(onDisk.definitions[`intake_${type}_body`]).toBeDefined();
    }
  });

  test("each property carries x-prx-actions-bearing + x-prx-heading", () => {
    for (const type of INTAKE_BODY_SCHEMA_TYPES) {
      const onDisk = JSON.parse(
        readFileSync(resolve(repoRoot, `schemas/intake/${type}.json`), "utf8"),
      );
      const properties = onDisk.definitions[`intake_${type}_body`].properties as Record<
        string,
        Record<string, unknown>
      >;
      const meta = INTAKE_BODY_FIELDS_META[type];
      for (const [field, fieldMeta] of Object.entries(meta)) {
        expect(properties[field]?.["x-prx-actions-bearing"]).toBe(fieldMeta.actionsBearing);
        expect(properties[field]?.["x-prx-heading"]).toBe(fieldMeta.heading);
      }
    }
  });
});
