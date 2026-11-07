import { FormActivity, RequestScope, StateStore } from "./state.js";

export interface PortalRuntimeOptions {
  window: Window;
  fetch?: typeof fetch;
  /** Host owns localized unsaved-change UI. False leaves the current document. */
  beforeNavigate?: () => boolean | Promise<boolean>;
  hardNavigate?: (url: string) => void;
}
type Position = { x: number; y: number };
type FormControl =
  | HTMLInputElement
  | HTMLSelectElement
  | HTMLTextAreaElement
  | HTMLButtonElement;
const PAGE = "[data-portal-page]";
const HISTORY = "__portalPosition";
const INDEX = "__portalIndex";

/** Enhances ordinary SSR HTML. It never evaluates template expressions or Lua. */
export class PortalRuntime {
  readonly state = new StateStore<{ navigating: boolean; error: unknown }>({
    navigating: false,
    error: null,
  });
  private readonly requests = new RequestScope();
  private readonly forms = new Map<HTMLFormElement, FormActivity>();
  private readonly formLocks = new Map<HTMLFormElement, FormControl[]>();
  private readonly timers = new Map<
    HTMLFormElement,
    ReturnType<typeof setTimeout>
  >();
  private readonly win: Window;
  private readonly doc: Document;
  private readonly fetcher: typeof fetch;
  private readonly hard: (url: string) => void;
  private readonly serverShell: string;
  private readonly serverStructure: string;
  private epoch = 0;
  private navigationAttempt = 0;
  private historyIndex = 0;
  private restoringHistory = false;
  private pageURL = "";
  private started = false;
  private disposed = false;
  private transitioning = false;
  private context: string;
  private version: string;
  private oldScrollRestoration: ScrollRestoration = "auto";
  constructor(private readonly options: PortalRuntimeOptions) {
    this.win = options.window;
    this.doc = this.win.document;
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
  start(): void {
    if (this.started || this.disposed) return;
    if (
      !this.context ||
      !this.version ||
      this.doc.querySelectorAll(PAGE).length !== 1
    )
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
  dispose(): void {
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
  invalidate(): void {
    ++this.epoch;
    ++this.navigationAttempt;
    this.transitioning = false;
    this.requests.reset();
    for (const [element, form] of this.forms) {
      form.invalidate();
      element.removeAttribute("aria-busy");
    }
    for (const region of this.doc.querySelectorAll(
      "[data-portal-region][aria-busy]",
    ))
      region.removeAttribute("aria-busy");
    this.forms.clear();
    for (const [form, controls] of this.formLocks)
      this.unlockForm(form, controls);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.state.set({ navigating: false, error: null });
  }
  private savePosition = (): void => {
    if (this.transitioning || this.disposed) return;
    this.win.history.replaceState(
      {
        ...this.win.history.state,
        [INDEX]: this.historyIndex,
        [HISTORY]: { x: this.win.scrollX, y: this.win.scrollY },
      },
      "",
    );
  };
  private pop = (event: PopStateEvent): void => {
    if (this.restoringHistory) {
      this.restoringHistory = false;
      return;
    }
    void this.navigate(
      this.win.location.href,
      "pop",
      event.state?.[HISTORY] as Position | undefined,
      event.state?.[INDEX] as number | undefined,
    );
  };
  private click = (event: MouseEvent): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey
    )
      return;
    const target = event.target as Element | null;
    if (typeof target?.closest !== "function") return;
    const link = target?.closest<HTMLAnchorElement>("a[href]");
    if (
      !link ||
      link.hasAttribute("download") ||
      (link.target && link.target !== "_self") ||
      link.closest("[data-portal-native]")
    )
      return;
    const url = new URL(link.href, this.win.location.href);
    if (!this.internal(url)) return;
    if (
      url.pathname === this.win.location.pathname &&
      url.search === this.win.location.search &&
      url.hash
    )
      return;
    event.preventDefault();
    void this.navigate(url.href);
  };
  private internal(url: URL): boolean {
    return (
      url.origin === this.win.location.origin &&
      ["http:", "https:"].includes(url.protocol)
    );
  }
  async navigate(
    href: string,
    mode: "push" | "pop" | "replace" = "push",
    position?: Position,
    targetIndex?: number,
  ): Promise<void> {
    if (this.disposed) return;
    const url = new URL(href, this.win.location.href);
    if (!this.internal(url)) {
      this.hard(url.href);
      return;
    }
    this.requests.cancel("navigation");
    this.transitioning = mode === "pop";
    const attempt = ++this.navigationAttempt;
    let allowed: boolean;
    try {
      allowed =
        !this.options.beforeNavigate || (await this.options.beforeNavigate());
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
          Accept: "text/html",
        },
      });
      const html = await response.text();
      if (!request.isCurrent()) return;
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
        this.win.history.pushState(
          { [INDEX]: ++this.historyIndex },
          "",
          destination,
        );
      if (mode === "replace")
        this.win.history.replaceState(
          { [INDEX]: this.historyIndex },
          "",
          destination,
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
  private rejectNavigation(
    mode: "push" | "pop" | "replace",
    targetIndex?: number,
  ): void {
    this.transitioning = false;
    this.state.set({ navigating: false, error: null });
    if (mode !== "pop") return;
    if (typeof targetIndex === "number" && targetIndex !== this.historyIndex) {
      this.restoringHistory = true;
      this.win.history.go(this.historyIndex - targetIndex);
    } else this.hard(this.pageURL);
  }
  private compatible(response: Response): boolean {
    return (
      response.headers.get("X-Portal-Context") === this.context &&
      response.headers.get("X-Portal-Version") === this.version &&
      (response.headers.get("content-type") ?? "").includes("text/html")
    );
  }
  private parse(html: string): Document {
    // DOMParser and imported script nodes do not execute page-provided scripts.
    return new DOMParser().parseFromString(html, "text/html");
  }
  /** Compare incoming server layout with the original server layout, not live
   * DOM: client-owned edits in a compatible persistent shell must survive. */
  private shell(page: Document): string {
    const body = page.body.cloneNode(true) as HTMLBodyElement;
    for (const content of body.querySelectorAll(PAGE)) {
      content.replaceWith(page.createComment("portal-page-slot"));
    }
    return body.outerHTML;
  }
  private structure(page: Document): string {
    const root = page.documentElement.cloneNode(false) as HTMLElement;
    root.removeAttribute("lang");
    root.removeAttribute("dir");
    const head = page.head.cloneNode(true) as HTMLHeadElement;
    // Only metadata explicitly synchronized by replacePage may differ.
    for (const node of head.querySelectorAll(
      'title, meta[name]:not([name="viewport"]), meta[property], link[rel="canonical"], link[rel~="icon"], script[type="application/ld+json"]',
    )) node.remove();
    return root.outerHTML + head.outerHTML;
  }
  private pageCompatible(page: Document): boolean {
    if (
      page.documentElement.dataset.portalContext !== this.context ||
      page.documentElement.dataset.portalVersion !== this.version ||
      page.querySelectorAll(PAGE).length !== 1 ||
      this.shell(page) !== this.serverShell ||
      this.structure(page) !== this.serverStructure
    )
      return false;
    // Asset/layout changes get native navigation rather than partially loading code.
    const assets = (doc: Document) =>
      Array.from(
        doc.querySelectorAll(
          'head link[rel="stylesheet"], head style, head meta[charset], head meta[name="viewport"], script[src]',
        ),
      )
        .map((node) => node.outerHTML)
        .join("");
    return assets(page) === assets(this.doc);
  }
  private replacePage(page: Document): void {
    this.doc
      .querySelector(PAGE)!
      .replaceWith(this.doc.importNode(page.querySelector(PAGE)!, true));
    this.doc.title = page.title;
    this.doc.documentElement.lang = page.documentElement.lang;
    this.doc.documentElement.dir = page.documentElement.dir;
    const metadata =
      'meta[name]:not([name="viewport"]), meta[property], link[rel="canonical"], link[rel~="icon"], script[type="application/ld+json"]';
    for (const node of this.doc.head.querySelectorAll(metadata)) node.remove();
    for (const node of page.head.querySelectorAll(metadata))
      this.doc.head.append(this.doc.importNode(node, true));
    this.doc.dispatchEvent(new CustomEvent("portal:navigated"));
  }
  private restoreFocusAndScroll(position?: Position, hash = ""): void {
    const heading =
      this.doc.querySelector<HTMLElement>(`${PAGE} h1`) ??
      this.doc.querySelector<HTMLElement>(PAGE);
    if (heading) {
      if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    let anchor: HTMLElement | null = null;
    try {
      anchor = hash
        ? this.doc.getElementById(decodeURIComponent(hash.slice(1)))
        : null;
    } catch {
      /* malformed fragment: use top */
    }
    if (position) this.win.scrollTo(position.x, position.y);
    else if (anchor) anchor.scrollIntoView();
    else this.win.scrollTo(0, 0);
  }
  private submit = (event: SubmitEvent): void => {
    const form = event.target as HTMLFormElement;
    if (
      event.defaultPrevented ||
      form.tagName !== "FORM" ||
      form.closest("[data-portal-native]")
    )
      return;
    const submitter = event.submitter as
      HTMLButtonElement | HTMLInputElement | null;
    const target = submitter?.getAttribute("formtarget") ?? form.target;
    if (target && target !== "_self") return;
    const action = submitter?.getAttribute("formaction") ?? form.action;
    const method = (
      submitter?.getAttribute("formmethod") ?? form.method
    ).toUpperCase();
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
        void this.refreshRegion(region, url.href).catch((error) =>
          this.failure(form, error),
        );
      else void this.navigate(url.href);
    } else {
      const body = new URLSearchParams();
      for (const [key, value] of data) {
        if (typeof value !== "string") {
          this.failure(
            form,
            new Error("File forms require the Folder upload adapter"),
          );
          return;
        }
        body.append(key, value);
      }
      void this.postForm(form, url, body, region);
    }
  };
  private input = (event: Event): void => {
    const control = event.target as HTMLInputElement;
    const form = control.form;
    if (
      !form?.hasAttribute("data-portal-live") ||
      form.method.toUpperCase() !== "GET" ||
      !form.dataset.portalTarget
    )
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
        Number.isFinite(delay) ? Math.max(0, Math.min(delay, 2000)) : 150,
      ),
    );
  };
  async refreshRegion(name: string, href: string): Promise<void> {
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
  private region(doc: Document, name: string): HTMLElement | null {
    const matches = Array.from(
      doc.querySelectorAll<HTMLElement>("[data-portal-region]"),
    ).filter((node) => node.dataset.portalRegion === name);
    return matches.length === 1 ? matches[0] : null;
  }
  private replaceRegion(name: string, html: string): void {
    const target = this.region(this.doc, name);
    const replacement = this.region(this.parse(html), name);
    if (!target || !replacement)
      throw new Error("Region response must contain one matching root");
    const active = this.doc.activeElement;
    // Forms should be siblings of their result region. Never destroy live input.
    if (
      active &&
      target.contains(active) &&
      active.matches("input,textarea,select")
    )
      throw new Error("Cannot replace a region containing the focused input");
    for (const child of target.querySelectorAll<HTMLElement>(
      "[data-portal-region]",
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
      new CustomEvent("portal:region", { detail: { name } }),
    );
  }
  private async postForm(
    form: HTMLFormElement,
    url: URL,
    data: URLSearchParams,
    region?: string,
  ): Promise<void> {
    if (this.disposed) return;
    let activity = this.forms.get(form);
    if (!activity) {
      activity = new FormActivity();
      this.forms.set(form, activity);
    }
    if (activity.state.getSnapshot().pending) return;
    const epoch = this.epoch;
    if (region) this.requests.cancel(`region:${region}`);
    const headers: Record<string, string> = {
      "X-Portal-Request": region ? "region" : "navigation",
      "X-Portal-Context": this.context,
      "X-Portal-Version": this.version,
      Accept: "text/html",
    };
    // Fetch forwards custom headers across a 303. Keep the POST-only target
    // in the body so redirected GETs request a complete destination document.
    if (region) data.set("_portal_region", region);
    form.setAttribute("aria-busy", "true");
    const controls = this.lockForm(form);
    await activity.submit(
      async () => {
        const response = await this.fetcher(url.href, {
          method: "POST",
          body: data,
          credentials: "same-origin",
          headers,
        });
        return { response, html: await response.text() };
      },
      ({ response, html }) => {
        if (epoch !== this.epoch || !this.doc.contains(form)) return;
        if (response.status === 409 || response.status === 401) {
          this.invalidate();
          this.hard(
            response.redirected ? response.url : this.win.location.href,
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
            response.redirected ? response.url : this.win.location.href,
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
              response.redirected ? response.url : this.win.location.href,
            );
            return;
          }
          this.invalidate();
          this.replacePage(page);
          if (response.redirected)
            this.win.history.pushState(
              { [INDEX]: ++this.historyIndex },
              "",
              response.url,
            );
          if (response.redirected) this.pageURL = response.url;
          this.restoreFocusAndScroll();
        }
      },
    );
    this.unlockForm(form, controls);
    if (epoch === this.epoch && this.forms.get(form) === activity)
      form.removeAttribute("aria-busy");
    const error = activity.state.getSnapshot().error;
    if (error && epoch === this.epoch) this.failure(form, error);
  }
  private lockForm(form: HTMLFormElement): FormControl[] {
    const controls = Array.from(form.elements)
      .filter((element): element is FormControl =>
        ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(element.tagName),
      )
      .filter((control) => !control.disabled);
    for (const control of controls) control.disabled = true;
    this.formLocks.set(form, controls);
    return controls;
  }
  private unlockForm(form: HTMLFormElement, controls: FormControl[]): void {
    if (this.formLocks.get(form) !== controls) return;
    for (const control of controls) control.disabled = false;
    this.formLocks.delete(form);
  }
  private failure(target: Element, error: unknown): void {
    this.state.set({ navigating: false, error });
    target.dispatchEvent(
      new CustomEvent("portal:error", { bubbles: true, detail: { error } }),
    );
  }
}
