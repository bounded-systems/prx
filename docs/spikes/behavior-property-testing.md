# Behavior layer — property & contract testing over the verb registry (spike)

> Design-only spike. No `src/`/`packages/` changes in this unit — the
> **strategy, the recommended first slice, and the forcing function are the
> deliverable**. Written 2026-06-19. Companion to
> [`docs/agentic-code-hygiene.md`](../agentic-code-hygiene.md) (layer 5) and the
> OpenAPI surface (`packages/prx/openapi.json`, [`cli-from-spec.md`](../prx/cli-from-spec.md)).

## 0. Status

**Proposed — not decided.** The agentic-hygiene doctrine names **behavior**
(layer 5) as the thin layer: **5 `.feature` files** + `value_props.test.ts` for a
5-value-prop product. Behavior is the layer types and lint *cannot* reach — and
plausible-but-wrong behavior is exactly the dominant failure mode of
agent-written code. This spike picks the cheapest path to thicken it, leaning on
machinery the repo already has (the Zod verb registry, now also projected to
OpenAPI).

## 1. Why this layer matters most for agentic code

A type-check proves shape; a lint proves style; neither proves the function does
what it claims. An agent will write code that compiles, lints clean, and is
subtly wrong. Only an executable statement of *intended behavior* — a property or
a contract — catches that. With most code agent-authored, layer 5 is where trust
is actually won or lost.

## 2. Two complementary techniques

### 2a. Contract testing (free, do first)

`verbspec` already gives every verb an `input` and `output` Zod schema. That is a
contract. A **single generic test over the whole registry** turns it into
coverage:

```
for each verb in verbRegistry:
  for N generated inputs (from verb.input):
    out = await verb.run(input, verb.deps?.())
    expect(verb.output.safeParse(out).success).toBe(true)
```

This asserts the property *"a valid input always produces a schema-valid
output"* for every verb, with zero per-verb authoring. It is the behavioral twin
of the type-coverage ratchet. Pure verbs run as-is; effectful verbs run against a
stub `deps` slice (the same seam `runSpecVerb` uses).

### 2b. Property invariants (high-value verbs)

For verbs with real invariants, add `fast-check` properties: round-trips
(`plan save` → `plan load` is identity), idempotence, ordering/sort stability,
monotonic ratchets. Generate inputs from the Zod schema via a Zod-v4-compatible
arbitrary (or `z.toJSONSchema` → a JSON-Schema arbitrary), so the generator and
the validator share one source.

### 2c. HTTP fuzzing (optional, once the OpenAPI doc is served)

`packages/prx/openapi.json` is a ready-made target for **schemathesis** —
property-based fuzzing derived from the OpenAPI spec. Defer until/unless a real
HTTP surface is stood up; the in-process 2a/2b cover the same ground without a
server.

## 3. Recommendation

1. Land **2a** as one generic `registry-contract.test.ts` — the highest
   coverage-per-line move available, and it makes the OpenAPI/contract claim
   *behaviorally* true, not just structurally.
2. Add **2b** invariants for the round-trip/ratchet verbs (`plan` family,
   `status`, `transition`).
3. Keep **2c** (schemathesis) as a note against the OpenAPI surface.

Tooling: `fast-check` (TS property testing), a Zod→arbitrary bridge, and
`schemathesis` (Python) only if/when an HTTP surface exists.

## 4. Forcing function

A **registry behavioral-coverage ratchet**: every verb in `verbRegistry` must be
exercised by the generic contract test (2a) — a shrinking allowlist of
exemptions, driven to zero. This is the layer-5 analogue of the per-file
coverage gate, and it composes with the "scripts → verbs" migration: every new
verb arrives with behavioral coverage for free.

## 5. Decision needed

Approve the 2a-first plan and the dependency add (`fast-check` + a Zod arbitrary
bridge), then file as a work unit. This doc is the design input; no code yet.
