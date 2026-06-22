#!/usr/bin/env bun
/**
 * front-desk-coverage — audit which org repos carry the instant-add template
 * (`.github/workflows/front-desk-add.yml`), so the Front Desk *instant* path
 * can't silently drift to sweep-only as new repos appear.
 *
 * Thin wrapper: the logic lives in `../src/front-desk/coverage.ts` (a library
 * module that can become a spec-driven verb), per the scripts→verbs forcing
 * function. This file only parses flags, prints, and sets the exit code.
 *
 *   GITHUB_TOKEN=… bun run front-desk:coverage         # human-readable report
 *   GITHUB_TOKEN=… bun run front-desk:coverage --json  # machine-readable
 *   GITHUB_TOKEN=… bun run front-desk:coverage --check  # exit 1 if a public,
 *                                                        # non-archived repo
 *                                                        # lacks the template
 *
 * Token: any token with repo read on the org (the Front Desk App token in CI,
 * or a PAT locally), read from GITHUB_TOKEN or GH_TOKEN by the library.
 */

import {
  auditFrontDeskCoverage,
  MissingTokenError,
  renderReport,
} from "../src/front-desk/coverage.ts";

const JSON_OUT = process.argv.includes("--json");
const CHECK = process.argv.includes("--check");

try {
  const report = await auditFrontDeskCoverage();
  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          org: report.org,
          template: report.template,
          total: report.rows.length,
          present: report.present,
          missing: report.missing,
          private: report.privateRepos,
          archived: report.archived,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(renderReport(report));
  }
  if (CHECK && report.missing.length > 0) process.exit(1);
} catch (err: unknown) {
  if (err instanceof MissingTokenError) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(`front-desk-coverage: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
