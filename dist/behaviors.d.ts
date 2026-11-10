/** Trusted DOM controllers. Configuration is data, never JavaScript expressions. */
export declare class PortalBehaviors {
    private readonly doc;
    private started;
    private readonly initialized;
    private readonly openers;
    private readonly copied;
    private readonly announcing;
    constructor(doc: Document);
    start(): void;
    dispose(): void;
    reset(): void;
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
