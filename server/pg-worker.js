/**
 * pg-worker.js  –  PostgreSQL Query Worker Thread
 *
 * Runs inside a dedicated Worker Thread.
 * Receives SQL queries from the HTTP-server thread via MessageChannel,
 * executes them asynchronously with the pg pool, then signals the caller
 * via SharedArrayBuffer + Atomics so the caller can block synchronously.
 *
 * Message format (inbound from pg-sync.js):
 *   { id, sql, params, mode }   – mode: 'get' | 'all' | 'run' | 'exec'
 * Message format (outbound):
 *   { id, data, error }
 */

'use strict';

const { workerData } = require('worker_threads');
const { Pool }       = require('pg');

// pg-sync communicates via the MessageChannel port transferred in workerData,
// NOT via parentPort (which is the built-in worker↔spawner channel).
const port = workerData.port;
port.on('error', e => console.error('[pg-worker] port error:', e.message));

// ── Connection pool ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString : workerData.connectionString,
  ssl              : { rejectUnauthorized: false },
  max              : 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', e => console.error('[pg-worker] pool error:', e.message));

// ── In-process SELECT cache (TTL = 20 seconds) ───────────────────────────────
// Eliminates redundant Neon round-trips for repeated read queries within the
// same burst (e.g. dashboard auto-refresh, multiple API calls on page load).
const _cache    = new Map();
const CACHE_TTL = 20_000;     // 20 s — safe for near-real-time dashboards

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) { _cache.delete(key); return undefined; }
  return entry.data;
}
function cacheSet(key, data) {
  if (_cache.size >= 500) { _cache.delete(_cache.keys().next().value); }
  _cache.set(key, { data, expires: Date.now() + CACHE_TTL });
}


// ── SQL translator  (SQLite → PostgreSQL) ────────────────────────────────────
function translateSQL(rawSql, rawParams) {
  let sql    = rawSql;
  let params = rawParams || [];

  // ── 1.  Named parameters  (@name)  →  positional ($N) ───────────────────
  //   params may be a plain object  { name: value, … }
  if (params && !Array.isArray(params) && typeof params === 'object') {
    const namedObj = params;
    params = [];
    let n = 0;
    sql = sql.replace(/@(\w+)/g, (_, key) => {
      params.push(namedObj[key] !== undefined ? namedObj[key] : null);
      return '$' + (++n);
    });
  } else {
    // ── 2.  Positional  (?)  →  ($N) ────────────────────────────────────
    params = Array.isArray(params) ? [...params] : [];
    let n = 0;
    sql = sql.replace(/\?/g, () => '$' + (++n));
  }

  // ── 3.  SQLite-only pragmas → skip ───────────────────────────────────────
  if (/^\s*PRAGMA\b/i.test(sql)) return { pgSql: '', pgParams: [] };

  // ── 4.  AUTOINCREMENT → drop it  (we use SERIAL / identity columns) ───────
  sql = sql.replace(/\bAUTOINCREMENT\b/gi, '');

  // ── 5.  INTEGER PRIMARY KEY  (SQLite rowid alias) → SERIAL PRIMARY KEY ───
  sql = sql.replace(/\bINTEGER\s+PRIMARY\s+KEY\b/gi, 'SERIAL PRIMARY KEY');

  // ── 6.  datetime / date helpers ──────────────────────────────────────────
  const IST_TS  = "to_char(NOW() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS')";
  const IST_DT  = "to_char(NOW() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')";

  // 3-arg: datetime('now', '-N unit', 'localtime') → shifted IST timestamp
  sql = sql.replace(/datetime\s*\(\s*'now'\s*,\s*'([^']+)'\s*,\s*'localtime'\s*\)/gi, (_, iv) => {
    return `to_char((NOW() + INTERVAL '${iv}') AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS')`;
  });
  // 3-arg: datetime('now', 'localtime', 'interval') → IST + interval (rbac.js form)
  sql = sql.replace(/datetime\s*\(\s*'now'\s*,\s*'localtime'\s*,\s*'([^']+)'\s*\)/gi, (_, iv) => {
    return `to_char((NOW() AT TIME ZONE 'Asia/Kolkata') + INTERVAL '${iv}','YYYY-MM-DD HH24:MI:SS')`;
  });
  // 3-arg dynamic: datetime('now', 'localtime', '-' || $N || ' unit')
  sql = sql.replace(/datetime\s*\(\s*'now'\s*,\s*'localtime'\s*,\s*'-'\s*\|\|\s*(\$\d+)\s*\|\|\s*'([^']+)'\s*\)/gi, (_, param, unit) => {
    return `to_char((NOW() AT TIME ZONE 'Asia/Kolkata') - (${param} || ' ${unit.trim()}')::interval,'YYYY-MM-DD HH24:MI:SS')`;
  });
  sql = sql.replace(/datetime\s*\(\s*'now'\s*,\s*'localtime'\s*\)/gi, IST_TS);
  sql = sql.replace(/datetime\s*\(\s*'now'\s*\)/gi,                   IST_TS);
  sql = sql.replace(/date\s*\(\s*'now'\s*,\s*'localtime'\s*\)/gi,     IST_DT);
  sql = sql.replace(/date\s*\(\s*'now'\s*\)/gi,                       IST_DT);

  // ── 6b. strftime → to_char ────────────────────────────────────────────────
  sql = sql.replace(/strftime\s*\(\s*'([^']+)'\s*,\s*([^,)]+)\s*\)/gi, (_, fmt, col) => {
    const pgFmt = fmt
      .replace(/%Y/g, 'YYYY').replace(/%m/g, 'MM').replace(/%d/g, 'DD')
      .replace(/%H/g, 'HH24').replace(/%M/g, 'MI').replace(/%S/g, 'SS');
    return `to_char(${col.trim()}::timestamp, '${pgFmt}')`;
  });

  // ── 6c. SQLite pragma functions → PostgreSQL equivalents ─────────────────
  // pragma_page_count() / pragma_page_size() → pg_database_size() fallback
  if (/pragma_page_count|pragma_page_size/i.test(sql)) {
    return { pgSql: "SELECT pg_database_size(current_database()) AS sz", pgParams: [] };
  }

  // ── 7.  INSERT OR IGNORE → INSERT … ON CONFLICT DO NOTHING ──────────────
  sql = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO');
  if (/\bINSERT\s+INTO\b/i.test(sql) && !/ON\s+CONFLICT/i.test(sql) &&
      rawSql.toUpperCase().includes('INSERT OR IGNORE')) {
    sql = sql.trimEnd().replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
  }

  // ── 8.  INSERT OR REPLACE → handled table-by-table ───────────────────────
  if (/\bINSERT\s+OR\s+REPLACE\s+INTO\b/i.test(sql)) {
    sql = sql.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'INSERT INTO');
    sql = appendReplaceConflict(sql);
  }

  // ── 9.  Inline SQLite comments  (-- text in multi-stmt exec)  are fine ───

  // ── 10a. Disambiguate bare 'value' in ON CONFLICT counter update (server_meta) ──
//   SQLite: CAST(CAST(value AS INTEGER)+1 AS TEXT) — PG needs table qualification
sql = sql.replace(
  /\bCAST\s*\(\s*CAST\s*\(\s*value\s+AS\s+INTEGER\s*\)/gi,
  'CAST(CAST(server_meta.value AS INTEGER)');

// ── 10b. Fix DEFAULT "" → DEFAULT '' (PG treats "" as zero-length identifier) ──
sql = sql.replace(/DEFAULT\s+""/gi, "DEFAULT ''");

// ── 10. GROUP BY completeness – ca.name must be in GROUP BY when selected ───
  if (/\bca\.name\b/i.test(sql) && /\bSUM\s*\(/i.test(sql)) {
    sql = sql.replace(/\bGROUP\s+BY\s+je\.account_code\b(?!\s*,\s*ca\.name)/gi,
                      'GROUP BY je.account_code, ca.name');
  }

  return { pgSql: sql, pgParams: params };
}

/**
 * Appends the appropriate ON CONFLICT … DO UPDATE SET clause for
 * INSERT OR REPLACE statements, keyed on the target table name.
 */
function appendReplaceConflict(sql) {
  // Extract table name
  const m = sql.match(/\bINSERT\s+INTO\s+(\w+)\s*\(/i);
  if (!m) return sql + ' ON CONFLICT DO NOTHING';
  const tbl = m[1].toLowerCase();

  // Extract column list
  const colMatch = sql.match(/\bINSERT\s+INTO\s+\w+\s*\(([^)]+)\)/i);
  const allCols  = colMatch ? colMatch[1].split(',').map(c => c.trim()) : [];

  // Conflict columns per table
  const conflictMap = {
    attendance          : 'student_id,date',
    daily_reports       : 'teacher_id,report_date',
    students            : 'id',
    payroll_entries     : 'staff_id,staff_type,month,fiscal_year',
    fee_schedules       : 'class,fee_type,academic_yr,term',
    exam_marks          : 'exam_id,student_id,subject',
    marks               : 'student_id,subject,exam',          // no unique defined, skip
    homework_submissions: 'homework_id,student_id',
    transport_students  : 'student_id',
    nep_assessments     : 'student_id,class,term,academic_yr',
    server_meta         : 'key',
    biometric_access    : 'user_id,user_type',
    class_fees          : 'class',
    hr_budget           : 'fiscal_year',
    department_budgets  : 'dept_key,fiscal_year',
  };

  const conflictCols = conflictMap[tbl];
  if (!conflictCols) {
    // Unknown table – use DO NOTHING as safe fallback
    return sql.trimEnd().replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
  }

  // Build SET clause (exclude the conflict columns + serial id)
  const skipCols = new Set(['id', ...conflictCols.split(',').map(c => c.trim())]);
  const setCols  = allCols.filter(c => !skipCols.has(c));
  if (!setCols.length) {
    return sql.trimEnd().replace(/;?\s*$/, '') + ` ON CONFLICT (${conflictCols}) DO NOTHING`;
  }
  const setClause = setCols.map(c => `${c}=EXCLUDED.${c}`).join(',');
  return sql.trimEnd().replace(/;?\s*$/, '') +
         ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${setClause}`;
}

// ── Schema helpers  (convert DDL blocks) ─────────────────────────────────────
function translateSchemaSql(block) {
  // Split on semicolons, translate each statement
  // Preserve CREATE INDEX / TABLE IF NOT EXISTS logic
  return block
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const { pgSql } = translateSQL(s, []);
      return pgSql;
    })
    .filter(Boolean)
    .join(';\n');
}

// ── Message handler ──────────────────────────────────────────────────────────
const signal = new Int32Array(workerData.signalSab);

port.on('message', async (msg) => {
  const { id, sql, params, mode } = msg;

  try {
    let data;

    if (mode === 'exec') {
      // DDL multi-statement block
      const translated = translateSchemaSql(sql);
      if (translated) {
        // Run each statement individually
        const stmts = translated.split(';').map(s => s.trim()).filter(Boolean);
        for (const stmt of stmts) {
          try { await pool.query(stmt); } catch(e) {
            // Log but don't crash on "already exists" / idempotent errors
            if (!/(already exists|does not exist|duplicate|relation.*exists)/i.test(e.message)) {
              console.warn('[pg-worker] exec warning:', e.message.slice(0, 120));
              console.warn('  stmt:', stmt.slice(0, 80));
            }
          }
        }
      }
      data = null;
    } else {
      const { pgSql, pgParams } = translateSQL(sql, params);
      if (!pgSql) {
        data = mode === 'get' ? null : mode === 'all' ? [] : { changes: 0, lastInsertRowid: 0 };
      } else {
        // ── SELECT cache: only for pure read queries (get / all) ─────────
        const isRead = (mode === 'get' || mode === 'all') && /^\s*SELECT\b/i.test(pgSql);
        const cKey   = isRead ? mode + '|' + pgSql + '|' + JSON.stringify(pgParams) : null;
        if (cKey) {
          const hit = cacheGet(cKey);
          if (hit !== undefined) {
            port.postMessage({ id, data: hit, error: null });
            Atomics.store(signal, 0, 1); Atomics.notify(signal, 0, 1);
            return;
          }
        }

        // Add RETURNING id for INSERT/UPDATE/DELETE so we can get lastInsertRowid
        let execSql = pgSql;
        const isInsert = /^\s*INSERT\s/i.test(pgSql);
        if (isInsert && !/\bRETURNING\b/i.test(pgSql)) {
          execSql = pgSql + ' RETURNING id';
        }

        let result;
        try {
          result = await pool.query(execSql, pgParams);
        } catch(e) {
          // RETURNING id fails if table has no id column → retry without
          if (isInsert && /column.*does not exist/i.test(e.message)) {
            result = await pool.query(pgSql, pgParams);
          } else {
            throw e;
          }
        }

        if (mode === 'get') {
          data = result.rows[0] || null;
        } else if (mode === 'all') {
          data = result.rows;
        } else {
          // run — invalidate cache so stale reads don't linger
          _cache.clear();
          const lid = result.rows?.[0]?.id ?? 0;
          data = { changes: result.rowCount || 0, lastInsertRowid: lid };
        }

        if (cKey) cacheSet(cKey, data);
      }
    }

    port.postMessage({ id, data, error: null });
  } catch(e) {
    console.error('[pg-worker] query error:', e.message);
    console.error('  sql:', (sql||'').slice(0, 120));
    port.postMessage({ id, data: null, error: e.message });
  } finally {
    // Wake up the waiting server-worker thread
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0, 1);
  }
});

console.log('[pg-worker] ready — connected to PostgreSQL');
