/** Trusted DOM controllers. Configuration is data, never JavaScript expressions. */
export declare class PortalBehaviors {
    private readonly doc;
    private started;
    private readonly initialized;
    /** Per initialised scope, the server markup it was initialised from. A
     * morph leaves a scope alone while the server still renders that markup. */
    private readonly markup;
    /** Server markup for a scope a morph patched, used when it initialises again. */
    private readonly pending;
    private readonly openers;
    private readonly copied;
    private readonly announcing;
    constructor(doc: Document);
    start(): void;
    dispose(): void;
    reset(): void;
    /** The server markup an initialised scope came from, if it is initialised. */
    serverMarkup(scope: Element): string | undefined;
    /** A morph is about to patch this scope to new server markup: initialise it
     * again on the next refresh. Its open dialog and opener stay as they are. */
    forget(scope: HTMLElement, markup: string): void;
    /** A morph removed this subtree: tear down the behaviours inside it. */
    teardown(root: Node): void;
    private owned;
    refresh(): void;
    private panelID;
    private select;
    private click;
    private copy;
    private uncopy;
    private keydown;
    private closed;
}
