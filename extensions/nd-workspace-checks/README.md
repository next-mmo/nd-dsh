# ND Workspace Checks

A read-only ND extension and Model Context Protocol (MCP) server that safely inspects `package.json` scripts and check targets (`verify`, `typecheck`, `test`, `build`) without executing code, and exports structured findings for handoffs.

---

## Table of Contents

- [Overview](#overview)
- [Installation and Registration](#installation-and-registration)
  - [Native ND Extension (`nd-extension.json`)](#native-nd-extension-nd-extensionjson)
  - [Legacy MCP Registration (`nd-extension.example.json`)](#legacy-mcp-registration-nd-extensionexamplejson)
  - [Executable Trust Model](#executable-trust-model)
  - [Absolute Path Requirement](#absolute-path-requirement)
- [Workspace Binding Semantics](#workspace-binding-semantics)
- [Tool Reference](#tool-reference)
  - [`workspace_checks`](#workspace_checks)
  - [`workspace_checks_export`](#workspace_checks_export)
- [Security Guarantees](#security-guarantees)
- [Package ID Coexistence](#package-id-coexistence)
- [Development and Testing](#development-and-testing)

---

## Overview

In multi-agent collaborative workflows and automated coding loops, agents frequently need to know what verification commands (build, test, typecheck, lint/verify) a repository supports before attempting modifications or running checks.

**ND Workspace Checks** provides a strictly read-only, safe discovery mechanism:
- Discovers and categorizes package scripts without invoking shell interpreters.
- Evaluates availability of canonical verification tasks: `verify`, `typecheck`, `test`, and `build`.
- Generates structured JSON reports and Markdown summaries for seamless handoffs between agents or human reviewers.
- Enforces strict security boundaries: bounded file reads, symlink confinement, zero execution, and no file writes.

---

## Installation and Registration

### Native ND Extension (`nd-extension.json`)

ND Workspace Checks is packaged as a native ND extension adhering to protocol `nd.extension/1` and API version `1`.

The manifest is located at `extension/nd-extension.json` and declares:
- **ID**: `nd-workspace-checks`
- **Contexts**: `["personal", "company", "project"]`
- **Executable**: MCP stdio transport invoking `node mcp-server.mjs`
- **Contributions**:
  - `workspace_checks` tool
  - `workspace_checks_export` tool
  - `workspace-checks-skill` skill instructing agents on safe inspection workflows

To install natively in ND:
1. Copy or link the `extension` directory into your ND extensions catalog or workspace.
2. ND automatically discovers `nd-extension.json` and exposes the declared tools and skills to authorized sessions.

### Legacy MCP Registration (`nd-extension.example.json`)

For legacy setups or direct MCP server configuration in ND:
1. Navigate to **Settings > Agent capabilities > MCP Servers**.
2. Click **Add Server** or import configuration using `extension/nd-extension.example.json`.
3. Provide the required configuration:

```json
{
  "id": "nd-workspace-checks",
  "name": "ND Workspace Checks",
  "description": "Read-only workspace checks and package.json script inventory for handoffs.",
  "surface": "mcp",
  "version": "1.0.0",
  "enabled": false,
  "runtime": {
    "kind": "mcp-stdio",
    "command": "node",
    "args": [
      "/ABSOLUTE/PATH/TO/mcp-server.mjs"
    ],
    "env": {}
  },
  "engineRoutes": [],
  "providerRoutes": []
}
```

### Executable Trust Model

ND enforces a strict separation between extension registration and code execution:
- **Registration**: Registering `nd-extension.json` or importing `nd-extension.example.json` only stores static metadata. The server process is **never** launched at registration time.
- **Activation & Trust**: Explicit executable trust must be granted by the user when enabling the extension. ND prompts for confirmation before spawning the underlying Node.js process.
- **Environment Isolation**: The runtime declaration explicitly specifies environment variable pass-through (`env`), ensuring secrets and parent credentials are never leaked.

### Absolute Path Requirement

In the legacy MCP registration (`nd-extension.example.json`), the `args` array contains the placeholder:
```text
/ABSOLUTE/PATH/TO/mcp-server.mjs
```
Because the host environment may launch MCP servers from varying working directories, relative paths can fail to resolve. Users must replace this placeholder with the full absolute path on the host system (e.g., `C:/Projects/my-app/extension/mcp-server.mjs` on Windows or `/home/user/my-app/extension/mcp-server.mjs` on Linux/macOS).

---

## Workspace Binding Semantics

The server determines the workspace root using the following order of precedence:

1. **CLI Flag (`--workspace <path>`)**:
   When launched with `--workspace <path>` (e.g., `node mcp-server.mjs --workspace /path/to/project`), the server resolves and binds strictly to the specified absolute path.
2. **Current Working Directory (`process.cwd()`) Fallback**:
   If no `--workspace` argument is supplied, the server falls back to `process.cwd()`.

### Path Validation and Symlink Confinement
- The server validates that the workspace root exists and is a directory.
- When resolving files such as `package.json`, the server performs symlink resolution (via `fs.realpath` / canonical path inspection).
- **Symlink Escape Rejection**: If `package.json` or any target file is a symlink pointing outside the workspace boundary, the server rejects access fail-closed and returns an error (`isError: true`).

---

## Tool Reference

### `workspace_checks`

Inspects the bound workspace's `package.json`, extracting all scripts and checking the availability of canonical check tasks.

#### Input Schema
The tool accepts **no arguments**. Passing any arguments will result in an error (`isError: true`).
```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### Output Structure
Returns a JSON-encoded object in text content:
```json
{
  "workspace": "/absolute/path/to/workspace",
  "packageJsonFound": true,
  "scripts": [
    { "name": "build", "command": "tsc -b" },
    { "name": "test", "command": "node --test" },
    { "name": "typecheck", "command": "tsc --noEmit" },
    { "name": "verify", "command": "npm run typecheck && npm run test" }
  ],
  "checks": {
    "verify": { "available": true, "command": "npm run typecheck && npm run test" },
    "typecheck": { "available": true, "command": "tsc --noEmit" },
    "test": { "available": true, "command": "node --test" },
    "build": { "available": true, "command": "tsc -b" }
  },
  "warnings": []
}
```

- **Checks Ordering**: Canonical verification checks are evaluated in fixed order: `verify`, `typecheck`, `test`, `build`.
- **Deterministic Sorting**: Scripts are deterministically sorted alphabetically by script name.
- **Missing `package.json`**: If `package.json` is not found, `scripts` is empty (`[]`), all checks report `available: false`, and an informative warning is included in `warnings`.
- **Malformed Content**: If `package.json` contains invalid JSON, is not an object, has a non-object `scripts` property, contains non-string command values, or exceeds 1 MiB, an MCP error response (`isError: true`) is returned.

---

### `workspace_checks_export`

Exports the workspace checks and package scripts as human- and agent-readable Markdown suitable for context handoffs.

#### Input Schema
The tool accepts **no arguments**. Passing any arguments will result in an error (`isError: true`).
```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

#### Output Structure
Returns formatted Markdown text containing:
- Extension header (`# Workspace Checks Report` or `## ND Workspace Checks`)
- Bound workspace directory path
- Summary table or list of canonical check targets (`verify`, `typecheck`, `test`, `build`) and availability
- Deterministically ordered inventory of scripts and their exact command definitions
- Any applicable warnings or notices

#### Memory-Only Execution
`workspace_checks_export` operates entirely in memory. It outputs formatted text within the MCP protocol response and **never writes or touches files on disk**.

---

## Security Guarantees

1. **Strictly Read-Only**: The extension contains no filesystem write, delete, rename, or update operations.
2. **Zero Execution**: Package scripts, command strings, hooks, and npm lifecycle triggers are treated purely as inert text data. Neither `child_process.exec`, `spawn`, `eval()`, nor shell interpreters are ever invoked on package scripts.
3. **Bounded Reads (<= 1 MiB)**: The server verifies file size before reading. Files larger than 1 MiB (1,048,576 bytes) are rejected with an explicit error to prevent memory exhaustion / denial-of-service.
4. **Symlink Escape Rejection**: All target paths are checked against the canonical workspace root. Symlinks targeting directories or files outside the workspace are rejected.
5. **Inert Data Preservation**: Untrusted commands containing shell metacharacters or dangerous payloads (e.g. `rm -rf /`, `curl | sh`, `node -e "..."`) are stored and returned verbatim as strings without sanitization or expansion.
6. **No Network Access**: The server does not open network sockets, HTTP connections, or IPC channels beyond standard stdio communication with the parent process.

---

## Package ID Coexistence

To support seamless testing, evaluation, and side-by-side benchmarking:
- **`nd-workspace-checks`** ("ND Workspace Checks"): Native implementation designed for ND workflows.
- **`gpt-workspace-checks`** ("GPT Workspace Checks"): Sibling/benchmark implementation.

Both packages implement identical MCP tool names (`workspace_checks`, `workspace_checks_export`) and schema specifications. Their unique IDs allow both extensions to be installed in the same ND environment without namespace collisions.

---

## Development and Testing

The extension test suite is located at `extension/test/workspace-checks.test.mjs`.

To run the test suite:
```bash
node extension/test/workspace-checks.test.mjs
```

The test suite exercises:
- Manifest structure and schema validation (`nd-extension.json` and `nd-extension.example.json`)
- MCP protocol handshake (`initialize`, `notifications/initialized`, `ping`)
- Tool discovery and JSON schemas (`tools/list`)
- Input validation (argument rejection, unknown methods)
- Package inspection scenarios (valid scripts, missing file, missing scripts key, malformed JSON, invalid types, oversized files, outside symlinks)
- Markdown export output validation and disk write non-occurrence
