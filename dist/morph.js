/** Input types whose value is not visitor state (the attribute is the value). */
const VALUE_IS_ATTRIBUTE = new Set(["hidden", "submit", "reset", "button", "image", "file"]);
const OPENABLE = new Set(["details", "dialog"]);
const element = (node) => node.nodeType === 1;
/** A node's key among its siblings: the host's stable instance key, else its
 * id, else its Portal region. */
const key = (node) => {
    if (!element(node))
        return undefined;
    const stable = node.getAttribute("data-portal-key");
    if (stable)
        return "%" + stable;
    const id = node.getAttribute("id");
    if (id)
        return "#" + id;
    const region = node.getAttribute("data-portal-region");
    return region ? "@" + region : undefined;
};
const CONTROLS = new Set(["input", "select", "textarea"]);
/** A component instance's form id (`c3`): positional, renumbered by the host
 * when an instance before it comes or goes, so not part of a field's identity. */
const INSTANCE_FORM_ID = /^c[1-9][0-9]*$/;
/** A control whose name, type or form changed is a different field: it is
 * replaced, never patched, so no draft moves into another field. */
const sameField = (live, next) => {
    if (!element(live) || !element(next) || !CONTROLS.has(live.localName))
        return true;
    const form = (node) => { const value = node.getAttribute("form"); return value && INSTANCE_FORM_ID.test(value) ? "instance" : value; };
    return live.getAttribute("name") === next.getAttribute("name") && live.getAttribute("type") === next.getAttribute("type") && form(live) === form(next);
};
/** Descendant ids and control names: what makes an unkeyed subtree the same
 * subtree, beyond its tag and position. */
const signature = (node) => {
    const names = new Set();
    if (!element(node))
        return names;
    for (const item of [node, ...Array.from(node.querySelectorAll("[id], [name]"))]) {
        const id = item.getAttribute("id"), name = item.getAttribute("name");
        if (id)
            names.add("#" + id);
        if (name && CONTROLS.has(item.localName))
            names.add("=" + name);
    }
    return names;
};
const control = (node) => {
    if (node.localName === "textarea" || node.localName === "select")
        return node;
    if (node.localName !== "input")
        return undefined;
    return VALUE_IS_ATTRIBUTE.has(node.type) ? undefined : node;
};
const checkable = (node) => node.localName === "input" && ["checkbox", "radio"].includes(node.type);
/** What the server rendered: the control's defaults, which only markup sets. */
const rendered = (node) => {
    if (checkable(node))
        return String(node.defaultChecked);
    if (node.localName === "select")
        return Array.from(node.options).filter((option) => option.defaultSelected).map((option) => option.value).join("\n");
    return node.defaultValue;
};
/** What the visitor has now. */
const current = (node) => {
    if (checkable(node))
        return String(node.checked);
    if (node.localName === "select")
        return Array.from(node.selectedOptions).map((option) => option.value).join("\n");
    return node.value;
};
const setCurrent = (node, value) => {
    if (current(node) === value)
        return;
    if (checkable(node))
        node.checked = value === "true";
    else if (node.localName === "select") {
        const values = value.split("\n");
        for (const option of Array.from(node.options))
            option.selected = values.includes(option.value);
    }
    else
        node.value = value;
};
const resetToRendered = (node) => {
    if (checkable(node))
        node.checked = node.defaultChecked;
    else if (node.localName === "select") {
        const select = node;
        const chosen = Array.from(select.options).filter((option) => option.defaultSelected);
        if (chosen.length)
            for (const option of Array.from(select.options))
                option.selected = option.defaultSelected;
        else
            select.selectedIndex = select.multiple ? -1 : 0;
    }
    else
        node.value = node.defaultValue;
};
const selection = (node) => {
    if (!node || !("selectionStart" in node))
        return undefined;
    try {
        const field = node;
        if (field.selectionStart === null || field.selectionEnd === null)
            return undefined;
        return { start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection ?? "none" };
    }
    catch {
        return undefined;
    }
};
const select = (node, range) => {
    if (!range)
        return;
    const field = node;
    try {
        if (field.selectionStart !== range.start || field.selectionEnd !== range.end)
            field.setSelectionRange(range.start, range.end, range.direction);
    }
    catch {
        /* the control does not support a selection */
    }
};
/**
 * Patches live DOM toward parsed server HTML in place, keeping visitor state.
 * Children match by key (id, else `data-portal-region`), then by tag and
 * position; keyed nodes that moved are moved, not repainted. A form control
 * keeps the visitor's value unless the server rendered a different value from
 * the one it last rendered (the control's defaults record that). An open
 * `<details>`/`<dialog>` stays as the visitor left it unless the server changed
 * its `open`. The focused element keeps focus, value and selection. Nothing
 * scrolls. There is no virtual DOM: the diff is live DOM against server HTML.
 */
export class Morph {
    doc;
    /** Nodes the server rendered. Only these are matched or removed; anything
     * else (an extension's node, a host toast) is client-owned and left alone. */
    server = new WeakSet();
    /** Per server element, the attributes the server last rendered. Only these
     * are removed when the server stops rendering them. */
    serverAttributes = new WeakMap();
    /** The `open` the server last rendered, per details/dialog. */
    serverOpen = new WeakMap();
    constructor(doc) {
        this.doc = doc;
    }
    /** Record a subtree as server-rendered, as it is now: at start, after a swap,
     * and for anything the morph or the runtime inserts. */
    adopt(root) {
        const walker = this.doc.createTreeWalker(root, 0x1 | 0x4 | 0x80); // elements, text, comments
        for (let node = root; node; node = walker.nextNode()) {
            this.server.add(node);
            if (!element(node))
                continue;
            this.serverAttributes.set(node, new Set(Array.from(node.attributes, (attribute) => attribute.name)));
            if (OPENABLE.has(node.localName))
                this.serverOpen.set(node, node.hasAttribute("open"));
        }
    }
    morph(live, next, hooks = {}) {
        const active = this.doc.activeElement;
        const range = selection(active);
        this.patch(live, next, hooks, active);
        // Browsers without moveBefore blur a focused node that moved.
        if (active instanceof HTMLElement && active.isConnected && this.doc.activeElement !== active) {
            active.focus({ preventScroll: true });
            select(active, range);
        }
    }
    patch(live, next, hooks, active) {
        if (hooks.enter && !hooks.enter(live, next))
            return;
        const field = control(live);
        const before = field && rendered(field);
        const visitor = field && current(field);
        const range = live === active ? selection(live) : undefined;
        this.attributes(live, next, active);
        if (live.localName === "textarea") {
            const value = next.defaultValue ?? next.textContent ?? "";
            if (live.defaultValue !== value)
                live.defaultValue = value;
        }
        else if (live.localName !== "template")
            this.children(live, next, hooks, active);
        if (!field)
            return;
        // The server wins only when it changed what it rendered, and never over
        // the control the visitor is in.
        if (live !== active && rendered(field) !== before)
            resetToRendered(field);
        else {
            setCurrent(field, visitor);
            if (live === active)
                select(live, range);
        }
    }
    attributes(live, next, active) {
        const openable = OPENABLE.has(live.localName);
        const previous = this.serverAttributes.get(live) ?? new Set();
        for (const attribute of Array.from(next.attributes)) {
            if (openable && attribute.name === "open")
                continue;
            if (live.getAttributeNS(attribute.namespaceURI, attribute.localName) !== attribute.value)
                live.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
        }
        for (const attribute of Array.from(live.attributes)) {
            if (openable && attribute.name === "open")
                continue;
            // Only what the server rendered before is the server's to take away.
            if (!previous.has(attribute.name))
                continue;
            if (live === active && attribute.name === "tabindex")
                continue;
            if (!next.hasAttributeNS(attribute.namespaceURI, attribute.localName))
                live.removeAttributeNS(attribute.namespaceURI, attribute.localName);
        }
        this.serverAttributes.set(live, new Set(Array.from(next.attributes, (attribute) => attribute.name)));
        if (!openable)
            return;
        const server = next.hasAttribute("open");
        const last = this.serverOpen.get(live);
        this.serverOpen.set(live, server);
        if (last === undefined || last === server)
            return;
        if (live.localName === "dialog") {
            const dialog = live;
            if (!server && dialog.open) {
                if (typeof dialog.close === "function")
                    dialog.close();
                else
                    dialog.removeAttribute("open");
            }
            else if (server && !dialog.open)
                dialog.setAttribute("open", "");
        }
        else
            live.toggleAttribute("open", server);
    }
    children(live, next, hooks, active) {
        const incoming = Array.from(next.childNodes);
        // Client-owned children are never matched, moved or removed.
        const existing = Array.from(live.childNodes).filter((node) => this.server.has(node));
        // Keys must be unique among siblings to count; duplicates match by position.
        const keyed = new Map();
        const duplicate = new Set();
        for (const node of existing) {
            const name = key(node);
            if (!name)
                continue;
            if (keyed.has(name))
                duplicate.add(name);
            else
                keyed.set(name, node);
        }
        for (const name of duplicate)
            keyed.delete(name);
        const positional = existing.filter((node) => {
            const name = key(node);
            return !name || duplicate.has(name);
        });
        const used = new Set();
        const matches = incoming.map((node) => {
            const name = key(node);
            if (name && !duplicate.has(name)) {
                const match = keyed.get(name);
                if (!match || used.has(match) || match.nodeName !== node.nodeName || !sameField(match, node))
                    return undefined;
                used.add(match);
                return match;
            }
            const match = this.positionalMatch(node, positional, used);
            if (match)
                used.add(match);
            return match;
        });
        // Remove first, so that removals never force the nodes after them to move.
        for (const node of existing) {
            if (used.has(node))
                continue;
            live.removeChild(node);
            hooks.removed?.(node);
        }
        const skipClient = (node) => {
            while (node && !this.server.has(node))
                node = node.nextSibling;
            return node;
        };
        let cursor = skipClient(live.firstChild);
        incoming.forEach((node, index) => {
            const match = matches[index];
            if (!match) {
                const fresh = this.doc.importNode(node, true);
                live.insertBefore(fresh, cursor);
                this.adopt(fresh);
                hooks.inserted?.(fresh);
                return;
            }
            if (match === cursor)
                cursor = skipClient(cursor.nextSibling);
            else
                this.move(live, match, cursor);
            if (element(match))
                this.patch(match, node, hooks, active);
            else if (match.nodeValue !== node.nodeValue)
                match.nodeValue = node.nodeValue;
        });
    }
    /** An unkeyed node's match: among live siblings of the same tag (and the
     * same field, for a control), the one sharing the most descendant ids and
     * control names, the earliest on a tie; else the first one whose fields
     * cannot conflict. Order decides between equals, never focus: a focused row
     * must not claim a sibling's place. Two subtrees holding different fields
     * never match, so a draft never moves into another field. */
    positionalMatch(node, candidates, used) {
        const open = candidates.filter((candidate) => !used.has(candidate) && candidate.nodeName === node.nodeName && sameField(candidate, node));
        if (!element(node))
            return open[0];
        const wanted = signature(node);
        let best, most = 0;
        for (const candidate of open) {
            let shared = 0;
            for (const name of signature(candidate))
                if (wanted.has(name))
                    shared++;
            if (shared > most) {
                best = candidate;
                most = shared;
            }
        }
        if (best)
            return best;
        return open.find((candidate) => !wanted.size || !signature(candidate).size);
    }
    /** Move a keyed node into place, keeping its state where the browser can. */
    move(parent, node, before) {
        const atomic = parent.moveBefore;
        if (typeof atomic === "function") {
            try {
                atomic.call(parent, node, before);
                return;
            }
            catch {
                /* fall back to an ordinary move */
            }
        }
        parent.insertBefore(node, before);
    }
}
