# Security Policy

`prx` — the agent-run PR contract / work-unit CLI.

## Supported versions

Security fixes land on the latest release line only. `prx` is
pre-1.0; expect the supported range to move forward as releases ship.

| Version | Supported |
| ------- | --------- |
| 0.1.x | Yes |
| < 0.1 | No |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting:

1. Go to the [**Security** tab](https://github.com/bounded-systems/prx/security) of the repository.
2. Click **Report a vulnerability** (or use this direct link: https://github.com/bounded-systems/prx/security/advisories/new).
3. Describe the issue, the affected version, and a reproduction if you have one.

GitHub keeps the report private between you and the maintainer until a fix is
published. If private reporting is unavailable, contact the maintainer through
their GitHub profile at https://github.com/bdelanghe rather than disclosing publicly.

## What to expect

- An acknowledgement within **7 days**.
- A private discussion to confirm and scope the issue.
- A fix released on the supported line, with a published GitHub Security
  Advisory crediting you unless you prefer to remain anonymous.

## Scope

`prx` orchestrates agent runs and shells out to local tooling
(`git`, `gh`, `bd`, Dolt, container runtimes). Reports about how `prx`
invokes, trusts, or passes data to those tools are in scope. Vulnerabilities in
the upstream tools themselves should be reported to their respective projects.
