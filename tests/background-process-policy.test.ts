import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const execute = promisify(execFile)
const electron = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
const preload = join(process.cwd(), 'scripts', 'nd-background-process.cjs')
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const probe = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class NDBackgroundConsole { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); }'; [NDBackgroundConsole]::GetConsoleWindow().ToInt64()`
const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }
const setup = `const cp = require('node:child_process'); const exe = ${JSON.stringify(powershell)}; const argv = ['-NoProfile','-NonInteractive','-Command',${JSON.stringify(probe)}];`

async function run(code: string, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(electron, ['-e', code], { env: environment, windowsHide: true, stdio: 'pipe' })
    let stdout = '', stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

describe.skipIf(process.platform !== 'win32')('ND background Node process policy', () => {
  it('preserves null and undefined execFile argument placeholders, with and without options', async () => {
    const result = await run(`const cp=require('node:child_process'); (async()=>{ for(const placeholder of [null,undefined]) { for(const withOptions of [false,true]) { await new Promise((resolve,reject)=>{ const cb=(err,out)=>{if(err) reject(err);else{process.stdout.write('async-ok;');resolve()}}; if(withOptions) cp.execFile(process.env.ComSpec,placeholder,{},cb).stdin.end('exit /b 0\\r\\n'); else cp.execFile(process.env.ComSpec,placeholder,cb).stdin.end('exit /b 0\\r\\n'); }); if(withOptions) cp.execFileSync(process.env.ComSpec,placeholder,{input:'exit /b 0\\r\\n'}); else cp.execFileSync(process.env.ComSpec,placeholder); process.stdout.write('sync-ok;'); } } })().catch(e=>{console.error(e);process.exitCode=1});`)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('async-ok;sync-ok;'.repeat(4))
    expect(result.stderr).toBe('')
  }, 20_000)

  it('retains execSync and execFileSync unknown-encoding validation', async () => {
    const code = `const cp=require('node:child_process'); for(const name of ['execSync','execFileSync']) { try { if(name==='execSync') cp[name]('echo marker',{encoding:'nd-invalid-encoding'}); else cp[name](process.execPath,['--version'],{encoding:'nd-invalid-encoding'}); process.stdout.write('unexpected-success'); } catch(e) { process.stdout.write(name+':'+e.name+':'+e.code+';'); } }`
    const result = await run(code)
    const baseline = await execute(electron, ['-e', code], { env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(baseline.stdout)
    expect(result.stdout).toBe('execSync:TypeError:ERR_UNKNOWN_ENCODING;execFileSync:TypeError:ERR_UNKNOWN_ENCODING;')
  })
  it('preserves default synchronous stderr on success and failure, and execFile undefined-options overloads', async () => {
    const result = await run(`const cp=require('node:child_process'); cp.execFile(process.execPath, ['-e',"process.stdout.write('async')"], undefined, (err,out)=>{ if(err) throw err; process.stdout.write(out); cp.execFileSync(process.execPath,['-e',"process.stderr.write('success-stderr')"]); try { cp.execFileSync(process.execPath,['-e',"process.stderr.write('failure-stderr');process.exit(5)"]); } catch(e) { if(e.status!==5 || e.stderr.toString()!=='failure-stderr') throw e; } });`)
    expect(result).toEqual({ code: 0, stdout: 'async', stderr: 'success-stderrfailure-stderr' })
  })

  it('propagates only its preload policy into a scrubbed child environment', async () => {
    const childCode = `process.stdout.write(String(process.env.ND_SECRET_PARENT ?? 'scrubbed')); const r=require('node:child_process').spawnSync(${JSON.stringify(powershell)},['-NoProfile','-NonInteractive','-Command',${JSON.stringify(probe)}],{stdio:'inherit',windowsHide:false}); process.exitCode=r.status;`
    const result = await run(`process.env.ND_SECRET_PARENT='dummy-test-placeholder'; require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit',env:{SystemRoot:process.env.SystemRoot,ELECTRON_RUN_AS_NODE:'1'}});`)
    expect(result).toEqual({ code: 0, stdout: 'scrubbed0\r\n', stderr: '' })
  }, 20_000)
  it.each(['spawn', 'spawnSync', 'execFile', 'execFileSync'] as const)('hides actual Windows console for %s with inherited output and explicit windowsHide=false', async (method) => {
    const invocation = method === 'execFile'
      ? `cp.execFile(exe, argv, { windowsHide:false }, (err,out) => { if(err) throw err; process.stdout.write(out) });`
      : method === 'execFileSync'
        ? `cp.execFileSync(exe, argv, { windowsHide:false, stdio:'inherit' });`
        : method === 'spawnSync'
          ? `const r=cp.spawnSync(exe,argv,{windowsHide:false,stdio:[0,1,2]}); if(r.error) throw r.error; process.exitCode=r.status;`
          : `cp.spawn(exe,argv,{windowsHide:false,stdio:'inherit'}).on('exit',code=>process.exitCode=code);`
    const result = await run(setup + invocation)
    expect(result).toEqual({ code: 0, stdout: '0\r\n', stderr: '' })
  }, 20_000)

  it('covers exec and execSync shell overloads and preserves callbacks and return values', async () => {
    const result = await run(`const cp=require('node:child_process'); cp.exec('echo async-marker', (err,out) => { if(err) throw err; process.stdout.write(out); const out2=cp.execSync('echo sync-marker'); process.stdout.write(out2); });`)
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('async-marker\r\nsync-marker\r\n')
  })

  it('forwards inherited stdin, stdout and stderr and releases input after early child exit', async () => {
    const childCode = `let input=''; process.stdin.on('data',v=>input+=v); process.stdin.on('end',()=>{ process.stdout.write(input); process.stderr.write('error-marker'); process.exitCode=7; });`
    const result = await run(`const cp=require('node:child_process'); cp.spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'inherit'}).on('exit',code=>process.exitCode=code);`, 'input-marker')
    expect(result).toEqual({ code: 7, stdout: 'input-marker', stderr: 'error-marker' })
    const early = await run(`require('node:child_process').spawn(process.execPath,['-e','process.exit(0)'],{stdio:'inherit'});`, 'x'.repeat(100_000))
    expect(early.code).toBe(0)
    expect(early.stderr).toBe('')
  }, 20_000)

  it('preserves synchronous inherited output, input option and failing status', async () => {
    const result = await run(`const cp=require('node:child_process'); try { cp.execFileSync(process.execPath,['-e',"process.stdout.write(require('node:fs').readFileSync(0)); process.stderr.write('sync-error'); process.exit(9)"],{stdio:'inherit',input:'sync-input'}); } catch(e) { process.exitCode=e.status; }`)
    expect(result).toEqual({ code: 9, stdout: 'sync-input', stderr: 'sync-error' })
  })

  it('keeps promisified execFile output and child handle', async () => {
    const result = await run(`const {promisify}=require('node:util'); const cp=require('node:child_process'); const pending=promisify(cp.execFile)(process.execPath,['-e',"process.stdout.write('promise-marker')"]); if(!pending.child?.pid) throw Error('missing child'); pending.then(({stdout})=>process.stdout.write(stdout));`)
    expect(result).toEqual({ code: 0, stdout: 'promise-marker', stderr: '' })
  })

  it('keeps fork IPC and inherited preload in grandchildren', async () => {
    // This follows the same fork boundary used by node-pty's console-list helper.
    const code = `const fs=require('node:fs'); const path=require('node:path'); const os=require('node:os'); const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nd-hidden-fork-')); const file=path.join(dir,'worker.cjs'); fs.writeFileSync(file,${JSON.stringify(setup + `const r=cp.spawnSync(exe,argv,{stdio:'inherit',windowsHide:false}); process.send({status:r.status});`)}); const child=require('node:child_process').fork(file,[],{windowsHide:false}); child.on('message',msg=>{if(msg.status!==0) process.exitCode=1}); child.on('close',()=>fs.rmSync(dir,{recursive:true,force:true}));`
    const result = await run(code)
    expect(result).toEqual({ code: 0, stdout: '0\r\n', stderr: '' })
  }, 20_000)

  it('updates ESM child_process named imports', async () => {
    const code = `import {spawnSync} from 'node:child_process'; const r=spawnSync(${JSON.stringify(powershell)},['-NoProfile','-NonInteractive','-Command',${JSON.stringify(probe)}],{stdio:'inherit',windowsHide:false}); if(r.error) throw r.error; process.exitCode=r.status;`
    const result = await execute(electron, ['--input-type=module', '-e', code], { env: environment, windowsHide: true })
    expect(result.stdout.trim()).toBe('0')
    expect(result.stderr).toBe('')
  }, 20_000)
})

it('leaves non-Windows Node runtimes untouched', () => {
  let required = false
  runInNewContext(readFileSync(preload, 'utf8'), {
    process: { platform: 'linux' },
    require() { required = true; throw new Error('must not patch non-Windows modules') },
  })
  expect(required).toBe(false)
})
