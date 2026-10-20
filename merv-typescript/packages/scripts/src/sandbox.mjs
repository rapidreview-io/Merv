// Runtime resource: copied beside the compiled plugin by the build. Plain ESM, so it runs under
// the permission model without tsx. It runs one script in QuickJS (WebAssembly); its only way out
// is a `call` message the parent decides on. argv: QuickJS core's module URL, the variant's, and
// the script's memory in bytes.
const core = await import(process.argv[2]);
const variant = (await import(process.argv[3])).default;
const memory = Number(process.argv[4]);
// This build cannot measure its blocks (no malloc_usable_size), so QuickJS's own limit counts
// only per-block overhead: large strings and buffers pass it. The WebAssembly memory's maximum
// is the hard cap: 16 MiB of startup heap (Emscripten's default initial) plus the script's share.
const pages = (bytes) => bytes / 65536;
const wasmMemory = new WebAssembly.Memory({
  initial: pages(16 << 20),
  maximum: pages((16 << 20) + memory),
});
const QuickJS = await core.newQuickJSWASMModuleFromVariant(
  core.newVariant(variant, { wasmMemory }),
);

const send = (message) => process.send(message);
let ended = false;
// Exit only once the message is written: exiting right after send can drop it.
const finish = (message) => {
  if (ended) return;
  ended = true;
  process.send(message, () => process.exit(0));
};

process.once('message', ({ code, names, timeoutMs, stack, calls, logLines }) => {
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memory);
  runtime.setMaxStackSize(stack);
  const deadline = Date.now() + timeoutMs;
  // Runs only while QuickJS executes; the parent kills a child that waits past its deadline.
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();
  const failure = (handle) => {
    const error = vm.dump(handle);
    handle.dispose();
    const text =
      typeof error === 'object' && error ? `${error.name}: ${error.message}` : `${error}`;
    if (Date.now() > deadline)
      return { code: 'script_timeout', message: 'The script ran out of time' };
    if (/out of memory/i.test(text))
      return { code: 'script_memory', message: 'The script ran out of memory' };
    return { code: 'script_error', message: text.slice(0, 2048) };
  };
  // A job that fails outside any promise (an interrupt, memory) ends the script.
  const jobs = () => {
    const result = runtime.executePendingJobs();
    if (result.error) finish({ type: 'done', ok: false, error: failure(result.error) });
  };

  const pending = new Map();
  let next = 0;
  process.on('message', (message) => {
    const deferred = pending.get(message.id);
    if (!deferred) return;
    pending.delete(message.id);
    if (message.ok) {
      const value = vm.newString(message.value);
      deferred.resolve(value);
      value.dispose();
    } else {
      const error = vm.newError(message.error);
      const code = vm.newString(message.code);
      vm.setProp(error, 'code', code);
      deferred.reject(error);
      code.dispose();
      error.dispose();
    }
    jobs();
  });
  // The parent ends the script on the call past the limit and keeps only the first log lines.
  // Nothing is sent beyond those: while QuickJS runs a loop, every send queues in this process.
  const host = vm.newFunction('__call', (name, input) => {
    const id = next++;
    const deferred = vm.newPromise();
    pending.set(id, deferred);
    if (id <= calls)
      send({ type: 'call', id, name: vm.getString(name), input: vm.getString(input) });
    return deferred.handle;
  });
  vm.setProp(vm.global, '__call', host);
  host.dispose();
  let lines = 0;
  const log = vm.newFunction('log', (...args) => {
    if (lines++ >= logLines) return;
    const line = args
      .map((arg) => {
        const value = vm.dump(arg);
        return typeof value === 'string' ? value : JSON.stringify(value);
      })
      .join(' ');
    send({ type: 'log', line: line.slice(0, 2048) });
  });
  const consoleObject = vm.newObject();
  vm.setProp(consoleObject, 'log', log);
  vm.setProp(vm.global, 'console', consoleObject);
  log.dispose();
  consoleObject.dispose();

  // One line, so the script's own line numbers are off by one only.
  const prelude = `const call = ((c) => async (name, input) => JSON.parse(await c(name, JSON.stringify(input ?? {}))))(globalThis.__call); delete globalThis.__call; const tools = {}; for (const name of ${JSON.stringify(names)}) { const parts = name.split('.'); let node = tools; parts.forEach((part, i) => { if (i < parts.length - 1) { node = node[part] ??= {}; return; } const fn = (input) => call(name, input); node[part] = Object.assign(fn, node[part]); }); }`;
  const evaluated = vm.evalCode(
    `${prelude}\n(async () => { const value = await (async () => {\n${code}\n})(); return value === undefined ? undefined : JSON.stringify(value); })()`,
    'script.js',
  );
  if (evaluated.error) {
    const error = vm.dump(evaluated.error);
    evaluated.error.dispose();
    const syntax = error?.name === 'SyntaxError';
    finish({
      type: 'done',
      ok: false,
      error: syntax
        ? { code: 'script_syntax', message: `${error.message}`.slice(0, 2048) }
        : { code: 'script_error', message: `${error?.message ?? error}`.slice(0, 2048) },
    });
    return;
  }
  const promise = evaluated.value;
  // resolvePromise on a settled QuickJS promise settles only after the jobs run.
  const waiting = vm.resolvePromise(promise);
  jobs();
  void waiting.then((settled) => {
    promise.dispose();
    if (settled.error) return finish({ type: 'done', ok: false, error: failure(settled.error) });
    const value = vm.typeof(settled.value) === 'string' ? vm.getString(settled.value) : undefined;
    settled.value.dispose();
    finish({ type: 'done', ok: true, result: value });
  });
});

// The parent runs no script unless the permission model holds this process.
send({ type: 'ready', permission: process.permission?.has('fs.read', '/') === false });
