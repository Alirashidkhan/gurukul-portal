/**
 * index.js  –  Gurukul Portal entry point
 *
 * Starts server.js inside a Worker Thread so that the pg-sync module can use
 * Atomics.wait() (which is forbidden on the main/browser thread but perfectly
 * legal inside Worker Threads).
 *
 * Environment variables are forwarded automatically via `env: WORKER_THREADS`
 * (default behaviour) so PORT, DATABASE_URL, JWT_SECRET etc. are all visible
 * to the worker.
 */

'use strict';

const { Worker, isMainThread } = require('worker_threads');
const path = require('path');

if (isMainThread) {
  const worker = new Worker(path.resolve(__dirname, 'server-pg.js'), {
    // Pass all env vars (including DATABASE_URL set by Render)
    env: process.env,
  });

  worker.on('error', e => {
    console.error('[index] Server worker error:', e);
    process.exit(1);
  });

  worker.on('exit', code => {
    if (code !== 0) {
      console.error('[index] Server worker exited with code', code);
      process.exit(code);
    }
  });

  // Forward SIGTERM / SIGINT so Render's graceful shutdown works
  process.on('SIGTERM', () => worker.terminate());
  process.on('SIGINT',  () => worker.terminate());

} else {
  // This branch is never reached via this file —
  // Worker Threads start from server.js directly.
}
