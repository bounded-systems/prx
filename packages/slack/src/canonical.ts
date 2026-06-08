// slack .5 — deterministic JSON for content-addressing.
//
// Stable, recursive, sorted-key serialization so identical reads hash identically
// regardless of property insertion order. `undefined` properties are dropped (as
// JSON would). Shared by execSlackRead's content address and the provenance
// derivation digest (slack .6) so the two never disagree on the envelope's hash.

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalJson(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") +
    "}"
  );
}
