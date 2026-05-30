/**
 * GH-1287: argv-size estimator + structured overflow error. The implement
 * session profile assembles many large-ish strings (allowlist, system prompt,
 * MCP path, agents JSON, etc.) into the `claude` argv. macOS `posix_spawn`
 * imposes a combined argv+envp ceiling (~256 KB) plus a per-string
 * `MAX_ARG_STRLEN` cap, and the error returned (`E2BIG`) surfaces only as a
 * bare `command too long` from the kernel.
 *
 * This helper lets the runtime-profile builder fail loudly with a structured
 * message naming the offending component instead, so future regressions point
 * straight at the inflated flag rather than requiring a stat-based postmortem.
 */

export interface ArgComponent {
  /** Human-readable label (e.g. `--append-system-prompt`). */
  label: string;
  /** UTF-8 byte length of the component's value. */
  bytes: number;
}

/**
 * Sum of UTF-8 byte lengths of each argv string plus a +1 NUL terminator per
 * arg (matches what the kernel actually counts toward the per-string and
 * combined ceilings).
 */
export function estimateArgvBytes(args: readonly string[]): number {
  let total = 0;
  for (const a of args) total += Buffer.byteLength(a, "utf8") + 1;
  return total;
}

/**
 * Pick the component with the largest UTF-8 size. Used to name the offender
 * in the overflow error message.
 */
export function findLargestComponent(components: readonly ArgComponent[]): ArgComponent | undefined {
  let largest: ArgComponent | undefined;
  for (const c of components) {
    if (!largest || c.bytes > largest.bytes) largest = c;
  }
  return largest;
}

/**
 * Conservative ceiling well below the macOS `MAX_ARG_STRLEN` (typically
 * 256 KB) with envp headroom. Tuned for the implement-session shape, which
 * carries an allowlist + agents.json + MCP path on top of the system prompt.
 */
export const ARGV_SAFE_CEILING_BYTES = 120 * 1024;

export class ArgvOverflowError extends Error {
  readonly totalBytes: number;
  readonly ceilingBytes: number;
  readonly largestComponent?: ArgComponent | undefined;

  constructor(input: {
    totalBytes: number;
    ceilingBytes: number;
    largestComponent?: ArgComponent | undefined;
  }) {
    const parts = [
      `argv would exceed safe size (${input.totalBytes} bytes; ceiling ${input.ceilingBytes} bytes)`,
    ];
    if (input.largestComponent) {
      parts.push(
        `largest component: ${input.largestComponent.label} (${input.largestComponent.bytes} bytes)`,
      );
    }
    parts.push("Inspect the assembled args and reduce the offending input.");
    super(parts.join("; "));
    this.name = "ArgvOverflowError";
    this.totalBytes = input.totalBytes;
    this.ceilingBytes = input.ceilingBytes;
    this.largestComponent = input.largestComponent;
  }
}

/**
 * Throw if the assembled argv would exceed the safe ceiling. Caller passes
 * the full args array (used for the byte-sum) plus a parallel components list
 * naming the largest single contributors so the error message can identify
 * the offender by flag rather than position.
 */
export function assertArgvWithinCeiling(
  args: readonly string[],
  components: readonly ArgComponent[],
  ceilingBytes: number = ARGV_SAFE_CEILING_BYTES,
): void {
  const total = estimateArgvBytes(args);
  if (total <= ceilingBytes) return;
  throw new ArgvOverflowError({
    totalBytes: total,
    ceilingBytes,
    largestComponent: findLargestComponent(components),
  });
}
