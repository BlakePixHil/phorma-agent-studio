/**
 * The `node:http` surface `server/index.ts` uses, declared locally.
 *
 * `cloud-aws` installs no `@types/node`, on purpose: the Check_Pipeline compiles
 * this package with `tsc --noEmit` and nothing else, and the two new guards read
 * `package.json` (exact pins, declared imports), so a platform typing package
 * would be one more thing to reason about for a package whose `core/` layer is
 * required to stay free of `node:` imports entirely.
 *
 * That leaves the one module that genuinely needs a Node runtime - the HTTP
 * listener - with no types. Every other place in the package solves this by
 * declaring the members it uses and reading the global through `globalThis`
 * (`aws/stdout-log-writer.ts`, `server/startup.ts`), but an IMPORT cannot be
 * satisfied that way: `import { createServer } from 'node:http'` needs the
 * specifier to resolve. So this file declares that one ambient module with only
 * the members `server/index.ts` touches.
 *
 * Two deliberate shapes:
 *
 * - Every method returns `void` rather than `this`. Node's real methods return
 *   `this`, which is assignable to a `void` return, and a `void` return is also
 *   what a hand-built test double naturally has - so both the real server and a
 *   fake request satisfy these declarations without a cast. `createRequestListener`
 *   is tested that way, with no port bound.
 * - Event listeners are typed loosely, because `on('data', ...)` and
 *   `on('end', ...)` carry different payloads and overloading them here would
 *   force every test double to reproduce the overload set.
 *
 * If `@types/node` is ever added to this package, delete this file in the same
 * change: two declarations of `node:http` would collide.
 *
 * Feature: aws-byo-deploy
 * Requirements: 7.1, 7.2
 */

declare module 'node:http' {
  /** One `EventEmitter` listener. Payload varies by event, so it stays loose. */
  type NodeEventListener = (...args: any[]) => void;

  /** The inbound request. Only the members the listener reads are declared. */
  export interface IncomingMessage {
    /** The request method as the wire carried it, uppercase. */
    method?: string;
    /** The request target, path and query, never absolute in practice. */
    url?: string;
    /** Lowercased header names to values. */
    headers?: Record<string, string | string[] | undefined>;
    /** `'data'` carries a `Uint8Array` chunk, `'end'` and `'error'` carry nothing. */
    on(event: string, listener: NodeEventListener): void;
    /** Abandon the request without reading the rest of it. */
    destroy(error?: Error): void;
  }

  /** The outbound response. */
  export interface ServerResponse {
    /** True once `end` has been called, so a double write can be avoided. */
    writableEnded?: boolean;
    writeHead(status: number, headers?: Record<string, string>): void;
    /** The callback fires once the response has been flushed. */
    end(chunk?: string, callback?: () => void): void;
    destroy(error?: Error): void;
  }

  export type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

  export interface Server {
    /** Bind and start accepting. The callback fires once bound. */
    listen(port: number, listener?: () => void): void;
    /** Stop accepting new connections; the callback fires when all are closed. */
    close(listener?: (error?: Error) => void): void;
    /** Close keep-alive connections that are between requests. */
    closeIdleConnections?(): void;
    /** The bound address, so a caller that listened on port 0 can learn the port. */
    address(): { port: number } | string | null;
    on(event: string, listener: NodeEventListener): void;
    once(event: string, listener: NodeEventListener): void;
    removeListener(event: string, listener: NodeEventListener): void;
  }

  export function createServer(listener: RequestListener): Server;
}
