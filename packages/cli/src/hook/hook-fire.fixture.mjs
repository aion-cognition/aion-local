// Standalone hook fire, not vitest-collected: state-concurrency.test.ts forks these as real
// child processes, so two fires for one session meet each other the way two harness fires on
// one machine do. Within one process the handlers would interleave on the event loop alone,
// which is not the mechanism a session's state file has to survive.
// Native node runs the TypeScript sources directly. Its resolver looks for a relative `./x.js`
// specifier as a real file and the project writes those against `x.ts`, so the hook below maps
// the specifier back to the source that exists.
import { existsSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve: (specifier, context, nextResolve) => {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
      const source = new URL(`${specifier.slice(0, -'.js'.length)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(source))) {
        return { url: source.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { runHook } = await import('./run.ts');

const config = JSON.parse(process.argv[2] ?? '{}');
const send = process.send?.bind(process);
if (send === undefined) {
  throw new Error('hook-fire.fixture.mjs must run as a forked child process');
}

const calls = [];

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      return;
    }
    await delay(10);
  }
}

/**
 * Answers the round trip a flush makes, and holds it open on request. The hold is what puts a
 * second fire inside the window between one fire's read of the state and its write back.
 */
const fetchImpl = async (_url, init) => {
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  if (body?.method === 'initialize') {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'transport-1' },
    });
  }
  if (body?.method === 'tools/call') {
    calls.push(body.params);
    if (config.holdMarker !== undefined) {
      writeFileSync(config.holdMarker, '');
    }
    if (config.releaseMarker !== undefined) {
      await waitForFile(config.releaseMarker, 15_000);
    }
    if (config.failCall === true) {
      return new Response('the service is down', { status: 500 });
    }
    const frame = JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: { structuredContent: { episode_id: 'e1' } },
    });
    return new Response(`event: message\ndata: ${frame}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  return new Response(null, { status: 202 });
};

async function fire() {
  const exit = await runHook(config.input, {
    event: config.event,
    harness: 'claude',
    stopMode: 'push',
    minChars: 40,
    keyState: 'present',
    settingsPath: `${config.stateDir}/settings.json`,
    stateDir: config.stateDir,
    endpoint: 'http://127.0.0.1:8765/mcp',
    fetchImpl,
    timeoutMs: config.timeoutMs ?? 10_000,
    now: () => new Date(config.now ?? '2026-09-06T04:00:00.000Z'),
    stdout: () => undefined,
    stderr: () => undefined,
  });
  return { exit, calls };
}

process.on('message', (message) => {
  if (message !== 'go') {
    return;
  }
  fire()
    .then((result) => {
      send(result, () => {
        process.disconnect();
      });
    })
    .catch((err) => {
      send({ exit: -1, calls, error: String(err) }, () => {
        process.disconnect();
      });
    });
});

send('ready');
