// makefun-github-core-clone-01b — entry lifecycle.
//
// The forge itself lives in app.ts. This file only runs the trial lifecycle
// the env expects: bind an ephemeral port, tell the env that port, then poll
// until the env says the trial is over and exit 0. It never binds 8080 (the
// env owns that port) and never exits before the env says done.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (ENV_URL === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set; there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;
// How long the env may be unreachable in a row before the entry gives up
// instead of polling forever. The trial only ever ends through /done, so
// an env that stops answering mid-trial is dead: exiting 1 lets the
// harness record a clean failure instead of killing a hung process at the
// wall budget. Only transport failures count — a 200 with done:false is a
// healthy env that is still working. Overridable for tests.
const UNREACHABLE_LIMIT_MS = Number(process.env.MAKEFUN_ENV_UNREACHABLE_TIMEOUT_MS ?? '120000') || 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Tracks consecutive transport failures against the env. Call noteSuccess()
 * on any answer at all (even a 409 or a done:false); call noteFailure() when
 * the request itself throws. Throws once the env has been silent for
 * UNREACHABLE_LIMIT_MS, so the entry exits 1 instead of hanging forever.
 */
class UnreachableTracker {
  #silentSince: number | null = null;
  noteSuccess(): void {
    this.#silentSince = null;
  }
  noteFailure(now: number): void {
    if (this.#silentSince === null) this.#silentSince = now;
    else if (now - this.#silentSince >= UNREACHABLE_LIMIT_MS) {
      throw new Error(`the env at ${ENV_URL} has been unreachable for ${UNREACHABLE_LIMIT_MS} ms`);
    }
  }
}

async function register(port: number): Promise<void> {
  const tracker = new UnreachableTracker();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      tracker.noteSuccess();
      // 200: registered. 409: a register already won — either this entry's
      // own first POST landed and its answer was lost (the env still dials
      // this entry), or another entry won (then /done still ends the wait).
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      if (err instanceof Error && err.message.startsWith('the env at ')) throw err;
      tracker.noteFailure(Date.now());
    }
    await sleep(backoff(attempt));
  }
}

async function waitForDone(): Promise<void> {
  const tracker = new UnreachableTracker();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      tracker.noteSuccess();
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('the env at ')) throw err;
      tracker.noteFailure(Date.now());
    }
    await sleep(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[forge] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[forge] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[forge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
