/** What a morph reports to its owner while it patches. */
export interface MorphHooks {
    /** Return false to leave a matched live element and its subtree as they are. */
    enter?(live: Element, next: Element): boolean;
    /** The root of a subtree the morph inserted. */
    inserted?(node: Node): void;
    /** The root of a subtree the morph removed. */
    removed?(node: Node): void;
}
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
export declare class Morph {
    private readonly doc;
    /** Nodes the server rendered. Only these are matched or removed; anything
     * else (an extension's node, a host toast) is client-owned and left alone. */
    private readonly server;
    /** Per server element, the attributes the server last rendered. Only these
     * are removed when the server stops rendering them. */
    private readonly serverAttributes;
    /** The `open` the server last rendered, per details/dialog. */
    private readonly serverOpen;
    constructor(doc: Document);
    /** Record a subtree as server-rendered, as it is now: at start, after a swap,
     * and for anything the morph or the runtime inserts. */
    adopt(root: Node): void;
    morph(live: Element, next: Element, hooks?: MorphHooks): void;
    private patch;
    private attributes;
    private children;
    /** An unkeyed node's match: among live siblings of the same tag (and the
     * same field, for a control), the one sharing the most descendant ids and
     * control names, the earliest on a tie; else the first one whose fields
     * cannot conflict. Order decides between equals, never focus: a focused row
     * must not claim a sibling's place. Two subtrees holding different fields
     * never match, so a draft never moves into another field. */
    private positionalMatch;
    /** Move a keyed node into place, keeping its state where the browser can. */
    private move;
}
