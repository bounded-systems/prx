import type { ZodTypeAny } from "zod";

export type DriftIssue =
  | {
      kind: "type_mismatch";
      path: string;
      expected: string;
      received: string;
      rawValue: unknown;
    }
  | {
      kind: "stale_value";
      path: string;
      rawValue: unknown;
      reason: string;
    };

export type DriftReport = { ok: boolean; issues: DriftIssue[] };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function describeRuntimeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function partition(
  input: Record<string, unknown>,
  keys: ReadonlySet<string>,
): {
  slice: Record<string, unknown>;
  passthrough: Record<string, unknown>;
} {
  const slice: Record<string, unknown> = {};
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (keys.has(key)) {
      slice[key] = value;
    } else {
      passthrough[key] = value;
    }
  }
  return { slice, passthrough };
}

export function collectDrift(
  schema: ZodTypeAny,
  slice: Record<string, unknown>,
): DriftReport {
  const result = schema.safeParse(slice);
  if (result.success) {
    return { ok: true, issues: [] };
  }
  const issues: DriftIssue[] = result.error.issues.flatMap(
    (issue): DriftIssue | DriftIssue[] => {
      const path = issue.path.join(".");
      const rawValue = path
        .split(".")
        .reduce<unknown>((acc, segment) => {
          if (isPlainObject(acc)) return (acc as Record<string, unknown>)[segment];
          return undefined;
        }, slice);
      if (issue.code === "invalid_enum_value") {
        return {
          kind: "stale_value",
          path,
          rawValue,
          reason: `not in {${issue.options.map((o) => JSON.stringify(o)).join(", ")}}`,
        };
      }
      if (issue.code === "invalid_type") {
        return {
          kind: "type_mismatch",
          path,
          expected: issue.expected,
          received: issue.received,
          rawValue,
        };
      }
      if (issue.code === "unrecognized_keys") {
        const parent = isPlainObject(rawValue) ? rawValue : {};
        return issue.keys.map(
          (key): DriftIssue => ({
            kind: "stale_value",
            path: [path, key].filter(Boolean).join("."),
            rawValue: parent[key],
            reason: `unrecognized key: ${key}`,
          }),
        );
      }
      return {
        kind: "type_mismatch",
        path,
        expected: "valid",
        received: describeRuntimeType(rawValue),
        rawValue,
      };
    },
  );
  return { ok: false, issues };
}

export function nonObjectRootDrift(input: unknown): DriftReport {
  return {
    ok: false,
    issues: [
      {
        kind: "type_mismatch",
        path: "",
        expected: "object",
        received: describeRuntimeType(input),
        rawValue: input,
      },
    ],
  };
}
