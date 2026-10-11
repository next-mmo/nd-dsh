import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RESULTS_PATH = 'benchmarks/baselines/agent-task-normal-loop.json';
export const MAX_RESULTS_BYTES = 8 * 1024 * 1024;
const OUTCOMES = ['completed', 'failed', 'canceled', 'interrupted'];
const VERIFICATIONS = ['passed', 'failed', 'skipped', 'not-run'];
const KINDS = ['pm-plan', 'task-execution', 'task-review'];
const COUNTERS = ['modelRoundTrips', 'toolCalls', 'ipcCrossings', 'bytesToModel', 'tokensToModel', 'escalations'];
const PASS_NAMES = ['normal-read', 'fast-read', 'verified', 'verification-failed', 'engine-failed', 'canceled', 'sequential-4x', 'parallel-4x', 'overflow-5x'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const verified = sample => sample.outcome === 'completed' && sample.verification === 'passed' && sample.completedTask === true && sample.finished === true;

function invalid(message) {
  const error = new Error(message);
  error.code = -32602;
  return error;
}

function durationStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  return { measured: sorted.length, totalMs, minMs: sorted[0] ?? 0, maxMs: sorted.at(-1) ?? 0,
    meanMs: sorted.length ? totalMs / sorted.length : 0,
    p50Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : 0,
    p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : 0 };
}

function overlap(samples) {
  const intervals = samples.filter(s => s.finished && s.finishedAt > s.startedAt);
  const events = intervals.flatMap(s => [[s.startedAt, 1], [s.finishedAt, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let peakConcurrency = 0;
  let overlappingMs = 0;
  let previous = events[0]?.[0] ?? 0;
  for (const [time, delta] of events) {
    if (active > 1) overlappingMs += time - previous;
    active += delta;
    peakConcurrency = Math.max(peakConcurrency, active);
    previous = time;
  }
  const spanMs = events.length ? events.at(-1)[0] - events[0][0] : 0;
  const sumIntervalMs = intervals.reduce((sum, s) => sum + s.finishedAt - s.startedAt, 0);
  return { measuredIntervals: intervals.length, excludedIntervals: samples.length - intervals.length,
    peakConcurrency, overlappingMs, spanMs, sumIntervalMs, overlapFactor: spanMs ? sumIntervalMs / spanMs : 0 };
}

function aggregate(samples) {
  const outcomes = Object.fromEntries(OUTCOMES.map(key => [key, samples.filter(s => s.outcome === key).length]));
  const verifications = Object.fromEntries(VERIFICATIONS.map(key => [key, samples.filter(s => s.verification === key).length]));
  const completed = samples.filter(verified);
  return {
    totals: { executionTasks: samples.length, verifiedCompleted: completed.length,
      failed: outcomes.failed, canceled: outcomes.canceled, interrupted: outcomes.interrupted,
      unverified: samples.filter(s => s.outcome === 'completed' && !verified(s)).length,
      unfinished: samples.filter(s => !s.finished).length, completionRate: samples.length ? completed.length / samples.length : 0 },
    outcomes, verifications,
    durations: durationStats(samples.filter(s => s.finished).map(s => s.totalWallMs)),
    verifiedDurations: durationStats(completed.map(s => s.totalWallMs)),
    counters: Object.fromEntries(COUNTERS.map(key => [key, { total: samples.reduce((sum, s) => sum + s[key], 0),
      perVerifiedCompletion: completed.length ? completed.reduce((sum, s) => sum + s[key], 0) / completed.length : null }])),
    overlap: overlap(samples)
  };
}

/** Derive evidence only from individual receipts; never trust stored aggregates. */
export function summarizeResults(receipt) {
  if (!object(receipt) || receipt.schemaVersion !== 1 || receipt.benchmark !== 'agent-task-metrics' || receipt.taskKind !== 'agent-task'
    || !Array.isArray(receipt.samples) || !['excludes-model-latency', 'includes-model-latency'].includes(receipt.wallTimeScope)
    || (receipt.runMode !== undefined && !['offline-fixture', 'live-model'].includes(receipt.runMode))) {
    throw invalid('Expected an ND agent-task metrics receipt with schemaVersion 1.');
  }
  for (const s of receipt.samples) {
    if (!object(s) || !KINDS.includes(s.kind) || !OUTCOMES.includes(s.outcome) || !VERIFICATIONS.includes(s.verification)
      || typeof s.runId !== 'string' || !s.runId.trim()
      || (s.kind === 'task-execution' && (typeof s.taskId !== 'string' || !s.taskId.trim()))
      || typeof s.completedTask !== 'boolean' || typeof s.finished !== 'boolean'
      || !finite(s.startedAt) || !finite(s.finishedAt) || !finite(s.totalWallMs) || s.totalWallMs < 0
      || (s.finished && s.finishedAt < s.startedAt) || COUNTERS.some(key => !Number.isSafeInteger(s[key]) || s[key] < 0)) {
      throw invalid('Invalid individual task receipt.');
    }
  }
  const tasks = receipt.samples.filter(s => s.kind === 'task-execution');
  if (new Set(tasks.map(s => s.runId)).size !== tasks.length) throw invalid('Duplicate task execution receipts.');
  const result = aggregate(tasks);
  result.totals.samples = receipt.samples.length;
  const passes = receipt.passes ?? [];
  const knownRuns = new Set(tasks.map(s => s.runId));
  if (!Array.isArray(passes) || passes.some(p => !object(p) || !Array.isArray(p.tasks)
    || new Set(p.tasks.map(t => t?.runId)).size !== p.tasks.length
    || p.tasks.some(t => !object(t) || typeof t.runId !== 'string' || !knownRuns.has(t.runId)))) {
    throw invalid('Invalid pass membership.');
  }
  result.passes = passes.map((pass, index) => {
    const ids = new Set(pass.tasks.map(t => t.runId).filter(id => typeof id === 'string' && id.length));
    return { name: PASS_NAMES.includes(pass.name) ? pass.name : `pass-${index + 1}`,
      ...aggregate(tasks.filter(s => typeof s.runId === 'string' && ids.has(s.runId))) };
  });
  result.evidence = {
    runMode: receipt.runMode ?? 'unspecified', wallTimeScope: receipt.wallTimeScope,
    limitation: receipt.runMode === 'offline-fixture' || receipt.wallTimeScope === 'excludes-model-latency'
      ? 'Offline fixture or overhead-only timing excludes real model latency; this is not proof of live AI or child subagents.'
      : 'Recorded task intervals measure execution overlap; they do not prove child subagents or a live AI speedup.',
    subagentEvidence: 'not-recorded', basis: 'individual-task-execution-receipts'
  };
  return result;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Bounded, read-only file access. Caller cannot replace the server workspace root. */
export async function readResults(workspaceRoot, relativePath = DEFAULT_RESULTS_PATH) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 1024
    || relativePath.includes('\0') || relativePath.includes(':') || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).some(part => part === '..')) {
    throw invalid('Results path must be a relative workspace path without traversal.');
  }
  let handle;
  try {
    const root = await realpath(workspaceRoot);
    const requested = path.resolve(root, relativePath.replaceAll('\\', path.sep));
    if (!inside(root, requested)) throw invalid('Results path must remain within the workspace.');
    const resolved = await realpath(requested);
    if (!inside(root, resolved)) throw invalid('Results symlink escapes the workspace.');
    handle = await open(resolved, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_RESULTS_BYTES) throw invalid('Results must be a regular file of at most 8 MB.');
    // Read no more than the limit plus one byte, even if the file grows after stat.
    const buffer = Buffer.alloc(MAX_RESULTS_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_RESULTS_BYTES) throw invalid('Results exceed the 8 MB limit.');
    let receipt;
    try { receipt = JSON.parse(buffer.subarray(0, used).toString('utf8')); }
    catch { throw invalid('Results file contains invalid JSON.'); }
    return summarizeResults(receipt);
  } catch (error) {
    if (error.code === -32602) throw error;
    throw invalid('Unable to read results within the workspace.');
  } finally { await handle?.close(); }
}

export function formatMarkdown(summary) {
  const t = summary.totals;
  const number = n => Number(n.toFixed(2));
  return ['# ND Task Results', '', summary.evidence.limitation, '',
    `Verified completions: ${t.verifiedCompleted}/${t.executionTasks}. Failed: ${t.failed}. Canceled: ${t.canceled}. Interrupted: ${t.interrupted}. Unverified completions: ${t.unverified}. Unfinished: ${t.unfinished}.`, '',
    `Finished task mean: ${number(summary.durations.meanMs)} ms. Peak observed concurrency: ${summary.overlap.peakConcurrency}. Overlapping time: ${number(summary.overlap.overlappingMs)} ms.`, '',
    '| Pass | Verified/tasks | Mean ms | Span ms | Peak concurrency | Overlap factor |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...summary.passes.map(p => `| ${p.name} | ${p.totals.verifiedCompleted}/${p.totals.executionTasks} | ${number(p.durations.meanMs)} | ${number(p.overlap.spanMs)} | ${p.overlap.peakConcurrency} | ${number(p.overlap.overlapFactor)} |`), '',
    'Overlap is derived from finished, positive-duration task execution intervals. Model latency scope: ' + summary.evidence.wallTimeScope + '.',
    'Child subagent evidence: not recorded. Concurrency alone does not establish child agents.', ''].join('\n');
}

const inputSchema = { type: 'object', properties: { resultsPath: { type: 'string', description: 'Relative workspace metrics JSON path.', default: DEFAULT_RESULTS_PATH } }, additionalProperties: false };
export const TOOLS = [
  { name: 'task_results', description: 'Read verified task outcomes and measured multitasking overlap from local ND metrics receipts.', inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'task_results_export', description: 'Return a Markdown task results report without writing files.', inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }
];

export async function handleRequest(request, workspaceRoot) {
  const id = object(request) && (typeof request.id === 'string' || finite(request.id) || request.id === null) ? request.id : null;
  const response = result => ({ jsonrpc: '2.0', id, result });
  try {
    if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
      || (request.id !== undefined && id === null && request.id !== null)) {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request.' } };
    }
    if (request.id === undefined) return null;
    if (request.params !== undefined && !object(request.params)) throw invalid('Parameters must be an object.');
    const params = request.params ?? {};
    if (request.method === 'initialize') return response({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'nd-task-results', version: '1.0.0' } });
    if (request.method === 'ping') return response({});
    if (request.method === 'tools/list') return response({ tools: TOOLS });
    if (request.method !== 'tools/call') return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } };
    if (!TOOLS.some(tool => tool.name === params.name)) throw invalid('Unknown tool.');
    const args = params.arguments ?? {};
    if (!object(args) || Object.keys(args).some(key => key !== 'resultsPath') || (args.resultsPath !== undefined && typeof args.resultsPath !== 'string')) {
      throw invalid('Expected only an optional string resultsPath.');
    }
    const summary = await readResults(workspaceRoot, args.resultsPath);
    return response({ content: [{ type: 'text', text: params.name === 'task_results_export' ? formatMarkdown(summary) : JSON.stringify(summary, null, 2) }] });
  } catch (error) {
    return { jsonrpc: '2.0', id, error: { code: error.code === -32602 ? -32602 : -32603,
      message: error.code === -32602 ? error.message : 'Internal error.' } };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--workspace' || !args[1])) throw invalid('Usage: node mcp-server.mjs [--workspace PATH]');
  const workspaceRoot = await realpath(args[1] ?? process.cwd());
  let pending = Buffer.alloc(0);
  // MCP stdio is newline-delimited JSON; cap frames before parsing, too.
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk]);
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (!line.length) continue;
      let result;
      if (line.length > 64 * 1024) result = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds 64 KB.' } };
      else {
        try { result = await handleRequest(JSON.parse(line.toString('utf8')), workspaceRoot); }
        catch { result = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }; }
      }
      if (result) process.stdout.write(JSON.stringify(result) + '\n');
    }
    if (pending.length > 64 * 1024) throw invalid('Request exceeds 64 KB.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('ND Task Results could not start or process input.\n'); process.exitCode = 1; });
}
