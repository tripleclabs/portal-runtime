# Security

Report vulnerabilities privately using [GitHub's vulnerability reporting form](https://github.com/tripleclabs/portal-runtime/security/advisories/new). Do not put credentials, customer data, or exploitable deployment details in a public issue. Include the affected commit, a minimal reproduction, and the impact you observed.

The latest tagged release is the supported version. This is an early project with no guaranteed response-time SLA.

## Trust boundary

This is a browser enhancement library, not an authentication or authorization layer. Servers must enforce permissions, CSRF protection, safe HTML rendering, and appropriate caching headers independently of browser behavior. Context and version markers prevent accidental application of stale responses; they are not credentials.

Treat every HTML response as trusted server output. DOM parsing does not sanitize HTML, and applications must not rely on inert script parsing as an XSS defense. Serve the runtime as a trusted external asset under the application's content security policy. Never include secrets in context/version markers or client-side state.
