import {
  defaultRunner,
  repoNameWithOwner,
  validateGitHubIssue,
  type CommandRunner,
} from "../github.ts";
import type { ResolvedWorkUnit, WorkUnitResolver } from "./types.ts";

const GH_ID_PATTERN = /^GH-(\d+)$/;

export class GithubResolver implements WorkUnitResolver {
  readonly name = "github" as const;

  constructor(private readonly repoPath: string) {}

  async fetch(
    canonicalId: string,
    opts?: { runner?: CommandRunner },
  ): Promise<ResolvedWorkUnit> {
    const match = canonicalId.match(GH_ID_PATTERN);
    if (!match) {
      throw new Error(`GithubResolver requires a GH-<n> canonical id, got: ${canonicalId}`);
    }
    const runner = opts?.runner ?? defaultRunner;
    const issueNumber = Number.parseInt(match[1]!, 10);
    const repo = repoNameWithOwner(this.repoPath, runner);
    const issue = validateGitHubIssue(repo, issueNumber, runner);
    const state = issue.state.toUpperCase() === "OPEN" ? "open" : "closed";
    return {
      id: canonicalId,
      title: issue.title,
      body: issue.body ?? null,
      state,
      url: issue.url ?? null,
      source: "github",
    };
  }
}
