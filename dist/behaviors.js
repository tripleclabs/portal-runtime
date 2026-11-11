/** Trusted DOM controllers. Configuration is data, never JavaScript expressions. */
export class PortalBehaviors {
    doc;
    started = false;
    initialized = new WeakSet();
    /** Per initialised scope, the server markup it was initialised from. A
     * morph leaves a scope alone while the server still renders that markup. */
    markup = new WeakMap();
    /** Server markup for a scope a morph patched, used when it initialises again. */
    pending = new WeakMap();
    openers = new Map();
    copied = new Map();
    announcing = new Map();
    constructor(doc) {
        this.doc = doc;
    }
    start() {
        if (this.started)
            return;
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
        for (const dialog of this.openers.keys())
            if (dialog.open && typeof dialog.close === "function")
                dialog.close();
        this.openers.clear();
        for (const [scope, timer] of this.copied) {
            clearTimeout(timer);
            this.uncopy(scope);
        }
        this.copied.clear();
    }
    /** The server markup an initialised scope came from, if it is initialised. */
    serverMarkup(scope) {
        return this.initialized.has(scope) ? this.markup.get(scope) : undefined;
    }
    /** A morph is about to patch this scope to new server markup: initialise it
     * again on the next refresh. Its open dialog and opener stay as they are. */
    forget(scope, markup) {
        this.initialized.delete(scope);
        this.markup.delete(scope);
        this.pending.set(scope, markup);
        const timer = this.copied.get(scope);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.copied.delete(scope);
            this.uncopy(scope);
        }
    }
    /** A morph removed this subtree: tear down the behaviours inside it. */
    teardown(root) {
        if (!(root instanceof Element))
            return;
        const scopes = [...(root.matches("[data-portal-behavior]") ? [root] : []), ...Array.from(root.querySelectorAll("[data-portal-behavior]"))];
        for (const scope of scopes) {
            this.initialized.delete(scope);
            this.markup.delete(scope);
            const timer = this.copied.get(scope);
            if (timer !== undefined) {
                clearTimeout(timer);
                this.copied.delete(scope);
            }
            clearTimeout(this.announcing.get(scope));
            this.announcing.delete(scope);
        }
        for (const dialog of [...(root.matches("dialog") ? [root] : []), ...Array.from(root.querySelectorAll("dialog"))]) {
            if (dialog.open && typeof dialog.close === "function")
                dialog.close();
        }
    }
    owned(scope, selector) {
        return Array.from(scope.querySelectorAll(selector)).filter(node => node.closest("[data-portal-behavior]") === scope);
    }
    refresh() {
        for (const [dialog, opener] of this.openers)
            if (!dialog.isConnected) {
                this.openers.delete(dialog);
                if (opener.isConnected)
                    opener.focus();
            }
        for (const scope of this.doc.querySelectorAll("[data-portal-behavior]")) {
            if (this.initialized.has(scope))
                continue;
            const kind = scope.dataset.portalBehavior;
            const markup = this.pending.get(scope) ?? scope.outerHTML;
            if (kind === "quantity" && this.owned(scope, 'input[type="number"][data-portal-control="value"]').length !== 1)
                continue;
            if (kind === "copy") {
                const buttons = this.owned(scope, 'button[data-portal-command="copy"]');
                if (this.owned(scope, "[data-portal-copy-source]").length !== 1 || buttons.length !== 1 || !buttons[0].hasAttribute("data-portal-enhanced-only"))
                    continue;
                // A visually hidden polite region, present (and empty) before the first
                // copy so that setting its text is announced. An author-supplied region
                // is completed with the same live-region semantics.
                const supplied = this.owned(scope, "[data-portal-copy-status]")[0];
                if (supplied) {
                    if (!supplied.hasAttribute("role"))
                        supplied.setAttribute("role", "status");
                    if (!supplied.hasAttribute("aria-live"))
                        supplied.setAttribute("aria-live", "polite");
                }
                else {
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
                if (dialogs.length !== 1 || typeof dialogs[0].showModal !== "function")
                    continue;
            }
            if (kind === "tabs") {
                const tabs = this.owned(scope, "button[data-portal-tab]");
                const panels = this.owned(scope, "[data-portal-panel]");
                const lists = this.owned(scope, "[data-portal-tablist]");
                if (lists.length !== 1 || !tabs.length || tabs.length !== panels.length || tabs.some(tab => !tab.id || !lists[0].contains(tab) || panels.filter(panel => panel.id && panel.id === this.panelID(tab)).length !== 1))
                    continue;
                if (new Set(tabs.map(tab => this.panelID(tab))).size !== tabs.length || new Set(tabs.map(tab => tab.id)).size !== tabs.length || tabs.every(tab => tab.disabled))
                    continue;
                lists[0].setAttribute("role", "tablist");
                for (const tab of tabs) {
                    tab.setAttribute("role", "tab");
                    tab.setAttribute("aria-controls", this.panelID(tab));
                    const panel = panels.find(panel => panel.id === this.panelID(tab));
                    panel.setAttribute("role", "tabpanel");
                    panel.setAttribute("aria-labelledby", tab.id);
                    panel.tabIndex = 0;
                }
                this.select(scope, tabs.find(tab => !tab.disabled && tab.getAttribute("aria-selected") === "true") ?? tabs.find(tab => !tab.disabled), false);
            }
            else if (kind !== "quantity" && kind !== "dialog" && kind !== "copy")
                continue;
            this.initialized.add(scope);
            this.markup.set(scope, markup);
            this.pending.delete(scope);
            for (const control of this.owned(scope, "[data-portal-enhanced-only]"))
                control.hidden = false;
        }
    }
    panelID(tab) { return tab.getAttribute("aria-controls") ?? tab.dataset.portalTab ?? ""; }
    select(scope, selected, focus) {
        for (const tab of this.owned(scope, "button[data-portal-tab]")) {
            const active = tab === selected;
            tab.setAttribute("aria-selected", String(active));
            tab.tabIndex = active ? 0 : -1;
            for (const panel of this.owned(scope, "[data-portal-panel]"))
                if (panel.id === this.panelID(tab))
                    panel.hidden = !active;
        }
        if (focus)
            selected.focus();
    }
    click = (event) => {
        if (event.defaultPrevented || event.button !== 0)
            return;
        const button = event.target?.closest("button");
        const scope = button?.closest("[data-portal-behavior]");
        if (!button || button.disabled || !scope || !this.initialized.has(scope))
            return;
        if (scope.dataset.portalBehavior === "tabs" && button.hasAttribute("data-portal-tab")) {
            event.preventDefault();
            this.select(scope, button, false);
            return;
        }
        const command = button.dataset.portalCommand;
        if (scope.dataset.portalBehavior === "quantity" && ["increment", "decrement"].includes(command ?? "")) {
            const input = this.owned(scope, 'input[type="number"][data-portal-control="value"]')[0];
            if (!input || input.disabled || input.readOnly)
                return;
            event.preventDefault();
            const previous = input.value;
            try {
                command === "increment" ? input.stepUp() : input.stepDown();
            }
            catch {
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
            if (!dialog)
                return;
            // A supported native invoker that targets this scope's dialog with the
            // matching command opens or closes it itself; only remember the opener so
            // focus returns to it on close. Anything else falls back to showModal().
            const target = button.commandForElement;
            const native = command === "open" ? "show-modal" : command === "close" ? "close" : undefined;
            if (target === dialog && native && button.getAttribute("command") === native) {
                if (command === "open")
                    this.openers.set(dialog, button);
                return;
            }
            if (command === "open" && typeof dialog.showModal === "function") {
                event.preventDefault();
                this.openers.set(dialog, button);
                if (!dialog.open)
                    dialog.showModal();
            }
            else if (command === "close" && typeof dialog.close === "function") {
                event.preventDefault();
                dialog.close();
            }
        }
    };
    async copy(scope) {
        const source = this.owned(scope, "[data-portal-copy-source]")[0];
        const button = this.owned(scope, 'button[data-portal-command="copy"]')[0];
        const clipboard = this.doc.defaultView?.navigator.clipboard;
        if (!source || !button || typeof clipboard?.writeText !== "function")
            return;
        // Form controls copy their value; other sources copy their text without the
        // indentation that server-rendered markup leaves around it.
        const text = source.localName === "input" || source.localName === "textarea" ? source.value : (source.textContent ?? "").trim();
        try {
            await clipboard.writeText(text);
        }
        catch {
            return;
        }
        if (!this.started || !scope.isConnected)
            return;
        const previous = this.copied.get(scope);
        if (previous !== undefined)
            clearTimeout(previous);
        scope.setAttribute("data-portal-copied", "");
        const status = this.owned(scope, "[data-portal-copy-status]")[0];
        if (status) {
            // Localised text comes from a hidden [data-portal-copied-text] child, then
            // the button's data-portal-copied-message, then "Copied".
            const message = this.owned(scope, "[data-portal-copied-text]")[0]?.textContent?.trim() || button.dataset.portalCopiedMessage || "Copied";
            // Clear first and set the text on the next tick, so a repeat copy within
            // the copied window changes the live region again and is re-announced.
            status.textContent = "";
            clearTimeout(this.announcing.get(scope));
            this.announcing.set(scope, setTimeout(() => { this.announcing.delete(scope); if (scope.hasAttribute("data-portal-copied"))
                status.textContent = message; }, 0));
        }
        this.copied.set(scope, setTimeout(() => { this.copied.delete(scope); this.uncopy(scope); }, 2000));
    }
    uncopy(scope) {
        clearTimeout(this.announcing.get(scope));
        this.announcing.delete(scope);
        scope.removeAttribute("data-portal-copied");
        const status = this.owned(scope, "[data-portal-copy-status]")[0];
        if (status)
            status.textContent = "";
    }
    keydown = (event) => {
        const tab = event.target?.closest("button[data-portal-tab]");
        const scope = tab?.closest('[data-portal-behavior="tabs"]');
        if (!tab || !scope || !this.initialized.has(scope))
            return;
        const tabs = this.owned(scope, "button[data-portal-tab]").filter(item => !item.disabled);
        const index = tabs.indexOf(tab);
        const vertical = this.owned(scope, "[data-portal-tablist]")[0]?.getAttribute("aria-orientation") === "vertical";
        const previous = vertical ? "ArrowUp" : "ArrowLeft", next = vertical ? "ArrowDown" : "ArrowRight";
        let target;
        if (event.key === "Home")
            target = tabs[0];
        if (event.key === "End")
            target = tabs.at(-1);
        if (event.key === next)
            target = tabs[(index + 1) % tabs.length];
        if (event.key === previous)
            target = tabs[(index + tabs.length - 1) % tabs.length];
        if (target) {
            event.preventDefault();
            this.select(scope, target, true);
        }
    };
    closed = (event) => {
        const dialog = event.target;
        const opener = this.openers.get(dialog);
        this.openers.delete(dialog);
        if (opener?.isConnected)
            opener.focus();
    };
}
