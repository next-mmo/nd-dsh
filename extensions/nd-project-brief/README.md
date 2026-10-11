# ND Project Brief

**Package ID:** `nd-project-brief`  
**Visible Extension Name:** `ND Project Brief`  
**Protocol:** `nd.extension/1` (API Version 1)

ND Project Brief is an on-demand, read-only extension and Model Context Protocol (MCP) stdio server for ND. It inspects current Git repository status, tracks project tasks from `.project-brief/tasks.json`, highlights blocked work, derives deterministic next actions, and exports clean Markdown summaries for daily standups, handoffs, and team reviews.

---

## Features

- **Git Status Inspection**: Accurately tracks `added`, `modified`, `deleted`, `untracked`, and `renamed` files via `git status --porcelain=v1 -z --untracked-files=all`. Fully handles filenames with spaces, Unicode characters, and porcelain `-z` rename records without duplicating source paths.
- **Task Tracking**: Loads project task records from `.project-brief/tasks.json` with status tracking across `open`, `in_progress`, `blocked`, and `done`.
- **Honest Warnings & Explicit Errors**: If `.project-brief/tasks.json` is missing, an honest warning is returned rather than failing. If the file is malformed or contains invalid schemas, an explicit error is returned instead of pretending tasks are empty.
- **Deterministic Next Actions**: Proposes deterministic next actions strictly grounded in actual task evidence—blocked tasks are prioritized first, followed by in-progress tasks, then open tasks. Never invents test statuses or false blockers.
- **Flexible Filtering**: Supports `filter` options (`all`, `changes`, `open`, `blocked`).
- **Markdown Export**: Generates formatted Markdown summaries containing workspace path, changed paths, task IDs/titles/statuses, warnings, and suggested next actions.
- **Zero External Dependencies**: Built entirely with Node.js standard library modules (`node:readline`, `node:child_process`, `node:fs`, `node:path`).

---

## Security & Read-Only Safety

1. **Strictly Read-Only**: The extension performs no filesystem mutations, no file writing, and no Git mutations (`git commit`, `git add`, `git checkout`, etc. are never executed). No background timers or polling processes are started; data is fetched fresh on-demand upon each invocation.
2. **Fixed Workspace Binding**: The target workspace is bound once at process startup via the `--workspace <path>` command-line flag or defaults to `process.cwd()`. Tool call arguments are strictly prohibited from switching the workspace root to prevent lateral access.
3. **Escaping Symlink & Path Traversal Protection**: All paths resolving `.project-brief/tasks.json` are validated against directory traversal and symlink escapes. Escaping symbolic links pointing outside the bound workspace root are rejected with explicit security errors.
4. **Subprocess Safety**: Shell execution uses direct argument arrays (`node:child_process.execFile`) without string concatenation or shell interpolation (`shell: true` is never used).
5. **Clear Root Validation**: Readable errors are returned if the workspace root does not exist, is not a directory, or is not a Git repository.

---

## Installation & Setup

You can register ND Project Brief with ND using either of two methods:

### Method 1: ND Extensions Native Package Installation

Install the extension package manifest directly through the ND Extensions interface:

1. Copy or link the `./extension` directory into your ND extensions directory.
2. Open ND and navigate to **Extensions**.
3. Locate **ND Project Brief** (`nd-project-brief`).
4. Review the contributed tools (`project_brief`, `project_brief_export`) and skill (`project-brief-skill`).
5. **Executable Trust**: ND packages never execute code automatically upon installation. When enabling the extension, grant executable trust to allow the MCP stdio runtime (`node mcp-server.mjs`) to be spawned by ND.

> **Note**: Installing the native package through ND Extensions registers the package manifest and tools for agent workflows, but does **not** automatically wire entries into the legacy Agent capabilities MCP server catalog.

### Method 2: Legacy Agent Capabilities MCP Registration

To configure ND Project Brief as a standalone stdio MCP server in ND's legacy Agent capabilities catalog:

1. Open ND and open **Settings** > **Agent capabilities** > **MCP Servers**.
2. Add a new MCP server entry using the template provided in `./extension/nd-extension.example.json`:
   ```json
   {
     "id": "nd-project-brief",
     "name": "ND Project Brief",
     "version": "1.0.0",
     "surface": "mcp",
     "enabled": true,
     "runtime": "node",
     "command": "node",
     "args": [
       "/ABSOLUTE/PATH/TO/extension/mcp-server.mjs"
     ],
     "serverPath": "/ABSOLUTE/PATH/TO/extension/mcp-server.mjs",
     "instructions": "Use project_brief to inspect Git status changes, check project tasks in .project-brief/tasks.json, identify blocked work, and generate deterministic next actions. Use project_brief_export to generate clean Markdown summaries for standups and handoffs.",
     "engineRoutes": {},
     "providerRoutes": {}
   }
   ```
3. Replace `/ABSOLUTE/PATH/TO/extension/mcp-server.mjs` with the actual **absolute path** to `mcp-server.mjs` on your machine (e.g. `C:\Users\...\extension\mcp-server.mjs` on Windows or `/home/.../extension/mcp-server.mjs` on Linux/macOS).
4. Set `"enabled": true` when you are ready to activate the server.
5. Save the configuration.

---

## How to Ask ND to Call the Tools

Once registered and enabled, ND's agent will automatically discover the tools and the contributed `project-brief-skill`. You can trigger them using natural language prompts:

- *"Show me a brief of this project."*
- *"What files have changed in the repository?"*
- *"Check our task list: what tasks are currently open or blocked?"*
- *"Give me only the blocked project tasks and tell me what needs unblocking."*
- *"Export a project brief in Markdown for today's standup."*

### Tools Reference

#### 1. `project_brief`
Returns a JSON-encoded status object containing:
```json
{
  "extensionId": "nd-project-brief",
  "workspace": "/absolute/path/to/workspace",
  "changes": [
    { "path": "src/index.js", "status": "modified" },
    { "path": "docs/README.md", "status": "added" }
  ],
  "tasks": [
    { "id": "TASK-1", "title": "Database migration", "status": "blocked", "source": ".project-brief/tasks.json" },
    { "id": "TASK-2", "title": "API endpoints", "status": "in_progress", "source": ".project-brief/tasks.json" }
  ],
  "nextActions": [
    "Unblock task TASK-1: Database migration",
    "Continue task TASK-2: API endpoints"
  ],
  "warnings": []
}
```

**Parameters:**
- `filter` *(string, optional)*:
  - `all` (default): Returns all Git changes and all non-done tasks (`open`, `in_progress`, `blocked`).
  - `changes`: Returns repository changes only; `tasks` is empty.
  - `open`: Returns `open` and `in_progress` tasks only; `changes` is empty.
  - `blocked`: Returns `blocked` tasks only; `changes` is empty.

#### 2. `project_brief_export`
Generates formatted Markdown text suitable for standups and asynchronous handoffs.

**Parameters:**
- `filter` *(string, optional)*: Same filter options as `project_brief`.

---

## Task Source Format (`.project-brief/tasks.json`)

Place a `tasks.json` file inside a `.project-brief` directory in your workspace root:

```json
[
  {
    "id": "TASK-101",
    "title": "Resolve production memory leak",
    "status": "blocked"
  },
  {
    "id": "TASK-102",
    "title": "Implement user authentication flow",
    "status": "in_progress"
  },
  {
    "id": "TASK-103",
    "title": "Write unit tests for checkout service",
    "status": "open"
  },
  {
    "id": "TASK-100",
    "title": "Initial architecture review",
    "status": "done"
  }
]
```

- Each entry requires `id` (non-empty string or number), `title` (string), and `status` (`open` | `in_progress` | `blocked` | `done`).
- `done` tasks are automatically excluded from briefs.
- Blocked tasks always produce prioritized unblocking actions in `nextActions`.

---

## Command-Line Execution

To run or debug the MCP stdio server manually from a terminal:

```bash
# Bind to the current working directory
node extension/mcp-server.mjs

# Bind to a specific repository workspace root
node extension/mcp-server.mjs --workspace /path/to/git/repository
```

All JSON-RPC 2.0 messages are exchanged over `stdin` and `stdout`. Diagnostic messages are output exclusively to `stderr` to avoid corrupting protocol communication.
