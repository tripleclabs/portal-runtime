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

A compatible page response replaces only the page root, updates title, language, direction, description, robots, canonical, OpenGraph, and structured-data metadata, and preserves the surrounding shell. Changed stylesheet/script assets or server-rendered body-shell content trigger full navigation. Shell comparison uses the original server snapshot with the page replaced by a sentinel, not the live DOM, so client-owned shell edits survive compatible navigation. Links marked `data-portal-native`, downloads, external URLs, and modified clicks keep browser semantics.

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
