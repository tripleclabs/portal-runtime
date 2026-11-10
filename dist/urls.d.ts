export interface PortalSelection {
    readonly site?: string;
    readonly version?: string;
}
export interface PortalURLOptions {
    basePath?: string;
    currentPath?: string;
    selection?: PortalSelection;
}
/** Logical site URLs independent of their deployment mount. No browser globals. */
export declare class PortalURLs {
    readonly basePath: string;
    readonly currentPath: string;
    readonly selection: PortalSelection;
    private get prefix();
    constructor(options?: PortalURLOptions);
    page(value: string): string;
    asset(value: string): string;
    /** Path is relative to /api, e.g. api('orders/123'). */
    api(value: string): string;
    action(name: string, returnTo?: string): string;
    logicalPath(value: string): string;
    unmount(value: string): string;
    resolve(value: string, preserveSelection: boolean): string;
    private strip;
}
