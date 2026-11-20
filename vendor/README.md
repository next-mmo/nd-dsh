# Vendored upstreams

ND-DSH vendors implementation/runtime upstreams as Git submodules so product code targets known revisions without mixing third-party product identity into the ND control plane. The ND Pencil upstream is commit-pinned; DeepSeek Harness tracks upstream latest while ND-DSH is in beta.

## DeepSeek Harness

- repository: `https://github.com/deepseek-ai/deepseek-harness.git`
- tracked branch: `master` (upstream latest; synced at bootstrap or via `pnpm dsh:update`)
- provenance metadata: `deepseek-harness.json` records the last-synced commit/release informationally

DeepSeek Harness is ND's agent runtime adapter, tracked to upstream latest. Do not copy or patch its core into this repository.

## ND Pencil upstream implementation

ND Pencil is ND's native **Design → Freeform** product surface. Its current low-level editor/runtime implementation is derived from the MIT-licensed OpenPencil project pinned here:

- upstream repository: `https://github.com/ZSeven-W/openpencil.git`
- commit: `9c810776dab546076a5d9db791a49d9e8048dbd7`
- release at that commit: `0.8.4`
- license: MIT
- metadata/provenance: `openpencil.json`
- required upstream notice: `openpencil.LICENSE`

The upstream checkout is implementation source, not a second product inside ND. ND owns the Freeform UI, active project/workspace, document lifecycle, agent bridge, provider routing, security policy and distribution. Account/login, teams/collaboration, cloud tenancy, upstream AI/provider settings, updates/billing and standalone-app workflows are not part of ND Pencil.

Normal users install only ND. Release builds stage the tested local engine under `resources/nd-pencil`; ND never requires an external OpenPencil install or PATH entry. In a source checkout run `corepack pnpm nd-pencil:build` to compile and stage the development runtime.

Run `corepack pnpm bootstrap` from the repository root. Bootstrap supports both a Git checkout and a downloaded source archive. Pass `--build-nd-pencil` when you also want the Freeform runtime compiled during bootstrap.

## ND Source Control upstream implementation

ND's built-in **Source Control** (Git) feature is derived from the MIT-licensed Git extension of microsoft/vscode, pinned here as a source snapshot (not a submodule — nothing is built from this checkout):

- upstream repository: `https://github.com/microsoft/vscode.git`
- upstream path: `extensions/git`
- commit: `f3fa55c39d3df2923b46a3d76cf6baf0afa1db33`
- license: MIT
- metadata/provenance: `vscode-git.json`
- required upstream notice: `vscode-git.LICENSE` (Copyright (c) 2015 - present Microsoft Corporation)

The snapshot is provenance/reference only. ND owns the Source Control UI, IPC contracts, repository-state service, security policy and distribution; the adapted runtime lives in `src/main/git/` and carries Microsoft's copyright headers where source is derived. Credential prompts fail closed (`GIT_ASKPASS=echo`, `GIT_TERMINAL_PROMPT=0`) instead of spawning an askpass helper.

## Free Gemini API upstream runtime

ND Router integrates `free-gemini-api` as a local OpenAI-compatible provider lane (`free-gemini-api`) for Gemini 4 Hydrogen, Gemini 4 Neon, and Task Mode:

- upstream repository: `https://github.com/kodelyx/free-gemini-api.git`
- commit: `bcac6040765fa151a8ee7840740627c0dfc5d2a0`
- metadata/provenance: `free-gemini-api.json`

Run `corepack pnpm free-gemini-api:build` to compile and stage the local Go binary under `resources/free-gemini-api/bin/`. In development, ND Router can also compile or reuse an existing local `free-gemini-api` instance on `http://127.0.0.1:8001/v1`.

