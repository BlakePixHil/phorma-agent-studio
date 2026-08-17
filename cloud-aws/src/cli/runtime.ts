/**
 * The production `CliContext`: Node for process access, the AWS SDK for signing
 * and describing.
 *
 * Two rules hold throughout this file.
 *
 * 1. NOTHING resolves at module load. Every AWS client is imported inside the
 *    call that needs it, exactly as `infra/preflight.ts` does, so `cli/main.ts`
 *    can be imported (and Property 24 can run) without loading a single SDK
 *    package, and a verb pays only for the clients it actually uses.
 * 2. Credentials come from `fromNodeProviderChain()` and from nowhere else
 *    (Req 6.5). No verb reads a credential from argv, and no verb reads a
 *    credential-bearing environment variable by name - the provider chain owns
 *    that lookup, so the ambient profile or SSO session is the only source.
 *
 * `process` is reached through `globalThis` behind a narrow local interface, the
 * pattern `aws/stdout-log-writer.ts` and `server/startup.ts` already use. The
 * five `node:` modules this file imports are declared in `cli/node-runtime.d.ts`.
 *
 * Feature: aws-byo-deploy
 * Requirements: 5.3, 6.5, 9.4, 10.3, 11.2
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAwsDescribeBackend } from '../infra/preflight.js';
import type { DockerProbe } from '../infra/preflight.js';
import type {
  AwsIdentityProbe,
  AwsSigner,
  AwsStackOutputsReader,
  CliCommands,
  CliContext,
  CliFiles,
  CliIo,
  PresignRequest,
  SignedHttpRequest,
  SignedHttpResponse,
} from './ports.js';

// ---------------------------------------------------------------------------
// process access
// ---------------------------------------------------------------------------

interface WritableStreamLike {
  write(chunk: string): boolean;
}

interface ReadableStreamLike {
  on(event: string, listener: (chunk: unknown) => void): void;
  setEncoding?(encoding: string): void;
  readableEnded?: boolean;
  isTTY?: boolean;
}

interface ProcessLike {
  stdout?: WritableStreamLike;
  stderr?: WritableStreamLike;
  stdin?: ReadableStreamLike;
  platform?: string;
  env?: Record<string, string | undefined>;
}

function currentProcess(): ProcessLike | undefined {
  return (globalThis as { process?: ProcessLike }).process;
}

function requireStream(stream: WritableStreamLike | undefined, name: string): WritableStreamLike {
  if (!stream || typeof stream.write !== 'function') {
    throw new Error(
      `The phorma-aws CLI needs process.${name}, and this runtime exposes none. ` +
        'Pass a CliContext explicitly when running outside Node.',
    );
  }
  return stream;
}

// ---------------------------------------------------------------------------
// The package root
// ---------------------------------------------------------------------------

/**
 * The `cloud-aws` package directory, derived from this module's own location
 * rather than from the working directory.
 *
 * The Studio spawns the CLI with `cwd` set to the operator's configured
 * `cloudAwsDirectory`, but an operator running the verb by hand may be anywhere.
 * Resolving from `import.meta.url` means the config file, the CDK entry point and
 * the `cdk` steps all address the same package either way.
 */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function createIo(): CliIo {
  const proc = currentProcess();
  const stdout = requireStream(proc?.stdout, 'stdout');
  const stderr = requireStream(proc?.stderr, 'stderr');

  return {
    out: (text) => void stdout.write(text),
    err: (text) => void stderr.write(text),
    readStdin: () => readStdin(proc?.stdin),
  };
}

/**
 * Read stdin to end.
 *
 * Resolves with `''` for a TTY or an already-ended stream, so `phorma-aws request`
 * typed at a prompt reports its HTTP result instead of blocking forever on a body
 * nobody is going to send. The Studio always attaches a pipe (`stdin_data`, Req
 * 10.2), which ends immediately when the body is empty.
 */
function readStdin(stdin: ReadableStreamLike | undefined): Promise<string> {
  if (!stdin || typeof stdin.on !== 'function' || stdin.isTTY === true) {
    return Promise.resolve('');
  }
  return new Promise<string>((resolveText, reject) => {
    const chunks: string[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolveText(chunks.join(''));
    };
    stdin.setEncoding?.('utf-8');
    stdin.on('data', (chunk) => chunks.push(String(chunk)));
    stdin.on('end', finish);
    stdin.on('close', finish);
    stdin.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    if (stdin.readableEnded === true) finish();
  });
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

function createFiles(): CliFiles {
  return {
    readText: (path) => {
      try {
        return readFileSync(path, 'utf-8');
      } catch {
        return undefined;
      }
    },
    exists: (path) => existsSync(path),
    makeTempDir: () => mkdtempSync(join(tmpdir(), 'phorma-aws-')),
  };
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

/** Windows needs a shell to run the `npx.cmd` shim. */
function needsShell(): boolean {
  return currentProcess()?.platform === 'win32';
}

function createCommands(io: CliIo): CliCommands {
  return {
    run: (program, args, cwd) =>
      new Promise<number>((resolveCode) => {
        let child;
        try {
          child = spawn(program, args, {
            cwd,
            // stdin inherited: `cdk` prompts nothing (`--require-approval never`)
            // but a hung child is easier to diagnose than a silently closed pipe.
            stdio: ['inherit', 'pipe', 'pipe'],
            shell: needsShell(),
            env: currentProcess()?.env,
          });
        } catch (err) {
          io.err(`Failed to start ${program}: ${String(err)}\n`);
          resolveCode(1);
          return;
        }
        child.stdout?.on('data', (chunk) => io.out(chunk.toString()));
        child.stderr?.on('data', (chunk) => io.err(chunk.toString()));
        child.on('error', (err: unknown) => {
          io.err(`Failed to start ${program}: ${String(err)}\n`);
          resolveCode(1);
        });
        child.on('close', (code: number | null) => resolveCode(code ?? 1));
      }),
  };
}

/**
 * The Docker daemon probe (Req 4.5).
 *
 * `docker version` rather than `docker info`: it is the cheaper call that still
 * requires the daemon to answer, so a stopped daemon fails it while a present CLI
 * with no daemon does not pass it. All three stdio slots are ignored, because this
 * is a check whose only output is its exit code.
 */
function createDockerProbe(): DockerProbe {
  return {
    available: () =>
      new Promise<boolean>((resolveAvailable) => {
        let child;
        try {
          child = spawn('docker', ['version', '--format', '{{.Server.Version}}'], {
            stdio: ['ignore', 'ignore', 'ignore'],
            shell: needsShell(),
            env: currentProcess()?.env,
          });
        } catch {
          resolveAvailable(false);
          return;
        }
        child.on('error', () => resolveAvailable(false));
        child.on('close', (code: number | null) => resolveAvailable(code === 0));
      }),
  };
}

// ---------------------------------------------------------------------------
// SigV4
// ---------------------------------------------------------------------------

/** The service every signed call in this package targets. */
const EXECUTE_API = 'execute-api';

/**
 * Build the signer. Every SDK package loads inside the call, so constructing this
 * costs nothing.
 */
function createSigner(): AwsSigner {
  async function signatureV4(region: string) {
    const { SignatureV4 } = await import('@smithy/signature-v4');
    const { Sha256 } = await import('@aws-crypto/sha256-js');
    const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
    return new SignatureV4({
      service: EXECUTE_API,
      region,
      // The ONLY credential source in the package (Req 6.5).
      credentials: fromNodeProviderChain(),
      sha256: Sha256,
    });
  }

  return {
    async send(request: SignedHttpRequest): Promise<SignedHttpResponse> {
      const { HttpRequest } = await import('@smithy/protocol-http');
      const { parseUrl } = await import('@smithy/url-parser');

      const parsed = parseUrl(request.url);
      const headers: Record<string, string> = { host: parsed.hostname };
      if (request.body !== undefined) headers['content-type'] = 'application/json';

      const signer = await signatureV4(request.region);
      const signed = await signer.sign(
        new HttpRequest({
          ...parsed,
          method: request.method,
          headers,
          body: request.body,
        }),
      );

      const response = await fetch(request.url, {
        method: request.method,
        headers: signed.headers as Record<string, string>,
        body: request.body,
      });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      return { status: response.status, headers: responseHeaders, body: await response.text() };
    },

    async presign(request: PresignRequest): Promise<string> {
      const { HttpRequest } = await import('@smithy/protocol-http');
      // `formatUrl` lives here, NOT in `@smithy/url-parser`, which exports no such
      // member - the reason the previous shim's monitor-url verb never ran.
      const { formatUrl } = await import('@aws-sdk/util-format-url');

      const target = new URL(request.url);
      const signer = await signatureV4(request.region);
      const presigned = await signer.presign(
        new HttpRequest({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port === '' ? undefined : Number(target.port),
          path: target.pathname,
          query: { ...request.query },
          headers: { host: target.host },
          method: 'GET',
        }),
        { expiresIn: request.expiresInSec },
      );
      return formatUrl(presigned);
    },
  };
}

// ---------------------------------------------------------------------------
// STS and CloudFormation
// ---------------------------------------------------------------------------

function createIdentityProbe(): AwsIdentityProbe {
  return {
    async callerIdentity(region) {
      const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
      const client = new STSClient({ region });
      const identity = await client.send(new GetCallerIdentityCommand({}));
      return { account: identity.Account, arn: identity.Arn };
    },
  };
}

function createStackOutputsReader(): AwsStackOutputsReader {
  return {
    async describe(region, stackName) {
      const { CloudFormationClient, DescribeStacksCommand } = await import(
        '@aws-sdk/client-cloudformation'
      );
      const client = new CloudFormationClient({ region });
      try {
        const res = await client.send(new DescribeStacksCommand({ StackName: stackName }));
        const stack = res.Stacks?.[0];
        if (!stack) return undefined;
        const outputs: Record<string, string> = {};
        for (const output of stack.Outputs ?? []) {
          if (output.OutputKey && output.OutputValue !== undefined) {
            outputs[output.OutputKey] = output.OutputValue;
          }
        }
        return outputs;
      } catch (err) {
        // A stack that was never deployed is an operator-facing fact, so it
        // reports as "no outputs" rather than as an exception. Everything else -
        // an expired session above all - propagates so the verb can map it to
        // exit 4.
        if (isStackNotFound(err)) return undefined;
        throw err;
      }
    },
  };
}

/**
 * CloudFormation reports an absent stack as `ValidationError` with a message
 * naming it, so both halves are checked: the name alone also covers malformed
 * requests, which must not read as "not deployed yet".
 */
function isStackNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  const message = (err as { message?: unknown }).message;
  return (
    name === 'ValidationError' &&
    typeof message === 'string' &&
    message.includes('does not exist')
  );
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Compose the production context. Called once per process, by `cli/main.ts`, and
 * only when a verb is actually going to run.
 */
export function createCliContext(): CliContext {
  const io = createIo();
  return {
    root: packageRoot(),
    io,
    files: createFiles(),
    commands: createCommands(io),
    dockerProbe: createDockerProbe(),
    describeBackend: createAwsDescribeBackend(),
    signer: createSigner(),
    identity: createIdentityProbe(),
    stackOutputs: createStackOutputsReader(),
  };
}
