import { StateStore } from "./state.js";
export interface PortalRuntimeOptions {
    window: Window;
    fetch?: typeof fetch;
    /** Host owns localized unsaved-change UI. False leaves the current document. */
    beforeNavigate?: () => boolean | Promise<boolean>;
    hardNavigate?: (url: string) => void;
}
type Position = {
    x: number;
    y: number;
};
/** Enhances ordinary SSR HTML. It never evaluates template expressions or Lua. */
export declare class PortalRuntime {
    private readonly options;
    readonly state: StateStore<{
        navigating: boolean;
        error: unknown;
    }>;
    private readonly requests;
    private readonly forms;
    private readonly formLocks;
    private readonly timers;
    private readonly win;
    private readonly doc;
    private readonly fetcher;
    private readonly hard;
    private readonly serverShell;
    private readonly serverStructure;
    private epoch;
    private navigationAttempt;
    private historyIndex;
    private restoringHistory;
    private pageURL;
    private started;
    private disposed;
    private transitioning;
    private context;
    private version;
    private oldScrollRestoration;
    constructor(options: PortalRuntimeOptions);
    start(): void;
    dispose(): void;
    /** Host calls before an identity switch; no previous response can then apply. */
    invalidate(): void;
    private savePosition;
    private pop;
    private click;
    private internal;
    navigate(href: string, mode?: "push" | "pop" | "replace", position?: Position, targetIndex?: number): Promise<void>;
    private rejectNavigation;
    private compatible;
    private parse;
    /** Compare incoming server layout with the original server layout, not live
     * DOM: client-owned edits in a compatible persistent shell must survive. */
    private shell;
    private structure;
    private pageCompatible;
    private replacePage;
    private restoreFocusAndScroll;
    private submit;
    private input;
    refreshRegion(name: string, href: string): Promise<void>;
    private region;
    private replaceRegion;
    private postForm;
    private lockForm;
    private unlockForm;
    private failure;
}
export {};
