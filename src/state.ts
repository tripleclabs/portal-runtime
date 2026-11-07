/** External-store contract extracted from Workspace's subscribe/snapshot model.
 * Values are immutable by convention; each update publishes one stable snapshot. */
export class StateStore<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  getSnapshot = (): T => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  clearSubscribers(): void {
    this.listeners.clear();
  }
  set(value: T): void {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}

/** Workspace's generation-based stale-result guard, with transport cancellation.
 * Aborting is an optimization; isCurrent remains authoritative for transports
 * that ignore AbortSignal. Reset on page/identity transitions. */
export class RequestScope {
  private pending = new Map<string, AbortController>();
  begin(key: string): {
    signal: AbortSignal;
    isCurrent: () => boolean;
    finish: () => void;
  } {
    this.pending.get(key)?.abort();
    const controller = new AbortController();
    this.pending.set(key, controller);
    return {
      signal: controller.signal,
      isCurrent: () =>
        this.pending.get(key) === controller && !controller.signal.aborted,
      finish: () => {
        if (this.pending.get(key) === controller) this.pending.delete(key);
      },
    };
  }
  cancel(key: string): void {
    this.pending.get(key)?.abort();
    this.pending.delete(key);
  }
  reset(): void {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }
}

export interface RuntimeLifecycle {
  start(): void | Promise<void>;
  dispose(): void;
}
/** Extracted from the Workspace React host's StrictMode-safe lifetime lease.
 * Also usable by a DOM host reconnecting the same runtime in one microtask. */
export class RuntimeLeases {
  private leases = new Map<RuntimeLifecycle, number>();
  acquire(runtime: RuntimeLifecycle): () => void {
    this.leases.set(runtime, (this.leases.get(runtime) ?? 0) + 1);
    void runtime.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases.set(runtime, (this.leases.get(runtime) ?? 1) - 1);
      queueMicrotask(() => {
        if (this.leases.get(runtime) === 0) {
          this.leases.delete(runtime);
          runtime.dispose();
        }
      });
    };
  }
}

/** Per-form submission lifecycle: never abort/retry a write automatically.
 * A response only belongs to the generation that initiated it. */
export class SubmissionClock {
  private generation = 0;
  next(): number {
    return ++this.generation;
  }
  isCurrent(token: number): boolean {
    return token === this.generation;
  }
}

export class FormActivity {
  readonly state = new StateStore<{ pending: boolean; error: unknown }>({
    pending: false,
    error: null,
  });
  private readonly submissions = new SubmissionClock();
  async submit<T>(
    operation: () => Promise<T>,
    apply: (result: T) => void,
  ): Promise<boolean> {
    if (this.state.getSnapshot().pending) return false;
    const generation = this.submissions.next();
    this.state.set({ pending: true, error: null });
    try {
      const result = await operation();
      if (!this.submissions.isCurrent(generation)) return false;
      apply(result);
      if (!this.submissions.isCurrent(generation)) return false;
      this.state.set({ pending: false, error: null });
      return true;
    } catch (error) {
      if (this.submissions.isCurrent(generation))
        this.state.set({ pending: false, error });
      return false;
    }
  }
  invalidate(): void {
    this.submissions.next();
    this.state.set({ pending: false, error: null });
  }
}
