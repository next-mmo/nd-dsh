#!/usr/bin/env node
/**
 * Test suite for ND Workspace Checks extension.
 *
 * Covers:
 * 1. Native manifest validation (`extension/nd-extension.json`)
 * 2. Legacy example template validation (`extension/nd-extension.example.json`)
 * 3. Server process startup and workspace binding (`--workspace` and default cwd)
 * 4. MCP protocol handshake (`initialize`, `notifications/initialized`, `ping`)
 * 5. MCP `tools/list` discovery and schemas
 * 6. MCP unknown method error code (-32601)
 * 7. Malformed input line resilience
 * 8. Tool arguments rejection (`isError: true`)
 * 9. Valid package.json checks and deterministically sorted scripts
 * 10. Missing package.json handling (empty scripts, unavailable checks, warning)
 * 11. Missing scripts key in package.json
 * 12. Malformed JSON rejection (`isError: true`)
 * 13. Non-object package.json rejection (`isError: true`)
 * 14. Non-object scripts rejection (`isError: true`)
 * 15. Non-string command in scripts rejection (`isError: true`)
 * 16. Oversized package.json rejection (>1 MiB) (`isError: true`)
 * 17. Symlink pointing outside workspace root (`isError: true`)
 * 18. `workspace_checks_export` Markdown output and zero disk writes
 */

import test, { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionDir = path.resolve(__dirname, '..');
const serverPath = path.join(extensionDir, 'mcp-server.mjs');
const nativeManifestPath = path.join(extensionDir, 'nd-extension.json');
const legacyManifestPath = path.join(extensionDir, 'nd-extension.example.json');

// --- Helper Functions for Manifest Validation ---

function validateNativeManifest(manifest) {
  const issues = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, issues: ['Manifest must be an object'] };
  }
  if (manifest.protocol !== 'nd.extension/1') {
    issues.push('protocol must be "nd.extension/1"');
  }
  const idPattern = /^[a-z0-9][a-z0-9._-]{1,127}$/;
  if (typeof manifest.id !== 'string' || !idPattern.test(manifest.id)) {
    issues.push('id must match pattern ^[a-z0-9][a-z0-9._-]{1,127}$');
  }
  if (typeof manifest.name !== 'string' || manifest.name.length < 1 || manifest.name.length > 128) {
    issues.push('name must be between 1 and 128 characters');
  }
  if (typeof manifest.description !== 'string' || manifest.description.length < 1 || manifest.description.length > 2000) {
    issues.push('description must be between 1 and 2000 characters');
  }
  const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  if (typeof manifest.version !== 'string' || !versionPattern.test(manifest.version)) {
    issues.push('version must be a valid semver string');
  }
  if (manifest.apiVersion !== 1) {
    issues.push('apiVersion must be 1');
  }
  const validContexts = ['personal', 'company', 'project'];
  if (!Array.isArray(manifest.contexts) || manifest.contexts.length === 0 || !manifest.contexts.every(c => validContexts.includes(c))) {
    issues.push('contexts must be an array of valid context kinds (personal, company, project)');
  }
  if (!Array.isArray(manifest.permissions)) {
    issues.push('permissions must be an array');
  }
  if (!Array.isArray(manifest.settings)) {
    issues.push('settings must be an array');
  }
  if (manifest.executable) {
    if (manifest.executable.kind !== 'mcp-stdio') {
      issues.push('executable.kind must be "mcp-stdio"');
    }
    if (typeof manifest.executable.command !== 'string' || !manifest.executable.command.trim()) {
      issues.push('executable.command is required');
    }
    if (!Array.isArray(manifest.executable.args)) {
      issues.push('executable.args must be an array');
    }
    if (typeof manifest.executable.env !== 'object' || Array.isArray(manifest.executable.env)) {
      issues.push('executable.env must be an object');
    }
  }
  if (!manifest.contributions || typeof manifest.contributions !== 'object') {
    issues.push('contributions must be an object');
  } else {
    const hasTools = Array.isArray(manifest.contributions.tools) && manifest.contributions.tools.length > 0;
    const hasSkills = Array.isArray(manifest.contributions.skills) && manifest.contributions.skills.length > 0;
    if (!hasTools && !hasSkills) {
      issues.push('contributions must declare at least one tool or skill');
    }
    if (hasTools && !manifest.executable) {
      issues.push('executable transport is required when tool contributions are declared');
    }
    if (hasTools) {
      for (const [idx, tool] of manifest.contributions.tools.entries()) {
        if (!tool.id || typeof tool.id !== 'string') issues.push(`tool[${idx}].id is required`);
        if (!tool.title || typeof tool.title !== 'string') issues.push(`tool[${idx}].title is required`);
        if (!tool.toolName || typeof tool.toolName !== 'string') issues.push(`tool[${idx}].toolName is required`);
      }
    }
    if (hasSkills) {
      for (const [idx, skill] of manifest.contributions.skills.entries()) {
        if (!skill.id || typeof skill.id !== 'string') issues.push(`skill[${idx}].id is required`);
        if (!skill.title || typeof skill.title !== 'string') issues.push(`skill[${idx}].title is required`);
        if (!skill.instructions || typeof skill.instructions !== 'string') issues.push(`skill[${idx}].instructions is required`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

function validateLegacyTemplate(manifest) {
  const issues = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, issues: ['Manifest must be an object'] };
  }
  if (typeof manifest.id !== 'string' || !manifest.id.trim()) issues.push('id is required');
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) issues.push('name is required');
  if (typeof manifest.description !== 'string') issues.push('description is required');
  if (manifest.surface !== 'mcp') issues.push('surface must be "mcp"');
  if (typeof manifest.version !== 'string') issues.push('version is required');
  if (manifest.enabled !== false) issues.push('enabled must be false');
  if (!manifest.runtime || manifest.runtime.kind !== 'mcp-stdio') {
    issues.push('runtime.kind must be "mcp-stdio"');
  }
  if (!Array.isArray(manifest.runtime?.args) || manifest.runtime.args.length === 0) {
    issues.push('runtime.args must be non-empty array');
  }
  if (!Array.isArray(manifest.engineRoutes)) issues.push('engineRoutes must be array');
  if (!Array.isArray(manifest.providerRoutes)) issues.push('providerRoutes must be array');
  return { ok: issues.length === 0, issues };
}

// --- File-based Stdio Helper for Sandbox & Cross-Platform Resilience ---

async function runServerWithInput(inputMessages, extraArgs = [], cwd = undefined) {
  const tmpIoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-mcp-io-'));
  const inFile = path.join(tmpIoDir, 'stdin.txt');
  const outFile = path.join(tmpIoDir, 'stdout.txt');

  const inContent = inputMessages
    .map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))
    .join('\n') + '\n';
  fs.writeFileSync(inFile, inContent, 'utf8');

  const inFd = fs.openSync(inFile, 'r');
  const outFd = fs.openSync(outFile, 'w');

  const proc = spawn(process.execPath, [serverPath, ...extraArgs], {
    cwd: cwd || extensionDir,
    stdio: [inFd, outFd, 'ignore'],
    env: { ...process.env, NO_COLOR: '1' },
  });

  await new Promise((resolve) => {
    proc.on('close', resolve);
    setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      resolve();
    }, 4000);
  });

  fs.closeSync(inFd);
  fs.closeSync(outFd);

  const outRaw = fs.readFileSync(outFile, 'utf8');
  try {
    fs.rmSync(tmpIoDir, { recursive: true, force: true });
  } catch {}

  const lines = outRaw.split('\n').map((l) => l.trim()).filter(Boolean);
  const responses = [];
  for (const line of lines) {
    try {
      responses.push(JSON.parse(line));
    } catch {}
  }
  return responses;
}

// --- Suite Definition ---

describe('Manifest Validations', () => {
  it('validates native extension manifest (nd-extension.json)', () => {
    assert(fs.existsSync(nativeManifestPath), 'nd-extension.json must exist');
    const content = JSON.parse(fs.readFileSync(nativeManifestPath, 'utf8'));
    const validation = validateNativeManifest(content);
    assert.strictEqual(validation.ok, true, `Validation failed: ${validation.issues.join('; ')}`);
    assert.strictEqual(content.protocol, 'nd.extension/1');
    assert.strictEqual(content.id, 'nd-workspace-checks');
    assert.strictEqual(content.apiVersion, 1);
    assert.strictEqual(content.executable?.kind, 'mcp-stdio');
    assert.strictEqual(content.executable?.command, 'node');
    assert.deepStrictEqual(content.executable?.args, ['mcp-server.mjs']);
    assert(Array.isArray(content.contributions?.tools));
    const toolNames = content.contributions.tools.map((t) => t.toolName);
    assert(toolNames.includes('workspace_checks'));
    assert(toolNames.includes('workspace_checks_export'));
    const skillIds = content.contributions.skills?.map((s) => s.id) ?? [];
    assert(skillIds.includes('workspace-checks-skill'));
  });

  it('validates legacy example template (nd-extension.example.json)', () => {
    assert(fs.existsSync(legacyManifestPath), 'nd-extension.example.json must exist');
    const content = JSON.parse(fs.readFileSync(legacyManifestPath, 'utf8'));
    const validation = validateLegacyTemplate(content);
    assert.strictEqual(validation.ok, true, `Legacy validation failed: ${validation.issues.join('; ')}`);
    assert.strictEqual(content.id, 'nd-workspace-checks');
    assert.strictEqual(content.surface, 'mcp');
    assert.strictEqual(content.enabled, false);
    assert.strictEqual(content.runtime?.kind, 'mcp-stdio');
    assert.strictEqual(content.runtime?.command, 'node');
    assert(content.runtime?.args?.[0]?.includes('mcp-server.mjs'));
    assert(Array.isArray(content.engineRoutes));
    assert(Array.isArray(content.providerRoutes));
  });
});

const serverExists = fs.existsSync(serverPath);

describe('MCP Server Integration', { skip: !serverExists ? 'mcp-server.mjs does not exist yet' : undefined }, () => {
  let tmpDirs = [];

  function createTmpWorkspace(files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-checks-test-'));
    tmpDirs.push(dir);
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }
    return dir;
  }

  after(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('handles MCP protocol initialize, notifications/initialized, and ping', async () => {
    const responses = await runServerWithInput([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {} },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ]);

    const initRes = responses.find((r) => r.id === 1);
    assert(initRes?.result, 'initialize must return result');
    assert(initRes.result.capabilities, 'capabilities must be returned');

    const pingRes = responses.find((r) => r.id === 2);
    assert(pingRes?.result, 'ping must return result');
  });

  it('lists workspace_checks and workspace_checks_export in tools/list', async () => {
    const responses = await runServerWithInput([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ]);
    const listRes = responses.find((r) => r.id === 1);
    assert(listRes?.result?.tools, 'tools/list must return tools array');
    const names = listRes.result.tools.map((t) => t.name);
    assert(names.includes('workspace_checks'), 'must expose workspace_checks');
    assert(names.includes('workspace_checks_export'), 'must expose workspace_checks_export');

    const checksTool = listRes.result.tools.find((t) => t.name === 'workspace_checks');
    assert.strictEqual(checksTool.inputSchema?.type, 'object');

    const exportTool = listRes.result.tools.find((t) => t.name === 'workspace_checks_export');
    assert.strictEqual(exportTool.inputSchema?.type, 'object');
  });

  it('returns error code -32601 on unknown method', async () => {
    const responses = await runServerWithInput([
      { jsonrpc: '2.0', id: 99, method: 'unknown/method' },
    ]);
    const res = responses.find((r) => r.id === 99);
    assert(res?.error, 'must return error for unknown method');
    assert.strictEqual(res.error.code, -32601);
  });

  it('survives malformed input lines without crashing', async () => {
    const responses = await runServerWithInput([
      'THIS IS NOT VALID JSON',
      '{ "unterminated: "json"',
      { jsonrpc: '2.0', id: 10, method: 'ping' },
    ]);
    const pingRes = responses.find((r) => r.id === 10);
    assert(pingRes?.result, 'server should answer valid requests after malformed inputs');
  });

  it('rejects tool arguments with isError: true', async () => {
    const ws = createTmpWorkspace();
    const responses = await runServerWithInput(
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'workspace_checks', arguments: { unexpectedParam: 'bad' } },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'workspace_checks_export', arguments: { anotherParam: 123 } },
        },
      ],
      ['--workspace', ws]
    );

    const res1 = responses.find((r) => r.id === 1);
    const isErr1 = res1?.result?.isError === true || res1?.error !== undefined;
    assert.strictEqual(isErr1, true, 'tool must reject unexpected arguments');

    const res2 = responses.find((r) => r.id === 2);
    const isErr2 = res2?.result?.isError === true || res2?.error !== undefined;
    assert.strictEqual(isErr2, true, 'workspace_checks_export must reject unexpected arguments');
  });

  it('supports workspace binding via --workspace argument and default cwd', async () => {
    const ws1 = createTmpWorkspace({
      'package.json': { name: 'ws-arg', scripts: { test: 'node --test' } },
    });
    const responses1 = await runServerWithInput(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_checks' } }],
      ['--workspace', ws1]
    );
    const res1 = responses1.find((r) => r.id === 1);
    assert.strictEqual(res1?.result?.isError, false || undefined);
    const data1 = JSON.parse(res1.result.content.find((c) => c.type === 'text').text);
    assert(data1.scripts?.length > 0);

    const ws2 = createTmpWorkspace({
      'package.json': { name: 'ws-cwd', scripts: { build: 'tsc' } },
    });
    const responses2 = await runServerWithInput(
      [{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace_checks' } }],
      [],
      ws2
    );
    const res2 = responses2.find((r) => r.id === 2);
    assert.strictEqual(res2?.result?.isError, false || undefined);
    const data2 = JSON.parse(res2.result.content.find((c) => c.type === 'text').text);
    assert(data2.scripts?.length > 0);
  });

  it('inspects valid package.json with deterministically sorted scripts, check targets, and inert commands', async () => {
    const ws = createTmpWorkspace({
      'package.json': {
        name: 'valid-project',
        scripts: {
          verify: 'npm run typecheck && npm run test',
          test: 'node --test',
          build: 'tsc -b',
          typecheck: 'tsc --noEmit',
          zebra: 'echo zebra',
          danger: 'rm -rf /; node -e "process.exit(1)"; `touch /tmp/pwned`',
          alpha: 'echo alpha',
        },
      },
    });

    const responses = await runServerWithInput(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_checks' } }],
      ['--workspace', ws]
    );
    const res = responses.find((r) => r.id === 1);
    assert.strictEqual(res?.result?.isError, false || undefined);
    const data = JSON.parse(res.result.content.find((c) => c.type === 'text').text);

    assert(Array.isArray(data.scripts), 'scripts must be an array');
    const scriptNames = data.scripts.map((s) => (typeof s === 'string' ? s : s.name || s.key));
    assert.deepStrictEqual(scriptNames, [...scriptNames].sort(), 'scripts must be deterministically sorted');

    const dangerScript = data.scripts.find(
      (s) => (typeof s === 'string' ? s : s.name || s.key) === 'danger'
    );
    assert(dangerScript, 'danger script must be present in inventory');
    const dangerCmd = typeof dangerScript === 'string' ? '' : dangerScript.command || dangerScript.script;
    assert(
      dangerCmd.includes('rm -rf') && dangerCmd.includes('node -e'),
      'command string must be preserved inertly'
    );

    const canonicalChecks = ['verify', 'typecheck', 'test', 'build'];
    if (Array.isArray(data.checks)) {
      const checkNames = data.checks.map((c) => c.name || c.key || c.check);
      assert.deepStrictEqual(checkNames, canonicalChecks, 'checks must follow canonical ordering');
      for (const c of data.checks) {
        assert.strictEqual(c.available, true, `check ${c.name} should be available`);
      }
    } else if (typeof data.checks === 'object') {
      const checkKeys = Object.keys(data.checks);
      assert.deepStrictEqual(checkKeys, canonicalChecks, 'checks keys must follow canonical ordering');
      for (const key of canonicalChecks) {
        assert.strictEqual(data.checks[key].available, true, `check ${key} should be available`);
      }
    } else {
      assert.fail('checks must be an object or array');
    }
  });

  it('handles missing package.json gracefully with empty scripts, unavailable checks, and honest warning', async () => {
    const ws = createTmpWorkspace();
    const responses = await runServerWithInput(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_checks' } }],
      ['--workspace', ws]
    );
    const res = responses.find((r) => r.id === 1);
    assert.strictEqual(res?.result?.isError, false || undefined);
    const data = JSON.parse(res.result.content.find((c) => c.type === 'text').text);

    assert.deepStrictEqual(data.scripts, [], 'scripts must be empty array when package.json is missing');

    const canonicalChecks = ['verify', 'typecheck', 'test', 'build'];
    if (Array.isArray(data.checks)) {
      for (const c of data.checks) {
        assert.strictEqual(c.available, false, `check ${c.name} should be unavailable`);
      }
    } else if (typeof data.checks === 'object') {
      for (const key of canonicalChecks) {
        assert.strictEqual(data.checks[key].available, false, `check ${key} should be unavailable`);
      }
    }

    assert(
      (Array.isArray(data.warnings) && data.warnings.length > 0) ||
        (typeof data.warning === 'string' && data.warning.length > 0),
      'must return honest warning when package.json is missing'
    );
  });

  it('handles package.json without scripts key returning empty script list', async () => {
    const ws = createTmpWorkspace({
      'package.json': { name: 'no-scripts', version: '1.0.0' },
    });
    const responses = await runServerWithInput(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_checks' } }],
      ['--workspace', ws]
    );
    const res = responses.find((r) => r.id === 1);
    assert.strictEqual(res?.result?.isError, false || undefined);
    const data = JSON.parse(res.result.content.find((c) => c.type === 'text').text);
    assert.deepStrictEqual(data.scripts, [], 'scripts must be empty array when scripts key is missing');
  });

  it('returns tool error (isError: true) for malformed JSON in package.json', async () => {
    const ws = createTmpWorkspace({
      'package.json': '{\n  "name": "broken",\n  "scripts": { unclosed ',
    });
    const responses = await runServerWithInput(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_checks' } }],
      ['--workspace', ws]
    );
    const res = responses.find((r) => r.id === 1);
    const isErr = res?.result?.isError === true || res?.error !== undefined;
    assert.strictEqual(isErr, true, 'must return isError: true on malformed JSON');
  });

  it('returns tool error (isError: true) for non-object package.json', async () => {
    const ws = createTmpWorkspace({
      'package.json': JSON.stringify(['item1', 'item2']),
    });
    const responses = await runServerWithInput(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_checks' } }],
      ['--workspace', ws]
    );
    const res = responses.find((r) => r.id === 1);
    const isErr = res?.result?.isError === true || res?.error !== undefined;
    assert.strictEqual(isErr, true, 'must return isError: true on array package.json');
  });

  it('returns tool error (isError: true) for non-object scripts', async () => {
    const ws = createTmpWorkspace({
      'package.json': { name: 'bad-scripts', scripts: 'build tsc' },
    });
    const responses = await runServerWithInput(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_checks' } }],
      ['--workspace', ws]
    );
    const res = responses.find((r) => r.id === 1);
    const isErr = res?.result?.isError === true || res?.error !== undefined;
    assert.strictEqual(isErr, true, 'must return isError: true on non-object scripts');
  });

  it('returns tool error (isError: true) for non-string command in scripts', async () => {
    const ws = createTmpWorkspace({
      'package.json': { name: 'bad-command', scripts: { test: 12345 } },
    });
    const responses = await runServerWithInput(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_checks' } }],
      ['--workspace', ws]
    );
    const res = responses.find((r) => r.id === 1);
    const isErr = res?.result?.isError === true || res?.error !== undefined;
    assert.strictEqual(isErr, true, 'must return isError: true on non-string script command');
  });

  it('returns tool error (isError: true) for oversized package.json (> 1 MiB)', async () => {
    const largePadding = 'a'.repeat(1024 * 1024 + 100);
    const ws = createTmpWorkspace({
      'package.json': JSON.stringify({ name: 'huge', padding: largePadding, scripts: { test: 'node' } }),
    });
    const responses = await runServerWithInput(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_checks' } }],
      ['--workspace', ws]
    );
    const res = responses.find((r) => r.id === 1);
    const isErr = res?.result?.isError === true || res?.error !== undefined;
    assert.strictEqual(isErr, true, 'must return isError: true on oversized package.json');
  });

  it('returns tool error (isError: true) when package.json symlink escapes workspace root', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-checks-outside-'));
    tmpDirs.push(outsideDir);
    const outsidePkg = path.join(outsideDir, 'package.json');
    fs.writeFileSync(outsidePkg, JSON.stringify({ name: 'outside', scripts: { build: 'tsc' } }));

    const ws = createTmpWorkspace();
    const symlinkTarget = path.join(ws, 'package.json');

    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsidePkg, symlinkTarget, 'file');
      symlinkCreated = true;
    } catch {
      // Platform may require privilege to create symlinks (e.g. Windows without Dev Mode)
    }

    if (!symlinkCreated) {
      // Skip assertion if OS denied symlink creation
      return;
    }

    const responses = await runServerWithInput(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_checks' } }],
      ['--workspace', ws]
    );
    const res = responses.find((r) => r.id === 1);
    const isErr = res?.result?.isError === true || res?.error !== undefined;
    assert.strictEqual(isErr, true, 'must return isError: true when symlink points outside workspace');
  });

  it('exports checks as Markdown via workspace_checks_export without writing to disk', async () => {
    const ws = createTmpWorkspace({
      'package.json': {
        name: 'export-test-project',
        scripts: {
          test: 'node --test',
          build: 'tsc -b',
        },
      },
    });

    const filesBefore = fs.readdirSync(ws);
    const responses = await runServerWithInput(
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace_checks_export' } }],
      ['--workspace', ws]
    );
    const res = responses.find((r) => r.id === 1);
    assert.strictEqual(res?.result?.isError, false || undefined);

    const markdown = res.result.content.find((c) => c.type === 'text')?.text;
    assert(typeof markdown === 'string' && markdown.length > 0, 'must return markdown text');

    assert(
      markdown.toLowerCase().includes('workspace checks') || markdown.toLowerCase().includes('nd workspace checks'),
      'markdown must contain extension name'
    );
    assert(markdown.includes('test'), 'markdown must contain test check');
    assert(markdown.includes('build'), 'markdown must contain build check');
    assert(markdown.includes('verify'), 'markdown must contain verify target');
    assert(markdown.includes('typecheck'), 'markdown must contain typecheck target');

    const filesAfter = fs.readdirSync(ws);
    assert.deepStrictEqual(filesBefore, filesAfter, 'workspace_checks_export must not create any files on disk');
  });
});
