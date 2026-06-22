# The hard part of agent-built software isn't the code

*Draft — blog post #1. Lead with the bet, in plain language.*

An agent can write the filesystem layer now. The process spawner, the tool
adapters, the CLI — all of it. What it can't do yet, what nobody has really
solved, is keep all of those honest with each other while it keeps editing them.

That gap is the whole problem, and it's where I work.

## Good ideas bifurcate

Agentic development works by **bifurcation**: a good idea earns its own bounded
abstraction with a defined contract. "Filesystem access" becomes a thing with
edges — a name, a surface, a promise about what it does and doesn't do. That
boundary is exactly what makes an agent useful on it. You can scope an agent to a
contract; you can't scope one to a vibe.

This part is getting easy. Hand an agent a crisp contract and it fills in the
implementation, the tests, the docs. The cost of *authoring* a bounded
abstraction is falling toward zero — so the cost moves somewhere else.

## The unsolved part is between the abstractions, not inside them

When authoring is cheap, you get *more* of it: more seams, more contracts, more
places two agent-authored pieces can quietly come to disagree. The filesystem
door assumes one ownership model; the process door drifts to another; the CLI
says one thing and its MCP adapter says a slightly older thing. Each piece is
internally fine. The system is wrong.

The hard, unsolved problem is **keeping many bounded, agent-authored abstractions
honest against each other as they evolve** — enforcing contracts *between* ideas,
not just within one. Most tooling secures a single action. The interesting
failure mode is the seam.

## The bet: three mechanisms for the seams

prx is my answer — not a product, an argument made in running code. Three
mechanisms:

**One sanctioned door per kind of power.** For each ambient capability there is
exactly one way through — a door you hold a socket to, never the keys behind it:
`fs`, `proc`, `env`, `gh`, `git`, `cas`. The door checks an owner and a policy,
acts or refuses, and records either way:

```
agent → fs.write("/repo/out.txt", bytes)   ✓ written · signed keeper · audited
agent → fs.write("/etc/shadow", bytes)      ✗ refused · outside keeper's grant · recorded
```

Same door, one allow, one deny, both recorded. The seam is the only path, so the
seam is where authority is decided.

**One source of truth, projected to many surfaces.** The industry hand-maintains
the same command four times — CLI, MCP tool, OpenAPI route, tool schema — and
hopes they stay in sync. They don't. prx derives them from one spec, so the
surfaces *can't* disagree: there's only one thing to disagree with.

**Drift is a build failure, not a code review.** A contract no tool enforces is
not a standard; it's a wish, and an agent regresses it the first time it's
convenient. So docs generate from source and fail CI on drift, and behaviour
specs execute against the engine. Trust is *mechanical* — gates on every change,
not reviewer vigilance that can't scale to agent throughput.

## What's a result and what's still a bet

I grade my own claims against the running code, so plainly:

- **Enforced today** — the drift gates (docs from source) and executable behaviour
  specs. If they break, the build breaks.
- **Partial** — "every privileged effect attributable to a signed owner." True on
  the common path; the named gap is a permission boundary I'm still closing.
- **The bet** — contracts staying honest *between* components as they evolve. That
  one is stated as direction, not a finished result. It's the problem this whole
  project is aimed at.

When agents write most of the software, the scarce resource isn't authoring — it's
trust *between* the pieces. The seam is where that's won or lost. That's the bet,
and I'm working it in the open, graded against the code.

---

*The capability-seam idea converges with established object-capability and
information-flow research; that mapping is a later post. This one is the bet.*
