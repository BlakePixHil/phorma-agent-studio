/**
 * Unit tests for the production `LogWriter`.
 *
 * Feature: aws-byo-deploy
 * Requirements: 8.1, 8.2
 */

import { describe, expect, it } from 'vitest';

import { createStdoutLogWriter, type LogSink } from './stdout-log-writer.js';

/** A sink that records chunks and honours the completion callback. */
class RecordingSink implements LogSink {
  chunks: string[] = [];
  error: Error | undefined;
  /** When true, the callback fires on a later turn, as a buffering pipe does. */
  deferred = false;

  write(chunk: string, callback: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    const settle = () => callback(this.error ?? null);
    if (this.deferred) queueMicrotask(settle);
    else settle();
    return !this.deferred;
  }
}

describe('createStdoutLogWriter', () => {
  it('writes the line with exactly one trailing newline', async () => {
    const sink = new RecordingSink();
    const writer = createStdoutLogWriter({ sink });

    await writer.write('{"level":"info"}');

    expect(sink.chunks).toEqual(['{"level":"info"}\n']);
  });

  it('does not double the separator when the line already ends in a newline', async () => {
    const sink = new RecordingSink();
    const writer = createStdoutLogWriter({ sink });

    await writer.write('{"a":1}\n');
    await writer.write('{"b":2}\r\n');

    expect(sink.chunks).toEqual(['{"a":1}\n', '{"b":2}\n']);
    expect(sink.chunks.join('')).not.toContain('\n\n');
  });

  it('writes one chunk per entry, in call order', async () => {
    const sink = new RecordingSink();
    const writer = createStdoutLogWriter({ sink });

    await writer.write('first');
    await writer.write('second');
    await writer.write('third');

    expect(sink.chunks).toEqual(['first\n', 'second\n', 'third\n']);
  });

  it('resolves only once the stream reports the chunk accepted', async () => {
    const sink = new RecordingSink();
    sink.deferred = true;
    const writer = createStdoutLogWriter({ sink });

    let settled = false;
    const pending = writer.write('buffered').then(() => {
      settled = true;
    });

    expect(settled).toBe(false);
    await pending;
    expect(settled).toBe(true);
  });

  it('rejects when the stream reports an error', async () => {
    const sink = new RecordingSink();
    sink.error = new Error('EPIPE');
    const writer = createStdoutLogWriter({ sink });

    await expect(writer.write('lost')).rejects.toThrow('EPIPE');
  });

  it('resolves process.stdout when no sink is injected', () => {
    const writer = createStdoutLogWriter();

    expect(typeof writer.write).toBe('function');
  });
});
