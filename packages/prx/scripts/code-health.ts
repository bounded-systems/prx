// Code-health detection — an honest, grounded read on sprawl, coupling, dead
// code, "what the product actually is", and spec-driven-CLI readiness. Not a
// quality gate (that's test/code_health.test.ts, which ratchets the cheap
// deterministic budgets); this is the on-demand deep scan.
//
//   bun run health            # human report (markdown)
//   bun run health -- --json  # machine output (the CodeHealthReport)
//   prx health                # same report via the spec-driven verb (JSON)
//
// The computation lives in src/health/report.ts so the script and the `prx
// health` verb share one source. Modern toolchain (replaced madge):
//   - knip               → dead code (unused files, declared in knip.json).
//   - dependency-cruiser → circular imports (.dependency-cruiser.cjs).
//   - bespoke            → sprawl, product map, VerbSpec coverage.

import { computeHealthReport, renderHealthMarkdown } from "../src/health/report.ts";

const asJson = process.argv.slice(2).includes("--json");
const report = computeHealthReport();
console.log(asJson ? JSON.stringify(report, null, 2) : renderHealthMarkdown(report));
