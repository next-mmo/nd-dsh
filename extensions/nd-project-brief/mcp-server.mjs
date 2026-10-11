#!/usr/bin/env node
/**
 * ND Project Brief - Zero-dependency MCP stdio server.
 *
 * Provides on-demand Git status inspection, project task tracking from
 * .project-brief/tasks.json, deterministic next actions, and standup/handoff Markdown briefs.
 */

import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

// Parse command line arguments once at process start
let workspaceArg = null;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if ((arg === '--workspace' || arg === '-w') && i + 1 < process.argv.length) {
    workspaceArg = process.argv[i + 1];
    i++;
  } else if (arg.startsWith('--workspace=')) {
    workspaceArg = arg.slice('--workspace='.length);
  }
}

// Bind workspace once at process start - tool arguments can never override this.
const boundWorkspace = path.resolve(workspaceArg || process.cwd());

const EXTENSION_ID = 'nd-project-brief';
const EXTENSION_NAME = 'ND Project Brief';
const TASK_SOURCE_REL_PATH = '.project-brief/tasks.json';
const VALID_TASK_STATUSES = new Set(['open', 'in_progress', 'blocked', 'done']);
const VALID_FILTERS = new Set(['all', 'changes', 'open', 'blocked']);

const TOOLS = [
  {
    name: 'project_brief',
    description: 'Get an on-demand brief of Git repository changes, open/blocked project tasks, and deterministic next actions.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'changes', 'open', 'blocked'],
          description: 'Filter tasks and changes: all (default), changes (changes only, no tasks), open (open/in_progress tasks only, no changes), or blocked (blocked tasks only, no changes).',
        },
      },
    },
  },
  {
    name: 'project_brief_export',
    description: 'Export an on-demand formatted Markdown brief of repository changes, project tasks, and next actions for standups and handoffs.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'changes', 'open', 'blocked'],
          description: 'Filter tasks and changes: all (default), changes, open, or blocked.',
        },
      },
    },
  },
];

function isSubpath(parent, child) {
  let p = path.resolve(parent);
  let c = path.resolve(child);
  if (process.platform === 'win32') {
    p = p.toLowerCase();
    c = c.toLowerCase();
  }
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function runGit(args, cwd) {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        args,
        {
          cwd,
          maxBuffer: 25 * 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error ? (typeof error.code === 'number' ? error.code : (typeof error.status === 'number' ? error.status : 1)) : 0,
            stdout: stdout || '',
            stderr: stderr || '',
            error,
          });
        },
      );
    } catch (syncError) {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: syncError instanceof Error ? syncError.message : String(syncError),
        error: syncError,
      });
    }
  });
}

async function validateWorkspaceRoot(ws) {
  let stat;
  try {
    stat = await fs.promises.stat(ws);
  } catch {
    return { ok: false, error: `Workspace root does not exist: ${ws}` };
  }

  if (!stat.isDirectory()) {
    return { ok: false, error: `Workspace root is not a directory: ${ws}` };
  }

  let hasDotGit = false;
  try {
    await fs.promises.access(path.join(ws, '.git'));
    hasDotGit = true;
  } catch {}

  const revParse = await runGit(['rev-parse', '--show-toplevel'], ws);
  if (revParse.exitCode !== 0) {
    return { ok: false, error: `Directory is not a Git repository: ${ws}` };
  }

  const gitTopLevel = path.resolve(revParse.stdout.trim());
  const resolvedWs = path.resolve(ws);
  const isMatch = process.platform === 'win32'
    ? gitTopLevel.toLowerCase() === resolvedWs.toLowerCase()
    : gitTopLevel === resolvedWs;

  if (!hasDotGit && !isMatch) {
    return { ok: false, error: `Directory is not a Git repository: ${ws}` };
  }

  return { ok: true };
}

function mapGitStatusCode(x, y) {
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'M' || y === 'M') return 'modified';
  if (x === 'T' || y === 'T') return 'modified';
  if (x === 'U' || y === 'U') return 'modified';
  return 'modified';
}

function parseGitStatus(raw) {
  const changes = [];
  if (!raw) return changes;

  const chunks = raw.split('\0');
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk || chunk.length < 3) continue;

    const x = chunk[0];
    const y = chunk[1];
    const filePath = chunk.slice(3);

    if (x === 'R' || y === 'R') {
      // In porcelain v1 -z, rename target path is followed by the source path in the next chunk
      if (i + 1 < chunks.length) {
        i++; // Exclude rename's old path from extra changes
      }
      changes.push({
        path: filePath,
        status: 'renamed',
      });
    } else {
      changes.push({
        path: filePath,
        status: mapGitStatusCode(x, y),
      });
    }
  }

  return changes;
}

async function fetchGitChanges(ws) {
  const result = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], ws);
  if (result.exitCode !== 0) {
    return {
      error: `Failed to execute git status: ${result.stderr.trim() || 'unknown error'}`,
    };
  }

  return { changes: parseGitStatus(result.stdout) };
}

async function fetchTasks(ws) {
  const warnings = [];
  const tasksFilePath = path.resolve(ws, '.project-brief', 'tasks.json');

  if (!isSubpath(ws, tasksFilePath)) {
    return {
      error: 'Security error: Task source path resolves outside the bound workspace.',
    };
  }

  let stat;
  try {
    stat = await fs.promises.stat(tasksFilePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        tasks: [],
        warnings: [`Task source file not found: ${TASK_SOURCE_REL_PATH}`],
      };
    }
    return {
      error: `Failed to access task source file: ${err.message}`,
    };
  }

  if (!stat.isFile()) {
    return {
      error: `Invalid task source: ${TASK_SOURCE_REL_PATH} is not a file.`,
    };
  }

  // Symlink protection: ensure neither .project-brief nor tasks.json escapes bound workspace
  try {
    const realWs = await fs.promises.realpath(ws);
    const realTasksPath = await fs.promises.realpath(tasksFilePath);
    if (!isSubpath(realWs, realTasksPath)) {
      return {
        error: 'Security error: Task source symlink points outside the bound workspace.',
      };
    }
  } catch (err) {
    return {
      error: `Security error resolving task source symlink: ${err.message}`,
    };
  }

  let content;
  try {
    content = await fs.promises.readFile(tasksFilePath, 'utf8');
  } catch (err) {
    return {
      error: `Failed to read task source file: ${err.message}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      error: `Malformed task source in ${TASK_SOURCE_REL_PATH}: ${err.message}`,
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      error: `Invalid task source in ${TASK_SOURCE_REL_PATH}: root must be an array of tasks.`,
    };
  }

  const tasks = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return {
        error: `Invalid task at index ${i} in ${TASK_SOURCE_REL_PATH}: task must be an object.`,
      };
    }

    if (item.id === undefined || item.id === null || String(item.id).trim() === '') {
      return {
        error: `Invalid task at index ${i} in ${TASK_SOURCE_REL_PATH}: missing or empty "id".`,
      };
    }

    if (typeof item.title !== 'string') {
      return {
        error: `Invalid task at index ${i} in ${TASK_SOURCE_REL_PATH}: "title" must be a string.`,
      };
    }

    if (typeof item.status !== 'string' || !VALID_TASK_STATUSES.has(item.status)) {
      return {
        error: `Invalid task at index ${i} (${item.id}) in ${TASK_SOURCE_REL_PATH}: status must be one of: open, in_progress, blocked, done. Got: "${item.status}".`,
      };
    }

    tasks.push({
      id: String(item.id),
      title: item.title,
      status: item.status,
      source: TASK_SOURCE_REL_PATH,
    });
  }

  return { tasks, warnings };
}

function generateNextActions(tasks) {
  const actions = [];
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const inProgress = tasks.filter((t) => t.status === 'in_progress');
  const open = tasks.filter((t) => t.status === 'open');

  for (const t of blocked) {
    actions.push(`Unblock task ${t.id}: ${t.title}`);
  }
  for (const t of inProgress) {
    actions.push(`Continue task ${t.id}: ${t.title}`);
  }
  for (const t of open) {
    actions.push(`Start task ${t.id}: ${t.title}`);
  }

  return actions;
}

async function collectBriefData(args, ws = boundWorkspace) {
  const filter = args?.filter ?? 'all';
  if (typeof filter !== 'string' || !VALID_FILTERS.has(filter)) {
    return {
      error: `Invalid filter: "${filter}". Allowed values are: all, changes, open, blocked.`,
    };
  }

  // Validate workspace root
  const wsValidation = await validateWorkspaceRoot(ws);
  if (!wsValidation.ok) {
    return { error: wsValidation.error };
  }

  // Fetch Git changes
  const gitResult = await fetchGitChanges(ws);
  if (gitResult.error) {
    return { error: gitResult.error };
  }

  // Fetch tasks
  const taskResult = await fetchTasks(ws);
  if (taskResult.error) {
    return { error: taskResult.error };
  }

  const allChanges = gitResult.changes;
  const allTasks = taskResult.tasks;
  const warnings = taskResult.warnings || [];

  let selectedChanges = [];
  let selectedTasks = [];

  if (filter === 'all') {
    selectedChanges = allChanges;
    selectedTasks = allTasks.filter((t) => t.status !== 'done');
  } else if (filter === 'changes') {
    selectedChanges = allChanges;
    selectedTasks = [];
  } else if (filter === 'open') {
    selectedChanges = [];
    selectedTasks = allTasks.filter((t) => t.status === 'open' || t.status === 'in_progress');
  } else if (filter === 'blocked') {
    selectedChanges = [];
    selectedTasks = allTasks.filter((t) => t.status === 'blocked');
  }

  const nextActions = generateNextActions(selectedTasks);

  return {
    data: {
      extensionId: EXTENSION_ID,
      workspace: ws,
      changes: selectedChanges,
      tasks: selectedTasks,
      nextActions,
      warnings,
    },
  };
}

function renderMarkdownBrief(data) {
  const lines = [];
  lines.push(`# ${EXTENSION_NAME}`);
  lines.push('');
  lines.push(`**Workspace:** \`${data.workspace}\``);
  lines.push('');

  lines.push('## Changed Paths');
  if (data.changes.length === 0) {
    lines.push('- No changes detected.');
  } else {
    for (const c of data.changes) {
      lines.push(`- \`${c.path}\` (${c.status})`);
    }
  }
  lines.push('');

  lines.push('## Project Tasks');
  if (data.tasks.length === 0) {
    lines.push('- No active tasks.');
  } else {
    for (const t of data.tasks) {
      lines.push(`- [${t.status}] **${t.id}**: ${t.title} (Source: \`${t.source}\`)`);
    }
  }
  lines.push('');

  lines.push('## Suggested Next Actions');
  if (data.nextActions.length === 0) {
    lines.push('- No suggested next actions.');
  } else {
    for (let i = 0; i < data.nextActions.length; i++) {
      lines.push(`${i + 1}. ${data.nextActions[i]}`);
    }
  }
  lines.push('');

  if (data.warnings.length > 0) {
    lines.push('## Warnings');
    for (const w of data.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function callTool(name, args) {
  // Tool arguments must NEVER switch the bound workspace root
  if (name === 'project_brief') {
    const res = await collectBriefData(args, boundWorkspace);
    if (res.error) {
      return {
        isError: true,
        content: [{ type: 'text', text: res.error }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
    };
  }

  if (name === 'project_brief_export') {
    const res = await collectBriefData(args, boundWorkspace);
    if (res.error) {
      return {
        isError: true,
        content: [{ type: 'text', text: res.error }],
      };
    }
    return {
      content: [{ type: 'text', text: renderMarkdownBrief(res.data) }],
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }],
  };
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handleMessage(msg, customWriter = write) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.method === 'initialize') {
    customWriter({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: {
          name: EXTENSION_ID,
          version: '1.0.0',
        },
      },
    });
    return;
  }

  if (msg.method === 'notifications/initialized') {
    return;
  }

  if (msg.method === 'ping') {
    customWriter({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'tools/list') {
    customWriter({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: TOOLS },
    });
    return;
  }

  if (msg.method === 'tools/call') {
    const toolResult = await callTool(msg.params?.name, msg.params?.arguments);
    customWriter({
      jsonrpc: '2.0',
      id: msg.id,
      result: toolResult,
    });
    return;
  }

  if (msg.id !== undefined) {
    customWriter({
      jsonrpc: '2.0',
      id: msg.id,
      error: {
        code: -32601,
        message: `Method not found: ${String(msg.method)}`,
      },
    });
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const current = fileURLToPath(import.meta.url);
    const main = path.resolve(process.argv[1]);
    return process.platform === 'win32'
      ? current.toLowerCase() === main.toLowerCase()
      : current === main;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const lines = createInterface({ input: process.stdin, terminal: false });

  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      console.error('JSON-RPC parse error on input line:', err.message);
      return;
    }

    handleMessage(msg).catch((err) => {
      console.error('Unhandled error processing JSON-RPC message:', err);
      if (msg && msg.id !== undefined) {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32603,
            message: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
    });
  });
}

export {
  boundWorkspace,
  validateWorkspaceRoot,
  mapGitStatusCode,
  parseGitStatus,
  fetchGitChanges,
  fetchTasks,
  generateNextActions,
  collectBriefData,
  renderMarkdownBrief,
  callTool,
  handleMessage,
  TOOLS,
  EXTENSION_ID,
  EXTENSION_NAME,
};
