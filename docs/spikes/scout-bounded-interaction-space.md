# Capability-scoped DCI — a bounded interaction space for scout (spike)

> Design-only spike. Reads *Beyond Semantic Similarity: Rethinking Retrieval
> for Agentic Search via Direct Corpus Interaction* (DCI) and its "bounded
> interaction space" follow-up as a **systems pattern**, and tests it against
> `@bounded-systems/scout`. No `src/`/`packages/` changes in this unit — the
> **diagnosis and the one additive shape are the deliverable**. Written
> 2026-06-13. Companion to `two-clock-policy.md` (same static→derived move,
> different axis).

## 0. Status

**Exploratory — no decision forced.** Finding: scout is *already* DCI, not RAG
— it has no retriever, no index, no embeddings; it exposes `read`/`grep`/`files`
straight over the filesystem (§2). So the paper's headline argument is one scout
already conceded in the agent's favour. The gap the paper's follow-up names — a
**bounded interaction space** the agent explores *within* — maps onto a real
absence in scout: its bounds exist, but as **hardcoded global constants**, not a
**minted, content-addressed, chain-recorded capability** (§3). The additive
shape (§4) is a first-class `CorpusScope` — scout's already-existing bounds
lifted into a signed corpus handle that every read records as an input. This
spike records the gap and the shape; it does not propose building it.

## 1. The pattern, stripped of retrieval

Classic RAG filters first, reasons second:

```
corpus → retriever (BM25/vector) → top-K → LLM
```

Once the retriever drops a document the agent can never recover it. DCI removes
the retriever and hands the agent the corpus directly:

```
corpus → agent ⟨grep · rg · find · read · shell⟩
```

The paper's real thesis is not "embeddings are bad" — it is that **retrieval
quality is a property of the interface between model and corpus, not only of the
model's reasoning.** `search(query)→top-K` is a *low-resolution* interface;
`read(file)` / `grep(pattern)` / `list(dir)` is a *high-resolution* one. The
librarian hands you a shortlist; the detective works the whole archive.

The follow-up paper's amendment: pure DCI doesn't scale indefinitely, so
**retrieve a bounded interaction space first, then let the agent explore freely
within it.** That is no longer "retrieve then reason" *or* "search while
reasoning" — it is *bound the corpus, then search while reasoning inside the
bound.* That is capability scoping wearing a retrieval hat.

## 2. scout is already DCI

scout's surface (`packages/scout/src/index.ts`) is exactly the high-resolution
interface:

| paper's DCI primitive | scout verb |
|---|---|
| `read(file)` | `runScoutRead` (bounded text read, sha256-addressed) |
| `grep(pattern)` | `runScoutGrep` (regex walk, line-numbered matches) |
| `list(glob)` | `runScoutFiles` (glob walk, file paths) |

Confirmed absent, by code and by the extractability test
(`src/__tests__/extractability.test.ts`): no index, no embeddings, no vector
search, no `search(query)→top-K`, no retrieval API. Reads go straight to
`node:fs` over a directory walk. **There is nothing to convert.** scout is the
detective, not the librarian — by construction.

And it has one thing the paper's shell-DCI throws away: **provenance.** `rg
"OrderStatus"` runs, prints, and is forgotten. Every scout read instead emits an
anchored-chain derivation (`src/provenance.ts`) whose *input* is the file's
content digest:

```
producer: "scout.read"
inputs:   { source: "sha256:<file-content-hex>" }
outputs:  { envelope: "sha256:<json-envelope-hex>" }
contracts: ["scout.read/v1"]
```

So `store.invalidate.descendants(fileDigest)` already answers *"which reads
consumed a file that has since changed?"* scout is **DCI with a case file** — the
detective who keeps evidence. That property is what makes DCI *bounded* rather
than merely *unbounded-but-fast*.

## 3. …but the bound is a constant, not a capability

scout is *not* unbounded. It already enforces real limits — they are just
**baked in as global constants**, identical for every caller and invisible to
the chain:

| bound | where it lives today | scope |
|---|---|---|
| skip-list (`.git`, `node_modules`, `dist`, `.beads`, …) | hardcoded array in `grep.ts` / `files.ts` | global |
| max file size (2 MiB) | constant in `read.ts` / `grep.ts` | global |
| match cap (200 default / 5000 hard) | constant in `grep.ts` | global |
| text-extension allowlist (43 / 29 / glob) | constant arrays | global |
| root / `in` | per-call argument (path, or future `GH-<n>`) | per-call, **not recorded as a bound** |

This is the same shape `two-clock-policy.md` found in `policy`: a guardrail that
is **authored as a constant** rather than **minted as a value**. The bound
exists; it is just not a *thing* — you cannot name it, hand it to an agent,
narrow it for one investigation, or read it back off the chain. The interaction
space is real but anonymous.

The paper's follow-up wants the bound to be **first-class**: mint an interaction
space, then explore within it. prx's reason for wanting the same thing is *not*
the paper's (scale/cost — a repo is small; scout does not need retrieval to
fit). prx's reason is **capability + audit**: a bounded corpus the agent
*cannot widen on its own*, and whose boundary is *recorded in the lineage of
every read taken inside it.* Same mechanism, different driver — worth stating
plainly so we don't import the paper's scaling rationale we don't need.

## 4. The additive shape — `CorpusScope`

Lift scout's anonymous constants into a single minted, content-addressed value.
A scope *is* the interaction space:

```ts
interface CorpusScope {
  scopeId: Digest;          // = digestManifest(manifest) — content-addressed, like derivationId
  roots: string[];          // absolute, or work-unit-resolved (GH-<n>)
  include?: GlobPattern[];  // allowlist (default: today's text-extension globs)
  exclude?: GlobPattern[];  // denylist  (default: today's skip-list)
  budget: {
    maxFileBytes: number;   // today's 2 MiB, now per-scope
    maxFiles: number;       // walk census cap
    maxMatches: number;     // today's 200/5000, now per-scope
  };
  contracts: ["scout.scope/v1"];
  ts: number;
}
```

`read`/`grep`/`files` take an optional `scope`. Two effects:

1. **Enforcement.** A path outside `roots`/`include`, or a read past `budget`,
   is refused with a new error code (`PATH_OUT_OF_SCOPE` / `BUDGET_EXCEEDED`)
   rather than served. Today's hardcoded constants become the **default scope** —
   so the change is additive and back-compatible: no `scope` ⇒ the global
   default exactly as now.

2. **Provenance.** The scope digest joins the derivation manifest as a *second
   input*, reusing the existing anchored-chain machinery exactly as
   `worktree-provenance.md` reused the SLSA tier — no new mechanism:

   ```
   manifest.inputs = {
     source: "sha256:<file-content>",
     scope:  "sha256:<scope-manifest>"   // NEW
   }
   ```

   Now `descendants(scopeId)` answers *"every read taken inside this
   investigation,"* and a scope is itself an anchor on the chain — invalidating
   the scope invalidates the bounded investigation as a unit.

The teeth (deferred slice 3): a scope can be **minted and signed by `policy`**,
and scout verifies the signature before honouring it — so the *agent cannot
forge a wider corpus for itself.* That is the bounded-systems thesis applied to
retrieval: the corpus handle is an unforgeable, attenuating capability, and
read/grep/files are its only exercise.

## 5. Slices

1. **Scope as a value.** `CorpusScope` + `digestScope`; `read`/`grep`/`files`
   accept an optional `scope` and enforce `roots`/`include`/`exclude`/`budget`
   (`PATH_OUT_OF_SCOPE`, `BUDGET_EXCEEDED`). Today's constants become the
   default scope. Pure, unit-testable, no chain dependency. Stays inside the
   extractability allowlist (`node:fs`, `node:path`, `cas`, `anchored-chain`).
2. **Scope in the chain.** Scope digest as the second manifest input;
   `scoutScopeDerivation` / `recordScoutScopeDerivation`; `descendants(scopeId)`
   lineage query. Reuses `digestManifest` + `DerivationStore`.
3. **Minted / signed scope (deferred — the teeth).** `policy` mints + signs
   scopes; scout verifies before honouring; the agent cannot self-widen. This is
   where the capability boundary gets enforced rather than merely recorded.

## 6. Consequences

- scout's bounds stop being anonymous constants and become a **named,
  inspectable, chain-recorded capability** — the same static→derived move
  `two-clock-policy.md` urged for `policy`, here on the *corpus* axis.
- The agent's investigation gains a lineage *root*: not just "which reads
  consumed file X" but "which reads belonged to scoped investigation S." A
  bounded interaction space becomes auditable as a unit.
- No new mechanism in slices 1–2: reuses `digestManifest` / the derivation
  manifest / `DerivationStore`. The only novelty is a second input edge and a
  default-scope fallback.
- Honours the `worktree-provenance.md` boundary: a scope governs **file-content
  reads** only. It is *not* a general capability for git state or infra config —
  scout's model is content, and a scope must not smuggle in authority over
  anything else.

## 7. Recommendation

- **Adopt the framing now; name the bound.** State in scout's model that its
  hardcoded limits *are* an interaction space — currently an anonymous global
  one. Naming it prevents the conflation `two-clock` warns about: a constant
  wearing a capability's clothes.
- **Make slice 1 the first real step** — `CorpusScope` as a value with the
  current constants as its default. It is back-compatible, pure, and forces the
  bound to become a thing you can hold before any chain or signing work.
- **Do not import the paper's scaling rationale.** scout does not need a bounded
  space to *fit* a corpus; it wants one to *scope and audit* access. Building
  toward retrieval-scale (sharding, pre-filtering for cost) would be solving a
  problem prx does not have.

## 8. Non-goals & open questions

- **Non-goal:** any retriever/index/embedding/vector step. DCI is the model;
  this spike narrows the corpus, it does not reintroduce a retrieval interface.
- **Non-goal:** building the minted/signed scope (slice 3) — this spike names
  the capability boundary; enforcing it is a separate unit gated on `policy`.
- **Open:** does `CorpusScope` live in scout, or do `roots`/`budget` belong in
  scout while the *authority to mint* belongs in `policy` / `machine-schema`?
  (Likely split: scope-as-value in scout, mint-and-sign in policy.)
- **Open:** the `in: GH-<n>` work-unit resolution already implies a corpus — is
  a work-unit id *itself* a scope, or does it resolve *to* one?
- **Open:** does a scope *replace* the hardcoded skip-list/extension allowlists,
  or *layer* over them as the default it can only narrow (never widen)?
- **Tension:** the bound must stay legible — a read taken inside a scope has to
  record *which* scope was in force (the second input edge), so the interaction
  space is itself a derivation on the chain, not hidden per-call state. This is
  the same "moving guardrail must stay auditable" constraint `two-clock` raised.
