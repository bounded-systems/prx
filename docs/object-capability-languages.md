# Object-capability languages — prior art for prx's capability model

> Reference survey. Catalogs the object-capability (ocap) language lineage
> and maps it onto prx's two capability layers (the sanctioned-access-point
> seams and the Deno `--allow-*` actor tiers). The *decision* this grounds
> lives in [GH-1836 §3.7](spikes/GH-1836-prx-runtime-architecture.md); this
> doc is the broader background that subsection cites.

## Why this is here

prx keeps meeting the same question: *"these capabilities-secure languages
(Pony, Austral, Cadence, …) look like exactly what we're building — should
we swap to one?"* The short answer is **no, and we don't need to**: prx
already obtains the property those languages sell, at two layers it
controls. This doc records the lineage so that answer is grounded rather
than asserted.

## The principle — POLA / no ambient authority

Object-capability security is the discipline that **a component can only
affect what it was explicitly handed** — there is no ambient authority to
reach for. The idea traces to Dennis & van Horn (1966) and is named
**POLA**, the Principle of Least Authority, in Mark Miller's **E** language:
*authority follows the reference*. To do something to an object, you must
hold a reference to it; references are unforgeable and only obtained by
being passed one. Everything below is a variation on that rule.

## The language lineage

| Language | Where the capability lives | Maturity / domain | Relevance to prx |
|----------|----------------------------|-------------------|------------------|
| **E** (Miller) | Object references *are* capabilities; POLA is the design axiom | Research; the conceptual root | "Authority follows the reference" is the rule every prx seam encodes. |
| **Pony** | Reference capabilities (`iso`, `val`, `ref`, `box`, `tag`) checked by the type system; actor-model + "capabilities-secure" | Niche systems language, LLVM-native, GC'd actors | Closest structural analogue — ocap **and** actors, prx's two axes (`src/machine/actors.ts` tiers + the seams). |
| **Newspeak** | Object-capability platform; no global namespace, all authority passed in as constructor args | Research; runs on WASM in-browser | The "no ambient" rule prx enforces via the single-sanctioned-access-point packages. |
| **Monte** | POLA + capability object model over a Python-like surface | Nascent | Demonstrates ocap retrofit onto a mainstream-feeling language — prx's situation in TS. |
| **Cadence** | Capability security in the static type system (resources / linear types) | Production, but **domain-locked to the Flow blockchain** | Type-level authority; the down-casting-for-access-control pattern mirrors prx's policy gates. Off-chain: irrelevant. |
| **Austral** | Linear types + capability security; capabilities are unforgeable values threaded explicitly | `0.1.0` (core complete, 2022); research-stage | The "authority is a value you must be given" model the dispatch envelope approximates. |

## How prx gets the property without the language

TypeScript has no reference-capability system, and the Claude Agent SDK
constrains the host language — so prx cannot adopt a Pony-style
*type-checked* capability. Instead it realizes the same invariant at the
two layers it does control:

1. **Architecture layer (in place).** The "one sanctioned access point"
   packages — `@bounded-systems/{fs,env,host,proc}` plus the `policy`
   engine and per-actor tool allowlists — are an ocap discipline enforced
   by module boundaries and review. This is Newspeak's "authority passed
   in, never ambient" applied to a TS monorepo: nothing reads
   `process.env` except `env`, nothing spawns a subprocess except `proc`.

2. **OS layer (GH-1836, Phases A–D).** Deno's `--allow-*` flags make the
   same authority **unforgeable at the process boundary** — the property
   Pony gets from its type checker, prx gets from the kernel. This is what
   turns the audit invariant I-AUD4 (`src/audit/invariants.ts:159`) from a
   *post-hoc string match* on the action verb into an OS guarantee: the
   executor *cannot* `git push --force` even if the prompt says so.

## The mapping, made explicit

Pony's reference capabilities annotate *what a reference may do with the
object it points at*; the Deno tier flags annotate *what a process may do
with the host it runs on*. The shapes line up:

| ocap concept | Pony form | prx form (GH-1836) |
|--------------|-----------|--------------------|
| Read-only authority | `val` / `box` reference | `planning` tier: `--allow-read=$REPO_ROOT`, no write/run/net |
| Write + side-effect authority | `iso` / `ref` reference | `execution` tier: `--allow-write=$WORKTREE,$CAS_ROOT --allow-run=git,gh,bun` |
| Scoped outbound authority | capability passed to one actor | `verification_publication` tier: `--allow-net=api.github.com` (host-scoped) |
| Unforgeable identity, no authority | `tag` reference | An actor with no `--allow-*` flag for a resource simply cannot reach it |

## Takeaway

The capabilities-secure language family is **validating prior art, not a
migration target**. prx already holds the property — structurally at the
architecture layer and (via GH-1836) at the OS layer — without paying the
ecosystem cost of leaving the Agent-SDK-bearing TypeScript runtime. A
language swap would re-acquire a property prx already has and forfeit the
libraries the product is built on. The lever that *is* live is the
**tool/runtime** swap decided in
[GH-1836](spikes/GH-1836-prx-runtime-architecture.md): Moon for the task
graph, Deno for OS-enforced per-tier permissions, Bun retained for the
shipped binary.
