/**
 * pg-sync.js  –  Synchronous PostgreSQL adapter
 *
 * Provides the SAME synchronous API as Node.js's built-in `node:sqlite`
 * DatabaseSync class, so that server.js needs ZERO logic changes.
 *
 * HOW IT WORKS:
 *   • Must be required inside a Worker Thread (not the main thread) because
 *     Atomics.wait() is forbidden on the main thread.
 *   • Spawns a dedicated "pg-worker" thread that holds the pg connection pool
 *     and executes queries asynchronously.
 *   • The two threads communicate via MessageChannel.
 *   • A SharedArrayBuffer[Int32] acts as a semaphore:
 *       – pg-sync   resets it to 0, sends the query, calls Atomics.wait()
 *       – pg-worker responds, then calls Atomics.notify() → pg-sync unblocks
 *
 * USAGE (inside a Worker Thread):
 *   const { DatabaseSync } = require('./pg-sync');
 *   const db = new DatabaseSync(process.env.DATABASE_URL);
 *   const row = db.prepare('SELECT * FROM users WHERE id=?').get(42);
 */

'use strict';

const {
  Worker,
  isMainThread,
  receiveMessageOnPort,
  MessageChannel,
} = require('worker_threads');
const path = require('path');

// ── Tiny id generator ─────────────────────────────────────────────────────────
let _msgId = 0;
const nextId = () => ++_msgId;

// ─────────────────────────────────────────────────────────────────────────────
class PreparedStatement {
  constructor(db, sql) {
    this._db  = db;
    this._sql = sql;
  }

  /** Returns the first matching row, or null */
  get(...args) {
    return this._db._exec(this._sql, args.flat(), 'get');
  }

  /** Returns all matching rows as an array */
  all(...args) {
    return this._db._exec(this._sql, args.flat(), 'all');
  }

  /** Executes a write (INSERT/UPDATE/DELETE) */
  run(...args) {
    return this._db._exec(this._sql, args.flat(), 'run');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
class DatabaseSync {
  constructor(connectionString) {
    if (isMainThread) {
      throw new Error(
        'pg-sync: DatabaseSync must be used inside a Worker Thread ' +
        '(Atomics.wait is not available on the main thread).'
      );
    }

    // Semaphore: Int32Array[0] = 0 (waiting) → 1 (done)
    this._signalSab = new SharedArrayBuffer(4);
    this._signal    = new Int32Array(this._signalSab);

    // Bidirectional message channel
    const { port1, port2 } = new MessageChannel();
    this._port = port1;

    // Spawn the PostgreSQL worker
    this._worker = new Worker(
      path.resolve(__dirname, 'pg-worker.js'),
      {
        workerData : { connectionString, signalSab: this._signalSab, port: port2 },
        transferList: [port2],
      }
    );
    this._worker.on('error', e => {
      console.error('[pg-sync] worker error:', e.message);
    });
    this._worker.on('exit', code => {
      if (code !== 0) console.error('[pg-sync] worker exited with code', code);
    });

    // Drain any startup messages
    this._worker.on('message', () => {});
  }

  /**
   * Core synchronous query execution.
   * Blocks the calling Worker Thread via Atomics.wait() until pg-worker
   * has finished and stored the result.
   */
  _exec(sql, params, mode) {
    const id = nextId();

    // Reset signal
    Atomics.store(this._signal, 0, 0);

    // Send query to pg-worker
    this._port.postMessage({ id, sql, params, mode });

    // Block until pg-worker notifies us (timeout = 30 s)
    const waitResult = Atomics.wait(this._signal, 0, 0, 90000);
    if (waitResult === 'timed-out') {
      throw new Error(`[pg-sync] query timed out after 90 s  (sql: ${sql.slice(0, 80)})`);
    }

    // Read the response
    const incoming = receiveMessageOnPort(this._port);
    if (!incoming) {
      throw new Error('[pg-sync] no response received from pg-worker');
    }
    const { data, error } = incoming.message;
    if (error) throw new Error(`[pg-sync] PostgreSQL error: ${error}`);
    return data;
  }

  /** Returns a PreparedStatement-like object */
  prepare(sql) {
    return new PreparedStatement(this, sql);
  }

  /**
   * Executes a (possibly multi-statement) DDL block.
   * Works like db.exec() in better-sqlite3 / DatabaseSync.
   */
  exec(sql) {
    this._exec(sql, [], 'exec');
  }

  /** Gracefully shuts down the worker (call on server shutdown) */
  close() {
    try { this._worker.terminate(); } catch(e) {}
  }
}

module.exports = { DatabaseSync };
