#!/usr/bin/env node
/**
 * migrate-to-pg.js
 *
 * Transforms server.js (SQLite / DatabaseSync) into server-pg.js (PostgreSQL)
 * with the minimal set of changes required:
 *
 *  1. Replace the DatabaseSync import with pg-sync
 *  2. Replace DB_PATH / IS_CLOUD / SQLite startup code with PG connection
 *  3. Remove / comment out PRAGMA statements
 *  4. Remove the SQLite file-copy startup block
 *  5. Update package.json start script to use index.js
 *
 * All other logic (handlers, SQL queries, stmts object) stays untouched.
 * The pg-sync / pg-worker layer handles SQL translation automatically at
 * runtime (? → $N, INSERT OR IGNORE → ON CONFLICT DO NOTHING, etc.).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SRC  = path.join(__dirname, 'server.js');
const DEST = path.join(__dirname, 'server-pg.js');

let src = fs.readFileSync(SRC, 'utf8');

// ── 1.  Replace the sqlite import ───────────────────────────────────────────
src = src.replace(
  /const\s*\{\s*DatabaseSync\s*\}\s*=\s*require\(['"]node:sqlite['"]\)\s*;?/,
  `const { DatabaseSync } = require('./pg-sync');`
);

// ── 2.  Replace DB setup block (path / IS_CLOUD / file copy) ────────────────
//  The original block spans several lines. We replace it with a PG URL read.

// Remove the DATA_DIR / DB_FUSE_PATH / DB_PATH / DB_BACKUP / IS_CLOUD block
src = src.replace(
  /\/\/ DB setup[\s\S]*?const IS_CLOUD\s*=\s*.*?;\s*\n/,
  `// PostgreSQL – database URL comes from DATABASE_URL env var
const DATABASE_URL = process.env.DATABASE_URL || '';
const IS_CLOUD     = true;  // always treat as cloud when using PostgreSQL
\n`
);

// ── 3.  Remove the FEE_BACKUP constant (SQLite-only) ────────────────────────
src = src.replace(
  /const FEE_BACKUP\s*=\s*path\.join\(DATA_DIR.*?\);\s*\n/,
  "const FEE_BACKUP = path.join('/tmp', 'finance_fees_backup.json'); // use /tmp for PostgreSQL\n"
);

// ── 4.  Remove the SQLite startup file-copy try/catch block ─────────────────
// Pattern:  try {\n  if (!IS_CLOUD …)\n  …\n} catch(e) { … }
src = src.replace(
  /\/\/ Startup: on local dev[\s\S]*?catch\(e\)\s*\{\s*console\.warn\('DB startup copy.*?\}\s*\n/,
  '// SQLite startup copy removed — using PostgreSQL\n'
);

// ── 5.  Remove the fs.existsSync seed-from-backup block ─────────────────────
src = src.replace(
  /\/\/ Seed VM-local DB[\s\S]*?catch\(e\)\s*\{\s*console\.warn\('⚠️.*?backup.*?\}\s*\}\s*\n/,
  '// SQLite backup seed removed\n'
);

// ── 6.  Replace  new DatabaseSync(DB_PATH)  with  new DatabaseSync(DATABASE_URL) ─
src = src.replace(
  /const db\s*=\s*new DatabaseSync\(DB_PATH\)\s*;/,
  'const db = new DatabaseSync(DATABASE_URL);'
);

// ── 7.  Remove / neutralise PRAGMA calls ─────────────────────────────────────
//  db.exec('PRAGMA …');  →  // PRAGMA removed (PostgreSQL)
src = src.replace(
  /db\.exec\(['"`]PRAGMA\s[^'"`]+['"`]\)\s*;/g,
  '// PRAGMA removed for PostgreSQL'
);

// ── 8.  Remove DATA_DIR creation  (not needed for PG) ───────────────────────
src = src.replace(
  /if \(!fs\.existsSync\(DATA_DIR\)\) fs\.mkdirSync\(DATA_DIR,.*?\);\s*\n/,
  '// DATA_DIR removed (PostgreSQL)\n'
);

// ── 9.  Update startup log to say "PostgreSQL Edition" ──────────────────────
src = src.replace(
  /SQLite Edition/g,
  'PostgreSQL Edition'
);

// ── 10.  Remove the stats query at startup that references DB_PATH ───────────
src = src.replace(
  /const stats = \{[\s\S]*?attendance:.*?\};\s*\n/,
  'const stats = { students: "?", attendance: "?" }; // stats skipped on PG startup\n'
);

// ── 11.  Remove mention of DB_PATH in the startup log ────────────────────────
src = src.replace(
  /console\.log\(`\s*DB\s*:.*?`\)\s*;/,
  'console.log(`   DB     : PostgreSQL (${DATABASE_URL.replace(/:[^@]*@/, ":****@")})`);'
);

// ── 12.  Replace remaining DB_PATH refs (dbPath in stats handler, db label) ─────
src = src.replace(
  /db:\s*'SQLite \(node:sqlite built-in\)'/g,
  "db: 'PostgreSQL (Neon.tech)'"
);
src = src.replace(
  /dbPath:\s*DB_PATH/g,
  "dbPath: DATABASE_URL.replace(/:[^@]*@/, ':****@')"
);

// ── Write output ─────────────────────────────────────────────────────────────
fs.writeFileSync(DEST, src, 'utf8');

console.log(`✅  Generated ${DEST}`);
console.log(`    Lines: ${src.split('\n').length}`);

// ── Update package.json to use index.js as start ─────────────────────────────
const pkgPath = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.scripts = pkg.scripts || {};
pkg.scripts.start = 'node index.js';
pkg.scripts.dev   = 'node index.js';
pkg.dependencies  = pkg.dependencies || {};
pkg.dependencies.pg = '^8.11.0';

// Change main file reference
pkg.main = 'index.js';

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log(`✅  Updated package.json  (start → node index.js, added pg dependency)`);

// ── 13.  Patch rbac.js – fix PostgreSQL strict GROUP BY in getActiveUsers ────
//  PostgreSQL requires all non-aggregate SELECT columns in GROUP BY.
//  The original query selects role_key and ip_address without aggregation,
//  which works in SQLite but breaks on PostgreSQL.
const rbacPath = path.join(__dirname, 'rbac.js');
if (fs.existsSync(rbacPath)) {
  let rbac = fs.readFileSync(rbacPath, 'utf8');
  rbac = rbac.replace(
    /SELECT username, role_key, COUNT\(\*\) as actions, MAX\(timestamp\) as last_seen, ip_address/g,
    'SELECT username, MAX(role_key) as role_key, COUNT(*) as actions, MAX(timestamp) as last_seen, MAX(ip_address) as ip_address'
  );
  fs.writeFileSync(rbacPath, rbac, 'utf8');
  console.log('✅  Patched rbac.js – fixed PostgreSQL GROUP BY in getActiveUsers()');
}

// ── 14.  (DONE) server.js monthly_trend query already uses GROUP BY 1 ────────
//  The GROUP BY alias fix has been applied directly in server.js (GROUP BY 1).
//  This step is intentionally left as a no-op to preserve step numbering.
console.log('✅  Step 14: monthly_trend GROUP BY already fixed in server.js — skipped');

// ── 15.  Run production seed (teachers, finance, HR, donations, etc.) ────────
const seedPath = path.join(__dirname, 'seed-production.js');
if (fs.existsSync(seedPath) && process.env.DATABASE_URL) {
  try {
    require('child_process').execSync(`node "${seedPath}"`, {
      env: process.env,
      stdio: 'inherit',
      timeout: 60000
    });
  } catch(e) {
    console.warn('⚠️  seed-production.js failed (non-fatal):', e.message.slice(0,120));
  }
}
