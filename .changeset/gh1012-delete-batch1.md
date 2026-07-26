---
"@bounded-systems/prx": minor
---

Delete the bd maintenance subcommands `prx doctor dedupe-bd` and `prx delegate
repair-assignees` (GH-1012, beads removal). Both were bd-substrate maintenance
verbs (dedupe bd records sharing an external-id pin; rewrite legacy bd assignee
strings) with no purpose once beads is retired. Removed the modules, their tests,
the CLI wiring (command union, router, parser, dispatch, help, registry), and
refreshed the help snapshot.
