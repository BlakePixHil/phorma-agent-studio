/**
 * Minimal zero-dependency Chrome DevTools Protocol driver.
 *
 * Playwright is not a dependency of this repo, and Node 24 ships a global
 * `WebSocket`, so a browser check needs nothing installed. Launches headless
 * Chrome, opens a url, and runs each `--eval` snippet in page context in order,
 * printing the JSON result of each.
 *
 * Usage:
 *   node scripts/cdp.mjs <url> <file-with-snippets.mjs>
 *
 * The snippet file default-exports an array of `async (evaluate) => any` steps,
 * where `evaluate(fnSource)` runs a page-context expression and resolves its
 * value (awaited if it is a promise).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

const [url, snippetPath] = process.argv.slice(2);
if (!url || !snippetPath) {
  console.error('usage: node scripts/cdp.mjs <url> <snippets.mjs>');
  process.exit(2);
}

const port = 9222 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'phorma-cdp-'));
const binary = CHROME_CANDIDATES.find(path => existsSync(path));
if (!binary) {
  console.error('No Chrome/Edge binary found.');
  process.exit(2);
}

const chrome = spawn(binary, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1600,1000',
  'about:blank',
]);
chrome.on('error', error => {
  console.error('Chrome failed to start:', error.message);
  process.exit(2);
});

/** Waits for the DevTools endpoint to answer. */
async function debuggerUrl() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const body = await response.json();
      if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('DevTools endpoint never came up.');
}

const socket = new WebSocket(await debuggerUrl());
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  const settle = pending.get(message.id);
  if (!settle) return;
  pending.delete(message.id);
  if (message.error) settle.reject(new Error(message.error.message));
  else settle.resolve(message.result);
});

function send(method, params = {}, sessionId) {
  const id = (nextId += 1);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const { targetInfos } = await send('Target.getTargets');
const pageTarget = targetInfos.find(target => target.type === 'page');
const { sessionId } = await send('Target.attachToTarget', {
  targetId: pageTarget.targetId,
  flatten: true,
});

await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Page.navigate', { url }, sessionId);

/** Runs an expression in page context, awaiting a promise result. */
async function evaluate(expression) {
  const result = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'page error',
    );
  }
  return result.result.value;
}

let failed = false;
try {
  const { default: steps } = await import(`file://${join(process.cwd(), snippetPath)}`);
  for (const step of steps) {
    const value = await step(evaluate);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
} catch (error) {
  failed = true;
  console.error('FAILED:', error.message);
} finally {
  socket.close();
  chrome.kill();
  // Chrome may still hold the profile directory briefly; losing a temp folder
  // must never mask the result of the run.
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(failed ? 1 : 0);
