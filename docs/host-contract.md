# Server and browser contract

Complete documents have one `data-portal-page` root and these attributes on `html`:

```html
<html data-portal-context="opaque-context-generation" data-portal-version="published-version">
```

Context is an opaque non-secret generation identifier. It must change when identity or customer context changes. Every enhanced response supplies `X-Portal-Context`, `X-Portal-Version`, and `Content-Type: text/html`. A mismatch forces a full GET navigation, never a write retry. Page and region routes enforce authorization independently of these browser checks.

```html
<form method="get" action="/products/booklet" data-portal-target="quote" data-portal-live>
  <input name="quantity" type="number" value="10">
  <button>Calculate</button>
</form>
<section data-portal-region="quote">Server-rendered price</section>
```

Forms retain ordinary URLs and native submit behavior when JavaScript is absent. `data-portal-target` selects a region; optional `data-portal-live` enhances GET forms with debounced requests (150 ms default, `data-portal-debounce` override). A region response is morphed into the live region (see below), so inputs may live inside it: the focused control keeps its draft, caret and focus.

POST forms serialize URL-encoded values, including the server-rendered hidden CSRF token. Multipart file forms need a future Folder upload adapter; the runtime reports an error instead of transmitting binary through Lua. Form actions never automatically retry an uncertain write. The form lifecycle prevents duplicate in-flight submissions. Once values and the submitter have been captured, enabled controls in the submitted form are disabled for the duration of the POST; originally disabled controls remain disabled. Completion, errors, disposal, and identity invalidation restore the controls owned by that submission. This deliberately avoids losing newer draft edits when a server-rendered response updates the form. The response, not the lock, decides which controls end up disabled.

Enhanced fetch sends `X-Portal-Request: navigation` or `region`, plus `X-Portal-Region` for GET regions. POST region targets use the reserved `_portal_region` form field instead, so a 303 redirect does not forward a stale region header to the destination page. The server returns a complete HTML document for navigation and one matching named root for region responses. Validation responses may use HTTP 422 with rendered HTML. API routes use their own credential contract and are not browser page enhancement endpoints.

## Same URL morphs, another URL swaps

One rule decides how a response reaches the page. **If the URL stays the same, the runtime morphs; if it changes, it swaps.**

- **Morph:** component event responses, region responses (including live GET forms and targeted links), a POST answered without a redirect (a 422, say), and a redirect back to the current URL. Morphing patches the live DOM toward the parsed response in place. Children are matched by key first (`data-portal-key`, else `id`, else `data-portal-region`), then by tag and position; keyed nodes that moved are moved, not repainted, and nodes absent from the response are removed. An unkeyed node matches the sibling sharing the most descendant ids and control names, the earliest on a tie (never by focus, so a focused row keeps its place and its own hidden values); two subtrees holding different fields never match, and a control whose `name`, `type` or `form` changed is replaced rather than patched, so a draft never moves into another field. Only what the server rendered is the morph's: nodes the page did not get from the server (an extension's node) are never matched, moved or removed, and neither are attributes the server never rendered on that element (the runtime's own `tabindex` or `aria-busy`, a `class` a script added to a `<body>` the server renders without one). Tracking is per attribute name: if the server renders `class` on an element, the morph sets it to the server's value, replacing classes a script added. Nodes present when the runtime starts count as server-rendered. The visitor's state survives: the focused element keeps its value, selection and focus; a form control keeps the visitor's value unless the server rendered a different value from the one it last rendered (its defaults record that), in which case the server wins; `<details>`/`<dialog>` keep their live `open` unless the server changed the attribute. Focus does not move and scroll is untouched, unless the morph removed the focused element: then focus goes to the nearest surviving instance or region root around it (else the page root), made focusable with `tabindex="-1"`, without scrolling. `data-portal-status` outlets are the runtime's and are left to announce as they do. Behaviours re-initialise only where the morph inserted them or changed their server markup, and are torn down where it removed them. A whole-page morph patches the page root, or the whole body when the server's layout around it changed too (a basket total in the header); title and metadata are synchronised as for a swap. It signals `portal:region` with `detail.name` `"page"`.
- **Swap:** link navigation, back/forward, and redirects to another URL. These keep their behaviour: the page root is replaced, scroll goes to the top (or the restored position, or the fragment), focus moves to the page heading, and `portal:navigated` signals it.

Context, version and mount checks apply before either; a 409 still reloads. A form submission in flight inside what a morph re-renders is discarded and its controls unlocked, and a page morph supersedes region and live-change requests made before it, so an older response never lands on newer content.

A compatible page response for a swap replaces only the page root, updates title, language, direction, description, robots, canonical, OpenGraph, and structured-data metadata, and preserves the surrounding shell. Changed stylesheet/script assets or server-rendered body-shell content trigger full navigation. The one exception is `style[data-portal-icons]`: the host inlines only the icon mask rules a response uses, one rule per line, in that element (in a page's head, or beside a region response's root). It is not part of the asset comparison; instead the runtime merges any rules the live page lacks into its own `head style[data-portal-icons]` before swapping in a page or region, so swapped-in icons keep painting. Shell comparison uses the last server snapshot with the page replaced by a sentinel, not the live DOM, so client-owned shell edits survive compatible navigation; a morph that changes the server's layout updates that snapshot. Links marked `data-portal-native`, downloads, external URLs, and modified clicks keep browser semantics.

## Component events

The host renders each component instance with events as a region named `c<n>` (document order), with a stable `data-portal-key` on its root, plus one hidden form, `<form hidden id="c<n>" data-portal-instance method="post" action="…/_portal/actions/_portal_event?returnTo=…">`, holding the signed `_portal_instance` token, `returnTo` and the usual CSRF/version/context fence. The instance's named controls and event buttons point at it with the native `form` attribute, so every event is an ordinary POST without JavaScript; each event button is `<button type="submit" name="_portal_export" value="<call>">`, where the call key is the export's name, or `<export>#<n>` when the instance binds that export more than once (a button repeated by `t:for`, each with its own sealed arguments). `data-portal-change` carries a call key the same way. The token is bound to the visitor's session and context: a token from another visitor or an earlier context answers 409, and the runtime reloads. A **pure** export cannot change data, so the host re-renders only its instance, from the sealed props and the export's `result`/`errors`, with no page loaders, and answers with the instance fragment. If that render nests a different number of evented instances than the page did (a result that reveals a nested evented component), their ids would collide with later instances', so the host answers with the whole page instead. A **privileged** export may have changed data shown anywhere on the page, so the host re-renders the whole page (loaders run again) and answers with the full document; the runtime morphs it, so a basket total elsewhere on the page updates too. An instance whose caller filled a slot is answered with the whole page as well, since slot content is not sealed. An author's event form (`t:submit`) carries the same hidden fields itself. `c<n>` is positional: removing an instance renumbers the ones after it. `data-portal-key` is not: it is derived from the instance's render identity (its call site and, unless the caller gave it a `key`, its props), so the morph keeps each remaining instance's DOM, drafts and focus. Key list rows whose props change (`t:bind-key`), or the row is replaced and focus moves to its region. The key is emitted only when events are live (a static render without a signer omits it). Treat all of these as host-owned.

With the runtime, an event button or event form submits through the normal form lifecycle (duplicate-submission prevention, no retries) with `_portal_region` set to its instance. A fragment answer (with the instance's refreshed hidden form) is morphed into the instance; a whole-document answer is morphed into the page. Either way the focused control's draft survives.

`data-portal-change="<call>"` marks a container whose controls re-render the instance as the visitor edits: `input` and `change` events debounce at 250 ms, a newer change aborts the request in flight (`AbortController`), and a response that arrives after a newer one began is discarded. The response is morphed in, so the control being edited keeps its draft and caret. A 409 or 401 reloads the page; an incompatible context or version forces native navigation, as everywhere else.

Region and page responses carry the CSS of the components they render in `style[data-portal-components]` (in a page's head, or first in a fragment), one component per line. Like the icon rules it is excluded from the asset comparison, and `adoptComponentStyles` merges the rules the live page lacks before a morph or swap.

## Runtime API

```ts
import { PortalRuntime } from '@wearecococo/portal-runtime'
const runtime = new PortalRuntime({
  window,
  beforeNavigate: async () => true, // supply localized draft-confirmation UI
})
runtime.start()
// Before identity transitions, cancel all outstanding results and form generations:
runtime.invalidate()
// When the host unmounts:
runtime.dispose()
```

Load the `auto` entry as a trusted external module for automatic enhancement. It invalidates requests on page exit and reloads browser back/forward-cache restorations. No customer HTML is cached by this runtime. The server must still use appropriate HTTP cache policy.

`runtime.state` exposes navigation/error state through `subscribe/getSnapshot`. `portal:error` events bubble from failed regions/forms; the host supplies localized error presentation. `portal:navigated` and `portal:region` signal completed DOM updates. There is no English UI copy in the runtime.

## Mount-aware URLs

Hosts emit `data-portal-base` (canonical `/` or a path without a trailing slash) and `data-portal-selection` (JSON object with optional `site`/`version` string fields). Omitted metadata retains root-mount compatibility. Treat these as host-owned fields, never authored template values. New page and fragment responses must match both; the runtime rejects incompatible responses before DOM replacement. A fragment carries these attributes on its `data-portal-fragment` wrapper.

```ts
import { PortalURLs } from '@wearecococo/portal-runtime';
const urls = new PortalURLs({
  basePath: '/portals/example',
  currentPath: '/orders/123?status=open', // logical URL, including page query
  selection: { site: selectedSite, version: selectedVersion },
});
urls.page('/orders');     // mounted page URL + host selection
urls.asset('/logo.svg');  // mounted asset URL, no page selection
urls.api('orders/123');   // mounted /api/orders/123
urls.api('');             // mounted /api
urls.action('save');      // mounted action with encoded logical returnTo
```

The `runtime.urls` getter uses the current page after navigation. URL resolution is pure and exported for framework/custom HTML use; it does not fetch, authenticate, or grant any capability. Optional undefined selection fields are omitted. Relative paths follow URL-directory semantics, root-relative paths use the site root, and already-mounted paths are not prefixed again. Escape above the logical root or ambiguous encoded separators is rejected. Query strings, duplicate query keys and fragments are preserved; host page selection wins over conflicting query flags. External references retain their scheme/authority and are not rewritten (unsafe active schemes remain rejected).

Standard expanded HTML `href`, `src`, `action`, `poster` and `cite` attributes are resolved by the server. Page GET forms need host-owned hidden selection fields for no-JavaScript submission; enhancement re-applies those values too. For ambiguous resource links use `data-portal-url-kind="asset"`; `"endpoint"` also keeps handling native without page selection. CSS text and unsupported attributes are never rewritten. Absolute URLs outside the mount are not enhanced. This is a routing boundary, not a substitute for server authorization.

## Commerce enhancement contract

See [Frames and commerce interactions](commerce.md) for targeted links, explicit GET history policies, localized status outlets, IME-safe live forms and trusted quantity/dialog/tabs/copy controllers. Existing region markup and history defaults remain compatible. These features do not add client-side template evaluation or relax context/version/mount checks.
