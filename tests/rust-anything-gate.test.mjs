import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/rust-anything-gate.mjs')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'nd-rust-gate-'))
  const bin = join(root, 'bin')
  const unit = join(root, 'rust', 'sample')
  mkdirSync(bin, { recursive: true })
  mkdirSync(unit, { recursive: true })
  writeFileSync(join(unit, 'Cargo.toml'), '[package]\nname="sample"\nversion="0.1.0"\n')
  writeFileSync(join(unit, 'cases.jsonl'), '{"fn":"x","args":[]}\n')
  const mock = join(bin, 'mock.mjs')
  writeFileSync(mock, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const args=process.argv.slice(2)
appendFileSync(process.env.MOCK_GATE_CALLS, JSON.stringify(args)+'\\n')
if (args[0]===process.env.MOCK_FAIL_ON) process.exit(31)
`)
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'rust-anything.cmd'), `@echo off\r\n"${process.execPath}" "${mock}" %*\r\n`)
  } else {
    const binPath = join(bin, 'rust-anything')
    writeFileSync(binPath, `#!/bin/sh\nexec "${process.execPath}" "${mock}" "$@"\n`)
    chmodSync(binPath, 0o755)
  }
  const calls = join(root, 'calls.jsonl')
  const env = { ...process.env, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`, MOCK_GATE_CALLS: calls, ND_RUST_ANYTHING_SANDBOX: '1' }
  return { root, env, calls, run: (...args) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8', env }), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function calls(path) { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) }

describe('rust-anything gate', () => {
  it('prints help without executing the original', () => {
    const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /isolated test data/)
  })
  it('refuses unsafe environments', () => {
    const f = fixture()
    try {
      delete f.env.ND_RUST_ANYTHING_SANDBOX
      const out = spawnSync(process.execPath, [script, '--root', f.root, '--all'], { encoding: 'utf8', env: f.env })
      assert.notEqual(out.status, 0)
      assert.match(out.stderr, /Refusing to run original/)
      assert.equal(existsSync(f.calls), false)
    } finally { f.cleanup() }
  })
  it('verifies diff and gate before marking a recorded unit passed', () => {
    const f = fixture()
    try {
      const out = f.run('--all')
      assert.equal(out.status, 0, out.stderr)
      assert.deepEqual(calls(f.calls).map((args) => args[0]), ['build', 'diff', 'bench', 'gate', 'map'])
      const report = JSON.parse(readFileSync(join(f.root, 'rust', 'gate-report.json'), 'utf8'))
      assert.equal(report.status, 'passed')
      assert.equal(report.units[0].status, 'passed')
    } finally { f.cleanup() }
  })
  it('fails closed on a behavior mismatch and never runs bench or shadow', () => {
    const f = fixture()
    try {
      f.env.MOCK_FAIL_ON = 'diff'
      const out = f.run('--all', '--shadow')
      assert.notEqual(out.status, 0)
      assert.deepEqual(calls(f.calls).map((args) => args[0]), ['build', 'diff'])
      const report = JSON.parse(readFileSync(join(f.root, 'rust', 'gate-report.json'), 'utf8'))
      assert.equal(report.status, 'failed')
      assert.equal(report.units[0].status, 'failed')
    } finally { f.cleanup() }
  })
  it('rejects unrecorded crates and path escapes', () => {
    const f = fixture()
    try {
      rmSync(join(f.root, 'rust', 'sample', 'cases.jsonl'))
      assert.notEqual(f.run('--all').status, 0)
      assert.notEqual(f.run('--crate', '../elsewhere').status, 0)
      assert.equal(existsSync(f.calls), false)
    } finally { f.cleanup() }
  })
})
