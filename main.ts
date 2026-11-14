// main.ts — the forge's entrypoint.
//
// Lifecycle (the environment's contract):
//   1. listen on an ephemeral port the kernel picks (never 8080),
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register,
//   3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//   4. exit 0.
//
// Without MAKEFUN_ENV_URL (a manual run) the server just listens and logs
// its port until it is stopped.

import { Forge, IssueStore } from './store.ts';
import { createApp } from './app.ts';

const POLL_MS = 250;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
    } catch {
      // The environment may not be listening yet; retry until the deadline.
    }
    if (Date.now() > deadline) throw new Error('could not register with the environment');
    await sleep(250);
  }
}

async function waitDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Transient; keep polling.
    }
    await sleep(POLL_MS);
  }
}

async function main(): Promise<void> {
  const forge = new Forge();
  const issues = new IssueStore(forge);
  const server = createApp(forge, issues);
  const envUrl = process.env.MAKEFUN_ENV_URL;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) throw new Error('server did not bind a port');

  if (envUrl === undefined || envUrl === '') {
    console.log(`github-core-clone forge listening on 127.0.0.1:${port}`);
    return;
  }
  await register(envUrl, port);
  await waitDone(envUrl);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
