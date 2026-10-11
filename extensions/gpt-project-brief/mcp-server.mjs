#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { constants, lstatSync, realpathSync, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION_ID = 'gpt-project-brief';
export const EXTENSION_NAME = 'GPT Project Brief';
const SOURCE = '.project-brief/tasks.json';
const FILTERS = ['all', 'changes', 'open', 'blocked'];
const STATUSES = ['open', 'in_progress', 'blocked', 'done'];
const MAX_TASK_BYTES = 1024 * 1024;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => ({ content: [{ type: 'text', text: String(value) }] });
const failure = message => ({ ...text(message), isError: true });

export const TOOLS = ['project_brief', 'project_brief_export'].map(name => ({
  name,
  description: name === 'project_brief'
    ? 'Read fresh Git changes and project tasks from the startup-bound workspace; return JSON text.'
    : 'Read fresh Git changes and project tasks and return a Markdown standup/handoff brief. Does not write a file.',
  inputSchema: {
    type: 'object',
    properties: { filter: { type: 'string', enum: FILTERS, default: 'all' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Reject links component by component before opening data. In particular, do not
// realpath/read a tasks.json link first and discover the escape after the read.
function checkedPath(root, relative) {
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link in ${relative}.`);
    if (!contained(root, realpathSync(current))) throw new Error(`Path escapes the bound workspace: ${relative}.`);
  }
  return current;
}

function bindWorkspace(argv, cwd) {
  let requested = cwd;
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== '--workspace' || !path.isAbsolute(argv[1])) {
      throw new Error('Usage: node mcp-server.mjs [--workspace ABSOLUTE_PATH].');
    }
    requested = argv[1];
  }
  let root;
  try {
    root = realpathSync(requested);
    if (!lstatSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('Workspace is missing, inaccessible, or not a directory. Supply --workspace with an existing absolute directory path.');
  }
  return root;
}

function gitEnvironment() {
  // Inherited Git overrides must not redirect repository discovery or index reads.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CEILING_DIRECTORIES: path.dirname(rootForCeiling()),
  };
}

// Git uses explicit --git-dir/--work-tree below; this additionally disables
// accidental discovery if Git changes its discovery behavior.
function rootForCeiling() { return path.resolve(process.cwd()); }

function verifyRepository(root) {
  if (realpathSync(root) !== root) throw new Error('Bound workspace has moved or become a symbolic link; restart the server.');
  let metadata;
  try { metadata = checkedPath(root, '.git'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Workspace is not a Git repository root: no .git directory.');
    throw error;
  }
  if (!lstatSync(metadata).isDirectory()) {
    throw new Error('Workspace must have an in-root .git directory. Linked worktrees and external Git directories are not supported.');
  }
  // Git metadata links and includes can cause reads outside the bound root.
  // Check the metadata tree without following links before executing Git.
  checkMetadata(root, '.git');
  const configPath = path.join(metadata, 'config');
  let config = '';
  try { config = readFileSync(configPath, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (/\[\s*include(?:if)?(?:\s|\]|\.)/i.test(config.replace(/\\\r?\n/g, ''))) {
    throw new Error('Git config includes are not supported because they can read outside the bound workspace.');
  }
}

import { readdirSync } from 'node:fs';
function checkMetadata(root, relative) {
  const directory = checkedPath(root, relative);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('Git metadata symbolic links are not supported.');
    if (entry.isDirectory()) checkMetadata(root, child);
    else if (!entry.isFile()) throw new Error('Git metadata must contain only ordinary files and directories.');
    else if (['commondir', 'alternates', 'http-alternates'].includes(entry.name)) {
      throw new Error('External/shared Git metadata is not supported within a bound workspace.');
    }
  }
}

export function parsePorcelain(output) {
  const records = output.split('\0');
  const changes = [];
  const warnings = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') throw new Error('Git returned an invalid porcelain status record.');
    const code = record.slice(0, 2);
    const name = record.slice(3);
    const renamed = code.includes('R');
    const copied = code.includes('C');
    if (renamed || copied) {
      if (!records[++i]) throw new Error('Git returned an incomplete rename/copy record.');
    }
    const status = code === '??' ? 'untracked'
      : renamed ? 'renamed'
      : code.includes('D') ? 'deleted'
      : code.includes('A') || copied ? 'added' : 'modified';
    if (code.includes('U') || code === 'AA' || code === 'DD') {
      warnings.push(`Git reports an unmerged path: ${name} (${code}).`);
    }
    changes.push({ path: name, status });
  }
  changes.sort((a, b) => compare(a.path, b.path));
  return { changes, warnings };
}

function readChanges(root) {
  verifyRepository(root);
  let output;
  try {
    output = execFileSync('git', [
      '--no-optional-locks', '--no-pager',
      '--git-dir', path.join(root, '.git'), '--work-tree', root,
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'core.excludesFile=', '-c', 'core.attributesFile=',
      '-c', 'status.renames=true', '-c', 'core.quotePath=false',
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all',
    ], { cwd: root, env: gitEnvironment(), encoding: 'utf8', shell: false, windowsHide: true,
      timeout: 15000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Git executable was not found. Install Git and make it available on PATH.');
    throw new Error('Unable to read Git status. Check repository permissions/integrity; status has a 15-second timeout and a 16 MiB output limit.');
  }
  return parsePorcelain(output);
}

function readTasks(root) {
  let filename;
  try { filename = checkedPath(root, SOURCE); }
  catch (error) {
    if (error.code === 'ENOENT') return { tasks: [], warnings: [`Task source ${SOURCE} is missing; project task status is unknown.`] };
    throw new Error(`Cannot read task source ${SOURCE}: ${error.message}`);
  }
  let raw;
  let fd;
  try {
    if (!lstatSync(filename).isFile()) throw new Error('must be a regular file');
    fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TASK_BYTES) throw new Error('must be a regular file of at most 1 MiB');
    raw = readFileSync(fd, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read task source ${SOURCE}: ${error.message}`);
  } finally { if (fd !== undefined) closeSync(fd); }
  let values;
  try { values = JSON.parse(raw); }
  catch { throw new Error(`Invalid task source ${SOURCE}: malformed JSON.`); }
  if (!Array.isArray(values)) throw new Error(`Invalid task source ${SOURCE}: expected an array.`);
  const ids = new Set();
  const tasks = values.map((task, index) => {
    if (!object(task) || typeof task.id !== 'string' || !task.id.trim() ||
        typeof task.title !== 'string' || !task.title.trim() || !STATUSES.includes(task.status)) {
      throw new Error(`Invalid task source ${SOURCE}: entry ${index + 1} requires nonempty string id/title and status open, in_progress, blocked, or done.`);
    }
    if (ids.has(task.id)) throw new Error(`Invalid task source ${SOURCE}: duplicate task ID at entry ${index + 1}.`);
    ids.add(task.id);
    return { id: task.id, title: task.title, status: task.status, source: SOURCE };
  });
  tasks.sort((a, b) => compare(a.id, b.id));
  return { tasks, warnings: [] };
}

function validateArguments(args) {
  if (args === undefined) return 'all';
  if (!object(args) || Object.keys(args).some(key => key !== 'filter') ||
      (Object.hasOwn(args, 'filter') && !FILTERS.includes(args.filter))) {
    throw new Error('Arguments must be an object with only optional filter: all, changes, open, or blocked. Workspace is fixed at process startup.');
  }
  return args.filter ?? 'all';
}

function collect(root, filter) {
  const git = readChanges(root);
  const source = readTasks(root);
  const tasks = source.tasks.filter(task => filter === 'changes' ? false
    : filter === 'open' ? ['open', 'in_progress'].includes(task.status)
    : filter === 'blocked' ? task.status === 'blocked' : task.status !== 'done');
  const priority = { blocked: 0, in_progress: 1, open: 2 };
  const nextActions = [...tasks].sort((a, b) => priority[a.status] - priority[b.status] || compare(a.id, b.id))
    .map(task => task.status === 'blocked'
      ? `Review blocked task ${task.id}: ${task.title}; clarify what is needed to unblock it.`
      : task.status === 'in_progress' ? `Continue task ${task.id}: ${task.title}.`
      : `Pick up open task ${task.id}: ${task.title}.`);
  return {
    extensionId: EXTENSION_ID, workspace: root,
    changes: ['all', 'changes'].includes(filter) ? git.changes : [],
    tasks, nextActions, warnings: [...git.warnings, ...source.warnings],
  };
}

const md = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;');
function markdown(brief, filter) {
  const bullets = (items, empty) => items.length ? items.map(item => `- ${item}`).join('\n') : empty;
  return `# ${EXTENSION_NAME}\n\nWorkspace: ${md(brief.workspace)}\n\nFilter: ${filter}\n\n` +
    `## Changed paths\n\n${bullets(brief.changes.map(change => `${change.status}: ${md(change.path)}`), ['open', 'blocked'].includes(filter) ? 'Changes excluded by filter.' : 'No changed paths.')}\n\n` +
    `## Tasks\n\n${bullets(brief.tasks.map(task => `${md(task.id)} — ${md(task.title)} (${task.status}); source: ${md(task.source)}`), filter === 'changes' ? 'Tasks excluded by filter.' : 'No matching tasks available; see warnings for source availability.')}\n\n` +
    `## Warnings\n\n${bullets(brief.warnings.map(md), 'None.')}\n\n` +
    `## Suggested next actions\n\n${bullets(brief.nextActions.map(md), 'No task-based next actions in this selection.')}\n`;
}

export function createService(argv = process.argv.slice(2), cwd = process.cwd()) {
  let root;
  let startupError;
  try { root = bindWorkspace(argv, cwd); }
  catch (error) { startupError = error.message; }
  return {
    call(name, args) {
      try {
        if (!TOOLS.some(tool => tool.name === name)) return failure('Unknown tool. Available tools: project_brief, project_brief_export.');
        const filter = validateArguments(args);
        if (startupError) throw new Error(startupError);
        const brief = collect(root, filter);
        return text(name === 'project_brief' ? JSON.stringify(brief) : markdown(brief, filter));
      } catch (error) { return failure(error.message); }
    },
  };
}

export function serve() {
  const service = createService();
  const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const rpcError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch {
      console.error('Ignoring malformed JSON-RPC input line.');
      rpcError(null, -32700, 'Parse error');
      return;
    }
    if (!object(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        (Object.hasOwn(message, 'id') && message.id !== null && typeof message.id !== 'string' && typeof message.id !== 'number')) {
      rpcError(null, -32600, 'Invalid Request');
      return;
    }
    if (message.method === 'notifications/initialized' || !Object.hasOwn(message, 'id')) return;
    const reply = result => write({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize') {
      if (!object(message.params) || typeof message.params.protocolVersion !== 'string') {
        rpcError(message.id, -32602, 'initialize requires a protocolVersion string');
        return;
      }
      reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: EXTENSION_ID, title: EXTENSION_NAME, version: '1.0.0' } });
    } else if (message.method === 'ping') reply({});
    else if (message.method === 'tools/list') reply({ tools: TOOLS });
    else if (message.method === 'tools/call') {
      reply(object(message.params) ? service.call(message.params.name, message.params.arguments) : failure('tools/call requires a params object with name and optional arguments.'));
    } else rpcError(message.id, -32601, 'Method not found');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
