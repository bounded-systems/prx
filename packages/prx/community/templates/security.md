# Security Policy

`{{project.name}}` — {{project.tagline}}.

## Supported versions

Security fixes land on the latest release line only. `{{project.name}}` is
pre-1.0; expect the supported range to move forward as releases ship.

| Version | Supported |
| ------- | --------- |
{{security.versionTable}}

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting:

1. Go to the [**Security** tab]({{project.url}}/security) of the repository.
2. Click **Report a vulnerability** (or use this direct link: {{security.reportUrl}}).
3. Describe the issue, the affected version, and a reproduction if you have one.

GitHub keeps the report private between you and the maintainer until a fix is
published. If private reporting is unavailable, contact the maintainer through
their GitHub profile at {{copyright.url}} rather than disclosing publicly.

## What to expect

- An acknowledgement within **{{security.responseDays}} days**.
- A private discussion to confirm and scope the issue.
- A fix released on the supported line, with a published GitHub Security
  Advisory crediting you unless you prefer to remain anonymous.

## Scope

`{{project.name}}` orchestrates agent runs and shells out to local tooling
(`git`, `gh`, `bd`, Dolt, container runtimes). Reports about how `{{project.name}}`
invokes, trusts, or passes data to those tools are in scope. Vulnerabilities in
the upstream tools themselves should be reported to their respective projects.
