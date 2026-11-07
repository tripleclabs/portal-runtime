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

// src/browser.ts
var PAGE = "[data-portal-page]";
var HISTORY = "__portalPosition";
var INDEX = "__portalIndex";
var PortalRuntime = class {
  constructor(options) {
    this.options = options;
    this.win = options.window;
    this.doc = this.win.document;
    this.serverShell = this.shell(this.doc);
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
  serverShell;
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
    this.win.removeEventListener("popstate", this.pop);
    this.win.removeEventListener("scroll", this.savePosition);
    this.win.history.scrollRestoration = this.oldScrollRestoration;
  }
  /** Host calls before an identity switch; no previous response can then apply. */
  invalidate() {
    ++this.epoch;
    ++this.navigationAttempt;
    this.transitioning = false;
    this.requests.reset();
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
    if (!link || link.hasAttribute("download") || link.target && link.target !== "_self" || link.closest("[data-portal-native]"))
      return;
    const url = new URL(link.href, this.win.location.href);
    if (!this.internal(url)) return;
    if (url.pathname === this.win.location.pathname && url.search === this.win.location.search && url.hash)
      return;
    event.preventDefault();
    void this.navigate(url.href);
  };
  internal(url) {
    return url.origin === this.win.location.origin && ["http:", "https:"].includes(url.protocol);
  }
  async navigate(href, mode = "push", position, targetIndex) {
    if (this.disposed) return;
    const url = new URL(href, this.win.location.href);
    if (!this.internal(url)) {
      this.hard(url.href);
      return;
    }
    this.requests.cancel("navigation");
    this.transitioning = mode === "pop";
    const attempt = ++this.navigationAttempt;
    let allowed;
    try {
      allowed = !this.options.beforeNavigate || await this.options.beforeNavigate();
    } catch (error) {
      if (attempt === this.navigationAttempt) {
        this.rejectNavigation(mode, targetIndex);
        this.failure(this.doc.documentElement, error);
      }
      return;
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
      const destination = response.url || url.href;
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
  pageCompatible(page) {
    if (page.documentElement.dataset.portalContext !== this.context || page.documentElement.dataset.portalVersion !== this.version || page.querySelectorAll(PAGE).length !== 1 || this.shell(page) !== this.serverShell)
      return false;
    const assets = (doc) => Array.from(
      doc.querySelectorAll(
        'head link[rel="stylesheet"], head style, head meta[charset], head meta[name="viewport"], script[src]'
      )
    ).map((node) => node.outerHTML).join("");
    return assets(page) === assets(this.doc);
  }
  replacePage(page) {
    this.doc.querySelector(PAGE).replaceWith(this.doc.importNode(page.querySelector(PAGE), true));
    this.doc.title = page.title;
    this.doc.documentElement.lang = page.documentElement.lang;
    this.doc.documentElement.dir = page.documentElement.dir;
    const metadata = 'meta[name]:not([name="viewport"]), meta[property], link[rel="canonical"], link[rel~="icon"], script[type="application/ld+json"]';
    for (const node of this.doc.head.querySelectorAll(metadata)) node.remove();
    for (const node of page.head.querySelectorAll(metadata))
      this.doc.head.append(this.doc.importNode(node, true));
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
    if (event.defaultPrevented || form.tagName !== "FORM" || form.closest("[data-portal-native]"))
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
    const region = form.dataset.portalTarget;
    if (method === "GET") {
      url.search = "";
      for (const [key, value] of data)
        if (typeof value === "string") url.searchParams.append(key, value);
      if (region)
        void this.refreshRegion(region, url.href).catch(
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
  input = (event) => {
    const control = event.target;
    const form = control.form;
    if (!form?.hasAttribute("data-portal-live") || form.method.toUpperCase() !== "GET" || !form.dataset.portalTarget)
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
  async refreshRegion(name, href) {
    if (this.disposed) return;
    const url = new URL(href, this.win.location.href);
    if (!this.internal(url)) throw new Error("Region URL must be same-origin");
    const target = this.region(this.doc, name);
    if (!target) throw new Error("Region target must be unique");
    const request = this.requests.begin(`region:${name}`);
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
      if (!response.ok)
        throw new Error(`Region request failed (${response.status})`);
      this.replaceRegion(name, html);
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
    const replacement = this.region(this.parse(html), name);
    if (!target || !replacement)
      throw new Error("Region response must contain one matching root");
    const active = this.doc.activeElement;
    if (active && target.contains(active) && active.matches("input,textarea,select"))
      throw new Error("Cannot replace a region containing the focused input");
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
    target.replaceWith(this.doc.importNode(replacement, true));
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
        if (region && !response.redirected) {
          this.requests.cancel(`region:${region}`);
          this.replaceRegion(region, html);
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
  failure(target, error) {
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
