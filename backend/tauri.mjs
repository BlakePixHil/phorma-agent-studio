#!/usr/bin/env node
/**
 * Tauri launcher — ensures ~/.cargo/bin is on PATH before invoking the CLI.
 *
 * npm on Windows spawns via cmd.exe, which may not inherit the full PATH
 * that PowerShell has. This wrapper prepends the Cargo bin directory so
 * that `tauri dev` / `tauri build` can find the Rust toolchain reliably.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cargoBin = join(homedir(), '.cargo', 'bin');

// Prepend cargo bin to PATH so `cargo` is resolvable.
const sep = process.platform === 'win32' ? ';' : ':';
if (!env.PATH?.includes(cargoBin)) {
  env.PATH = cargoBin + sep + env.PATH;
}

// On Windows, npm puts .cmd wrappers in node_modules/.bin.
const cmd = process.platform === 'win32' ? 'tauri.cmd' : 'tauri';
const bin = join(__dirname, 'node_modules', '.bin', cmd);

if (!existsSync(bin)) {
  console.error(
    `Tauri CLI not found at ${bin}.\n` +
      'Run "npm install" in the backend/ folder first (it installs @tauri-apps/cli).',
  );
  process.exit(1);
}

const child = spawn(bin, argv.slice(2), {
  cwd: __dirname,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env,
});

child.on('exit', (code) => process.exit(code ?? 0));