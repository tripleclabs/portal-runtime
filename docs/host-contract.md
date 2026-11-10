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

Forms retain ordinary URLs and native submit behavior when JavaScript is absent. `data-portal-target` selects a region; optional `data-portal-live` enhances GET forms with debounced requests (150 ms default, `data-portal-debounce` override). Region inputs should live outside the replacement root. The runtime refuses replacement around a focused input rather than silently discarding its draft.

POST forms serialize URL-encoded values, including the server-rendered hidden CSRF token. Multipart file forms need a future Folder upload adapter; the runtime reports an error instead of transmitting binary through Lua. Form actions never automatically retry an uncertain write. The form lifecycle prevents duplicate in-flight submissions. Once values and the submitter have been captured, enabled controls in the submitted form are disabled for the duration of the POST; originally disabled controls remain disabled. Completion, errors, disposal, and identity invalidation restore the controls owned by that submission. This deliberately avoids losing newer draft edits when a server-rendered response replaces the form.

Enhanced fetch sends `X-Portal-Request: navigation` or `region`, plus `X-Portal-Region` for GET regions. POST region targets use the reserved `_portal_region` form field instead, so a 303 redirect does not forward a stale region header to the destination page. The server returns a complete HTML document for navigation and one matching named root for region responses. Validation responses may use HTTP 422 with rendered HTML. API routes use their own credential contract and are not browser page enhancement endpoints.

A compatible page response replaces only the page root, updates title, language, direction, description, robots, canonical, OpenGraph, and structured-data metadata, and preserves the surrounding shell. Changed stylesheet/script assets or server-rendered body-shell content trigger full navigation. The one exception is `style[data-portal-icons]`: the host inlines only the icon mask rules a response uses, one rule per line, in that element (in a page's head, or beside a region response's root). It is not part of the asset comparison; instead the runtime merges any rules the live page lacks into its own `head style[data-portal-icons]` before swapping in a page or region, so swapped-in icons keep painting. Shell comparison uses the original server snapshot with the page replaced by a sentinel, not the live DOM, so client-owned shell edits survive compatible navigation. Links marked `data-portal-native`, downloads, external URLs, and modified clicks keep browser semantics.

## Component events

The host renders each component instance with events as a region named `c<n>` (document order) plus one hidden form, `<form hidden id="c<n>" data-portal-instance method="post" action="…/_portal/actions/_portal_event?returnTo=…">`, holding the signed `_portal_instance` token, `returnTo` and the usual CSRF/version/context fence. The instance's named controls and event buttons point at it with the native `form` attribute, so every event is an ordinary POST without JavaScript; each event button is `<button type="submit" name="_portal_export" value="<call>">`, where the call key is the export's name, or `<export>#<n>` when the instance binds that export more than once (a button repeated by `t:for`, each with its own sealed arguments). `data-portal-change` carries a call key the same way. The token is bound to the visitor's session and context: a token from another visitor or an earlier context answers 409, and the runtime reloads. When an event's instance has moved or disappeared in the re-render (an export that removes its own line, say), the host answers a region request with the whole page, and the runtime swaps the page. An author's event form (`t:submit`) carries the same hidden fields itself. Treat all of these as host-owned.

With the runtime, an event button or event form submits through the normal form lifecycle (duplicate-submission prevention, no retries) with `_portal_region` set to its instance, and the server answers with that instance's fragment, including its refreshed hidden form. If the focused control sits inside the instance, the runtime swaps only the instance's live parts (`c<n>-<part>` regions) so the draft survives.

`data-portal-change="<call>"` marks a container whose controls re-render the instance's live parts as the visitor edits: `input` and `change` events debounce at 250 ms, a newer change aborts the request in flight (`AbortController`), and a response that arrives after a newer one began is discarded. A live part holding the focused control is never replaced. A 409 or 401 reloads the page; an incompatible context or version forces native navigation, as everywhere else.

Region and page responses carry the CSS of the components they render in `style[data-portal-components]` (in a page's head, or first in a fragment), one component per line. Like the icon rules it is excluded from the asset comparison, and `adoptComponentStyles` merges the rules the live page lacks before a swap.

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
