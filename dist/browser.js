import { FormActivity, RequestScope, StateStore } from "./state.js";
import { PortalURLs } from "./urls.js";
import { PortalBehaviors } from "./behaviors.js";
import { Morph } from "./morph.js";
const PAGE = "[data-portal-page]";
const ICONS = "style[data-portal-icons]";
const COMPONENTS = "style[data-portal-components]";
const INSTANCE_FORM = "form[data-portal-instance]";
const STATUS = "[data-portal-status]";
/** A component instance (`c3`) or one of its live parts (`c3-total`). */
const INSTANCE = /^c[1-9][0-9]*$/;
const CHANGE_DEBOUNCE = 250;
const HISTORY = "__portalPosition";
const INDEX = "__portalIndex";
/** Enhances ordinary SSR HTML. It never evaluates template expressions or Lua. */
export class PortalRuntime {
    options;
    state = new StateStore({
        navigating: false,
        error: null,
    });
    requests = new RequestScope();
    forms = new Map();
    formLocks = new Map();
    timers = new Map();
    win;
    doc;
    fetcher;
    hard;
    routing;
    behaviors;
    morpher;
    composing = new WeakSet();
    /** Per instance: the pending debounce and the in-flight live change. */
    changes = new Map();
    historyRequest = 0;
    awaitingNavigation = false;
    /** URL helpers follow the current logical page after enhanced navigation. */
    get urls() {
        return new PortalURLs({ basePath: this.routing.basePath, selection: this.routing.selection,
            currentPath: this.routing.unmount(this.win.location.pathname + this.win.location.search) });
    }
    /** The server layout outside the page content, as last rendered. */
    serverShell;
    serverStructure;
    epoch = 0;
    navigationAttempt = 0;
    historyIndex = 0;
    restoringHistory = false;
    pageURL = "";
    started = false;
    disposed = false;
    transitioning = false;
    context;
    version;
    oldScrollRestoration = "auto";
    constructor(options) {
        this.options = options;
        this.win = options.window;
        this.doc = this.win.document;
        this.behaviors = new PortalBehaviors(this.doc);
        this.morpher = new Morph(this.doc);
        const selection = JSON.parse(this.doc.documentElement.dataset.portalSelection ?? "{}");
        if (!selection || typeof selection !== "object" || Array.isArray(selection))
            throw new Error("Invalid Portal selection metadata");
        this.routing = new PortalURLs({ basePath: this.doc.documentElement.dataset.portalBase ?? "/", selection: selection });
        this.routing.unmount(this.win.location.pathname);
        this.serverShell = this.shell(this.doc);
        this.serverStructure = this.structure(this.doc);
        this.fetcher = options.fetch ?? this.win.fetch.bind(this.win);
        this.hard =
            options.hardNavigate ?? ((url) => this.win.location.assign(url));
        this.pageURL = this.win.location.href;
        this.historyIndex = Number.isInteger(this.win.history.state?.[INDEX])
            ? this.win.history.state[INDEX]
            : 0;
        this.context = this.doc.documentElement.dataset.portalContext ?? "";
        this.version = this.doc.documentElement.dataset.portalVersion ?? "";
    }
    start() {
        if (this.started || this.disposed)
            return;
        if (!this.context ||
            !this.version ||
            this.doc.querySelectorAll(PAGE).length !== 1)
            return;
        this.started = true;
        this.oldScrollRestoration = this.win.history.scrollRestoration;
        this.win.history.scrollRestoration = "manual";
        this.doc.addEventListener("click", this.click);
        this.doc.addEventListener("submit", this.submit);
        this.doc.addEventListener("input", this.input);
        this.doc.addEventListener("change", this.input);
        this.doc.addEventListener("compositionstart", this.compositionStart);
        this.doc.addEventListener("compositionend", this.compositionEnd);
        this.morpher.adopt(this.doc.body);
        this.behaviors.start();
        this.win.addEventListener("popstate", this.pop);
        this.win.addEventListener("scroll", this.savePosition);
        this.savePosition();
    }
    dispose() {
        this.disposed = true;
        this.started = false;
        this.invalidate();
        this.doc.removeEventListener("click", this.click);
        this.doc.removeEventListener("submit", this.submit);
        this.doc.removeEventListener("input", this.input);
        this.doc.removeEventListener("change", this.input);
        this.doc.removeEventListener("compositionstart", this.compositionStart);
        this.doc.removeEventListener("compositionend", this.compositionEnd);
        this.behaviors.dispose();
        this.win.removeEventListener("popstate", this.pop);
        this.win.removeEventListener("scroll", this.savePosition);
        this.win.history.scrollRestoration = this.oldScrollRestoration;
    }
    /** Host calls before an identity switch; no previous response can then apply. */
    invalidate() {
        ++this.epoch;
        ++this.historyRequest;
        ++this.navigationAttempt;
        this.transitioning = false;
        this.awaitingNavigation = false;
        this.requests.reset();
        this.behaviors.reset();
        for (const [element, form] of this.forms) {
            form.invalidate();
            element.removeAttribute("aria-busy");
        }
        for (const region of this.doc.querySelectorAll("[data-portal-region][aria-busy]"))
            region.removeAttribute("aria-busy");
        this.forms.clear();
        for (const [form, controls] of this.formLocks)
            this.unlockForm(form, controls);
        for (const timer of this.timers.values())
            clearTimeout(timer);
        this.timers.clear();
        for (const change of this.changes.values()) {
            clearTimeout(change.timer);
            change.controller?.abort();
        }
        this.changes.clear();
        this.state.set({ navigating: false, error: null });
    }
    savePosition = () => {
        if (this.transitioning || this.disposed)
            return;
        this.win.history.replaceState({
            ...this.win.history.state,
            [INDEX]: this.historyIndex,
            [HISTORY]: { x: this.win.scrollX, y: this.win.scrollY },
        }, "");
    };
    pop = (event) => {
        if (this.restoringHistory) {
            this.restoringHistory = false;
            return;
        }
        void this.navigate(this.win.location.href, "pop", event.state?.[HISTORY], event.state?.[INDEX]);
    };
    click = (event) => {
        if (event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            event.shiftKey)
            return;
        const target = event.target;
        if (typeof target?.closest !== "function")
            return;
        const link = target?.closest("a[href]");
        if (!link ||
            link.hasAttribute("download") ||
            ["asset", "endpoint"].includes(link.dataset.portalUrlKind ?? "") ||
            (link.target && link.target !== "_self") ||
            link.closest("[data-portal-native]"))
            return;
        const url = new URL(link.href, this.win.location.href);
        if (!this.internal(url))
            return;
        if (url.pathname === this.win.location.pathname &&
            url.search === this.win.location.search &&
            url.hash)
            return;
        event.preventDefault();
        if (link.dataset.portalTarget) {
            void this.refreshRegion(link.dataset.portalTarget, url.href, this.historyPolicy(link)).catch(error => this.failure(link, error));
        }
        else
            void this.navigate(url.href);
    };
    endpoint(url) {
        const path = this.routing.unmount(url.pathname);
        return path === "/api" || path.startsWith("/api/") || path === "/mcp" || path.startsWith("/_portal/");
    }
    selectPage(url) {
        if (!this.endpoint(url)) {
            url.search = new URL(this.urls.page(url.pathname + url.search + url.hash), this.win.location.href).search;
        }
    }
    internal(url) {
        if (url.origin !== this.win.location.origin || !["http:", "https:"].includes(url.protocol))
            return false;
        try {
            this.routing.unmount(url.pathname);
            return true;
        }
        catch {
            return false;
        }
    }
    async navigate(href, mode = "push", position, targetIndex) {
        if (this.disposed)
            return;
        const url = new URL(this.urls.asset(href), this.win.location.href);
        if (!this.internal(url)) {
            this.hard(url.href);
            return;
        }
        this.selectPage(url);
        this.requests.cancel("navigation");
        this.transitioning = mode === "pop";
        const attempt = ++this.navigationAttempt;
        let allowed;
        this.awaitingNavigation = true;
        try {
            allowed =
                !this.options.beforeNavigate || (await this.options.beforeNavigate());
        }
        catch (error) {
            if (attempt === this.navigationAttempt) {
                this.rejectNavigation(mode, targetIndex);
                this.failure(this.doc.documentElement, error);
            }
            return;
        }
        finally {
            if (attempt === this.navigationAttempt)
                this.awaitingNavigation = false;
        }
        if (attempt !== this.navigationAttempt)
            return;
        if (!allowed) {
            this.rejectNavigation(mode, targetIndex);
            return;
        }
        if (mode !== "pop")
            this.savePosition();
        this.invalidate();
        const request = this.requests.begin("navigation");
        this.transitioning = true;
        this.state.set({ navigating: true, error: null });
        try {
            const response = await this.fetcher(url.href, {
                signal: request.signal,
                credentials: "same-origin",
                headers: {
                    "X-Portal-Request": "navigation",
                    "X-Portal-Context": this.context,
                    "X-Portal-Version": this.version,
                    Accept: "text/html",
                },
            });
            const html = await response.text();
            if (!request.isCurrent())
                return;
            // Fetch strips fragments, including redirect Location fragments. Let the
            // browser resolve redirected GETs; never guess their final anchor.
            if (response.redirected) {
                this.invalidate();
                this.hard(url.href);
                return;
            }
            const destinationURL = new URL(response.url || url.href);
            destinationURL.hash = url.hash;
            const destination = destinationURL.href;
            if (!this.internal(new URL(destination))) {
                this.invalidate();
                this.hard(destination);
                return;
            }
            if (!response.ok || !this.compatible(response)) {
                this.invalidate();
                this.hard(destination);
                return;
            }
            const parsed = this.parse(html);
            if (!this.pageCompatible(parsed)) {
                this.invalidate();
                this.hard(destination);
                return;
            }
            this.invalidate();
            this.replacePage(parsed);
            if (mode === "push")
                this.win.history.pushState({ [INDEX]: ++this.historyIndex }, "", destination);
            if (mode === "replace")
                this.win.history.replaceState({ [INDEX]: this.historyIndex }, "", destination);
            if (mode === "pop" && typeof targetIndex === "number")
                this.historyIndex = targetIndex;
            this.pageURL = destination;
            this.restoreFocusAndScroll(position, new URL(destination).hash);
            this.state.set({ navigating: false, error: null });
        }
        catch (error) {
            if (!request.isCurrent())
                return;
            this.state.set({ navigating: false, error });
            this.hard(url.href);
        }
        finally {
            if (request.isCurrent())
                this.transitioning = false;
            request.finish();
        }
    }
    rejectNavigation(mode, targetIndex) {
        this.transitioning = false;
        this.state.set({ navigating: false, error: null });
        if (mode !== "pop")
            return;
        if (typeof targetIndex === "number" && targetIndex !== this.historyIndex) {
            this.restoringHistory = true;
            this.win.history.go(this.historyIndex - targetIndex);
        }
        else
            this.hard(this.pageURL);
    }
    compatible(response) {
        return (response.headers.get("X-Portal-Context") === this.context &&
            response.headers.get("X-Portal-Version") === this.version &&
            (response.headers.get("content-type") ?? "").includes("text/html"));
    }
    parse(html) {
        // DOMParser and imported script nodes do not execute page-provided scripts.
        return new DOMParser().parseFromString(html, "text/html");
    }
    /** Compare incoming server layout with the original server layout, not live
     * DOM: client-owned edits in a compatible persistent shell must survive. */
    shell(page) {
        const body = page.body.cloneNode(true);
        for (const content of body.querySelectorAll(PAGE)) {
            content.replaceWith(page.createComment("portal-page-slot"));
        }
        return body.outerHTML;
    }
    structure(page) {
        const root = page.documentElement.cloneNode(false);
        root.removeAttribute("lang");
        root.removeAttribute("dir");
        const head = page.head.cloneNode(true);
        // Only metadata explicitly synchronized by replacePage may differ, and the
        // host's per-page icon rules, which adoptIcons merges.
        for (const node of head.querySelectorAll(`title, meta[name]:not([name="viewport"]), meta[property], link[rel="canonical"], link[rel~="icon"], script[type="application/ld+json"], ${ICONS}, ${COMPONENTS}`))
            node.remove();
        return root.outerHTML + head.outerHTML;
    }
    routingCompatible(root) {
        try {
            const selection = JSON.parse(root.dataset.portalSelection ?? "{}");
            const incoming = new PortalURLs({ basePath: root.dataset.portalBase ?? "/", selection });
            return incoming.basePath === this.routing.basePath &&
                JSON.stringify(Object.entries(incoming.selection).sort()) === JSON.stringify(Object.entries(this.routing.selection).sort());
        }
        catch {
            return false;
        }
    }
    /** A morph may also change the layout around the page; a swap may not. */
    pageCompatible(page, morph = false) {
        if (!this.routingCompatible(page.documentElement) ||
            page.documentElement.dataset.portalContext !== this.context ||
            page.documentElement.dataset.portalVersion !== this.version ||
            page.querySelectorAll(PAGE).length !== 1 ||
            (!morph && this.shell(page) !== this.serverShell) ||
            this.structure(page) !== this.serverStructure)
            return false;
        // Asset/layout changes get native navigation rather than partially loading code.
        const assets = (doc) => Array.from(doc.querySelectorAll('head link[rel="stylesheet"], head style:not([data-portal-icons]):not([data-portal-components]), head meta[charset], head meta[name="viewport"], script[src]'))
            .map((node) => node.outerHTML)
            .join("");
        return assets(page) === assets(this.doc);
    }
    /** The host inlines only the icon mask rules a response uses, one per line,
     * in style[data-portal-icons] (a page's head, or beside a region's root).
     * Merge them into the live page so swapped-in content keeps its icons. */
    adoptIcons(source) {
        this.adoptRules(source, ICONS, "data-portal-icons");
    }
    /** Likewise for the CSS of the components a response renders
     * (style[data-portal-components], one component per line). */
    adoptComponentStyles(source) {
        this.adoptRules(source, COMPONENTS, "data-portal-components");
    }
    adoptRules(source, selector, attribute) {
        const incoming = Array.from(source.querySelectorAll(selector)).flatMap((node) => (node.textContent ?? "").split("\n")).filter(Boolean);
        if (!incoming.length)
            return;
        let live = this.doc.head.querySelector(selector);
        const present = (live?.textContent ?? "").split("\n").filter(Boolean);
        const missing = [...new Set(incoming)].filter((rule) => !present.includes(rule));
        if (!missing.length)
            return;
        if (!live) {
            live = this.doc.createElement("style");
            live.setAttribute(attribute, "");
            this.doc.head.append(live);
        }
        live.textContent = [...present, ...missing].join("\n");
    }
    replacePage(page) {
        this.adoptIcons(page);
        this.adoptComponentStyles(page);
        const content = this.doc.importNode(page.querySelector(PAGE), true);
        this.doc.querySelector(PAGE).replaceWith(content);
        this.morpher.adopt(content);
        this.syncMetadata(page);
        this.behaviors.refresh();
        this.doc.dispatchEvent(new CustomEvent("portal:navigated"));
    }
    syncMetadata(page) {
        if (this.doc.title !== page.title)
            this.doc.title = page.title;
        if (this.doc.documentElement.lang !== page.documentElement.lang)
            this.doc.documentElement.lang = page.documentElement.lang;
        if (this.doc.documentElement.dir !== page.documentElement.dir)
            this.doc.documentElement.dir = page.documentElement.dir;
        const metadata = 'meta[name]:not([name="viewport"]), meta[property], link[rel="canonical"], link[rel~="icon"], script[type="application/ld+json"]';
        const markup = (head) => Array.from(head.querySelectorAll(metadata), (node) => node.outerHTML).join("");
        if (markup(this.doc.head) === markup(page.head))
            return;
        for (const node of this.doc.head.querySelectorAll(metadata))
            node.remove();
        for (const node of page.head.querySelectorAll(metadata))
            this.doc.head.append(this.doc.importNode(node, true));
    }
    /** Same URL: patch the live page toward the response, keeping visitor state
     * (focus, typed values, open disclosures, scroll). Focus does not move. */
    morphPage(page, current) {
        // Anything requested before this page response is older than it: region
        // and change responses must not land on what it re-rendered.
        ++this.epoch;
        for (const name of this.requests.cancelPrefix("region:"))
            this.region(this.doc, name.slice("region:".length))?.removeAttribute("aria-busy");
        for (const change of this.changes.values()) {
            change.controller?.abort();
            change.controller = undefined;
        }
        this.adoptIcons(page);
        this.adoptComponentStyles(page);
        // Only the page content, unless the server's layout changed too (a basket
        // total in the header): then the whole body, and that is the new layout.
        const shell = this.shell(page);
        if (shell === this.serverShell)
            this.morphTree(this.doc.querySelector(PAGE), page.querySelector(PAGE), current);
        else {
            this.morphTree(this.doc.body, page.body, current);
            this.serverShell = shell;
        }
        this.syncMetadata(page);
        this.doc.dispatchEvent(new CustomEvent("portal:region", { detail: { name: "page" } }));
    }
    /** Morph one live subtree. Behaviours re-initialise only where the morph
     * inserted or changed their markup; removed ones are torn down. Status
     * outlets are the runtime's own and keep their announcements. */
    morphTree(live, next, current) {
        // Forms in flight inside what is re-rendered no longer apply: their
        // responses are discarded and their controls unlocked, as for a swap.
        for (const [form, activity] of this.forms) {
            if (form === current || !live.contains(form))
                continue;
            activity.invalidate();
            this.forms.delete(form);
            form.removeAttribute("aria-busy");
            const controls = this.formLocks.get(form);
            if (controls)
                this.unlockForm(form, controls);
        }
        // Where focus goes if the morph removes the focused element: the nearest
        // instance or region around it that survives, else the page.
        const active = this.doc.activeElement;
        const shelters = [];
        for (let node = active?.parentElement ?? null; node; node = node.parentElement)
            if (node.hasAttribute("data-portal-region") || node.hasAttribute("data-portal-key") || node.matches(PAGE))
                shelters.push(node);
        const removed = [];
        this.morpher.morph(live, next, {
            enter: (element, incoming) => {
                if (element.matches(STATUS) && element.getAttribute("data-portal-status") === incoming.getAttribute("data-portal-status"))
                    return false;
                if (!element.hasAttribute("data-portal-behavior"))
                    return true;
                const markup = this.behaviors.serverMarkup(element);
                if (markup === undefined)
                    return true;
                if (markup === incoming.outerHTML)
                    return false;
                this.behaviors.forget(element, incoming.outerHTML);
                return true;
            },
            removed: (node) => removed.push(node),
        });
        for (const node of removed) {
            this.behaviors.teardown(node);
            for (const [form, activity] of this.forms) {
                if (node.contains(form)) {
                    activity.invalidate();
                    this.forms.delete(form);
                }
            }
        }
        this.behaviors.refresh();
        if (active instanceof HTMLElement && !active.isConnected) {
            const shelter = shelters.find((node) => node.isConnected);
            if (shelter) {
                if (!shelter.hasAttribute("tabindex"))
                    shelter.tabIndex = -1;
                shelter.focus({ preventScroll: true });
            }
        }
    }
    restoreFocusAndScroll(position, hash = "") {
        const heading = this.doc.querySelector(`${PAGE} h1`) ??
            this.doc.querySelector(PAGE);
        if (heading) {
            if (!heading.hasAttribute("tabindex"))
                heading.tabIndex = -1;
            heading.focus({ preventScroll: true });
        }
        let anchor = null;
        try {
            anchor = hash
                ? this.doc.getElementById(decodeURIComponent(hash.slice(1)))
                : null;
        }
        catch {
            /* malformed fragment: use top */
        }
        if (position)
            this.win.scrollTo(position.x, position.y);
        else if (anchor)
            anchor.scrollIntoView();
        else
            this.win.scrollTo(0, 0);
    }
    submit = (event) => {
        const form = event.target;
        if (event.defaultPrevented ||
            form.tagName !== "FORM" ||
            ["asset", "endpoint"].includes(form.dataset.portalUrlKind ?? "") ||
            form.closest("[data-portal-native]"))
            return;
        const submitter = event.submitter;
        const target = submitter?.getAttribute("formtarget") ?? form.target;
        if (target && target !== "_self")
            return;
        const action = submitter?.getAttribute("formaction") ?? form.action;
        const method = (submitter?.getAttribute("formmethod") ?? form.method).toUpperCase();
        const url = new URL(action, this.win.location.href);
        if (!this.internal(url) || !["GET", "POST"].includes(method))
            return;
        if (!form.noValidate && !submitter?.formNoValidate && !form.checkValidity())
            return;
        event.preventDefault();
        const data = new FormData(form, submitter);
        // A component event re-renders its own instance in place.
        const region = form.dataset.portalTarget ?? this.eventInstance(form);
        if (method === "GET") {
            url.search = "";
            for (const [key, value] of data)
                if (typeof value === "string")
                    url.searchParams.append(key, value);
            if (!this.endpoint(url)) {
                for (const [key, value] of Object.entries(this.routing.selection))
                    url.searchParams.set(key, value);
            }
            if (region)
                void this.refreshRegion(region, url.href, this.historyPolicy(form)).catch((error) => this.failure(form, error));
            else
                void this.navigate(url.href);
        }
        else {
            const body = new URLSearchParams();
            for (const [key, value] of data) {
                if (typeof value !== "string") {
                    this.failure(form, new Error("File forms require the Folder upload adapter"));
                    return;
                }
                body.append(key, value);
            }
            void this.postForm(form, url, body, region);
        }
    };
    historyPolicy(element) {
        const policy = element.dataset.portalHistory ?? "none";
        if (!["none", "replace", "advance"].includes(policy))
            throw new Error("Invalid Portal history policy");
        return policy;
    }
    compositionStart = (event) => {
        const form = event.target.form;
        if (form) {
            this.composing.add(form);
            clearTimeout(this.timers.get(form));
            this.timers.delete(form);
        }
    };
    compositionEnd = (event) => {
        const form = event.target.form;
        if (form)
            this.composing.delete(form);
        this.input(event);
    };
    /** The instance a component event form belongs to: its hidden instance form,
     * or an author's t:submit form inside the instance. */
    eventInstance(form) {
        if (form.matches(INSTANCE_FORM))
            return INSTANCE.test(form.id) ? form.id : undefined;
        if (!form.querySelector('input[name="_portal_instance"]'))
            return undefined;
        return this.instanceRoot(form)?.dataset.portalRegion;
    }
    instanceRoot(element) {
        let region = element.closest("[data-portal-region]");
        while (region && !INSTANCE.test(region.dataset.portalRegion ?? ""))
            region = region.parentElement?.closest("[data-portal-region]") ?? null;
        return region ?? undefined;
    }
    /** t:change: debounce, then post the instance form for its live parts only.
     * A newer change aborts the request in flight, so a slow response never
     * overwrites a newer one. */
    scheduleChange(container) {
        const root = this.instanceRoot(container);
        const instance = root?.dataset.portalRegion;
        const exportName = container.dataset.portalChange;
        if (!instance || !exportName)
            return;
        const form = this.doc.getElementById(instance);
        if (!(form instanceof HTMLFormElement) || !form.matches(INSTANCE_FORM))
            return;
        const state = this.changes.get(instance) ?? {};
        clearTimeout(state.timer);
        state.timer = setTimeout(() => {
            state.timer = undefined;
            void this.postChange(instance, exportName, container);
        }, CHANGE_DEBOUNCE);
        this.changes.set(instance, state);
    }
    async postChange(instance, exportName, container) {
        const form = this.doc.getElementById(instance);
        const state = this.changes.get(instance);
        if (this.disposed || !state || !(form instanceof HTMLFormElement))
            return;
        state.controller?.abort();
        const controller = new AbortController();
        state.controller = controller;
        const epoch = this.epoch;
        const body = new URLSearchParams();
        for (const [key, value] of new FormData(form))
            if (typeof value === "string")
                body.append(key, value);
        body.set("_portal_export", exportName);
        body.set("_portal_region", instance);
        const current = () => !controller.signal.aborted && state.controller === controller && epoch === this.epoch;
        try {
            const response = await this.fetcher(new URL(form.action, this.win.location.href).href, {
                method: "POST",
                body,
                signal: controller.signal,
                credentials: "same-origin",
                headers: {
                    "X-Portal-Request": "region",
                    "X-Portal-Context": this.context,
                    "X-Portal-Version": this.version,
                    Accept: "text/html",
                },
            });
            const html = await response.text();
            if (!current())
                return;
            if (response.status === 409 || response.status === 401 || !this.compatible(response)) {
                this.invalidate();
                this.hard(this.win.location.href);
                return;
            }
            if (!response.ok && response.status !== 422)
                throw new Error(`Component event failed (${response.status})`);
            const parsed = this.parse(html);
            // A privileged export answers with the whole page: morph it in.
            if (this.isWholePage(html)) {
                if (!this.pageCompatible(parsed, true)) {
                    this.invalidate();
                    this.hard(this.win.location.href);
                    return;
                }
                this.morphPage(parsed);
                return;
            }
            this.morphRegion(instance, parsed);
        }
        catch (error) {
            if (current())
                this.failure(container, error);
        }
        finally {
            if (state.controller === controller)
                state.controller = undefined;
        }
    }
    /** A complete document rather than a region fragment. */
    isWholePage(html) {
        return /^\s*<!doctype html>/i.test(html);
    }
    /** A response's instance forms carry fresh tokens: morph or add them. */
    adoptInstanceForms(parsed, inside) {
        for (const incoming of Array.from(parsed.querySelectorAll(INSTANCE_FORM))) {
            if (inside.contains(incoming))
                continue;
            const existing = incoming.id ? this.doc.getElementById(incoming.id) : null;
            if (existing instanceof HTMLFormElement && existing.matches(INSTANCE_FORM))
                this.morphTree(existing, incoming);
            else {
                const imported = this.doc.importNode(incoming, true);
                this.doc.querySelector(PAGE)?.append(imported);
                this.morpher.adopt(imported);
            }
        }
    }
    input = (event) => {
        const changed = event.target?.closest?.("[data-portal-change]");
        if (changed && !event.isComposing) {
            this.scheduleChange(changed);
            return;
        }
        if (event.type === "change")
            return;
        const control = event.target;
        const form = control.form;
        if (!form?.hasAttribute("data-portal-live") ||
            this.composing.has(form) || event.isComposing ||
            form.method.toUpperCase() !== "GET" ||
            !form.dataset.portalTarget)
            return;
        const delay = Number(form.dataset.portalDebounce ?? 150);
        clearTimeout(this.timers.get(form));
        this.timers.set(form, setTimeout(() => {
            this.timers.delete(form);
            if (form.isConnected)
                form.requestSubmit();
        }, Number.isFinite(delay) ? Math.max(0, Math.min(delay, 2000)) : 150));
    };
    async refreshRegion(name, href, history = "none") {
        if (this.disposed)
            return;
        const url = new URL(this.urls.asset(href), this.win.location.href);
        if (!this.internal(url))
            throw new Error("Region URL must be inside the Portal mount");
        this.selectPage(url);
        const target = this.region(this.doc, name);
        if (!target)
            throw new Error("Region target must be unique");
        if (!["none", "replace", "advance"].includes(history))
            throw new Error("Invalid Portal history policy");
        // A URL-changing frame click is a newer navigation intent. If a page
        // transition (including its host approval) is pending, use the normal
        // navigation owner so old responses/prompts cannot overwrite this intent.
        if (history !== "none" && (this.transitioning || this.awaitingNavigation)) {
            return this.navigate(url.href, history === "replace" ? "replace" : "push");
        }
        const historyRequest = history === "none" ? 0 : ++this.historyRequest;
        const request = this.requests.begin(`region:${name}`);
        this.feedback(name, "loading");
        target.setAttribute("aria-busy", "true");
        try {
            const response = await this.fetcher(url.href, {
                signal: request.signal,
                credentials: "same-origin",
                headers: {
                    "X-Portal-Region": name,
                    "X-Portal-Request": "region",
                    "X-Portal-Context": this.context,
                    "X-Portal-Version": this.version,
                    Accept: "text/html",
                },
            });
            const html = await response.text();
            if (!request.isCurrent() || this.region(this.doc, name) !== target)
                return;
            if (!this.compatible(response)) {
                this.invalidate();
                this.hard(this.win.location.href);
                return;
            }
            if (response.url && !this.internal(new URL(response.url)))
                throw new Error("Region redirect left the Portal mount");
            if (!response.ok)
                throw new Error(`Region request failed (${response.status})`);
            if (history !== "none" && historyRequest !== this.historyRequest)
                return;
            this.morphRegion(name, this.parse(html));
            if (history !== "none") {
                const destination = response.url ? new URL(response.url) : new URL(url);
                if (!response.redirected)
                    destination.hash = url.hash;
                if (history === "advance") {
                    this.savePosition();
                    this.win.history.pushState({ [INDEX]: ++this.historyIndex }, "", destination.href);
                }
                else
                    this.win.history.replaceState({ ...this.win.history.state, [INDEX]: this.historyIndex }, "", destination.href);
                this.pageURL = destination.href;
            }
            this.feedback(name, "success");
        }
        catch (error) {
            if (request.isCurrent())
                this.failure(target, error);
        }
        finally {
            if (request.isCurrent())
                target.removeAttribute("aria-busy");
            request.finish();
        }
    }
    region(doc, name) {
        const matches = Array.from(doc.querySelectorAll("[data-portal-region]")).filter((node) => node.dataset.portalRegion === name);
        return matches.length === 1 ? matches[0] : null;
    }
    /** Same URL: morph a region (or a component instance) toward the response.
     * The focused control, typed values and open disclosures inside it survive. */
    morphRegion(name, parsed, current) {
        const target = this.region(this.doc, name);
        const metadata = parsed.querySelector("[data-portal-fragment]") ?? parsed.documentElement;
        if (!this.routingCompatible(metadata))
            throw new Error("Region response changed Portal routing context");
        const replacement = this.region(parsed, name);
        if (!target || !replacement)
            throw new Error("Region response must contain one matching root");
        for (const child of target.querySelectorAll("[data-portal-region]")) {
            if (child.dataset.portalRegion)
                this.requests.cancel(`region:${child.dataset.portalRegion}`);
        }
        replacement.removeAttribute("aria-busy");
        this.adoptIcons(parsed);
        this.adoptComponentStyles(parsed);
        this.morphTree(target, replacement, current);
        this.adoptInstanceForms(parsed, replacement);
        this.doc.dispatchEvent(new CustomEvent("portal:region", { detail: { name } }));
    }
    async postForm(form, url, data, region) {
        if (this.disposed)
            return;
        let activity = this.forms.get(form);
        if (!activity) {
            activity = new FormActivity();
            this.forms.set(form, activity);
        }
        if (activity.state.getSnapshot().pending)
            return;
        let epoch = this.epoch;
        if (region)
            this.requests.cancel(`region:${region}`);
        const headers = {
            "X-Portal-Request": region ? "region" : "navigation",
            "X-Portal-Context": this.context,
            "X-Portal-Version": this.version,
            Accept: "text/html",
        };
        // Fetch forwards custom headers across a 303. Keep the POST-only target
        // in the body so redirected GETs request a complete destination document.
        if (region)
            data.set("_portal_region", region);
        form.setAttribute("aria-busy", "true");
        this.feedback(region ?? "page", "loading");
        const controls = this.lockForm(form);
        await activity.submit(async () => {
            const response = await this.fetcher(url.href, {
                method: "POST",
                body: data,
                credentials: "same-origin",
                headers,
            });
            return { response, html: await response.text() };
        }, ({ response, html }) => {
            if (epoch !== this.epoch || !this.doc.contains(form))
                return;
            // The response decides the controls' disabled state, not the lock.
            this.unlockForm(form, controls);
            if (response.status === 409 || response.status === 401) {
                this.invalidate();
                this.hard(response.redirected ? response.url : this.win.location.href);
                return;
            }
            if (response.redirected && !this.internal(new URL(response.url))) {
                this.invalidate();
                this.hard(response.url);
                return;
            }
            if (!response.ok && response.status !== 422)
                throw new Error(`Action failed (${response.status})`);
            if (!this.compatible(response)) {
                this.invalidate();
                this.hard(response.redirected ? response.url : this.win.location.href);
                return;
            }
            // A region (or a pure component event's instance) morphs in place.
            if (region && !response.redirected && !this.isWholePage(html)) {
                this.requests.cancel(`region:${region}`);
                this.morphRegion(region, this.parse(html), form);
                this.feedback(region, "success");
            }
            else {
                const page = this.parse(html);
                // The same URL (no redirect, a privileged component event, or a
                // redirect back here) morphs; another URL swaps.
                const morph = !response.redirected || this.samePage(response.url);
                if (!this.pageCompatible(page, morph)) {
                    this.invalidate();
                    this.hard(response.redirected ? response.url : this.win.location.href);
                    return;
                }
                if (morph) {
                    this.morphPage(page, form);
                    // This submission produced the page; it is not superseded by it.
                    epoch = this.epoch;
                    this.feedback(region ?? "page", "success");
                    return;
                }
                this.invalidate();
                this.replacePage(page);
                if (response.redirected)
                    this.win.history.pushState({ [INDEX]: ++this.historyIndex }, "", response.url);
                if (response.redirected)
                    this.pageURL = response.url;
                this.restoreFocusAndScroll();
                this.feedback("page", "success");
            }
        });
        this.unlockForm(form, controls);
        if (epoch === this.epoch && this.forms.get(form) === activity)
            form.removeAttribute("aria-busy");
        const error = activity.state.getSnapshot().error;
        if (error && epoch === this.epoch)
            this.failure(form, error);
    }
    /** The current document's URL, fragment aside. */
    samePage(href) {
        const url = new URL(href, this.win.location.href);
        return url.origin === this.win.location.origin && url.pathname === this.win.location.pathname && url.search === this.win.location.search;
    }
    lockForm(form) {
        const controls = Array.from(form.elements)
            .filter((element) => ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(element.tagName))
            .filter((control) => !control.disabled);
        for (const control of controls)
            control.disabled = true;
        this.formLocks.set(form, controls);
        return controls;
    }
    unlockForm(form, controls) {
        if (this.formLocks.get(form) !== controls)
            return;
        for (const control of controls)
            control.disabled = false;
        this.formLocks.delete(form);
    }
    feedback(name, state) {
        for (const outlet of this.doc.querySelectorAll("[data-portal-status]")) {
            if (outlet.dataset.portalStatus !== name)
                continue;
            const fallback = state === "loading" ? "Loading…" : state === "error" ? "Unable to update. Please try again." : "Updated.";
            outlet.setAttribute("role", "status");
            outlet.setAttribute("aria-live", "polite");
            outlet.textContent = outlet.getAttribute(`data-portal-${state}-message`) ?? fallback;
        }
    }
    failure(target, error) {
        const element = target;
        this.feedback(element.dataset.portalTarget ?? element.dataset.portalRegion ?? "page", "error");
        this.state.set({ navigating: false, error });
        target.dispatchEvent(new CustomEvent("portal:error", { bubbles: true, detail: { error } }));
    }
}
