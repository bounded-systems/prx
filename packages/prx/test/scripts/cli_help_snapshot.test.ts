import { describe, expect, test } from "bun:test";

type HelpCommand = {
  readonly label: string;
  readonly binary: string;
  readonly cmd: readonly string[];
};

const helpCommands: readonly HelpCommand[] = [
  { label: "claude --help", binary: "claude", cmd: ["claude", "--help"] },
  { label: "codex --help", binary: "codex", cmd: ["codex", "--help"] },
  { label: "gh --help", binary: "gh", cmd: ["gh", "--help"] },
  { label: "gh copilot --help", binary: "gh", cmd: ["gh", "copilot", "--help"] },
  { label: "gemini --help", binary: "gemini", cmd: ["gemini", "--help"] },
  { label: "cursor-agent --help", binary: "cursor-agent", cmd: ["cursor-agent", "--help"] },
];

function normalizeText(value: string): string {
  const normalizedNewlines = value
    .replaceAll("\r\n", "\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
  const sanitizedWarnings = normalizedNewlines
    .split("\n")
    .filter(
      (line) => !line.startsWith("WARNING: proceeding, even though we could not update PATH:"),
    )
    .join("\n");
  const homeDir = process.env.HOME;
  return homeDir && homeDir.length > 1
    ? sanitizedWarnings.split(homeDir).join("$HOME")
    : sanitizedWarnings;
}

// A wrapper script that exists on PATH but whose runtime (e.g. node) is missing
// produces an env-level failure rather than the CLI's own help output. Treat
// those as "unavailable" so degraded local environments don't fail the snapshot
// (the strict comparison still runs in environments where every CLI is fully
// invokable, e.g. CI).
const ENV_BROKEN_PATTERNS: readonly RegExp[] = [
  /env: [^:]+: No such file or directory/,
  /command not found/,
];

function runHelp(command: HelpCommand): string {
  if (!Bun.which(command.binary)) {
    return `status: unavailable\nbinary not found: ${command.binary}`;
  }

  const result = Bun.spawnSync({
    cmd: [...command.cmd],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
      CLICOLOR: "0",
      FORCE_COLOR: "0",
    },
  });
  const combinedOutput = normalizeText(
    `${Buffer.from(result.stdout).toString()}${Buffer.from(result.stderr).toString()}`,
  );
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : -1;

  if (exitCode === 127 && ENV_BROKEN_PATTERNS.some((re) => re.test(combinedOutput))) {
    return `status: unavailable\nbinary not found: ${command.binary} (runtime missing: ${combinedOutput.split("\n")[0]})`;
  }

  return combinedOutput.length > 0
    ? `exit_code: ${exitCode}\n${combinedOutput}`
    : `exit_code: ${exitCode}`;
}

describe("CLI help snapshot", () => {
  // GH-2302: this test cold-spawns 6 external CLIs sequentially (claude, codex,
  // gh, gemini, cursor-agent) and snapshots their --help. Under CI latency the
  // total exceeds bun's 5000ms default (observed ~9.6s); locally it runs in
  // <1s. The explicit timeout below gives generous headroom so a slow runner is
  // not a spurious timeout failure — it does not change what the test asserts.
  test("matches expected CLI help output", () => {
    const sections = helpCommands.map((command) => ({
      label: command.label,
      output: runHelp(command),
    }));
    const unavailable = sections.filter((section) =>
      section.output.startsWith("status: unavailable"),
    );

    // CI runners may not have all external CLIs installed; only enforce help snapshots
    // when every command is available in the environment.
    if (unavailable.length > 0) {
      for (const section of unavailable) {
        expect(section.output).toContain("binary not found");
      }
      return;
    }

    const snapshot = sections
      .map((section) => `## ${section.label}\n\n${section.output}`)
      .join("\n\n");
    expect(snapshot).toMatchSnapshot();
  }, 60_000);
});
