/**
 * The `node:` surface `cli/runtime.ts` uses, declared locally.
 *
 * `cloud-aws` installs no `@types/node`, on purpose: the Check_Pipeline compiles
 * this package with `tsc --noEmit`, and `core/` is required to stay free of
 * `node:` imports entirely, so a platform typing package would be one more thing
 * to reason about. Every module that only needs a GLOBAL reads it through
 * `globalThis` behind a narrow local interface (`aws/stdout-log-writer.ts`,
 * `server/startup.ts`, `cli/runtime.ts` for `process`). An IMPORT cannot be
 * satisfied that way - the specifier has to resolve - so this file declares the
 * five modules the CLI runtime imports, with only the members it touches, the
 * same way `server/node-http.d.ts` declares `node:http`.
 *
 * Shapes are deliberately loose where Node's real types are richer: every method
 * declared here is satisfied by the real Node export, and nothing here is used to
 * type a test double (the CLI injects its ports instead, see `cli/ports.ts`).
 *
 * If `@types/node` is ever added to this package, delete this file and
 * `server/node-http.d.ts` in the same change: two declarations of the same module
 * would collide.
 *
 * Feature: aws-byo-deploy
 * Requirements: 6.2, 6.4
 */

declare module 'node:fs' {
  /** True when the path exists. Used for the config file and the CDK entry point. */
  export function existsSync(path: string): boolean;
  /** Read a whole file as text. Throws when the path is absent or unreadable. */
  export function readFileSync(path: string, encoding: 'utf-8'): string;
  /** Create a unique directory whose name starts with `prefix`; returns its path. */
  export function mkdtempSync(prefix: string): string;
}

declare module 'node:path' {
  /** Join and normalize path segments against the leftmost absolute one. */
  export function resolve(...segments: string[]): string;
  /** Join path segments without resolving against the working directory. */
  export function join(...segments: string[]): string;
  /** The directory portion of a path. */
  export function dirname(path: string): string;
}

declare module 'node:os' {
  /** The platform temporary directory, the parent of the deploy outputs file. */
  export function tmpdir(): string;
}

declare module 'node:url' {
  /** Convert a `file:` URL to a platform path. Used on `import.meta.url`. */
  export function fileURLToPath(url: string): string;
}

declare module 'node:child_process' {
  /** A child stdio stream. `'data'` carries a chunk that stringifies to text. */
  export interface ChildStream {
    on(event: string, listener: (chunk: { toString(): string }) => void): void;
  }

  export interface ChildProcessHandle {
    /** Present when the matching stdio slot was configured as `'pipe'`. */
    stdout: ChildStream | null;
    stderr: ChildStream | null;
    /** `'close'` carries the exit code or null; `'error'` carries an Error. */
    on(event: string, listener: (...args: any[]) => void): void;
  }

  export interface SpawnOptions {
    cwd?: string;
    /** One entry per stdio slot: `'inherit'`, `'pipe'` or `'ignore'`. */
    stdio?: readonly string[];
    /** Required on Windows to run a `.cmd` shim such as `npx`. */
    shell?: boolean;
    env?: Record<string, string | undefined>;
  }

  export function spawn(
    command: string,
    args: readonly string[],
    options?: SpawnOptions,
  ): ChildProcessHandle;
}
