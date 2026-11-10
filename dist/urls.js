const unsafe = (value) => /[\\\x00-\x1f\x7f]/.test(value);
const parts = (value) => {
    const hash = value.indexOf("#");
    const head = hash < 0 ? value : value.slice(0, hash);
    const mark = head.indexOf("?");
    return { path: mark < 0 ? head : head.slice(0, mark), query: mark < 0 ? undefined : head.slice(mark + 1), fragment: hash < 0 ? undefined : value.slice(hash + 1) };
};
function path(value, current) {
    if (unsafe(value) || value.includes("//"))
        throw new Error("Ambiguous Portal path");
    const currentParts = current.split("/").filter(Boolean);
    const output = value.startsWith("/") ? [] : current.endsWith("/") ? currentParts : currentParts.slice(0, -1);
    for (const segment of value.split("/").filter(Boolean)) {
        const decoded = decodeURIComponent(segment);
        if (unsafe(decoded) || decoded.includes("/") || decoded.includes("%") || (segment !== decoded && [".", ".."].includes(decoded)))
            throw new Error("Ambiguous encoded Portal path");
        if (segment === ".")
            continue;
        if (segment === "..") {
            if (!output.length)
                throw new Error("Portal URL escapes its mount");
            output.pop();
        }
        else {
            output.push(encodeURI(segment).replace(/%25([0-9a-f]{2})/gi, "%$1"));
        }
    }
    const result = "/" + output.join("/");
    return result + (result !== "/" && (value.endsWith("/") || [".", ".."].includes(value.split("/").at(-1))) ? "/" : "");
}
/** Logical site URLs independent of their deployment mount. No browser globals. */
export class PortalURLs {
    basePath;
    currentPath;
    selection;
    get prefix() { return this.basePath === "/" ? "" : this.basePath; }
    constructor(options = {}) {
        this.basePath = options.basePath ?? "/";
        this.currentPath = options.currentPath ?? "/";
        if (options.selection !== undefined && (!options.selection || typeof options.selection !== "object" || Array.isArray(options.selection)))
            throw new Error("Invalid Portal selection metadata");
        if (Object.keys(options.selection ?? {}).some(key => !["site", "version"].includes(key)))
            throw new Error("Unknown Portal selection key");
        this.selection = Object.freeze(Object.fromEntries(Object.entries(options.selection ?? {}).filter(([, value]) => value !== undefined)));
        if (!this.basePath.startsWith("/") || this.basePath.startsWith("//") || /[?#%]/.test(this.basePath) || (this.basePath !== "/" && this.basePath.endsWith("/")) || path(this.basePath, "/") !== this.basePath ||
            !this.currentPath.startsWith("/") || this.currentPath.startsWith("//") || this.currentPath.includes("#") || unsafe(this.currentPath) || path(parts(this.currentPath).path, "/") !== parts(this.currentPath).path ||
            Object.entries(this.selection).some(([key, value]) => !["site", "version"].includes(key) || typeof value !== "string" || !value || new TextEncoder().encode(value).length > 256 || unsafe(value)))
            throw new Error("Invalid Portal routing context");
    }
    page(value) { return this.resolve(value, true); }
    asset(value) { return this.resolve(value, false); }
    /** Path is relative to /api, e.g. api('orders/123'). */
    api(value) {
        const split = parts(value);
        const suffix = split.path.startsWith("/") ? split.path.slice(1) : split.path;
        const result = this.resolve("/api" + (suffix ? "/" + suffix : "") + (split.query === undefined ? "" : "?" + split.query) + (split.fragment === undefined ? "" : "#" + split.fragment), false);
        const logical = this.logicalPath(parts(result).path);
        if (logical !== "/api" && !logical.startsWith("/api/"))
            throw new Error("API URL escapes its namespace");
        return result;
    }
    action(name, returnTo = this.currentPath) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            throw new Error("Invalid Portal action name");
        return this.resolve("/_portal/actions/" + name, false) + "?returnTo=" + encodeURIComponent(this.logicalPath(returnTo));
    }
    logicalPath(value) {
        if (!value.startsWith("/") || value.startsWith("//") || value.includes("#") || unsafe(value))
            throw new Error("Expected a local Portal path");
        const split = parts(value);
        return path(this.strip(split.path), "/") + (split.query === undefined ? "" : "?" + split.query);
    }
    unmount(value) {
        const split = parts(value);
        if (this.prefix && split.path !== this.prefix && !split.path.startsWith(this.prefix + "/"))
            throw new Error("Path is outside the Portal mount");
        return this.logicalPath(value);
    }
    resolve(value, preserveSelection) {
        if (unsafe(value) || value !== value.trim())
            throw new Error("Unsafe Portal URL");
        if (value.startsWith("//"))
            return value;
        const scheme = /^([^/?#:]+):/.exec(value)?.[1]?.toLowerCase();
        if (scheme) {
            if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || ["javascript", "data", "vbscript"].includes(scheme))
                throw new Error("Unsupported URL scheme");
            return value;
        }
        if (value.startsWith("#"))
            return value;
        const split = parts(value), current = parts(this.currentPath);
        const route = split.path ? path(this.strip(split.path), current.path) : current.path;
        let query = split.query ?? (value === "" ? current.query : undefined);
        if (preserveSelection && Object.keys(this.selection).length) {
            const fields = (query ?? "").split("&").filter(Boolean).filter(field => {
                let key;
                try {
                    key = decodeURIComponent(field.split("=")[0].replace(/\+/g, " "));
                }
                catch {
                    key = "";
                }
                return !Object.hasOwn(this.selection, key);
            });
            fields.push(...Object.keys(this.selection).sort().map(key => encodeURIComponent(key) + "=" + encodeURIComponent(this.selection[key])));
            query = fields.join("&");
        }
        return this.prefix + route + (query === undefined ? "" : "?" + query) + (split.fragment === undefined ? "" : "#" + split.fragment);
    }
    strip(value) {
        return this.prefix && (value === this.prefix || value.startsWith(this.prefix + "/")) ? value.slice(this.prefix.length) || "/" : value;
    }
}
