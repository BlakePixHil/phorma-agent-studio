/**
 * RunGate — the scheduler gate that gives Phorma its debugger semantics.
 *
 * The engine awaits `checkpoint(nodeId)` immediately before executing every
 * node. The gate decides whether execution flows, pauses (user pressed Pause
 * or hit a breakpoint), steps (exactly one node through, then re-pause), or
 * aborts (Stop). Because EVERY node passes through the same gate, pause and
 * step behave correctly even across parallel branches.
 */

/** Thrown through the run when the user presses Stop. */
export class RunStoppedError extends Error {
  constructor() {
    super('Run stopped by user.');
    this.name = 'RunStoppedError';
  }
}

export class RunGate {
  private state: 'running' | 'paused' | 'stopped' = 'running';
  /** Nodes allowed through while paused (Step grants exactly one). */
  private stepBudget = 0;
  private waiters: (() => void)[] = [];

  /** Node ids that force a pause when reached. */
  readonly breakpoints = new Set<string>();

  /** Called when the gate transitions between running/paused (for events). */
  onPauseChange?: (paused: boolean, nodeId?: string) => void;

  get paused(): boolean {
    return this.state === 'paused';
  }

  get stopped(): boolean {
    return this.state === 'stopped';
  }

  /**
   * Blocks until this node may execute. Throws {@link RunStoppedError} when
   * the run has been stopped.
   */
  async checkpoint(nodeId: string): Promise<void> {
    if (this.state === 'stopped') throw new RunStoppedError();

    // Hitting a breakpoint while running pauses BEFORE the node executes.
    if (this.state === 'running' && this.breakpoints.has(nodeId)) {
      this.state = 'paused';
      this.onPauseChange?.(true, nodeId);
    }

    while (this.state === 'paused') {
      if (this.stepBudget > 0) {
        this.stepBudget -= 1;
        return; // stepped through — gate stays paused for the next node
      }
      await new Promise<void>(resolve => this.waiters.push(resolve));
      if ((this.state as string) === 'stopped') throw new RunStoppedError();
    }

    if ((this.state as string) === 'stopped') throw new RunStoppedError();
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.onPauseChange?.(true);
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.stepBudget = 0;
    this.onPauseChange?.(false);
    this.wakeAll();
  }

  /** While paused: lets exactly one node execute, then re-pauses. */
  step(): void {
    if (this.state !== 'paused') return;
    this.stepBudget += 1;
    this.wakeAll();
  }

  stop(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.wakeAll();
  }

  /**
   * Sleeps for `ms`, waking immediately (and throwing {@link RunStoppedError})
   * if the run is stopped mid-sleep. Used for retry backoff and timeout
   * waits so Stop always unwinds promptly instead of waiting out a timer.
   */
  async sleep(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (!this.stopped) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise<void>(resolve => {
        const wake = (): void => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve();
        }, remaining);
        this.waiters.push(wake);
      });
    }
    throw new RunStoppedError();
  }

  private wakeAll(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}
