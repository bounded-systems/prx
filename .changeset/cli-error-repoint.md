---
---

internal: repoint all CliError importers to the @cli-error leaf and drop cli.ts's
back-compat re-export — removes the pre-existing cli ↔ *_adopt import cycles
(dependency-cruiser no-circular warnings 63 → 56). No package version change.
