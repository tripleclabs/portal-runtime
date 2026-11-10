# Frames and commerce interactions

Portal progressively enhances server-rendered HTML. DataXML renders on the server; Lua owns fetching and actions. Browser behaviours never calculate authoritative prices, stock, customer permissions or accepted orders.

## A frame is an existing region

Keep using `data-portal-region`; there is no competing frame element or navigation engine. Links and GET forms can explicitly target a region. Descendant links are not implicitly captured.

```html
<form method="get" data-portal-live data-portal-debounce="250"
      data-portal-target="catalog" data-portal-history="replace">
  <label for="search">Search</label>
  <input id="search" name="q" value="">
  <button type="submit">Search</button>
</form>
<p data-portal-status="catalog"
   data-portal-loading-message="Finding products…"
   data-portal-success-message="Products updated."
   data-portal-error-message="Products could not be updated. Please try again."></p>
<section data-portal-region="catalog">
  <!-- Server-rendered results -->
  <a href="?q=cards&amp;page=2" data-portal-target="catalog"
     data-portal-history="advance">Next page</a>
</section>
```

The full page remains a valid native GET destination. Preserve filter parameters in pagination URLs. In DataXML, populate the input from `input.q` and use a read loader on the results region. Repeated query keys are not currently a multi-select filter contract; use an explicitly schematized encoding.

History policies: `none` (default) leaves the URL alone; `replace` updates the current history entry; `advance` creates an entry. They apply only to read navigation. History commits after a compatible, successful replacement. If a whole-page transition or host navigation decision is already pending, a newer URL-changing frame request uses full-page navigation so the earlier response cannot overwrite it. Back/forward fetches the complete SSR page, restoring controls from server-rendered URL state. Fragment responses still require the same context, publication version and mount. Modified clicks, downloads and external links remain native. IME composition waits until composition ends before live submission.

A `data-portal-status` outlet names a region, or `page` for full-page forms. Runtime gives it polite status semantics and plain-text loading/success/error messages. Supply translated messages as shown. Place the outlet outside the replaced region so failure feedback survives. Errors never interpolate raw server exceptions into HTML. Existing `portal:error` events remain available to trusted hosts.

### Editing and errors

Keep editable controls **outside** the region containing their quote/results/error feedback. A focused input, textarea or select inside a replacement boundary prevents replacement; its draft and focus survive and the status outlet reports failure. This is deliberately conservative—there is no DOM morphing or implicit draft merge.

For inline cart quantity editing, put the quantity form beside a summary/error region and target that region. A 422 action response can render errors in that sibling region. If a response must rerender the fields themselves, use a full-page action response and return submitted values plus accessible error messages. Native validation remains enabled. Runtime does not automatically focus a server validation summary; use a meaningful page heading until that explicit contract is added.

## Trusted local behaviours

These are bounded controllers in the shipped runtime, not author-supplied expressions. They initialize on navigation/replacement, scope commands to their nearest behaviour and use delegated listeners. No fetch, eval, HTML interpolation, global store, persistence or authoritative business state is exposed.

### Quantity

```html
<div data-portal-behavior="quantity">
  <button type="button" data-portal-command="decrement"
          hidden data-portal-enhanced-only>Less</button>
  <input type="number" name="quantity" aria-label="Quantity"
         min="1" max="100" step="1" value="1" data-portal-control="value">
  <button type="button" data-portal-command="increment"
          hidden data-portal-enhanced-only>More</button>
</div>
```

Exactly one scoped number input is required. Native `stepUp`/`stepDown` honour min/max/step; disabled/read-only inputs are not changed. Changes emit native input/change events, integrating with live GET forms. Do not use `step="any"` for a stepper. Without JavaScript the number input remains usable and enhancement-only buttons stay hidden.

### Dialog or drawer

```html
<div data-portal-behavior="dialog">
  <button type="button" data-portal-command="open"
          hidden data-portal-enhanced-only>Delivery details</button>
  <dialog aria-labelledby="delivery-title">
    <h2 id="delivery-title">Delivery details</h2>
    <p>Delivery information…</p>
    <button type="button" data-portal-command="close">Close</button>
  </dialog>
</div>
```

Exactly one scoped native dialog is required. It uses `showModal()` for browser focus containment/inert background and native Escape dismissal; closing restores the connected opener. Style the dialog as a drawer when appropriate. Essential content must also have an ordinary page link or inline no-JS alternative; dialog content is not visible without enhancement. No custom focus-trap implementation is introduced.

Buttons may also carry native invoker commands (`command="show-modal"` / `command="close"` with `commandfor="<dialog id>"`). Where the browser supports them (`"commandForElement" in HTMLButtonElement.prototype`), the runtime leaves those clicks to the browser and only records the opener so focus still returns to it on close; elsewhere it opens and closes the dialog itself as above. Keep `data-portal-enhanced-only` on the opener either way: without JavaScript the trigger stays hidden.

### Copy

```html
<div data-portal-behavior="copy">
  <code data-portal-copy-source>sk_test_51Hb…</code>
  <button type="button" data-portal-command="copy"
          hidden data-portal-enhanced-only
          data-portal-copied-message="Key copied">Copy</button>
  <span data-portal-copied-text hidden>Schlüssel kopiert</span>
</div>
```

Exactly one scoped `[data-portal-copy-source]` and one copy button (which must be `data-portal-enhanced-only`) are required; otherwise the scope stays unenhanced and the button stays hidden, as it does without JavaScript. The button copies an input's or textarea's `value`, or else the source's text with surrounding whitespace trimmed, through `navigator.clipboard.writeText`. On success the scope carries `data-portal-copied` for 2000 ms (style a confirmation with it) a confirmation is announced through a polite status. The announced text is the scope's hidden `[data-portal-copied-text]` child when present (so a server-rendered, localised string needs no attribute), else the button's `data-portal-copied-message`, else `Copied`. The runtime adds a visually hidden `[data-portal-copy-status]` to the scope when it enhances it; an author-supplied one is used instead and gets `role="status"` and `aria-live="polite"` if it lacks them. The status is cleared first and the text set on the next tick, so a repeat copy within the 2000 ms window is announced again. If the clipboard is unavailable or refuses, nothing changes and nothing is announced; the source text stays selectable.

### Tabs

```html
<div data-portal-behavior="tabs">
  <div data-portal-tablist aria-label="Product information">
    <button type="button" id="details-tab" data-portal-tab aria-controls="details"
            hidden data-portal-enhanced-only>Details</button>
    <button type="button" id="delivery-tab" data-portal-tab aria-controls="delivery"
            hidden data-portal-enhanced-only>Delivery</button>
  </div>
  <section id="details" data-portal-panel><h3>Details</h3>…</section>
  <section id="delivery" data-portal-panel><h3>Delivery</h3>…</section>
</div>
```

Use unique IDs (component templates may derive normal `id` and `aria-controls` attributes from `component.id`). The runtime adds tab/tablist/tabpanel semantics, selected state and roving tabindex; arrows and Home/End select and focus. `aria-orientation="vertical"` uses Up/Down. Disabled tabs are skipped. Panels are ordinary visible sections without JS; the runtime hides inactive panels. All tabs must map one-to-one to scoped panels. Invalid structures are left unenhanced.

## Transactional actions and remaining boundaries

Related authoritative writes belong in one instance-side Lua action, using the host's authorized transactional GraphQL capability where available. Only produce successful UI state after commit. Database transaction atomicity does not itself provide request idempotency or order concurrent writes from separate forms. Never automatically retry an ambiguous POST or assume aborting a fetch cancels a write.

Component events are the other route for commerce controls. A component such as `buy-now.portal` declares its exports in `<server>` and binds them with `t:click`, `t:submit` or `t:change`. The host seals each rendered instance (its props, each event's call and arguments, and the visitor and Portal it was rendered for) into an encrypted token, so the export receives the props the server rendered, never browser-supplied ones, and the visitor cannot read props the template does not show. A `t:change` export re-renders only the instance's `t:live` parts while the visitor edits, and should only read; `t:click` and `t:submit` may redirect (303), return field errors (422) or re-render the instance with a result. The token is a safety net, not authorization: exports still check, for example, that a line belongs to the visitor. See the host contract for the markup.

### Checkout redirects

A redirect to a local path goes to one of the site's published pages, as for page actions. A `security="privileged"` component may also redirect to an absolute `https://` URL, which is how a checkout hands over to a payment provider: we recommend Stripe hosted Checkout: the export creates the Checkout Session (for example through the tenant's Stripe integration) and returns the session's `url` as its `redirect`. A pure component cannot redirect off the site, and no export may redirect to any other scheme (such as `http://`); the server refuses such a redirect with an error rather than silently sending the visitor elsewhere.

Page actions still replace one region per action. Coordinated basket/badge responses, layout-owned regions, lazy frame sources, generic reactive expressions, optimistic totals, and upload adapters are not implemented. Use a page-owned summary or a complete SSR response for a coherent commerce result today. The host must supply the real commerce/authorization adapter; the runtime does not create carts or orders.
