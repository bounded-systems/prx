# Contributing to prx

`prx` — the agent-run PR contract / work-unit CLI. Thanks for your interest in contributing.

> **Licensing note.** `prx` is released under the
> [MIT License](https://opensource.org/license/mit) (MIT). OSI-approved permissive open-source licence. Free for any use, including commercial, provided the copyright notice and permission notice are retained.
> By submitting a contribution you agree it is licensed under the same terms.

## Before you start

- This is a small, opinionated project. For anything beyond a typo or an
  obvious bug fix, **open an issue first** so we can agree on scope before you
  invest time.
- Be kind. This project follows a [Code of Conduct](./CODE_OF_CONDUCT.md).
- Found a security problem? **Do not** open a public issue — see the
  [Security Policy](./SECURITY.md).

## Development setup

`prx` is a [Bun](https://bun.sh) + TypeScript monorepo.

```bash
bun install
bun test                # run the test suite
bun run typecheck       # bunx tsc --noEmit
bun run prx:build       # build the self-contained binary -> dist/prx
```

## Generated artifacts must not drift

Several files in this repo are **generated** and committed. CI fails if
regenerating produces a `git diff`, so regenerate locally and commit the result
when you touch a source of truth:

- **JSON Schemas** — `bun run schemas:export` (Zod schemas are the source of
  truth under `packages/prx/src/**/schema.ts`).
- **Community health files** — `LICENSE`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
  this file, and the `.github/` issue + pull-request templates are rendered from
  `packages/prx/community/` by `bun run community:render`. Edit the data in
  `community/community.json` or the pinned templates in `community/templates/` —
  **never** edit the generated files by hand. Run `bun run community:check` to
  verify there is no drift.
- **CLI help snapshots** — `bun run snapshot:help:refresh` after intentional
  help-text changes.

## Pull request standards

Keep PRs minimal and independent — no bundled or speculative changes. Each PR
should:

1. Address one thing, with its scope stated in the description.
2. Verify the changed codepaths with targeted unit and integration tests.
3. Trace every failure to its root cause rather than papering over symptoms.
4. Prefer refactoring over copy/paste duplication.
5. Keep unrelated housekeeping on its own branch.

CI must be green before a PR is marked ready for review. Never merge into
protected branches locally — merges land through GitHub PRs.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
`fix:`, `chore:`, `docs:`, …). Reference the issue or work unit you are closing.
