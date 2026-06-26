---
---

Fail closed on unparseable policed commands in the agent policy guard (prx-w1v).
Two fail-open bypasses are closed:

- **Misparse via value-taking options.** `parsePolicedCommand` dropped every
  `-`-prefixed token, so a value-taking global option's value was mistaken for
  the verb — `git -C /repo push` read as subcommand `/repo` (unknown ⇒ allowed),
  and `gh -R o/r pr merge` as `o/r`. It now skips those options *with* their
  values (`git -C/-c/--git-dir/--work-tree/--namespace`, `gh -R/--repo`) and
  finds the real verb, so ownership is enforced (a non-keeper push, a non-forge
  merge, are denied).
- **Pass-through on no verb.** A head that names a policed tool but yields no
  parseable subcommand (`prx tools git`, `git -C /x` with no verb, an option
  whose value ate the verb) used to pass through. `decideAgentToolCall` now fails
  closed for the actors the hook governs (policy roles + the capability-poor
  orchestrator); the main session and unknown subagents stay out of scope.

Adds `namesPolicedTool` and adversarial parser tests. No API change, no release.
