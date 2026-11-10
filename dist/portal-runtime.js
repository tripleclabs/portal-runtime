// src/state.ts
var StateStore = class {
  constructor(value) {
    this.value = value;
  }
  value;
  listeners = /* @__PURE__ */ new Set();
  getSnapshot = () => this.value;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  clearSubscribers() {
    this.listeners.clear();
  }
  set(value) {
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }
};
var RequestScope = class {
  pending = /* @__PURE__ */ new Map();
  begin(key) {
    this.pending.get(key)?.abort();
    const controller = new AbortController();
    this.pending.set(key, controller);
    return {
      signal: controller.signal,
      isCurrent: () => this.pending.get(key) === controller && !controller.signal.aborted,
      finish: () => {
        if (this.pending.get(key) === controller) this.pending.delete(key);
      }
    };
  }
  cancel(key) {
    this.pending.get(key)?.abort();
    this.pending.delete(key);
  }
  reset() {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
  }
};
var SubmissionClock = class {
  generation = 0;
  next() {
    return ++this.generation;
  }
  isCurrent(token) {
    return token === this.generation;
  }
};
var FormActivity = class {
  state = new StateStore({
    pending: false,
    error: null
  });
  submissions = new SubmissionClock();
  async submit(operation, apply) {
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
  invalidate() {
    this.submissions.next();
    this.state.set({ pending: false, error: null });
  }
};

// src/urls.ts
var unsafe = (value) => /[\\\x00-\x1f\x7f]/.test(value);
var parts = (value) => {
  const hash = value.indexOf("#");
  const head = hash < 0 ? value : value.slice(0, hash);
  const mark = head.indexOf("?");
  return { path: mark < 0 ? head : head.slice(0, mark), query: mark < 0 ? void 0 : head.slice(mark + 1), fragment: hash < 0 ? void 0 : value.slice(hash + 1) };
};
function path(value, current) {
  if (unsafe(value) || value.includes("//")) throw new Error("Ambiguous Portal path");
  const currentParts = current.split("/").filter(Boolean);
  const output = value.startsWith("/") ? [] : current.endsWith("/") ? currentParts : currentParts.slice(0, -1);
  for (const segment of value.split("/").filter(Boolean)) {
    const decoded = decodeURIComponent(segment);
    if (unsafe(decoded) || decoded.includes("/") || decoded.includes("%") || segment !== decoded && [".", ".."].includes(decoded))
      throw new Error("Ambiguous encoded Portal path");
    if (segment === ".") continue;
    if (segment === "..") {
      if (!output.length) throw new Error("Portal URL escapes its mount");
      output.pop();
    } else {
      output.push(encodeURI(segment).replace(/%25([0-9a-f]{2})/gi, "%$1"));
    }
  }
  const result = "/" + output.join("/");
  return result + (result !== "/" && (value.endsWith("/") || [".", ".."].includes(value.split("/").at(-1))) ? "/" : "");
}
var PortalURLs = class {
  basePath;
  currentPath;
  selection;
  get prefix() {
    return this.basePath === "/" ? "" : this.basePath;
  }
  constructor(options = {}) {
    this.basePath = options.basePath ?? "/";
    this.currentPath = options.currentPath ?? "/";
    if (options.selection !== void 0 && (!options.selection || typeof options.selection !== "object" || Array.isArray(options.selection))) throw new Error("Invalid Portal selection metadata");
    if (Object.keys(options.selection ?? {}).some((key) => !["site", "version"].includes(key))) throw new Error("Unknown Portal selection key");
    this.selection = Object.freeze(Object.fromEntries(Object.entries(options.selection ?? {}).filter(([, value]) => value !== void 0)));
    if (!this.basePath.startsWith("/") || this.basePath.startsWith("//") || /[?#%]/.test(this.basePath) || this.basePath !== "/" && this.basePath.endsWith("/") || path(this.basePath, "/") !== this.basePath || !this.currentPath.startsWith("/") || this.currentPath.startsWith("//") || this.currentPath.includes("#") || unsafe(this.currentPath) || path(parts(this.currentPath).path, "/") !== parts(this.currentPath).path || Object.entries(this.selection).some(([key, value]) => !["site", "version"].includes(key) || typeof value !== "string" || !value || new TextEncoder().encode(value).length > 256 || unsafe(value)))
      throw new Error("Invalid Portal routing context");
  }
  page(value) {
    return this.resolve(value, true);
  }
  asset(value) {
    return this.resolve(value, false);
  }
  /** Path is relative to /api, e.g. api('orders/123'). */
  api(value) {
    const split = parts(value);
    const suffix = split.path.startsWith("/") ? split.path.slice(1) : split.path;
    const result = this.resolve("/api" + (suffix ? "/" + suffix : "") + (split.query === void 0 ? "" : "?" + split.query) + (split.fragment === void 0 ? "" : "#" + split.fragment), false);
    const logical = this.logicalPath(parts(result).path);
    if (logical !== "/api" && !logical.startsWith("/api/")) throw new Error("API URL escapes its namespace");
    return result;
  }
  action(name, returnTo = this.currentPath) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid Portal action name");
    return this.resolve("/_portal/actions/" + name, false) + "?returnTo=" + encodeURIComponent(this.logicalPath(returnTo));
  }
  logicalPath(value) {
    if (!value.startsWith("/") || value.startsWith("//") || value.includes("#") || unsafe(value)) throw new Error("Expected a local Portal path");
    const split = parts(value);
    return path(this.strip(split.path), "/") + (split.query === void 0 ? "" : "?" + split.query);
  }
  unmount(value) {
    const split = parts(value);
    if (this.prefix && split.path !== this.prefix && !split.path.startsWith(this.prefix + "/")) throw new Error("Path is outside the Portal mount");
    return this.logicalPath(value);
  }
  resolve(value, preserveSelection) {
    if (unsafe(value) || value !== value.trim()) throw new Error("Unsafe Portal URL");
    if (value.startsWith("//")) return value;
    const scheme = /^([^/?#:]+):/.exec(value)?.[1]?.toLowerCase();
    if (scheme) {
      if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || ["javascript", "data", "vbscript"].includes(scheme)) throw new Error("Unsupported URL scheme");
      return value;
    }
    if (value.startsWith("#")) return value;
    const split = parts(value), current = parts(this.currentPath);
    const route = split.path ? path(this.strip(split.path), current.path) : current.path;
    let query = split.query ?? (value === "" ? current.query : void 0);
    if (preserveSelection && Object.keys(this.selection).length) {
      const fields = (query ?? "").split("&").filter(Boolean).filter((field) => {
        let key;
        try {
          key = decodeURIComponent(field.split("=")[0].replace(/\+/g, " "));
        } catch {
          key = "";
        }
        return !Object.hasOwn(this.selection, key);
      });
      fields.push(...Object.keys(this.selection).sort().map((key) => encodeURIComponent(key) + "=" + encodeURIComponent(this.selection[key])));
      query = fields.join("&");
    }
    return this.prefix + route + (query === void 0 ? "" : "?" + query) + (split.fragment === void 0 ? "" : "#" + split.fragment);
  }
  strip(value) {
    return this.prefix && (value === this.prefix || value.startsWith(this.prefix + "/")) ? value.slice(this.prefix.length) || "/" : value;
  }
};

// src/behaviors.ts
var PortalBehaviors = class {
  constructor(doc) {
    this.doc = doc;
  }
  doc;
  started = false;
  initialized = /* @__PURE__ */ new WeakSet();
  openers = /* @__PURE__ */ new Map();
  copied = /* @__PURE__ */ new Map();
  announcing = /* @__PURE__ */ new Map();
  start() {
    if (this.started) return;
    this.started = true;
    this.doc.addEventListener("click", this.click);
    this.doc.addEventListener("keydown", this.keydown);
    this.doc.addEventListener("close", this.closed, true);
    this.refresh();
  }
  dispose() {
    this.started = false;
    this.doc.removeEventListener("click", this.click);
    this.doc.removeEventListener("keydown", this.keydown);
    this.doc.removeEventListener("close", this.closed, true);
    this.reset();
  }
  reset() {
    for (const dialog of this.openers.keys()) if (dialog.open && typeof dialog.close === "function") dialog.close();
    this.openers.clear();
    for (const [scope, timer] of this.copied) {
      clearTimeout(timer);
      this.uncopy(scope);
    }
    this.copied.clear();
  }
  owned(scope, selector) {
    return Array.from(scope.querySelectorAll(selector)).filter((node) => node.closest("[data-portal-behavior]") === scope);
  }
  refresh() {
    for (const [dialog, opener] of this.openers) if (!dialog.isConnected) {
      this.openers.delete(dialog);
      if (opener.isConnected) opener.focus();
    }
    for (const scope of this.doc.querySelectorAll("[data-portal-behavior]")) {
      if (this.initialized.has(scope)) continue;
      const kind = scope.dataset.portalBehavior;
      if (kind === "quantity" && this.owned(scope, 'input[type="number"][data-portal-control="value"]').length !== 1) continue;
      if (kind === "copy") {
        const buttons = this.owned(scope, 'button[data-portal-command="copy"]');
        if (this.owned(scope, "[data-portal-copy-source]").length !== 1 || buttons.length !== 1 || !buttons[0].hasAttribute("data-portal-enhanced-only")) continue;
        const supplied = this.owned(scope, "[data-portal-copy-status]")[0];
        if (supplied) {
          if (!supplied.hasAttribute("role")) supplied.setAttribute("role", "status");
          if (!supplied.hasAttribute("aria-live")) supplied.setAttribute("aria-live", "polite");
        } else {
          const status = this.doc.createElement("span");
          status.setAttribute("data-portal-copy-status", "");
          status.setAttribute("role", "status");
          status.setAttribute("aria-live", "polite");
          Object.assign(status.style, { position: "absolute", width: "1px", height: "1px", overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" });
          scope.append(status);
        }
      }
      if (kind === "dialog") {
        const dialogs = this.owned(scope, "dialog");
        if (dialogs.length !== 1 || typeof dialogs[0].showModal !== "function") continue;
      }
      if (kind === "tabs") {
        const tabs = this.owned(scope, "button[data-portal-tab]");
        const panels = this.owned(scope, "[data-portal-panel]");
        const lists = this.owned(scope, "[data-portal-tablist]");
        if (lists.length !== 1 || !tabs.length || tabs.length !== panels.length || tabs.some((tab) => !tab.id || !lists[0].contains(tab) || panels.filter((panel) => panel.id && panel.id === this.panelID(tab)).length !== 1)) continue;
        if (new Set(tabs.map((tab) => this.panelID(tab))).size !== tabs.length || new Set(tabs.map((tab) => tab.id)).size !== tabs.length || tabs.every((tab) => tab.disabled)) continue;
        lists[0].setAttribute("role", "tablist");
        for (const tab of tabs) {
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-controls", this.panelID(tab));
          const panel = panels.find((panel2) => panel2.id === this.panelID(tab));
          panel.setAttribute("role", "tabpanel");
          panel.setAttribute("aria-labelledby", tab.id);
          panel.tabIndex = 0;
        }
        this.select(scope, tabs.find((tab) => !tab.disabled && tab.getAttribute("aria-selected") === "true") ?? tabs.find((tab) => !tab.disabled), false);
      } else if (kind !== "quantity" && kind !== "dialog" && kind !== "copy") continue;
      this.initialized.add(scope);
      for (const control of this.owned(scope, "[data-portal-enhanced-only]")) control.hidden = false;
    }
  }
  panelID(tab) {
    return tab.getAttribute("aria-controls") ?? tab.dataset.portalTab ?? "";
  }
  select(scope, selected, focus) {
    for (const tab of this.owned(scope, "button[data-portal-tab]")) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      for (const panel of this.owned(scope, "[data-portal-panel]")) if (panel.id === this.panelID(tab)) panel.hidden = !active;
    }
    if (focus) selected.focus();
  }
  click = (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const button = event.target?.closest("button");
    const scope = button?.closest("[data-portal-behavior]");
    if (!button || button.disabled || !scope || !this.initialized.has(scope)) return;
    if (scope.dataset.portalBehavior === "tabs" && button.hasAttribute("data-portal-tab")) {
      event.preventDefault();
      this.select(scope, button, false);
      return;
    }
    const command = button.dataset.portalCommand;
    if (scope.dataset.portalBehavior === "quantity" && ["increment", "decrement"].includes(command ?? "")) {
      const input = this.owned(scope, 'input[type="number"][data-portal-control="value"]')[0];
      if (!input || input.disabled || input.readOnly) return;
      event.preventDefault();
      const previous = input.value;
      try {
        command === "increment" ? input.stepUp() : input.stepDown();
      } catch {
        return;
      }
      if (input.value !== previous) {
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    if (scope.dataset.portalBehavior === "copy" && command === "copy") {
      event.preventDefault();
      void this.copy(scope);
    }
    if (scope.dataset.portalBehavior === "dialog") {
      const dialog = this.owned(scope, "dialog")[0];
      if (!dialog) return;
      const target = button.commandForElement;
      const native = command === "open" ? "show-modal" : command === "close" ? "close" : void 0;
      if (target === dialog && native && button.getAttribute("command") === native) {
        if (command === "open") this.openers.set(dialog, button);
        return;
      }
      if (command === "open" && typeof dialog.showModal === "function") {
        event.preventDefault();
        this.openers.set(dialog, button);
        if (!dialog.open) dialog.showModal();
      } else if (command === "close" && typeof dialog.close === "function") {
        event.preventDefault();
        dialog.close();
      }
    }
  };
  async copy(scope) {
    const source = this.owned(scope, "[data-portal-copy-source]")[0];
    const button = this.owned(scope, 'button[data-portal-command="copy"]')[0];
    const clipboard = this.doc.defaultView?.navigator.clipboard;
    if (!source || !button || typeof clipboard?.writeText !== "function") return;
    const text = source.localName === "input" || source.localName === "textarea" ? source.value : (source.textContent ?? "").trim();
    try {
      await clipboard.writeText(text);
    } catch {
      return;
    }
    if (!this.started || !scope.isConnected) return;
    const previous = this.copied.get(scope);
    if (previous !== void 0) clearTimeout(previous);
    scope.setAttribute("data-portal-copied", "");
    const status = this.owned(scope, "[data-portal-copy-status]")[0];
    if (status) {
      const message = this.owned(scope, "[data-portal-copied-text]")[0]?.textContent?.trim() || button.dataset.portalCopiedMessage || "Copied";
      status.textContent = "";
      clearTimeout(this.announcing.get(scope));
      this.announcing.set(scope, setTimeout(() => {
        this.announcing.delete(scope);
        if (scope.hasAttribute("data-portal-copied")) status.textContent = message;
      }, 0));
    }
    this.copied.set(scope, setTimeout(() => {
      this.copied.delete(scope);
      this.uncopy(scope);
    }, 2e3));
  }
  uncopy(scope) {
    clearTimeout(this.announcing.get(scope));
    this.announcing.delete(scope);
    scope.removeAttribute("data-portal-copied");
    const status = this.owned(scope, "[data-portal-copy-status]")[0];
    if (status) status.textContent = "";
  }
  keydown = (event) => {
    const tab = event.target?.closest("button[data-portal-tab]");
    const scope = tab?.closest('[data-portal-behavior="tabs"]');
    if (!tab || !scope || !this.initialized.has(scope)) return;
    const tabs = this.owned(scope, "button[data-portal-tab]").filter((item) => !item.disabled);
    const index = tabs.indexOf(tab);
    const vertical = this.owned(scope, "[data-portal-tablist]")[0]?.getAttribute("aria-orientation") === "vertical";
    const previous = vertical ? "ArrowUp" : "ArrowLeft", next = vertical ? "ArrowDown" : "ArrowRight";
    let target;
    if (event.key === "Home") target = tabs[0];
    if (event.key === "End") target = tabs.at(-1);
    if (event.key === next) target = tabs[(index + 1) % tabs.length];
    if (event.key === previous) target = tabs[(index + tabs.length - 1) % tabs.length];
    if (target) {
      event.preventDefault();
      this.select(scope, target, true);
    }
  };
  closed = (event) => {
    const dialog = event.target;
    const opener = this.openers.get(dialog);
    this.openers.delete(dialog);
    if (opener?.isConnected) opener.focus();
  };
};

// src/browser.ts
var PAGE = "[data-portal-page]";
var ICONS = "style[data-portal-icons]";
var COMPONENTS = "style[data-portal-components]";
var INSTANCE_FORM = "form[data-portal-instance]";
var INSTANCE = /^c[1-9][0-9]*$/;
var CHANGE_DEBOUNCE = 250;
var HISTORY = "__portalPosition";
var INDEX = "__portalIndex";
var PortalRuntime = class {
  constructor(options) {
    this.options = options;
    this.win = options.window;
    this.doc = this.win.document;
    this.behaviors = new PortalBehaviors(this.doc);
    const selection = JSON.parse(this.doc.documentElement.dataset.portalSelection ?? "{}");
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new Error("Invalid Portal selection metadata");
    this.routing = new PortalURLs({ basePath: this.doc.documentElement.dataset.portalBase ?? "/", selection });
    this.routing.unmount(this.win.location.pathname);
    this.serverShell = this.shell(this.doc);
    this.serverStructure = this.structure(this.doc);
    this.fetcher = options.fetch ?? this.win.fetch.bind(this.win);
    this.hard = options.hardNavigate ?? ((url) => this.win.location.assign(url));
    this.pageURL = this.win.location.href;
    this.historyIndex = Number.isInteger(this.win.history.state?.[INDEX]) ? this.win.history.state[INDEX] : 0;
    this.context = this.doc.documentElement.dataset.portalContext ?? "";
    this.version = this.doc.documentElement.dataset.portalVersion ?? "";
  }
  options;
  state = new StateStore({
    navigating: false,
    error: null
  });
  requests = new RequestScope();
  forms = /* @__PURE__ */ new Map();
  formLocks = /* @__PURE__ */ new Map();
  timers = /* @__PURE__ */ new Map();
  win;
  doc;
  fetcher;
  hard;
  routing;
  behaviors;
  composing = /* @__PURE__ */ new WeakSet();
  /** Per instance: the pending debounce and the in-flight live change. */
  changes = /* @__PURE__ */ new Map();
  historyRequest = 0;
  awaitingNavigation = false;
  /** URL helpers follow the current logical page after enhanced navigation. */
  get urls() {
    return new PortalURLs({
      basePath: this.routing.basePath,
      selection: this.routing.selection,
      currentPath: this.routing.unmount(this.win.location.pathname + this.win.location.search)
    });
  }
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
  start() {
    if (this.started || this.disposed) return;
    if (!this.context || !this.version || this.doc.querySelectorAll(PAGE).length !== 1)
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
    for (const region of this.doc.querySelectorAll(
      "[data-portal-region][aria-busy]"
    ))
      region.removeAttribute("aria-busy");
    this.forms.clear();
    for (const [form, controls] of this.formLocks)
      this.unlockForm(form, controls);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const change of this.changes.values()) {
      clearTimeout(change.timer);
      change.controller?.abort();
    }
    this.changes.clear();
    this.state.set({ navigating: false, error: null });
  }
  savePosition = () => {
    if (this.transitioning || this.disposed) return;
    this.win.history.replaceState(
      {
        ...this.win.history.state,
        [INDEX]: this.historyIndex,
        [HISTORY]: { x: this.win.scrollX, y: this.win.scrollY }
      },
      ""
    );
  };
  pop = (event) => {
    if (this.restoringHistory) {
      this.restoringHistory = false;
      return;
    }
    void this.navigate(
      this.win.location.href,
      "pop",
      event.state?.[HISTORY],
      event.state?.[INDEX]
    );
  };
  click = (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return;
    const target = event.target;
    if (typeof target?.closest !== "function") return;
    const link = target?.closest("a[href]");
    if (!link || link.hasAttribute("download") || ["asset", "endpoint"].includes(link.dataset.portalUrlKind ?? "") || link.target && link.target !== "_self" || link.closest("[data-portal-native]"))
      return;
    const url = new URL(link.href, this.win.location.href);
    if (!this.internal(url)) return;
    if (url.pathname === this.win.location.pathname && url.search === this.win.location.search && url.hash)
      return;
    event.preventDefault();
    if (link.dataset.portalTarget) {
      void this.refreshRegion(link.dataset.portalTarget, url.href, this.historyPolicy(link)).catch((error) => this.failure(link, error));
    } else void this.navigate(url.href);
  };
  endpoint(url) {
    const path2 = this.routing.unmount(url.pathname);
    return path2 === "/api" || path2.startsWith("/api/") || path2 === "/mcp" || path2.startsWith("/_portal/");
  }
  selectPage(url) {
    if (!this.endpoint(url)) {
      url.search = new URL(this.urls.page(url.pathname + url.search + url.hash), this.win.location.href).search;
    }
  }
  internal(url) {
    if (url.origin !== this.win.location.origin || !["http:", "https:"].includes(url.protocol)) return false;
    try {
      this.routing.unmount(url.pathname);
      return true;
    } catch {
      return false;
    }
  }
  async navigate(href, mode = "push", position, targetIndex) {
    if (this.disposed) return;
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
      allowed = !this.options.beforeNavigate || await this.options.beforeNavigate();
    } catch (error) {
      if (attempt === this.navigationAttempt) {
        this.rejectNavigation(mode, targetIndex);
        this.failure(this.doc.documentElement, error);
      }
      return;
    } finally {
      if (attempt === this.navigationAttempt) this.awaitingNavigation = false;
    }
    if (attempt !== this.navigationAttempt) return;
    if (!allowed) {
      this.rejectNavigation(mode, targetIndex);
      return;
    }
    if (mode !== "pop") this.savePosition();
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
          Accept: "text/html"
        }
      });
      const html = await response.text();
      if (!request.isCurrent()) return;
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
        this.win.history.pushState(
          { [INDEX]: ++this.historyIndex },
          "",
          destination
        );
      if (mode === "replace")
        this.win.history.replaceState(
          { [INDEX]: this.historyIndex },
          "",
          destination
        );
      if (mode === "pop" && typeof targetIndex === "number")
        this.historyIndex = targetIndex;
      this.pageURL = destination;
      this.restoreFocusAndScroll(position, new URL(destination).hash);
      this.state.set({ navigating: false, error: null });
    } catch (error) {
      if (!request.isCurrent()) return;
      this.state.set({ navigating: false, error });
      this.hard(url.href);
    } finally {
      if (request.isCurrent()) this.transitioning = false;
      request.finish();
    }
  }
  rejectNavigation(mode, targetIndex) {
    this.transitioning = false;
    this.state.set({ navigating: false, error: null });
    if (mode !== "pop") return;
    if (typeof targetIndex === "number" && targetIndex !== this.historyIndex) {
      this.restoringHistory = true;
      this.win.history.go(this.historyIndex - targetIndex);
    } else this.hard(this.pageURL);
  }
  compatible(response) {
    return response.headers.get("X-Portal-Context") === this.context && response.headers.get("X-Portal-Version") === this.version && (response.headers.get("content-type") ?? "").includes("text/html");
  }
  parse(html) {
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
    for (const node of head.querySelectorAll(
      `title, meta[name]:not([name="viewport"]), meta[property], link[rel="canonical"], link[rel~="icon"], script[type="application/ld+json"], ${ICONS}, ${COMPONENTS}`
    )) node.remove();
    return root.outerHTML + head.outerHTML;
  }
  routingCompatible(root) {
    try {
      const selection = JSON.parse(root.dataset.portalSelection ?? "{}");
      const incoming = new PortalURLs({ basePath: root.dataset.portalBase ?? "/", selection });
      return incoming.basePath === this.routing.basePath && JSON.stringify(Object.entries(incoming.selection).sort()) === JSON.stringify(Object.entries(this.routing.selection).sort());
    } catch {
      return false;
    }
  }
  pageCompatible(page) {
    if (!this.routingCompatible(page.documentElement) || page.documentElement.dataset.portalContext !== this.context || page.documentElement.dataset.portalVersion !== this.version || page.querySelectorAll(PAGE).length !== 1 || this.shell(page) !== this.serverShell || this.structure(page) !== this.serverStructure)
      return false;
    const assets = (doc) => Array.from(
      doc.querySelectorAll(
        'head link[rel="stylesheet"], head style:not([data-portal-icons]):not([data-portal-components]), head meta[charset], head meta[name="viewport"], script[src]'
      )
    ).map((node) => node.outerHTML).join("");
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
    if (!incoming.length) return;
    let live = this.doc.head.querySelector(selector);
    const present = (live?.textContent ?? "").split("\n").filter(Boolean);
    const missing = [...new Set(incoming)].filter((rule) => !present.includes(rule));
    if (!missing.length) return;
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
    this.doc.querySelector(PAGE).replaceWith(this.doc.importNode(page.querySelector(PAGE), true));
    this.doc.title = page.title;
    this.doc.documentElement.lang = page.documentElement.lang;
    this.doc.documentElement.dir = page.documentElement.dir;
    const metadata = 'meta[name]:not([name="viewport"]), meta[property], link[rel="canonical"], link[rel~="icon"], script[type="application/ld+json"]';
    for (const node of this.doc.head.querySelectorAll(metadata)) node.remove();
    for (const node of page.head.querySelectorAll(metadata))
      this.doc.head.append(this.doc.importNode(node, true));
    this.behaviors.refresh();
    this.doc.dispatchEvent(new CustomEvent("portal:navigated"));
  }
  restoreFocusAndScroll(position, hash = "") {
    const heading = this.doc.querySelector(`${PAGE} h1`) ?? this.doc.querySelector(PAGE);
    if (heading) {
      if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    let anchor = null;
    try {
      anchor = hash ? this.doc.getElementById(decodeURIComponent(hash.slice(1))) : null;
    } catch {
    }
    if (position) this.win.scrollTo(position.x, position.y);
    else if (anchor) anchor.scrollIntoView();
    else this.win.scrollTo(0, 0);
  }
  submit = (event) => {
    const form = event.target;
    if (event.defaultPrevented || form.tagName !== "FORM" || ["asset", "endpoint"].includes(form.dataset.portalUrlKind ?? "") || form.closest("[data-portal-native]"))
      return;
    const submitter = event.submitter;
    const target = submitter?.getAttribute("formtarget") ?? form.target;
    if (target && target !== "_self") return;
    const action = submitter?.getAttribute("formaction") ?? form.action;
    const method = (submitter?.getAttribute("formmethod") ?? form.method).toUpperCase();
    const url = new URL(action, this.win.location.href);
    if (!this.internal(url) || !["GET", "POST"].includes(method)) return;
    if (!form.noValidate && !submitter?.formNoValidate && !form.checkValidity())
      return;
    event.preventDefault();
    const data = new FormData(form, submitter);
    const region = form.dataset.portalTarget ?? this.eventInstance(form);
    if (method === "GET") {
      url.search = "";
      for (const [key, value] of data)
        if (typeof value === "string") url.searchParams.append(key, value);
      if (!this.endpoint(url)) {
        for (const [key, value] of Object.entries(this.routing.selection)) url.searchParams.set(key, value);
      }
      if (region)
        void this.refreshRegion(region, url.href, this.historyPolicy(form)).catch(
          (error) => this.failure(form, error)
        );
      else void this.navigate(url.href);
    } else {
      const body = new URLSearchParams();
      for (const [key, value] of data) {
        if (typeof value !== "string") {
          this.failure(
            form,
            new Error("File forms require the Folder upload adapter")
          );
          return;
        }
        body.append(key, value);
      }
      void this.postForm(form, url, body, region);
    }
  };
  historyPolicy(element) {
    const policy = element.dataset.portalHistory ?? "none";
    if (!["none", "replace", "advance"].includes(policy)) throw new Error("Invalid Portal history policy");
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
    if (form) this.composing.delete(form);
    this.input(event);
  };
  /** The instance a component event form belongs to: its hidden instance form,
   * or an author's t:submit form inside the instance. */
  eventInstance(form) {
    if (form.matches(INSTANCE_FORM)) return INSTANCE.test(form.id) ? form.id : void 0;
    if (!form.querySelector('input[name="_portal_instance"]')) return void 0;
    return this.instanceRoot(form)?.dataset.portalRegion;
  }
  instanceRoot(element) {
    let region = element.closest("[data-portal-region]");
    while (region && !INSTANCE.test(region.dataset.portalRegion ?? ""))
      region = region.parentElement?.closest("[data-portal-region]") ?? null;
    return region ?? void 0;
  }
  /** t:change: debounce, then post the instance form for its live parts only.
   * A newer change aborts the request in flight, so a slow response never
   * overwrites a newer one. */
  scheduleChange(container) {
    const root = this.instanceRoot(container);
    const instance = root?.dataset.portalRegion;
    const exportName = container.dataset.portalChange;
    if (!instance || !exportName) return;
    const form = this.doc.getElementById(instance);
    if (!(form instanceof HTMLFormElement) || !form.matches(INSTANCE_FORM)) return;
    const state = this.changes.get(instance) ?? {};
    clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = void 0;
      void this.postChange(instance, exportName, container);
    }, CHANGE_DEBOUNCE);
    this.changes.set(instance, state);
  }
  async postChange(instance, exportName, container) {
    const form = this.doc.getElementById(instance);
    const state = this.changes.get(instance);
    if (this.disposed || !state || !(form instanceof HTMLFormElement)) return;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const epoch = this.epoch;
    const body = new URLSearchParams();
    for (const [key, value] of new FormData(form)) if (typeof value === "string") body.append(key, value);
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
          Accept: "text/html"
        }
      });
      const html = await response.text();
      if (!current()) return;
      if (response.status === 409 || response.status === 401 || !this.compatible(response)) {
        this.invalidate();
        this.hard(this.win.location.href);
        return;
      }
      if (!response.ok && response.status !== 422) throw new Error(`Component event failed (${response.status})`);
      const parsed = this.parse(html);
      if (this.isWholePage(html)) {
        if (!this.pageCompatible(parsed)) {
          this.invalidate();
          this.hard(this.win.location.href);
          return;
        }
        this.replacePage(parsed);
        return;
      }
      const metadata = parsed.querySelector("[data-portal-fragment]") ?? parsed.documentElement;
      if (!this.routingCompatible(metadata)) throw new Error("Region response changed Portal routing context");
      this.adoptIcons(parsed);
      this.adoptComponentStyles(parsed);
      this.replaceLiveParts(instance, parsed);
      this.adoptInstanceForms(parsed);
      this.behaviors.refresh();
      this.doc.dispatchEvent(new CustomEvent("portal:region", { detail: { name: instance } }));
    } catch (error) {
      if (current()) this.failure(container, error);
    } finally {
      if (state.controller === controller) state.controller = void 0;
    }
  }
  /** A complete document rather than a region fragment. */
  isWholePage(html) {
    return /^\s*<!doctype html>/i.test(html);
  }
  /** Swap an instance's live parts, never one holding the focused control. */
  replaceLiveParts(instance, parsed) {
    const active = this.doc.activeElement;
    for (const part of Array.from(this.doc.querySelectorAll("[data-portal-region]"))) {
      const name = part.dataset.portalRegion ?? "";
      if (!name.startsWith(instance + "-") || active && part.contains(active)) continue;
      const replacement = this.region(parsed, name);
      if (replacement) part.replaceWith(this.doc.importNode(replacement, true));
    }
  }
  /** A response's instance forms carry fresh tokens: replace or add them. */
  adoptInstanceForms(parsed) {
    for (const incoming of Array.from(parsed.querySelectorAll(INSTANCE_FORM))) {
      const existing = incoming.id ? this.doc.getElementById(incoming.id) : null;
      const imported = this.doc.importNode(incoming, true);
      if (existing instanceof HTMLFormElement && existing.matches(INSTANCE_FORM)) {
        this.forms.get(existing)?.invalidate();
        this.forms.delete(existing);
        existing.replaceWith(imported);
      } else this.doc.querySelector(PAGE)?.append(imported);
    }
  }
  input = (event) => {
    const changed = event.target?.closest?.("[data-portal-change]");
    if (changed && !event.isComposing) {
      this.scheduleChange(changed);
      return;
    }
    if (event.type === "change") return;
    const control = event.target;
    const form = control.form;
    if (!form?.hasAttribute("data-portal-live") || this.composing.has(form) || event.isComposing || form.method.toUpperCase() !== "GET" || !form.dataset.portalTarget)
      return;
    const delay = Number(form.dataset.portalDebounce ?? 150);
    clearTimeout(this.timers.get(form));
    this.timers.set(
      form,
      setTimeout(
        () => {
          this.timers.delete(form);
          if (form.isConnected) form.requestSubmit();
        },
        Number.isFinite(delay) ? Math.max(0, Math.min(delay, 2e3)) : 150
      )
    );
  };
  async refreshRegion(name, href, history = "none") {
    if (this.disposed) return;
    const url = new URL(this.urls.asset(href), this.win.location.href);
    if (!this.internal(url)) throw new Error("Region URL must be inside the Portal mount");
    this.selectPage(url);
    const target = this.region(this.doc, name);
    if (!target) throw new Error("Region target must be unique");
    if (!["none", "replace", "advance"].includes(history)) throw new Error("Invalid Portal history policy");
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
          Accept: "text/html"
        }
      });
      const html = await response.text();
      if (!request.isCurrent() || this.region(this.doc, name) !== target)
        return;
      if (!this.compatible(response)) {
        this.invalidate();
        this.hard(this.win.location.href);
        return;
      }
      if (response.url && !this.internal(new URL(response.url))) throw new Error("Region redirect left the Portal mount");
      if (!response.ok)
        throw new Error(`Region request failed (${response.status})`);
      if (history !== "none" && historyRequest !== this.historyRequest) return;
      this.replaceRegion(name, html);
      if (history !== "none") {
        const destination = response.url ? new URL(response.url) : new URL(url);
        if (!response.redirected) destination.hash = url.hash;
        if (history === "advance") {
          this.savePosition();
          this.win.history.pushState({ [INDEX]: ++this.historyIndex }, "", destination.href);
        } else this.win.history.replaceState({ ...this.win.history.state, [INDEX]: this.historyIndex }, "", destination.href);
        this.pageURL = destination.href;
      }
      this.feedback(name, "success");
    } catch (error) {
      if (request.isCurrent()) this.failure(target, error);
    } finally {
      if (request.isCurrent()) target.removeAttribute("aria-busy");
      request.finish();
    }
  }
  region(doc, name) {
    const matches = Array.from(
      doc.querySelectorAll("[data-portal-region]")
    ).filter((node) => node.dataset.portalRegion === name);
    return matches.length === 1 ? matches[0] : null;
  }
  replaceRegion(name, html) {
    const target = this.region(this.doc, name);
    const parsed = this.parse(html);
    const metadata = parsed.querySelector("[data-portal-fragment]") ?? parsed.documentElement;
    if (!this.routingCompatible(metadata)) throw new Error("Region response changed Portal routing context");
    const replacement = this.region(parsed, name);
    if (!target || !replacement)
      throw new Error("Region response must contain one matching root");
    const active = this.doc.activeElement;
    if (active && target.contains(active) && active.matches("input,textarea,select")) {
      if (!INSTANCE.test(name))
        throw new Error("Cannot replace a region containing the focused input");
      this.adoptIcons(parsed);
      this.adoptComponentStyles(parsed);
      this.replaceLiveParts(name, parsed);
      this.adoptInstanceForms(parsed);
      this.behaviors.refresh();
      this.doc.dispatchEvent(new CustomEvent("portal:region", { detail: { name } }));
      return;
    }
    for (const child of target.querySelectorAll(
      "[data-portal-region]"
    )) {
      if (child.dataset.portalRegion)
        this.requests.cancel(`region:${child.dataset.portalRegion}`);
    }
    for (const [form, activity] of this.forms) {
      if (target.contains(form)) {
        activity.invalidate();
        this.forms.delete(form);
        const controls = this.formLocks.get(form);
        if (controls) this.unlockForm(form, controls);
      }
    }
    replacement.removeAttribute("aria-busy");
    this.adoptIcons(parsed);
    this.adoptComponentStyles(parsed);
    target.replaceWith(this.doc.importNode(replacement, true));
    this.adoptInstanceForms(parsed);
    this.behaviors.refresh();
    this.doc.dispatchEvent(
      new CustomEvent("portal:region", { detail: { name } })
    );
  }
  async postForm(form, url, data, region) {
    if (this.disposed) return;
    let activity = this.forms.get(form);
    if (!activity) {
      activity = new FormActivity();
      this.forms.set(form, activity);
    }
    if (activity.state.getSnapshot().pending) return;
    const epoch = this.epoch;
    if (region) this.requests.cancel(`region:${region}`);
    const headers = {
      "X-Portal-Request": region ? "region" : "navigation",
      "X-Portal-Context": this.context,
      "X-Portal-Version": this.version,
      Accept: "text/html"
    };
    if (region) data.set("_portal_region", region);
    form.setAttribute("aria-busy", "true");
    this.feedback(region ?? "page", "loading");
    const controls = this.lockForm(form);
    await activity.submit(
      async () => {
        const response = await this.fetcher(url.href, {
          method: "POST",
          body: data,
          credentials: "same-origin",
          headers
        });
        return { response, html: await response.text() };
      },
      ({ response, html }) => {
        if (epoch !== this.epoch || !this.doc.contains(form)) return;
        if (response.status === 409 || response.status === 401) {
          this.invalidate();
          this.hard(
            response.redirected ? response.url : this.win.location.href
          );
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
          this.hard(
            response.redirected ? response.url : this.win.location.href
          );
          return;
        }
        if (region && !response.redirected && !this.isWholePage(html)) {
          this.requests.cancel(`region:${region}`);
          this.replaceRegion(region, html);
          this.feedback(region, "success");
        } else {
          const page = this.parse(html);
          if (!this.pageCompatible(page)) {
            this.invalidate();
            this.hard(
              response.redirected ? response.url : this.win.location.href
            );
            return;
          }
          this.invalidate();
          this.replacePage(page);
          if (response.redirected)
            this.win.history.pushState(
              { [INDEX]: ++this.historyIndex },
              "",
              response.url
            );
          if (response.redirected) this.pageURL = response.url;
          this.restoreFocusAndScroll();
          this.feedback("page", "success");
        }
      }
    );
    this.unlockForm(form, controls);
    if (epoch === this.epoch && this.forms.get(form) === activity)
      form.removeAttribute("aria-busy");
    const error = activity.state.getSnapshot().error;
    if (error && epoch === this.epoch) this.failure(form, error);
  }
  lockForm(form) {
    const controls = Array.from(form.elements).filter(
      (element) => ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(element.tagName)
    ).filter((control) => !control.disabled);
    for (const control of controls) control.disabled = true;
    this.formLocks.set(form, controls);
    return controls;
  }
  unlockForm(form, controls) {
    if (this.formLocks.get(form) !== controls) return;
    for (const control of controls) control.disabled = false;
    this.formLocks.delete(form);
  }
  feedback(name, state) {
    for (const outlet of this.doc.querySelectorAll("[data-portal-status]")) {
      if (outlet.dataset.portalStatus !== name) continue;
      const fallback = state === "loading" ? "Loading\u2026" : state === "error" ? "Unable to update. Please try again." : "Updated.";
      outlet.setAttribute("role", "status");
      outlet.setAttribute("aria-live", "polite");
      outlet.textContent = outlet.getAttribute(`data-portal-${state}-message`) ?? fallback;
    }
  }
  failure(target, error) {
    const element = target;
    this.feedback(element.dataset.portalTarget ?? element.dataset.portalRegion ?? "page", "error");
    this.state.set({ navigating: false, error });
    target.dispatchEvent(
      new CustomEvent("portal:error", { bubbles: true, detail: { error } })
    );
  }
};

// src/auto.ts
var runtime = new PortalRuntime({ window });
runtime.start();
window.addEventListener("pagehide", () => runtime.invalidate());
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
export {
  runtime
};
/*!
MIT License

Copyright (c) 2026 Triple C Labs GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
