// ND-owned preload for background Node runtimes, including their dependencies.
// Do not patch upstream code. ConPTY remains managed by its native PTY library.
'use strict';

if (process.platform === 'win32') {
  const cp = require('node:child_process');
  const { syncBuiltinESMExports } = require('node:module');
  const inputBridges = new Set();
  let restorePausedInput = false;

  function hiddenOptions(options, fork = false) {
    const result = { ...options, windowsHide: true };
    if (result.env) {
      // Carry only ND's launch policy through an intentionally scrubbed env.
      // Never reintroduce credentials or other parent environment values.
      const requirement = `--require ${JSON.stringify(__filename)}`;
      const current = result.env.NODE_OPTIONS ?? '';
      result.env = { ...result.env, NODE_OPTIONS: current.includes(requirement) ? current : `${current} ${requirement}`.trim() };
    }
    const stdio = result.stdio ?? (fork ? (result.silent ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc']) : 'pipe');
    const list = Array.isArray(stdio) ? [...stdio] : [stdio, stdio, stdio];
    const inherited = [0, 1, 2].map((fd) => list[fd] === 'inherit' || list[fd] === fd || list[fd] === [process.stdin, process.stdout, process.stderr][fd]);
    for (let fd = 0; fd < 3; fd++) if (inherited[fd]) list[fd] = 'pipe';
    if (fork && !list.includes('ipc')) list.push('ipc');
    result.stdio = list;
    return { options: result, inherited };
  }

  function forward(child, inherited) {
    if (inherited[1] && child.stdout) child.stdout.pipe(process.stdout, { end: false });
    if (inherited[2] && child.stderr) child.stderr.pipe(process.stderr, { end: false });
    if (inherited[0] && child.stdin) {
      if (inputBridges.size === 0) restorePausedInput = process.stdin.isPaused();
      inputBridges.add(child.stdin);
      const stop = () => {
        process.stdin.unpipe(child.stdin);
        inputBridges.delete(child.stdin);
        if (inputBridges.size === 0 && restorePausedInput) process.stdin.pause();
      };
      // A child may exit before consuming input. Match inherited descriptor
      // behavior without surfacing an unhandled pipe-close error in its parent.
      child.stdin.on('error', (error) => {
        if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED') stop();
      });
      child.once('close', stop);
      child.stdin.once('close', stop);
      process.stdin.pipe(child.stdin);
    }
    return child;
  }

  function forwardSync(result, inherited) {
    for (const fd of [1, 2]) {
      const key = fd === 1 ? 'stdout' : 'stderr';
      if (inherited[fd] && result[key] != null) {
        require('node:fs').writeSync(fd, result[key]);
        result[key] = null;
        if (result.output) result.output[fd] = null;
      }
    }
    return result;
  }

  for (const name of ['spawn', 'spawnSync', 'fork']) {
    const original = cp[name];
    cp[name] = function (command, args, options) {
      if (!Array.isArray(args)) {
        if (args != null) options = args;
        args = [];
      }
      const hidden = hiddenOptions(options, name === 'fork');
      if (name === 'spawnSync') {
        // Inherited input cannot be a console handle in a no-window child.
        // Callers requiring input should use input: or an asynchronous pipe.
        return forwardSync(original.call(this, command, args, hidden.options), hidden.inherited);
      }
      return forward(original.call(this, command, args, hidden.options), hidden.inherited);
    };
  }

  for (const name of ['exec', 'execFile', 'execSync', 'execFileSync']) {
    const original = cp[name];
    cp[name] = function (...args) {
      const hasArgs = name.startsWith('execFile') && (Array.isArray(args[1]) || (args.length > 1 && args[1] == null));
      const index = hasArgs ? 2 : 1;
      const supplied = args[index];
      const options = supplied && typeof supplied === 'object' ? supplied : undefined;
      const hidden = hiddenOptions(options);
      if (typeof supplied === 'function' || args.length <= index) args.splice(index, 0, hidden.options);
      else args[index] = hidden.options;
      if (!name.endsWith('Sync')) return forward(original.apply(this, args), hidden.inherited);
      if (options?.encoding && options.encoding !== 'buffer') {
        // Node exec*Sync rejects unknown encodings even if the child emits no
        // output. spawnSync alone does not retain that argument validation.
        Buffer.from('x').toString(options.encoding);
      }
      // Use the same spawnSync result that Node's exec*Sync APIs consume,
      // retaining both output streams so inherited stderr is forwarded too.
      const isFile = name === 'execFileSync';
      const invocation = isFile && Array.isArray(args[1]) ? args[1] : [];
      const result = cp.spawnSync(args[0], invocation, {
        maxBuffer: 1024 * 1024,
        ...options,
        ...(!isFile ? { shell: typeof options?.shell === 'string' ? options.shell : true } : {}),
      });
      // Node exec*Sync forwards stderr by default, even on successful exit.
      if (options?.stdio == null && result.stderr != null) require('node:fs').writeSync(2, result.stderr);
      if (result.error || result.status !== 0) {
        const error = result.error ?? new Error(`Command failed: ${args[0]}${invocation.length ? ` ${invocation.join(' ')}` : ''}\n${result.stderr ?? ''}`);
        Object.assign(error, result);
        throw error;
      }
      return result.stdout;
    };
    // Keep util.promisify(exec/execFile) behavior, including its child property.
    if (!name.endsWith('Sync')) {
      const custom = require('node:util').promisify.custom;
      cp[name][custom] = function (...args) {
        let child;
        const promise = new Promise((resolve, reject) => {
          child = cp[name](...args, (error, stdout, stderr) => {
            if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
            else resolve({ stdout, stderr });
          });
        });
        promise.child = child;
        return promise;
      };
    }
  }
  syncBuiltinESMExports();
}
