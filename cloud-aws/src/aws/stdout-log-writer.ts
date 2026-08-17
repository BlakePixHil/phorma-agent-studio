/**
 * The production `LogWriter`: one structured single-line JSON entry per write,
 * to `process.stdout`.
 *
 * There is no CloudWatch Logs client here, on purpose. `ComputeConstruct` runs
 * the container with the `awslogs` log driver, so stdout already lands in the
 * App_CMK-encrypted log group with the configured retention. A Logs client would
 * be a second path to the same log group: a second set of credentials to grant,
 * a second failure mode, a second ordering, and duplicate entries whenever both
 * paths worked.
 *
 * The single-line contract belongs to the caller. `TelemetryAdapter.log` writes
 * `JSON.stringify(entry)`, which escapes every newline, so one call is one log
 * record. This module appends exactly one trailing newline and never inserts
 * another, because the `awslogs` driver splits records on newlines and a blank
 * line would become an empty record.
 *
 * Nothing is resolved at module load: the Check_Pipeline imports this file with
 * no runtime present beyond the type-checker, and `createStdoutLogWriter` is the
 * first point at which a stream is looked up.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.1, 8.2
 */

import type { LogWriter } from './ports.js';

// ---------------------------------------------------------------------------
// The stream this module needs
// ---------------------------------------------------------------------------

/**
 * The one stream operation this module uses, declared locally.
 *
 * `cloud-aws` installs no `@types/node`, so `process` carries no ambient type.
 * Declaring the two members that matter keeps the module type-checked without
 * pulling a whole platform typing surface into a package whose `core/` layer is
 * required to stay free of `node:` imports. `NodeJS.WriteStream` satisfies this
 * shape, so injecting the real stream needs no cast.
 */
export interface LogSink {
  /**
   * Write a chunk and report completion through the callback. The callback form
   * is the load-bearing one: `write` returning `false` means the stream buffered
   * the chunk, and resolving on the return value alone would let an unbounded
   * backlog build behind a slow pipe.
   */
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

export interface StdoutLogWriterOptions {
  /**
   * The stream to write to. Defaults to `process.stdout`. Present so a test can
   * capture lines without touching the process streams; production passes
   * nothing.
   */
  sink?: LogSink;
}

// ---------------------------------------------------------------------------
// Stream resolution
// ---------------------------------------------------------------------------

interface ProcessLike {
  stdout?: LogSink;
}

/**
 * Resolve `process.stdout` through `globalThis`, so no ambient `process`
 * declaration is needed and no import of `node:process` reaches a package that
 * also compiles for the type-checker alone.
 */
function resolveProcessStdout(): LogSink {
  const stdout = (globalThis as { process?: ProcessLike }).process?.stdout;
  if (!stdout || typeof stdout.write !== 'function') {
    throw new Error(
      'createStdoutLogWriter needs process.stdout, and this runtime exposes none. ' +
        'Pass a sink explicitly when running outside Node.',
    );
  }
  return stdout;
}

/**
 * Drop trailing newlines so the appended one is the only record separator. An
 * interior newline is left alone: it can only arrive from a caller that did not
 * hand over a JSON line, and silently rewriting the payload would be worse than
 * emitting it as the caller built it.
 */
function oneLine(line: string): string {
  return `${line.replace(/[\r\n]+$/, '')}\n`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the production `LogWriter` over `process.stdout`.
 *
 * The returned promise settles when the stream has accepted the chunk, and
 * rejects when the stream reports an error (a closed pipe, for instance). The
 * caller owns the failure policy: this layer neither retries nor swallows.
 */
export function createStdoutLogWriter(options: StdoutLogWriterOptions = {}): LogWriter {
  const sink = options.sink ?? resolveProcessStdout();

  return {
    write: (line) =>
      new Promise<void>((resolve, reject) => {
        sink.write(oneLine(line), (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
