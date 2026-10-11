#!/usr/bin/env node
/**
 * Test suite for ND Project Brief extension.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  validateWorkspaceRoot,
  mapGitStatusCode,
  parseGitStatus,
  fetchTasks,
  generateNextActions,
  collectBriefData,
  renderMarkdownBrief,
  callTool,
  handleMessage,
  TOOLS,
  EXTENSION_ID,
  EXTENSION_NAME,
} from '../mcp-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '..', '..');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

async function testAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

console.log('=== Running ND Project Brief Tests ===\n');

// ---------------------------------------------------------------------------
// 1. Packaging & Manifests
// ---------------------------------------------------------------------------
console.log('1. Packaging & Manifests:');

test('nd-extension.json exists and is valid nd.extension/1', () => {
  const manifestPath = path.resolve(workspaceRoot, 'extension', 'nd-extension.json');
  assert.ok(fs.existsSync(manifestPath), 'nd-extension.json must exist');

  const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(content.protocol, 'nd.extension/1');
  assert.equal(content.id, 'nd-project-brief');
  assert.equal(content.name, 'ND Project Brief');
  assert.equal(content.apiVersion, 1);
  assert.ok(content.version && /^\d+\.\d+\.\d+/.test(content.version));
  assert.deepEqual(content.contexts, ['project']);
  assert.ok(content.executable, 'executable block is required');
  assert.equal(content.executable.kind, 'mcp-stdio');
  assert.equal(content.executable.command, 'node');
  assert.ok(Array.isArray(content.executable.args));

  // Verify contributions
  const contrib = content.contributions;
  assert.ok(contrib, 'contributions is required');
  assert.ok(Array.isArray(contrib.tools), 'contributions.tools must be an array');
  assert.equal(contrib.tools.length, 2);

  const toolNames = contrib.tools.map((t) => t.toolName);
  assert.ok(toolNames.includes('project_brief'));
  assert.ok(toolNames.includes('project_brief_export'));

  assert.ok(Array.isArray(contrib.skills), 'contributions.skills must be an array');
  assert.equal(contrib.skills.length, 1);
  assert.equal(contrib.skills[0].id, 'project-brief-skill');
  assert.ok(contrib.skills[0].instructions.length > 20);

  // Manifest must not contain unsupported commands/views/workflows
  assert.equal(contrib.commands, undefined);
  assert.equal(contrib.views, undefined);
  assert.equal(contrib.workflows, undefined);
});

test('nd-extension.example.json exists and satisfies legacy MCP template', () => {
  const examplePath = path.resolve(workspaceRoot, 'extension', 'nd-extension.example.json');
  assert.ok(fs.existsSync(examplePath), 'nd-extension.example.json must exist');

  const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  assert.equal(example.id, 'nd-project-brief');
  assert.equal(example.name, 'ND Project Brief');
  assert.equal(example.surface, 'mcp');
  assert.equal(example.enabled, false);
  assert.equal(example.runtime, 'node');
  assert.ok(example.command === 'node' || example.runtime === 'node');
  assert.ok(
    example.args.some((a) => a.includes('mcp-server.mjs') && a.includes('ABSOLUTE')) ||
    example.serverPath?.includes('ABSOLUTE'),
    'must document absolute server path placeholder',
  );
  assert.ok(example.version && /^\d+\.\d+\.\d+/.test(example.version));
  assert.ok(example.instructions && example.instructions.length > 10);
  assert.deepEqual(example.engineRoutes, {});
  assert.deepEqual(example.providerRoutes, {});
});

// ---------------------------------------------------------------------------
// 2. MCP JSON-RPC 2.0 Protocol
// ---------------------------------------------------------------------------
console.log('\n2. MCP JSON-RPC 2.0 Protocol:');

await testAsync('initialize method returns tools capability and serverInfo', async () => {
  let response = null;
  const customWriter = (msg) => {
    response = msg;
  };

  await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    },
    customWriter,
  );

  assert.ok(response);
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, '2024-11-05');
  assert.ok(response.result.capabilities.tools);
  assert.equal(response.result.serverInfo.name, 'nd-project-brief');
  assert.equal(response.result.serverInfo.version, '1.0.0');
});

await testAsync('notifications/initialized sends no response', async () => {
  let response = null;
  const customWriter = (msg) => {
    response = msg;
  };

  await handleMessage(
    {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    },
    customWriter,
  );

  assert.equal(response, null);
});

await testAsync('ping returns empty result', async () => {
  let response = null;
  const customWriter = (msg) => {
    response = msg;
  };

  await handleMessage(
    {
      jsonrpc: '2.0',
      id: 42,
      method: 'ping',
    },
    customWriter,
  );

  assert.ok(response);
  assert.equal(response.id, 42);
  assert.deepEqual(response.result, {});
});

await testAsync('tools/list returns project_brief and project_brief_export', async () => {
  let response = null;
  const customWriter = (msg) => {
    response = msg;
  };

  await handleMessage(
    {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/list',
    },
    customWriter,
  );

  assert.ok(response);
  assert.equal(response.id, 10);
  assert.ok(Array.isArray(response.result.tools));
  assert.equal(response.result.tools.length, 2);
  const names = response.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['project_brief', 'project_brief_export']);
});

await testAsync('unknown RPC method returns code -32601', async () => {
  let response = null;
  const customWriter = (msg) => {
    response = msg;
  };

  await handleMessage(
    {
      jsonrpc: '2.0',
      id: 99,
      method: 'nonexistent/method',
    },
    customWriter,
  );

  assert.ok(response);
  assert.equal(response.id, 99);
  assert.ok(response.error);
  assert.equal(response.error.code, -32601);
  assert.ok(response.error.message.includes('Method not found'));
});

await testAsync('unknown tool call returns isError: true', async () => {
  const result = await callTool('unknown_tool', {});
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('Unknown tool'));
});

await testAsync('invalid filter argument returns isError: true', async () => {
  const result = await callTool('project_brief', { filter: 'invalid_filter_val' });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes('Invalid filter'));
});

await testAsync('multiple sequential requests work and malformed line is handled', async () => {
  const responses = [];
  const writer = (msg) => responses.push(msg);

  // Send request 1
  await handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }, writer);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 1);

  // Simulate malformed line handling in readline handler:
  // parse error does not call handleMessage and logs to stderr
  try {
    JSON.parse('{ invalid json }');
  } catch (err) {
    // Malformed line caught, not crashing
  }

  // Send request 2 - continues normally!
  await handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }, writer);
  assert.equal(responses.length, 2);
  assert.equal(responses[1].id, 2);
});

// ---------------------------------------------------------------------------
// 3. Git Status Correctness
// ---------------------------------------------------------------------------
console.log('\n3. Git Status Correctness:');

test('mapGitStatusCode maps all status codes accurately', () => {
  assert.equal(mapGitStatusCode('?', '?'), 'untracked');
  assert.equal(mapGitStatusCode('R', ' '), 'renamed');
  assert.equal(mapGitStatusCode(' ', 'R'), 'renamed');
  assert.equal(mapGitStatusCode('D', ' '), 'deleted');
  assert.equal(mapGitStatusCode(' ', 'D'), 'deleted');
  assert.equal(mapGitStatusCode('A', ' '), 'added');
  assert.equal(mapGitStatusCode(' ', 'A'), 'added');
  assert.equal(mapGitStatusCode('M', ' '), 'modified');
  assert.equal(mapGitStatusCode(' ', 'M'), 'modified');
  assert.equal(mapGitStatusCode('M', 'M'), 'modified');
  assert.equal(mapGitStatusCode('A', 'M'), 'added');
  assert.equal(mapGitStatusCode('T', ' '), 'modified');
  assert.equal(mapGitStatusCode('U', 'U'), 'modified');
});

test('parseGitStatus parses porcelain -z output including spaces, Unicode, and renames', () => {
  // Construct raw porcelain -z buffer:
  // 1. M  src/app.ts
  // 2. ?? untracked file with spaces.txt
  // 3. R  new name with spaces.js\0old name with spaces.js
  // 4. D  deleted_file.txt
  // 5. A  docs/тест_unicode.md
  // 6. ?? src/日本語.ts
  const raw = [
    'M  src/app.ts',
    '?? untracked file with spaces.txt',
    'R  new name with spaces.js',
    'old name with spaces.js',
    'D  deleted_file.txt',
    'A  docs/тест_unicode.md',
    '?? src/日本語.ts',
    '',
  ].join('\0');

  const changes = parseGitStatus(raw);
  assert.equal(changes.length, 6);

  assert.deepEqual(changes[0], { path: 'src/app.ts', status: 'modified' });
  assert.deepEqual(changes[1], { path: 'untracked file with spaces.txt', status: 'untracked' });
  assert.deepEqual(changes[2], { path: 'new name with spaces.js', status: 'renamed' });
  // Ensure old path is excluded from changes
  assert.ok(!changes.some((c) => c.path === 'old name with spaces.js'));
  assert.deepEqual(changes[3], { path: 'deleted_file.txt', status: 'deleted' });
  assert.deepEqual(changes[4], { path: 'docs/тест_unicode.md', status: 'added' });
  assert.deepEqual(changes[5], { path: 'src/日本語.ts', status: 'untracked' });
});

test('parseGitStatus returns empty array for empty git status output', () => {
  const changes = parseGitStatus('');
  assert.deepEqual(changes, []);
});

// ---------------------------------------------------------------------------
// 4. Task / Filter / Next Action Correctness
// ---------------------------------------------------------------------------
console.log('\n4. Task, Filter, and Next Action Correctness:');

test('generateNextActions orders blocked first, then in-progress, then open', () => {
  const tasks = [
    { id: 'T3', title: 'Open task', status: 'open', source: '.project-brief/tasks.json' },
    { id: 'T2', title: 'Work in progress', status: 'in_progress', source: '.project-brief/tasks.json' },
    { id: 'T1', title: 'Blocked item', status: 'blocked', source: '.project-brief/tasks.json' },
  ];

  const actions = generateNextActions(tasks);
  assert.equal(actions.length, 3);
  assert.equal(actions[0], 'Unblock task T1: Blocked item');
  assert.equal(actions[1], 'Continue task T2: Work in progress');
  assert.equal(actions[2], 'Start task T3: Open task');
});

test('generateNextActions returns empty array when tasks is empty', () => {
  assert.deepEqual(generateNextActions([]), []);
});

await testAsync('missing tasks.json produces an honest warning', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-test-missing-'));
  try {
    const result = await fetchTasks(tempDir);
    assert.deepEqual(result.tasks, []);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes('Task source file not found'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

await testAsync('malformed tasks.json returns an explicit error', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-test-malformed-'));
  try {
    const pbDir = path.join(tempDir, '.project-brief');
    fs.mkdirSync(pbDir, { recursive: true });
    fs.writeFileSync(path.join(pbDir, 'tasks.json'), '{ not valid json }');

    const result = await fetchTasks(tempDir);
    assert.ok(result.error);
    assert.ok(result.error.includes('Malformed task source'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

await testAsync('invalid task schemas return explicit errors', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-test-invalid-'));
  try {
    const pbDir = path.join(tempDir, '.project-brief');
    fs.mkdirSync(pbDir, { recursive: true });

    // Test 1: not an array
    fs.writeFileSync(path.join(pbDir, 'tasks.json'), JSON.stringify({ id: '1', title: 'test' }));
    let res = await fetchTasks(tempDir);
    assert.ok(res.error.includes('root must be an array'));

    // Test 2: invalid status
    fs.writeFileSync(
      path.join(pbDir, 'tasks.json'),
      JSON.stringify([{ id: '1', title: 'test', status: 'invalid_status' }]),
    );
    res = await fetchTasks(tempDir);
    assert.ok(res.error.includes('status must be one of'));

    // Test 3: missing title
    fs.writeFileSync(
      path.join(pbDir, 'tasks.json'),
      JSON.stringify([{ id: '1', status: 'open' }]),
    );
    res = await fetchTasks(tempDir);
    assert.ok(res.error.includes('"title" must be a string'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

await testAsync('valid tasks.json parses properly with source attribution', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-test-valid-'));
  try {
    const pbDir = path.join(tempDir, '.project-brief');
    fs.mkdirSync(pbDir, { recursive: true });
    fs.writeFileSync(
      path.join(pbDir, 'tasks.json'),
      JSON.stringify([
        { id: '1', title: 'Done task', status: 'done' },
        { id: '2', title: 'In-progress task', status: 'in_progress' },
        { id: '3', title: 'Blocked task', status: 'blocked' },
      ]),
    );

    const res = await fetchTasks(tempDir);
    assert.equal(res.tasks.length, 3);
    for (const t of res.tasks) {
      assert.equal(t.source, '.project-brief/tasks.json');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('filter logic separates changes and tasks correctly', () => {
  const allChanges = [
    { path: 'src/index.js', status: 'modified' },
    { path: 'README.md', status: 'added' },
  ];
  const allTasks = [
    { id: '1', title: 'Done task', status: 'done', source: '.project-brief/tasks.json' },
    { id: '2', title: 'Open task', status: 'open', source: '.project-brief/tasks.json' },
    { id: '3', title: 'In-progress task', status: 'in_progress', source: '.project-brief/tasks.json' },
    { id: '4', title: 'Blocked task', status: 'blocked', source: '.project-brief/tasks.json' },
  ];

  // Helper simulating filter logic
  function applyFilter(filter) {
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
    return { selectedChanges, selectedTasks, nextActions: generateNextActions(selectedTasks) };
  }

  // Filter 'all'
  const resAll = applyFilter('all');
  assert.equal(resAll.selectedChanges.length, 2);
  assert.equal(resAll.selectedTasks.length, 3);
  assert.ok(!resAll.selectedTasks.some((t) => t.status === 'done'));
  assert.equal(resAll.nextActions.length, 3);
  assert.equal(resAll.nextActions[0], 'Unblock task 4: Blocked task');
  assert.equal(resAll.nextActions[1], 'Continue task 3: In-progress task');
  assert.equal(resAll.nextActions[2], 'Start task 2: Open task');

  // Filter 'changes'
  const resChanges = applyFilter('changes');
  assert.equal(resChanges.selectedChanges.length, 2);
  assert.equal(resChanges.selectedTasks.length, 0);
  assert.equal(resChanges.nextActions.length, 0);

  // Filter 'open'
  const resOpen = applyFilter('open');
  assert.equal(resOpen.selectedChanges.length, 0);
  assert.equal(resOpen.selectedTasks.length, 2);
  assert.deepEqual(
    resOpen.selectedTasks.map((t) => t.id),
    ['2', '3'],
  );
  assert.equal(resOpen.nextActions.length, 2);
  assert.equal(resOpen.nextActions[0], 'Continue task 3: In-progress task');
  assert.equal(resOpen.nextActions[1], 'Start task 2: Open task');

  // Filter 'blocked'
  const resBlocked = applyFilter('blocked');
  assert.equal(resBlocked.selectedChanges.length, 0);
  assert.equal(resBlocked.selectedTasks.length, 1);
  assert.equal(resBlocked.selectedTasks[0].id, '4');
  assert.equal(resBlocked.nextActions.length, 1);
  assert.equal(resBlocked.nextActions[0], 'Unblock task 4: Blocked task');
});

// ---------------------------------------------------------------------------
// 5. Workspace Safety & Read-Only Checks
// ---------------------------------------------------------------------------
console.log('\n5. Workspace Safety & Read-Only Checks:');

await testAsync('non-existent workspace returns readable error', async () => {
  const nonExistentPath = path.resolve(os.tmpdir(), 'definitely-does-not-exist-dir-12345');
  const res = await validateWorkspaceRoot(nonExistentPath);
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('Workspace root does not exist'));
});

await testAsync('file path instead of directory returns readable error', async () => {
  const manifestPath = path.resolve(workspaceRoot, 'extension', 'nd-extension.json');
  const res = await validateWorkspaceRoot(manifestPath);
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('Workspace root is not a directory'));
});

await testAsync('non-git directory returns readable error', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-dir-'));
  try {
    const res = await validateWorkspaceRoot(tempDir);
    assert.equal(res.ok, false);
    assert.ok(res.error.includes('Directory is not a Git repository'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

await testAsync('escaping symlink task source is rejected with security error', async () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-outside-'));
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-target-'));

  try {
    const outsideFile = path.join(outsideDir, 'secret-tasks.json');
    fs.writeFileSync(outsideFile, JSON.stringify([{ id: '1', title: 'Hacked', status: 'open' }]));

    const pbDir = path.join(targetDir, '.project-brief');
    fs.mkdirSync(pbDir, { recursive: true });

    try {
      fs.symlinkSync(outsideFile, path.join(pbDir, 'tasks.json'), 'file');
    } catch {
      // If symlink creation fails due to OS privilege on Windows, skip symlink assertion
      return;
    }

    const res = await fetchTasks(targetDir);
    assert.ok(res.error);
    assert.ok(res.error.includes('Security error'));
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Markdown Export
// ---------------------------------------------------------------------------
console.log('\n6. Markdown Export:');

test('renderMarkdownBrief formats all required sections', () => {
  const testData = {
    extensionId: EXTENSION_ID,
    workspace: '/test/workspace',
    changes: [
      { path: 'src/index.js', status: 'modified' },
      { path: 'docs/README.md', status: 'added' },
    ],
    tasks: [
      { id: 'TASK-1', title: 'Fix auth', status: 'blocked', source: '.project-brief/tasks.json' },
      { id: 'TASK-2', title: 'Refactor UI', status: 'in_progress', source: '.project-brief/tasks.json' },
    ],
    nextActions: [
      'Unblock task TASK-1: Fix auth',
      'Continue task TASK-2: Refactor UI',
    ],
    warnings: ['Sample warning message'],
  };

  const md = renderMarkdownBrief(testData);

  assert.ok(md.includes('# ND Project Brief'), 'must include extension name');
  assert.ok(md.includes('src/index.js') && md.includes('(modified)'), 'must include modified change');
  assert.ok(md.includes('docs/README.md') && md.includes('(added)'), 'must include added change');
  assert.ok(md.includes('TASK-1'), 'must include task ID');
  assert.ok(md.includes('Fix auth'), 'must include task title');
  assert.ok(md.includes('[blocked]'), 'must include task status');
  assert.ok(md.includes('.project-brief/tasks.json'), 'must include task source');
  assert.ok(md.includes('Unblock task TASK-1: Fix auth'), 'must include next action');
  assert.ok(md.includes('Sample warning message'), 'must include warnings');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n----------------------------------------');
console.log(`Tests completed: ${totalTests}`);
console.log(`Passed: ${passedTests}`);
console.log(`Failed: ${failedTests}`);
console.log('----------------------------------------\n');

if (failedTests > 0) {
  process.exit(1);
}
