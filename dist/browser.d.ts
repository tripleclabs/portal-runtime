import { StateStore } from "./state.js";
import { PortalURLs } from "./urls.js";
export type RegionHistory = "none" | "replace" | "advance";
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
    private readonly routing;
    private readonly behaviors;
    private readonly composing;
    /** Per instance: the pending debounce and the in-flight live change. */
    private readonly changes;
    private historyRequest;
    private awaitingNavigation;
    /** URL helpers follow the current logical page after enhanced navigation. */
    get urls(): PortalURLs;
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
    private endpoint;
    private selectPage;
    private internal;
    navigate(href: string, mode?: "push" | "pop" | "replace", position?: Position, targetIndex?: number): Promise<void>;
    private rejectNavigation;
    private compatible;
    private parse;
    /** Compare incoming server layout with the original server layout, not live
     * DOM: client-owned edits in a compatible persistent shell must survive. */
    private shell;
    private structure;
    private routingCompatible;
    private pageCompatible;
    /** The host inlines only the icon mask rules a response uses, one per line,
     * in style[data-portal-icons] (a page's head, or beside a region's root).
     * Merge them into the live page so swapped-in content keeps its icons. */
    private adoptIcons;
    /** Likewise for the CSS of the components a response renders
     * (style[data-portal-components], one component per line). */
    adoptComponentStyles(source: Document): void;
    private adoptRules;
    private replacePage;
    private restoreFocusAndScroll;
    private submit;
    private historyPolicy;
    private compositionStart;
    private compositionEnd;
    /** The instance a component event form belongs to: its hidden instance form,
     * or an author's t:submit form inside the instance. */
    private eventInstance;
    private instanceRoot;
    /** t:change: debounce, then post the instance form for its live parts only.
     * A newer change aborts the request in flight, so a slow response never
     * overwrites a newer one. */
    private scheduleChange;
    private postChange;
    /** A complete document rather than a region fragment. */
    private isWholePage;
    /** Swap an instance's live parts, never one holding the focused control. */
    private replaceLiveParts;
    /** A response's instance forms carry fresh tokens: replace or add them. */
    private adoptInstanceForms;
    private input;
    refreshRegion(name: string, href: string, history?: RegionHistory): Promise<void>;
    private region;
    private replaceRegion;
    private postForm;
    private lockForm;
    private unlockForm;
    private feedback;
    private failure;
}
export {};
