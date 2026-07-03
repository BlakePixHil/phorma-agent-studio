import { effect, Injectable, computed, signal } from '@angular/core';
import { loadLayout, saveLayout } from './layout-storage';

/**
 * Console channels for Agent Studio runs:
 * - `run`      — run lifecycle: starts, handoffs, pauses, completions.
 * - `agents`   — streaming agent output (tokens, messages).
 * - `tools`    — tool calls and their results.
 * - `problems` — errors and failures.
 */
export type TerminalChannelId = 'run' | 'agents' | 'tools' | 'problems';

export type TerminalEntryLevel = 'info' | 'success' | 'warning' | 'error';

/** Lifecycle of the active run, mirrored in the status bar + run controls. */
export type RunPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'paused'
  | 'waiting-approval'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface TerminalChannel {
  id: TerminalChannelId;
  label: string;
  icon: string;
}

export interface TerminalEntry {
  id: number;
  channel: TerminalChannelId;
  level: TerminalEntryLevel;
  message: string;
  timestamp: string;
}

// Matches ANSI escape sequences (CSI/SGR colors, cursor moves, OSC, etc.) so
// raw process output renders as clean text instead of artifacts like `[33m`.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsiCodes(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

const TERMINAL_CHANNELS: TerminalChannel[] = [
  { id: 'run', label: 'Run', icon: 'ti ti-player-play' },
  { id: 'agents', label: 'Agents', icon: 'ti ti-robot' },
  { id: 'tools', label: 'Tools', icon: 'ti ti-tool' },
  { id: 'problems', label: 'Problems', icon: 'ti ti-alert-triangle' },
];

// A long run streams tokens continuously. Each entry is rendered to the DOM,
// so we cap the retained buffer to keep memory and rendering bounded. Older
// lines are dropped first.
const MAX_TERMINAL_ENTRIES = 2000;

/**
 * The bottom console dock: run traces, streaming agent output, tool I/O, and
 * problems. Shell infrastructure inherited from Phorma Code's terminal —
 * Phase 3 feeds it RunEvents from the engine.
 */
@Injectable({ providedIn: 'root' })
export class TerminalOutputService {
  private nextEntryId = 1;
  private readonly entriesState = signal<TerminalEntry[]>([]);
  private readonly activeChannelState = signal<TerminalChannelId>('run');
  private readonly collapsedState = signal(loadLayout('terminalCollapsed', true));
  private readonly heightState = signal(loadLayout('terminalHeight', 260));
  private readonly phaseState = signal<RunPhase>('idle');

  readonly channels = signal(TERMINAL_CHANNELS).asReadonly();
  readonly entries = this.entriesState.asReadonly();
  readonly activeChannel = this.activeChannelState.asReadonly();
  readonly collapsed = this.collapsedState.asReadonly();
  readonly height = this.heightState.asReadonly();
  readonly phase = this.phaseState.asReadonly();
  readonly activeEntries = computed(() =>
    this.entriesState().filter(entry => entry.channel === this.activeChannelState()),
  );
  readonly errorCount = computed(
    () => this.entriesState().filter(entry => entry.channel === 'problems').length,
  );

  constructor() {
    // Persist console dock state so it survives app restarts.
    effect(() => saveLayout('terminalCollapsed', this.collapsedState()));
    effect(() => saveLayout('terminalHeight', this.heightState()));
  }

  setActiveChannel(channel: TerminalChannelId): void {
    this.activeChannelState.set(channel);
  }

  setHeight(height: number): void {
    this.heightState.set(height);
  }

  setPhase(phase: RunPhase): void {
    this.phaseState.set(phase);
  }

  open(channel?: TerminalChannelId): void {
    if (channel) this.activeChannelState.set(channel);
    this.collapsedState.set(false);
  }

  close(): void {
    this.collapsedState.set(true);
  }

  toggle(): void {
    this.collapsedState.update(collapsed => !collapsed);
  }

  clear(channel: TerminalChannelId = this.activeChannelState()): void {
    this.entriesState.update(entries => entries.filter(entry => entry.channel !== channel));
  }

  clearAll(): void {
    this.entriesState.set([]);
  }

  append(channel: TerminalChannelId, level: TerminalEntryLevel, message: string): void {
    const trimmed = stripAnsiCodes(message).trimEnd();
    if (trimmed.length === 0) return;

    this.entriesState.update(entries => {
      const next = [
        ...entries,
        {
          id: this.nextEntryId++,
          channel,
          level,
          message: trimmed,
          timestamp: new Date().toISOString(),
        },
      ];
      return next.length > MAX_TERMINAL_ENTRIES
        ? next.slice(next.length - MAX_TERMINAL_ENTRIES)
        : next;
    });
  }
}
