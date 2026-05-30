/**
 * @bounded-systems/env — the ambient-environment capability.
 *
 * The ONE place process.env is read. Ambient config is a dependency; routing it
 * through an explicit import turns a hidden edge into a visible one, so a
 * package that needs env declares @bounded-systems/env in its imports rather than reaching
 * into the global. (The boundary tests forbid raw process.env everywhere else.)
 */

/** Read an env var; undefined when unset. */
export function getEnv(key: string): string | undefined {
  return process.env[key];
}

/** Read an env var or throw — for values a process genuinely cannot run without. */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error(`required environment variable not set: ${key}`);
  }
  return value;
}

/** First set value among the given keys (precedence order), else null. */
export function firstEnv(...keys: string[]): string | null {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== "") return value;
  }
  return null;
}

/** The full ambient environment — for handing to a subprocess as its default. */
export function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/**
 * Set an ambient env var. A write to the process environment is even more
 * load-bearing than a read (child processes inherit it), so it routes through
 * the capability too — the mutation is a visible @bounded-systems/env edge, not a raw
 * `process.env.X = …`.
 */
export function setEnv(key: string, value: string): void {
  process.env[key] = value;
}

/** Remove an ambient env var (the inverse of {@link setEnv}). */
export function deleteEnv(key: string): void {
  delete process.env[key];
}
