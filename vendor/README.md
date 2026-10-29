# Vendored upstreams

ND-DSH vendors implementation/runtime upstreams as Git submodules so product code targets known revisions without mixing third-party product identity into the ND control plane. DeepSeek Harness tracks upstream latest while ND-DSH is in beta.

## DeepSeek Harness

- repository: `https://github.com/deepseek-ai/deepseek-harness.git`
- tracked branch: `master` (upstream latest; synced at bootstrap or via `pnpm dsh:update`)
- provenance metadata: `deepseek-harness.json` records the last-synced commit/release informationally

DeepSeek Harness is ND's agent runtime adapter, tracked to upstream latest. Do not copy or patch its core into this repository.

Run `corepack pnpm bootstrap` from the repository root. Bootstrap supports both a Git checkout and a downloaded source archive.

## ND Source Control upstream implementation

ND's built-in **Source Control** (Git) feature is derived from the MIT-licensed Git extension of microsoft/vscode, pinned here as a source snapshot (not a submodule — nothing is built from this checkout):

- upstream repository: `https://github.com/microsoft/vscode.git`
- upstream path: `extensions/git`
- commit: `f3fa55c39d3df2923b46a3d76cf6baf0afa1db33`
- license: MIT
- metadata/provenance: `vscode-git.json`
- required upstream notice: `vscode-git.LICENSE` (Copyright (c) 2015 - present Microsoft Corporation)

The snapshot is provenance/reference only. ND owns the Source Control UI, IPC contracts, repository-state service, security policy and distribution; the adapted runtime lives in `src/main/git/` and carries Microsoft's copyright headers where source is derived. Credential prompts fail closed (`GIT_ASKPASS=echo`, `GIT_TERMINAL_PROMPT=0`) instead of spawning an askpass helper.

