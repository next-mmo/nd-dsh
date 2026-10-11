# Contributing

Use Node 24 and pnpm 11.7. Run `corepack pnpm bootstrap` once, then develop with
`corepack pnpm dev`.

Before submitting changes:

```bash
corepack pnpm verify
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Keep commits focused. Harness runtime syncs use
`corepack pnpm run dsh:update` (upstream latest by default; an explicit
tag-or-commit is available for debugging or downgrades). Explain adapter or
Cordis changes in the commit and preserve the same-browser invariant.

## Building an ND extension

ND extensions are declarative `nd.extension/1` packages — a folder with an
`nd-extension.json` manifest, installed through Settings → Extensions → *Install
from folder*. No SDK is published; the contract is the JSON Schema at
`schema/nd-extension.schema.json`, the types and host-method allowlist in
`src/shared/extension-package.ts`, and the validator:

```bash
corepack pnpm ext:validate <package-dir>   # or: node scripts/validate-nd-extension.mjs
```

Start from [`examples/nd-extension-hello`](examples/nd-extension-hello), and read
[`docs/extensions/authoring.md`](docs/extensions/authoring.md) for the full
guide. Note that *ND Extensions* and *agent capabilities*
(`src/shared/extensions.ts`, Settings → Agent capabilities) are separate
capability classes with incompatible manifests.

## CI triggers and the skip directive

> **CI is parked as of 2026-09-23** at the operator's direction, to conserve compute until
> the product is stable enough to justify the spend. The workflow files are unchanged but
> live in `.github-bk/` instead of `.github/`; renaming that folder back restores CI, and
> nothing below is disabled. Until then the local commands in "Before submitting changes"
> are the gate, and anything needing a runner is deferred rather than waived.

The `ci` workflow runs on pushes to `main` and on non-draft pull requests.

A commit message containing the skip directive — `[skip ci]`, `[ci skip]`,
`[no ci]`, `[skip actions]`, or `[actions skip]` — suppresses that workflow for
pushes and for pull requests alike. GitHub matches the token anywhere in the
message, including prose in the body and inside backticks, so a commit that
merely *describes* the convention silently skips CI. That is how the 2026-09-23
`Verify ND Core` regression reached `main` unvalidated, and a pull request that
explained it in its own commit message had every run suppressed until the
message was reworded.

Two consequences worth remembering:

- A pull request that never appears in the Actions tab is usually this, not a
  broken trigger. Reword the head commit, or dispatch the workflow explicitly,
  which ignores the directive:

  ```bash
  gh workflow run ci.yml --ref <branch> -f full_benchmark=false
  ```

- Concurrency is per ref, and `cancel-in-progress` is on. Dispatching a second
  run on a branch while one is still in flight cancels the first, even when the
  two runs target different jobs. Wait for the running job, or dispatch on
  another ref.
