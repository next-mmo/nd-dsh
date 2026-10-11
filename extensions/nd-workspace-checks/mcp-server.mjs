#!/usr/bin/env node
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// 1. Workspace Binding
let workspaceArg = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--workspace') {
    if (i + 1 < argv.length) {
      workspaceArg = argv[++i];
    }
  } else if (arg.startsWith('--workspace=')) {
    workspaceArg = arg.slice('--workspace='.length);
  }
}

const rawRoot = workspaceArg ?? process.cwd();
const resolvedRoot = path.resolve(rawRoot);

let boundRootReal;
try {
  const rootStat = fs.statSync(resolvedRoot);
  if (!rootStat.isDirectory()) {
    console.error(`Invalid workspace root: "${resolvedRoot}" is not a directory.`);
    process.exit(1);
  }
  boundRootReal = fs.realpathSync(resolvedRoot);
} catch (error) {
  console.error(`Invalid workspace root: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function formatMarkdown({ checks, scripts, warnings }) {
  const lines = ['# ND Workspace Checks', ''];
  if (warnings && warnings.length > 0) {
    lines.push('## Warnings');
    for (const w of warnings) {
      lines.push(`- ${w}`);
    }
    lines.push('');
  }
  lines.push('## Checks');
  for (const c of checks) {
    lines.push(`- [${c.available ? 'x' : ' '}] ${c.name} (${c.available ? 'available' : 'unavailable'})`);
  }
  lines.push('');
  lines.push('## Scripts');
  if (scripts.length === 0) {
    lines.push('No scripts found.');
  } else {
    for (const s of scripts) {
      lines.push(`- **${s.name}**: \`${s.command}\``);
    }
  }
  return lines.join('\n') + '\n';
}

function handleToolsCall(message) {
  const toolName = message.params?.name;
  if (toolName !== 'workspace_checks' && toolName !== 'workspace_checks_export') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${String(toolName)}` }],
      },
    };
  }

  const args = message.params?.arguments;
  if (args !== undefined) {
    if (typeof args !== 'object' || args === null || Array.isArray(args) || Object.keys(args).length > 0) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: 'Tool does not accept arguments' }],
        },
      };
    }
  }

  const targetPath = path.join(resolvedRoot, 'package.json');

  // a) Check existence with fs.lstatSync(targetPath) (catch ENOENT)
  let lstat;
  try {
    lstat = fs.lstatSync(targetPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      if (toolName === 'workspace_checks') {
        const payload = {
          extensionId: 'nd-workspace-checks',
          scripts: [],
          checks: [
            { name: 'verify', available: false },
            { name: 'typecheck', available: false },
            { name: 'test', available: false },
            { name: 'build', available: false },
          ],
          warnings: ['package.json not found in workspace root'],
        };
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
          },
        };
      }
      // workspace_checks_export
      const text =
        '# ND Workspace Checks\n\n## Warnings\n- package.json not found in workspace root\n\n## Checks\n- [ ] verify (unavailable)\n- [ ] typecheck (unavailable)\n- [ ] test (unavailable)\n- [ ] build (unavailable)\n\n## Scripts\nNo package.json found.\n';
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text }],
        },
      };
    }
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: `Failed to inspect package.json: ${err.message}` }],
      },
    };
  }

  // b) Symlink containment check
  if (lstat.isSymbolicLink()) {
    let targetReal;
    try {
      targetReal = fs.realpathSync(targetPath);
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `Failed to resolve package.json symlink: ${err.message}` }],
        },
      };
    }

    const rootNorm = process.platform === 'win32' ? boundRootReal.toLowerCase() : boundRootReal;
    const targetNorm = process.platform === 'win32' ? targetReal.toLowerCase() : targetReal;
    const rel = path.relative(rootNorm, targetNorm);

    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: 'package.json symlink points outside the bound workspace root' }],
        },
      };
    }
  }

  // Regular file and size check
  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: `Failed to stat package.json: ${err.message}` }],
      },
    };
  }

  if (!stat.isFile()) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'package.json is not a regular file' }],
      },
    };
  }

  // c) Input size limit (at most 1 MiB = 1,048,576 bytes)
  if (stat.size > 1048576) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'package.json exceeds 1 MiB size limit' }],
      },
    };
  }

  // d) Read content with fs.readFileSync(targetPath, 'utf8')
  let content;
  try {
    content = fs.readFileSync(targetPath, 'utf8');
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: `Failed to read package.json: ${err.message}` }],
      },
    };
  }

  if (Buffer.byteLength(content, 'utf8') > 1048576) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'package.json exceeds 1 MiB size limit' }],
      },
    };
  }

  // e) JSON parsing
  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: `Failed to parse package.json: ${err.message}` }],
      },
    };
  }

  // f) Package JSON validation
  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: 'package.json must be a JSON object' }],
      },
    };
  }

  const scripts = [];
  if ('scripts' in pkg && pkg.scripts !== undefined) {
    if (typeof pkg.scripts !== 'object' || pkg.scripts === null || Array.isArray(pkg.scripts)) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          isError: true,
          content: [{ type: 'text', text: 'package.json scripts must be an object' }],
        },
      };
    }
    for (const [k, v] of Object.entries(pkg.scripts)) {
      if (typeof v !== 'string') {
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `Script command for "${k}" must be a string` }],
          },
        };
      }
      scripts.push({ name: k, command: v });
    }
  }

  // h) Data computation
  scripts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const standardChecks = ['verify', 'typecheck', 'test', 'build'];
  const checks = standardChecks.map((name) => ({
    name,
    available: Boolean(pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, name)),
  }));

  const warnings = [];

  // i) Output response
  if (toolName === 'workspace_checks') {
    const payload = {
      extensionId: 'nd-workspace-checks',
      scripts,
      checks,
      warnings,
    };
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      },
    };
  }

  // workspace_checks_export
  return {
    jsonrpc: '2.0',
    id: message.id,
    result: {
      content: [{ type: 'text', text: formatMarkdown({ checks, scripts, warnings }) }],
    },
  };
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') {
    console.error('Invalid JSON-RPC message: not an object');
    return;
  }

  const { method, id } = message;

  if (method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nd-workspace-checks', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    return;
  }

  if (method === 'ping') {
    writeMessage({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'tools/list') {
    writeMessage({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'workspace_checks',
            description: 'Inspect available package.json scripts and verification checks without executing them.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
          {
            name: 'workspace_checks_export',
            description: 'Export available package.json scripts and verification checks as Markdown.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const response = handleToolsCall(message);
    writeMessage(response);
    return;
  }

  if (id !== undefined) {
    writeMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${String(method)}`,
      },
    });
  }
}

const rl = createInterface({
  input: process.stdin,
  output: undefined,
  terminal: false,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (err) {
    console.error(`Failed to parse JSON input: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    handleMessage(message);
  } catch (err) {
    console.error(`Error handling message: ${err instanceof Error ? err.message : String(err)}`);
  }
});
