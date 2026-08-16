// prx surface specification — the actor / verb / effect model as enforceable types.
//
// This file is the CONSTITUTION. The four design invariants are encoded as CUE
// constraints, so a surface instance that violates them fails `cue vet`. The law
// is the type; the migration backlog is whatever `cue vet surface.current.cue`
// rejects.
//
// Why CUE and not OpenAPI:
//   - OpenAPI models HTTP resources (paths × methods × bodies). prx has no HTTP
//     verbs and its load-bearing facts are *effects* (which surface a verb
//     mutates) — which OpenAPI can only smuggle in as `x-` extension soup.
//   - These rules are CONSTRAINTS. CUE lets the constraint BE the schema: e.g.
//     "writes at most one surface" is a single type, not a separate linter.
//   - This is the registry GH-974/975 keeps deferring, formalized once.
//
// MCP is NOT a peer of this spec — it is one optional *projection* of it
// (CUE -> {CLI table, help sitemap, OpenAPI doc, MCP manifest}). MCP is opt-in
// and OFF by default (`mcp: *false`) because every exposed tool's schema is
// injected into the model context each session (token cost). See #Verb.mcp.
package prx

// ---------------------------------------------------------------------------
// Surfaces — the external state planes a verb may touch.
//
// A surface is a BACKING STORE, not an actor. This is Rule 3 in type form.
// `beads` was removed entirely (GH-1012); `dolt` remains as the Front Desk
// mirror substrate, `notion` as an (arguably retireable) substrate — flagged
// for confirmation, not hard-excluded.
#Surface: "github" | "dolt" | "notion" | "filesystem" | "cas" | "tmux"

// ---------------------------------------------------------------------------
// Verb — one executable command. Effects and transport are first-class.
#Verb: {
	desc?: string

	// EFFECTS.
	// `reads` is unbounded — a verb may read any number of surfaces.
	// `writes` is AT MOST ONE surface. This single line IS Rule 4
	// ("never mutate two surfaces with one verb"): `writes` is one #Surface
	// or null, structurally never a set. A verb that needs to mutate two
	// surfaces must be split into two verbs (one write each) — typically a
	// canonical write plus a separate projection/mirror.
	reads: [...#Surface] | *[]
	writes: #Surface | *null

	// TRANSPORT.
	// prx is a CLI first; the model calls it via Bash at zero standing token
	// cost. MCP exposure is an opt-in projection, OFF by default, because each
	// MCP tool's name+description+inputSchema is pushed into the model context
	// every session. Flip to true only for verbs where typed/structured tool
	// access earns its tokens (realistically: the per-actor `agent` verbs).
	mcp: bool | *false

	// Safe to re-run? Lets an agent reason about retries after a partial fail.
	idempotent?: bool
}

// Convenience: a read-only verb declares no write surface.
#ReadVerb: #Verb & {writes: null}

// ---------------------------------------------------------------------------
// Actor — a workflow DOMAIN (intake, triage, publisher, ...), never a surface.
//
// Rule 2: every actor exposes `agent`, the uniform headless operator for that
// domain. It is required with no default, so an actor that omits it is an
// incomplete value and fails `cue vet`. No special cases — `help` included:
// the `help` actor's `agent` renders the sitemap; a bare `prx <actor>` prints
// that actor's own verb list (help is not a special top-level flag).
#Actor: {
	desc?: string
	agent: #Verb // Rule 2 — required, no default.
	verbs: [string]: #Verb
}

// ---------------------------------------------------------------------------
// Prx — the root.
//
// Rule 1: every first arg is an actor (`prx <actor> ...`). There are no loose
// top-level verbs; a bare command like `prx tui` must be rehomed under an actor.
// Rule 3: a surface name may never be an actor name (beads/bd excluded here).
#Prx: {
	actors: {
		[Name = !~"^(beads|bd)$"]: #Actor
	}
}

// The canonical surface conforms to #Prx:
//   surface: #Prx & { actors: { ... } }   // see surface.current.cue
