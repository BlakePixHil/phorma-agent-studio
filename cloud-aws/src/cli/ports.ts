/**
 * The seams the six verbs run against.
 *
 * Every effect a verb performs - writing a line, reading stdin, spawning `cdk`,
 * probing Docker, describing a VPC, signing an HTTP call, presigning a socket
 * URL, reading stack outputs - arrives through one of these ports. Nothing in
 * `cli/plan.ts`, `cli/deploy.ts`, `cli/request.ts`, `cli/monitor-url.ts`,
 * `cli/doctor.ts` or `cli/outputs.ts` touches `process`, the filesystem or an AWS
 * client directly.
 *
 * Two reasons, both load-bearing:
 *
 * - Property 24 asserts that an under-supplied verb performs NO AWS call. With
 *   the SDK behind a port, that is an assertion about an unused port rather than
 *   a network expectation, so it runs in the credential-free Check_Pipeline.
 * - The real implementations (`cli/runtime.ts`) import the AWS SDK dynamically
 *   inside each call, exactly as `infra/preflight.ts` does, so importing
 *   `cli/main.ts` loads no client and a verb pays only for what it uses.
 *
 * Feature: aws-byo-deploy
 * Requirements: 5.1, 6.4, 6.5, 10.3, 11.2
 */

import type { DockerProbe, PreflightDescribeBackend } from '../infra/preflight.js';

// ---------------------------------------------------------------------------
// Process I/O
// ---------------------------------------------------------------------------

/**
 * The three stream operations a verb needs. `out` and `err` write VERBATIM: the
 * caller supplies its own newline, because a Sentinel_Envelope line and a
 * streamed `cdk` chunk have different framing rules and this port must not
 * impose one on the other.
 */
export interface CliIo {
  /** Write to stdout. Sentinel_Envelope lines and operator progress both go here. */
  out(text: string): void;
  /** Write to stderr. Usage lines, failure lines and streamed `cdk` stderr. */
  err(text: string): void;
  /**
   * Read stdin to end as UTF-8 text. Resolves with `''` when stdin is closed or
   * carries nothing, so a verb never hangs waiting for a pipe that was never
   * attached.
   */
  readStdin(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/**
 * The filesystem reads the verbs perform. Deliberately read-mostly: the only
 * write is the temporary directory that receives `cdk deploy --outputs-file`.
 */
export interface CliFiles {
  /** File text, or `undefined` when the path is absent or unreadable. */
  readText(path: string): string | undefined;
  /** Whether the path exists. */
  exists(path: string): boolean;
  /** A fresh empty directory under the platform temporary directory. */
  makeTempDir(): string;
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

/**
 * The `cdk` step. Output streams through `CliIo` as it arrives rather than being
 * buffered, so the Studio's deploy console fills in while the deploy runs.
 */
export interface CliCommands {
  /** Run to completion and resolve with the exit code (1 when the spawn failed). */
  run(program: string, args: readonly string[], cwd: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------

/** One SigV4-signed HTTP call. */
export interface SignedHttpRequest {
  url: string;
  /** Uppercase HTTP method as the operator supplied it. */
  method: string;
  /** Absent for a body-less method. */
  body?: string;
  /** Signing region - always the configured region, never a value from argv. */
  region: string;
}

/** What the caller needs to tell a 409 from a broken pipe (Req 10.4). */
export interface SignedHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A presign of the Monitor_API `$connect` request (Req 11.2). */
export interface PresignRequest {
  /** The `wss://` Monitor_API URL, stage path included. */
  url: string;
  region: string;
  /** Query members to include in the SIGNED query string, `workflowId` among them. */
  query: Record<string, string>;
  /** Presign validity in seconds. Always 300 for `monitor-url`. */
  expiresInSec: number;
}

/**
 * SigV4 for `execute-api`, credentials from the Node provider chain and nothing
 * else (Req 6.5, 10.3).
 */
export interface AwsSigner {
  send(request: SignedHttpRequest): Promise<SignedHttpResponse>;
  presign(request: PresignRequest): Promise<string>;
}

/** `sts:GetCallerIdentity`, the `doctor` session check (Req 5.6). */
export interface AwsIdentityProbe {
  callerIdentity(region: string): Promise<{ account?: string; arn?: string }>;
}

/**
 * `cloudformation:DescribeStacks`, the `outputs` verb's source (Req 9.4).
 * Resolves with the stack's outputs by name, or `undefined` when the stack does
 * not exist - an absent stack is an operator-facing fact, not an exception.
 */
export interface AwsStackOutputsReader {
  describe(region: string, stackName: string): Promise<Record<string, string> | undefined>;
}

// ---------------------------------------------------------------------------
// The context
// ---------------------------------------------------------------------------

/**
 * Everything a verb may reach. `root` is the `cloud-aws` package directory: the
 * `cdk` steps run there, and the config file and CDK entry point are resolved
 * against it, so a verb behaves the same whatever the caller's working directory.
 */
export interface CliContext {
  root: string;
  io: CliIo;
  files: CliFiles;
  commands: CliCommands;
  dockerProbe: DockerProbe;
  describeBackend: PreflightDescribeBackend;
  signer: AwsSigner;
  identity: AwsIdentityProbe;
  stackOutputs: AwsStackOutputsReader;
}
