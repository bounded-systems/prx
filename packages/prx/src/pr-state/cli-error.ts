// Extracted from packages/prx/src/pr-state/cli.ts by scripts/codemod/extract-module.ts — part of the
// §4 decomposition of the pr-state/cli.ts monolith into focused modules.

export type CliErrorDetails = {
  code: "PRX_SESSION_NOT_PROJECTED_LOCALLY";
  message: string;
  workUnitId: string;
  source: string;
  title: string;
  url: string | null;
  suggestedNextCommands: string[];
};

export class CliError extends Error {
  exitCode: number;
  details?: CliErrorDetails;

  constructor(message: string, exitCode = 1, details?: CliErrorDetails) {
    super(message);
    this.exitCode = exitCode;
    if (details !== undefined) {
      this.details = details;
    }
  }
}


