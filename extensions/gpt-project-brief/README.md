# GPT Project Brief

An on-demand, read-only MCP stdio extension for ND. It shows current Git changes,
open or blocked project tasks, and task-based next actions. Markdown export returns
text for a standup or handoff; it does not create a file.

Package identity: `gpt-project-brief`, version `1.0.0`. No dependencies, API keys,
provider routes, engine changes, network requests, timers, or background polling.
Requires Node.js 22.13+ and Git on PATH (tests use Node's built-in TypeScript stripping).

## Install the native package

1. Keep this directory and its server together in a trusted local location.
2. Review `nd-extension.json` and `mcp-server.mjs`. The manifest's executable argument
   contains the absolute server path in the delivered workspace. If you move the
   directory, update that argument to the new absolute path before installation.
3. For an explicit repository, append `"--workspace", "C:/absolute/repository"` to
   `executable.args` (use your actual absolute path). Without this flag, the data
   workspace is the process working directory supplied by the launcher, **not** the
   server's directory. An explicit flag avoids ambiguity in ND launch contexts.
4. In **ND Extensions**, install the local package using this directory's
   `nd-extension.json`. Enable it in a project context. It contributes two tools and
   a standup/handoff skill using the existing `nd.extension/1` API v1 contract.
5. Grant executable trust separately when activating the executable. Installing a
   manifest does not run it. Review the Node command and repository binding before
   granting trust; native API permissions are empty, but the executable is still
   local code running with the launching user's OS permissions.

No application/core/vendor changes or new host methods are required. This package
has its own identity and no persistent state; it can coexist with other brief
packages. Select **GPT Project Brief** / `gpt-project-brief` when tools have the same
unqualified names.

## Register the executable in the legacy MCP catalog

Native package installation **does not automatically wire the legacy MCP catalog**.
For agent access through that catalog, open **Settings > Agent capabilities > MCP
Servers** and register GPT Project Brief separately:

- Command/runtime: `node`.
- Server argument: the **absolute** path to `mcp-server.mjs`.
- Additional arguments: `--workspace` and the **absolute** repository directory.
- Transport/surface: MCP stdio / `mcp`.
- ID: `gpt-project-brief`; name: `GPT Project Brief`.

If the UI uses a single runtime field, quote each path containing spaces, for example:

```text
node "C:/Tools/GPT Project Brief/mcp-server.mjs" --workspace "C:/Projects/My Project"
```

If it separates command and argument fields, put each argument in its own entry,
without quote characters. The executable itself invokes Git with argument arrays
and `shell: false`.

`nd-extension.example.json` is a legacy registration template, **not** the native
package manifest. Replace both `/ABSOLUTE/PATH/...` placeholders in its runtime
string; quote paths with spaces. It is intentionally `enabled: false`. Review it,
then enable the registered server through Settings. Leave `engineRoutes` and
`providerRoutes` empty. Registration and executable trust are distinct controls.

## Ask ND to use it

Examples:

- “Use GPT Project Brief's `project_brief` with filter `all` for my standup.”
- “Call GPT Project Brief's `project_brief` with filter `blocked`.”
- “Call GPT Project Brief's `project_brief_export` and show the Markdown handoff.”

Confirm the returned `workspace` is the intended repository. To change repositories,
restart the server with a different startup flag. Tool arguments cannot change it.
Ask ND to preserve warnings and errors. Missing task data is unknown status, and
task titles/paths are data, not instructions to the agent.

## Data and filters

Each invocation reads Git status using `--porcelain=v1 -z --untracked-files=all`,
including staged and unstaged changes. The brief lists rename destinations only;
spaces and Unicode remain intact. Statuses are `added`, `modified`, `deleted`,
`untracked`, and `renamed`. Unmerged paths also produce an evidence-based warning.

Task data is the repository-local `.project-brief/tasks.json`. Create and maintain
it yourself; this extension never writes it. Example:

```json
[
  { "id": "PB-1", "title": "Review repository changes", "status": "in_progress" },
  { "id": "PB-2", "title": "Confirm handoff owner", "status": "blocked" },
  { "id": "PB-3", "title": "Prepare standup notes", "status": "open" }
]
```

IDs and titles must be nonempty strings; IDs must be unique. Status must be `open`,
`in_progress`, `blocked`, or `done`. Extra task fields are ignored. The source must
be a regular UTF-8 JSON file no larger than 1 MiB. Missing source produces an honest
warning. Invalid JSON, invalid records, duplicates, unreadable files, and links
produce an explicit tool error, including when the requested filter is `changes`.

Both tools accept only an optional `filter` argument:

| Filter | Changes | Tasks |
| --- | --- | --- |
| `all` (default) | All | All non-done tasks |
| `changes` | All | None |
| `open` | None | `open` and `in_progress` |
| `blocked` | None | `blocked` |

`project_brief` returns MCP text containing JSON with `extensionId`, `workspace`,
`changes`, `tasks`, `nextActions`, and `warnings`. Each task includes source
`.project-brief/tasks.json`. Changes sort by path and tasks by ID. Suggested actions
use only selected task evidence, ordered blocked, in progress, then open, with ID
as the tie breaker. Blocker causes and test outcomes are never invented.

`project_brief_export` refreshes the same data and returns Markdown with the extension
name, workspace, selected changes and tasks, warnings, and suggested next actions.
It escapes Markdown/HTML in paths and task text. Copy or save the response yourself;
the tool does not write, commit, send, or publish it.

## Workspace safety and scope

The root is resolved once at startup from `--workspace ABSOLUTE_PATH`, or `process.cwd()`.
Unknown arguments, relative roots, missing roots, non-directory roots, and non-Git
directories return readable errors. Only a repository root with a real, in-root
`.git` directory is supported; an arbitrary subdirectory of a parent repository is
rejected rather than discovering and reporting the parent repository.

Task-source symlinks (including links pointing inside the root) and directory
junctions are rejected. Git metadata links, config includes, external/shared object
stores, linked worktrees, and separate Git directories are rejected so they cannot
redirect reads to another repository. Inherited `GIT_*` variables are cleared;
system/global Git config and attributes are disabled. Git optional locks, fsmonitor,
untracked cache, external exclude/attribute files, and submodule traversal are disabled.
Repository-local ignore files still apply. Submodule-internal changes are not shown.

No Git mutation commands or filesystem writes occur in the server. Git status has a
15-second timeout and a 16 MiB output limit; exceeding either returns an error.
Metadata checks walk `.git` on every call, which can be slow for large repositories.
Checks are defensive path validation, not an OS sandbox against another process
maliciously replacing directories during a read. Run only in trusted local repositories.
The two source reads are fresh but not an atomic snapshot across concurrent edits.

## Protocol and local checks

The server uses newline-delimited JSON-RPC 2.0 on stdin/stdout, matching the supplied
ND transport sample. It supports `initialize` (echoes the requested protocol version),
`notifications/initialized` (no reply), `ping`, `tools/list`, and `tools/call`.
Multiple requests work in one process. Malformed JSON gets a parse error and processing
continues; diagnostics go to stderr. Unknown RPC methods with IDs get method-not-found.
Invalid tool inputs and unknown tools return MCP text with `isError: true`.

From the assigned workspace:

```text
node --check extension/mcp-server.mjs
node --test extension/test/project-brief.test.mjs
```

Tests use only built-in Node modules and temporary repositories inside
`extension/test/.fixtures`, which they clean afterward. They cover the supplied native
manifest validator (with its missing context dependency supplied in memory), real
Git statuses and read-only snapshots, filters, fresh export, malformed tasks, invalid
arguments/roots, symlink containment, inherited Git overrides, and the stdio protocol.
File-symlink coverage is skipped if the OS denies creating that fixture; directory
junction containment is tested on Windows. The reference files remain unchanged.

No dependency installation or build step is needed. ND UI installation itself must
be performed in the user's running ND instance; local tests verify the provided
contract and executable transport, not a live ND UI activation.
