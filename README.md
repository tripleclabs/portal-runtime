# Portal Runtime

Small, dependency-free state and navigation primitives for server-rendered HTML. Keep your server-rendered pages, URLs, and forms; enhance navigation and selected regions without introducing a client-side template engine.

- **Progressive navigation:** replace a page while retaining its surrounding shell, metadata, focus, scroll, and browser history.
- **Targeted updates:** refresh named regions, with cancellation and stale-response guards.
- **Same-URL morphing:** responses that keep the URL are patched into the live DOM, keeping focus, drafts, caret, open disclosures and scroll.
- **Form lifecycle:** prevent duplicate submissions and ignore obsolete responses without automatically retrying writes.
- **Shared state:** observable snapshots, request scopes, submission generations, and lifecycle leases work independently of the DOM runtime.

Portal Runtime was built for HTML-flavoured DataXML and Lua handlers, but the browser contract is plain HTML and HTTP. Any server can implement it. Rendering, authentication, authorization, and HTML sanitization remain server responsibilities.

## Install from GitHub

```sh
pnpm add '@wearecococo/portal-runtime@github:tripleclabs/portal-runtime#v0.1.0'
```

For reproducible deployments, replace `v0.1.0` with its full commit SHA and commit your lockfile. The package is distributed from GitHub; no npm publication is required. Compiled ESM, TypeScript declarations, and a standalone browser module are included in the repository, so installation does not require a build hook.

## Start with state

```ts
import { StateStore, RequestScope } from '@wearecococo/portal-runtime'

const state = new StateStore({ quantity: 1 })
const unsubscribe = state.subscribe(() => console.log(state.getSnapshot()))
state.set({ quantity: 2 })
unsubscribe()

const requests = new RequestScope()
const request = requests.begin('quote')
try {
  const response = await fetch('/quote?quantity=2', { signal: request.signal })
  const quote = await response.json()
  if (request.isCurrent()) console.log(quote)
} finally {
  request.finish()
}
```

`StateStore` uses immutable snapshots by convention. Update it with a new value; mutating an existing snapshot does not notify subscribers. Beginning a request with the same key cancels the previous one; always check `isCurrent()` because a transport can ignore cancellation.

## Enhance pages

```ts
import { PortalRuntime } from '@wearecococo/portal-runtime'

const runtime = new PortalRuntime({ window })
runtime.start()
// Before an identity transition:
runtime.invalidate()
// When the host unmounts:
runtime.dispose()
```

The server must supply one `data-portal-page` root, context/version markers, and matching response headers. See the **[host contract](docs/host-contract.md)** before integrating: it covers region markup, POST/303 handling, cache policy, native fallbacks, lifecycle events, and metadata updates.

For automatic enhancement, serve `dist/portal-runtime.js` as a trusted external module:

```html
<script type="module" src="/assets/portal-runtime.js"></script>
```

This bundle is also exported as `@wearecococo/portal-runtime/browser`. The `/auto` entry is the unbundled ESM equivalent. Both require a browser document; the root library can be imported without starting a runtime.

## Scope and compatibility

Version 0.2 is an early API. Breaking API or HTTP-contract changes require a minor version bump until 1.0; fixes that preserve the contract use patch versions. Pin a commit and read the [changelog](CHANGELOG.md) when upgrading.

The browser target is ES2022 with modern DOM APIs, including Fetch, AbortController, and FormData submitter support. Chromium is exercised in CI; other browser engines are not yet qualified. Node.js 22.18+ is required for development, not for serving the browser bundle.

The runtime does not execute Lua or templates, authenticate visitors, sanitize untrusted HTML, cache customer pages, or upload files. Multipart forms should use native submission (`data-portal-native`) or a separately implemented upload adapter. The server must validate CSRF tokens and permissions on every operation. Incompatible context, version, or page-shell responses cause full navigation.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm test:package
pnpm exec playwright install chromium
pnpm test:browser
```

CI runs the same checks from a clean checkout and verifies that committed build output matches source. See [contributing](CONTRIBUTING.md) for changes and releases, and [security](SECURITY.md) for the trust boundary and private reporting.

## License

[MIT](LICENSE), copyright Triple C Labs GmbH. See [source provenance](PROVENANCE.md).

## Mount-aware URLs

The same page can live at `/` publicly or beneath `/portals/example` in a host.
Use `runtime.urls` for custom browser requests, or the pure exported helper:

```ts
import { PortalURLs } from '@wearecococo/portal-runtime';
const urls = new PortalURLs({ basePath: '/portals/example', currentPath: '/orders/123' });
urls.page('/orders');    // /portals/example/orders
urls.asset('/logo.svg'); // /portals/example/logo.svg
urls.api('orders/123');  // /portals/example/api/orders/123
urls.action('save');     // mounted action with encoded logical returnTo
```

Standard HTML attributes are resolved by the server after DataXML expansion.
Page navigation preserves host-selected preview context; assets and endpoints
remain separate. See the [mount contract](docs/host-contract.md#mount-aware-urls)
for relative paths, native forms, explicit asset links and security boundaries.

For frame navigation, live commerce forms and accessible local controls, see [commerce interactions](docs/commerce.md).
