# ND API Studio

One local-first workspace for OpenAPI documentation and HTTP request work:
browse a spec, try an operation, edit it as a request, save it into a
collection, switch environments, and replay it from history — without sending
the document or the request through a hosted service.

## Install

- **Development builds**: Settings → Extensions → **Discover** → *ND API
  Studio* → Install.
- **Packaged builds**: install the published catalog entry, or choose the
  package folder with *Install from folder*.
- After installing, activate the package in the Personal context. The launcher
  command **Open API Studio** (and Ctrl+K) opens the view.

The package is fully external: nothing here is staged into the application
bundle, and `electron-builder.yml` is untouched.

## First run

1. **Environment**: open *Environments* and set `baseUrl` (for example
   `http://localhost:8080`). Variables are referenced as `{{baseUrl}}`.
2. **Docs**: *Import* → *OpenAPI* and either paste a document or point at a
   Spring Boot service (`http://localhost:8080/v3/api-docs`). JSON and YAML
   are both accepted.
3. **Try it out** on an operation, edit the URL or params, add auth in the
   *Auth* tab, and press **Send** (Ctrl/Cmd+Enter).
4. **Save to…** stores the request in a collection. Environments, collections,
   and history are persisted and restored the next time the view opens.

## What is included

- OpenAPI 3.0 / 3.1 and Swagger 2.0 documentation with tag grouping, search,
  parameters, request/response examples, schema examples, and security schemes.
- HTTP client: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS; query, path, and
  header parameters; JSON/text/form/multipart bodies; Bearer, Basic, and API-key
  auth; response status, headers, timing, size, a collapsible JSON viewer, and
  a resizable request/response split (60% response by default).
- Follows ND's light/dark theme; the view receives theme changes through the
  webview bridge and updates without reloading.
- Collections with request rename, reorder, and delete.
- Environments with `{{variable}}` substitution across URL, params, headers,
  body, and auth.
- Request history with credentials redacted before anything is written.
- Import: OpenAPI JSON/YAML (paste or URL), Postman Collection v2.1, cURL.
  Paste a cURL command straight into the URL field, or anywhere in Collections
  when no text field is focused, to turn it into a request; `Import` → `cURL`
  does the same. Chrome's `Copy as cURL (cmd)`/`(bash)` output is accepted,
  including line continuations and ANSI-C quoting.
- Export: copy a request as cURL, copy the response body.

## Storage and trust boundary

- The UI is a package-shipped web view in ND's sandboxed iframe: no Node, no
  network, no renderer injection. Every effect goes through a named view action
  and the extension broker.
- HTTP requests execute in **nd-core (Rust)**, not in the frame or the desktop
  main process. Rust enforces `http`/`https` only, allowed methods, a 4,096
  character URL cap, 100 headers / 32 KB of headers, a 2 MB request body, a
  10-redirect limit, a 250 ms–120 s timeout, and an 8 MB response cap.
- `userData/nd-api-studio/workspace.json` holds collections, environments,
  request definitions, and history. It is encrypted with Electron
  `safeStorage` when the OS keychain is available; otherwise it is written
  `0600` and the header chip says **Unencrypted**. The store refuses to replace
  an encrypted workspace with plaintext while the keychain is unavailable.
- History strips `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`,
  `X-API-Key`, `X-Auth-Token`, and `API-Key` headers, plus the configured auth
  secret. Query parameters you add yourself are stored as written — prefer
  `{{variables}}` for secrets.
- Imported specs live as raw files under `userData/nd-api-studio/specs/`
  (metadata index in `index.json`, each document capped at 4 MB).
- Connections are direct: ambient `HTTP_PROXY`/`HTTPS_PROXY` are not used, so
  localhost debugging is predictable.

## Limits (V1)

- Response bodies are displayed up to 100 KB; larger bodies are marked
  truncated. Imported specs are capped at 4 MB. Request bodies sent through
  the current bridge are limited to 120 KB (the bridge drops larger frames).
- Spec import from a URL is unauthenticated; download a secured document and
  paste it instead.
- Multipart supports text fields only; the sandboxed frame has no file picker.
- Deferred: OAuth2 authorization code + PKCE, WebSocket/SSE/GraphQL/gRPC,
  Postman pre-request scripts and assertions, collection runner, mock servers,
  team sync, and publishing generated docs.

## Vendored dependency

- [`js-yaml`](https://github.com/nodeca/js-yaml) 4.3.2 (MIT) — YAML parsing for
  OpenAPI documents. Copied unmodified to `ui/vendor/js-yaml.mjs`; the upstream
  MIT text is in `ui/vendor/js-yaml.LICENSE`.

## Verification

```bash
node scripts/validate-nd-extension.mjs extensions/api-studio
pnpm typecheck
pnpm test tests/api-studio-extension.test.ts
cargo test -p nd-runtime api_http
```
