## Summary

<!-- What does this PR do, and why? Keep it to one focused change. -->

Closes #

## Checklist

- [ ] **Independent PR** — no bundled or speculative changes
- [ ] **Changed codepaths verified** — targeted unit + integration tests
- [ ] **Root cause identified** — every failure traced to source, not papered over
- [ ] **No duplication** — refactoring preferred over copy/paste
- [ ] **No unrelated changes** — housekeeping isolated to its own branch
- [ ] **Generated artifacts regenerated** — ran `bun run schemas:export` /
      `bun run community:render` if I touched a source of truth (CI fails on drift)
- [ ] **CI is green** — never mark ready while CI is pending or failing
