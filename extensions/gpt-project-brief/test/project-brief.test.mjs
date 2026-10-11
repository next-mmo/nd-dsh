import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, realpathSync, renameSync, unlinkSync, rmSync, rmdirSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, parsePorcelain } from '../mcp-server.mjs';

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspace = path.dirname(extension);
const server = path.join(extension, 'mcp-server.mjs');
const fixtureBase = path.join(extension, 'test', '.fixtures');
mkdirSync(fixtureBase, { recursive: true });
const suites = [];
test.after(() => {
  for (const target of suites) {
    // Deletion is constrained to this test's own verified fixture directories.
    const relative = path.relative(fixtureBase, target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    rmSync(target, { recursive: true, force: true });
  }
  if (readdirSync(fixtureBase).length === 0) rmdirSync(fixtureBase);
});

function fixture() {
  const root = mkdtempSync(path.join(fixtureBase, 'gpt-'));
  suites.push(root);
  return realpathSync(root);
}
function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
function repo() { const root = fixture(); git(root, 'init'); return root; }
function tasks(root, value) {
  mkdirSync(path.join(root, '.project-brief'), { recursive: true });
  writeFileSync(path.join(root, '.project-brief', 'tasks.json'), JSON.stringify(value));
}
function brief(service, args) {
  const result = service.call('project_brief', args);
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}
function snapshot(root) {
  const result = {};
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) result[path.relative(root, name)] = {
        sha: createHash('sha256').update(readFileSync(name)).digest('hex'),
        mtime: lstatSync(name).mtimeMs,
      };
    }
  }
  visit(root);
  return result;
}
function rpc(root, lines, args = ['--workspace', root], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server, ...args], {
      cwd: root, windowsHide: true, env: { ...process.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('MCP test timed out')); }, 20000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      try {
        assert.equal(code, 0, stderr);
        resolve({ messages: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), stderr });
      } catch (error) { reject(error); }
    });
    child.stdin.end(lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
  });
}
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

test('native package validates against the supplied ND validator; legacy registration is disabled', async () => {
  const manifest = JSON.parse(readFileSync(path.join(extension, 'nd-extension.json')));
  const source = readFileSync(path.join(workspace, 'reference', 'extension-package.ts'), 'utf8');
  // The standalone reference omits nd-context.js. Supply only that dependency
  // in memory, preserving the validator's actual implementation and files.
  const prepared = source.replace(/import\s*\{[\s\S]*?\}\s*from '\.\/nd-context\.js'/,
    "const ND_CONTEXT_KINDS = ['personal', 'company', 'project']; const isNdContextKind = value => ND_CONTEXT_KINDS.includes(value);");
  const module = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(prepared)).toString('base64')}`);
  const validation = module.validateNdExtensionManifest(manifest);
  assert.equal(validation.ok, true, JSON.stringify(validation));
  assert.deepEqual(module.manifestPermissionIssues(validation.manifest), []);
  assert.equal(manifest.id, 'gpt-project-brief');
  assert.equal(manifest.name, 'GPT Project Brief');
  assert.deepEqual(manifest.contributions.tools.map(tool => tool.toolName), ['project_brief', 'project_brief_export']);
  assert.ok(manifest.contributions.skills.length);
  assert.ok(path.isAbsolute(manifest.executable.args[0]));
  assert.equal(realpathSync(manifest.executable.args[0]), realpathSync(server));
  const legacy = JSON.parse(readFileSync(path.join(extension, 'nd-extension.example.json')));
  assert.equal(legacy.id, manifest.id);
  assert.equal(legacy.surface, 'mcp');
  assert.equal(legacy.enabled, false);
  assert.match(legacy.runtime, /^node .*ABSOLUTE.*mcp-server\.mjs/);
  assert.deepEqual(legacy.engineRoutes, []);
  assert.deepEqual(legacy.providerRoutes, []);
});

test('real Git status includes all required states, spaces, Unicode, and rename destination only', () => {
  const root = repo();
  for (const name of ['modify me.txt', 'delete me.txt', 'old 名.txt']) writeFileSync(path.join(root, name), 'original\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture');
  writeFileSync(path.join(root, 'modify me.txt'), 'changed\n');
  unlinkSync(path.join(root, 'delete me.txt'));
  renameSync(path.join(root, 'old 名.txt'), path.join(root, 'new 名.txt'));
  git(root, 'add', '--', 'old 名.txt', 'new 名.txt');
  writeFileSync(path.join(root, 'added.txt'), 'added'); git(root, 'add', '--', 'added.txt');
  mkdirSync(path.join(root, 'new folder'));
  writeFileSync(path.join(root, 'new folder', '你好 space.txt'), 'untracked');
  const before = snapshot(root);
  const service = createService(['--workspace', root]);
  const result = brief(service);
  assert.deepEqual(result.changes, [
    { path: 'added.txt', status: 'added' }, { path: 'delete me.txt', status: 'deleted' },
    { path: 'modify me.txt', status: 'modified' }, { path: 'new folder/你好 space.txt', status: 'untracked' },
    { path: 'new 名.txt', status: 'renamed' },
  ]);
  assert.equal(result.workspace, root);
  assert.equal(result.extensionId, 'gpt-project-brief');
  assert.match(result.warnings[0], /missing.*unknown/);
  assert.deepEqual(result.nextActions, []);
  service.call('project_brief_export', {});
  assert.deepEqual(snapshot(root), before, 'Both tools leave files and Git metadata unchanged');
});

test('porcelain parser consumes old rename/copy paths and preserves unusual names', () => {
  assert.deepEqual(parsePorcelain('R  new -> 名\0old name\0?? quote"file\0 M line\nbreak\0C  copy\0original\0').changes, [
    { path: 'copy', status: 'added' }, { path: 'line\nbreak', status: 'modified' },
    { path: 'new -> 名', status: 'renamed' }, { path: 'quote"file', status: 'untracked' },
  ]);
  assert.throws(() => parsePorcelain('R  new\0'), /incomplete/);
  assert.match(parsePorcelain('UU conflicted\0').warnings[0], /unmerged/);
});

test('task filters and deterministic evidence-based next actions', () => {
  const root = repo();
  tasks(root, [
    { id: 'D', title: 'Finished', status: 'done' }, { id: 'A', title: 'First open', status: 'open' },
    { id: 'Z', title: 'Await review', status: 'blocked' }, { id: 'C', title: 'Implement feature', status: 'in_progress' },
    { id: 'B', title: 'Second open', status: 'open' },
  ]);
  const service = createService(['--workspace', root]);
  const all = brief(service);
  assert.deepEqual(all.tasks.map(task => task.id), ['A', 'B', 'C', 'Z']);
  assert.ok(all.tasks.every(task => task.source === '.project-brief/tasks.json'));
  assert.deepEqual(all.nextActions, [
    'Review blocked task Z: Await review; clarify what is needed to unblock it.',
    'Continue task C: Implement feature.', 'Pick up open task A: First open.', 'Pick up open task B: Second open.',
  ]);
  assert.deepEqual(brief(service, { filter: 'all' }), all);
  const open = brief(service, { filter: 'open' });
  assert.deepEqual(open.changes, []);
  assert.deepEqual(open.tasks.map(task => task.id), ['A', 'B', 'C']);
  const blocked = brief(service, { filter: 'blocked' });
  assert.deepEqual(blocked.changes, []);
  assert.deepEqual(blocked.tasks.map(task => task.id), ['Z']);
  const changes = brief(service, { filter: 'changes' });
  assert.deepEqual(changes.tasks, []);
  assert.deepEqual(changes.nextActions, []);
  assert.ok(changes.changes.length);
});

test('each call refreshes Git and task data; export contains fresh evidence and escapes Markdown', () => {
  const root = repo();
  tasks(root, []);
  const service = createService(['--workspace', root]);
  assert.deepEqual(brief(service).tasks, []);
  tasks(root, [{ id: 'X-1', title: 'Review <script> [link](url)\nheading', status: 'blocked' }]);
  writeFileSync(path.join(root, 'fresh.txt'), 'new');
  const result = service.call('project_brief_export', {});
  assert.notEqual(result.isError, true);
  const markdown = result.content[0].text;
  for (const part of ['# GPT Project Brief', '## Changed paths', 'fresh\\.txt', 'X\\-1', '(blocked)',
    '## Warnings', '## Suggested next actions', 'Review blocked task', '&lt;script&gt;', '&#10;']) assert.ok(markdown.includes(part), part);
  assert.equal(brief(service).tasks[0].status, 'blocked');
  unlinkSync(path.join(root, '.project-brief', 'tasks.json'));
  assert.match(service.call('project_brief_export').content[0].text, /missing; project task status is unknown/);
});

test('malformed/invalid task data is an explicit error even under changes filter', () => {
  const root = repo(); tasks(root, []);
  const service = createService(['--workspace', root]);
  for (const value of ['{', '{}', '[{"id":"X","title":"A","status":"waiting"}]',
    '[{"id":1,"title":"A","status":"open"}]', '[{"id":"X","title":"","status":"open"}]',
    '[{"id":"X","title":"A","status":"open"},{"id":"X","title":"B","status":"done"}]']) {
    writeFileSync(path.join(root, '.project-brief', 'tasks.json'), value);
    for (const name of ['project_brief', 'project_brief_export']) {
      const result = service.call(name, { filter: 'changes' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Invalid task source/);
    }
  }
});

test('invalid tool inputs cannot redirect the bound workspace', () => {
  const root = repo(); tasks(root, []);
  const service = createService(['--workspace', root]);
  for (const args of [null, [], 'all', { filter: null }, { filter: 'done' }, { filter: 1 },
    { workspace: fixture() }, { root: '..' }, { path: '../outside' }]) {
    assert.equal(service.call('project_brief', args).isError, true);
  }
  assert.equal(service.call('unknown', {}).isError, true);
  assert.equal(brief(service).workspace, root);
});

test('startup roots: absolute flag, missing, file, non-Git, and nested directory', () => {
  assert.match(createService(['--workspace', 'relative']).call('project_brief').content[0].text, /ABSOLUTE_PATH/);
  const root = fixture();
  assert.match(createService(['--workspace', path.join(root, 'missing')]).call('project_brief').content[0].text, /missing/);
  writeFileSync(path.join(root, 'file'), 'x');
  assert.equal(createService(['--workspace', path.join(root, 'file')]).call('project_brief').isError, true);
  assert.match(createService(['--workspace', root]).call('project_brief').content[0].text, /not a Git repository/);
  git(root, 'init'); mkdirSync(path.join(root, 'nested'));
  assert.equal(createService(['--workspace', path.join(root, 'nested')]).call('project_brief').isError, true);
});

test('escaping task directory symlink/junction is refused, never read', () => {
  const root = repo(), outside = fixture();
  writeFileSync(path.join(outside, 'tasks.json'), '[{"id":"outside","title":"must not be read","status":"open"}]');
  symlinkSync(outside, path.join(root, '.project-brief'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = createService(['--workspace', root]).call('project_brief');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /symbolic link/);
  assert.ok(!result.content[0].text.includes('must not be read'));
});

test('task file symlink is refused when the OS permits creating one', t => {
  const root = repo(), outside = fixture();
  writeFileSync(path.join(outside, 'tasks.json'), '[]'); mkdirSync(path.join(root, '.project-brief'));
  try { symlinkSync(path.join(outside, 'tasks.json'), path.join(root, '.project-brief', 'tasks.json'), 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('OS denies file-symlink creation'); throw error; }
  assert.equal(createService(['--workspace', root]).call('project_brief').isError, true);
});

test('external Git metadata and config includes are rejected', () => {
  const root = fixture();
  writeFileSync(path.join(root, '.git'), 'gitdir: ../outside');
  assert.match(createService(['--workspace', root]).call('project_brief').content[0].text, /in-root .git directory/);
  const included = repo();
  writeFileSync(path.join(included, '.git', 'config'), '[include]\n path = ../outside\n');
  assert.match(createService(['--workspace', included]).call('project_brief').content[0].text, /includes are not supported/);
});

test('MCP stdio supports multiple requests, notifications, malformed recovery, and all error shapes', async () => {
  const root = repo(); tasks(root, []);
  const { messages, stderr } = await rpc(root, [
    request(0, 'initialize', { protocolVersion: '2025-03-26' }),
    { jsonrpc: '2.0', method: 'notifications/initialized' }, '{broken',
    request('ping', 'ping'), request(2, 'tools/list'), request(3, 'tools/call', { name: 'project_brief' }),
    request(4, 'tools/call', { name: 'project_brief_export', arguments: { filter: 'blocked' } }),
    request(5, 'not-supported'), request(6, 'tools/call', { name: 'wrong' }),
    request(7, 'tools/call', { name: 'project_brief', arguments: { root: '../outside' } }),
    'null', request(8, 'ping'),
  ]);
  assert.equal(messages.length, 11);
  assert.equal(messages[0].result.protocolVersion, '2025-03-26');
  assert.equal(messages[0].result.serverInfo.name, 'gpt-project-brief');
  assert.deepEqual(messages[0].result.capabilities, { tools: {} });
  assert.equal(messages[1].error.code, -32700);
  assert.match(stderr, /malformed/);
  assert.deepEqual(messages.find(message => message.id === 'ping').result, {});
  assert.equal(messages.find(message => message.id === 2).result.tools.length, 2);
  assert.equal(JSON.parse(messages.find(message => message.id === 3).result.content[0].text).workspace, root);
  assert.match(messages.find(message => message.id === 4).result.content[0].text, /^# GPT Project Brief/);
  assert.equal(messages.find(message => message.id === 5).error.code, -32601);
  assert.equal(messages.find(message => message.id === 6).result.isError, true);
  assert.equal(messages.find(message => message.id === 7).result.isError, true);
  assert.deepEqual(messages.find(message => message.id === 8).result, {});
});

test('stdio defaults to cwd and ignores inherited Git redirection', async () => {
  const root = repo(); tasks(root, []);
  const { messages } = await rpc(root, [request(1, 'tools/call', { name: 'project_brief' })], [], {
    GIT_DIR: path.join(fixture(), 'not-a-repository'), GIT_WORK_TREE: fixture(),
  });
  assert.notEqual(messages[0].result.isError, true, messages[0].result.content[0].text);
  assert.equal(JSON.parse(messages[0].result.content[0].text).workspace, root);
});
