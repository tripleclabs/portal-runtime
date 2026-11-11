/** External-store contract extracted from Workspace's subscribe/snapshot model.
 * Values are immutable by convention; each update publishes one stable snapshot. */
export declare class StateStore<T> {
    private value;
    private listeners;
    constructor(value: T);
    getSnapshot: () => T;
    subscribe: (listener: () => void) => (() => void);
    clearSubscribers(): void;
    set(value: T): void;
}
/** Workspace's generation-based stale-result guard, with transport cancellation.
 * Aborting is an optimization; isCurrent remains authoritative for transports
 * that ignore AbortSignal. Reset on page/identity transitions. */
export declare class RequestScope {
    private pending;
    begin(key: string): {
        signal: AbortSignal;
        isCurrent: () => boolean;
        finish: () => void;
    };
    cancel(key: string): void;
    /** Cancel every pending request whose key starts with `prefix`; returns their keys. */
    cancelPrefix(prefix: string): string[];
    reset(): void;
}
export interface RuntimeLifecycle {
    start(): void | Promise<void>;
    dispose(): void;
}
/** Extracted from the Workspace React host's StrictMode-safe lifetime lease.
 * Also usable by a DOM host reconnecting the same runtime in one microtask. */
export declare class RuntimeLeases {
    private leases;
    acquire(runtime: RuntimeLifecycle): () => void;
}
/** Per-form submission lifecycle: never abort/retry a write automatically.
 * A response only belongs to the generation that initiated it. */
export declare class SubmissionClock {
    private generation;
    next(): number;
    isCurrent(token: number): boolean;
}
export declare class FormActivity {
    readonly state: StateStore<{
        pending: boolean;
        error: unknown;
    }>;
    private readonly submissions;
    submit<T>(operation: () => Promise<T>, apply: (result: T) => void): Promise<boolean>;
    invalidate(): void;
}
