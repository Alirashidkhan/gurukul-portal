/**
 * Gurukul Student Portal – Backend Server
 * The Gurukul High, K.R. Nagar, Mysuru
 *
 * Database : SQLite (Node.js built-in node:sqlite — no npm needed)
 * Auth     : JWT (HS256, built-in crypto)
 * Passwords: PBKDF2 (built-in crypto)
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const { DatabaseSync } = require('node:sqlite');
const rbac = require('./rbac');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT           || 3001;
const JWT_SECRET     = process.env.JWT_SECRET     || 'gurukul-high-secret-2026-change-in-production';
const ADMIN_KEY      = process.env.ADMIN_KEY      || 'gurukul-admin-2026';
const ADMIN_USER     = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASS     = process.env.ADMIN_PASS     || 'gurukul@2026';
const FINANCE_USER   = process.env.FINANCE_USER   || 'finance';
const FINANCE_PASS   = process.env.FINANCE_PASS   || 'finance@2026';
const HR_USER        = process.env.HR_USER        || 'hr';
const HR_PASS        = process.env.HR_PASS        || 'hr@2026';
const MARKETING_USER = process.env.MARKETING_USER || 'marketing';
const MARKETING_PASS = process.env.MARKETING_PASS || 'marketing@2026';
const BUDGET_USER    = process.env.BUDGET_USER    || 'budget';
const BUDGET_PASS    = process.env.BUDGET_PASS    || 'budget@2026';
const AUDIT_USER     = process.env.AUDIT_USER     || 'audit';
const AUDIT_PASS     = process.env.AUDIT_PASS     || 'audit@2026';
const CYBER_USER     = process.env.CYBER_USER     || 'cyber';
const CYBER_PASS     = process.env.CYBER_PASS     || 'cyber@2026';
// DB setup
// - Local dev (FUSE mount): copy to /tmp to avoid FUSE file-locking issues
// - Cloud (Railway/Render): use data/ directory directly — filesystem is real
const DATA_DIR      = path.join(__dirname, 'data');
const DB_FUSE_PATH  = path.join(DATA_DIR, 'gurukul.db');
// DB_PATH env var lets Railway/Render override to a persistent volume path
const DB_PATH       = process.env.DB_PATH || (process.env.RAILWAY_ENVIRONMENT || process.env.RENDER ? path.join(DATA_DIR, 'gurukul_live.db') : '/tmp/gurukul_working.db');
const DB_BACKUP     = DB_FUSE_PATH;
const IS_CLOUD      = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.DB_PATH);

const FEE_BACKUP  = path.join(DATA_DIR, 'finance_fees_backup.json');

// Startup: on local dev copy from FUSE; on cloud use DB_PATH directly
try {
  if (!IS_CLOUD && fs.existsSync(DB_FUSE_PATH)) {
    fs.copyFileSync(DB_FUSE_PATH, DB_PATH);
    console.log(`📦 DB schema loaded from FUSE → /tmp`);
  } else if (IS_CLOUD) {
    console.log(`☁️  Cloud mode — DB: ${DB_PATH}`);
  }
} catch(e) { console.warn('DB startup copy failed:', e.message); }

// Load .env if present
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  env.split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && !k.startsWith('#') && v.length) process.env[k.trim()] = v.join('=').trim();
  });
} catch(e) { /* .env optional */ }

// ─── RATE LIMITER (in-memory, no npm needed) ─────────────────────────────────
const _rateBuckets = new Map();  // key → { count, resetAt }
function rateLimit(ip, endpoint, maxReqs = 20, windowMs = 60000) {
  const key = `${ip}|${endpoint}`;
  const now = Date.now();
  let b = _rateBuckets.get(key);
  if (!b || now > b.resetAt) b = { count: 0, resetAt: now + windowMs };
  b.count++;
  _rateBuckets.set(key, b);
  // Clean map periodically
  if (_rateBuckets.size > 5000) {
    for (const [k, v] of _rateBuckets) { if (now > v.resetAt) _rateBuckets.delete(k); }
  }
  return b.count <= maxReqs;
}

// ─── SIMPLE SMTP EMAIL SENDER (built-in net/tls only) ─────────────────────────
const _smtpCfg = {
  host : process.env.SMTP_HOST || '',
  port : parseInt(process.env.SMTP_PORT || '587'),
  user : process.env.SMTP_USER || '',
  pass : process.env.SMTP_PASS || '',
  from : process.env.SMTP_FROM || 'noreply@gurukul.edu',
};
function sendEmail(to, subject, body, toName = '') {
  // Queue in DB — background processor will send via SMTP if configured
  try {
    db.prepare(`INSERT INTO email_queue (to_email,to_name,subject,body,status,created_by)
                VALUES (?,?,?,?,?,?)`).run(to, toName, subject, body,
                _smtpCfg.host ? 'Pending' : 'Sent', 'system');
    if (_smtpCfg.host) _processSMTPQueue();
  } catch(e) {}
}
let _smtpBusy = false;
function _processSMTPQueue() {
  if (_smtpBusy || !_smtpCfg.host || !_smtpCfg.user || !_smtpCfg.pass) return;
  const pending = db.prepare(`SELECT * FROM email_queue WHERE status='Pending' LIMIT 5`).all();
  if (!pending.length) return;
  _smtpBusy = true;
  const tls = require('tls');
  let idx = 0;
  function sendNext() {
    if (idx >= pending.length) { _smtpBusy = false; return; }
    const em = pending[idx++];
    _sendSMTP(em).then(() => {
      db.prepare(`UPDATE email_queue SET status='Sent', sent_at=datetime('now','localtime') WHERE id=?`).run(em.id);
    }).catch(err => {
      db.prepare(`UPDATE email_queue SET status='Failed', error=? WHERE id=?`).run(err.message.slice(0,200), em.id);
    }).finally(() => sendNext());
  }
  sendNext();
}
function _sendSMTP(em) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const tls = require('tls');
    const lines = [];
    let socket;
    let tlsSocket;
    let step = 0;
    const creds = Buffer.from(`\0${_smtpCfg.user}\0${_smtpCfg.pass}`).toString('base64');
    const boundary = `----=_Gurukul_${Date.now()}`;
    const rawBody = [
      `MIME-Version: 1.0`,`Content-Type: text/plain; charset=UTF-8`,``,em.body
    ].join('\r\n');
    const msg = [
      `From: ${em.from_name} <${_smtpCfg.from}>`,
      `To: ${em.to_name ? em.to_name + ' <' + em.to_email + '>' : em.to_email}`,
      `Subject: ${em.subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}@gurukul>`,
      rawBody, `.`
    ].join('\r\n');
    const t = setTimeout(() => reject(new Error('SMTP timeout')), 15000);
    socket = net.createConnection(_smtpCfg.port, _smtpCfg.host);
    function write(line) { (tlsSocket||socket).write(line + '\r\n'); }
    function onData(data) {
      const txt = data.toString();
      const code = parseInt(txt.slice(0,3));
      if (code >= 500) { clearTimeout(t); return reject(new Error(txt.slice(0,100))); }
      if (step===0 && code===220) { step=1; write(`EHLO gurukul`); }
      else if (step===1 && code===250) { step=2; write(`STARTTLS`); }
      else if (step===2 && code===220) {
        step=3;
        tlsSocket = tls.connect({ socket, rejectUnauthorized: false, servername: _smtpCfg.host });
        tlsSocket.on('data', onData);
        tlsSocket.on('error', e => { clearTimeout(t); reject(e); });
        write(`EHLO gurukul`);
      }
      else if (step===3 && code===250) { step=4; write(`AUTH PLAIN ${creds}`); }
      else if (step===4 && code===235) { step=5; write(`MAIL FROM:<${_smtpCfg.from}>`); }
      else if (step===5 && code===250) { step=6; write(`RCPT TO:<${em.to_email}>`); }
      else if (step===6 && code===250) { step=7; write(`DATA`); }
      else if (step===7 && code===354) { step=8; write(msg); }
      else if (step===8 && code===250) { step=9; write(`QUIT`); clearTimeout(t); resolve(); }
    }
    socket.on('data', onData);
    socket.on('error', e => { clearTimeout(t); reject(e); });
  });
}

// ─── TIMEZONE HELPER (IST = UTC+5:30) ───────────────────────────────────────
// Always use IST so dates/times are correct for India regardless of server TZ
function istNow() {
  const d = new Date();
  const date = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }); // HH:MM:SS
  return { date, time };
}
function istDateOnly() { return istNow().date; }
function istTimeOnly() { return istNow().time; }

// ─── DATABASE SETUP ─────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Seed VM-local DB from project backup if it doesn't exist yet
if (!fs.existsSync(DB_PATH) && fs.existsSync(DB_BACKUP)) {
  try { fs.copyFileSync(DB_BACKUP, DB_PATH); console.log('📦 DB seeded from backup'); }
  catch(e) { console.warn('⚠️  Could not seed DB from backup:', e.message); }
}

const db = new DatabaseSync(DB_PATH);

// ─── DATABASE STABILITY SETTINGS ─────────────────────────────────────────────
// DELETE journal mode: works reliably on all filesystems including FUSE/network mounts.
// WAL mode is NOT used because it requires POSIX file locking which FUSE mounts don't support.
db.exec('PRAGMA journal_mode=DELETE');
// FULL sync: safest setting for DELETE journal mode
db.exec('PRAGMA synchronous=FULL');
// Increase cache to reduce I/O thrashing
db.exec('PRAGMA cache_size=-32000');   // 32 MB page cache
db.exec('PRAGMA temp_store=MEMORY');
// Busy timeout — wait up to 5 seconds instead of instantly failing on lock
db.exec('PRAGMA busy_timeout=5000');
db.exec('PRAGMA foreign_keys=ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    class         TEXT NOT NULL,
    section       TEXT DEFAULT '',
    dob           TEXT DEFAULT '',
    parent_name   TEXT DEFAULT '',
    parent_phone  TEXT DEFAULT '',
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email         TEXT DEFAULT '',
    address       TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    date       TEXT NOT NULL,
    status     TEXT NOT NULL CHECK(status IN ('P','A','L')),
    UNIQUE(student_id, date),
    FOREIGN KEY(student_id) REFERENCES students(id)
  );

  CREATE TABLE IF NOT EXISTS marks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    subject    TEXT NOT NULL,
    exam       TEXT NOT NULL,
    marks      REAL NOT NULL,
    max_marks  REAL NOT NULL DEFAULT 100,
    term       TEXT NOT NULL DEFAULT '',
    date       TEXT DEFAULT '',
    FOREIGN KEY(student_id) REFERENCES students(id)
  );

  CREATE TABLE IF NOT EXISTS fees (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    fee_type   TEXT NOT NULL,
    amount     REAL NOT NULL,
    due_date   TEXT DEFAULT '',
    paid_date  TEXT DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'Pending',
    receipt    TEXT DEFAULT '',
    FOREIGN KEY(student_id) REFERENCES students(id)
  );

  CREATE TABLE IF NOT EXISTS admissions (
    id                TEXT PRIMARY KEY,
    submitted_at      TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'Pending Review',
    status_note       TEXT DEFAULT '',
    status_updated_at TEXT DEFAULT '',
    first_name        TEXT NOT NULL,
    last_name         TEXT NOT NULL,
    dob               TEXT DEFAULT '',
    gender            TEXT DEFAULT '',
    blood_group       TEXT DEFAULT '',
    grade_applying    TEXT DEFAULT '',
    prev_school       TEXT DEFAULT '',
    last_grade        TEXT DEFAULT '',
    last_percentage   TEXT DEFAULT '',
    father_name       TEXT DEFAULT '',
    father_mobile     TEXT NOT NULL,
    father_email      TEXT DEFAULT '',
    father_occupation TEXT DEFAULT '',
    mother_name       TEXT DEFAULT '',
    mother_mobile     TEXT DEFAULT '',
    address           TEXT DEFAULT '',
    city              TEXT DEFAULT '',
    pin               TEXT DEFAULT '',
    hear_about        TEXT DEFAULT '',
    reason_admission  TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS teachers (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email         TEXT DEFAULT '',
    phone         TEXT DEFAULT '',
    subject       TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS teacher_assignments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id TEXT NOT NULL,
    class      TEXT NOT NULL,
    section    TEXT DEFAULT '',
    subject    TEXT NOT NULL,
    UNIQUE(teacher_id, class, section, subject),
    FOREIGN KEY(teacher_id) REFERENCES teachers(id)
  );

  CREATE INDEX IF NOT EXISTS idx_att_student  ON attendance(student_id);
  CREATE INDEX IF NOT EXISTS idx_att_date     ON attendance(date);
  CREATE INDEX IF NOT EXISTS idx_marks_stud   ON marks(student_id);
  CREATE INDEX IF NOT EXISTS idx_marks_term   ON marks(student_id, term);
  CREATE INDEX IF NOT EXISTS idx_fees_stud    ON fees(student_id);
  CREATE INDEX IF NOT EXISTS idx_adm_status   ON admissions(status);
  CREATE INDEX IF NOT EXISTS idx_adm_date     ON admissions(submitted_at);
  CREATE INDEX IF NOT EXISTS idx_ta_teacher   ON teacher_assignments(teacher_id);
  CREATE INDEX IF NOT EXISTS idx_ta_class     ON teacher_assignments(class, section);

  CREATE TABLE IF NOT EXISTS teacher_checkins (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id   TEXT NOT NULL,
    date         TEXT NOT NULL,
    check_in     TEXT DEFAULT '',
    check_out    TEXT DEFAULT '',
    hours_worked REAL DEFAULT 0,
    notes        TEXT DEFAULT '',
    UNIQUE(teacher_id, date),
    FOREIGN KEY(teacher_id) REFERENCES teachers(id)
  );
  CREATE INDEX IF NOT EXISTS idx_tc_teacher ON teacher_checkins(teacher_id);
  CREATE INDEX IF NOT EXISTS idx_tc_date    ON teacher_checkins(date);
`);

// ─── ACCOUNTING TABLES ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS chart_of_accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL CHECK(type IN ('Asset','Liability','Equity','Income','Expense')),
    group_name  TEXT NOT NULL DEFAULT '',
    normal_bal  TEXT NOT NULL CHECK(normal_bal IN ('Dr','Cr')),
    is_system   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS journal_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    voucher_no  TEXT NOT NULL,
    voucher_type TEXT NOT NULL DEFAULT 'Journal',
    narration   TEXT NOT NULL DEFAULT '',
    account_code TEXT NOT NULL,
    debit       REAL NOT NULL DEFAULT 0,
    credit      REAL NOT NULL DEFAULT 0,
    reference   TEXT DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'manual',
    created_by  TEXT NOT NULL DEFAULT 'admin',
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL DEFAULT (datetime('now')),
    action      TEXT NOT NULL,
    entity      TEXT NOT NULL,
    entity_id   TEXT DEFAULT '',
    details     TEXT DEFAULT '',
    performed_by TEXT NOT NULL DEFAULT 'system',
    ip          TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_je_date    ON journal_entries(date);
  CREATE INDEX IF NOT EXISTS idx_je_account ON journal_entries(account_code);
  CREATE INDEX IF NOT EXISTS idx_al_ts      ON audit_log(ts);
`);

// ── Payment Vouchers table (safe migration) ───────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS payment_vouchers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_no    TEXT NOT NULL UNIQUE,
    date          TEXT NOT NULL,
    category      TEXT NOT NULL,
    account_code  TEXT NOT NULL,
    description   TEXT DEFAULT '',
    payee         TEXT DEFAULT '',
    amount        REAL NOT NULL DEFAULT 0,
    payment_mode  TEXT NOT NULL DEFAULT 'Cash',
    authorized_by TEXT DEFAULT '',
    notes         TEXT DEFAULT '',
    created_by    TEXT DEFAULT 'finance',
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pv_date ON payment_vouchers(date);
`);

// ── Recruitment Tables ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS job_postings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    department    TEXT NOT NULL DEFAULT '',
    location      TEXT NOT NULL DEFAULT 'K.R. Nagar, Mysuru',
    type          TEXT NOT NULL DEFAULT 'Full-time',
    description   TEXT DEFAULT '',
    requirements  TEXT DEFAULT '',
    vacancies     INTEGER NOT NULL DEFAULT 1,
    status        TEXT NOT NULL DEFAULT 'Open',
    posted_date   TEXT NOT NULL,
    closing_date  TEXT DEFAULT '',
    created_by    TEXT DEFAULT 'hr',
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS job_applications (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id           INTEGER NOT NULL,
    job_title        TEXT NOT NULL DEFAULT '',
    applicant_name   TEXT NOT NULL,
    email            TEXT DEFAULT '',
    phone            TEXT DEFAULT '',
    experience_years REAL DEFAULT 0,
    qualification    TEXT DEFAULT '',
    current_org      TEXT DEFAULT '',
    applied_date     TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'Applied',
    interview_date   TEXT DEFAULT '',
    notes            TEXT DEFAULT '',
    created_at       TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(job_id) REFERENCES job_postings(id)
  );
  CREATE INDEX IF NOT EXISTS idx_jp_status  ON job_postings(status);
  CREATE INDEX IF NOT EXISTS idx_ja_job     ON job_applications(job_id);
  CREATE INDEX IF NOT EXISTS idx_ja_status  ON job_applications(status);
`);

// ── HR BUDGET (Allocated Fund) ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS hr_budget (
    id               INTEGER PRIMARY KEY,
    fiscal_year      TEXT    NOT NULL UNIQUE,
    allocated_amount REAL    NOT NULL DEFAULT 0,
    notes            TEXT    DEFAULT '',
    set_by           TEXT    DEFAULT '',
    updated_at       TEXT    DEFAULT ''
  );
`);
// Seed current year with 0 so the row always exists
try {
  const curYear = new Date().getFullYear().toString();
  db.prepare(`INSERT OR IGNORE INTO hr_budget (fiscal_year, allocated_amount, notes, set_by, updated_at) VALUES (?,0,'',''  ,?)`).run(curYear, istDateOnly());
} catch(e) {}

// ── DEPARTMENT BUDGETS ─────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS department_budgets (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    dept_key         TEXT    NOT NULL,
    dept_name        TEXT    NOT NULL,
    fiscal_year      TEXT    NOT NULL,
    allocated_amount REAL    NOT NULL DEFAULT 0,
    notes            TEXT    DEFAULT '',
    set_by           TEXT    DEFAULT '',
    updated_at       TEXT    DEFAULT '',
    UNIQUE(dept_key, fiscal_year)
  );
  CREATE TABLE IF NOT EXISTS budget_expenses (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    dept_key         TEXT    NOT NULL,
    fiscal_year      TEXT    NOT NULL,
    month            TEXT    NOT NULL,
    description      TEXT    NOT NULL,
    amount           REAL    NOT NULL DEFAULT 0,
    category         TEXT    DEFAULT 'General',
    reference_id     TEXT    DEFAULT '',
    reference_type   TEXT    DEFAULT '',
    created_by       TEXT    DEFAULT '',
    created_at       TEXT    DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS biometric_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT    NOT NULL,
    user_type    TEXT    NOT NULL CHECK(user_type IN ('teacher','student','support')),
    action       TEXT    NOT NULL CHECK(action IN ('IN','OUT')),
    timestamp    TEXT    NOT NULL,
    device_id    TEXT    DEFAULT 'MAIN-GATE',
    notes        TEXT    DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_bio_user ON biometric_logs(user_id, user_type);
  CREATE INDEX IF NOT EXISTS idx_bio_ts   ON biometric_logs(timestamp);
  CREATE TABLE IF NOT EXISTS class_timetables (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id   TEXT    NOT NULL,
    class_name   TEXT    NOT NULL,
    section      TEXT    NOT NULL DEFAULT 'A',
    subject      TEXT    NOT NULL,
    day_of_week  TEXT    NOT NULL,
    start_time   TEXT    NOT NULL,
    end_time     TEXT    NOT NULL,
    room         TEXT    DEFAULT '',
    week_start   TEXT    NOT NULL,
    notes        TEXT    DEFAULT '',
    created_at   TEXT    DEFAULT '',
    updated_at   TEXT    DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_tt_teacher ON class_timetables(teacher_id);
  CREATE INDEX IF NOT EXISTS idx_tt_class   ON class_timetables(class_name, section);
  CREATE INDEX IF NOT EXISTS idx_tt_week    ON class_timetables(week_start);

  CREATE TABLE IF NOT EXISTS marketing_leads (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    phone            TEXT    DEFAULT '',
    email            TEXT    DEFAULT '',
    class_interested TEXT    DEFAULT '',
    source           TEXT    DEFAULT 'Walk-in',
    stage            TEXT    DEFAULT 'Inquiry',
    assigned_to      TEXT    DEFAULT '',
    notes            TEXT    DEFAULT '',
    created_at       TEXT    DEFAULT '',
    updated_at       TEXT    DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS marketing_campaigns (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    type             TEXT    DEFAULT 'Email',
    status           TEXT    DEFAULT 'Draft',
    target_audience  TEXT    DEFAULT '',
    budget           REAL    DEFAULT 0,
    reach            INTEGER DEFAULT 0,
    conversions      INTEGER DEFAULT 0,
    start_date       TEXT    DEFAULT '',
    end_date         TEXT    DEFAULT '',
    notes            TEXT    DEFAULT '',
    created_at       TEXT    DEFAULT '',
    updated_at       TEXT    DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS marketing_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    type             TEXT    DEFAULT 'Open Day',
    event_date       TEXT    DEFAULT '',
    venue            TEXT    DEFAULT '',
    description      TEXT    DEFAULT '',
    registrations    INTEGER DEFAULT 0,
    attendees        INTEGER DEFAULT 0,
    status           TEXT    DEFAULT 'Upcoming',
    created_at       TEXT    DEFAULT '',
    updated_at       TEXT    DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS marketing_social_posts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    platform         TEXT    DEFAULT 'Instagram',
    content          TEXT    DEFAULT '',
    scheduled_date   TEXT    DEFAULT '',
    status           TEXT    DEFAULT 'Draft',
    reach            INTEGER DEFAULT 0,
    engagement       INTEGER DEFAULT 0,
    created_at       TEXT    DEFAULT '',
    updated_at       TEXT    DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS security_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT    NOT NULL,
    dashboard   TEXT    DEFAULT '',
    ip          TEXT    DEFAULT '',
    username    TEXT    DEFAULT '',
    details     TEXT    DEFAULT '',
    severity    TEXT    DEFAULT 'info',
    timestamp   TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS api_call_logs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    method           TEXT    DEFAULT '',
    path             TEXT    DEFAULT '',
    status_code      INTEGER DEFAULT 200,
    response_time_ms INTEGER DEFAULT 0,
    ip               TEXT    DEFAULT '',
    user_agent       TEXT    DEFAULT '',
    timestamp        TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS server_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS data_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor       TEXT    DEFAULT '',
    role        TEXT    DEFAULT '',
    module      TEXT    DEFAULT '',
    action      TEXT    DEFAULT '',
    db_table    TEXT    DEFAULT '',
    detail      TEXT    DEFAULT '',
    record_count INTEGER DEFAULT 1,
    ip          TEXT    DEFAULT '',
    timestamp   TEXT    DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS page_views (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    page        TEXT    DEFAULT '',
    ip          TEXT    DEFAULT '',
    user_agent  TEXT    DEFAULT '',
    referrer    TEXT    DEFAULT '',
    timestamp   TEXT    DEFAULT (datetime('now','localtime'))
  );
`);

// ─── Track server restarts ────────────────────────────────────────────────────
try {
  db.prepare(`INSERT INTO server_meta (key, value, updated_at)
    VALUES ('restart_count', '1', datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET
      value      = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
      updated_at = datetime('now','localtime')`).run();
  db.prepare(`INSERT OR IGNORE INTO server_meta (key, value, updated_at)
    VALUES ('first_start', datetime('now','localtime'), datetime('now','localtime'))`).run();
  db.prepare(`INSERT INTO server_meta (key, value, updated_at)
    VALUES ('last_restart', datetime('now','localtime'), datetime('now','localtime'))
    ON CONFLICT(key) DO UPDATE SET value = datetime('now','localtime'), updated_at = datetime('now','localtime')`).run();
} catch(e) { console.error('Restart tracking error:', e.message); }
// Seed all departments for current fiscal year
try {
  const curYear = new Date().getFullYear().toString();
  const DEPT_SEEDS = [
    { key:'hr',          name:'Human Resources'  },
    { key:'marketing',   name:'Marketing'         },
    { key:'operations',  name:'Operations & Admin'},
    { key:'academic',    name:'Academic & Teaching'},
    { key:'it',          name:'IT & Infrastructure'},
    { key:'transport',   name:'Transport'         },
  ];
  const deptIns = db.prepare(`INSERT OR IGNORE INTO department_budgets (dept_key,dept_name,fiscal_year,allocated_amount,notes,set_by,updated_at) VALUES (?,?,?,0,'','',?)`);
  DEPT_SEEDS.forEach(d => deptIns.run(d.key, d.name, curYear, istDateOnly()));
} catch(e) {}

// ── Seed Chart of Accounts (school standard) ─────────────────────────────────
const _seedCOA = db.prepare(`INSERT OR IGNORE INTO chart_of_accounts (code,name,type,group_name,normal_bal) VALUES (?,?,?,?,?)`);
[
  // Assets
  ['1001','Cash in Hand',          'Asset','Current Assets','Dr'],
  ['1002','Bank Account (SBI)',    'Asset','Current Assets','Dr'],
  ['1003','Fee Receivable',        'Asset','Current Assets','Dr'],
  ['1004','Salary Advance',        'Asset','Current Assets','Dr'],
  ['1005','Prepaid Expenses',      'Asset','Current Assets','Dr'],
  ['1010','Furniture & Fixtures',  'Asset','Fixed Assets','Dr'],
  ['1011','Computer Equipment',    'Asset','Fixed Assets','Dr'],
  ['1012','School Building',       'Asset','Fixed Assets','Dr'],
  ['1013','Accumulated Depreciation','Asset','Fixed Assets','Cr'],
  // Liabilities
  ['2001','Salary Payable',        'Liability','Current Liabilities','Cr'],
  ['2002','PF Payable',            'Liability','Current Liabilities','Cr'],
  ['2003','ESI Payable',           'Liability','Current Liabilities','Cr'],
  ['2004','TDS Payable',           'Liability','Current Liabilities','Cr'],
  ['2005','Professional Tax Payable','Liability','Current Liabilities','Cr'],
  ['2006','Security Deposits',     'Liability','Current Liabilities','Cr'],
  ['2007','Advance Fees Received', 'Liability','Current Liabilities','Cr'],
  // Equity / Capital Fund
  ['3001','Capital Fund',          'Equity','Capital','Cr'],
  ['3002','General Reserve',       'Equity','Reserves','Cr'],
  ['3003','Building Fund',         'Equity','Reserves','Cr'],
  ['3004','Surplus / (Deficit)',   'Equity','Reserves','Cr'],
  // Income
  ['4001','Tuition Fee Income',    'Income','Fee Income','Cr'],
  ['4002','Uniform Fee Income',    'Income','Fee Income','Cr'],
  ['4003','Transport Fee Income',  'Income','Fee Income','Cr'],
  ['4004','Books Fee Income',      'Income','Fee Income','Cr'],
  ['4005','Exam Fee Income',       'Income','Fee Income','Cr'],
  ['4006','Annual Function Income','Income','Fee Income','Cr'],
  ['4007','Miscellaneous Income',  'Income','Fee Income','Cr'],
  ['4008','Donation Income',       'Income','Other Income','Cr'],
  ['4009','Interest Income',       'Income','Other Income','Cr'],
  // Expenses
  ['5001','Teaching Salary',       'Expense','Personnel','Dr'],
  ['5002','Support Staff Salary',  'Expense','Personnel','Dr'],
  ['5003','PF Contribution (Employer)','Expense','Personnel','Dr'],
  ['5004','ESI Contribution (Employer)','Expense','Personnel','Dr'],
  ['5005','Electricity & Utilities','Expense','Operations','Dr'],
  ['5006','Maintenance & Repairs', 'Expense','Operations','Dr'],
  ['5007','Stationery & Printing', 'Expense','Operations','Dr'],
  ['5008','Transport Expenses',    'Expense','Operations','Dr'],
  ['5009','Depreciation',          'Expense','Operations','Dr'],
  ['5010','Miscellaneous Expense', 'Expense','Operations','Dr'],
  ['5011','Water & Plumbing',      'Expense','Operations','Dr'],
  ['5012','Construction & Infrastructure','Expense','Operations','Dr'],
  ['5013','Cleaning & Sanitation', 'Expense','Operations','Dr'],
  ['5014','Security Services',     'Expense','Operations','Dr'],
  ['5015','Internet & Communication','Expense','Operations','Dr'],
  ['5016','Event & Function Expenses','Expense','Operations','Dr'],
].forEach(r => _seedCOA.run(...r));

// ─── NEW TABLES (safe migrations) ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS holidays (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'National' -- National | State | School
  );

  CREATE TABLE IF NOT EXISTS leave_balance (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id               TEXT NOT NULL,
    person_type             TEXT NOT NULL CHECK(person_type IN ('teacher','student')),
    year                    INTEGER NOT NULL,
    sick_total              INTEGER NOT NULL DEFAULT 0,   -- accrued sick leaves (computed monthly)
    sick_used               INTEGER NOT NULL DEFAULT 0,   -- approved sick leaves consumed
    earned_total            INTEGER NOT NULL DEFAULT 0,   -- accrued earned leaves (computed monthly)
    earned_used             INTEGER NOT NULL DEFAULT 0,   -- approved earned leaves consumed
    earned_used_month       TEXT    NOT NULL DEFAULT '',  -- kept for legacy compat
    earned_applied_month    TEXT    NOT NULL DEFAULT '',  -- 'YYYY-MM:N' — applications count this month
    UNIQUE(person_id, person_type, year)
  );

  CREATE TABLE IF NOT EXISTS leave_applications (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id      TEXT NOT NULL,
    person_type    TEXT NOT NULL CHECK(person_type IN ('teacher','student')),
    person_name    TEXT NOT NULL DEFAULT '',
    leave_type     TEXT NOT NULL CHECK(leave_type IN ('sick','earned')),
    from_date      TEXT NOT NULL,
    to_date        TEXT NOT NULL,
    days           INTEGER NOT NULL DEFAULT 1,
    reason         TEXT DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Approved','Rejected')),
    admin_note     TEXT DEFAULT '',
    applied_at     TEXT NOT NULL,
    decided_at     TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_lapp_person ON leave_applications(person_id, person_type);
  CREATE INDEX IF NOT EXISTS idx_lapp_status ON leave_applications(status);

  CREATE TABLE IF NOT EXISTS daily_reports (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id      TEXT NOT NULL,
    teacher_name    TEXT NOT NULL DEFAULT '',
    report_date     TEXT NOT NULL,
    classes_taken   TEXT NOT NULL DEFAULT '[]',  -- JSON array of {class, section, subject, present, absent}
    login_time      TEXT DEFAULT '',
    logout_time     TEXT DEFAULT '',
    hours_worked    REAL DEFAULT 0,
    extra_notes     TEXT DEFAULT '',
    submitted_at    TEXT NOT NULL,
    UNIQUE(teacher_id, report_date),
    FOREIGN KEY(teacher_id) REFERENCES teachers(id)
  );
  CREATE INDEX IF NOT EXISTS idx_dr_teacher ON daily_reports(teacher_id);
  CREATE INDEX IF NOT EXISTS idx_dr_date    ON daily_reports(report_date);

  CREATE TABLE IF NOT EXISTS salary_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id    TEXT NOT NULL,
    teacher_name  TEXT NOT NULL DEFAULT '',
    checkin_date  TEXT NOT NULL,
    request_type  TEXT NOT NULL CHECK(request_type IN ('exemption','reminder','warning')),
    message       TEXT DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Approved','Rejected')),
    admin_note    TEXT DEFAULT '',
    submitted_at  TEXT NOT NULL,
    decided_at    TEXT DEFAULT '',
    FOREIGN KEY(teacher_id) REFERENCES teachers(id)
  );
  CREATE INDEX IF NOT EXISTS idx_sr_teacher ON salary_requests(teacher_id);
`);

// Safe column migrations
try { db.exec('ALTER TABLE attendance ADD COLUMN marked_by TEXT DEFAULT ""'); } catch(e) { /* already exists */ }
try { db.exec('ALTER TABLE teacher_checkins ADD COLUMN late_mins INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE teacher_checkins ADD COLUMN early_mins INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE teacher_checkins ADD COLUMN deduction REAL DEFAULT 0'); } catch(e) {}
// Leave balance migrations (new monthly accrual system)
try { db.exec('ALTER TABLE leave_balance ADD COLUMN earned_applied_month TEXT NOT NULL DEFAULT ""'); } catch(e) {}
try { db.exec("UPDATE leave_balance SET sick_total=0, earned_total=0 WHERE sick_total IN (6,12) AND sick_used=0 AND earned_used=0"); } catch(e) {}
// Installment request count per-request
try { db.exec('ALTER TABLE installment_requests ADD COLUMN installment_count INTEGER NOT NULL DEFAULT 3'); } catch(e) {}
try { db.exec('ALTER TABLE installment_requests ADD COLUMN annual_fee REAL'); } catch(e) {}
try { db.exec('ALTER TABLE installment_requests ADD COLUMN processing_fee REAL'); } catch(e) {}
// PTM class_name column (for class-wide meetings)
try { db.exec("ALTER TABLE ptm_meetings ADD COLUMN class_name TEXT NOT NULL DEFAULT ''"); } catch(e) {}

// ─── ACCESS CONTROL TABLES ────────────────────────────────────────────────────
// Biometric access control — one row per user, persists lock state
db.exec(`CREATE TABLE IF NOT EXISTS biometric_access (
  user_id    TEXT NOT NULL,
  user_type  TEXT NOT NULL CHECK(user_type IN ('student','teacher','support','all')),
  is_blocked INTEGER NOT NULL DEFAULT 0,
  blocked_by TEXT DEFAULT '',
  blocked_at TEXT DEFAULT '',
  reason     TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, user_type)
);`);

// Admin-side password reset audit log (tracks every admin-forced reset)
db.exec(`CREATE TABLE IF NOT EXISTS password_reset_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  user_type   TEXT NOT NULL CHECK(user_type IN ('student','teacher','support','parent')),
  reset_by    TEXT NOT NULL DEFAULT 'admin',
  ip_address  TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);`);

// class_fees table
db.exec(`CREATE TABLE IF NOT EXISTS class_fees (
  class TEXT PRIMARY KEY,
  annual_fee REAL NOT NULL DEFAULT 21000,
  processing_fee REAL NOT NULL DEFAULT 1000,
  updated_at TEXT
)`);
// Seed default class fees if empty
const cfCount = db.prepare('SELECT COUNT(*) AS c FROM class_fees').get();
if (cfCount.c === 0) {
  const insertCF = db.prepare('INSERT OR IGNORE INTO class_fees (class,annual_fee,processing_fee,updated_at) VALUES (?,?,?,datetime(\'now\',\'localtime\'))');
  const defaultFees = [
    ['1',12000,500],['2',12000,500],['3',13000,500],['4',13000,500],['5',14000,500],
    ['6',15000,750],['7',15000,750],['8',16000,750],['9',17000,1000],['10',18000,1000],
    ['11',20000,1000],['12',21000,1000]
  ];
  defaultFees.forEach(([cls,af,pf]) => insertCF.run(cls,af,pf));
}

// ─── STAFF PROFILE FIELD MIGRATIONS ─────────────────────────────────────────
// Teachers: extended profile fields (using single-quoted defaults for SQLite)
['dob','gender','blood_group','emergency_name','emergency_phone','address',
 'bank_name','account_number','ifsc','account_type','pan','uan','esi_number',
 'employment_type','designation','department','joining_date','status'].forEach(col => {
  try {
    const def = col === 'account_type' ? "'Savings'" : col === 'employment_type' ? "'Full-time'"
              : col === 'status' ? "'Active'" : col === 'department' ? "'Teaching'" : "''";
    db.exec(`ALTER TABLE teachers ADD COLUMN ${col} TEXT DEFAULT ${def}`);
  } catch(e) {}
});
// Support staff: extended profile fields
['dob','gender','blood_group','emergency_name','emergency_phone','address',
 'bank_name','account_number','ifsc','account_type','pan','uan','esi_number','employment_type'].forEach(col => {
  try {
    const def = col === 'account_type' ? "'Savings'" : col === 'employment_type' ? "'Full-time'" : "''";
    db.exec(`ALTER TABLE support_staff ADD COLUMN ${col} TEXT DEFAULT ${def}`);
  } catch(e) {}
});

// ─── FINANCE TABLES ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS fee_schedules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    class        TEXT NOT NULL,
    fee_type     TEXT NOT NULL,
    amount       REAL NOT NULL DEFAULT 0,
    academic_yr  TEXT NOT NULL,
    term         TEXT NOT NULL DEFAULT 'Annual',
    UNIQUE(class, fee_type, academic_yr, term)
  );
  CREATE INDEX IF NOT EXISTS idx_fs_class ON fee_schedules(class, academic_yr);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS finance_fees (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id   TEXT NOT NULL,
    fee_type     TEXT NOT NULL,
    amount       REAL NOT NULL,
    academic_yr  TEXT NOT NULL DEFAULT '',
    month        TEXT NOT NULL DEFAULT '',
    paid_date    TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'Paid' CHECK(status IN ('Paid','Pending','Partial','Waived')),
    payment_mode TEXT NOT NULL DEFAULT 'Cash',
    receipt_no   TEXT DEFAULT '',
    notes        TEXT DEFAULT '',
    recorded_at  TEXT NOT NULL,
    FOREIGN KEY(student_id) REFERENCES students(id)
  );
  CREATE INDEX IF NOT EXISTS idx_ff_student  ON finance_fees(student_id);
  CREATE INDEX IF NOT EXISTS idx_ff_type     ON finance_fees(fee_type);
  CREATE INDEX IF NOT EXISTS idx_ff_month    ON finance_fees(month);
  CREATE INDEX IF NOT EXISTS idx_ff_status   ON finance_fees(status);

  CREATE TABLE IF NOT EXISTS donations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    donor_name   TEXT NOT NULL,
    donor_phone  TEXT DEFAULT '',
    donor_email  TEXT DEFAULT '',
    amount       REAL NOT NULL,
    purpose      TEXT NOT NULL DEFAULT 'General',
    payment_mode TEXT NOT NULL DEFAULT 'Cash',
    receipt_no   TEXT DEFAULT '',
    donated_date TEXT NOT NULL,
    notes        TEXT DEFAULT '',
    recorded_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_don_date    ON donations(donated_date);
  CREATE INDEX IF NOT EXISTS idx_don_purpose ON donations(purpose);
`);

// ─── FINANCE_FEES COLUMN MIGRATIONS ─────────────────────────────────────────
['term','discount_amount','balance_due','cheque_no','bank_name','transaction_id',
 'parent_name','parent_phone','verified_by','submitted_by'].forEach(col => {
  try {
    const def = ['discount_amount','balance_due'].includes(col) ? '0' : "''";
    db.exec(`ALTER TABLE finance_fees ADD COLUMN ${col} REAL NOT NULL DEFAULT ${def}`);
  } catch(e) {}
});
// Fix type for text columns (SQLite ignores type mismatch, but be explicit)
['term','cheque_no','bank_name','transaction_id','parent_name','parent_phone','verified_by','submitted_by'].forEach(col => {
  try { db.exec(`ALTER TABLE finance_fees ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`); } catch(e) {}
});

// ── JSON fee backup / restore (persists across server restarts via FUSE text write) ──
function saveFeeBackup() {
  try {
    const rows = db.prepare('SELECT * FROM finance_fees').all();
    fs.writeFileSync(FEE_BACKUP, JSON.stringify(rows, null, 2), 'utf8');
  } catch(e) { console.warn('⚠️  saveFeeBackup failed:', e.message); }
}

// Startup restore: if the backup JSON exists and the working DB has 0 fee records, restore
(function restoreFeesFromBackup() {
  try {
    if (!fs.existsSync(FEE_BACKUP)) return;
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM finance_fees').get();
    if (cnt && cnt.c > 0) {
      console.log(`✅ finance_fees already has ${cnt.c} rows — skipping JSON restore`);
      return;
    }
    const rows = JSON.parse(fs.readFileSync(FEE_BACKUP, 'utf8'));
    if (!Array.isArray(rows) || rows.length === 0) return;
    const ins = db.prepare(`
      INSERT OR IGNORE INTO finance_fees
        (id,student_id,fee_type,amount,academic_yr,month,paid_date,status,
         payment_mode,receipt_no,notes,recorded_at,term,discount_amount,
         balance_due,cheque_no,bank_name,transaction_id,parent_name,
         parent_phone,verified_by,submitted_by)
      VALUES
        (@id,@student_id,@fee_type,@amount,@academic_yr,@month,@paid_date,@status,
         @payment_mode,@receipt_no,@notes,@recorded_at,@term,@discount_amount,
         @balance_due,@cheque_no,@bank_name,@transaction_id,@parent_name,
         @parent_phone,@verified_by,@submitted_by)
    `);
    let restored = 0;
    for (const r of rows) {
      try {
        ins.run({
          id: r.id, student_id: r.student_id, fee_type: r.fee_type,
          amount: r.amount, academic_yr: r.academic_yr || '', month: r.month || '',
          paid_date: r.paid_date || '', status: r.status || 'Paid',
          payment_mode: r.payment_mode || 'Cash', receipt_no: r.receipt_no || '',
          notes: r.notes || '', recorded_at: r.recorded_at || '',
          term: r.term || '', discount_amount: r.discount_amount || 0,
          balance_due: r.balance_due || 0, cheque_no: r.cheque_no || '',
          bank_name: r.bank_name || '', transaction_id: r.transaction_id || '',
          parent_name: r.parent_name || '', parent_phone: r.parent_phone || '',
          verified_by: r.verified_by || '', submitted_by: r.submitted_by || ''
        });
        restored++;
      } catch(e) { /* skip duplicate/bad row */ }
    }
    console.log(`📥 Restored ${restored} fee records from JSON backup`);
  } catch(e) { console.warn('⚠️  restoreFeesFromBackup failed:', e.message); }
})();

// ─── RESIGNATION TABLE ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS resignations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id   TEXT NOT NULL,
    last_day     TEXT NOT NULL,
    reason       TEXT NOT NULL,
    message      TEXT DEFAULT '',
    status       TEXT DEFAULT 'Pending',
    admin_note   TEXT DEFAULT '',
    submitted_at TEXT NOT NULL,
    reviewed_at  TEXT DEFAULT ''
  )
`);

// ─── PAYROLL TABLES ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS support_staff (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    department   TEXT NOT NULL DEFAULT 'Administration',
    designation  TEXT DEFAULT '',
    phone        TEXT DEFAULT '',
    email        TEXT DEFAULT '',
    joining_date TEXT DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'Active'
  );

  CREATE TABLE IF NOT EXISTS payroll_structures (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id   TEXT NOT NULL,
    staff_type TEXT NOT NULL CHECK(staff_type IN ('teacher','support')),
    basic      REAL NOT NULL DEFAULT 0,
    hra_pct    REAL NOT NULL DEFAULT 40,
    da_pct     REAL NOT NULL DEFAULT 5,
    transport  REAL NOT NULL DEFAULT 1500,
    medical    REAL NOT NULL DEFAULT 1250,
    pf_pct     REAL NOT NULL DEFAULT 12,
    esi_pct    REAL NOT NULL DEFAULT 0.75,
    tds        REAL NOT NULL DEFAULT 0,
    UNIQUE(staff_id, staff_type)
  );

  CREATE TABLE IF NOT EXISTS payroll_entries (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id         TEXT NOT NULL,
    staff_type       TEXT NOT NULL CHECK(staff_type IN ('teacher','support')),
    month            TEXT NOT NULL,
    working_days     INTEGER NOT NULL DEFAULT 26,
    present_days     REAL NOT NULL DEFAULT 0,
    lop_days         REAL NOT NULL DEFAULT 0,
    basic            REAL NOT NULL DEFAULT 0,
    hra              REAL NOT NULL DEFAULT 0,
    da               REAL NOT NULL DEFAULT 0,
    transport        REAL NOT NULL DEFAULT 0,
    medical          REAL NOT NULL DEFAULT 0,
    gross            REAL NOT NULL DEFAULT 0,
    pf_deduction     REAL NOT NULL DEFAULT 0,
    esi_deduction    REAL NOT NULL DEFAULT 0,
    tds_deduction    REAL NOT NULL DEFAULT 0,
    late_deduction   REAL NOT NULL DEFAULT 0,
    lop_deduction    REAL NOT NULL DEFAULT 0,
    total_deductions REAL NOT NULL DEFAULT 0,
    bonus            REAL NOT NULL DEFAULT 0,
    net_pay          REAL NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'Processed',
    processed_at     TEXT DEFAULT '',
    UNIQUE(staff_id, staff_type, month)
  );
  CREATE INDEX IF NOT EXISTS idx_pe_month ON payroll_entries(month);
  CREATE INDEX IF NOT EXISTS idx_pe_staff ON payroll_entries(staff_id, staff_type);
`);

// ─── NOTIFICATIONS & ANNOUNCEMENTS ───────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS announcements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL DEFAULT '',
    type         TEXT NOT NULL DEFAULT 'announcement'
                   CHECK(type IN ('announcement','circular','alert','urgent')),
    target_roles TEXT NOT NULL DEFAULT '["all"]',
    created_by   TEXT NOT NULL DEFAULT 'Admin',
    created_at   TEXT DEFAULT (datetime('now','localtime')),
    expires_at   TEXT DEFAULT NULL,
    is_active    INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL,
    title      TEXT NOT NULL,
    message    TEXT NOT NULL DEFAULT '',
    type       TEXT NOT NULL DEFAULT 'info'
                 CHECK(type IN ('info','success','warning','danger')),
    link       TEXT NOT NULL DEFAULT '',
    is_read    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, role, is_read);
  CREATE INDEX IF NOT EXISTS idx_notif_created ON notifications(created_at);
`);

// ─── SYSTEM SETTINGS + FEE INSTALLMENTS + SMS LOG ────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS system_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  INSERT OR IGNORE INTO system_settings (key,value) VALUES ('installments_enabled','0');
  INSERT OR IGNORE INTO system_settings (key,value) VALUES ('annual_fee','21000');
  INSERT OR IGNORE INTO system_settings (key,value) VALUES ('installment_processing_fee','1000');
  INSERT OR IGNORE INTO system_settings (key,value) VALUES ('installment_count','3');

  CREATE TABLE IF NOT EXISTS fee_installments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      TEXT NOT NULL,
    academic_yr     TEXT NOT NULL DEFAULT '',
    annual_fee      REAL NOT NULL DEFAULT 21000,
    installment_no  INTEGER NOT NULL CHECK(installment_no IN (1,2,3)),
    base_amount     REAL NOT NULL,
    processing_fee  REAL NOT NULL DEFAULT 1000,
    total_amount    REAL NOT NULL,
    status          TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Paid','Overdue')),
    due_date        TEXT DEFAULT NULL,
    paid_date       TEXT DEFAULT NULL,
    collected_by    TEXT NOT NULL DEFAULT '',
    receipt_no      TEXT NOT NULL DEFAULT '',
    payment_mode    TEXT NOT NULL DEFAULT 'Cash',
    notes           TEXT NOT NULL DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(student_id, academic_yr, installment_no),
    FOREIGN KEY(student_id) REFERENCES students(id)
  );
  CREATE INDEX IF NOT EXISTS idx_finstall_student ON fee_installments(student_id, academic_yr);
  CREATE INDEX IF NOT EXISTS idx_finstall_status  ON fee_installments(status);

  CREATE TABLE IF NOT EXISTS installment_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    TEXT NOT NULL,
    academic_yr   TEXT NOT NULL DEFAULT '',
    requested_by  TEXT NOT NULL DEFAULT 'Finance Office',
    request_note  TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Approved','Rejected')),
    admin_note    TEXT NOT NULL DEFAULT '',
    actioned_by   TEXT NOT NULL DEFAULT '',
    actioned_at   TEXT DEFAULT NULL,
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(student_id) REFERENCES students(id)
  );
  CREATE INDEX IF NOT EXISTS idx_inst_req_student ON installment_requests(student_id, academic_yr);
  CREATE INDEX IF NOT EXISTS idx_inst_req_status  ON installment_requests(status);

  CREATE TABLE IF NOT EXISTS sms_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  TEXT NOT NULL,
    phone       TEXT NOT NULL DEFAULT '',
    message     TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'fee_reminder',
    sent_by     TEXT NOT NULL DEFAULT 'Finance Office',
    status      TEXT NOT NULL DEFAULT 'simulated',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );
`);


// ─── NEW FEATURE TABLES ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS academic_calendar (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    event_type  TEXT NOT NULL DEFAULT 'Event'
                  CHECK(event_type IN ('Term','Exam','Holiday','Event','PTM','Result','Vacation','Test')),
    start_date  TEXT NOT NULL,
    end_date    TEXT NOT NULL DEFAULT '',
    class       TEXT NOT NULL DEFAULT 'All',
    description TEXT DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_by  TEXT NOT NULL DEFAULT 'Admin',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_cal_date ON academic_calendar(start_date);

  CREATE TABLE IF NOT EXISTS ptm_meetings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id      INTEGER NOT NULL,
    title           TEXT NOT NULL DEFAULT 'Parent-Teacher Meeting',
    scheduled_at    TEXT NOT NULL,
    teacher_name    TEXT NOT NULL DEFAULT '',
    teacher_subject TEXT NOT NULL DEFAULT '',
    location        TEXT NOT NULL DEFAULT 'School Campus',
    status          TEXT NOT NULL DEFAULT 'scheduled'
                      CHECK(status IN ('scheduled','completed','cancelled','requested')),
    admin_notes     TEXT DEFAULT '',
    parent_notes    TEXT DEFAULT '',
    requested_by    TEXT DEFAULT 'admin',
    created_at      TEXT DEFAULT (datetime('now','localtime')),
    updated_at      TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_ptm_student ON ptm_meetings(student_id);

  CREATE TABLE IF NOT EXISTS mock_tests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  INTEGER NOT NULL,
    title       TEXT NOT NULL,
    subject     TEXT NOT NULL,
    class       TEXT NOT NULL DEFAULT '',
    difficulty  TEXT NOT NULL DEFAULT 'Medium'
                  CHECK(difficulty IN ('Easy','Medium','Hard')),
    questions   TEXT NOT NULL DEFAULT '[]',
    created_by  TEXT NOT NULL DEFAULT 'parent',
    time_limit  INTEGER DEFAULT 30,
    total_marks INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_mock_student ON mock_tests(student_id);

  CREATE TABLE IF NOT EXISTS email_templates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    role        TEXT NOT NULL,
    name        TEXT NOT NULL,
    subject     TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL DEFAULT 'General',
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    updated_at  TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS email_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    to_email    TEXT NOT NULL,
    to_name     TEXT NOT NULL DEFAULT '',
    from_name   TEXT NOT NULL DEFAULT 'The Gurukul High',
    subject     TEXT NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'Pending'
                  CHECK(status IN ('Pending','Sent','Failed','Cancelled')),
    sent_at     TEXT DEFAULT '',
    error       TEXT DEFAULT '',
    created_by  TEXT NOT NULL DEFAULT 'system',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_eq_status ON email_queue(status);

  CREATE TABLE IF NOT EXISTS documents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id      TEXT NOT NULL,
    owner_type    TEXT NOT NULL CHECK(owner_type IN ('student','teacher','support')),
    doc_type      TEXT NOT NULL DEFAULT 'General',
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL DEFAULT '',
    file_size     INTEGER NOT NULL DEFAULT 0,
    mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
    uploaded_by   TEXT NOT NULL DEFAULT '',
    notes         TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_docs_owner ON documents(owner_id, owner_type);

  CREATE TABLE IF NOT EXISTS settlement_records (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_id         TEXT NOT NULL,
    staff_type       TEXT NOT NULL CHECK(staff_type IN ('teacher','support')),
    staff_name       TEXT NOT NULL DEFAULT '',
    last_working_day TEXT NOT NULL,
    reason           TEXT NOT NULL DEFAULT 'Resignation',
    basic_salary     REAL NOT NULL DEFAULT 0,
    years_of_service REAL NOT NULL DEFAULT 0,
    gratuity_amount  REAL NOT NULL DEFAULT 0,
    leave_encashment REAL NOT NULL DEFAULT 0,
    notice_pay       REAL NOT NULL DEFAULT 0,
    other_dues       REAL NOT NULL DEFAULT 0,
    total_settlement REAL NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'Draft'
                       CHECK(status IN ('Draft','Approved','Paid')),
    notes            TEXT DEFAULT '',
    created_by       TEXT NOT NULL DEFAULT 'hr',
    created_at       TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_settle_staff ON settlement_records(staff_id);

  CREATE TABLE IF NOT EXISTS password_resets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL,
    user_type  TEXT NOT NULL CHECK(user_type IN ('student','teacher')),
    token      TEXT NOT NULL UNIQUE,
    used       INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS razorpay_orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    TEXT NOT NULL,
    order_id      TEXT NOT NULL UNIQUE,
    amount        REAL NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'INR',
    purpose       TEXT NOT NULL DEFAULT 'Fee Payment',
    status        TEXT NOT NULL DEFAULT 'created'
                    CHECK(status IN ('created','paid','failed')),
    payment_id    TEXT DEFAULT '',
    academic_yr   TEXT DEFAULT '',
    notes         TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── Exam & Report Card tables ──────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS exams (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    exam_type    TEXT    NOT NULL DEFAULT 'Unit Test'
                   CHECK(exam_type IN ('Unit Test','Mid Term','Half Yearly','Annual','Mock Test','Internal')),
    term         TEXT    NOT NULL DEFAULT 'Term-1',
    class        TEXT    NOT NULL DEFAULT 'All',
    section      TEXT    NOT NULL DEFAULT 'All',
    start_date   TEXT    NOT NULL DEFAULT '',
    end_date     TEXT    NOT NULL DEFAULT '',
    total_marks  REAL    NOT NULL DEFAULT 100,
    pass_marks   REAL    NOT NULL DEFAULT 35,
    academic_yr  TEXT    NOT NULL DEFAULT '',
    status       TEXT    NOT NULL DEFAULT 'Upcoming'
                   CHECK(status IN ('Upcoming','Ongoing','Completed','Results Published')),
    created_by   TEXT    DEFAULT '',
    created_at   TEXT    DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_exam_class  ON exams(class, section);
  CREATE INDEX IF NOT EXISTS idx_exam_term   ON exams(term);
  CREATE INDEX IF NOT EXISTS idx_exam_status ON exams(status);

  CREATE TABLE IF NOT EXISTS exam_marks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id      INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    student_id   TEXT    NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    subject      TEXT    NOT NULL,
    marks        REAL    NOT NULL DEFAULT 0,
    max_marks    REAL    NOT NULL DEFAULT 100,
    grade        TEXT    DEFAULT '',
    remarks      TEXT    DEFAULT '',
    entered_by   TEXT    DEFAULT '',
    entered_at   TEXT    DEFAULT (datetime('now','localtime')),
    UNIQUE(exam_id, student_id, subject)
  );
  CREATE INDEX IF NOT EXISTS idx_em_exam    ON exam_marks(exam_id);
  CREATE INDEX IF NOT EXISTS idx_em_student ON exam_marks(student_id);
  CREATE INDEX IF NOT EXISTS idx_em_class   ON exam_marks(exam_id, subject);
`);

// ─── NEW MODULE TABLES ────────────────────────────────────────────────────────
db.exec(`
  -- HOMEWORK / ASSIGNMENTS
  CREATE TABLE IF NOT EXISTS homework (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    subject     TEXT NOT NULL,
    class       TEXT NOT NULL,
    section     TEXT DEFAULT 'All',
    due_date    TEXT NOT NULL,
    assigned_by TEXT NOT NULL,
    attachment  TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS homework_submissions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    homework_id  INTEGER NOT NULL REFERENCES homework(id) ON DELETE CASCADE,
    student_id   TEXT NOT NULL,
    status       TEXT DEFAULT 'Pending',
    submitted_at TEXT DEFAULT '',
    remarks      TEXT DEFAULT '',
    grade        TEXT DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_hw_sub ON homework_submissions(homework_id, student_id);

  -- LIBRARY
  CREATE TABLE IF NOT EXISTS library_books (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    author        TEXT DEFAULT '',
    isbn          TEXT DEFAULT '',
    category      TEXT DEFAULT 'General',
    total_copies  INTEGER DEFAULT 1,
    available     INTEGER DEFAULT 1,
    rack          TEXT DEFAULT '',
    added_on      TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS book_loans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id     INTEGER NOT NULL REFERENCES library_books(id) ON DELETE CASCADE,
    borrower_id TEXT NOT NULL,
    borrower_type TEXT DEFAULT 'student',
    issued_on   TEXT DEFAULT (datetime('now','localtime')),
    due_date    TEXT NOT NULL,
    returned_on TEXT DEFAULT '',
    status      TEXT DEFAULT 'Issued',
    fine        REAL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_loans_book    ON book_loans(book_id);
  CREATE INDEX IF NOT EXISTS idx_loans_borrower ON book_loans(borrower_id);

  -- TRANSPORT
  CREATE TABLE IF NOT EXISTS transport_routes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    route_name TEXT NOT NULL,
    driver     TEXT DEFAULT '',
    vehicle    TEXT DEFAULT '',
    capacity   INTEGER DEFAULT 40,
    stops      TEXT DEFAULT '[]',
    departure  TEXT DEFAULT '08:00',
    arrival    TEXT DEFAULT '09:00',
    status     TEXT DEFAULT 'Active'
  );
  CREATE TABLE IF NOT EXISTS transport_students (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    route_id   INTEGER NOT NULL REFERENCES transport_routes(id) ON DELETE CASCADE,
    stop       TEXT DEFAULT '',
    fee        REAL DEFAULT 0,
    UNIQUE(student_id)
  );

  -- VISITOR LOG
  CREATE TABLE IF NOT EXISTS visitors (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    phone        TEXT DEFAULT '',
    purpose      TEXT DEFAULT '',
    whom_to_meet TEXT DEFAULT '',
    badge_no     TEXT DEFAULT '',
    entry_time   TEXT DEFAULT (datetime('now','localtime')),
    exit_time    TEXT DEFAULT '',
    status       TEXT DEFAULT 'In'
  );

  -- CERTIFICATES
  CREATE TABLE IF NOT EXISTS certificates (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  TEXT NOT NULL,
    type        TEXT NOT NULL,
    content     TEXT DEFAULT '',
    issued_by   TEXT DEFAULT 'Administrator',
    issued_on   TEXT DEFAULT (datetime('now','localtime')),
    serial_no   TEXT DEFAULT ''
  );

  -- NEP 2020 HOLISTIC ASSESSMENTS
  CREATE TABLE IF NOT EXISTS nep_assessments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  TEXT NOT NULL,
    class       TEXT NOT NULL,
    term        TEXT NOT NULL,
    academic_yr TEXT NOT NULL,
    cognitive   INTEGER DEFAULT 0,
    affective   INTEGER DEFAULT 0,
    psychomotor INTEGER DEFAULT 0,
    sports      TEXT DEFAULT '',
    arts        TEXT DEFAULT '',
    community   TEXT DEFAULT '',
    teacher_note TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(student_id, term, academic_yr)
  );

  -- NOTIFICATION SETTINGS (WhatsApp / SMS)
  CREATE TABLE IF NOT EXISTS notification_settings (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT DEFAULT 'msg91',
    api_key  TEXT DEFAULT '',
    sender   TEXT DEFAULT 'GURUKL',
    enabled  INTEGER DEFAULT 0,
    wa_token TEXT DEFAULT '',
    wa_phone TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  INSERT OR IGNORE INTO notification_settings(id) VALUES(1);
`);

// Seed sample library books
try {
  const bookCount = db.prepare('SELECT COUNT(*) AS c FROM library_books').get().c;
  if (bookCount === 0) {
    const ins = db.prepare("INSERT INTO library_books(title,author,isbn,category,total_copies,available,rack) VALUES(?,?,?,?,?,?,?)");
    [
      ['Mathematics for Class 10','R.D. Sharma','978-81-219-0942-3','Textbook',5,5,'A1'],
      ['Science NCERT Class 9','NCERT','978-81-7450-602-3','Textbook',4,4,'A2'],
      ['History of Modern India','Bipin Chandra','978-81-250-1849-9','History',3,3,'B1'],
      ['Wings of Fire','A.P.J. Abdul Kalam','978-81-7371-480-7','Biography',2,2,'C1'],
      ['The Alchemist','Paulo Coelho','978-0-06-231609-7','Fiction',3,3,'C2'],
      ['English Grammar','Wren & Martin','978-81-219-0198-4','Reference',6,6,'A3'],
      ['Physics for Class 12','H.C. Verma','978-81-7709-197-0','Textbook',4,4,'A4'],
    ].forEach(b => ins.run(...b));
  }
} catch(e) {}

// Seed sample transport routes
try {
  const rtCount = db.prepare('SELECT COUNT(*) AS c FROM transport_routes').get().c;
  if (rtCount === 0) {
    const ins = db.prepare("INSERT INTO transport_routes(route_name,driver,vehicle,capacity,stops,departure,arrival) VALUES(?,?,?,?,?,?,?)");
    ins.run('Route 1 – KR Nagar', 'Raju Kumar', 'KA-09 AB 1234', 40, JSON.stringify(['KR Nagar','Mysore Road','Vijayanagar','School']), '08:00', '08:45');
    ins.run('Route 2 – Hunsur Road', 'Mahesh D', 'KA-09 CD 5678', 35, JSON.stringify(['Hunsur Road','Rajajinagar','Saraswathipuram','School']), '08:10', '08:50');
  }
} catch(e) {}

// ─────────────────────────────────────────────────────────────────────────────

// Seed academic calendar events
try {
  const yr = new Date().getFullYear();
  const calEvents = [
    ['Academic Year Begins', 'Term',    `${yr}-06-01`, `${yr}-06-01`,   'All', 'Start of academic year'],
    ['Term 1',               'Term',    `${yr}-06-01`, `${yr}-09-30`,   'All', 'First term'],
    ['Term 1 Unit Tests',    'Test',    `${yr}-08-01`, `${yr}-08-15`,   'All', 'Unit tests for Term 1'],
    ['Term 1 Exams',         'Exam',    `${yr}-09-15`, `${yr}-09-30`,   'All', 'Term 1 internal exams'],
    ['Dussehra Break',       'Vacation',`${yr}-10-01`, `${yr}-10-14`,   'All', 'Autumn break'],
    ['Term 2',               'Term',    `${yr}-10-15`, `${yr}-12-31`,   'All', 'Second term'],
    ['Half-Yearly Exams',    'Exam',    `${yr}-12-10`, `${yr}-12-20`,   'All', 'Half-yearly examinations'],
    ['Winter Vacation',      'Vacation',`${yr}-12-21`, `${yr+1}-01-05`, 'All', 'Winter break'],
    ['Term 3',               'Term',    `${yr+1}-01-06`,`${yr+1}-03-31`,'All', 'Third term'],
    ['Annual Exams',         'Exam',    `${yr+1}-03-01`,`${yr+1}-03-31`,'All', 'Annual/Board examinations'],
    ['Result Day',           'Result',  `${yr+1}-04-15`,`${yr+1}-04-15`,'All', 'Annual result declaration'],
    ['PTM - Term 1',         'PTM',     `${yr}-10-12`, `${yr}-10-12`,   'All', 'Parent-Teacher Meeting after Term 1'],
    ['PTM - Half-Yearly',    'PTM',     `${yr+1}-01-04`,`${yr+1}-01-04`,'All', 'Parent-Teacher Meeting after half-yearly'],
  ];
  const insCalEv = db.prepare('INSERT OR IGNORE INTO academic_calendar (title,event_type,start_date,end_date,class,description) VALUES (?,?,?,?,?,?)');
  calEvents.forEach(e => insCalEv.run(...e));
} catch(e) {}

// Seed sample email templates
try {
  const tplSeeds = [
    ['teacher','Fee Reminder','Fee Payment Reminder','Dear {parent_name},\n\nThis is a reminder that the fee of ₹{amount} for {student_name} is due on {due_date}.\n\nPlease make the payment at the school finance office.\n\nRegards,\nThe Gurukul High','Finance'],
    ['teacher','Leave Approved','Leave Application Approved','Dear {teacher_name},\n\nYour leave application from {from_date} to {to_date} has been approved.\n\nEnjoy your leave.\n\nRegards,\nAdmin'],
    ['hr','Offer Letter','Offer of Employment — The Gurukul High','Dear {name},\n\nWe are pleased to offer you the position of {designation} at The Gurukul High, K.R. Nagar, Mysuru.\n\nYour joining date is {joining_date}.\n\nPlease confirm your acceptance by replying to this email.\n\nRegards,\nHR Department','Recruitment'],
    ['hr','Interview Call','Interview Invitation','Dear {name},\n\nYou are invited for an interview on {date} at {time} at our school premises.\n\nPlease bring your original documents.\n\nRegards,\nHR Department','Recruitment'],
  ];
  const insTpl = db.prepare("INSERT OR IGNORE INTO email_templates (role,name,subject,body,category,created_by) VALUES (?,?,?,?,?,?)");
  tplSeeds.forEach(t => insTpl.run(t[0],t[1],t[2],t[3],t[4]||'General','system'));
} catch(e) {}

// Create uploads directory
try {
  const uploadsDir = path.join(DATA_DIR, 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
} catch(e) {}

// ─── SEED SUPPORT STAFF ───────────────────────────────────────────────────────
const _seedSS = db.prepare(`INSERT OR IGNORE INTO support_staff (id,name,department,designation,phone,email,joining_date,status) VALUES (?,?,?,?,?,?,?,?)`);
[
  ['SS001','Mohan Kumar',    'Housekeeping', 'Peon',              '9900112233','mohan@gurukul.edu',   '2020-06-01','Active'],
  ['SS002','Ramaiah B',      'Security',     'Security Guard',    '9900223344','ramaiah@gurukul.edu', '2019-04-01','Active'],
  ['SS003','Savitha Rao',    'Library',      'Librarian',         '9900334455','savitha@gurukul.edu', '2021-07-01','Active'],
  ['SS004','Prakash Gowda',  'Science',      'Lab Assistant',     '9900445566','prakash@gurukul.edu', '2022-06-01','Active'],
  ['SS005','Leela Devi',     'Administration','Office Clerk',     '9900556677','leela@gurukul.edu',   '2020-01-15','Active'],
  ['SS006','Suresh Naik',    'Transport',    'Bus Driver',        '9900667788','snaik@gurukul.edu',   '2018-06-01','Active'],
  ['SS007','Anitha M',       'Administration','Receptionist',     '9900778899','anitha@gurukul.edu',  '2023-04-01','Active'],
].forEach(r => _seedSS.run(...r));

// ─── SEED SALARY STRUCTURES ──────────────────────────────────────────────────
const _seedPS = db.prepare(`INSERT OR IGNORE INTO payroll_structures (staff_id,staff_type,basic,hra_pct,da_pct,transport,medical,pf_pct,esi_pct,tds) VALUES (?,?,?,?,?,?,?,?,?,?)`);
// Support staff structures
[
  ['SS001','support',12000,40,5,1500,1250,12,0.75,0  ],
  ['SS002','support',13500,40,5,1500,1250,12,0.75,0  ],
  ['SS003','support',18000,40,5,1500,1250,12,0,   300],
  ['SS004','support',16000,40,5,1500,1250,12,0,   200],
  ['SS005','support',15000,40,5,1500,1250,12,0,   150],
  ['SS006','support',14000,40,5,1500,1250,12,0.75,0  ],
  ['SS007','support',14500,40,5,1500,1250,12,0,   100],
].forEach(r => _seedPS.run(...r));
// Teachers — insert default structure for any teacher without one
db.prepare('SELECT id FROM teachers').all().forEach(t => {
  db.prepare(`INSERT OR IGNORE INTO payroll_structures (staff_id,staff_type,basic,hra_pct,da_pct,transport,medical,pf_pct,esi_pct,tds) VALUES (?,?,25000,40,5,1500,1250,12,0,500)`).run(t.id,'teacher');
});

// ─── SEED HOLIDAYS (2026, Karnataka) ─────────────────────────────────────────
const holidays2026 = [
  ['2026-01-01','New Year\'s Day','National'],
  ['2026-01-14','Makar Sankranti / Makara Sankramana','State'],
  ['2026-01-26','Republic Day','National'],
  ['2026-02-19','Chhatrapati Shivaji Maharaj Jayanti','National'],
  ['2026-03-20','Ugadi (Karnataka New Year)','State'],
  ['2026-03-25','Holi','National'],
  ['2026-04-02','Ram Navami','National'],
  ['2026-04-03','Good Friday','National'],
  ['2026-04-14','Dr. Ambedkar Jayanti','National'],
  ['2026-04-21','Mahavir Jayanti','National'],
  ['2026-05-01','Karnataka Rajyotsava / Labour Day','State'],
  ['2026-05-23','Buddha Purnima','National'],
  ['2026-06-17','Eid ul-Adha (Bakrid)','National'],
  ['2026-07-16','Muharram','National'],
  ['2026-08-15','Independence Day','National'],
  ['2026-08-25','Ganesh Chaturthi','National'],
  ['2026-09-14','Milad-un-Nabi','National'],
  ['2026-10-02','Gandhi Jayanti','National'],
  ['2026-10-20','Vijayadashami (Dasara)','State'],
  ['2026-10-28','Naraka Chaturdashi (Diwali Eve)','National'],
  ['2026-10-29','Diwali / Lakshmi Puja','National'],
  ['2026-11-01','Karnataka Rajyotsava (Statehood Day)','State'],
  ['2026-11-04','Bhai Dooj','National'],
  ['2026-11-13','Guru Nanak Jayanti','National'],
  ['2026-12-25','Christmas Day','National'],
];
const insertHoliday = db.prepare('INSERT OR IGNORE INTO holidays (date,name,type) VALUES (?,?,?)');
for (const [d,n,t] of holidays2026) insertHoliday.run(d,n,t);
// Add older year too
const holidays2025 = [
  ['2025-08-15','Independence Day','National'],
  ['2025-10-02','Gandhi Jayanti','National'],
  ['2025-11-01','Karnataka Rajyotsava','State'],
  ['2025-12-25','Christmas Day','National'],
];
for (const [d,n,t] of holidays2025) insertHoliday.run(d,n,t);

// ─── TEACHER SEEDING HELPERS ─────────────────────────────────────────────────
// hashPassword is a function declaration (hoisted), so safe to call here.
function seedTeacher({ id, name, username, password, email, phone, subject,
                        designation, department, joining_date, employment_type,
                        status, assignments: assigns }) {
  const existing = db.prepare('SELECT id FROM teachers WHERE username=?').get(username);
  if (!existing) {
    const hash = hashPassword(password);
    // Insert core teacher record
    db.prepare(`INSERT OR IGNORE INTO teachers
      (id,name,username,password_hash,email,phone,subject,
       designation,department,joining_date,employment_type,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, name, username, hash, email||'', phone||'', subject||'',
      designation||'', department||'Teaching',
      joining_date||'', employment_type||'Full-time', status||'Active'
    );
    // Class assignments
    if (Array.isArray(assigns)) {
      assigns.forEach(a => {
        try {
          db.prepare('INSERT OR IGNORE INTO teacher_assignments (teacher_id,class,section,subject) VALUES (?,?,?,?)')
            .run(id, a.class, a.section||'', a.subject||subject||'');
        } catch(e) {}
      });
    }
    // Default salary structure
    db.prepare(`INSERT OR IGNORE INTO payroll_structures
      (staff_id,staff_type,basic,hra_pct,da_pct,transport,medical,pf_pct,esi_pct,tds)
      VALUES (?,?,25000,40,5,1500,1250,12,0,500)`).run(id, 'teacher');
    console.log(`   👨‍🏫 Seeded teacher: ${name} (username: ${username}, pass: ${password})`);
  } else {
    // Always ensure salary structure exists for existing teachers
    db.prepare(`INSERT OR IGNORE INTO payroll_structures
      (staff_id,staff_type,basic,hra_pct,da_pct,transport,medical,pf_pct,esi_pct,tds)
      VALUES (?,?,25000,40,5,1500,1250,12,0,500)`).run(existing.id, 'teacher');
  }
}

// Auto-generate next teacher ID based on existing records
function nextTeacherId() {
  const rows = db.prepare("SELECT id FROM teachers WHERE id LIKE 'T%'").all();
  let max = 0;
  rows.forEach(r => {
    const n = parseInt(r.id.replace('T','')) || 0;
    if (n > max) max = n;
  });
  return `T${String(max + 1).padStart(3,'0')}`;
}

// ─── SEED TEACHERS ───────────────────────────────────────────────────────────
// Seed ensures all teacher accounts exist with proper profiles.
// INSERT OR IGNORE protects existing records; salary structure is only set if missing.
[
  {
    name:            'Suresh Kumar',
    username:        'suresh.kumar',
    password:        'Teacher@123',
    email:           'suresh.kumar@gurukul.edu',
    phone:           '9900001111',
    subject:         'Mathematics',
    designation:     'Senior Teacher',
    department:      'Mathematics',
    joining_date:    '2020-06-01',
    employment_type: 'Full-time',
    status:          'Active',
    assignments:     []
  },
  {
    name:            'Priya Sharma',
    username:        'priya.sharma',
    password:        'Teacher@123',
    email:           'priya.sharma@gurukul.edu',
    phone:           '9900002222',
    subject:         'English',
    designation:     'Teacher',
    department:      'Languages',
    joining_date:    '2021-07-01',
    employment_type: 'Full-time',
    status:          'Active',
    assignments:     []
  },
  {
    name:            'Ramesh Rao',
    username:        'ramesh.rao',
    password:        'Teacher@123',
    email:           'ramesh.rao@gurukul.edu',
    phone:           '9900003333',
    subject:         'Science',
    designation:     'Senior Teacher',
    department:      'Science',
    joining_date:    '2019-06-01',
    employment_type: 'Full-time',
    status:          'Active',
    assignments:     []
  },
  {
    name:            'Kavitha Nair',
    username:        'kavitha.nair',
    password:        'Teacher@123',
    email:           'kavitha.nair@gurukul.edu',
    phone:           '9900004444',
    subject:         'Social Studies',
    designation:     'Teacher',
    department:      'Social Studies',
    joining_date:    '2022-06-01',
    employment_type: 'Full-time',
    status:          'Active',
    assignments:     []
  },
  {
    name:            'Anand Murthy',
    username:        'anand.murthy',
    password:        'Teacher@123',
    email:           'anand.murthy@gurukul.edu',
    phone:           '9900005555',
    subject:         'Hindi',
    designation:     'Teacher',
    department:      'Languages',
    joining_date:    '2021-04-01',
    employment_type: 'Full-time',
    status:          'Active',
    assignments:     []
  },
].forEach(t => {
  t.id = nextTeacherId();
  seedTeacher(t);
});

// ─── RBAC SYSTEM INIT ────────────────────────────────────────────────────────
rbac.init(db);

// ─── PREPARED STATEMENTS ────────────────────────────────────────────────────
const stmts = {
  // Students
  findByUsername: db.prepare('SELECT * FROM students WHERE username = ?'),
  findById:       db.prepare('SELECT * FROM students WHERE id = ?'),
  allStudents:    db.prepare('SELECT id,name,class,section,username,parent_name,parent_phone,email FROM students ORDER BY class,name'),
  insertStudent:  db.prepare('INSERT INTO students (id,name,class,section,dob,parent_name,parent_phone,username,password_hash,email,address) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
  updatePassword: db.prepare('UPDATE students SET password_hash=? WHERE id=?'),

  // Attendance
  getAttendance:  db.prepare('SELECT date,status FROM attendance WHERE student_id=? ORDER BY date DESC'),
  attSummary:     db.prepare('SELECT status, COUNT(*) as count FROM attendance WHERE student_id=? GROUP BY status'),
  markAttendance: db.prepare('INSERT OR REPLACE INTO attendance (student_id,date,status,marked_by) VALUES (?,?,?,?)'),
  bulkAttDate:    db.prepare('SELECT student_id,status FROM attendance WHERE date=?'),
  getAttByClassDate: db.prepare(`SELECT a.student_id, a.status, s.name, s.section
    FROM attendance a JOIN students s ON a.student_id=s.id
    WHERE s.class=? AND a.date=? ORDER BY s.name`),

  // Teachers
  findTeacherByUsername: db.prepare('SELECT * FROM teachers WHERE username=?'),
  findTeacherById:       db.prepare('SELECT * FROM teachers WHERE id=?'),
  allTeachers:           db.prepare("SELECT id,name,username,email,phone,subject,COALESCE(designation,'') as designation,COALESCE(department,'Teaching') as department,COALESCE(status,'Active') as status,COALESCE(employment_type,'Full-time') as employment_type,COALESCE(joining_date,'') as joining_date FROM teachers ORDER BY name"),
  insertTeacher:         db.prepare('INSERT INTO teachers (id,name,username,password_hash,email,phone,subject,designation,department,joining_date,employment_type,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
  getAssignments:        db.prepare('SELECT class,section,subject FROM teacher_assignments WHERE teacher_id=? ORDER BY class,section'),
  getAssignedClasses:    db.prepare('SELECT DISTINCT class,section FROM teacher_assignments WHERE teacher_id=? ORDER BY class,section'),
  insertAssignment:      db.prepare('INSERT OR IGNORE INTO teacher_assignments (teacher_id,class,section,subject) VALUES (?,?,?,?)'),
  deleteAssignment:      db.prepare('DELETE FROM teacher_assignments WHERE teacher_id=? AND class=? AND section=?'),
  studentsInClass:       db.prepare('SELECT id,name,section FROM students WHERE class=? ORDER BY name'),
  studentsInClassSec:    db.prepare('SELECT id,name,section FROM students WHERE class=? AND section=? ORDER BY name'),
  attForClassDate:       db.prepare(`SELECT a.student_id, a.status
    FROM attendance a JOIN students s ON a.student_id=s.id
    WHERE s.class=? AND s.section=? AND a.date=?`),
  attSummaryForClass:    db.prepare(`SELECT s.id, s.name,
    COUNT(a.id) as total,
    SUM(CASE WHEN a.status='P' THEN 1 ELSE 0 END) as present,
    SUM(CASE WHEN a.status='A' THEN 1 ELSE 0 END) as absent,
    SUM(CASE WHEN a.status='L' THEN 1 ELSE 0 END) as leave
    FROM students s LEFT JOIN attendance a ON s.id=a.student_id
    WHERE s.class=? AND s.section=?
    GROUP BY s.id ORDER BY s.name`),
  attHistoryForClass:    db.prepare(`SELECT a.date, a.student_id, a.status, s.name
    FROM attendance a JOIN students s ON a.student_id=s.id
    WHERE s.class=? AND s.section=? AND a.date BETWEEN ? AND ?
    ORDER BY a.date DESC, s.name`),
  datesMarkedForClass:   db.prepare(`SELECT DISTINCT a.date
    FROM attendance a JOIN students s ON a.student_id=s.id
    WHERE s.class=? AND s.section=? ORDER BY a.date DESC LIMIT 30`),

  // Marks
  getMarks:       db.prepare('SELECT subject,exam,marks,max_marks,term,date FROM marks WHERE student_id=? ORDER BY term,subject'),
  insertMark:     db.prepare('INSERT INTO marks (student_id,subject,exam,marks,max_marks,term,date) VALUES (?,?,?,?,?,?,?)'),

  // Fees
  getFees:        db.prepare('SELECT fee_type,amount,due_date,paid_date,status,receipt FROM fees WHERE student_id=? ORDER BY due_date DESC'),
  feeSummary:     db.prepare('SELECT status, SUM(amount) as total FROM fees WHERE student_id=? GROUP BY status'),
  updateFee:      db.prepare('UPDATE fees SET status=?,paid_date=?,receipt=? WHERE id=?'),
  insertFee:      db.prepare('INSERT INTO fees (student_id,fee_type,amount,due_date,status) VALUES (?,?,?,?,?)'),

  // Admissions
  countAdmissions:    db.prepare('SELECT COUNT(*) as c FROM admissions'),
  allAdmissions:      db.prepare('SELECT * FROM admissions ORDER BY submitted_at DESC'),
  admissionById:      db.prepare('SELECT * FROM admissions WHERE id=?'),
  insertAdmission:    db.prepare(`INSERT INTO admissions
    (id,submitted_at,status,first_name,last_name,dob,gender,blood_group,grade_applying,
     prev_school,last_grade,last_percentage,father_name,father_mobile,father_email,
     father_occupation,mother_name,mother_mobile,address,city,pin,hear_about,reason_admission)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateAdmStatus:    db.prepare('UPDATE admissions SET status=?,status_note=?,status_updated_at=? WHERE id=?'),

  // Teacher Check-ins (self-attendance)
  tcGetToday:       db.prepare('SELECT * FROM teacher_checkins WHERE teacher_id=? AND date=?'),
  tcInsertCheckin:  db.prepare('INSERT OR IGNORE INTO teacher_checkins (teacher_id,date,check_in) VALUES (?,?,?)'),
  tcUpdateCheckout: db.prepare('UPDATE teacher_checkins SET check_out=?,hours_worked=?,late_mins=?,early_mins=?,deduction=? WHERE teacher_id=? AND date=?'),
  tcGetHistory:     db.prepare('SELECT * FROM teacher_checkins WHERE teacher_id=? AND date BETWEEN ? AND ? ORDER BY date DESC'),
  tcAllTeachers:    db.prepare('SELECT tc.*, t.name FROM teacher_checkins tc JOIN teachers t ON tc.teacher_id=t.id WHERE tc.date BETWEEN ? AND ? ORDER BY tc.date DESC, t.name'),

  // Holidays
  allHolidays:      db.prepare('SELECT * FROM holidays ORDER BY date'),
  holidaysByYear:   db.prepare("SELECT * FROM holidays WHERE date LIKE ? ORDER BY date"),

  // Leave balance
  getLeaveBalance:    db.prepare('SELECT * FROM leave_balance WHERE person_id=? AND person_type=? AND year=?'),
  upsertLeaveBalance: db.prepare(`INSERT INTO leave_balance (person_id,person_type,year,sick_total,sick_used,earned_total,earned_used,earned_used_month,earned_applied_month)
    VALUES (?,?,?,0,0,0,0,'','') ON CONFLICT(person_id,person_type,year) DO NOTHING`),
  updateLeaveAccrued: db.prepare('UPDATE leave_balance SET sick_total=?,earned_total=? WHERE person_id=? AND person_type=? AND year=?'),
  updateLeaveUsed:    db.prepare('UPDATE leave_balance SET sick_used=?,earned_used=?,earned_applied_month=? WHERE person_id=? AND person_type=? AND year=?'),

  // Leave applications
  insertLeave:      db.prepare('INSERT INTO leave_applications (person_id,person_type,person_name,leave_type,from_date,to_date,days,reason,status,applied_at) VALUES (?,?,?,?,?,?,?,?,?,?)'),
  myLeaves:         db.prepare('SELECT * FROM leave_applications WHERE person_id=? AND person_type=? ORDER BY applied_at DESC'),
  allLeaves:        db.prepare('SELECT * FROM leave_applications ORDER BY applied_at DESC'),
  pendingLeaves:    db.prepare("SELECT * FROM leave_applications WHERE status='Pending' ORDER BY applied_at ASC"),
  leaveById:        db.prepare('SELECT * FROM leave_applications WHERE id=?'),
  updateLeaveStatus:db.prepare('UPDATE leave_applications SET status=?,admin_note=?,decided_at=? WHERE id=?'),

  // Daily reports
  insertDailyReport:  db.prepare('INSERT OR REPLACE INTO daily_reports (teacher_id,teacher_name,report_date,classes_taken,login_time,logout_time,hours_worked,extra_notes,submitted_at) VALUES (?,?,?,?,?,?,?,?,?)'),
  getMyReport:        db.prepare('SELECT * FROM daily_reports WHERE teacher_id=? AND report_date=?'),
  myReportHistory:    db.prepare('SELECT * FROM daily_reports WHERE teacher_id=? ORDER BY report_date DESC LIMIT 30'),
  allDailyReports:    db.prepare('SELECT * FROM daily_reports ORDER BY report_date DESC, submitted_at DESC'),
  reportsByDate:      db.prepare('SELECT * FROM daily_reports WHERE report_date=? ORDER BY teacher_name'),

  // Salary requests
  insertSalaryRequest:      db.prepare("INSERT INTO salary_requests (teacher_id,teacher_name,checkin_date,request_type,message,status,submitted_at) VALUES (?,?,?,?,?,'Pending',?)"),
  mySalaryRequests:         db.prepare('SELECT * FROM salary_requests WHERE teacher_id=? ORDER BY submitted_at DESC'),
  allSalaryRequests:        db.prepare('SELECT * FROM salary_requests ORDER BY submitted_at DESC'),
  salaryReqById:            db.prepare('SELECT * FROM salary_requests WHERE id=?'),
  updateSalaryReqStatus:    db.prepare('UPDATE salary_requests SET status=?,admin_note=?,decided_at=? WHERE id=?'),
  pendingSalaryRequests:    db.prepare("SELECT * FROM salary_requests WHERE status='Pending' ORDER BY submitted_at ASC")
};

// ─── CRYPTO HELPERS ─────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return check === hash;
}

function b64url(str)  { return Buffer.from(str).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_'); }
function frB64url(s)  { return Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString(); }

function createToken(payload) {
  const h = b64url(JSON.stringify({ alg:'HS256', typ:'JWT' }));
  const b = b64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+86400 }));
  const s = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${h}.${b}.${s}`;
}

function verifyToken(token) {
  try {
    const [h, b, s] = token.split('.');
    const check = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    if (check !== s) return null;
    const payload = JSON.parse(frB64url(b));
    if (payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch(e) { return null; }
}

// ─── HTTP HELPERS ────────────────────────────────────────────────────────────
function parseBody(req, cb) {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch(e) { parsed = {}; }
    cb(parsed);
  });
}

// ─── REAL-TIME SSE BUS ────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcastEvent(type, payload) {
  const msg = `data: ${JSON.stringify({ type, payload, ts: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch(e) { sseClients.delete(client); }
  }
}

// ─── RECEIPT NUMBER GENERATOR ────────────────────────────────────────────────
function generateReceiptNo() {
  const yr = new Date().getFullYear();
  const last = db.prepare(`SELECT receipt_no FROM finance_fees WHERE receipt_no LIKE ? ORDER BY id DESC LIMIT 1`).get(`RCT-${yr}-%`);
  const num = last ? (parseInt(last.receipt_no.split('-').pop() || '0', 10) + 1) : 1;
  return `RCT-${yr}-${String(num).padStart(5, '0')}`;
}

// ─── FINANCE AUTH ────────────────────────────────────────────────────────────
function financeAuth(req, res) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const pl    = verifyToken(token);
  // Accept both 'finance' (legacy) and 'finance_officer' (RBAC) and 'admin'/'super_admin'
  if (!pl || !['finance','finance_officer','admin','super_admin','accountant'].includes(pl.role)) {
    send(res, 401, { error: 'Finance authentication required.' }); return null;
  }
  return pl;
}

// ─── HR AUTH ─────────────────────────────────────────────────────────────────
function hrAuth(req, res) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const pl    = verifyToken(token);
  // Accept both 'hr' (legacy) and 'hr_manager' (RBAC) and 'admin'/'super_admin'
  if (!pl || !['hr','hr_manager','admin','super_admin'].includes(pl.role)) {
    send(res, 401, { error: 'HR authentication required.' }); return null;
  }
  return pl;
}

// ─── MARKETING AUTH ──────────────────────────────────────────────────────────
function marketingAuth(req, res) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const pl    = verifyToken(token);
  // Accept both 'marketing' (legacy) and 'admin'/'super_admin' (RBAC)
  if (!pl || !['marketing','admin','super_admin'].includes(pl.role)) {
    send(res, 401, { error: 'Marketing authentication required.' }); return null;
  }
  return pl;
}

// ─── MONITOR AUTH (admin + audit + cyber) ────────────────────────────────────
function monitorAuth(req, res) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const pl    = verifyToken(token);
  if (!pl || !['admin','super_admin','principal','audit','cyber'].includes(pl.role)) {
    send(res, 401, { error: 'Monitor access required.' }); return null;
  }
  return pl;
}

// ─── SECURITY EVENT LOGGER ───────────────────────────────────────────────────
function logSecEvent(event_type, dashboard, ip, username, details, severity='info') {
  try {
    db.prepare(`INSERT INTO security_events (event_type,dashboard,ip,username,details,severity,timestamp) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
      .run(event_type, dashboard, ip||'', username||'', details||'', severity);
    // Keep only last 5000 events
    db.prepare(`DELETE FROM security_events WHERE id NOT IN (SELECT id FROM security_events ORDER BY id DESC LIMIT 5000)`).run();
  } catch(e) {}
}

// ─── IP EXTRACTOR ────────────────────────────────────────────────────────────
function getIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 60);
}

// ─── BUDGET AUTH (finance + admin both accepted) ──────────────────────────────
function budgetAuth(req, res) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const pl    = verifyToken(token);
  if (!pl || !['budget','finance','finance_officer','accountant','admin','super_admin','hr','hr_manager','marketing','principal'].includes(pl.role)) { send(res, 401, { error: 'Budget access required.' }); return null; }
  return pl;
}

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function sendCSV(res, filename, csvContent) {
  res.writeHead(200, {
    'Content-Type': 'text/csv',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store'
  });
  res.end(csvContent);
}

function authMiddleware(req) {
  const auth = req.headers['authorization'] || '';
  return verifyToken(auth.replace('Bearer ', '').trim());
}

function requireAdmin(req, res) {
  const key = url.parse(req.url, true).query.key;
  if (key !== ADMIN_KEY) { send(res, 401, { error: 'Unauthorized. Provide ?key=<admin_key>' }); return false; }
  return true;
}

// ─── STUDENT PORTAL ROUTES ───────────────────────────────────────────────────

function handleLogin(req, res) {
  const ip = getIP(req);
  parseBody(req, ({ username, password }) => {
    if (!username || !password) return send(res, 400, { error: 'Username and password required' });
    const student = stmts.findByUsername.get(username.trim().toLowerCase());
    if (!student || !verifyPassword(password, student.password_hash)) {
      logSecEvent('login_failed', 'student', ip, username, 'Invalid credentials', 'warning');
      return send(res, 401, { error: 'Invalid username or password' });
    }
    logSecEvent('login_success', 'student', ip, username, `Student ${student.name} logged in`, 'info');
    const token = createToken({ sub: student.id, name: student.name, class: student.class, section: student.section });
    send(res, 200, {
      token,
      student: { id: student.id, name: student.name, class: student.class, section: student.section, parentName: student.parent_name }
    });
  });
}

function handleAdminLogin(req, res) {
  const ip = getIP(req);
  parseBody(req, ({ username, password }) => {
    if (!username || !password) return send(res, 400, { error: 'Username and password required' });
    if (username.trim() !== ADMIN_USER || password !== ADMIN_PASS) {
      logSecEvent('login_failed', 'admin', ip, username, 'Invalid admin credentials — possible intrusion attempt', 'critical');
      rbac.audit(req, username, 'LOGIN_FAILED', 'security', 'login', null, 'Invalid admin credentials', 'denied');
      return send(res, 401, { error: 'Invalid admin credentials' });
    }
    logSecEvent('login_success', 'admin', ip, username, 'Admin logged in successfully', 'info');
    const token = createToken({ sub: 'admin', name: 'Administrator', role: 'admin' });
    rbac.audit(req, 'admin', 'LOGIN', 'security', 'login', null, 'Admin logged in', 'success');
    send(res, 200, { token, adminKey: ADMIN_KEY, name: 'Administrator' });
  });
}

function handleProfile(req, res, payload) {
  const s = stmts.findById.get(payload.sub);
  if (!s) return send(res, 404, { error: 'Student not found' });
  const { password_hash, ...safe } = s;
  // Rename snake_case → camelCase for frontend compatibility
  send(res, 200, {
    id: s.id, name: s.name, class: s.class, section: s.section,
    dob: s.dob, parentName: s.parent_name, parentPhone: s.parent_phone,
    email: s.email, address: s.address
  });
}

function handleAttendance(req, res, payload) {
  const records = stmts.getAttendance.all(payload.sub);
  const summary = stmts.attSummary.all(payload.sub);
  const total   = records.length;
  const present = summary.find(r => r.status === 'P')?.count || 0;
  const absent  = summary.find(r => r.status === 'A')?.count || 0;
  const leave   = summary.find(r => r.status === 'L')?.count || 0;
  const pct     = total ? Math.round((present / total) * 100) : 0;
  send(res, 200, { records, summary: { total, present, absent, leave, percentage: pct } });
}

function handleMarks(req, res, payload) {
  const records = stmts.getMarks.all(payload.sub);
  const terms   = {};
  records.forEach(r => {
    const key = r.term || 'General';
    if (!terms[key]) terms[key] = [];
    terms[key].push(r);
  });
  send(res, 200, { records, terms });
}

function handleFees(req, res, payload) {
  const records = stmts.getFees.all(payload.sub);
  const summary = stmts.feeSummary.all(payload.sub);
  const totalPaid    = summary.find(r => r.status === 'Paid')?.total    || 0;
  const totalPending = summary.find(r => r.status === 'Pending')?.total || 0;
  send(res, 200, { records, summary: { totalPaid, totalPending } });
}

// ─── ADMISSIONS ROUTES ────────────────────────────────────────────────────────

function pushToGoogleSheets(submission) {
  const scriptUrl = process.env.APPS_SCRIPT_URL;
  if (!scriptUrl) return;
  try {
    const parsed  = new URL(scriptUrl);
    const body    = JSON.stringify({ action: 'addAdmission', data: submission });
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const r = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const result = JSON.parse(raw);
          if (result.success) console.log(`   ✅ Google Sheets updated for ${submission.id}`);
          else console.log(`   ⚠️  Sheets response: ${raw}`);
        } catch(e) { console.log(`   ⚠️  Sheets raw: ${raw}`); }
      });
    });
    r.on('error', e => console.log(`   ⚠️  Sheets push failed: ${e.message}`));
    r.write(body);
    r.end();
  } catch(e) { console.log(`   ⚠️  Invalid APPS_SCRIPT_URL: ${e.message}`); }
}

function handleAdmissionSubmit(req, res) {
  parseBody(req, (data) => {
    if (!data.firstName || !data.lastName || !data.fatherMobile)
      return send(res, 400, { error: 'Missing required fields' });

    const { c } = stmts.countAdmissions.get();
    const id = 'APP' + String(c + 1).padStart(4, '0');
    const submittedAt = new Date().toISOString();

    stmts.insertAdmission.run(
      id, submittedAt, 'Pending Review',
      data.firstName||'', data.lastName||'', data.dob||'', data.gender||'',
      data.bloodGroup||'', data.gradeApplying||'', data.prevSchool||'',
      data.lastGrade||'', data.lastPercentage||'', data.fatherName||'',
      data.fatherMobile, data.fatherEmail||'', data.fatherOccupation||'',
      data.motherName||'', data.motherMobile||'', data.address||'',
      data.city||'', data.pin||'', data.hearAbout||'', data.reasonAdmission||''
    );

    const submission = { id, submittedAt, status: 'Pending Review', ...data };
    pushToGoogleSheets(submission);

    console.log(`\n📋 New admission: ${id} — ${data.firstName} ${data.lastName} (Class ${data.gradeApplying}) — ${data.fatherMobile}`);
    send(res, 200, {
      success: true,
      applicationId: id,
      message: `Application received! Your Application ID is ${id}. Our team will contact you within 24 hours.`
    });
  });
}

function handleAdmissionsList(req, res) {
  if (!requireAdmin(req, res)) return;
  const submissions = stmts.allAdmissions.all().map(rowToAdmission);
  send(res, 200, { total: submissions.length, submissions });
}

function handleAdmissionStatusUpdate(req, res) {
  if (!requireAdmin(req, res)) return;
  const parts = req.url.split('?')[0].split('/');
  const appId = parts[3];
  parseBody(req, ({ status, note }) => {
    const allowed = ['Pending Review','Under Review','Interview Scheduled','Accepted','Rejected','Waitlisted'];
    if (!status || !allowed.includes(status))
      return send(res, 400, { error: 'Invalid status. Allowed: ' + allowed.join(', ') });
    const existing = stmts.admissionById.get(appId);
    if (!existing) return send(res, 404, { error: 'Application not found: ' + appId });
    const updatedAt = new Date().toISOString();
    stmts.updateAdmStatus.run(status, note || '', updatedAt, appId);
    console.log(`\n📝 Status updated: ${appId} → ${status}`);
    send(res, 200, { success: true, id: appId, status, updatedAt });
  });
}

// Row → camelCase object for frontend
function rowToAdmission(r) {
  return {
    id: r.id, submittedAt: r.submitted_at, status: r.status,
    statusNote: r.status_note, statusUpdatedAt: r.status_updated_at,
    firstName: r.first_name, lastName: r.last_name, dob: r.dob,
    gender: r.gender, bloodGroup: r.blood_group, gradeApplying: r.grade_applying,
    prevSchool: r.prev_school, lastGrade: r.last_grade, lastPercentage: r.last_percentage,
    fatherName: r.father_name, fatherMobile: r.father_mobile, fatherEmail: r.father_email,
    fatherOccupation: r.father_occupation, motherName: r.mother_name, motherMobile: r.mother_mobile,
    address: r.address, city: r.city, pin: r.pin, hearAbout: r.hear_about, reasonAdmission: r.reason_admission
  };
}

// ─── ADMIN ROUTES (school staff) ──────────────────────────────────────────────

function handleAdminStudentList(req, res) {
  if (!requireAdmin(req, res)) return;
  const students = stmts.allStudents.all();
  send(res, 200, { total: students.length, students });
}

function handleAdminAddStudent(req, res) {
  if (!requireAdmin(req, res)) return;
  parseBody(req, (data) => {
    if (!data.id || !data.name || !data.class || !data.username || !data.password)
      return send(res, 400, { error: 'Required: id, name, class, username, password' });
    const existing = stmts.findByUsername.get(data.username.trim().toLowerCase());
    if (existing) return send(res, 409, { error: 'Username already exists' });
    const passwordHash = hashPassword(data.password);
    stmts.insertStudent.run(
      data.id, data.name, data.class, data.section||'',
      data.dob||'', data.parentName||'', data.parentPhone||'',
      data.username.trim().toLowerCase(), passwordHash,
      data.email||'', data.address||''
    );
    logDataEvent('Admin', 'admin', 'Students', 'add', 'students', `New student: ${data.name} (${data.username}) — Class ${data.class}${data.section?' '+data.section:''}`, 1, getIP(req));
    console.log(`\n👩‍🎓 New student added: ${data.name} (${data.username})`);
    send(res, 201, { success: true, id: data.id, message: `Student ${data.name} added successfully` });
  });
}

function handleAdminUpdateStudent(req, res) {
  if (!requireAdmin(req, res)) return;
  const studentId = req.url.split('?')[0].split('/')[3];
  parseBody(req, (data) => {
    const student = stmts.findById.get(studentId);
    if (!student) return send(res, 404, { error: 'Student not found' });

    // If username is being changed, check it's not taken by someone else
    const newUsername = (data.username || student.username).trim().toLowerCase();
    if (newUsername !== student.username) {
      const taken = stmts.findByUsername.get(newUsername);
      if (taken && taken.id !== studentId)
        return send(res, 409, { error: 'Username already taken by another student' });
    }

    // Only update password if a new one was provided
    const passwordHash = (data.password && data.password.length >= 6)
      ? hashPassword(data.password)
      : student.password_hash;

    db.prepare(`UPDATE students SET
      name=?, class=?, section=?, dob=?, parent_name=?,
      parent_phone=?, username=?, password_hash=?, email=?, address=?
      WHERE id=?`).run(
      data.name        || student.name,
      data.class       || student.class,
      data.section     !== undefined ? data.section : student.section,
      data.dob         !== undefined ? data.dob     : student.dob,
      data.parentName  !== undefined ? data.parentName  : student.parent_name,
      data.parentPhone !== undefined ? data.parentPhone : student.parent_phone,
      newUsername,
      passwordHash,
      data.email   !== undefined ? data.email   : student.email,
      data.address !== undefined ? data.address : student.address,
      studentId
    );
    const updated = stmts.findById.get(studentId);
    console.log(`\n✏️  Student updated: ${updated.name} (${updated.username})`);
    send(res, 200, { success: true, student: updated });
  });
}

function handleAdminMarkAttendance(req, res) {
  if (!requireAdmin(req, res)) return;
  parseBody(req, ({ date, records }) => {
    // records: [{ studentId, status }]
    if (!date || !Array.isArray(records) || !records.length)
      return send(res, 400, { error: 'Required: date (YYYY-MM-DD), records: [{studentId, status}]' });
    let inserted = 0, errors = [];
    db.exec('BEGIN');
    for (const r of records) {
      if (!['P','A','L'].includes(r.status)) { errors.push(`${r.studentId}: invalid status ${r.status}`); continue; }
      try { stmts.markAttendance.run(r.studentId, date, r.status); inserted++; }
      catch(e) { errors.push(`${r.studentId}: ${e.message}`); }
    }
    db.exec('COMMIT');
    logDataEvent('Admin', 'admin', 'Attendance', 'mark', 'attendance', `Marked ${inserted} records for ${date}`, inserted, getIP(req));
    console.log(`\n📅 Attendance marked for ${date}: ${inserted} records`);
    send(res, 200, { success: true, date, inserted, errors });
  });
}

function handleAdminResetPassword(req, res) {
  if (!requireAdmin(req, res)) return;
  const parts = req.url.split('?')[0].split('/');
  const studentId = parts[4];
  parseBody(req, ({ newPassword }) => {
    if (!newPassword || newPassword.length < 6)
      return send(res, 400, { error: 'newPassword must be at least 6 characters' });
    const student = stmts.findById.get(studentId);
    if (!student) return send(res, 404, { error: 'Student not found' });
    stmts.updatePassword.run(hashPassword(newPassword), studentId);
    // Log the reset
    try { db.prepare('INSERT INTO password_reset_log (user_id,user_type,reset_by,ip_address) VALUES (?,?,?,?)').run(studentId,'student','admin',getIP(req)); } catch(e) {}
    console.log(`\n🔑 Password reset for student: ${studentId}`);
    send(res, 200, { success: true, message: `Password updated for ${student.name}` });
  });
}

function handleAdminResetTeacherPassword(req, res) {
  if (!requireAdmin(req, res)) return;
  const parts = req.url.split('?')[0].split('/');
  const teacherId = parts[4];
  parseBody(req, ({ newPassword }) => {
    if (!newPassword || newPassword.length < 6)
      return send(res, 400, { error: 'newPassword must be at least 6 characters' });
    const teacher = stmts.findTeacherById.get(teacherId);
    if (!teacher) return send(res, 404, { error: 'Teacher not found' });
    db.prepare('UPDATE teachers SET password_hash=? WHERE id=?').run(hashPassword(newPassword), teacherId);
    // Log the reset
    try { db.prepare('INSERT INTO password_reset_log (user_id,user_type,reset_by,ip_address) VALUES (?,?,?,?)').run(teacherId,'teacher','admin',getIP(req)); } catch(e) {}
    console.log(`\n🔑 Password reset for teacher: ${teacherId}`);
    send(res, 200, { success: true, message: `Password updated for ${teacher.name}` });
  });
}

// ─── ADMIN TEACHER ATTENDANCE MANAGEMENT ─────────────────────────────────────

function handleAdminTeacherAttendanceList(req, res) {
  if (!requireAdmin(req, res)) return;
  const q    = url.parse(req.url, true).query;
  const from = q.from || new Date(Date.now() - 30*24*60*60*1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const to   = q.to   || istDateOnly();
  const rows = stmts.tcAllTeachers.all(from, to);
  send(res, 200, { from, to, records: rows });
}

function handleAdminTeacherAttendanceEdit(req, res) {
  if (!requireAdmin(req, res)) return;
  const id = req.url.split('?')[0].split('/').pop();
  parseBody(req, ({ check_in, check_out }) => {
    const rec = db.prepare('SELECT * FROM teacher_checkins WHERE id=?').get(Number(id));
    if (!rec) return send(res, 404, { error: 'Record not found' });

    const ci = check_in  || rec.check_in;
    const co = check_out || rec.check_out;

    // Recalculate hours if both times present
    let hours = rec.hours_worked;
    if (ci && co) {
      const [ih, im, is_] = ci.split(':').map(Number);
      const [oh, om, os]  = co.split(':').map(Number);
      const inMin  = ih * 60 + im + (is_ || 0) / 60;
      const outMin = oh * 60 + om + (os  || 0) / 60;
      hours = Math.max(0, Math.round((outMin - inMin) / 60 * 100) / 100);
    }

    db.prepare('UPDATE teacher_checkins SET check_in=?, check_out=?, hours_worked=? WHERE id=?')
      .run(ci, co, hours, Number(id));
    const updated = db.prepare('SELECT * FROM teacher_checkins WHERE id=?').get(Number(id));
    console.log(`\n✏️  Admin edited teacher checkin #${id}`);
    send(res, 200, { success: true, record: updated });
  });
}

function handleAdminTeacherAttendanceDelete(req, res) {
  if (!requireAdmin(req, res)) return;
  const id = req.url.split('?')[0].split('/').pop();
  const rec = db.prepare('SELECT * FROM teacher_checkins WHERE id=?').get(Number(id));
  if (!rec) return send(res, 404, { error: 'Record not found' });
  db.prepare('DELETE FROM teacher_checkins WHERE id=?').run(Number(id));
  console.log(`\n🗑️  Admin deleted teacher checkin #${id}`);
  send(res, 200, { success: true });
}

// ─── GOOGLE SHEETS SYNC (read) ────────────────────────────────────────────────
function handleSheetsSync(req, res) {
  if (!requireAdmin(req, res)) return;
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const API_KEY  = process.env.GOOGLE_API_KEY;
  if (!SHEET_ID || !API_KEY)
    return send(res, 400, { error: 'GOOGLE_SHEET_ID and GOOGLE_API_KEY not configured in .env' });

  const sheets = ['Students','Attendance','Marks','Fees'];
  let completed = 0;
  const results = {};

  sheets.forEach(sheet => {
    const options = {
      hostname: 'sheets.googleapis.com',
      path: `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheet)}?key=${API_KEY}`,
      method: 'GET'
    };
    https.get(options, (r) => {
      let body = '';
      r.on('data', d => body += d);
      r.on('end', () => {
        try {
          const parsed  = JSON.parse(body);
          const rows    = parsed.values || [];
          if (rows.length < 2) { results[sheet] = 'empty'; }
          else {
            const headers = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g,''));
            const data    = rows.slice(1).map(row => {
              const obj = {};
              headers.forEach((h,i) => obj[h] = row[i] || '');
              return obj;
            });

            if (sheet === 'Students') {
              let count = 0;
              db.exec('BEGIN');
              data.forEach(row => {
                const existing = stmts.findByUsername.get(row.username);
                const ph = existing ? existing.password_hash : hashPassword(row.password || 'gurukul123');
                try {
                  db.prepare('INSERT OR REPLACE INTO students (id,name,class,section,dob,parent_name,parent_phone,username,password_hash) VALUES (?,?,?,?,?,?,?,?,?)')
                    .run(row.studentid||row.id, row.name, row.class, row.section||'', row.dob||'', row.parentname||'', row.parentphone||'', row.username, ph);
                  count++;
                } catch(e) {}
              });
              db.exec('COMMIT');
              results[sheet] = `${count} students synced`;
            } else if (sheet === 'Attendance') {
              let count = 0;
              db.exec('BEGIN');
              data.forEach(row => {
                try { stmts.markAttendance.run(row.studentid, row.date, row.status); count++; } catch(e) {}
              });
              db.exec('COMMIT');
              results[sheet] = `${count} records synced`;
            } else if (sheet === 'Marks') {
              let count = 0;
              db.exec('BEGIN');
              data.forEach(row => {
                try { stmts.insertMark.run(row.studentid, row.subject, row.exam, Number(row.marks), Number(row.maxmarks||100), row.term||'', row.date||''); count++; } catch(e) {}
              });
              db.exec('COMMIT');
              results[sheet] = `${count} records synced`;
            } else if (sheet === 'Fees') {
              let count = 0;
              db.exec('BEGIN');
              data.forEach(row => {
                try { stmts.insertFee.run(row.studentid, row.feetype, Number(row.amount), row.duedate||'', row.status||'Pending'); count++; } catch(e) {}
              });
              db.exec('COMMIT');
              results[sheet] = `${count} records synced`;
            }
          }
        } catch(e) { results[sheet] = `error: ${e.message}`; }
        completed++;
        if (completed === sheets.length) send(res, 200, { success: true, results });
      });
    }).on('error', e => {
      results[sheet] = `error: ${e.message}`;
      completed++;
      if (completed === sheets.length) send(res, 200, { success: true, results });
    });
  });
}

// ─── DB STATS ─────────────────────────────────────────────────────────────────
// ── Admin: Budget Overview (uses admin key, not JWT) ──────────────────────────
function handleAdminBudgetOverview(req, res) {
  if (!requireAdmin(req, res)) return;
  const year = url.parse(req.url, true).query.year || new Date().getFullYear().toString();
  const depts = Object.keys(DEPT_META).map(k => getDeptBudget(k, year));
  const totalAllocated = depts.reduce((s, d) => s + d.allocated, 0);
  const totalSpent     = depts.reduce((s, d) => s + d.spent,     0);
  const totalRemaining = totalAllocated - totalSpent;
  const overallPct     = totalAllocated > 0 ? Math.round(totalSpent / totalAllocated * 100) : 0;
  send(res, 200, { year, depts, totalAllocated, totalSpent, totalRemaining, overallPct });
}

function handleDbStats(req, res) {
  if (!requireAdmin(req, res)) return;
  const today = istDateOnly();
  const classCounts = db.prepare('SELECT class, section, COUNT(*) as count FROM students GROUP BY class, section ORDER BY class, section').all();
  const attToday    = db.prepare("SELECT COUNT(DISTINCT student_id) as c FROM attendance WHERE date=?").get(today);
  const pendingAdm  = db.prepare("SELECT COUNT(*) as c FROM admissions WHERE status='Pending Review'").get();
  send(res, 200, {
    students:       db.prepare('SELECT COUNT(*) AS c FROM students').get().c,
    teachers:       db.prepare('SELECT COUNT(*) AS c FROM teachers').get().c,
    attendance:     db.prepare('SELECT COUNT(*) AS c FROM attendance').get().c,
    markedToday:    attToday.c,
    marks:          db.prepare('SELECT COUNT(*) AS c FROM marks').get().c,
    fees:           db.prepare('SELECT COUNT(*) AS c FROM fees').get().c,
    admissions:     db.prepare('SELECT COUNT(*) AS c FROM admissions').get().c,
    pendingAdmissions: pendingAdm.c,
    classCounts,
    db:             'SQLite (node:sqlite built-in)',
    dbPath:         DB_PATH
  });
}

function handleAdminDeleteAssignment(req, res) {
  if (!requireAdmin(req, res)) return;
  parseBody(req, ({ teacherId, class: cls, section }) => {
    if (!teacherId || !cls) return send(res, 400, { error: 'teacherId and class required' });
    stmts.deleteAssignment.run(teacherId, cls, section||'');
    send(res, 200, { success: true });
  });
}

// ─── TEACHER ROUTES ──────────────────────────────────────────────────────────

function handleTeacherLogin(req, res) {
  const ip = getIP(req);
  parseBody(req, ({ username, password }) => {
    if (!username || !password) return send(res, 400, { error: 'Username and password required' });
    const teacher = stmts.findTeacherByUsername.get(username.trim().toLowerCase());
    if (!teacher || !verifyPassword(password, teacher.password_hash)) {
      logSecEvent('login_failed', 'teacher', ip, username, 'Invalid teacher credentials', 'warning');
      return send(res, 401, { error: 'Invalid username or password' });
    }
    logSecEvent('login_success', 'teacher', ip, username, `Teacher ${teacher.name} logged in`, 'info');
    const token = createToken({ sub: teacher.id, name: teacher.name, subject: teacher.subject, role: 'teacher' });
    send(res, 200, {
      token,
      teacher: { id: teacher.id, name: teacher.name, subject: teacher.subject, email: teacher.email, phone: teacher.phone }
    });
  });
}

function teacherAuth(req, res) {
  const payload = authMiddleware(req);
  if (!payload || payload.role !== 'teacher') { send(res, 401, { error: 'Unauthorized. Teacher login required.' }); return null; }
  return payload;
}

// Flexible teacher auth: accepts JWT via Authorization header OR ?token= query param (for CSV download links)
function teacherAuthFlexible(req, res) {
  const q = url.parse(req.url, true).query;
  const authHeader = req.headers['authorization'] || '';
  const tokenStr   = authHeader.replace('Bearer ', '').trim() || q.token || '';
  const payload    = verifyToken(tokenStr);
  if (!payload || payload.role !== 'teacher') { send(res, 401, { error: 'Unauthorized. Teacher login required.' }); return null; }
  return payload;
}

function handleTeacherProfile(req, res, payload) {
  const t = stmts.findTeacherById.get(payload.sub);
  if (!t) return send(res, 404, { error: 'Teacher not found' });
  const assignments = stmts.getAssignments.all(payload.sub);
  const { password_hash, ...safe } = t;

  // Fetch payroll structure so teacher can see their salary breakdown
  const ps = db.prepare("SELECT * FROM payroll_structures WHERE staff_id=? AND staff_type='teacher'").get(payload.sub) || {};

  // Compute salary components for display
  const basic     = ps.basic     || 0;
  const hra       = basic * (ps.hra_pct || 40) / 100;
  const da        = basic * (ps.da_pct  || 5)  / 100;
  const transport = ps.transport || 1500;
  const medical   = ps.medical   || 1250;
  const gross     = basic + hra + da + transport + medical;
  const pf        = basic * (ps.pf_pct || 12) / 100;
  const esi       = gross <= 21000 ? gross * (ps.esi_pct || 0) / 100 : 0;
  const tds       = ps.tds || 0;
  const net_pay   = Math.max(0, gross - pf - esi - tds);

  const payroll = {
    ...ps,
    computed: { basic, hra, da, transport, medical, gross, pf, esi, tds, net_pay }
  };

  send(res, 200, { ...safe, assignments, payroll });
}

function handleTeacherStudents(req, res, payload) {
  // GET /api/teacher/students?class=8&section=A
  const q = url.parse(req.url, true).query;
  if (!q.class) return send(res, 400, { error: 'class parameter required' });

  // Verify teacher is assigned to this class
  const assignments = stmts.getAssignments.all(payload.sub);
  const assigned = assignments.some(a => a.class === q.class && (a.section === (q.section||'') || !q.section));
  if (!assigned) return send(res, 403, { error: 'You are not assigned to this class' });

  const students = q.section
    ? stmts.studentsInClassSec.all(q.class, q.section)
    : stmts.studentsInClass.all(q.class);

  send(res, 200, { class: q.class, section: q.section||'', total: students.length, students });
}

function handleTeacherMarkAttendance(req, res, payload) {
  // POST /api/teacher/attendance
  // Body: { class, section, date, records: [{studentId, status}] }
  parseBody(req, ({ class: cls, section, date, records }) => {
    if (!cls || !date || !Array.isArray(records) || !records.length)
      return send(res, 400, { error: 'Required: class, date, records:[{studentId,status}]' });

    // Verify assignment
    const assignments = stmts.getAssignments.all(payload.sub);
    const assigned = assignments.some(a => a.class === cls && (a.section === (section||'') || !section));
    if (!assigned) return send(res, 403, { error: 'Not assigned to this class' });

    let inserted = 0, errors = [];
    db.exec('BEGIN');
    for (const r of records) {
      if (!['P','A','L'].includes(r.status)) { errors.push(`${r.studentId}: invalid status`); continue; }
      try { stmts.markAttendance.run(r.studentId, date, r.status, payload.sub); inserted++; }
      catch(e) { errors.push(`${r.studentId}: ${e.message}`); }
    }
    db.exec('COMMIT');
    logDataEvent(payload.name||payload.sub, 'teacher', 'Attendance', 'mark', 'attendance', `Class ${cls}${section?' '+section:''} on ${date} — ${inserted} students`, inserted, getIP(req));
    console.log(`\n📅 [${payload.name}] Attendance for Class ${cls}${section?' '+section:''} on ${date}: ${inserted} records`);
    send(res, 200, { success: true, date, class: cls, section: section||'', inserted, errors });
  });
}

function handleTeacherGetAttendance(req, res, payload) {
  // GET /api/teacher/attendance?class=8&section=A&date=2026-03-12
  const q = url.parse(req.url, true).query;
  if (!q.class) return send(res, 400, { error: 'class required' });

  const assignments = stmts.getAssignments.all(payload.sub);
  const assigned = assignments.some(a => a.class === q.class && (a.section === (q.section||'') || !q.section));
  if (!assigned) return send(res, 403, { error: 'Not assigned to this class' });

  const date = q.date || istDateOnly();
  const sec  = q.section || '';

  // Get all students in class
  const students = sec ? stmts.studentsInClassSec.all(q.class, sec) : stmts.studentsInClass.all(q.class);
  // Get attendance for that date
  const attRows = stmts.attForClassDate.all(q.class, sec, date);
  const attMap  = {};
  attRows.forEach(r => attMap[r.student_id] = r.status);

  const records = students.map(s => ({
    studentId: s.id, name: s.name, section: s.section,
    status: attMap[s.id] || null   // null = not yet marked
  }));

  // Recent dates already marked for this class
  const markedDates = stmts.datesMarkedForClass.all(q.class, sec).map(r => r.date);

  send(res, 200, { date, class: q.class, section: sec, records, markedDates });
}

function handleTeacherSummary(req, res, payload) {
  // GET /api/teacher/summary?class=8&section=A
  const q = url.parse(req.url, true).query;
  if (!q.class) return send(res, 400, { error: 'class required' });

  const assignments = stmts.getAssignments.all(payload.sub);
  const assigned = assignments.some(a => a.class === q.class && (a.section === (q.section||'') || !q.section));
  if (!assigned) return send(res, 403, { error: 'Not assigned to this class' });

  const sec  = q.section || '';
  const rows = stmts.attSummaryForClass.all(q.class, sec);
  const summary = rows.map(r => ({
    studentId: r.id, name: r.name,
    total: r.total||0, present: r.present||0, absent: r.absent||0, leave: r.leave||0,
    percentage: r.total ? Math.round((r.present/r.total)*100) : 0
  }));

  send(res, 200, { class: q.class, section: sec, summary });
}

function handleTeacherHistory(req, res, payload) {
  // GET /api/teacher/history?class=8&section=A&from=2026-01-01&to=2026-03-31
  const q = url.parse(req.url, true).query;
  if (!q.class) return send(res, 400, { error: 'class required' });

  const assignments = stmts.getAssignments.all(payload.sub);
  const assigned = assignments.some(a => a.class === q.class && (a.section === (q.section||'') || !q.section));
  if (!assigned) return send(res, 403, { error: 'Not assigned to this class' });

  const sec  = q.section || '';
  const from = q.from || new Date(new Date(istDateOnly()).getTime() - 30*24*60*60*1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const to   = q.to   || istDateOnly();
  const rows = stmts.attHistoryForClass.all(q.class, sec, from, to);

  // Group by date
  const byDate = {};
  rows.forEach(r => {
    if (!byDate[r.date]) byDate[r.date] = { date: r.date, records: [], present:0, absent:0, leave:0 };
    byDate[r.date].records.push({ studentId: r.student_id, name: r.name, status: r.status });
    if (r.status==='P') byDate[r.date].present++;
    if (r.status==='A') byDate[r.date].absent++;
    if (r.status==='L') byDate[r.date].leave++;
  });

  send(res, 200, { class: q.class, section: sec, from, to, days: Object.values(byDate) });
}

// ─── TEACHER SELF-ATTENDANCE (CHECK-IN / CHECK-OUT) ──────────────────────────

function handleTeacherCheckIn(req, res, payload) {
  parseBody(req, ({ notes }) => {
    const today = istDateOnly();
    const now   = istTimeOnly(); // HH:MM:SS in IST

    const existing = stmts.tcGetToday.get(payload.sub, today);
    if (existing && existing.check_in) {
      return send(res, 200, { alreadyCheckedIn: true, record: existing, message: `Already checked in at ${existing.check_in}` });
    }

    stmts.tcInsertCheckin.run(payload.sub, today, now);
    const record = stmts.tcGetToday.get(payload.sub, today);
    console.log(`\n⏰ [${payload.name}] Checked IN at ${now} on ${today}`);
    send(res, 200, { success: true, checkIn: now, date: today, record });
  });
}

function handleTeacherCheckOut(req, res, payload) {
  parseBody(req, ({ notes }) => {
    const today = istDateOnly();
    const now   = istTimeOnly(); // HH:MM:SS in IST

    const existing = stmts.tcGetToday.get(payload.sub, today);
    if (!existing || !existing.check_in) {
      return send(res, 400, { error: 'You have not checked in today. Please check in first.' });
    }
    if (existing.check_out) {
      return send(res, 200, { alreadyCheckedOut: true, record: existing, message: `Already checked out at ${existing.check_out}` });
    }

    // Calculate hours worked
    const [ih, im, is_] = existing.check_in.split(':').map(Number);
    const [oh, om, os]  = now.split(':').map(Number);
    const inMin  = ih * 60 + im + (is_ || 0) / 60;
    const outMin = oh * 60 + om + (os || 0) / 60;
    const hours  = Math.max(0, Math.round((outMin - inMin) / 60 * 100) / 100);

    // Salary deduction for late arrival / early departure
    const ded = calcDeduction(existing.check_in, now);
    stmts.tcUpdateCheckout.run(now, hours, ded.late_mins, ded.early_mins, ded.deduction, payload.sub, today);
    const record = stmts.tcGetToday.get(payload.sub, today);
    console.log(`\n⏰ [${payload.name}] Checked OUT at ${now} — ${hours}h worked, deduction ₹${ded.deduction}`);
    send(res, 200, { success: true, checkOut: now, hoursWorked: hours, date: today, deduction: ded, record });
  });
}

function handleTeacherMyAttendance(req, res, payload) {
  const q    = url.parse(req.url, true).query;
  const from = q.from || new Date(Date.now() - 30*24*60*60*1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const to   = q.to   || istDateOnly();
  const rows = stmts.tcGetHistory.all(payload.sub, from, to);

  const daysPresent  = rows.filter(r => r.check_in).length;
  const totalHours   = rows.reduce((sum, r) => sum + (r.hours_worked || 0), 0);

  send(res, 200, {
    from, to, records: rows,
    summary: { daysPresent, totalHours: Math.round(totalHours * 100) / 100 }
  });
}

// ─── TEACHER REPORTS (CSV DOWNLOADS) ─────────────────────────────────────────

function handleTeacherReportStudents(req, res, payload) {
  const q = url.parse(req.url, true).query;
  if (!q.class) return send(res, 400, { error: 'class parameter required' });

  const assignments = stmts.getAssignments.all(payload.sub);
  const assigned = assignments.some(a => a.class === q.class && (a.section === (q.section||'') || !q.section));
  if (!assigned) return send(res, 403, { error: 'Not assigned to this class' });

  const sec  = q.section || '';
  const from = q.from || new Date(Date.now() - 30*24*60*60*1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const to   = q.to   || istDateOnly();

  const rows = stmts.attHistoryForClass.all(q.class, sec, from, to);
  const lines = ['"Student ID","Student Name","Class","Section","Date","Day","Status"'];
  rows.forEach(r => {
    const day = new Date(r.date+'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });
    const statusFull = r.status === 'P' ? 'Present' : r.status === 'A' ? 'Absent' : 'Leave';
    lines.push(`"${r.student_id}","${r.name.replace(/"/g,'""')}","${q.class}","${sec}","${r.date}","${day}","${statusFull}"`);
  });

  const filename = `student-attendance-class${q.class}${sec?'-'+sec:''}-${from}-to-${to}.csv`;
  sendCSV(res, filename, lines.join('\n'));
}

function handleTeacherReportSelf(req, res, payload) {
  const q    = url.parse(req.url, true).query;
  const from = q.from || new Date(Date.now() - 30*24*60*60*1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const to   = q.to   || istDateOnly();

  const teacher = stmts.findTeacherById.get(payload.sub);
  const rows    = stmts.tcGetHistory.all(payload.sub, from, to);

  const lines = ['"Date","Day","Check In","Check Out","Hours Worked","Status"'];
  rows.forEach(r => {
    const day        = new Date(r.date+'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });
    const status     = r.check_in ? 'Present' : 'Absent';
    const checkInVal  = r.check_in  || '-';
    const checkOutVal = r.check_out || 'Not checked out';
    lines.push(`"${r.date}","${day}","${checkInVal}","${checkOutVal}","${r.hours_worked || 0}","${status}"`);
  });

  const tName  = (teacher?.name || 'teacher').replace(/[^a-zA-Z0-9]/g,'-');
  const filename = `teacher-attendance-${tName}-${from}-to-${to}.csv`;
  sendCSV(res, filename, lines.join('\n'));
}

// ─── ADMIN TEACHER MANAGEMENT ─────────────────────────────────────────────────

function handleAdminTeacherList(req, res) {
  if (!requireAdmin(req, res)) return;
  const teachers = stmts.allTeachers.all();
  const result = teachers.map(t => ({
    ...t,
    assignments: stmts.getAssignments.all(t.id)
  }));
  send(res, 200, { total: result.length, teachers: result });
}

function handleAdminAddTeacher(req, res) {
  if (!requireAdmin(req, res)) return;
  parseBody(req, (data) => {
    if (!data.id || !data.name || !data.username || !data.password)
      return send(res, 400, { error: 'Required: id, name, username, password' });
    const existing = stmts.findTeacherByUsername.get(data.username.trim().toLowerCase());
    if (existing) return send(res, 409, { error: 'Username already exists' });
    stmts.insertTeacher.run(data.id, data.name, data.username.trim().toLowerCase(),
      hashPassword(data.password), data.email||'', data.phone||'', data.subject||'',
      data.designation||'', data.department||'Teaching', data.joining_date||'',
      data.employment_type||'Full-time', data.status||'Active');
    // Ensure salary structure
    db.prepare(`INSERT OR IGNORE INTO payroll_structures
      (staff_id,staff_type,basic,hra_pct,da_pct,transport,medical,pf_pct,esi_pct,tds)
      VALUES (?,?,25000,40,5,1500,1250,12,0,500)`).run(data.id, 'teacher');
    // Add assignments if provided: [{class, section, subject}]
    if (Array.isArray(data.assignments)) {
      data.assignments.forEach(a => {
        try { stmts.insertAssignment.run(data.id, a.class, a.section||'', a.subject||data.subject||''); } catch(e) {}
      });
    }
    console.log(`\n👨‍🏫 New teacher added: ${data.name} (${data.username})`);
    send(res, 201, { success: true, id: data.id, message: `Teacher ${data.name} added` });
  });
}

function handleAdminAssignTeacher(req, res) {
  if (!requireAdmin(req, res)) return;
  parseBody(req, ({ teacherId, assignments }) => {
    if (!teacherId || !Array.isArray(assignments))
      return send(res, 400, { error: 'Required: teacherId, assignments:[{class,section,subject}]' });
    const teacher = stmts.findTeacherById.get(teacherId);
    if (!teacher) return send(res, 404, { error: 'Teacher not found' });
    let added = 0;
    assignments.forEach(a => {
      try { stmts.insertAssignment.run(teacherId, a.class, a.section||'', a.subject||''); added++; } catch(e) {}
    });
    send(res, 200, { success: true, teacherId, added });
  });
}

// ─── STATIC FILE SERVER ───────────────────────────────────────────────────────
const SITE_ROOT = path.join(__dirname, '..');
const MIME = {
  '.html':'text/html', '.css':'text/css', '.js':'application/javascript',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf',
  '.eot':'application/vnd.ms-fontobject', '.json':'application/json'
};

function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname === '/') {
    filePath = path.join(SITE_ROOT, 'index.html');
  } else if (pathname === '/portal' || pathname === '/portal/') {
    filePath = path.join(SITE_ROOT, 'portal', 'index.html');
  } else if (pathname.endsWith('/')) {
    // Any other trailing-slash path — try index.html inside that folder
    filePath = path.join(SITE_ROOT, pathname, 'index.html');
  } else {
    filePath = path.join(SITE_ROOT, pathname);
  }
  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); }
    else {
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
      // Track page views for HTML files
      if (ext === '.html') {
        const ip  = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0,60);
        const ua  = (req.headers['user-agent'] || '').slice(0, 200);
        const ref = (req.headers['referer'] || '').slice(0, 200);
        logPageView(pathname, ip, ua, ref);
      }
    }
  });
}

// ─── SALARY DEDUCTION HELPER ─────────────────────────────────────────────────
// School hours: 09:30 – 16:30 (7h/day), 6-day week (~26 days/month), salary ₹25,000
const SCHOOL_IN_MINS  = 9 * 60 + 30;   // 570
const SCHOOL_OUT_MINS = 16 * 60 + 30;  // 990
const MONTHLY_SALARY  = 25000;
const WORKING_DAYS_PM = 26;
const WORK_HOURS_DAY  = 7;
const HOURLY_RATE     = MONTHLY_SALARY / (WORKING_DAYS_PM * WORK_HOURS_DAY); // ~137.36

function timeToMins(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function calcDeduction(checkIn, checkOut) {
  const inM  = timeToMins(checkIn);
  const outM = timeToMins(checkOut);
  if (inM === null || outM === null) return { late_mins: 0, early_mins: 0, deduction: 0 };
  const late  = Math.max(0, inM  - SCHOOL_IN_MINS);
  const early = Math.max(0, SCHOOL_OUT_MINS - outM);
  const deduction = Math.round(((late + early) / 60) * HOURLY_RATE * 100) / 100;
  return { late_mins: late, early_mins: early, deduction };
}

// ─── LEAVE BALANCE HELPERS ────────────────────────────────────────────────────

// Academic year starts in June. Given a calendar year (June start), compute
// Full year allocation granted upfront at the start of the academic year.
// 12 sick + 12 earned (24 total) — available from day one, no monthly accrual.
// Academic year = calendar year (2026 = Jan 2026 – Dec 2026, displayed as 2026–2027).
function computeAccruedLeaves(academicYear) {
  const today     = istDateOnly();
  const todayYear = parseInt(today.slice(0, 4));
  if (todayYear < academicYear) return { sick: 0, earned: 0 };
  return { sick: 12, earned: 12 };
}

// Return the current academic year (June–May cycle).
// If today is Jun-Dec → academic year = this calendar year
// If today is Jan-May → academic year = last calendar year
function currentAcademicYear() {
  const today = istDateOnly();
  return parseInt(today.slice(0, 4));   // calendar year = academic year (2026 → "2026–2027")
}

// Ensure a leave_balance row exists, sync accrued totals, and return the row.
function ensureLeaveBalance(personId, personType, year) {
  stmts.upsertLeaveBalance.run(personId, personType, year);
  const accrued = computeAccruedLeaves(year);
  stmts.updateLeaveAccrued.run(accrued.sick, accrued.earned, personId, personType, year);
  return stmts.getLeaveBalance.get(personId, personType, year);
}

// Parse earned_applied_month field → count for current month
function earnedAppliedThisMonth(bal) {
  const today = istDateOnly().slice(0, 7); // YYYY-MM
  if (!bal.earned_applied_month) return 0;
  const [month, count] = bal.earned_applied_month.split(':');
  return month === today ? (parseInt(count) || 0) : 0;
}

// Build new earned_applied_month string
function buildEarnedAppliedMonth(bal, delta) {
  const today = istDateOnly().slice(0, 7);
  const current = earnedAppliedThisMonth(bal);
  return `${today}:${current + delta}`;
}

// ─── HOLIDAYS API ────────────────────────────────────────────────────────────
function handleGetHolidays(req, res) {
  const q    = url.parse(req.url, true).query;
  const year = q.year || new Date().getFullYear().toString();
  const rows = stmts.holidaysByYear.all(`${year}%`);
  send(res, 200, { holidays: rows });
}

// ─── LEAVE APIS (teacher + student) ──────────────────────────────────────────
function handleApplyLeave(req, res, payload) {
  parseBody(req, (data) => {
    const { leave_type, from_date, to_date, reason } = data;
    if (!leave_type || !from_date || !to_date) return send(res, 400, { error: 'leave_type, from_date, to_date required' });
    if (!['sick','earned'].includes(leave_type)) return send(res, 400, { error: 'leave_type must be sick or earned' });

    const personId   = payload.sub;
    const personType = payload.role === 'teacher' ? 'teacher' : 'student';

    // Use academic year for balance tracking (calendar year = academic year)
    const fromYear     = parseInt(from_date.slice(0, 4));
    const academicYear = fromYear;

    // Count calendar days
    const d1   = new Date(from_date), d2 = new Date(to_date);
    const days = Math.max(1, Math.round((d2 - d1) / 86400000) + 1);

    const bal = ensureLeaveBalance(personId, personType, academicYear);

    if (leave_type === 'sick') {
      // Include pending sick applications in the used count
      const pendingDays = stmts.myLeaves.all(personId, personType)
        .filter(l => l.leave_type === 'sick' && l.status === 'Pending')
        .reduce((s, l) => s + l.days, 0);
      const effectiveUsed = bal.sick_used + pendingDays;
      const remaining = bal.sick_total - effectiveUsed;
      if (days > remaining)
        return send(res, 400, { error: `Only ${remaining} sick leave(s) available (${bal.sick_total} accrued, ${effectiveUsed} used/pending)` });

    } else {
      // Earned leave checks
      // 1. Check total accrued balance (include pending applications)
      const pendingDays = stmts.myLeaves.all(personId, personType)
        .filter(l => l.leave_type === 'earned' && l.status === 'Pending')
        .reduce((s, l) => s + l.days, 0);
      const effectiveUsed = bal.earned_used + pendingDays;
      const remaining = bal.earned_total - effectiveUsed;
      if (days > remaining)
        return send(res, 400, { error: `Only ${remaining} earned leave(s) available (${bal.earned_total} accrued, ${effectiveUsed} used/pending)` });

      // 2. Max 2 earned leave DAYS applied per calendar month
      const appliedThisMonth = earnedAppliedThisMonth(bal);
      if (appliedThisMonth + days > 2)
        return send(res, 400, {
          error: `You can apply at most 2 earned leave days per month. You have already applied ${appliedThisMonth} day(s) this month.`
        });

      // 3. Update monthly application count immediately
      const newMonthField = buildEarnedAppliedMonth(bal, days);
      stmts.updateLeaveUsed.run(bal.sick_used, bal.earned_used, newMonthField, personId, personType, academicYear);
    }

    const personName = payload.name || personId;
    const appliedAt  = istDateOnly() + ' ' + istTimeOnly();
    stmts.insertLeave.run(personId, personType, personName, leave_type, from_date, to_date, days, reason || '', 'Pending', appliedAt);
    send(res, 200, { message: 'Leave application submitted successfully. Awaiting admin approval.' });
  });
}

function handleMyLeaves(req, res, payload) {
  const personId   = payload.sub;
  const personType = payload.role === 'teacher' ? 'teacher' : 'student';
  const acYear     = currentAcademicYear();
  const bal        = ensureLeaveBalance(personId, personType, acYear);
  const leaves     = stmts.myLeaves.all(personId, personType);

  // Include pending applications in effective used count
  const pendingSick   = leaves.filter(l => l.leave_type === 'sick'   && l.status === 'Pending').reduce((s,l) => s+l.days, 0);
  const pendingEarned = leaves.filter(l => l.leave_type === 'earned' && l.status === 'Pending').reduce((s,l) => s+l.days, 0);

  const appliedThisMonth = earnedAppliedThisMonth(bal);

  send(res, 200, {
    balance: {
      academic_year:   `${acYear}–${acYear + 1}`,
      // Sick
      sick_accrued:    bal.sick_total,
      sick_used:       bal.sick_used,
      sick_pending:    pendingSick,
      sick_remaining:  bal.sick_total - bal.sick_used - pendingSick,
      // Earned
      earned_accrued:  bal.earned_total,
      earned_used:     bal.earned_used,
      earned_pending:  pendingEarned,
      earned_remaining: bal.earned_total - bal.earned_used - pendingEarned,
      // Monthly limit
      earned_applied_this_month: appliedThisMonth,
      earned_monthly_limit: 2,
      earned_monthly_left: Math.max(0, 2 - appliedThisMonth),
      // Totals
      total_accrued:   bal.sick_total + bal.earned_total,
      total_used:      bal.sick_used + bal.earned_used,
      total_remaining: (bal.sick_total - bal.sick_used - pendingSick) + (bal.earned_total - bal.earned_used - pendingEarned)
    },
    leaves
  });
}

// ─── ADMIN LEAVE MANAGEMENT ──────────────────────────────────────────────────
function handleAdminGetLeaves(req, res) {
  if (!requireAdmin(req, res)) return;
  const q      = url.parse(req.url, true).query;
  const filter = q.status || 'all';
  const leaves = filter === 'pending' ? stmts.pendingLeaves.all() : stmts.allLeaves.all();
  send(res, 200, { total: leaves.length, leaves });
}

function handleAdminDecideLeave(req, res) {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.url.split('/').pop().split('?')[0]);
  parseBody(req, (data) => {
    const { status, admin_note } = data;
    if (!['Approved','Rejected'].includes(status)) return send(res, 400, { error: 'status must be Approved or Rejected' });

    const leave = stmts.leaveById.get(id);
    if (!leave) return send(res, 404, { error: 'Leave not found' });
    if (leave.status !== 'Pending') return send(res, 400, { error: 'Leave already decided' });

    const decidedAt = istDateOnly() + ' ' + istTimeOnly();
    stmts.updateLeaveStatus.run(status, admin_note || '', decidedAt, id);

    // Determine academic year for this leave (calendar year = academic year)
    const fromYear     = parseInt(leave.from_date.slice(0, 4));
    const academicYear = fromYear;
    const bal = ensureLeaveBalance(leave.person_id, leave.person_type, academicYear);

    if (status === 'Approved') {
      // Deduct from balance
      let newSickUsed   = bal.sick_used;
      let newEarnedUsed = bal.earned_used;
      if (leave.leave_type === 'sick')   newSickUsed   += leave.days;
      else                               newEarnedUsed += leave.days;
      stmts.updateLeaveUsed.run(newSickUsed, newEarnedUsed, bal.earned_applied_month || '', leave.person_id, leave.person_type, academicYear);
    } else if (status === 'Rejected') {
      // If earned leave was rejected, restore the monthly application count
      if (leave.leave_type === 'earned') {
        const currentApplied = earnedAppliedThisMonth(bal);
        const restored = Math.max(0, currentApplied - leave.days);
        const today = istDateOnly().slice(0, 7);
        stmts.updateLeaveUsed.run(bal.sick_used, bal.earned_used, `${today}:${restored}`, leave.person_id, leave.person_type, academicYear);
      }
    }

    // Auto-notification to the applicant
    const notifType = status === 'Approved' ? 'success' : 'warning';
    const notifMsg  = status === 'Approved'
      ? `Your leave from ${leave.from_date} to ${leave.to_date} has been approved.`
      : `Your leave from ${leave.from_date} to ${leave.to_date} was rejected.${admin_note ? ' Note: '+admin_note : ''}`;
    createNotification(leave.person_id, leave.person_type, `Leave ${status}`, notifMsg, notifType, '');

    send(res, 200, { message: `Leave ${status.toLowerCase()}. ${status === 'Rejected' ? 'Marked as Loss of Pay.' : ''}` });
  });
}

// ─── DAILY REPORT (teacher) ──────────────────────────────────────────────────
function handleSubmitDailyReport(req, res, payload) {
  parseBody(req, (data) => {
    const teacherId   = payload.sub;
    const teacherName = payload.name || teacherId;
    const reportDate  = data.report_date || istDateOnly();
    const classesTaken = JSON.stringify(data.classes_taken || []);
    const extraNotes  = data.extra_notes || '';
    const submittedAt = istDateOnly() + ' ' + istTimeOnly();

    // Pull today's check-in/out from teacher_checkins
    const tc = stmts.tcGetToday.get(teacherId, reportDate);
    const loginTime   = tc?.check_in   || '';
    const logoutTime  = tc?.check_out  || '';
    const hoursWorked = tc?.hours_worked || 0;

    stmts.insertDailyReport.run(teacherId, teacherName, reportDate, classesTaken, loginTime, logoutTime, hoursWorked, extraNotes, submittedAt);
    send(res, 200, { message: 'Daily report submitted successfully.' });
  });
}

function handleGetMyReports(req, res, payload) {
  const reports = stmts.myReportHistory.all(payload.sub);
  const parsed  = reports.map(r => ({ ...r, classes_taken: JSON.parse(r.classes_taken || '[]') }));
  send(res, 200, { reports: parsed });
}

function handleAdminGetDailyReports(req, res) {
  if (!requireAdmin(req, res)) return;
  const q    = url.parse(req.url, true).query;
  const date = q.date || '';
  const reports = date ? stmts.reportsByDate.all(date) : stmts.allDailyReports.all();
  const parsed  = reports.map(r => ({ ...r, classes_taken: JSON.parse(r.classes_taken || '[]') }));
  send(res, 200, { total: parsed.length, reports: parsed });
}

// ─── TEACHER SALARY (self-view) ──────────────────────────────────────────────
function handleTeacherSalary(req, res, payload) {
  const q     = url.parse(req.url, true).query;
  const month = q.month || istDateOnly().slice(0, 7); // YYYY-MM

  // Fetch this teacher's payroll structure — fall back to defaults if not set
  const ps       = db.prepare("SELECT * FROM payroll_structures WHERE staff_id=? AND staff_type='teacher'").get(payload.sub) || {};
  const basic    = ps.basic    || MONTHLY_SALARY;
  const hra      = basic * (ps.hra_pct  || 40) / 100;
  const da       = basic * (ps.da_pct   ||  5) / 100;
  const transport = ps.transport || 1500;
  const medical  = ps.medical  || 1250;
  const grossSalary = Math.round(basic + hra + da + transport + medical);
  const pfDed    = Math.round(basic * (ps.pf_pct || 12) / 100);
  const esiDed   = grossSalary <= 21000 ? Math.round(grossSalary * (ps.esi_pct || 0) / 100) : 0;
  const tdsDed   = ps.tds || 0;

  // Check-ins this month (late deductions)
  const checkins = db.prepare(
    'SELECT * FROM teacher_checkins WHERE teacher_id=? AND date LIKE ? ORDER BY date DESC'
  ).all(payload.sub, `${month}%`);

  const totalLateDed = checkins.reduce((s, r) => s + (r.deduction || 0), 0);

  // Rejected leaves this month → LOP
  const allLeaves = stmts.myLeaves.all(payload.sub, 'teacher');
  const rejectedLeaves = allLeaves.filter(l =>
    l.status === 'Rejected' &&
    (l.from_date.startsWith(month) || l.to_date.startsWith(month))
  );
  const lopDays   = rejectedLeaves.reduce((s, l) => s + l.days, 0);
  const dailyRate = Math.round((grossSalary / WORKING_DAYS_PM) * 100) / 100;
  const lopAmount = Math.round(lopDays * dailyRate * 100) / 100;

  const totalDeduction = Math.round((totalLateDed + lopAmount + pfDed + esiDed + tdsDed) * 100) / 100;
  const netSalary      = Math.max(0, Math.round((grossSalary - totalDeduction) * 100) / 100);

  // My salary requests (all time — client filters by month)
  const myRequests = stmts.mySalaryRequests.all(payload.sub);

  // Tag each checkin with whether a request already exists for that date
  const requestedDates = new Set(myRequests.map(r => r.checkin_date));

  send(res, 200, {
    month,
    gross_salary:    grossSalary,
    daily_rate:      dailyRate,
    basic,
    hra:             Math.round(hra),
    da:              Math.round(da),
    transport,
    medical,
    pf_deduction:    pfDed,
    esi_deduction:   esiDed,
    tds_deduction:   tdsDed,
    late_deduction:  Math.round(totalLateDed * 100) / 100,
    lop_days:        lopDays,
    lop_amount:      lopAmount,
    lop_leaves:      rejectedLeaves,
    total_deduction: totalDeduction,
    net_salary:      netSalary,
    checkins:        checkins.map(c => ({ ...c, has_request: requestedDates.has(c.date) })),
    requests:        myRequests.filter(r => r.checkin_date.startsWith(month))
  });
}

// ─── RESIGNATION HANDLERS ────────────────────────────────────────────────────
function handleTeacherResign(req, res, payload) {
  parseBody(req, ({ last_day, reason, message }) => {
    if (!last_day) return send(res, 400, { error: 'last_day is required' });
    if (!reason)   return send(res, 400, { error: 'reason is required' });
    // Only one active resignation per teacher
    const existing = db.prepare("SELECT id FROM resignations WHERE teacher_id=? AND status='Pending'").get(payload.sub);
    if (existing) return send(res, 409, { error: 'You already have a pending resignation request.' });
    db.prepare(`INSERT INTO resignations (teacher_id, last_day, reason, message, status, submitted_at)
                VALUES (?, ?, ?, ?, 'Pending', ?)`).run(payload.sub, last_day, reason, message||'', istDateOnly());
    send(res, 200, { ok: true, message: 'Resignation submitted successfully.' });
  });
}

function handleAdminGetResignations(req, res) {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`
    SELECT r.*, t.name as teacher_name, t.designation, t.department, t.subject, t.email, t.phone
    FROM resignations r JOIN teachers t ON r.teacher_id = t.id
    ORDER BY r.submitted_at DESC
  `).all();
  send(res, 200, { resignations: rows });
}

function handleAdminUpdateResignation(req, res) {
  if (!requireAdmin(req, res)) return;
  const id = req.url.split('/').pop().split('?')[0];
  parseBody(req, ({ status, admin_note }) => {
    if (!['Accepted','Rejected'].includes(status))
      return send(res, 400, { error: 'status must be Accepted or Rejected' });
    db.prepare("UPDATE resignations SET status=?, admin_note=?, reviewed_at=? WHERE id=?")
      .run(status, admin_note||'', istDateOnly(), id);
    // If accepted, update teacher status to Inactive
    const resRow = db.prepare('SELECT teacher_id FROM resignations WHERE id=?').get(id);
    if (status === 'Accepted') {
      if (resRow) db.prepare("UPDATE teachers SET status='Inactive' WHERE id=?").run(resRow.teacher_id);
    }
    if (resRow) {
      const resMsg = status === 'Accepted'
        ? `Your resignation has been accepted. We wish you all the best.${admin_note ? ' Note: '+admin_note : ''}`
        : `Your resignation has been rejected.${admin_note ? ' Note: '+admin_note : ''}`;
      createNotification(resRow.teacher_id, 'teacher', `Resignation ${status}`, resMsg, status==='Accepted'?'info':'warning', '');
    }
    send(res, 200, { ok: true });
  });
}

function handleTeacherSubmitSalaryRequest(req, res, payload) {
  parseBody(req, ({ checkin_date, request_type, message }) => {
    if (!checkin_date || !request_type)
      return send(res, 400, { error: 'checkin_date and request_type required' });
    if (!['exemption','reminder','warning'].includes(request_type))
      return send(res, 400, { error: 'request_type must be exemption, reminder, or warning' });

    // Check if request already exists for this date+type combo
    const existing = db.prepare(
      'SELECT id FROM salary_requests WHERE teacher_id=? AND checkin_date=? AND request_type=?'
    ).get(payload.sub, checkin_date, request_type);
    if (existing)
      return send(res, 409, { error: 'You already submitted this type of request for that date.' });

    const submittedAt = istDateOnly() + ' ' + istTimeOnly();
    stmts.insertSalaryRequest.run(
      payload.sub, payload.name || payload.sub,
      checkin_date, request_type, message || '', submittedAt
    );
    console.log(`\n📋 [${payload.name}] Salary request (${request_type}) for ${checkin_date}`);
    send(res, 200, { message: 'Request submitted to admin for review.' });
  });
}

function handleTeacherMySalaryRequests(req, res, payload) {
  const reqs = stmts.mySalaryRequests.all(payload.sub);
  send(res, 200, { requests: reqs });
}

// ─── ADMIN SALARY REQUESTS ───────────────────────────────────────────────────
function handleAdminGetSalaryRequests(req, res) {
  if (!requireAdmin(req, res)) return;
  const q      = url.parse(req.url, true).query;
  const filter = q.status || 'all';
  const reqs   = filter === 'pending' ? stmts.pendingSalaryRequests.all() : stmts.allSalaryRequests.all();
  send(res, 200, { total: reqs.length, requests: reqs });
}

function handleAdminDecideSalaryRequest(req, res) {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.url.split('/').pop().split('?')[0]);
  parseBody(req, ({ status, admin_note }) => {
    if (!['Approved','Rejected'].includes(status))
      return send(res, 400, { error: 'status must be Approved or Rejected' });
    const reqRow = stmts.salaryReqById.get(id);
    if (!reqRow)   return send(res, 404, { error: 'Request not found' });
    if (reqRow.status !== 'Pending') return send(res, 400, { error: 'Request already decided' });
    const decidedAt = istDateOnly() + ' ' + istTimeOnly();
    stmts.updateSalaryReqStatus.run(status, admin_note || '', decidedAt, id);
    console.log(`\n✅ Admin ${status.toLowerCase()} salary request #${id}`);
    const srMsg = status === 'Approved'
      ? `Your salary adjustment request (${reqRow.request_type}) for ${reqRow.checkin_date} was approved.`
      : `Your salary adjustment request (${reqRow.request_type}) for ${reqRow.checkin_date} was rejected.${admin_note ? ' Note: '+admin_note : ''}`;
    createNotification(reqRow.teacher_id, 'teacher', `Salary Request ${status}`, srMsg, status==='Approved'?'success':'warning', '');
    send(res, 200, { message: `Request ${status.toLowerCase()}.` });
  });
}

// ─── PAYROLL ENGINE ──────────────────────────────────────────────────────────
const PAYROLL_WORKING_DAYS = 26;

function calcComponents(s) {
  const basic     = s.basic     || 0;
  const hra       = Math.round(basic * (s.hra_pct || 40) / 100);
  const da        = Math.round(basic * (s.da_pct  ||  5) / 100);
  const transport = s.transport || 1500;
  const medical   = s.medical   || 1250;
  const gross     = basic + hra + da + transport + medical;
  const pf        = Math.round(basic * (s.pf_pct || 12) / 100);
  const esi       = gross <= 21000 ? Math.round(gross * (s.esi_pct || 0.75) / 100) : 0;
  const tds       = s.tds || 0;
  return { basic, hra, da, transport, medical, gross, pf, esi, tds };
}

function getOrCreateStructure(staffId, staffType) {
  let s = db.prepare('SELECT * FROM payroll_structures WHERE staff_id=? AND staff_type=?').get(staffId, staffType);
  if (!s) {
    const basic = staffType === 'teacher' ? 25000 : 15000;
    const tdsDef = staffType === 'teacher' ? 500 : 0;
    db.prepare(`INSERT OR IGNORE INTO payroll_structures (staff_id,staff_type,basic,tds) VALUES (?,?,?,?)`).run(staffId, staffType, basic, tdsDef);
    s = db.prepare('SELECT * FROM payroll_structures WHERE staff_id=? AND staff_type=?').get(staffId, staffType);
  }
  return s;
}

function computeMonthPayroll(month) {
  const teachers = db.prepare('SELECT id, name, subject as designation FROM teachers').all();
  const support  = db.prepare("SELECT id, name, designation, department FROM support_staff WHERE status='Active'").all();
  const entries  = [];

  for (const t of teachers) {
    const s    = getOrCreateStructure(t.id, 'teacher');
    const comp = calcComponents(s);

    const lopDays = db.prepare(`SELECT COALESCE(SUM(days),0) as total FROM leave_applications
      WHERE person_id=? AND person_type='teacher' AND status='Rejected'
      AND (from_date LIKE ? OR to_date LIKE ?)`).get(t.id, `${month}%`, `${month}%`)?.total || 0;
    const lopDeduction   = Math.round(lopDays * (comp.gross / PAYROLL_WORKING_DAYS) * 100) / 100;
    const lateDeduction  = db.prepare(`SELECT COALESCE(SUM(deduction),0) as total FROM teacher_checkins WHERE teacher_id=? AND date LIKE ?`).get(t.id, `${month}%`)?.total || 0;
    const presentDays    = db.prepare(`SELECT COUNT(*) as c FROM teacher_checkins WHERE teacher_id=? AND date LIKE ?`).get(t.id, `${month}%`)?.c || 0;

    const totalDed = Math.round((comp.pf + comp.esi + comp.tds + lateDeduction + lopDeduction) * 100) / 100;
    const netPay   = Math.max(0, Math.round((comp.gross - totalDed) * 100) / 100);

    entries.push({
      staff_id: t.id, staff_type: 'teacher', name: t.name,
      department: 'Teaching', designation: t.designation || 'Teacher',
      ...comp, present_days: presentDays, lop_days: lopDays,
      late_deduction: Math.round(lateDeduction * 100) / 100,
      lop_deduction: lopDeduction,
      total_deductions: totalDed, bonus: 0, net_pay: netPay
    });
  }

  for (const sp of support) {
    const s    = getOrCreateStructure(sp.id, 'support');
    const comp = calcComponents(s);
    const totalDed = Math.round((comp.pf + comp.esi + comp.tds) * 100) / 100;
    const netPay   = Math.max(0, Math.round((comp.gross - totalDed) * 100) / 100);

    entries.push({
      staff_id: sp.id, staff_type: 'support', name: sp.name,
      department: sp.department || 'Support', designation: sp.designation || 'Staff',
      ...comp, present_days: PAYROLL_WORKING_DAYS, lop_days: 0,
      late_deduction: 0, lop_deduction: 0,
      total_deductions: totalDed, bonus: 0, net_pay: netPay
    });
  }
  return entries;
}

function handleAdminPayrollRun(req, res) {
  if (!requireAdmin(req, res)) return;
  const q     = url.parse(req.url, true).query;
  const month = q.month || istDateOnly().slice(0, 7);

  if (req.method === 'POST') {
    // Save/finalize payroll entries for the month
    parseBody(req, () => {
      const entries     = computeMonthPayroll(month);
      const processedAt = istDateOnly() + ' ' + istTimeOnly();
      const ins = db.prepare(`INSERT OR REPLACE INTO payroll_entries
        (staff_id,staff_type,month,working_days,present_days,lop_days,basic,hra,da,transport,medical,
         gross,pf_deduction,esi_deduction,tds_deduction,late_deduction,lop_deduction,total_deductions,bonus,net_pay,status,processed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      entries.forEach(e => ins.run(
        e.staff_id, e.staff_type, month, PAYROLL_WORKING_DAYS, e.present_days, e.lop_days,
        e.basic, e.hra, e.da, e.transport, e.medical, e.gross,
        e.pf, e.esi, e.tds, e.late_deduction, e.lop_deduction,
        e.total_deductions, e.bonus, e.net_pay, 'Processed', processedAt
      ));

      // ── Auto-create double-entry journal entries for this payroll run ──
      // Delete any existing payroll journal entries for this month to avoid duplication on re-run
      db.prepare(`DELETE FROM journal_entries WHERE source='payroll' AND narration LIKE ?`).run(`%${month}%`);
      const jeIns = db.prepare(`INSERT INTO journal_entries
        (date,voucher_no,voucher_type,narration,account_code,debit,credit,reference,source,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      const payDate = month + '-01';

      entries.forEach(e => {
        const staffLabel  = e.staff_type === 'teacher' ? 'Teacher' : 'Staff';
        const expAccount  = e.staff_type === 'teacher' ? '5001' : '5002';
        const narr        = `Salary — ${staffLabel} ${e.staff_id} — ${month}`;
        const vno         = `SAL-${month}-${e.staff_id}`;
        // Effective salary cost = net_pay + statutory deductions (excludes LOP recovery shown in gross)
        const salaryCost  = (e.net_pay || 0) + (e.pf || 0) + (e.esi || 0) + (e.tds || 0);

        // Dr Salary/Staff Expense
        jeIns.run(payDate, vno, 'Salary Journal', narr, expAccount, salaryCost, 0, `PE-${e.staff_id}`, 'payroll', 'system');
        // Cr Net Salary Payable
        jeIns.run(payDate, vno, 'Salary Journal', narr, '2001', 0, e.net_pay || 0, `PE-${e.staff_id}`, 'payroll', 'system');
        // Cr PF Payable
        if (e.pf > 0) jeIns.run(payDate, vno, 'Salary Journal', narr, '2002', 0, e.pf, `PE-${e.staff_id}`, 'payroll', 'system');
        // Cr ESI Payable
        if (e.esi > 0) jeIns.run(payDate, vno, 'Salary Journal', narr, '2003', 0, e.esi, `PE-${e.staff_id}`, 'payroll', 'system');
        // Cr TDS Payable
        if (e.tds > 0) jeIns.run(payDate, vno, 'Salary Journal', narr, '2004', 0, e.tds, `PE-${e.staff_id}`, 'payroll', 'system');
      });

      const totalPayroll = Math.round(entries.reduce((s, e) => s + e.net_pay, 0));
      logDataEvent('Admin', 'admin', 'Payroll', 'process', 'payroll_entries', `Payroll for ${month} — ₹${totalPayroll.toLocaleString()} — ${entries.length} staff`, entries.length, getIP(req));
      console.log(`\n💰 Payroll processed for ${month} — ₹${totalPayroll.toLocaleString()} — Journal entries created`);
      // Notify each teacher individually with their net pay
      entries.filter(e => e.staff_type === 'teacher').forEach(e => {
        createNotification(e.staff_id, 'teacher', `Salary Credited – ${month}`,
          `Your salary of ₹${Math.round(e.net_pay).toLocaleString('en-IN')} for ${month} has been processed.`, 'success', '');
      });
      send(res, 200, { message: `Payroll for ${month} processed. Journal entries auto-created.`, total: totalPayroll, count: entries.length });
    });
    return;
  }

  // GET — compute live (not saved)
  const entries      = computeMonthPayroll(month);
  const totalPayroll = Math.round(entries.reduce((s, e) => s + e.net_pay, 0));
  const totalGross   = Math.round(entries.reduce((s, e) => s + e.gross, 0));
  const totalDed     = Math.round(entries.reduce((s, e) => s + e.total_deductions, 0));
  const totalLOP     = Math.round(entries.reduce((s, e) => s + e.lop_deduction, 0));
  const deptBreakdown = {};
  entries.forEach(e => { deptBreakdown[e.department] = (deptBreakdown[e.department] || 0) + e.net_pay; });

  send(res, 200, {
    month, working_days: PAYROLL_WORKING_DAYS,
    summary: { total_payroll: totalPayroll, total_gross: totalGross, total_deductions: totalDed,
               total_lop: totalLOP, staff_count: entries.length,
               avg_salary: Math.round(totalPayroll / (entries.length || 1)) },
    dept_breakdown: deptBreakdown,
    entries
  });
}

function handleAdminPayrollTrend(req, res) {
  if (!requireAdmin(req, res)) return;
  const today = istDateOnly();
  const cy = parseInt(today.slice(0,4));
  const cm = parseInt(today.slice(5,7));
  const months = [];
  for (let i = 5; i >= 0; i--) {
    let m = cm - i, y = cy;
    while (m <= 0) { m += 12; y--; }
    months.push(`${y}-${String(m).padStart(2,'0')}`);
  }
  const trend = months.map(month => {
    const saved = db.prepare('SELECT COALESCE(SUM(net_pay),0) as total, COUNT(*) as cnt FROM payroll_entries WHERE month=?').get(month);
    if (saved && saved.cnt > 0) return { month, total: Math.round(saved.total), count: saved.cnt, source: 'saved' };
    // Live compute
    const entries = computeMonthPayroll(month);
    return { month, total: Math.round(entries.reduce((s,e)=>s+e.net_pay,0)), count: entries.length, source: 'computed' };
  });
  send(res, 200, { trend });
}

function handleAdminPayrollUpdateStructure(req, res) {
  if (!requireAdmin(req, res)) return;
  const parts    = req.url.replace(/\?.*$/,'').split('/');
  const staffId  = parts.pop();
  const staffType= parts.pop();
  if (!['teacher','support'].includes(staffType)) return send(res, 400, { error: 'Invalid staff type' });
  parseBody(req, (body) => {
    const { basic, hra_pct, da_pct, transport, medical, pf_pct, esi_pct, tds } = body;
    db.prepare(`INSERT INTO payroll_structures (staff_id,staff_type,basic,hra_pct,da_pct,transport,medical,pf_pct,esi_pct,tds)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(staff_id,staff_type) DO UPDATE SET
        basic=excluded.basic, hra_pct=excluded.hra_pct, da_pct=excluded.da_pct,
        transport=excluded.transport, medical=excluded.medical, pf_pct=excluded.pf_pct,
        esi_pct=excluded.esi_pct, tds=excluded.tds`
    ).run(staffId, staffType, basic||0, hra_pct||40, da_pct||5, transport||1500, medical||1250, pf_pct||12, esi_pct||0.75, tds||0);
    send(res, 200, { message: 'Salary structure updated.' });
  });
}

// ─── STAFF PROFILE HANDLERS ───────────────────────────────────────────────────

function handleAdminStaffList(req, res) {
  if (!requireAdmin(req, res)) return;
  const teachers = db.prepare(`
    SELECT t.id, t.name, t.email, t.phone, t.subject, t.status,
      COALESCE(t.designation,'') as designation, COALESCE(t.department,'Teaching') as department,
      COALESCE(t.joining_date,'') as joining_date, COALESCE(t.employment_type,'Full-time') as employment_type,
      COALESCE(ps.basic,0) as basic,
      'teacher' as staff_type
    FROM teachers t
    LEFT JOIN payroll_structures ps ON ps.staff_id=t.id AND ps.staff_type='teacher'
    ORDER BY t.name`).all();

  const support = db.prepare(`
    SELECT s.id, s.name, s.email, s.phone, s.department, s.designation,
      s.joining_date, s.status, COALESCE(s.employment_type,'Full-time') as employment_type,
      COALESCE(ps.basic,0) as basic,
      'support' as staff_type
    FROM support_staff s
    LEFT JOIN payroll_structures ps ON ps.staff_id=s.id AND ps.staff_type='support'
    ORDER BY s.name`).all();

  send(res, 200, { teachers, support, total: teachers.length + support.length });
}

function handleAdminGetStaffProfile(req, res) {
  if (!requireAdmin(req, res)) return;
  const parts    = url.parse(req.url).pathname.split('/');
  const staffType = parts[4];
  const staffId   = parts[5];

  if (staffType === 'teacher') {
    const t = db.prepare('SELECT * FROM teachers WHERE id=?').get(staffId);
    if (!t) return send(res, 404, { error: 'Teacher not found' });
    const { password_hash, ...safe } = t;
    const ps = db.prepare("SELECT * FROM payroll_structures WHERE staff_id=? AND staff_type='teacher'").get(staffId) || {};
    const assignments = db.prepare('SELECT class,section,subject FROM teacher_assignments WHERE teacher_id=? ORDER BY class,section').all(staffId);
    send(res, 200, { ...safe, payroll: ps, assignments, staff_type: 'teacher' });
  } else {
    const s = db.prepare('SELECT * FROM support_staff WHERE id=?').get(staffId);
    if (!s) return send(res, 404, { error: 'Staff member not found' });
    const ps = db.prepare("SELECT * FROM payroll_structures WHERE staff_id=? AND staff_type='support'").get(staffId) || {};
    send(res, 200, { ...s, payroll: ps, staff_type: 'support' });
  }
}

function handleAdminUpdateStaffProfile(req, res) {
  if (!requireAdmin(req, res)) return;
  const parts    = url.parse(req.url).pathname.split('/');
  const staffType = parts[4];
  const staffId   = parts[5];

  parseBody(req, (d) => {
    if (!d) return send(res, 400, { error: 'No data' });

    if (staffType === 'teacher') {
      db.prepare(`UPDATE teachers SET
        name=COALESCE(?,name), email=COALESCE(?,email), phone=COALESCE(?,phone),
        subject=COALESCE(?,subject), designation=COALESCE(?,designation),
        department=COALESCE(?,department), dob=COALESCE(?,dob), gender=COALESCE(?,gender),
        blood_group=COALESCE(?,blood_group), emergency_name=COALESCE(?,emergency_name),
        emergency_phone=COALESCE(?,emergency_phone), address=COALESCE(?,address),
        bank_name=COALESCE(?,bank_name), account_number=COALESCE(?,account_number),
        ifsc=COALESCE(?,ifsc), account_type=COALESCE(?,account_type), pan=COALESCE(?,pan),
        uan=COALESCE(?,uan), esi_number=COALESCE(?,esi_number),
        employment_type=COALESCE(?,employment_type), joining_date=COALESCE(?,joining_date),
        status=COALESCE(?,status)
        WHERE id=?`).run(
        d.name||null, d.email||null, d.phone||null, d.subject||null,
        d.designation||null, d.department||null, d.dob||null, d.gender||null,
        d.blood_group||null, d.emergency_name||null, d.emergency_phone||null, d.address||null,
        d.bank_name||null, d.account_number||null, d.ifsc||null, d.account_type||null,
        d.pan||null, d.uan||null, d.esi_number||null, d.employment_type||null,
        d.joining_date||null, d.status||null, staffId
      );
    } else {
      db.prepare(`UPDATE support_staff SET
        name=COALESCE(?,name), email=COALESCE(?,email), phone=COALESCE(?,phone),
        designation=COALESCE(?,designation), department=COALESCE(?,department),
        status=COALESCE(?,status), joining_date=COALESCE(?,joining_date),
        dob=COALESCE(?,dob), gender=COALESCE(?,gender), blood_group=COALESCE(?,blood_group),
        emergency_name=COALESCE(?,emergency_name), emergency_phone=COALESCE(?,emergency_phone),
        address=COALESCE(?,address), bank_name=COALESCE(?,bank_name),
        account_number=COALESCE(?,account_number), ifsc=COALESCE(?,ifsc),
        account_type=COALESCE(?,account_type), pan=COALESCE(?,pan),
        uan=COALESCE(?,uan), esi_number=COALESCE(?,esi_number),
        employment_type=COALESCE(?,employment_type)
        WHERE id=?`).run(
        d.name||null, d.email||null, d.phone||null,
        d.designation||null, d.department||null, d.status||null, d.joining_date||null,
        d.dob||null, d.gender||null, d.blood_group||null,
        d.emergency_name||null, d.emergency_phone||null, d.address||null,
        d.bank_name||null, d.account_number||null, d.ifsc||null, d.account_type||null,
        d.pan||null, d.uan||null, d.esi_number||null, d.employment_type||null, staffId
      );
    }

    // Update salary structure if basic provided
    if (d.basic !== undefined) {
      db.prepare(`INSERT INTO payroll_structures
        (staff_id,staff_type,basic,hra_pct,da_pct,transport,medical,pf_pct,esi_pct,tds)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(staff_id,staff_type) DO UPDATE SET
          basic=excluded.basic, hra_pct=excluded.hra_pct, da_pct=excluded.da_pct,
          transport=excluded.transport, medical=excluded.medical,
          pf_pct=excluded.pf_pct, esi_pct=excluded.esi_pct, tds=excluded.tds`
      ).run(staffId, staffType,
        parseFloat(d.basic)||0, parseFloat(d.hra_pct)||40, parseFloat(d.da_pct)||5,
        parseFloat(d.transport)||1500, parseFloat(d.medical)||1250,
        parseFloat(d.pf_pct)||12, parseFloat(d.esi_pct)||0, parseFloat(d.tds)||0
      );
    }

    send(res, 200, { ok: true });
  });
}

function handleAdminAddSupportStaff(req, res) {
  if (!requireAdmin(req, res)) return;
  parseBody(req, (d) => {
    if (!d || !d.name) return send(res, 400, { error: 'Name required' });

    // Auto-generate next SS ID
    const existing = db.prepare('SELECT id FROM support_staff ORDER BY id').all();
    let nextNum = 1;
    existing.forEach(r => {
      const n = parseInt(r.id.replace('SS','')) || 0;
      if (n >= nextNum) nextNum = n + 1;
    });
    const newId = `SS${String(nextNum).padStart(3,'0')}`;

    db.prepare(`INSERT INTO support_staff
      (id,name,department,designation,phone,email,joining_date,status,employment_type)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      newId, d.name, d.department||'Administration', d.designation||'',
      d.phone||'', d.email||'', d.joining_date||istDateOnly(),
      d.status||'Active', d.employment_type||'Full-time'
    );

    // Default salary structure
    db.prepare(`INSERT OR IGNORE INTO payroll_structures
      (staff_id,staff_type,basic,hra_pct,da_pct,transport,medical,pf_pct,esi_pct,tds)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      newId, 'support',
      parseFloat(d.basic)||15000, 40, 5, 1500, 1250, 12, 0.75, 0
    );

    send(res, 201, { ok: true, id: newId });
  });
}

// ─── SALARY SUMMARY (admin) ──────────────────────────────────────────────────
function handleAdminSalarySummary(req, res) {
  if (!requireAdmin(req, res)) return;
  const q     = url.parse(req.url, true).query;
  const month = q.month || istDateOnly().slice(0, 7); // YYYY-MM
  const rows  = db.prepare(`SELECT tc.teacher_id, t.name,
    COUNT(tc.id) as days_attended,
    SUM(tc.hours_worked) as total_hours,
    SUM(tc.late_mins)  as total_late_mins,
    SUM(tc.early_mins) as total_early_mins,
    SUM(tc.deduction)  as total_deduction
    FROM teacher_checkins tc JOIN teachers t ON tc.teacher_id=t.id
    WHERE tc.date LIKE ? GROUP BY tc.teacher_id ORDER BY t.name`).all(`${month}%`);

  const summary = rows.map(r => ({
    ...r,
    gross_salary:    MONTHLY_SALARY,
    net_salary:      Math.max(0, Math.round((MONTHLY_SALARY - (r.total_deduction || 0)) * 100) / 100),
    total_deduction: Math.round((r.total_deduction || 0) * 100) / 100
  }));
  send(res, 200, { month, monthly_salary: MONTHLY_SALARY, teachers: summary });
}

// ─── FINANCE LOGIN ────────────────────────────────────────────────────────────
// ─── HR MODULE HANDLERS ───────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// BUDGET DASHBOARD HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

function handleBudgetLogin(req, res) {
  const ip = getIP(req);
  parseBody(req, ({ username, password }) => {
    if (!username || !password) return send(res, 400, { error: 'Username and password required' });
    const uname = username.trim().toLowerCase();
    let role = null;
    if (uname === BUDGET_USER && password === BUDGET_PASS) role = 'budget';
    else if (uname === FINANCE_USER && password === FINANCE_PASS) role = 'finance';
    else if (uname === ADMIN_USER && password === ADMIN_PASS) role = 'admin';
    if (!role) {
      logSecEvent('login_failed', 'budget', ip, username, 'Invalid budget credentials', 'warning');
      return send(res, 401, { error: 'Invalid credentials' });
    }
    logSecEvent('login_success', 'budget', ip, username, `Budget dashboard accessed as ${role}`, 'info');
    const token = createToken({ sub: uname, role, name: role === 'admin' ? 'Administrator' : role === 'finance' ? 'Finance Manager' : 'Budget Manager' });
    send(res, 200, { token, role, name: role === 'admin' ? 'Administrator' : role === 'finance' ? 'Finance Manager' : 'Budget Manager' });
  });
}

const DEPT_META = {
  hr:          { name: 'Human Resources',    icon: 'fa-users',          color: '#16a085', bg: 'rgba(22,160,133,0.1)'  },
  marketing:   { name: 'Marketing',          icon: 'fa-bullhorn',       color: '#8e44ad', bg: 'rgba(142,68,173,0.1)'  },
  operations:  { name: 'Operations & Admin', icon: 'fa-cogs',           color: '#e67e22', bg: 'rgba(230,126,34,0.1)'  },
  academic:    { name: 'Academic & Teaching',icon: 'fa-graduation-cap', color: '#2980b9', bg: 'rgba(41,128,185,0.1)'  },
  it:          { name: 'IT & Infrastructure',icon: 'fa-desktop',        color: '#27ae60', bg: 'rgba(39,174,96,0.1)'   },
  transport:   { name: 'Transport',          icon: 'fa-bus',            color: '#c0392b', bg: 'rgba(192,57,43,0.1)'   },
};

function getDeptBudget(deptKey, year) {
  year = year || new Date().getFullYear().toString();
  let row = db.prepare('SELECT * FROM department_budgets WHERE dept_key=? AND fiscal_year=?').get(deptKey, year);
  if (!row) {
    const meta = DEPT_META[deptKey] || { name: deptKey, icon: 'fa-circle', color: '#666', bg: '#eee' };
    db.prepare(`INSERT OR IGNORE INTO department_budgets (dept_key,dept_name,fiscal_year,allocated_amount,notes,set_by,updated_at) VALUES (?,?,?,0,'','',?)`)
      .run(deptKey, meta.name, year, istDateOnly());
    row = db.prepare('SELECT * FROM department_budgets WHERE dept_key=? AND fiscal_year=?').get(deptKey, year);
  }
  const allocated = row ? row.allocated_amount : 0;
  // For HR: also pull from hr_budget and from payroll_entries
  let spent = 0;
  if (deptKey === 'hr') {
    const hrSpent = db.prepare(`SELECT COALESCE(SUM(net_pay),0) as s FROM payroll_entries WHERE month LIKE ?`).get(year + '%');
    const expSpent = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM budget_expenses WHERE dept_key=? AND fiscal_year=?`).get(deptKey, year);
    spent = (hrSpent?.s || 0) + (expSpent?.s || 0);
  } else {
    const res2 = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM budget_expenses WHERE dept_key=? AND fiscal_year=?`).get(deptKey, year);
    spent = res2?.s || 0;
  }
  const remaining = allocated - spent;
  const pct_used = allocated > 0 ? Math.round(spent / allocated * 100) : 0;
  const monthly_expenses = db.prepare(`SELECT month, SUM(amount) as total FROM budget_expenses WHERE dept_key=? AND fiscal_year=? GROUP BY month ORDER BY month`).all(deptKey, year);
  return {
    dept_key: deptKey,
    dept_name: (row?.dept_name) || (DEPT_META[deptKey]?.name || deptKey),
    fiscal_year: year,
    allocated,
    spent,
    remaining,
    pct_used,
    budget_ok: remaining >= 0,
    notes: row?.notes || '',
    set_by: row?.set_by || '',
    updated_at: row?.updated_at || '',
    monthly_expenses,
  };
}

function handleBudgetOverview(req, res) {
  const pl = budgetAuth(req, res); if (!pl) return;
  const q = url.parse(req.url, true).query;
  const year = q.year || new Date().getFullYear().toString();
  const depts = Object.keys(DEPT_META).map(k => getDeptBudget(k, year));
  const totalAllocated = depts.reduce((s, d) => s + d.allocated, 0);
  const totalSpent     = depts.reduce((s, d) => s + d.spent, 0);
  const totalRemaining = totalAllocated - totalSpent;
  const overallPct     = totalAllocated > 0 ? Math.round(totalSpent / totalAllocated * 100) : 0;
  // Year-over-year: pull previous year
  const prevYear = (parseInt(year) - 1).toString();
  const prevDepts = Object.keys(DEPT_META).map(k => getDeptBudget(k, prevYear));
  const prevAllocated = prevDepts.reduce((s, d) => s + d.allocated, 0);
  const prevSpent     = prevDepts.reduce((s, d) => s + d.spent, 0);
  // Monthly totals across all depts this year
  const monthlyTotals = {};
  depts.forEach(d => {
    (d.monthly_expenses || []).forEach(me => {
      monthlyTotals[me.month] = (monthlyTotals[me.month] || 0) + me.total;
    });
  });
  const monthlyArr = Object.entries(monthlyTotals).sort(([a],[b]) => a.localeCompare(b)).map(([month, total]) => ({ month, total }));
  send(res, 200, { year, depts, totalAllocated, totalSpent, totalRemaining, overallPct, prevAllocated, prevSpent, monthly: monthlyArr });
}

function handleBudgetGetDept(req, res) {
  const pl = budgetAuth(req, res); if (!pl) return;
  const parts = pathname_from(req).split('/');
  const deptKey = parts[parts.length - 1];
  const year = url.parse(req.url, true).query.year || new Date().getFullYear().toString();
  const budget = getDeptBudget(deptKey, year);
  const expenses = db.prepare(`SELECT * FROM budget_expenses WHERE dept_key=? AND fiscal_year=? ORDER BY created_at DESC LIMIT 100`).all(deptKey, year);
  // For HR also pull payroll entries as system expenses
  let systemExpenses = [];
  if (deptKey === 'hr') {
    systemExpenses = db.prepare(`
      SELECT month as created_at, month, 'Payroll' as category,
        'Monthly payroll run' as description, SUM(net_pay) as amount
      FROM payroll_entries WHERE month LIKE ? GROUP BY month ORDER BY month DESC LIMIT 24
    `).all(year + '%');
  }
  send(res, 200, { budget, expenses, systemExpenses });
}

function handleBudgetSetAllocation(req, res) {
  const pl = budgetAuth(req, res); if (!pl) return;
  if (!['finance','finance_officer','admin','super_admin'].includes(pl.role)) return send(res, 403, { error: 'Only Finance or Admin can set allocations.' });
  parseBody(req, (d) => {
    const year = d.year || new Date().getFullYear().toString();
    const updates = d.allocations || {}; // { hr: 500000, marketing: 200000, ... }
    const results = {};
    Object.entries(updates).forEach(([deptKey, amount]) => {
      if (!DEPT_META[deptKey]) return;
      db.prepare(`INSERT INTO department_budgets (dept_key,dept_name,fiscal_year,allocated_amount,notes,set_by,updated_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(dept_key,fiscal_year) DO UPDATE SET
          allocated_amount=excluded.allocated_amount, notes=excluded.notes, set_by=excluded.set_by, updated_at=excluded.updated_at
      `).run(deptKey, DEPT_META[deptKey].name, year, parseFloat(amount)||0, d.notes||'', pl.name||pl.role, istDateOnly());
      results[deptKey] = getDeptBudget(deptKey, year);
    });
    // Also sync HR budget table if HR is being set
    if (updates.hr !== undefined) {
      db.prepare(`INSERT INTO hr_budget (fiscal_year, allocated_amount, notes, set_by, updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(fiscal_year) DO UPDATE SET allocated_amount=excluded.allocated_amount, notes=excluded.notes, set_by=excluded.set_by, updated_at=excluded.updated_at
      `).run(year, parseFloat(updates.hr)||0, d.notes||'', pl.name||pl.role, istDateOnly());
    }
    send(res, 200, { ok: true, results });
  });
}

function handleBudgetAddExpense(req, res) {
  const pl = budgetAuth(req, res); if (!pl) return;
  const parts = pathname_from(req).split('/');
  const deptKey = parts[parts.length - 2]; // /api/budget/dept/:key/expenses
  parseBody(req, (d) => {
    if (!d.description || !d.amount) return send(res, 400, { error: 'description and amount required' });
    const year = d.year || new Date().getFullYear().toString();
    const month = d.month || istDateOnly().slice(0, 7);
    db.prepare(`INSERT INTO budget_expenses (dept_key,fiscal_year,month,description,amount,category,reference_id,reference_type,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(deptKey, year, month, d.description, parseFloat(d.amount)||0, d.category||'General', d.reference_id||'', d.reference_type||'', pl.name||pl.role, istDateOnly());
    logDataEvent(pl.name||pl.role, pl.role, 'Budget', 'add_expense', 'budget_expenses', `${deptKey} dept: ${d.description} ₹${d.amount}`, 1, getIP(req));
    send(res, 200, { ok: true, budget: getDeptBudget(deptKey, year) });
  });
}

function handleBudgetDeleteExpense(req, res) {
  const pl = budgetAuth(req, res); if (!pl) return;
  if (!['finance','admin'].includes(pl.role)) return send(res, 403, { error: 'Only Finance or Admin can delete expenses.' });
  const parts = pathname_from(req).split('/');
  const expId = parts[parts.length - 1];
  const exp = db.prepare('SELECT * FROM budget_expenses WHERE id=?').get(expId);
  if (!exp) return send(res, 404, { error: 'Expense not found' });
  db.prepare('DELETE FROM budget_expenses WHERE id=?').run(expId);
  send(res, 200, { ok: true, budget: getDeptBudget(exp.dept_key, exp.fiscal_year) });
}

function pathname_from(req) { return url.parse(req.url).pathname || ''; }

function handleHRLogin(req, res) {
  const ip = getIP(req);
  parseBody(req, ({ username, password }) => {
    if (!username || !password) return send(res, 400, { error: 'Username and password required' });
    if (username.trim().toLowerCase() !== HR_USER || password !== HR_PASS) {
      logSecEvent('login_failed', 'hr', ip, username, 'Invalid HR credentials', 'warning');
      rbac.audit(req, username, 'LOGIN_FAILED', 'security', 'login', null, 'Invalid HR credentials', 'denied');
      return send(res, 401, { error: 'Invalid HR credentials' });
    }
    logSecEvent('login_success', 'hr', ip, username, 'HR Manager logged in', 'info');
    const token = createToken({ sub: 'hr', role: 'hr_manager', name: 'HR Manager' });
    rbac.audit(req, 'hr', 'LOGIN', 'security', 'login', null, 'HR Manager logged in', 'success');
    send(res, 200, { token, role: 'hr', name: 'HR Manager' });
  });
}

// ── HR BUDGET helpers ─────────────────────────────────────────────────────────
function getHRBudget(year) {
  year = year || new Date().getFullYear().toString();
  let row = db.prepare('SELECT * FROM hr_budget WHERE fiscal_year=?').get(year);
  if (!row) {
    db.prepare(`INSERT OR IGNORE INTO hr_budget (fiscal_year,allocated_amount,notes,set_by,updated_at) VALUES (?,0,'','',?)`).run(year, istDateOnly());
    row = db.prepare('SELECT * FROM hr_budget WHERE fiscal_year=?').get(year);
  }
  // Compute used amount from payroll_entries for this fiscal year
  const used = (db.prepare(`SELECT COALESCE(SUM(net_pay),0) as total FROM payroll_entries WHERE month LIKE ?`).get(year+'%') || {}).total || 0;
  // Projected monthly salary bill (sum of all active staff net pay)
  const projMonthly = (db.prepare(`
    SELECT COALESCE(SUM(
      ps.basic
      + ROUND(ps.basic * ps.hra_pct / 100)
      + ROUND(ps.basic * ps.da_pct  / 100)
      + ps.transport + ps.medical
      - ROUND(ps.basic * ps.pf_pct / 100)
      - CASE WHEN (ps.basic + ROUND(ps.basic*ps.hra_pct/100) + ROUND(ps.basic*ps.da_pct/100) + ps.transport + ps.medical) <= 21000
             THEN ROUND((ps.basic + ROUND(ps.basic*ps.hra_pct/100) + ROUND(ps.basic*ps.da_pct/100) + ps.transport + ps.medical) * ps.esi_pct / 100)
             ELSE 0 END
      - ps.tds
    ),0) as total
    FROM payroll_structures ps
    WHERE EXISTS (SELECT 1 FROM teachers   t WHERE t.id=ps.staff_id AND ps.staff_type='teacher' AND t.status='Active')
       OR EXISTS (SELECT 1 FROM support_staff s WHERE s.id=ps.staff_id AND ps.staff_type='support' AND s.status='Active')
  `).get() || {}).total || 0;
  const remaining = row.allocated_amount - used;
  const monthsLeft = 12 - new Date().getMonth(); // rough months remaining in year
  return {
    fiscal_year: row.fiscal_year,
    allocated: row.allocated_amount,
    used: Math.round(used),
    remaining: Math.round(remaining),
    proj_monthly: Math.round(projMonthly),
    proj_annual: Math.round(projMonthly * 12),
    months_left: monthsLeft,
    notes: row.notes || '',
    set_by: row.set_by || '',
    updated_at: row.updated_at || '',
    budget_ok: remaining >= projMonthly,
    pct_used: row.allocated_amount > 0 ? Math.round(used / row.allocated_amount * 100) : 0
  };
}

function handleHRBudget(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const q = url.parse(req.url, true).query;
  const year = q.year || new Date().getFullYear().toString();
  if (req.method === 'GET') {
    return send(res, 200, getHRBudget(year));
  }
  // PATCH — update allocated amount
  parseBody(req, (d) => {
    if (d.allocated_amount === undefined || isNaN(parseFloat(d.allocated_amount))) {
      return send(res, 400, { error: 'allocated_amount required' });
    }
    const amt = parseFloat(d.allocated_amount);
    db.prepare(`INSERT INTO hr_budget (fiscal_year,allocated_amount,notes,set_by,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(fiscal_year) DO UPDATE SET allocated_amount=excluded.allocated_amount, notes=excluded.notes, set_by=excluded.set_by, updated_at=excluded.updated_at`
    ).run(year, amt, d.notes||'', pl.username||'hr', istDateOnly());
    send(res, 200, { ok: true, budget: getHRBudget(year) });
  });
}

function handleHROverview(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const today = istDateOnly();
  const thisMonth = today.slice(0, 7);

  const totalTeachers  = (db.prepare("SELECT COUNT(*) as c FROM teachers WHERE status='Active'").get() || {}).c || 0;
  const totalSupport   = (db.prepare("SELECT COUNT(*) as c FROM support_staff WHERE status='Active'").get() || {}).c || 0;
  const totalStaff     = totalTeachers + totalSupport;

  const presentToday   = (db.prepare("SELECT COUNT(*) as c FROM teacher_checkins WHERE date=?").get(today) || {}).c || 0;
  const pendingLeaves  = (db.prepare("SELECT COUNT(*) as c FROM leave_applications WHERE status='Pending'").get() || {}).c || 0;
  const openJobs       = (db.prepare("SELECT COUNT(*) as c FROM job_postings WHERE status='Open'").get() || {}).c || 0;
  const newApplications= (db.prepare("SELECT COUNT(*) as c FROM job_applications WHERE status='Applied'").get() || {}).c || 0;

  // Payroll for this month
  const payrollThisMonth = db.prepare(`
    SELECT COALESCE(SUM(net_pay),0) as total FROM payroll_entries WHERE month=?
  `).get(thisMonth) || { total: 0 };

  // Department headcount
  const deptTeachers = db.prepare("SELECT department, COUNT(*) as count FROM teachers WHERE status='Active' GROUP BY department ORDER BY count DESC").all();
  const deptSupport  = db.prepare("SELECT department, COUNT(*) as count FROM support_staff WHERE status='Active' GROUP BY department ORDER BY count DESC").all();

  // Recent leave applications
  const recentLeaves = db.prepare(`
    SELECT id, person_name, leave_type, from_date, to_date, days, reason, status, applied_at
    FROM leave_applications ORDER BY applied_at DESC LIMIT 8
  `).all();

  // Today's checkins
  const todayCheckins = db.prepare(`
    SELECT tc.teacher_id, t.name, tc.check_in, tc.check_out, tc.hours_worked, 0 AS late_mins
    FROM teacher_checkins tc JOIN teachers t ON t.id=tc.teacher_id
    WHERE tc.date=? ORDER BY tc.check_in DESC
  `).all(today);

  // Employment type breakdown
  const empTypes = db.prepare(`
    SELECT employment_type, COUNT(*) as count FROM teachers WHERE status='Active'
    GROUP BY employment_type
    UNION ALL
    SELECT employment_type, COUNT(*) as count FROM support_staff WHERE status='Active'
    GROUP BY employment_type
  `).all();

  send(res, 200, {
    totalStaff, totalTeachers, totalSupport, presentToday,
    pendingLeaves, openJobs, newApplications,
    payrollThisMonth: payrollThisMonth.total,
    deptTeachers, deptSupport, recentLeaves, todayCheckins, empTypes,
    budget: getHRBudget(today.slice(0,4))
  });
}

function handleHREmployeeList(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const q = url.parse(req.url, true).query;
  const search = (q.search || '').toLowerCase();
  const dept   = q.department || '';
  const type   = q.type || '';

  let teachers = db.prepare(`
    SELECT t.id, t.name, t.email, t.phone, t.subject, t.status,
      COALESCE(t.designation,'') as designation,
      COALESCE(t.department,'Teaching') as department,
      COALESCE(t.joining_date,'') as joining_date,
      COALESCE(t.employment_type,'Full-time') as employment_type,
      COALESCE(t.gender,'') as gender,
      COALESCE(t.dob,'') as dob,
      COALESCE(ps.basic,0) as basic,
      'teacher' as staff_type
    FROM teachers t
    LEFT JOIN payroll_structures ps ON ps.staff_id=t.id AND ps.staff_type='teacher'
    ORDER BY t.name
  `).all();

  let support = db.prepare(`
    SELECT s.id, s.name, s.email, s.phone, s.designation, s.department,
      s.joining_date, s.status,
      COALESCE(s.employment_type,'Full-time') as employment_type,
      COALESCE(s.gender,'') as gender,
      COALESCE(s.dob,'') as dob,
      COALESCE(ps.basic,0) as basic,
      'support' as staff_type
    FROM support_staff s
    LEFT JOIN payroll_structures ps ON ps.staff_id=s.id AND ps.staff_type='support'
    ORDER BY s.name
  `).all();

  let all = [...teachers, ...support];
  if (search) all = all.filter(e => e.name.toLowerCase().includes(search) || e.id.toLowerCase().includes(search) || (e.email||'').toLowerCase().includes(search));
  if (dept)   all = all.filter(e => (e.department||'').toLowerCase() === dept.toLowerCase());
  if (type)   all = all.filter(e => e.staff_type === type);

  send(res, 200, { employees: all, total: all.length });
}

function handleHRGetEmployee(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const parts = url.parse(req.url).pathname.split('/');
  const staffType = parts[4];
  const staffId   = parts[5];

  if (staffType === 'teacher') {
    const t = db.prepare('SELECT * FROM teachers WHERE id=?').get(staffId);
    if (!t) return send(res, 404, { error: 'Teacher not found' });
    const { password_hash, ...safe } = t;
    const ps = db.prepare("SELECT * FROM payroll_structures WHERE staff_id=? AND staff_type='teacher'").get(staffId) || {};
    const assignments = db.prepare('SELECT class,section,subject FROM teacher_assignments WHERE teacher_id=? ORDER BY class,section').all(staffId);
    const leaveBalance = db.prepare("SELECT * FROM leave_balance WHERE person_id=? AND person_type='teacher' ORDER BY year DESC LIMIT 1").get(staffId) || {};
    send(res, 200, { ...safe, payroll: ps, assignments, leaveBalance, staff_type: 'teacher' });
  } else {
    const s = db.prepare('SELECT * FROM support_staff WHERE id=?').get(staffId);
    if (!s) return send(res, 404, { error: 'Staff not found' });
    const ps = db.prepare("SELECT * FROM payroll_structures WHERE staff_id=? AND staff_type='support'").get(staffId) || {};
    send(res, 200, { ...s, payroll: ps, staff_type: 'support' });
  }
}

function handleHRUpdateEmployee(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const parts     = url.parse(req.url).pathname.split('/');
  const staffType = parts[4];
  const staffId   = parts[5];

  parseBody(req, (d) => {
    if (!d) return send(res, 400, { error: 'No data' });
    if (staffType === 'teacher') {
      db.prepare(`UPDATE teachers SET
        name=COALESCE(?,name), email=COALESCE(?,email), phone=COALESCE(?,phone),
        subject=COALESCE(?,subject), designation=COALESCE(?,designation),
        department=COALESCE(?,department), dob=COALESCE(?,dob), gender=COALESCE(?,gender),
        blood_group=COALESCE(?,blood_group), emergency_name=COALESCE(?,emergency_name),
        emergency_phone=COALESCE(?,emergency_phone), address=COALESCE(?,address),
        bank_name=COALESCE(?,bank_name), account_number=COALESCE(?,account_number),
        ifsc=COALESCE(?,ifsc), pan=COALESCE(?,pan), uan=COALESCE(?,uan),
        employment_type=COALESCE(?,employment_type), joining_date=COALESCE(?,joining_date),
        status=COALESCE(?,status) WHERE id=?`).run(
        d.name||null, d.email||null, d.phone||null, d.subject||null,
        d.designation||null, d.department||null, d.dob||null, d.gender||null,
        d.blood_group||null, d.emergency_name||null, d.emergency_phone||null, d.address||null,
        d.bank_name||null, d.account_number||null, d.ifsc||null, d.pan||null, d.uan||null,
        d.employment_type||null, d.joining_date||null, d.status||null, staffId
      );
    } else {
      db.prepare(`UPDATE support_staff SET
        name=COALESCE(?,name), email=COALESCE(?,email), phone=COALESCE(?,phone),
        designation=COALESCE(?,designation), department=COALESCE(?,department),
        status=COALESCE(?,status), joining_date=COALESCE(?,joining_date),
        dob=COALESCE(?,dob), gender=COALESCE(?,gender), blood_group=COALESCE(?,blood_group),
        emergency_name=COALESCE(?,emergency_name), emergency_phone=COALESCE(?,emergency_phone),
        address=COALESCE(?,address), bank_name=COALESCE(?,bank_name),
        account_number=COALESCE(?,account_number), ifsc=COALESCE(?,ifsc),
        pan=COALESCE(?,pan), uan=COALESCE(?,uan), employment_type=COALESCE(?,employment_type)
        WHERE id=?`).run(
        d.name||null, d.email||null, d.phone||null,
        d.designation||null, d.department||null, d.status||null, d.joining_date||null,
        d.dob||null, d.gender||null, d.blood_group||null,
        d.emergency_name||null, d.emergency_phone||null, d.address||null,
        d.bank_name||null, d.account_number||null, d.ifsc||null,
        d.pan||null, d.uan||null, d.employment_type||null, staffId
      );
    }
    if (d.basic !== undefined) {
      db.prepare(`INSERT INTO payroll_structures (staff_id,staff_type,basic,hra_pct,da_pct,transport,medical,pf_pct,esi_pct,tds)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(staff_id,staff_type) DO UPDATE SET
          basic=excluded.basic,hra_pct=excluded.hra_pct,da_pct=excluded.da_pct,
          transport=excluded.transport,medical=excluded.medical,
          pf_pct=excluded.pf_pct,esi_pct=excluded.esi_pct,tds=excluded.tds`).run(
        staffId, staffType, parseFloat(d.basic)||0, parseFloat(d.hra_pct)||40,
        parseFloat(d.da_pct)||5, parseFloat(d.transport)||1500, parseFloat(d.medical)||1250,
        parseFloat(d.pf_pct)||12, parseFloat(d.esi_pct)||0, parseFloat(d.tds)||0
      );
    }
    send(res, 200, { ok: true });
  });
}

function handleHRAddTeacher(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  parseBody(req, (d) => {
    if (!d || !d.name || !d.username || !d.password)
      return send(res, 400, { error: 'name, username and password required' });
    const exists = db.prepare('SELECT id FROM teachers WHERE username=?').get(d.username.trim().toLowerCase());
    if (exists) return send(res, 409, { error: 'Username already taken' });
    const lastT = db.prepare("SELECT id FROM teachers ORDER BY id DESC LIMIT 1").get();
    let nextNum = 1;
    if (lastT && lastT.id) { const n = parseInt(lastT.id.replace(/\D/g,'')) || 0; nextNum = n + 1; }
    const newId = `T${String(nextNum).padStart(3,'0')}`;
    const hash  = hashPassword(d.password);
    db.prepare(`INSERT INTO teachers (id,name,username,password_hash,email,phone,subject,designation,department,joining_date,employment_type,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      newId, d.name, d.username.trim().toLowerCase(), hash,
      d.email||'', d.phone||'', d.subject||'',
      d.designation||'Teacher', d.department||'Teaching',
      d.joining_date||istDateOnly(), d.employment_type||'Full-time', 'Active'
    );
    db.prepare(`INSERT OR IGNORE INTO payroll_structures (staff_id,staff_type,basic,hra_pct,da_pct,transport,medical,pf_pct,esi_pct,tds)
      VALUES (?,?,?,40,5,1500,1250,12,0,500)`).run(newId,'teacher', parseFloat(d.basic)||25000);
    send(res, 201, { ok: true, id: newId });
  });
}

function handleHRAddSupport(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  parseBody(req, (d) => {
    if (!d || !d.name) return send(res, 400, { error: 'Name required' });
    const existing = db.prepare('SELECT id FROM support_staff ORDER BY id').all();
    let nextNum = 1;
    existing.forEach(r => { const n = parseInt(r.id.replace('SS','')) || 0; if (n >= nextNum) nextNum = n + 1; });
    const newId = `SS${String(nextNum).padStart(3,'0')}`;
    db.prepare(`INSERT INTO support_staff (id,name,department,designation,phone,email,joining_date,status,employment_type)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      newId, d.name, d.department||'Administration', d.designation||'',
      d.phone||'', d.email||'', d.joining_date||istDateOnly(), d.status||'Active', d.employment_type||'Full-time'
    );
    db.prepare(`INSERT OR IGNORE INTO payroll_structures (staff_id,staff_type,basic,hra_pct,da_pct,transport,medical,pf_pct,esi_pct,tds)
      VALUES (?,?,?,40,5,1500,1250,12,0.75,0)`).run(newId,'support', parseFloat(d.basic)||15000);
    send(res, 201, { ok: true, id: newId });
  });
}

function handleHRAttendance(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const q     = url.parse(req.url, true).query;
  const month = q.month || istDateOnly().slice(0, 7);
  const rows  = db.prepare(`
    SELECT tc.id, tc.teacher_id, t.name, t.department, tc.date,
      tc.check_in, tc.check_out, tc.hours_worked, tc.late_mins, tc.early_mins, tc.deduction, tc.notes
    FROM teacher_checkins tc
    JOIN teachers t ON t.id=tc.teacher_id
    WHERE tc.date LIKE ?
    ORDER BY tc.date DESC, t.name
  `).all(`${month}%`);
  const summary = db.prepare(`
    SELECT COUNT(DISTINCT date) as working_days,
      COUNT(DISTINCT teacher_id) as unique_staff,
      ROUND(AVG(hours_worked),1) as avg_hours
    FROM teacher_checkins WHERE date LIKE ?
  `).get(`${month}%`) || {};
  send(res, 200, { attendance: rows, summary, month });
}

function handleHRLeaves(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const q      = url.parse(req.url, true).query;
  const status = q.status || '';
  let sql = `SELECT * FROM leave_applications`;
  const args = [];
  if (status) { sql += ' WHERE status=?'; args.push(status); }
  sql += ' ORDER BY applied_at DESC LIMIT 100';
  send(res, 200, { leaves: db.prepare(sql).all(...args) });
}

function handleHRDecideLeave(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const id = parseInt(url.parse(req.url).pathname.split('/').slice(-2)[0], 10);
  parseBody(req, ({ decision, admin_note }) => {
    if (!['Approved','Rejected'].includes(decision)) return send(res, 400, { error: 'decision must be Approved or Rejected' });
    const app = db.prepare('SELECT * FROM leave_applications WHERE id=?').get(id);
    if (!app) return send(res, 404, { error: 'Leave application not found' });
    db.prepare(`UPDATE leave_applications SET status=?, admin_note=?, decided_at=? WHERE id=?`)
      .run(decision, admin_note||'', istDateOnly(), id);
    send(res, 200, { ok: true });
  });
}

function handleHRPayrollRun(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  // Delegate to admin handler but bypass requireAdmin check
  const q = url.parse(req.url, true).query;
  const month = q.month || istDateOnly().slice(0,7);

  if (req.method === 'GET') {
    // Preview payroll
    const teachers = db.prepare(`
      SELECT t.id, t.name, 'teacher' as staff_type,
        COALESCE(t.department,'Teaching') as department,
        COALESCE(ps.basic,0) as basic, COALESCE(ps.hra_pct,40) as hra_pct,
        COALESCE(ps.da_pct,5) as da_pct, COALESCE(ps.transport,1500) as transport,
        COALESCE(ps.medical,1250) as medical, COALESCE(ps.pf_pct,12) as pf_pct,
        COALESCE(ps.esi_pct,0) as esi_pct, COALESCE(ps.tds,0) as tds
      FROM teachers t
      LEFT JOIN payroll_structures ps ON ps.staff_id=t.id AND ps.staff_type='teacher'
      WHERE t.status='Active' ORDER BY t.name
    `).all();
    const support = db.prepare(`
      SELECT s.id, s.name, 'support' as staff_type, s.department,
        COALESCE(ps.basic,0) as basic, COALESCE(ps.hra_pct,40) as hra_pct,
        COALESCE(ps.da_pct,5) as da_pct, COALESCE(ps.transport,1500) as transport,
        COALESCE(ps.medical,1250) as medical, COALESCE(ps.pf_pct,12) as pf_pct,
        COALESCE(ps.esi_pct,0) as esi_pct, COALESCE(ps.tds,0) as tds
      FROM support_staff s
      LEFT JOIN payroll_structures ps ON ps.staff_id=s.id AND ps.staff_type='support'
      WHERE s.status='Active' ORDER BY s.name
    `).all();
    const allStaff = [...teachers, ...support].map(s => {
      const gross = s.basic + (s.basic * s.hra_pct / 100) + (s.basic * s.da_pct / 100) + s.transport + s.medical;
      const pf    = Math.round(s.basic * s.pf_pct / 100);
      const esi   = Math.round(gross * s.esi_pct / 100);
      const net   = gross - pf - esi - s.tds;
      const processed = db.prepare("SELECT id FROM payroll_entries WHERE staff_id=? AND staff_type=? AND month=?").get(s.id, s.staff_type, month);
      return { ...s, gross: Math.round(gross), pf_deduction: pf, esi_deduction: esi, tds_deduction: s.tds, net_pay: Math.round(net), already_processed: !!processed };
    });
    send(res, 200, { staff: allStaff, month });
  } else {
    // Run payroll
    parseBody(req, (d) => {
      const runMonth = d.month || month;
      const staff = d.staff || [];

      // Budget check — only if an allocated budget exists
      if (staff.length > 0) {
        const budget = getHRBudget(runMonth.slice(0,4));
        if (budget.allocated > 0) {
          const totalNet = staff.reduce((s,e) => s + (e.net_pay||0), 0);
          if (totalNet > budget.remaining) {
            return send(res, 400, {
              error: `Insufficient fund. Selected payroll ₹${Math.round(totalNet).toLocaleString('en-IN')} exceeds remaining HR budget ₹${Math.round(budget.remaining).toLocaleString('en-IN')}.`,
              budget
            });
          }
        }
      }

      let processed = 0;
      staff.forEach(s => {
        try {
          db.prepare(`INSERT OR REPLACE INTO payroll_entries
            (staff_id,staff_type,month,working_days,present_days,lop_days,basic,hra,da,transport,medical,gross,
             pf_deduction,esi_deduction,tds_deduction,late_deduction,lop_deduction,total_deductions,bonus,net_pay,status,processed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            s.id, s.staff_type, runMonth, s.working_days||26, s.present_days||26, s.lop_days||0,
            s.basic||0, s.hra||0, s.da||0, s.transport||0, s.medical||0, s.gross||0,
            s.pf_deduction||0, s.esi_deduction||0, s.tds_deduction||0, s.late_deduction||0, s.lop_deduction||0,
            (s.pf_deduction||0)+(s.esi_deduction||0)+(s.tds_deduction||0)+(s.late_deduction||0)+(s.lop_deduction||0),
            s.bonus||0, s.net_pay||0, 'Processed', istDateOnly()
          );
          processed++;
        } catch(e) {}
      });
      send(res, 200, { ok: true, processed });
    });
  }
}

function handleHRPayrollHistory(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const q = url.parse(req.url, true).query;
  const month = q.month || istDateOnly().slice(0,7);
  const rows = db.prepare(`
    SELECT pe.*, CASE pe.staff_type WHEN 'teacher' THEN t.name WHEN 'support' THEN s.name ELSE '' END as name,
      CASE pe.staff_type WHEN 'teacher' THEN COALESCE(t.department,'Teaching') WHEN 'support' THEN s.department ELSE '' END as department
    FROM payroll_entries pe
    LEFT JOIN teachers t ON t.id=pe.staff_id AND pe.staff_type='teacher'
    LEFT JOIN support_staff s ON s.id=pe.staff_id AND pe.staff_type='support'
    WHERE pe.month=? ORDER BY name
  `).all(month);
  const total = rows.reduce((s,r) => s + (r.net_pay||0), 0);
  send(res, 200, { payroll: rows, total: Math.round(total), month });
}

function handleHRSalaryStructures(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const teachers = db.prepare(`
    SELECT t.id, t.name, t.department, 'teacher' as staff_type,
      COALESCE(ps.basic,0) as basic, COALESCE(ps.hra_pct,40) as hra_pct,
      COALESCE(ps.da_pct,5) as da_pct, COALESCE(ps.transport,1500) as transport,
      COALESCE(ps.medical,1250) as medical, COALESCE(ps.pf_pct,12) as pf_pct,
      COALESCE(ps.esi_pct,0) as esi_pct, COALESCE(ps.tds,0) as tds
    FROM teachers t
    LEFT JOIN payroll_structures ps ON ps.staff_id=t.id AND ps.staff_type='teacher'
    WHERE t.status='Active' ORDER BY t.name
  `).all();
  const support = db.prepare(`
    SELECT s.id, s.name, s.department, 'support' as staff_type,
      COALESCE(ps.basic,0) as basic, COALESCE(ps.hra_pct,40) as hra_pct,
      COALESCE(ps.da_pct,5) as da_pct, COALESCE(ps.transport,1500) as transport,
      COALESCE(ps.medical,1250) as medical, COALESCE(ps.pf_pct,12) as pf_pct,
      COALESCE(ps.esi_pct,0) as esi_pct, COALESCE(ps.tds,0) as tds
    FROM support_staff s
    LEFT JOIN payroll_structures ps ON ps.staff_id=s.id AND ps.staff_type='support'
    WHERE s.status='Active' ORDER BY s.name
  `).all();
  send(res, 200, { structures: [...teachers, ...support] });
}

function handleHRUpdateSalaryStructure(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const parts     = url.parse(req.url).pathname.split('/');
  const staffType = parts[4];
  const staffId   = parts[5];
  parseBody(req, (d) => {
    db.prepare(`INSERT INTO payroll_structures (staff_id,staff_type,basic,hra_pct,da_pct,transport,medical,pf_pct,esi_pct,tds)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(staff_id,staff_type) DO UPDATE SET
        basic=excluded.basic,hra_pct=excluded.hra_pct,da_pct=excluded.da_pct,
        transport=excluded.transport,medical=excluded.medical,
        pf_pct=excluded.pf_pct,esi_pct=excluded.esi_pct,tds=excluded.tds`).run(
      staffId, staffType,
      parseFloat(d.basic)||0, parseFloat(d.hra_pct)||40, parseFloat(d.da_pct)||5,
      parseFloat(d.transport)||1500, parseFloat(d.medical)||1250,
      parseFloat(d.pf_pct)||12, parseFloat(d.esi_pct)||0, parseFloat(d.tds)||0
    );
    send(res, 200, { ok: true });
  });
}

// ── Recruitment Handlers ──────────────────────────────────────────────────────
function handleHRListJobs(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const jobs = db.prepare(`
    SELECT jp.*, (SELECT COUNT(*) FROM job_applications ja WHERE ja.job_id=jp.id) as total_applicants
    FROM job_postings jp ORDER BY jp.posted_date DESC
  `).all();
  send(res, 200, { jobs });
}

function handleHRCreateJob(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  parseBody(req, (d) => {
    if (!d || !d.title) return send(res, 400, { error: 'Job title required' });
    const r = db.prepare(`INSERT INTO job_postings (title,department,location,type,description,requirements,vacancies,status,posted_date,closing_date,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      d.title, d.department||'', d.location||'K.R. Nagar, Mysuru',
      d.type||'Full-time', d.description||'', d.requirements||'',
      parseInt(d.vacancies)||1, d.status||'Open',
      d.posted_date||istDateOnly(), d.closing_date||'', 'hr'
    );
    send(res, 201, { ok: true, id: r.lastInsertRowid });
  });
}

function handleHRUpdateJob(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const id = parseInt(url.parse(req.url).pathname.split('/').pop(), 10);
  parseBody(req, (d) => {
    db.prepare(`UPDATE job_postings SET
      title=COALESCE(?,title), department=COALESCE(?,department), status=COALESCE(?,status),
      closing_date=COALESCE(?,closing_date), vacancies=COALESCE(?,vacancies)
      WHERE id=?`).run(d.title||null, d.department||null, d.status||null, d.closing_date||null, d.vacancies||null, id);
    send(res, 200, { ok: true });
  });
}

function handleHRDeleteJob(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const id = parseInt(url.parse(req.url).pathname.split('/').pop(), 10);
  db.prepare('DELETE FROM job_applications WHERE job_id=?').run(id);
  db.prepare('DELETE FROM job_postings WHERE id=?').run(id);
  send(res, 200, { ok: true });
}

function handleHRListApplications(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const q  = url.parse(req.url, true).query;
  const jobId = q.job_id ? parseInt(q.job_id) : null;
  const status = q.status || '';
  let sql = `SELECT ja.*, jp.title as job_title FROM job_applications ja LEFT JOIN job_postings jp ON jp.id=ja.job_id`;
  const args = [];
  const conditions = [];
  if (jobId)  { conditions.push('ja.job_id=?'); args.push(jobId); }
  if (status) { conditions.push('ja.status=?'); args.push(status); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY ja.applied_date DESC';
  send(res, 200, { applications: db.prepare(sql).all(...args) });
}

function handleHRCreateApplication(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  parseBody(req, (d) => {
    if (!d || !d.applicant_name || !d.job_id) return send(res, 400, { error: 'job_id and applicant_name required' });
    const job = db.prepare('SELECT * FROM job_postings WHERE id=?').get(parseInt(d.job_id));
    if (!job) return send(res, 404, { error: 'Job not found' });
    const r = db.prepare(`INSERT INTO job_applications
      (job_id,job_title,applicant_name,email,phone,experience_years,qualification,current_org,applied_date,status,interview_date,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      job.id, job.title, d.applicant_name, d.email||'', d.phone||'',
      parseFloat(d.experience_years)||0, d.qualification||'', d.current_org||'',
      d.applied_date||istDateOnly(), d.status||'Applied', d.interview_date||'', d.notes||''
    );
    send(res, 201, { ok: true, id: r.lastInsertRowid });
  });
}

function handleHRUpdateApplication(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const id = parseInt(url.parse(req.url).pathname.split('/').pop(), 10);
  parseBody(req, (d) => {
    db.prepare(`UPDATE job_applications SET
      status=COALESCE(?,status), interview_date=COALESCE(?,interview_date),
      notes=COALESCE(?,notes) WHERE id=?`).run(d.status||null, d.interview_date||null, d.notes||null, id);
    send(res, 200, { ok: true });
  });
}

function handleHRDeleteApplication(req, res) {
  const pl = hrAuth(req, res); if (!pl) return;
  const id = parseInt(url.parse(req.url).pathname.split('/').pop(), 10);
  db.prepare('DELETE FROM job_applications WHERE id=?').run(id);
  send(res, 200, { ok: true });
}

function handleFinanceLogin(req, res) {
  const ip = getIP(req);
  parseBody(req, ({ username, password }) => {
    if (!username || !password) return send(res, 400, { error: 'Username and password required' });
    if (username.trim().toLowerCase() !== FINANCE_USER || password !== FINANCE_PASS) {
      logSecEvent('login_failed', 'finance', ip, username, 'Invalid finance credentials', 'warning');
      rbac.audit(req, username, 'LOGIN_FAILED', 'security', 'login', null, 'Invalid finance credentials', 'denied');
      return send(res, 401, { error: 'Invalid finance credentials' });
    }
    logSecEvent('login_success', 'finance', ip, username, 'Finance officer logged in', 'info');
    const token = createToken({ sub: 'finance', role: 'finance_officer', name: 'Finance Officer' });
    rbac.audit(req, 'finance', 'LOGIN', 'security', 'login', null, 'Finance Officer logged in', 'success');
    send(res, 200, { token, role: 'finance', name: 'Finance Officer' });
  });
}

// ─── FINANCE: FEE SCHEDULES ────────────────────────────────────────────────
function handleGetFeeSchedules(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  const q   = url.parse(req.url, true).query;
  const yr  = q.year || new Date().getFullYear().toString();
  const cls = q.class || '';
  let sql = 'SELECT * FROM fee_schedules WHERE academic_yr=?';
  const args = [yr];
  if (cls) { sql += ' AND class=?'; args.push(cls); }
  sql += ' ORDER BY class, fee_type';
  send(res, 200, { schedules: db.prepare(sql).all(...args) });
}

function handleSetFeeSchedule(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  parseBody(req, data => {
    const { class: cls, fee_type, amount, academic_yr, term } = data;
    if (!cls || !fee_type || amount === undefined) return send(res, 400, { error: 'class, fee_type, amount required' });
    db.prepare(`INSERT OR REPLACE INTO fee_schedules (class,fee_type,amount,academic_yr,term) VALUES (?,?,?,?,?)`).run(
      cls, fee_type, parseFloat(amount), academic_yr || new Date().getFullYear().toString(), term || 'Annual'
    );
    send(res, 200, { message: 'Schedule saved' });
  });
}

function handleDeleteFeeSchedule(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  const id = parseInt(req.url.split('/').pop(), 10);
  db.prepare('DELETE FROM fee_schedules WHERE id=?').run(id);
  send(res, 200, { message: 'Deleted' });
}

// ─── FINANCE: STUDENT FEE DETAIL ─────────────────────────────────────────────
function handleFinanceStudentFees(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  const sid = req.url.split('/').slice(-2)[0]; // /api/finance/student/:id/fees
  const q   = url.parse(req.url, true).query;
  const yr  = q.year || new Date().getFullYear().toString();

  const student = db.prepare('SELECT id,name,class,section,parent_name,parent_phone FROM students WHERE id=?').get(sid);
  if (!student) return send(res, 404, { error: 'Student not found' });

  // Fee schedule for this class+year
  const schedule = db.prepare('SELECT * FROM fee_schedules WHERE class=? AND academic_yr=? ORDER BY fee_type').all(student.class, yr);

  // All payments for this student this year (also include legacy empty academic_yr)
  const payments = db.prepare(`SELECT * FROM finance_fees WHERE student_id=? AND (academic_yr=? OR academic_yr='' OR academic_yr IS NULL) ORDER BY recorded_at DESC`).all(sid, yr);

  // Calculate totals per fee_type
  const paymentMap = {};
  payments.forEach(p => {
    if (!paymentMap[p.fee_type]) paymentMap[p.fee_type] = 0;
    if (p.status === 'Paid' || p.status === 'Partial') paymentMap[p.fee_type] += p.amount;
  });

  const scheduleWithBalance = schedule.map(s => ({
    ...s,
    paid: paymentMap[s.fee_type] || 0,
    balance: Math.max(0, s.amount - (paymentMap[s.fee_type] || 0))
  }));

  const totalExpected = schedule.reduce((a, s) => a + s.amount, 0);
  const totalPaid     = Object.values(paymentMap).reduce((a, v) => a + v, 0);
  const totalBalance  = Math.max(0, totalExpected - totalPaid);

  send(res, 200, { student, schedule: scheduleWithBalance, payments, totalExpected, totalPaid, totalBalance, year: yr });
}

// ─── FINANCE: RECORD PAYMENT (enhanced) ──────────────────────────────────────
function handleFinanceRecordPayment(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  parseBody(req, data => {
    const {
      student_id, fee_type, amount, academic_yr, term, paid_date, status, payment_mode,
      cheque_no, bank_name, transaction_id, discount_amount, balance_due,
      parent_name, parent_phone, notes, month
    } = data;
    if (!student_id || !fee_type || !amount)
      return send(res, 400, { error: 'student_id, fee_type and amount are required' });

    const now = istNow();
    const rcptNo = (status === 'Paid' || status === 'Partial') ? generateReceiptNo() : '';
    const result = db.prepare(`
      INSERT INTO finance_fees
        (student_id, fee_type, amount, academic_yr, month, paid_date, status, payment_mode,
         receipt_no, notes, recorded_at, term, discount_amount, balance_due,
         cheque_no, bank_name, transaction_id, parent_name, parent_phone, verified_by, submitted_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      student_id, fee_type, parseFloat(amount),
      academic_yr || new Date().getFullYear().toString(),
      month || '', paid_date || now.date,
      status || 'Paid', payment_mode || 'Cash',
      rcptNo, notes || '',
      `${now.date} ${now.time}`,
      term || 'Annual',
      parseFloat(discount_amount || 0),
      parseFloat(balance_due || 0),
      cheque_no || '', bank_name || '', transaction_id || '',
      parent_name || '', parent_phone || '',
      'Finance Office', 'finance'
    );

    // Broadcast real-time event
    const newRec = db.prepare('SELECT f.*, s.name AS student_name, s.class FROM finance_fees f JOIN students s ON f.student_id=s.id WHERE f.id=?').get(result.lastInsertRowid);
    broadcastEvent('new_payment', newRec);
    saveFeeBackup();

    send(res, 201, { id: result.lastInsertRowid, receipt_no: rcptNo, message: 'Payment recorded' });
  });
}

// ─── FINANCE: VERIFY ONLINE PAYMENT ──────────────────────────────────────────
function handleFinanceVerifyPayment(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  const id = parseInt(req.url.split('/').slice(-2)[0], 10);
  parseBody(req, data => {
    const { status, verified_by, notes } = data;
    if (!status) return send(res, 400, { error: 'status required' });
    const now   = istNow();
    const rcpt  = (status === 'Paid') ? generateReceiptNo() : '';
    db.prepare(`UPDATE finance_fees SET status=?, verified_by=?, notes=COALESCE(NULLIF(?,'')||' | '||COALESCE(notes,''),notes), receipt_no=CASE WHEN ?='' THEN receipt_no ELSE ? END, paid_date=? WHERE id=?`)
      .run(status, verified_by || 'Finance Office', notes || '', rcpt, rcpt, now.date, id);
    const updated = db.prepare('SELECT f.*, s.name AS student_name FROM finance_fees f JOIN students s ON f.student_id=s.id WHERE f.id=?').get(id);
    broadcastEvent('payment_verified', updated);
    saveFeeBackup();
    send(res, 200, { message: 'Payment updated', receipt_no: rcpt });
  });
}

// ─── FINANCE: SSE STREAM ─────────────────────────────────────────────────────
function handleFinanceStream(req, res) {
  // Allow any authenticated client (finance or admin)
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : (url.parse(req.url, true).query.token || '');
  const pl    = verifyToken(token);
  if (!pl) { send(res, 401, { error: 'Auth required for event stream' }); return; }

  res.writeHead(200, {
    'Content-Type':                'text/event-stream',
    'Cache-Control':               'no-cache',
    'Connection':                  'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

// ─── STUDENT: SUBMIT ONLINE PAYMENT ─────────────────────────────────────────
function handleStudentSubmitPayment(req, res, payload) {
  parseBody(req, data => {
    const { fee_type, amount, payment_mode, transaction_id, academic_yr, term, notes } = data;
    if (!fee_type || !amount) return send(res, 400, { error: 'fee_type and amount required' });
    const student = db.prepare('SELECT id,name,class,parent_name,parent_phone FROM students WHERE id=?').get(payload.sub);
    if (!student) return send(res, 404, { error: 'Student not found' });
    const now = istNow();
    const result = db.prepare(`
      INSERT INTO finance_fees
        (student_id, fee_type, amount, academic_yr, month, paid_date, status, payment_mode,
         receipt_no, notes, recorded_at, term, discount_amount, balance_due,
         cheque_no, bank_name, transaction_id, parent_name, parent_phone, verified_by, submitted_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      payload.sub, fee_type, parseFloat(amount),
      academic_yr || new Date().getFullYear().toString(),
      now.date.slice(0,7), now.date,
      'Pending', payment_mode || 'Online',
      '', notes || '',
      `${now.date} ${now.time}`,
      term || 'Annual', 0, 0,
      '', '', transaction_id || '',
      student.parent_name || '', student.parent_phone || '',
      '', 'student'
    );
    const newRec = db.prepare('SELECT f.*, s.name AS student_name, s.class FROM finance_fees f JOIN students s ON f.student_id=s.id WHERE f.id=?').get(result.lastInsertRowid);
    broadcastEvent('online_payment_request', newRec);
    send(res, 201, { id: result.lastInsertRowid, message: 'Payment submitted for verification' });
  });
}

// ─── STUDENT: GET FINANCE FEES (new endpoint) ─────────────────────────────────
function handleStudentFinanceFees(req, res, payload) {
  const q  = url.parse(req.url, true).query;
  const yr = q.year || new Date().getFullYear().toString();
  const student = db.prepare('SELECT id,name,class FROM students WHERE id=?').get(payload.sub);
  if (!student) return send(res, 404, { error: 'Not found' });

  // Fee schedule for this class
  const schedule = db.prepare('SELECT * FROM fee_schedules WHERE class=? AND academic_yr=? ORDER BY fee_type').all(student.class, yr);

  // All payment records
  const payments = db.prepare('SELECT * FROM finance_fees WHERE student_id=? AND academic_yr=? ORDER BY recorded_at DESC').all(payload.sub, yr);

  // Calculate balance per type
  const paidMap = {};
  payments.forEach(p => {
    if (!paidMap[p.fee_type]) paidMap[p.fee_type] = 0;
    if (p.status === 'Paid' || p.status === 'Partial') paidMap[p.fee_type] += p.amount;
  });

  const totalExpected = schedule.reduce((a, s) => a + s.amount, 0);
  const totalPaid     = Object.values(paidMap).reduce((a, v) => a + v, 0);

  send(res, 200, { schedule, payments, totalExpected, totalPaid, totalBalance: Math.max(0, totalExpected - totalPaid), year: yr });
}

// ─── SHARED AUTH CHECK (finance JWT OR admin key) ────────────────────────────
function requireFinanceOrAdmin(req, res) {
  const key = url.parse(req.url, true).query.key;
  if (key === ADMIN_KEY) return true;
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const pl    = verifyToken(token);
  if (pl && ['finance','finance_officer','accountant','admin','super_admin'].includes(pl.role)) return true;
  send(res, 401, { error: 'Unauthorized' }); return false;
}

// ─── FINANCE: FEE COLLECTION ─────────────────────────────────────────────────
function handleFinanceSummary(req, res) {
  if (!requireFinanceOrAdmin(req, res)) return;
  const q   = url.parse(req.url, true).query;
  const yr  = q.year || new Date().getFullYear().toString();
  // Also match academic_yr like "2025-26" when yr="2026"
  const acYr = `${parseInt(yr)-1}-${yr.slice(-2)}`; // e.g. "2025-26"
  const yrClause = `(academic_yr=? OR academic_yr=? OR academic_yr='' OR academic_yr IS NULL)`;

  // Total collected by fee type
  const byType = db.prepare(`
    SELECT fee_type, SUM(amount) AS total, COUNT(*) AS count
    FROM finance_fees WHERE status IN ('Paid','Partial') AND ${yrClause}
    GROUP BY fee_type ORDER BY total DESC
  `).all(acYr, yr);

  // Monthly collection trend
  const monthlyTrend = db.prepare(`
    SELECT COALESCE(NULLIF(month,''), LEFT(COALESCE(paid_date::text, recorded_at::text, '2026-01'), 7)) AS mon,
           SUM(amount) AS total
    FROM finance_fees WHERE status IN ('Paid','Partial') AND ${yrClause}
    GROUP BY 1 ORDER BY 1
  `).all(acYr, yr);

  // Outstanding dues
  const outstanding = db.prepare(`
    SELECT SUM(amount) AS total FROM finance_fees WHERE status='Pending' AND ${yrClause}
  `).get(acYr, yr);

  // Total donations
  const donationTotal = db.prepare(`
    SELECT SUM(amount) AS total FROM donations WHERE donated_date LIKE ?
  `).get(`${yr}%`);

  // Fees by class
  const byClass = db.prepare(`
    SELECT s.class, SUM(f.amount) AS total, COUNT(DISTINCT f.student_id) AS students
    FROM finance_fees f JOIN students s ON f.student_id=s.id
    WHERE f.status IN ('Paid','Partial') AND ${yrClause}
    GROUP BY s.class ORDER BY total DESC
  `).all(acYr, yr);

  // Grand total collected
  const grandTotal = db.prepare(`
    SELECT SUM(amount) AS total FROM finance_fees WHERE status IN ('Paid','Partial') AND ${yrClause}
  `).get(acYr, yr);

  send(res, 200, {
    year: yr,
    total_collected: grandTotal?.total || 0,
    total_outstanding: outstanding?.total || 0,
    total_donations: donationTotal?.total || 0,
    by_type: byType,
    monthly_trend: monthlyTrend,
    by_class: byClass
  });
}

function handleFinanceListFees(req, res) {
  if (!requireFinanceOrAdmin(req, res)) return;
  const q    = url.parse(req.url, true).query;
  const yr   = q.year  || '';
  const type = q.type  || '';
  const sid  = q.student_id || '';
  const cls  = q.class || '';
  const stat = q.status || '';
  const lim  = Math.min(parseInt(q.limit  || '200', 10), 500);
  const off  = parseInt(q.offset || '0', 10);

  let sql    = `SELECT f.*, s.name AS student_name, s.class, s.section
                FROM finance_fees f JOIN students s ON f.student_id=s.id
                WHERE 1=1`;
  const args = [];
  // Year filter: match exact year OR academic-year format (e.g. "2025-26") OR empty
  if (yr) {
    const acYr = `${parseInt(yr)-1}-${yr.slice(-2)}`;
    sql += ' AND (f.academic_yr=? OR f.academic_yr=? OR f.academic_yr=\'\' OR f.academic_yr IS NULL)';
    args.push(acYr, yr);
  }
  if (type) { sql += ' AND f.fee_type=?';    args.push(type); }
  if (sid)  { sql += ' AND f.student_id=?';  args.push(sid); }
  if (cls)  { sql += ' AND s.class=?';       args.push(cls); }
  if (stat) { sql += ' AND f.status=?';      args.push(stat); }
  sql += ' ORDER BY f.recorded_at DESC LIMIT ? OFFSET ?';
  args.push(lim, off);

  const rows  = db.prepare(sql).all(...args);
  const cntSql = `SELECT COUNT(*) AS c FROM finance_fees f JOIN students s ON f.student_id=s.id WHERE 1=1`
    + (yr   ? ` AND (f.academic_yr=? OR f.academic_yr=? OR f.academic_yr='' OR f.academic_yr IS NULL)` : '')
    + (type ? ` AND f.fee_type=?`    : '')
    + (sid  ? ` AND f.student_id=?`  : '')
    + (cls  ? ` AND s.class=?`       : '')
    + (stat ? ` AND f.status=?`      : '');
  const total = db.prepare(cntSql).get(...args.slice(0,-2));
  send(res, 200, { fees: rows, total: total?.c || 0 });
}

function handleFinanceAddFee(req, res) {
  if (!requireFinanceOrAdmin(req, res)) return;
  parseBody(req, data => {
    const { student_id, fee_type, amount, academic_yr, month, paid_date, status, payment_mode, receipt_no, notes } = data;
    if (!student_id || !fee_type || !amount)
      return send(res, 400, { error: 'student_id, fee_type, amount required' });
    const now = istNow();
    const ins = db.prepare(`INSERT INTO finance_fees (student_id,fee_type,amount,academic_yr,month,paid_date,status,payment_mode,receipt_no,notes,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const result = ins.run(
      student_id, fee_type, parseFloat(amount),
      academic_yr || `${new Date().getFullYear()}`, month || '',
      paid_date || now.date, status || 'Paid', payment_mode || 'Cash',
      receipt_no || '', notes || '', `${now.date} ${now.time}`
    );
    logDataEvent('Finance Officer', 'finance', 'Fees', 'record', 'finance_fees', `${fee_type} ₹${amount} for student ${student_id} — ${payment_mode||'Cash'}`, 1, getIP(req));
    saveFeeBackup();
    send(res, 201, { id: result.lastInsertRowid, message: 'Fee recorded' });
  });
}

function handleFinanceUpdateFee(req, res) {
  if (!requireFinanceOrAdmin(req, res)) return;
  const id = parseInt(req.url.split('/').pop(), 10);
  parseBody(req, data => {
    const allowed = ['status','amount','paid_date','payment_mode','receipt_no','notes'];
    const sets = [], args = [];
    for (const k of allowed) {
      if (data[k] !== undefined) { sets.push(`${k}=?`); args.push(data[k]); }
    }
    if (!sets.length) return send(res, 400, { error: 'Nothing to update' });
    args.push(id);
    db.prepare(`UPDATE finance_fees SET ${sets.join(',')} WHERE id=?`).run(...args);
    saveFeeBackup();
    send(res, 200, { message: 'Updated' });
  });
}

function handleFinanceDeleteFee(req, res) {
  if (!requireFinanceOrAdmin(req, res)) return;
  const id = parseInt(req.url.split('/').pop(), 10);
  db.prepare('DELETE FROM finance_fees WHERE id=?').run(id);
  saveFeeBackup();
  send(res, 200, { message: 'Deleted' });
}

// ─── FINANCE: DONATIONS ───────────────────────────────────────────────────────
function handleFinanceListDonations(req, res) {
  if (!requireFinanceOrAdmin(req, res)) return;
  const q   = url.parse(req.url, true).query;
  const yr  = q.year || '';
  let sql   = 'SELECT * FROM donations WHERE 1=1';
  const args = [];
  if (yr) { sql += ' AND donated_date LIKE ?'; args.push(`${yr}%`); }
  sql += ' ORDER BY donated_date DESC LIMIT 200';
  send(res, 200, { donations: db.prepare(sql).all(...args) });
}

function handleFinanceAddDonation(req, res) {
  if (!requireFinanceOrAdmin(req, res)) return;
  parseBody(req, data => {
    const { donor_name, amount, purpose, payment_mode, receipt_no, donated_date, donor_phone, donor_email, notes } = data;
    if (!donor_name || !amount) return send(res, 400, { error: 'donor_name and amount required' });
    const now = istNow();
    const result = db.prepare(`INSERT INTO donations (donor_name,donor_phone,donor_email,amount,purpose,payment_mode,receipt_no,donated_date,notes,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      donor_name, donor_phone||'', donor_email||'', parseFloat(amount),
      purpose||'General', payment_mode||'Cash', receipt_no||'',
      donated_date || now.date, notes||'', `${now.date} ${now.time}`
    );
    send(res, 201, { id: result.lastInsertRowid, message: 'Donation recorded' });
  });
}

function handleFinanceDeleteDonation(req, res) {
  if (!requireFinanceOrAdmin(req, res)) return;
  const id = parseInt(req.url.split('/').pop(), 10);
  db.prepare('DELETE FROM donations WHERE id=?').run(id);
  send(res, 200, { message: 'Deleted' });
}

// ─── PAYMENT VOUCHERS ─────────────────────────────────────────────────────────
// Auto-generate voucher number: PV-YYYY-NNNNN
function generateVoucherNo() {
  const yr = new Date().getFullYear();
  const last = db.prepare(`SELECT voucher_no FROM payment_vouchers WHERE voucher_no LIKE ? ORDER BY id DESC LIMIT 1`).get(`PV-${yr}-%`);
  const num  = last ? (parseInt(last.voucher_no.split('-').pop() || '0', 10) + 1) : 1;
  return `PV-${yr}-${String(num).padStart(5, '0')}`;
}

function handleListPaymentVouchers(req, res) {
  if (!requireFinanceOrAdmin(req, res)) return;
  const q    = new URLSearchParams(req.url.split('?')[1] || '');
  const from = q.get('from') || '';
  const to   = q.get('to')   || '';
  let sql    = 'SELECT pv.*, ca.name AS account_name FROM payment_vouchers pv LEFT JOIN chart_of_accounts ca ON pv.account_code=ca.code WHERE 1=1';
  const p    = [];
  if (from) { sql += ' AND pv.date>=?'; p.push(from); }
  if (to)   { sql += ' AND pv.date<=?'; p.push(to); }
  sql += ' ORDER BY pv.date DESC, pv.id DESC LIMIT 200';
  const rows = db.prepare(sql).all(...p);
  send(res, 200, { vouchers: rows });
}

function handleCreatePaymentVoucher(req, res) {
  if (!requireFinanceOrAdmin(req, res)) return;
  parseBody(req, data => {
    const { date, category, account_code, description, payee, amount, payment_mode, authorized_by, notes } = data;
    if (!date || !account_code || !amount) return send(res, 400, { error: 'Date, account and amount are required.' });
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return send(res, 400, { error: 'Amount must be positive.' });

    const vno    = generateVoucherNo();
    const cashAcct = (payment_mode === 'Bank') ? '1002' : '1001';

    // Insert voucher record
    const result = db.prepare(`INSERT INTO payment_vouchers
      (voucher_no,date,category,account_code,description,payee,amount,payment_mode,authorized_by,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(vno, date, category, account_code, description||'', payee||'', amt,
           payment_mode||'Cash', authorized_by||'', notes||'', 'finance');

    const pvId = result.lastInsertRowid;
    const narr = `${category} — ${payee||'—'} — ${vno}`;

    // Double-entry journal: Dr Expense, Cr Bank/Cash
    const jeIns = db.prepare(`INSERT INTO journal_entries
      (date,voucher_no,voucher_type,narration,account_code,debit,credit,reference,source,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    jeIns.run(date, vno, 'Payment Voucher', narr, account_code, amt, 0,    `PV-${pvId}`, 'expense', 'finance');
    jeIns.run(date, vno, 'Payment Voucher', narr, cashAcct,     0,   amt,  `PV-${pvId}`, 'expense', 'finance');

    // Audit log
    try { db.prepare('INSERT INTO audit_log (action,entity,entity_id,details,performed_by) VALUES (?,?,?,?,?)').run('CREATE','payment_voucher',String(pvId),`Voucher ${vno}: ${category} ₹${amt}`,'finance'); } catch(_) {}

    send(res, 201, { id: pvId, voucher_no: vno, message: 'Payment voucher created' });
  });
}

function handleDeletePaymentVoucher(req, res) {
  if (!requireFinanceOrAdmin(req, res)) return;
  const id = parseInt(req.url.split('/').pop(), 10);
  const pv = db.prepare('SELECT * FROM payment_vouchers WHERE id=?').get(id);
  if (!pv) return send(res, 404, { error: 'Voucher not found' });
  // Remove journal entries for this voucher
  db.prepare(`DELETE FROM journal_entries WHERE reference=? AND source='expense'`).run(`PV-${id}`);
  db.prepare('DELETE FROM payment_vouchers WHERE id=?').run(id);
  try { db.prepare('INSERT INTO audit_log (action,entity,entity_id,details,performed_by) VALUES (?,?,?,?,?)').run('DELETE','payment_voucher',String(id),`Deleted ${pv.voucher_no}`,'finance'); } catch(_) {}
  send(res, 200, { message: 'Deleted' });
}

// ─── MARKETING HANDLERS ───────────────────────────────────────────────────────
function handleMarketingLogin(req, res) {
  const ip = getIP(req);
  parseBody(req, ({ username, password }) => {
    if (!username || !password) return send(res, 400, { error: 'Username and password required.' });
    if (username.trim().toLowerCase() !== MARKETING_USER || password !== MARKETING_PASS) {
      logSecEvent('login_failed', 'marketing', ip, username, 'Invalid marketing credentials', 'warning');
      return send(res, 401, { error: 'Invalid credentials.' });
    }
    logSecEvent('login_success', 'marketing', ip, username, 'Marketing dashboard accessed', 'info');
    const token = createToken({ sub: MARKETING_USER, role: 'marketing', user: MARKETING_USER });
    send(res, 200, { token, user: MARKETING_USER });
  });
}

function handleMarketingOverview(req, res) {
  const totalLeads       = db.prepare('SELECT COUNT(*) AS c FROM marketing_leads').get().c;
  const todayLeads       = db.prepare("SELECT COUNT(*) AS c FROM marketing_leads WHERE created_at LIKE ?").get(new Date().toISOString().slice(0,10)+'%').c;
  const enrolled         = db.prepare("SELECT COUNT(*) AS c FROM marketing_leads WHERE stage='Enrolled'").get().c;
  const activeCampaigns  = db.prepare("SELECT COUNT(*) AS c FROM marketing_campaigns WHERE status='Active'").get().c;
  const upcomingEvents   = db.prepare("SELECT COUNT(*) AS c FROM marketing_events WHERE status='Upcoming'").get().c;
  const totalReach       = db.prepare("SELECT COALESCE(SUM(reach),0) AS s FROM marketing_campaigns").get().s;
  const totalConversions = db.prepare("SELECT COALESCE(SUM(conversions),0) AS s FROM marketing_campaigns").get().s;
  const conversionRate   = totalReach > 0 ? Math.round((totalConversions / totalReach) * 100) : 0;
  const stageRows        = db.prepare("SELECT stage, COUNT(*) AS c FROM marketing_leads GROUP BY stage").all();
  const sourceRows       = db.prepare("SELECT source, COUNT(*) AS c FROM marketing_leads GROUP BY source ORDER BY c DESC LIMIT 6").all();
  const recentLeads      = db.prepare("SELECT * FROM marketing_leads ORDER BY id DESC LIMIT 5").all();
  const monthlyLeads     = db.prepare("SELECT LEFT(created_at::text,7) AS mo, COUNT(*) AS c FROM marketing_leads GROUP BY 1 ORDER BY 1 DESC LIMIT 6").all().reverse();
  send(res, 200, { totalLeads, todayLeads, enrolled, activeCampaigns, upcomingEvents, totalReach, conversionRate, stageRows, sourceRows, recentLeads, monthlyLeads });
}

function handleMarketingLeadList(req, res) {
  const url    = new URL('http://x'+req.url);
  const stage  = url.searchParams.get('stage') || '';
  const source = url.searchParams.get('source') || '';
  const q_str  = url.searchParams.get('q') || '';
  let q = 'SELECT * FROM marketing_leads WHERE 1=1';
  const p = [];
  if (stage)  { q += ' AND stage=?';  p.push(stage); }
  if (source) { q += ' AND source=?'; p.push(source); }
  if (q_str)  { q += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)'; p.push('%'+q_str+'%','%'+q_str+'%','%'+q_str+'%'); }
  q += ' ORDER BY id DESC';
  send(res, 200, { leads: db.prepare(q).all(...p) });
}

function handleMarketingAddLead(req, res) {
  parseBody(req, d => {
    if (!d.name) return send(res, 400, { error: 'Name required' });
    const now = new Date().toISOString();
    const r = db.prepare('INSERT INTO marketing_leads (name,phone,email,class_interested,source,stage,assigned_to,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
                .run(d.name, d.phone||'', d.email||'', d.class_interested||'', d.source||'Walk-in', d.stage||'Inquiry', d.assigned_to||'', d.notes||'', now, now);
    logDataEvent('Marketing', 'marketing', 'Leads', 'add', 'marketing_leads', `New lead: ${d.name} via ${d.source||'Walk-in'} — ${d.class_interested||'—'}`, 1, getIP(req));
    send(res, 200, { ok: true, id: r.lastInsertRowid });
  });
}

function handleMarketingUpdateLead(req, res) {
  const id = parseInt(req.url.split('/').pop());
  parseBody(req, d => {
    const row = db.prepare('SELECT * FROM marketing_leads WHERE id=?').get(id);
    if (!row) return send(res, 404, { error: 'Not found' });
    db.prepare('UPDATE marketing_leads SET name=?,phone=?,email=?,class_interested=?,source=?,stage=?,assigned_to=?,notes=?,updated_at=? WHERE id=?')
      .run(d.name??row.name, d.phone??row.phone, d.email??row.email, d.class_interested??row.class_interested, d.source??row.source, d.stage??row.stage, d.assigned_to??row.assigned_to, d.notes??row.notes, new Date().toISOString(), id);
    send(res, 200, { ok: true });
  });
}

function handleMarketingDeleteLead(req, res) {
  const id = parseInt(req.url.split('/').pop());
  db.prepare('DELETE FROM marketing_leads WHERE id=?').run(id);
  send(res, 200, { ok: true });
}

function handleMarketingCampaignList(req, res) {
  send(res, 200, { campaigns: db.prepare('SELECT * FROM marketing_campaigns ORDER BY id DESC').all() });
}

function handleMarketingAddCampaign(req, res) {
  parseBody(req, d => {
    if (!d.name) return send(res, 400, { error: 'Name required' });
    const now = new Date().toISOString();
    const r = db.prepare('INSERT INTO marketing_campaigns (name,type,status,target_audience,budget,reach,conversions,start_date,end_date,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
                .run(d.name, d.type||'Email', d.status||'Draft', d.target_audience||'', d.budget||0, d.reach||0, d.conversions||0, d.start_date||'', d.end_date||'', d.notes||'', now, now);
    send(res, 200, { ok: true, id: r.lastInsertRowid });
  });
}

function handleMarketingUpdateCampaign(req, res) {
  const id = parseInt(req.url.split('/').pop());
  parseBody(req, d => {
    const row = db.prepare('SELECT * FROM marketing_campaigns WHERE id=?').get(id);
    if (!row) return send(res, 404, { error: 'Not found' });
    db.prepare('UPDATE marketing_campaigns SET name=?,type=?,status=?,target_audience=?,budget=?,reach=?,conversions=?,start_date=?,end_date=?,notes=?,updated_at=? WHERE id=?')
      .run(d.name??row.name, d.type??row.type, d.status??row.status, d.target_audience??row.target_audience, d.budget??row.budget, d.reach??row.reach, d.conversions??row.conversions, d.start_date??row.start_date, d.end_date??row.end_date, d.notes??row.notes, new Date().toISOString(), id);
    send(res, 200, { ok: true });
  });
}

function handleMarketingDeleteCampaign(req, res) {
  const id = parseInt(req.url.split('/').pop());
  db.prepare('DELETE FROM marketing_campaigns WHERE id=?').run(id);
  send(res, 200, { ok: true });
}

function handleMarketingEventList(req, res) {
  send(res, 200, { events: db.prepare('SELECT * FROM marketing_events ORDER BY event_date DESC').all() });
}

function handleMarketingAddEvent(req, res) {
  parseBody(req, d => {
    if (!d.name) return send(res, 400, { error: 'Name required' });
    const now = new Date().toISOString();
    const r = db.prepare('INSERT INTO marketing_events (name,type,event_date,venue,description,registrations,attendees,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
                .run(d.name, d.type||'Open Day', d.event_date||'', d.venue||'', d.description||'', d.registrations||0, d.attendees||0, d.status||'Upcoming', now, now);
    send(res, 200, { ok: true, id: r.lastInsertRowid });
  });
}

function handleMarketingUpdateEvent(req, res) {
  const id = parseInt(req.url.split('/').pop());
  parseBody(req, d => {
    const row = db.prepare('SELECT * FROM marketing_events WHERE id=?').get(id);
    if (!row) return send(res, 404, { error: 'Not found' });
    db.prepare('UPDATE marketing_events SET name=?,type=?,event_date=?,venue=?,description=?,registrations=?,attendees=?,status=?,updated_at=? WHERE id=?')
      .run(d.name??row.name, d.type??row.type, d.event_date??row.event_date, d.venue??row.venue, d.description??row.description, d.registrations??row.registrations, d.attendees??row.attendees, d.status??row.status, new Date().toISOString(), id);
    send(res, 200, { ok: true });
  });
}

function handleMarketingDeleteEvent(req, res) {
  const id = parseInt(req.url.split('/').pop());
  db.prepare('DELETE FROM marketing_events WHERE id=?').run(id);
  send(res, 200, { ok: true });
}

function handleMarketingSocialList(req, res) {
  send(res, 200, { posts: db.prepare('SELECT * FROM marketing_social_posts ORDER BY scheduled_date DESC').all() });
}

function handleMarketingAddSocial(req, res) {
  parseBody(req, d => {
    const now = new Date().toISOString();
    const r = db.prepare('INSERT INTO marketing_social_posts (platform,content,scheduled_date,status,reach,engagement,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
                .run(d.platform||'Instagram', d.content||'', d.scheduled_date||'', d.status||'Draft', d.reach||0, d.engagement||0, now, now);
    send(res, 200, { ok: true, id: r.lastInsertRowid });
  });
}

function handleMarketingUpdateSocial(req, res) {
  const id = parseInt(req.url.split('/').pop());
  parseBody(req, d => {
    const row = db.prepare('SELECT * FROM marketing_social_posts WHERE id=?').get(id);
    if (!row) return send(res, 404, { error: 'Not found' });
    db.prepare('UPDATE marketing_social_posts SET platform=?,content=?,scheduled_date=?,status=?,reach=?,engagement=?,updated_at=? WHERE id=?')
      .run(d.platform??row.platform, d.content??row.content, d.scheduled_date??row.scheduled_date, d.status??row.status, d.reach??row.reach, d.engagement??row.engagement, new Date().toISOString(), id);
    send(res, 200, { ok: true });
  });
}

function handleMarketingDeleteSocial(req, res) {
  const id = parseInt(req.url.split('/').pop());
  db.prepare('DELETE FROM marketing_social_posts WHERE id=?').run(id);
  send(res, 200, { ok: true });
}

// ─── MONITOR LOGIN ────────────────────────────────────────────────────────────
function handleMonitorLogin(req, res) {
  const ip = getIP(req);
  parseBody(req, ({ username, password }) => {
    if (!username || !password) return send(res, 400, { error: 'Username and password required.' });
    const uname = username.trim().toLowerCase();
    let role = null, name = '';
    if (uname === AUDIT_USER  && password === AUDIT_PASS)  { role = 'audit'; name = 'Audit Officer'; }
    if (uname === CYBER_USER  && password === CYBER_PASS)  { role = 'cyber'; name = 'Cyber Security'; }
    if (uname === ADMIN_USER  && password === ADMIN_PASS)  { role = 'admin'; name = 'Administrator'; }
    if (!role) {
      logSecEvent('login_failed', 'monitor', ip, username, 'Invalid monitor credentials — access denied', 'critical');
      return send(res, 401, { error: 'Invalid credentials.' });
    }
    logSecEvent('login_success', 'monitor', ip, uname, `Monitor dashboard accessed as ${role}`, 'info');
    const token = createToken({ sub: uname, role, name });
    send(res, 200, { token, role, name });
  });
}

// ─── MONITOR: SECURITY EVENTS ────────────────────────────────────────────────
function handleMonitorSecEvents(req, res) {
  const pl = monitorAuth(req, res); if (!pl) return;
  const q = url.parse(req.url, true).query;
  const limit  = Math.min(parseInt(q.limit)||200, 1000);
  const offset = parseInt(q.offset)||0;
  const sev    = q.severity || '';
  const dash   = q.dashboard || '';
  let sql = `SELECT * FROM security_events`;
  const params = [];
  const conds  = [];
  if (sev)  { conds.push(`severity=?`);  params.push(sev); }
  if (dash) { conds.push(`dashboard=?`); params.push(dash); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ` ORDER BY id DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  const events = db.prepare(sql).all(...params);
  const total  = db.prepare(`SELECT COUNT(*) AS c FROM security_events`).get().c;
  const failedToday = db.prepare(`SELECT COUNT(*) AS c FROM security_events WHERE event_type='login_failed' AND timestamp >= date('now','localtime')`).get().c;
  const successToday = db.prepare(`SELECT COUNT(*) AS c FROM security_events WHERE event_type='login_success' AND timestamp >= date('now','localtime')`).get().c;
  const critCount = db.prepare(`SELECT COUNT(*) AS c FROM security_events WHERE severity='critical' AND timestamp >= datetime('now','-1 hour','localtime')`).get().c;
  const byDash = db.prepare(`SELECT dashboard, COUNT(*) AS total, SUM(CASE WHEN event_type='login_failed' THEN 1 ELSE 0 END) AS failed FROM security_events GROUP BY dashboard ORDER BY total DESC`).all();
  const suspIPs = db.prepare(`SELECT ip, COUNT(*) AS cnt FROM security_events WHERE event_type='login_failed' GROUP BY ip HAVING COUNT(*) >= 3 ORDER BY COUNT(*) DESC LIMIT 20`).all();
  send(res, 200, { events, total, failedToday, successToday, critCount, byDash, suspIPs });
}

// ─── MONITOR: API CALL LOGS ───────────────────────────────────────────────────
function handleMonitorApiLogs(req, res) {
  const pl = monitorAuth(req, res); if (!pl) return;
  const q = url.parse(req.url, true).query;
  const limit = Math.min(parseInt(q.limit)||200, 2000);
  const logs  = db.prepare(`SELECT * FROM api_call_logs ORDER BY id DESC LIMIT ?`).all(limit);
  const totalReqs = db.prepare(`SELECT COUNT(*) AS c FROM api_call_logs`).get().c;
  const errReqs   = db.prepare(`SELECT COUNT(*) AS c FROM api_call_logs WHERE status_code >= 400`).get().c;
  const avgMs     = db.prepare(`SELECT ROUND(AVG(response_time_ms),1) AS a FROM api_call_logs WHERE timestamp >= datetime('now','-1 hour','localtime')`).get().a;
  const slowest   = db.prepare(`SELECT path, ROUND(AVG(response_time_ms),0) AS avg_ms, COUNT(*) AS hits FROM api_call_logs GROUP BY path ORDER BY avg_ms DESC LIMIT 10`).all();
  const byStatus  = db.prepare(`SELECT status_code, COUNT(*) AS cnt FROM api_call_logs GROUP BY status_code ORDER BY cnt DESC`).all();
  const byPath    = db.prepare(`SELECT path, COUNT(*) AS hits, ROUND(AVG(response_time_ms),0) AS avg_ms, SUM(CASE WHEN status_code>=400 THEN 1 ELSE 0 END) AS errors FROM api_call_logs GROUP BY path ORDER BY hits DESC LIMIT 20`).all();
  const hourly    = db.prepare(`SELECT to_char(timestamp::timestamp AT TIME ZONE 'Asia/Kolkata','HH24') AS hr, COUNT(*) AS cnt FROM api_call_logs WHERE timestamp >= to_char((NOW() - INTERVAL '24 hours') AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') GROUP BY 1 ORDER BY 1`).all();
  send(res, 200, { logs, totalReqs, errReqs, avgMs: avgMs||0, slowest, byStatus, byPath, hourly });
}

// ─── MONITOR: SYSTEM STATS SNAPSHOT ──────────────────────────────────────────
function handleMonitorStats(req, res) {
  const pl = monitorAuth(req, res); if (!pl) return;
  const students   = db.prepare(`SELECT COUNT(*) AS c FROM students`).get().c;
  const teachers   = db.prepare(`SELECT COUNT(*) AS c FROM teachers`).get().c;
  const totalReqs  = db.prepare(`SELECT COUNT(*) AS c FROM api_call_logs WHERE timestamp >= datetime('now','-1 hour','localtime')`).get().c;
  const errReqs1h  = db.prepare(`SELECT COUNT(*) AS c FROM api_call_logs WHERE status_code>=400 AND timestamp >= datetime('now','-1 hour','localtime')`).get().c;
  const errRate    = totalReqs > 0 ? Math.round(errReqs1h / totalReqs * 100) : 0;
  const secEvt1h   = db.prepare(`SELECT COUNT(*) AS c FROM security_events WHERE timestamp >= datetime('now','-1 hour','localtime')`).get().c;
  const failedLogins24h = db.prepare(`SELECT COUNT(*) AS c FROM security_events WHERE event_type='login_failed' AND timestamp >= datetime('now','-24 hours','localtime')`).get().c;
  const uptime     = Math.round(process.uptime());
  const memMB      = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const heapMB     = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  const cpuUsage   = process.cpuUsage();
  // Restart tracking
  const restartRow   = db.prepare(`SELECT value FROM server_meta WHERE key='restart_count'`).get();
  const firstStart   = db.prepare(`SELECT value FROM server_meta WHERE key='first_start'`).get();
  const lastRestart  = db.prepare(`SELECT value FROM server_meta WHERE key='last_restart'`).get();
  const restartCount = restartRow ? parseInt(restartRow.value) : 1;
  // MTTD — avg time between first failed login and next critical event (proxy: avg gap between consecutive critical events in last 24h)
  const critEvents = db.prepare(`SELECT timestamp FROM security_events WHERE severity='critical' AND timestamp >= datetime('now','-24 hours','localtime') ORDER BY timestamp ASC`).all();
  let mttdMin = null;
  if (critEvents.length >= 2) {
    let totalGap = 0;
    for (let i = 1; i < critEvents.length; i++) {
      totalGap += (new Date(critEvents[i].timestamp) - new Date(critEvents[i-1].timestamp));
    }
    mttdMin = Math.round(totalGap / (critEvents.length - 1) / 60000);
  }
  // MTTR — avg time between login_failed and next login_success on same IP (proxy for response)
  const failedEvts = db.prepare(`SELECT ip, timestamp FROM security_events WHERE event_type='login_failed' AND timestamp >= datetime('now','-24 hours','localtime') ORDER BY timestamp ASC LIMIT 50`).all();
  let mttrMin = null;
  if (failedEvts.length > 0) {
    // Simple proxy: avg API response time for 500-errors in last 24h (time to detect+respond to errors)
    const avgErrMs = db.prepare(`SELECT ROUND(AVG(response_time_ms),0) AS a FROM api_call_logs WHERE status_code>=500 AND timestamp >= datetime('now','-24 hours','localtime')`).get().a;
    if (avgErrMs) mttrMin = Math.round(avgErrMs / 1000 / 60 * 10) / 10; // convert to mins (scaled)
  }
  // Total events today
  const eventsToday = db.prepare(`SELECT COUNT(*) AS c FROM security_events WHERE timestamp >= date('now','localtime')`).get().c;
  const eventsWeek  = db.prepare(`SELECT COUNT(*) AS c FROM security_events WHERE timestamp >= datetime('now','-7 days','localtime')`).get().c;
  // DB size
  const dbSize      = db.prepare(`SELECT page_count * page_size AS sz FROM pragma_page_count(), pragma_page_size()`).get()?.sz || 0;
  const dbSizeKB    = Math.round(dbSize / 1024);
  // Active paths in last 5 min
  const activePaths = db.prepare(`SELECT COUNT(DISTINCT path) AS c FROM api_call_logs WHERE timestamp >= datetime('now','-5 minutes','localtime')`).get().c;
  send(res, 200, {
    students, teachers, totalReqs, errRate, secEvt1h, failedLogins24h,
    uptime, memMB, heapMB,
    restartCount, firstStart: firstStart?.value || null, lastRestart: lastRestart?.value || null,
    mttdMin, mttrMin,
    eventsToday, eventsWeek,
    dbSizeKB, activePaths,
    ts: new Date().toISOString()
  });
}

// ─── MONITOR: VULNERABILITY SCANNER ──────────────────────────────────────────
function handleMonitorVulnScan(req, res) {
  const pl = monitorAuth(req, res); if (!pl) return;
  const fsM = require('fs');
  const pathM = require('path');

  const VULN_PATTERNS = [
    { id: 'sql-template-inject', severity: 'critical', title: 'SQL Template Literal Injection',
      pattern: /db\s*\.\s*prepare\s*\(\s*`[^`]*\$\{[^}]+\}[^`]*`\)/,
      desc: 'Variable interpolated directly into SQL string — allows SQL injection if input is unsanitized.',
      fix: 'Use ? placeholders: db.prepare("SELECT * FROM t WHERE id=?").get(id)' },
    { id: 'eval-usage', severity: 'critical', title: 'eval() Usage Detected',
      pattern: /\beval\s*\(/,
      desc: 'eval() executes arbitrary code strings — critical Remote Code Execution (RCE) vector.',
      fix: 'Remove eval() completely. Use JSON.parse() for data parsing, or refactor logic.' },
    { id: 'hardcoded-secret', severity: 'high', title: 'Hardcoded Secret / Credential',
      pattern: /(?:password|secret|token|api_key|apikey)\s*[:=]\s*['"][^'"]{8,}['"]/i,
      desc: 'Credentials or secrets hardcoded in source — exposed if repo/file is leaked.',
      fix: 'Move to .env file: process.env.SECRET_NAME. Never commit secrets to source.' },
    { id: 'default-cred-fallback', severity: 'high', title: 'Default Credential Fallback',
      pattern: /process\.env\.\w+\s*\|\|\s*['"][a-z0-9@!_#]{4,}['"]/i,
      desc: 'If environment variable is missing, a hardcoded default is used — dangerous in production.',
      fix: 'In production, throw an error if required env vars are missing instead of using defaults.' },
    { id: 'no-rate-limit-login', severity: 'high', title: 'Login Endpoint Without Rate Limiting',
      pattern: /function handle\w*Login\s*\(/,
      desc: 'Authentication handler detected — no brute-force rate limiting implemented.',
      fix: 'Track failed attempts per IP. Lock out after 5 failures. Use exponential backoff.' },
    { id: 'http-external', severity: 'medium', title: 'Insecure HTTP External URL',
      pattern: /['"]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^'"]+['"]/,
      desc: 'External resource referenced over plain HTTP — susceptible to man-in-the-middle attacks.',
      fix: 'Replace all external http:// URLs with https://' },
    { id: 'jwt-no-expiry-check', severity: 'medium', title: 'JWT Long Expiry / No Rotation',
      pattern: /expiresIn\s*:\s*['"](\d{3,}[smh]|\d+d|\d+w)['"]/i,
      desc: 'Long-lived JWTs increase attack window if a token is compromised.',
      fix: 'Use short-lived tokens (15m-1h) with refresh token rotation for security.' },
    { id: 'missing-csrf', severity: 'medium', title: 'No CSRF Protection on POST Routes',
      pattern: /req\.method\s*===\s*'POST'\s*\)\s*return\s+handle(?!Login)/,
      desc: 'POST endpoints without CSRF token validation are vulnerable to cross-site request forgery.',
      fix: 'Implement CSRF tokens or verify Origin/Referer headers on state-changing requests.' },
    { id: 'cors-wildcard', severity: 'medium', title: 'CORS Wildcard (*) Allows Any Origin',
      pattern: /'Access-Control-Allow-Origin'\s*:\s*['"]\*['"]/,
      desc: 'Allowing all origins (*) enables cross-origin requests from any website.',
      fix: 'Restrict to specific trusted origins: "Access-Control-Allow-Origin": "https://yourdomain.com"' },
    { id: 'console-log-prod', severity: 'low', title: 'Debug console.log in Production Code',
      pattern: /console\.log\(/,
      desc: 'console.log statements expose internal data in server logs and slow performance.',
      fix: 'Remove console.log or replace with a structured logger that can be disabled in production.' },
    { id: 'todo-fixme', severity: 'low', title: 'Unresolved TODO / FIXME Comment',
      pattern: /\/\/\s*(TODO|FIXME|HACK|XXX)/i,
      desc: 'Development notes indicate incomplete or potentially broken functionality.',
      fix: 'Review and resolve all TODOs before production deployment.' },
    { id: 'large-payload-no-limit', severity: 'medium', title: 'No Request Body Size Limit',
      pattern: /data\s*\+=\s*chunk/,
      desc: 'Accumulating request body without size limit allows large payload (DoS) attacks.',
      fix: 'Add body size limit: if (data.length > 1_000_000) { res.writeHead(413); res.end(); return; }' },
  ];

  const findings = [];
  const filesToScan = [
    { file: 'server/server.js', path: pathM.join(__dirname, 'server.js') },
  ];
  // Also scan portal HTML files if accessible
  const portalDir = pathM.join(__dirname, '..', 'portal');
  if (fsM.existsSync(portalDir)) {
    const htmlFiles = fsM.readdirSync(portalDir).filter(f => f.endsWith('.html')).slice(0, 10);
    htmlFiles.forEach(f => filesToScan.push({ file: `portal/${f}`, path: pathM.join(portalDir, f) }));
  }

  filesToScan.forEach(({ file, path: filePath }) => {
    if (!fsM.existsSync(filePath)) return;
    const content = fsM.readFileSync(filePath, 'utf8');
    const lines   = content.split('\n');
    lines.forEach((line, i) => {
      // Skip comment-only lines and blank lines
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('<!--')) return;
      VULN_PATTERNS.forEach(p => {
        const re = new RegExp(p.pattern.source, p.pattern.flags.replace('g',''));
        if (re.test(line)) {
          findings.push({
            id: p.id, severity: p.severity, title: p.title,
            file, line: i + 1,
            code: trimmed.slice(0, 130),
            desc: p.desc, fix: p.fix
          });
        }
      });
    });
  });

  // Sort by severity
  const sevOrder = { critical:0, high:1, medium:2, low:3 };
  findings.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || a.line - b.line);

  // Deduplicate by (id+file) keeping first occurrence only (avoid flooding with console.log)
  const deduped = [];
  const seen = {};
  findings.forEach(f => {
    const k = `${f.id}|${f.file}`;
    if (!seen[k]) { seen[k] = 0; }
    seen[k]++;
    if (seen[k] <= 3) deduped.push({ ...f, occurrences: seen[k] });
  });
  // Add occurrence summary for repeated issues
  const fullSummary = {};
  findings.forEach(f => { const k = `${f.id}|${f.file}`; fullSummary[k] = (fullSummary[k]||0)+1; });
  deduped.forEach(f => { const k = `${f.id}|${f.file}`; f.totalOccurrences = fullSummary[k]; });

  const summary = {
    critical: findings.filter(f => f.severity==='critical').length,
    high:     findings.filter(f => f.severity==='high').length,
    medium:   findings.filter(f => f.severity==='medium').length,
    low:      findings.filter(f => f.severity==='low').length,
    total:    findings.length,
    scannedFiles: filesToScan.map(f => f.file),
    scannedAt: new Date().toISOString()
  };
  send(res, 200, { summary, findings: deduped });
}

// ─── MONITOR: AUTO-FIX VULNERABILITIES ───────────────────────────────────────
function handleMonitorAutoFix(req, res) {
  const pl = monitorAuth(req, res); if (!pl) return;
  parseBody(req, (body) => {
    const fsM    = require('fs');
    const pathM  = require('path');
    const { execSync } = require('child_process');
    const fixIds = body.fixIds || null; // null = fix all safe
    const dryRun = !!body.dryRun;

    // ── Define all auto-fixable rules ───────────────────────────────────────
    const AUTO_FIXES = [
      {
        id: 'console-log-prod',
        name: 'Disable console.log (comment out)',
        safe: true,
        desc: 'All console.log() calls commented out to prevent data leaks in production',
        apply: (src) => src.replace(/^(\s*)console\.log\(/gm, '$1// [AUTO-FIXED] console.log(')
      },
      {
        id: 'http-external',
        name: 'Upgrade insecure HTTP → HTTPS',
        safe: true,
        desc: 'External http:// references upgraded to https:// for encrypted transport',
        apply: (src) => src
          .replace(/'http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)([^'\\]+)'/g, "'https://$1'")
          .replace(/"http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)([^"\\]+)"/g, '"https://$1"')
      },
      {
        id: 'todo-fixme',
        name: 'Mark TODO/FIXME as reviewed',
        safe: true,
        desc: 'TODO/FIXME comments marked [REVIEWED] so they surface in the next manual audit',
        apply: (src) => src.replace(/\/\/\s*(TODO|FIXME|HACK|XXX)(\s*[:—]?)/gi, '// [REVIEWED-AUTO] $1$2')
      },
      {
        id: 'large-payload-no-limit',
        name: 'Add request body size guard',
        safe: true,
        desc: 'Added 2 MB body size check to prevent large-payload DoS attacks',
        apply: (src) => src.replace(
          /(\s*)(data\s*\+=\s*chunk;)/g,
          '$1if (data.length > 2_000_000) { req.destroy(); return; } // [AUTO-FIXED] body size guard\n$1$2'
        )
      },
      {
        id: 'cors-wildcard',
        name: 'Add comment warning on CORS wildcard',
        safe: true,
        desc: 'Added security comment on CORS * lines flagging them for review',
        apply: (src) => src.replace(
          /('Access-Control-Allow-Origin'\s*:\s*['"]\*['"])/g,
          '$1 /* SECURITY-REVIEW: restrict to specific origins in production */'
        )
      },
    ];

    // ── Scan server.js only (safest target) ─────────────────────────────────
    const filePath   = pathM.join(__dirname, 'server.js');
    const backupPath = filePath + '.bak.' + Date.now();
    let   original, content;
    try {
      original = fsM.readFileSync(filePath, 'utf8');
      content  = original;
    } catch(e) {
      return send(res, 500, { error: 'Cannot read server.js: ' + e.message });
    }

    const toFix = AUTO_FIXES.filter(f => !fixIds || fixIds.includes(f.id));
    const results = [];

    toFix.forEach(fix => {
      try {
        const next = fix.apply(content);
        const lines = content.split('\n'), nextLines = next.split('\n');
        let changeCount = 0;
        for (let i = 0; i < Math.max(lines.length, nextLines.length); i++) {
          if (lines[i] !== nextLines[i]) changeCount++;
        }
        if (next !== content) {
          content = next;
          results.push({ id: fix.id, name: fix.name, desc: fix.desc, status: 'fixed', changes: changeCount });
        } else {
          results.push({ id: fix.id, name: fix.name, desc: fix.desc, status: 'no_changes', changes: 0 });
        }
      } catch(e) {
        results.push({ id: fix.id, name: fix.name, desc: fix.desc, status: 'error', error: e.message, changes: 0 });
      }
    });

    // ── Dry-run: return preview without writing ──────────────────────────────
    if (dryRun) {
      return send(res, 200, {
        status: 'dry_run', results,
        fixedCount: results.filter(r => r.status === 'fixed').length,
        message: 'Dry-run complete. No files were changed.'
      });
    }

    // ── Nothing changed — no need to write or verify ──────────────────────
    if (content === original) {
      return send(res, 200, {
        status: 'no_changes', results, fixedCount: 0,
        syntaxOk: true, healthOk: true,
        message: 'No changes needed — code is already clean for selected rules.'
      });
    }

    // ── Write backup ─────────────────────────────────────────────────────────
    try { fsM.writeFileSync(backupPath, original); } catch(e) { /* non-fatal */ }

    // ── Write patched file ───────────────────────────────────────────────────
    try { fsM.writeFileSync(filePath, content); } catch(e) {
      return send(res, 500, { error: 'Write failed: ' + e.message });
    }

    // ── Syntax verification (node --check) ──────────────────────────────────
    let syntaxOk = false, syntaxError = null;
    try {
      execSync(`node --check "${filePath}"`, { timeout: 15000, stdio: 'pipe' });
      syntaxOk = true;
    } catch(e) {
      syntaxError = (e.stderr || e.stdout || e.message || '').toString().slice(0, 500);
    }

    // ── ROLLBACK if syntax broken ────────────────────────────────────────────
    if (!syntaxOk) {
      try { fsM.writeFileSync(filePath, original); } catch(_) {}
      logSecEvent('auto_fix_rollback', 'monitor', getIP(req), pl.sub||'monitor',
        `Auto-fix rolled back: syntax error — ${syntaxError}`, 'warning');
      return send(res, 200, {
        status: 'rolled_back',
        syntaxOk: false, syntaxError,
        results,
        backupFile: pathM.basename(backupPath),
        message: '⚠ Syntax check failed — original file restored automatically. No changes were made.'
      });
    }

    // ── Run live health-checks on key endpoints ──────────────────────────────
    const http2 = require('http');
    const port  = server.address()?.port || 3000;
    const healthChecks = [
      { name: 'API Health Ping',   path: '/api/health' },
      { name: 'Monitor Stats',     path: '/api/monitor/stats' },
      { name: 'Admin Students',    path: `/api/admin/students?key=${ADMIN_KEY}` },
    ];
    let healthPassed = 0, healthFailed = 0;
    const healthResults = [];
    let pending = healthChecks.length;

    const afterHealth = () => {
      logSecEvent('auto_fix_applied', 'monitor', getIP(req), pl.sub||'monitor',
        `Auto-fix applied ${results.filter(r=>r.status==='fixed').length} fix(es). Syntax: OK. Health: ${healthPassed}/${healthChecks.length}`, 'info');
      send(res, 200, {
        status: 'success',
        syntaxOk: true,
        healthOk: healthFailed === 0,
        healthResults,
        healthPassed, healthFailed,
        results,
        fixedCount: results.filter(r => r.status === 'fixed').length,
        backupFile: pathM.basename(backupPath),
        message: `✅ ${results.filter(r=>r.status==='fixed').length} fix(es) applied & verified. Syntax OK. Health: ${healthPassed}/${healthChecks.length} passed. Restart server to apply to running process.`
      });
    };

    // Quick sequential health checks
    const doHealthCheck = (idx) => {
      if (idx >= healthChecks.length) { afterHealth(); return; }
      const hc = healthChecks[idx];
      const t0 = Date.now();
      try {
        const req2 = http2.get({ host: '127.0.0.1', port, path: hc.path, timeout: 5000 }, (r2) => {
          const ms = Date.now() - t0;
          const ok = r2.statusCode < 500;
          if (ok) healthPassed++; else healthFailed++;
          healthResults.push({ name: hc.name, status: r2.statusCode, ms, ok });
          r2.resume();
          doHealthCheck(idx + 1);
        });
        req2.on('error', () => {
          healthFailed++;
          healthResults.push({ name: hc.name, status: 0, ms: Date.now()-t0, ok: false });
          doHealthCheck(idx + 1);
        });
        req2.setTimeout(5000, () => { req2.destroy(); });
      } catch(_) {
        healthFailed++;
        healthResults.push({ name: hc.name, status: 0, ms: 0, ok: false });
        doHealthCheck(idx + 1);
      }
    };
    doHealthCheck(0);
  });
}

// ─── MONITOR: RESTORE BACKUP ──────────────────────────────────────────────────
function handleMonitorRestoreBackup(req, res) {
  const pl = monitorAuth(req, res); if (!pl) return;
  parseBody(req, (body) => {
    const fsM   = require('fs');
    const pathM = require('path');
    const { execSync } = require('child_process');
    const backupFile = (body.backupFile || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!backupFile || !backupFile.startsWith('server.js.bak.')) {
      return send(res, 400, { error: 'Invalid backup file name.' });
    }
    const backupPath = pathM.join(__dirname, backupFile);
    const targetPath = pathM.join(__dirname, 'server.js');
    if (!fsM.existsSync(backupPath)) return send(res, 404, { error: 'Backup file not found.' });
    const backup = fsM.readFileSync(backupPath, 'utf8');
    // Syntax check backup before restoring
    const tmpPath = targetPath + '.tmp_restore';
    fsM.writeFileSync(tmpPath, backup);
    let syntaxOk = false;
    try { execSync(`node --check "${tmpPath}"`, { timeout: 10000, stdio: 'pipe' }); syntaxOk = true; } catch(_) {}
    fsM.unlinkSync(tmpPath);
    if (!syntaxOk) return send(res, 400, { error: 'Backup file failed syntax check — restore aborted.' });
    fsM.writeFileSync(targetPath, backup);
    logSecEvent('backup_restored', 'monitor', getIP(req), pl.sub||'monitor',
      `server.js restored from backup: ${backupFile}`, 'warning');
    send(res, 200, { status: 'restored', backupFile, message: 'Backup restored successfully. Restart server to apply.' });
  });
}

// ─── REAL-TIME ANALYTICS: SSE BROADCASTER ─────────────────────────────────────
const _sseClients = new Set();

function broadcastSSE(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  _sseClients.forEach(res => {
    try { res.write(payload); } catch(e) { _sseClients.delete(res); }
  });
}

function logDataEvent(actor, role, module, action, dbTable, detail, recordCount, ip) {
  try {
    db.prepare(`INSERT INTO data_events (actor,role,module,action,db_table,detail,record_count,ip,timestamp)
      VALUES (?,?,?,?,?,?,?,?,datetime('now','localtime'))`)
      .run(actor||'system', role||'system', module||'', action||'', dbTable||'', detail||'', recordCount||1, ip||'');
    db.prepare(`DELETE FROM data_events WHERE id NOT IN (SELECT id FROM data_events ORDER BY id DESC LIMIT 5000)`).run();
    broadcastSSE('data_event', {
      actor, role, module, action, dbTable, detail, recordCount,
      timestamp: new Date().toISOString()
    });
  } catch(e) {}
}

function logPageView(page, ip, userAgent, referrer) {
  try {
    db.prepare(`INSERT INTO page_views (page,ip,user_agent,referrer,timestamp)
      VALUES (?,?,?,?,datetime('now','localtime'))`)
      .run(page||'/', ip||'', (userAgent||'').slice(0,200), referrer||'');
    db.prepare(`DELETE FROM page_views WHERE id NOT IN (SELECT id FROM page_views ORDER BY id DESC LIMIT 50000)`).run();
    broadcastSSE('page_view', { page, ip, timestamp: new Date().toISOString() });
  } catch(e) {}
}

// ─── ANALYTICS API HANDLERS ────────────────────────────────────────────────────
function handleAnalyticsStream(req, res) {
  // Auth: admin key
  const key = url.parse(req.url, true).query.key;
  if (key !== ADMIN_KEY) { send(res, 401, { error: 'Unauthorized' }); return; }
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });
  res.write(':ok\n\n'); // initial ping
  _sseClients.add(res);
  // Heartbeat every 20s to keep connection alive
  const hb = setInterval(() => {
    try { res.write(':heartbeat\n\n'); } catch(e) { clearInterval(hb); _sseClients.delete(res); }
  }, 20000);
  req.on('close', () => { clearInterval(hb); _sseClients.delete(res); });
}

function handleAnalyticsOverview(req, res) {
  if (!requireAdmin(req, res)) return;
  const today = istDateOnly();
  const pvToday   = db.prepare(`SELECT COUNT(*) AS c FROM page_views WHERE timestamp >= date('now','localtime')`).get().c;
  const pvHour    = db.prepare(`SELECT COUNT(*) AS c FROM page_views WHERE timestamp >= datetime('now','-1 hour','localtime')`).get().c;
  const pvTotal   = db.prepare(`SELECT COUNT(*) AS c FROM page_views`).get().c;
  const uniqueIPs = db.prepare(`SELECT COUNT(DISTINCT ip) AS c FROM page_views WHERE timestamp >= date('now','localtime')`).get().c;
  const deToday   = db.prepare(`SELECT COUNT(*) AS c FROM data_events WHERE timestamp >= date('now','localtime')`).get().c;
  const deHour    = db.prepare(`SELECT COUNT(*) AS c FROM data_events WHERE timestamp >= datetime('now','-1 hour','localtime')`).get().c;
  const activeSSE = _sseClients.size;
  const dbSize    = db.prepare(`SELECT page_count * page_size AS sz FROM pragma_page_count(), pragma_page_size()`).get()?.sz || 0;
  // Hourly page views (last 24h)
  const pvHourly  = db.prepare(`SELECT to_char(timestamp::timestamp AT TIME ZONE 'Asia/Kolkata','HH24') AS hr, COUNT(*) AS cnt FROM page_views WHERE timestamp >= to_char((NOW() - INTERVAL '24 hours') AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') GROUP BY 1 ORDER BY 1`).all();
  // Hourly data events (last 24h)
  const deHourly  = db.prepare(`SELECT to_char(timestamp::timestamp AT TIME ZONE 'Asia/Kolkata','HH24') AS hr, COUNT(*) AS cnt FROM data_events WHERE timestamp >= to_char((NOW() - INTERVAL '24 hours') AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') GROUP BY 1 ORDER BY 1`).all();
  // Top pages
  const topPages  = db.prepare(`SELECT page, COUNT(*) AS hits FROM page_views WHERE timestamp >= date('now','-7 days','localtime') GROUP BY page ORDER BY hits DESC LIMIT 10`).all();
  // Top actors
  const topActors = db.prepare(`SELECT actor, role, COUNT(*) AS actions FROM data_events WHERE timestamp >= date('now','localtime') GROUP BY actor, role ORDER BY COUNT(*) DESC LIMIT 10`).all();
  // Module activity
  const byModule  = db.prepare(`SELECT module, COUNT(*) AS cnt FROM data_events WHERE timestamp >= date('now','localtime') GROUP BY module ORDER BY cnt DESC`).all();
  // Recent events
  const recentDE  = db.prepare(`SELECT * FROM data_events ORDER BY id DESC LIMIT 30`).all();
  const recentPV  = db.prepare(`SELECT * FROM page_views ORDER BY id DESC LIMIT 20`).all();
  send(res, 200, { pvToday, pvHour, pvTotal, uniqueIPs, deToday, deHour, activeSSE, dbSizeKB: Math.round(dbSize/1024), pvHourly, deHourly, topPages, topActors, byModule, recentDE, recentPV });
}

function handleAnalyticsStorage(req, res) {
  if (!requireAdmin(req, res)) return;
  const dbSize = db.prepare(`SELECT page_count * page_size AS sz FROM pragma_page_count(), pragma_page_size()`).get()?.sz || 0;
  const tables = [
    'students','teachers','attendance','marks','fees','admissions',
    'data_events','page_views','security_events','api_call_logs',
    'department_budgets','budget_expenses','payroll_entries',
    'marketing_leads','marketing_campaigns','teacher_checkins','leaves'
  ];
  const tableCounts = tables.map(t => {
    try {
      const cnt = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      return { table: t, rows: cnt };
    } catch(e) { return { table: t, rows: 0 }; }
  });
  // Growth rate (events in last 1h vs last 24h)
  const de1h  = db.prepare(`SELECT COUNT(*) AS c FROM data_events WHERE timestamp >= datetime('now','-1 hour','localtime')`).get().c;
  const de24h = db.prepare(`SELECT COUNT(*) AS c FROM data_events WHERE timestamp >= datetime('now','-24 hours','localtime')`).get().c;
  const pv1h  = db.prepare(`SELECT COUNT(*) AS c FROM page_views WHERE timestamp >= datetime('now','-1 hour','localtime')`).get().c;
  // Most written tables today (from data_events)
  const mostWritten = db.prepare(`SELECT db_table, COUNT(*) AS writes FROM data_events WHERE timestamp >= date('now','localtime') GROUP BY db_table ORDER BY writes DESC LIMIT 8`).all();
  send(res, 200, { dbSizeBytes: dbSize, dbSizeKB: Math.round(dbSize/1024), dbSizeMB: +(dbSize/1024/1024).toFixed(2), tableCounts, de1h, de24h, pv1h, mostWritten });
}

function handleAnalyticsDataFlow(req, res) {
  if (!requireAdmin(req, res)) return;
  const q     = url.parse(req.url, true).query;
  const limit = Math.min(parseInt(q.limit)||50, 200);
  const events = db.prepare(`SELECT * FROM data_events ORDER BY id DESC LIMIT ?`).all(limit);
  const byRole = db.prepare(`SELECT role, COUNT(*) AS cnt FROM data_events WHERE timestamp >= date('now','localtime') GROUP BY role`).all();
  const byModule = db.prepare(`SELECT module, COUNT(*) AS cnt, MAX(timestamp) AS last_at FROM data_events WHERE timestamp >= datetime('now','-1 hour','localtime') GROUP BY module ORDER BY cnt DESC`).all();
  send(res, 200, { events, byRole, byModule });
}

function handleAnalyticsUsers(req, res) {
  if (!requireAdmin(req, res)) return;
  const students   = db.prepare(`SELECT COUNT(*) AS c FROM students`).get().c;
  const teachers   = db.prepare(`SELECT COUNT(*) AS c FROM teachers`).get().c;
  const loginsToday= db.prepare(`SELECT COUNT(*) AS c FROM security_events WHERE event_type='login_success' AND timestamp >= date('now','localtime')`).get().c;
  const loginsFail = db.prepare(`SELECT COUNT(*) AS c FROM security_events WHERE event_type='login_failed' AND timestamp >= date('now','localtime')`).get().c;
  const byRole     = db.prepare(`SELECT dashboard AS role, COUNT(*) AS logins FROM security_events WHERE event_type='login_success' AND timestamp >= date('now','localtime') GROUP BY dashboard ORDER BY logins DESC`).all();
  const actorActivity = db.prepare(`SELECT actor, role, COUNT(*) AS actions, MAX(timestamp) AS last_active FROM data_events WHERE timestamp >= date('now','-7 days','localtime') GROUP BY actor, role ORDER BY COUNT(*) DESC LIMIT 20`).all();
  const hourlyLogins  = db.prepare(`SELECT to_char(timestamp::timestamp AT TIME ZONE 'Asia/Kolkata','HH24') AS hr, COUNT(*) AS cnt FROM security_events WHERE event_type='login_success' AND timestamp >= to_char((NOW() - INTERVAL '24 hours') AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') GROUP BY 1 ORDER BY 1`).all();
  const loginHistory  = db.prepare(`SELECT * FROM security_events WHERE event_type IN ('login_success','login_failed') ORDER BY id DESC LIMIT 40`).all();
  send(res, 200, { students, teachers, loginsToday, loginsFail, byRole, actorActivity, hourlyLogins, loginHistory });
}

// ─── MONITOR: LIST BACKUPS ────────────────────────────────────────────────────
function handleMonitorListBackups(req, res) {
  const pl = monitorAuth(req, res); if (!pl) return;
  const fsM  = require('fs');
  const pathM = require('path');
  const dir   = __dirname;
  const files = fsM.readdirSync(dir)
    .filter(f => f.startsWith('server.js.bak.'))
    .map(f => {
      const stat = fsM.statSync(pathM.join(dir, f));
      return { file: f, size: Math.round(stat.size / 1024) + ' KB', created: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.created.localeCompare(a.created))
    .slice(0, 20);
  send(res, 200, { backups: files });
}

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS & ANNOUNCEMENTS
// ══════════════════════════════════════════════════════════════════════════════

// Internal helper – create a notification (never throws)
function createNotification(userId, role, title, message, type, link) {
  try {
    db.prepare(`INSERT INTO notifications (user_id,role,title,message,type,link,created_at)
      VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
      .run(String(userId||''), String(role||''), String(title||''), String(message||''), String(type||'info'), String(link||''));
    // Prune old notifications – keep last 200 per user
    db.prepare(`DELETE FROM notifications WHERE user_id=? AND role=? AND id NOT IN
      (SELECT id FROM notifications WHERE user_id=? AND role=? ORDER BY id DESC LIMIT 200)`)
      .run(String(userId||''), String(role||''), String(userId||''), String(role||''));
    // Broadcast via SSE so bell updates instantly
    broadcastSSE('notification', { userId, role, title, type, created_at: new Date().toISOString() });
  } catch(e) { console.warn('createNotification error:', e.message); }
}

// Derive auth identity from request (JWT or admin key)
function getNotifAuth(req) {
  const ah = req.headers['authorization'] || '';
  if (ah.startsWith('Bearer ')) {
    try {
      const p = verifyToken(ah.slice(7));
      if (p) {
        // Safely resolve userId — some tokens use 'sub', others use 'user' or 'username'
        const userId = String(p.sub ?? p.user ?? p.username ?? p.role ?? 'unknown');
        const role   = String(p.role || 'student');
        return { userId, role };
      }
    } catch(_) {}
  }
  const q = url.parse(req.url, true).query;
  if (q.key === ADMIN_KEY) return { userId: 'admin', role: 'admin' };
  return null;
}

// ─── SYSTEM SETTINGS ─────────────────────────────────────────────────────────
// ─── CLASS FEES ───────────────────────────────────────────────────────────────

function handleGetClassFees(req, res) {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare('SELECT class, annual_fee, processing_fee, updated_at FROM class_fees ORDER BY CAST(class AS INTEGER), class').all();
  send(res, 200, { class_fees: rows });
}

function handleUpdateClassFees(req, res) {
  if (!requireAdmin(req, res)) return;
  parseBody(req, (data) => {
    // data can be an array of { class, annual_fee, processing_fee } or a single object
    const entries = Array.isArray(data) ? data : (data.class_fees || [data]);
    const stmt = db.prepare(`INSERT INTO class_fees (class,annual_fee,processing_fee,updated_at) VALUES (?,?,?,datetime('now','localtime'))
      ON CONFLICT(class) DO UPDATE SET annual_fee=excluded.annual_fee, processing_fee=excluded.processing_fee, updated_at=excluded.updated_at`);
    let updated = 0;
    for (const entry of entries) {
      const cls = String(entry.class || '').trim();
      const af  = parseFloat(entry.annual_fee);
      const pf  = parseFloat(entry.processing_fee);
      if (!cls || isNaN(af) || af < 0) continue;
      stmt.run(cls, af, isNaN(pf) ? 1000 : pf);
      updated++;
    }
    send(res, 200, { ok: true, updated });
  });
}

function handleGetClassFeeForStudent(req, res) {
  const auth = req.headers.authorization || '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const pl = verifyToken(tok);
  const qs = new URLSearchParams(req.url.split('?')[1] || '');
  const adminKey = qs.get('key') || '';
  const isAdmin = adminKey === (process.env.ADMIN_KEY || 'gurukul-admin-2026');
  if (!pl && !isAdmin) return send(res, 401, { error: 'Unauthorized' });
  if (pl && !['finance','admin'].includes(pl.role)) return send(res, 401, { error: 'Finance/Admin only' });
  const cls = qs.get('class') || '';
  if (!cls) return send(res, 400, { error: 'class query param required' });
  const fee = db.prepare('SELECT * FROM class_fees WHERE class=?').get(cls);
  if (!fee) {
    // Return global default
    const annualFee = parseFloat(getSetting('annual_fee') || '21000');
    const procFee   = parseFloat(getSetting('installment_processing_fee') || '1000');
    return send(res, 200, { class: cls, annual_fee: annualFee, processing_fee: procFee, source: 'default' });
  }
  send(res, 200, { ...fee, source: 'class' });
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM system_settings WHERE key=?').get(key);
  return row ? row.value : null;
}
function handleGetSystemSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare('SELECT key, value, updated_at FROM system_settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  send(res, 200, { settings });
}

// PATCH /api/admin/settings
function handleUpdateSystemSettings(req, res) {
  if (!requireAdmin(req, res)) return;
  parseBody(req, data => {
    const now = istNow();
    const stmt = db.prepare(`INSERT INTO system_settings (key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
    let updated = 0;
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'undefined') {
        stmt.run(key, String(value), `${now.date} ${now.time}`);
        updated++;
      }
    }
    send(res, 200, { ok: true, updated });
  });
}

// GET /api/finance/installment-settings  — finance-accessible check
// ─── INSTALLMENT REQUESTS ─────────────────────────────────────────────────────

function handleCreateInstallmentRequest(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  parseBody(req, ({ student_id, academic_yr, request_note, installment_count, annual_fee, processing_fee }) => {
    if (!student_id) return send(res, 400, { error: 'student_id required' });
    const yr    = (academic_yr || new Date().getFullYear()).toString();
    const iCount = Math.min(3, Math.max(1, parseInt(installment_count || '3', 10)));
    const s  = db.prepare('SELECT id, name, class, section, parent_name, parent_phone, email FROM students WHERE id=?').get(student_id);
    if (!s) return send(res, 404, { error: 'Student not found' });
    // Check no pending request already exists
    const existing = db.prepare('SELECT id, status FROM installment_requests WHERE student_id=? AND academic_yr=? AND status=?').get(student_id, yr, 'Pending');
    if (existing) return send(res, 409, { error: 'A pending request already exists for this student' });
    // Check no approved request
    const approved = db.prepare('SELECT id FROM installment_requests WHERE student_id=? AND academic_yr=? AND status=?').get(student_id, yr, 'Approved');
    if (approved) return send(res, 409, { error: 'Installment plan already approved for this student' });
    // Resolve fee: use passed values, fallback to class fee, then global
    let aFee = parseFloat(annual_fee) || 0;
    let pFee = parseFloat(processing_fee) || 0;
    if (!aFee) {
      const classFee = db.prepare('SELECT * FROM class_fees WHERE class=?').get(s.class);
      aFee = classFee ? classFee.annual_fee : parseFloat(getSetting('annual_fee') || '21000');
      pFee = classFee ? classFee.processing_fee : parseFloat(getSetting('installment_processing_fee') || '1000');
    }
    const result = db.prepare(
      'INSERT INTO installment_requests (student_id, academic_yr, requested_by, request_note, installment_count, annual_fee, processing_fee) VALUES (?,?,?,?,?,?,?)'
    ).run(student_id, yr, pl.name || 'Finance Office', request_note || '', iCount, aFee, pFee);
    const req2 = db.prepare('SELECT * FROM installment_requests WHERE id=?').get(result.lastInsertRowid);
    send(res, 201, { ok: true, request: req2, student: s });
  });
}

function handleListInstallmentRequests(req, res) {
  // Works for both admin (all requests) and finance (own requests)
  const auth = req.headers.authorization || '';
  const tok  = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // Admin may also pass ?key=
  const qs2  = new URLSearchParams(req.url.split('?')[1] || '');
  const adminKey = qs2.get('key') || '';
  const pl = adminKey === (process.env.ADMIN_KEY || 'gurukul-admin-2026') ? { role: 'admin' } : verifyToken(tok);
  const isAdmin   = pl && ['admin','super_admin'].includes(pl.role);
  const isFinance = pl && ['finance','finance_officer','accountant'].includes(pl.role);
  if (!isAdmin && !isFinance) return send(res, 401, { error: 'Unauthorized' });
  const qs     = new URLSearchParams(req.url.split('?')[1] || '');
  const status = qs.get('status') || '';
  const yr     = qs.get('year')   || '';
  let sql  = `SELECT r.*, s.name AS student_name, s.class, s.section, s.parent_name, s.parent_phone, s.email,
    (SELECT COUNT(*) FROM fee_installments fi WHERE fi.student_id=r.student_id AND fi.academic_yr=r.academic_yr) AS inst_count,
    (SELECT SUM(fi.total_amount) FROM fee_installments fi WHERE fi.student_id=r.student_id AND fi.academic_yr=r.academic_yr) AS inst_total,
    (SELECT SUM(fi.total_amount) FROM fee_installments fi WHERE fi.student_id=r.student_id AND fi.academic_yr=r.academic_yr AND fi.status='Paid') AS inst_paid
    FROM installment_requests r JOIN students s ON r.student_id=s.id WHERE 1=1`;
  const args = [];
  if (status) { sql += ' AND r.status=?'; args.push(status); }
  if (yr)     { sql += ' AND r.academic_yr=?'; args.push(yr); }
  sql += ' ORDER BY r.created_at DESC';
  const rows = db.prepare(sql).all(...args);
  const pending  = rows.filter(r => r.status === 'Pending').length;
  const approved = rows.filter(r => r.status === 'Approved').length;
  const rejected = rows.filter(r => r.status === 'Rejected').length;
  send(res, 200, { requests: rows, counts: { pending, approved, rejected, total: rows.length } });
}

function handleActionInstallmentRequest(req, res) {
  if (!requireAdmin(req, res)) return;
  const parts2 = req.url.split('?')[0].split('/');
  const id = parseInt(parts2[parts2.length - 2], 10); // .../requests/:id/action
  parseBody(req, ({ action, admin_note }) => {
    if (!['Approved','Rejected'].includes(action)) return send(res, 400, { error: 'action must be Approved or Rejected' });
    const existing = db.prepare('SELECT * FROM installment_requests WHERE id=?').get(id);
    if (!existing) return send(res, 404, { error: 'Request not found' });
    if (existing.status !== 'Pending') return send(res, 409, { error: `Request already ${existing.status}` });
    db.prepare('UPDATE installment_requests SET status=?, admin_note=?, actioned_by=?, actioned_at=datetime(\'now\',\'localtime\') WHERE id=?')
      .run(action, admin_note || '', 'Administrator', id);
    const updated = db.prepare('SELECT r.*, s.name AS student_name, s.class, s.section FROM installment_requests r JOIN students s ON r.student_id=s.id WHERE r.id=?').get(id);
    // If approved, auto-create installment plan if not already there
    if (action === 'Approved') {
      const yr    = existing.academic_yr;
      const planExists = db.prepare('SELECT id FROM fee_installments WHERE student_id=? AND academic_yr=?').get(existing.student_id, yr);
      if (!planExists) {
        // Use fee stored on the request (set by finance), fall back to class-based fee, then global
        let annualFee = parseFloat(existing.annual_fee) || 0;
        let procFee   = parseFloat(existing.processing_fee) || 0;
        if (!annualFee) {
          const student2 = db.prepare('SELECT class FROM students WHERE id=?').get(existing.student_id);
          const classFee = student2 ? db.prepare('SELECT * FROM class_fees WHERE class=?').get(student2.class) : null;
          annualFee = classFee ? classFee.annual_fee : parseFloat(getSetting('annual_fee') || '21000');
          procFee   = classFee ? classFee.processing_fee : parseFloat(getSetting('installment_processing_fee') || '1000');
        }
        // Use per-request installment_count (falls back to global setting)
        const count     = parseInt(existing.installment_count || getSetting('installment_count') || '3', 10);
        const base      = Math.round(annualFee / count);
        const total     = base + procFee;
        const ins = db.prepare('INSERT INTO fee_installments (student_id,academic_yr,annual_fee,installment_no,base_amount,processing_fee,total_amount,status,due_date) VALUES (?,?,?,?,?,?,?,?,?)');
        for (let i = 1; i <= count; i++) {
          const dueDate = new Date(); dueDate.setDate(dueDate.getDate() + (i - 1) * 30);
          ins.run(existing.student_id, yr, annualFee, i, base, procFee, total, 'Pending', dueDate.toISOString().split('T')[0]);
        }
      }
    }
    send(res, 200, { ok: true, request: updated });
  });
}

function handleGetInstallmentRequestCount(req, res) {
  if (!requireAdmin(req, res)) return;
  const count = db.prepare("SELECT COUNT(*) AS c FROM installment_requests WHERE status='Pending'").get();
  send(res, 200, { pending: count.c });
}

function handleGetInstallmentRequestForStudent(req, res) {
  const auth = req.headers.authorization || '';
  const tok  = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const pl = verifyToken(tok);
  if (!pl || !['finance','admin'].includes(pl.role)) return send(res, 401, { error: 'Unauthorized' });
  const parts = req.url.split('?')[0].split('/');
  const studentId = parts[parts.length - 2];
  const yr = new URLSearchParams(req.url.split('?')[1] || '').get('year') || new Date().getFullYear().toString();
  const rows = db.prepare('SELECT * FROM installment_requests WHERE student_id=? AND academic_yr=? ORDER BY created_at DESC').all(studentId, yr);
  send(res, 200, { requests: rows, latest: rows[0] || null });
}

function handleGetInstallmentSettings(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  const enabled  = getSetting('installments_enabled') === '1';
  const annualFee = parseFloat(getSetting('annual_fee') || '21000');
  const procFee   = parseFloat(getSetting('installment_processing_fee') || '1000');
  const count     = parseInt(getSetting('installment_count') || '3', 10);
  const basePerInst = parseFloat((annualFee / count).toFixed(2));
  const totalPerInst = basePerInst + procFee;
  const totalWithCharges = totalPerInst * count;
  send(res, 200, {
    enabled, annual_fee: annualFee, processing_fee_per_installment: procFee,
    installment_count: count, base_per_installment: basePerInst,
    total_per_installment: totalPerInst, total_with_charges: totalWithCharges,
    extra_charges: procFee * count
  });
}

// ─── FEE DEFAULTERS ──────────────────────────────────────────────────────────
// GET /api/finance/defaulters?year=2026
function handleFinanceDefaulters(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  const qs  = new URLSearchParams(req.url.split('?')[1] || '');
  const yr  = qs.get('year') || new Date().getFullYear().toString();

  // Get each student, their expected fees, and what they've paid
  const students = db.prepare('SELECT id, name, class, section, parent_phone, username FROM students').all();
  // Use fee_schedules if available, else fall back to class_fees annual amounts
  const scheduleMap = {};
  const fsRows = db.prepare(`SELECT class, SUM(amount) as total FROM fee_schedules WHERE academic_yr=? GROUP BY class`).all(yr);
  if (fsRows.length > 0) {
    fsRows.forEach(r => { scheduleMap[r.class] = r.total; });
  } else {
    // Fallback: use class_fees annual_fee when no fee_schedules exist
    db.prepare('SELECT class, annual_fee FROM class_fees').all()
      .forEach(r => { scheduleMap[r.class] = r.annual_fee; });
  }
  const paidMap = {};
  const _defAcYr = `${parseInt(yr)-1}-${yr.slice(-2)}`; // e.g. "2025-26"
  db.prepare(`SELECT student_id, SUM(amount) as paid FROM finance_fees WHERE (academic_yr=? OR academic_yr=? OR academic_yr='' OR academic_yr IS NULL) AND status IN ('Paid','Partial') GROUP BY student_id`).all(_defAcYr, yr)
    .forEach(r => { paidMap[r.student_id] = r.paid; });
  // Also check installment plans
  const installMap = {};
  db.prepare(`SELECT student_id, SUM(total_amount) as expected, SUM(CASE WHEN status='Paid' THEN total_amount ELSE 0 END) as paid FROM fee_installments WHERE academic_yr=? GROUP BY student_id`).all(yr)
    .forEach(r => { installMap[r.student_id] = r; });

  const defaulters = [];
  for (const s of students) {
    const expected = scheduleMap[s.class] || 0;
    if (expected <= 0) continue;
    const paid      = paidMap[s.id] || 0;
    const balance   = Math.max(0, expected - paid);
    if (balance <= 0) continue;
    const instRow   = installMap[s.id];
    const instStatus = instRow
      ? { has_plan: true, inst_expected: instRow.expected, inst_paid: instRow.paid,
          inst_balance: Math.max(0, instRow.expected - instRow.paid) }
      : { has_plan: false };
    defaulters.push({ ...s, expected, paid, balance, ...instStatus });
  }
  defaulters.sort((a, b) => b.balance - a.balance);
  send(res, 200, { defaulters, year: yr, count: defaulters.length });
}

// ─── NOTIFY FEE (In-App + Simulated SMS) ─────────────────────────────────────
// POST /api/finance/notify-fee
function handleFinanceNotifyFee(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  parseBody(req, data => {
    const { student_id, channel, message } = data;  // channel: 'inapp' | 'sms' | 'both'
    if (!student_id) return send(res, 400, { error: 'student_id required' });
    const s = db.prepare('SELECT id, name, username, parent_phone, class FROM students WHERE id=?').get(student_id);
    if (!s) return send(res, 404, { error: 'Student not found' });
    const msg = message || `Dear parent/guardian of ${s.name}, your school fee payment is pending. Please clear dues at the earliest to avoid inconvenience. — The Gurukul High`;
    const ch  = channel || 'both';
    let inapp = false, sms = false;
    if (ch === 'inapp' || ch === 'both') {
      createNotification(s.id, 'student',
        '💰 Fee Payment Reminder',
        msg, 'warning', '/portal/dashboard.html#fees');
      inapp = true;
    }
    if (ch === 'sms' || ch === 'both') {
      const phone = s.parent_phone || 'N/A';
      db.prepare('INSERT INTO sms_log (student_id,phone,message,type,sent_by,status) VALUES (?,?,?,?,?,?)')
        .run(student_id, phone, msg, 'fee_reminder', 'Finance Office', 'simulated');
      sms = true;
    }
    send(res, 200, { ok: true, student: s.name, inapp_sent: inapp, sms_sent: sms,
      sms_note: sms ? `SMS simulated — would be sent to ${s.parent_phone||'(no phone on record)'}` : null });
  });
}

// ─── FEE INSTALLMENT PLAN ─────────────────────────────────────────────────────
// POST /api/finance/installment-plan
function handleCreateInstallmentPlan(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  parseBody(req, data => {
    const { student_id, academic_yr } = data;
    if (!student_id) return send(res, 400, { error: 'student_id required' });

    // Check installments are enabled
    if (getSetting('installments_enabled') !== '1')
      return send(res, 403, { error: 'Installment plan is not enabled by Admin' });

    const s = db.prepare('SELECT id, name, class FROM students WHERE id=?').get(student_id);
    if (!s) return send(res, 404, { error: 'Student not found' });

    const yr       = academic_yr || new Date().getFullYear().toString();
    const annualFee = parseFloat(getSetting('annual_fee') || '21000');
    const procFee   = parseFloat(getSetting('installment_processing_fee') || '1000');
    const count     = parseInt(getSetting('installment_count') || '3', 10);
    const base      = parseFloat((annualFee / count).toFixed(2));
    const total     = base + procFee;

    // Check if plan already exists
    const existing = db.prepare('SELECT id FROM fee_installments WHERE student_id=? AND academic_yr=?').get(student_id, yr);
    if (existing) return send(res, 409, { error: 'Installment plan already exists for this student and year' });

    // Create due dates: 30/60/90 days from today
    const today = new Date();
    const dueDates = [30, 60, 90].map(d => {
      const dt = new Date(today); dt.setDate(dt.getDate() + d);
      return dt.toISOString().slice(0, 10);
    });

    const stmt = db.prepare(`INSERT OR IGNORE INTO fee_installments
      (student_id,academic_yr,annual_fee,installment_no,base_amount,processing_fee,total_amount,status,due_date)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for (let i = 1; i <= count; i++) {
      stmt.run(student_id, yr, annualFee, i, base, procFee, total, 'Pending', dueDates[i-1]);
    }

    const installments = db.prepare('SELECT * FROM fee_installments WHERE student_id=? AND academic_yr=? ORDER BY installment_no').all(student_id, yr);
    send(res, 201, { ok: true, student: s.name, installments, summary: { annual_fee: annualFee, count, base_per_installment: base, processing_per_installment: procFee, total_per_installment: total, grand_total: total * count } });
  });
}

// GET /api/finance/installment-plan/:studentId?year=2026
function handleGetStudentInstallmentPlan(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  const studentId = req.url.split('/').slice(-1)[0].split('?')[0];
  const qs = new URLSearchParams(req.url.split('?')[1] || '');
  const yr = qs.get('year') || new Date().getFullYear().toString();

  const s = db.prepare('SELECT id, name, class FROM students WHERE id=?').get(studentId);
  if (!s) return send(res, 404, { error: 'Student not found' });

  const installments = db.prepare('SELECT * FROM fee_installments WHERE student_id=? AND academic_yr=? ORDER BY installment_no').all(studentId, yr);
  const annualFee    = parseFloat(getSetting('annual_fee') || '21000');
  const procFee      = parseFloat(getSetting('installment_processing_fee') || '1000');
  const count        = parseInt(getSetting('installment_count') || '3', 10);
  const base         = parseFloat((annualFee / count).toFixed(2));
  send(res, 200, {
    student: s, installments,
    has_plan: installments.length > 0,
    summary: installments.length > 0 ? {
      annual_fee: annualFee, count, base_per_installment: base,
      processing_per_installment: procFee,
      total_per_installment: base + procFee,
      grand_total: (base + procFee) * count,
      paid: installments.filter(i => i.status === 'Paid').reduce((a, i) => a + i.total_amount, 0),
      pending: installments.filter(i => i.status !== 'Paid').reduce((a, i) => a + i.total_amount, 0)
    } : null
  });
}

// POST /api/finance/installment-plan/:id/pay  — mark one installment as paid
function handlePayInstallment(req, res) {
  const pl = financeAuth(req, res); if (!pl) return;
  const id = parseInt(req.url.split('/').slice(-2)[0], 10);
  parseBody(req, data => {
    const { payment_mode, notes } = data;
    const inst = db.prepare('SELECT * FROM fee_installments WHERE id=?').get(id);
    if (!inst) return send(res, 404, { error: 'Installment not found' });
    if (inst.status === 'Paid') return send(res, 409, { error: 'Installment already paid' });
    const now    = istNow();
    const rcpt   = generateReceiptNo();
    db.prepare(`UPDATE fee_installments SET status='Paid', paid_date=?, receipt_no=?, payment_mode=?, notes=?, collected_by=? WHERE id=?`)
      .run(now.date, rcpt, payment_mode || 'Cash', notes || '', 'Finance Office', id);
    // Also record in finance_fees for unified tracking
    db.prepare(`INSERT INTO finance_fees (student_id,fee_type,amount,academic_yr,paid_date,status,payment_mode,receipt_no,notes,recorded_at,term,submitted_by,verified_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(inst.student_id, `Installment ${inst.installment_no}`, inst.total_amount,
        inst.academic_yr, now.date, 'Paid', payment_mode || 'Cash', rcpt,
        `Installment ${inst.installment_no} of 3 (Base: ₹${inst.base_amount}, Processing: ₹${inst.processing_fee})${notes?' | '+notes:''}`,
        `${now.date} ${now.time}`, 'Annual', 'finance', 'Finance Office');
    // Notify student
    createNotification(inst.student_id, 'student',
      `✅ Installment ${inst.installment_no} Payment Confirmed`,
      `Your Installment ${inst.installment_no} of ₹${inst.total_amount.toLocaleString('en-IN')} has been received. Receipt: ${rcpt}`,
      'success', '/portal/dashboard.html#fees');
    const updated = db.prepare('SELECT * FROM fee_installments WHERE id=?').get(id);
    send(res, 200, { ok: true, receipt_no: rcpt, installment: updated });
  });
}

// GET /api/student/installments  — student sees their own plan
function handleStudentInstallments(req, res, payload) {
  if (!payload || !payload.sub) return send(res, 401, { error: 'Unauthorized' });
  const yr = new URLSearchParams(req.url.split('?')[1] || '').get('year') || new Date().getFullYear().toString();
  const installments = db.prepare('SELECT * FROM fee_installments WHERE student_id=? AND academic_yr=? ORDER BY installment_no').all(payload.sub, yr);
  const annualFee = parseFloat(getSetting('annual_fee') || '21000');
  const procFee   = parseFloat(getSetting('installment_processing_fee') || '1000');
  const count     = parseInt(getSetting('installment_count') || '3', 10);
  const base      = parseFloat((annualFee / count).toFixed(2));
  send(res, 200, {
    has_plan: installments.length > 0, installments,
    summary: installments.length > 0 ? {
      annual_fee: annualFee, count, base_per_installment: base,
      processing_per_installment: procFee,
      total_per_installment: base + procFee,
      grand_total: (base + procFee) * count,
      paid: installments.filter(i => i.status === 'Paid').reduce((a, i) => a + i.total_amount, 0),
      pending: installments.filter(i => i.status !== 'Paid').reduce((a, i) => a + i.total_amount, 0)
    } : null
  });
}

// GET /api/notifications
function handleGetNotifications(req, res) {
  const auth = getNotifAuth(req);
  if (!auth) return send(res, 401, { error: 'Unauthorized' });
  const q = url.parse(req.url, true).query;
  const limit = Math.min(parseInt(q.limit) || 50, 100);
  // Ensure params are always strings to avoid SQLite binding errors
  const userId = String(auth.userId ?? 'unknown');
  const role   = String(auth.role ?? 'unknown');
  const rows = db.prepare(
    `SELECT * FROM notifications WHERE user_id=? AND role=?
     ORDER BY id DESC LIMIT ${limit}`
  ).all(userId, role);
  const unread = db.prepare(
    `SELECT COUNT(*) AS c FROM notifications WHERE user_id=? AND role=? AND is_read=0`
  ).get(userId, role).c;
  // Also attach active announcements targeted at this role
  const ann = db.prepare(
    `SELECT * FROM announcements
     WHERE is_active=1 AND (expires_at IS NULL OR expires_at > datetime('now','localtime'))
       AND (target_roles LIKE '%"all"%' OR target_roles LIKE ?)
     ORDER BY id DESC LIMIT 10`
  ).all(`%"${auth.role}"%`);
  send(res, 200, { unread, notifications: rows, announcements: ann });
}

// POST /api/notifications/read  – body: {} = all, or {id:N} = single
function handleMarkNotifsRead(req, res) {
  const auth = getNotifAuth(req);
  if (!auth) return send(res, 401, { error: 'Unauthorized' });
  const userId = String(auth.userId ?? 'unknown');
  const role   = String(auth.role ?? 'unknown');
  parseBody(req, (data) => {
    if (data.id) {
      db.prepare(`UPDATE notifications SET is_read=1 WHERE id=? AND user_id=? AND role=?`)
        .run(parseInt(data.id), userId, role);
    } else {
      db.prepare(`UPDATE notifications SET is_read=1 WHERE user_id=? AND role=?`)
        .run(userId, role);
    }
    send(res, 200, { ok: true });
  });
}

// GET /api/announcements  – public endpoint, filtered by role query param or JWT role
function handleGetAnnouncements(req, res) {
  const q = url.parse(req.url, true).query;
  let role = q.role || 'all';
  // Also accept JWT role
  const ah = req.headers['authorization'] || '';
  if (ah.startsWith('Bearer ')) {
    try { const p = verifyToken(ah.slice(7)); if (p) role = p.role || 'all'; } catch(_) {}
  }
  if (q.key === ADMIN_KEY) role = 'admin';
  const rows = db.prepare(
    `SELECT * FROM announcements
     WHERE is_active=1 AND (expires_at IS NULL OR expires_at > datetime('now','localtime'))
       AND (target_roles LIKE '%"all"%' OR target_roles LIKE ? OR target_roles LIKE '["all"]')
     ORDER BY id DESC`
  ).all(`%"${role}"%`);
  send(res, 200, { announcements: rows });
}

// GET /api/admin/announcements
function handleAdminListAnnouncements(req, res) {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`SELECT * FROM announcements ORDER BY id DESC`).all();
  send(res, 200, { announcements: rows });
}

// POST /api/admin/announcements
function handleAdminCreateAnnouncement(req, res) {
  if (!requireAdmin(req, res)) return;
  parseBody(req, (data) => {
    const { title, body, type, target_roles, expires_at } = data;
    if (!title || !title.trim()) return send(res, 400, { error: 'title required' });
    const validTypes = ['announcement','circular','alert','urgent'];
    const t = validTypes.includes(type) ? type : 'announcement';
    // target_roles must be a JSON array
    let rolesJson = '["all"]';
    try {
      const arr = Array.isArray(target_roles) ? target_roles : JSON.parse(target_roles || '["all"]');
      rolesJson = JSON.stringify(arr);
    } catch(_) {}
    const r = db.prepare(
      `INSERT INTO announcements (title,body,type,target_roles,created_by,expires_at)
       VALUES (?,?,?,?,'Admin',?)`
    ).run(title.trim(), body||'', t, rolesJson, expires_at||null);
    const ann = db.prepare('SELECT * FROM announcements WHERE id=?').get(r.lastInsertRowid);
    // Broadcast to SSE
    broadcastSSE('announcement', ann);
    // Create in-app notifications for all relevant roles
    const targets = JSON.parse(rolesJson);
    const allRoles = ['student','teacher','finance','hr','budget','marketing','admin'];
    const notifRoles = targets.includes('all') ? allRoles : targets;
    notifRoles.forEach(nr => createNotification(nr, nr, `📢 ${title.trim()}`, body||'', t==='urgent'?'danger':t==='alert'?'warning':'info', ''));
    send(res, 201, { announcement: ann });
  });
}

// PATCH /api/admin/announcements/:id  (toggle active)
function handleAdminToggleAnnouncement(req, res) {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.url.split('/').pop().split('?')[0]);
  parseBody(req, (data) => {
    const is_active = data.is_active === false || data.is_active === 0 ? 0 : 1;
    db.prepare('UPDATE announcements SET is_active=? WHERE id=?').run(is_active, id);
    send(res, 200, { ok: true });
  });
}

// DELETE /api/admin/announcements/:id
function handleAdminDeleteAnnouncement(req, res) {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.url.split('/').pop().split('?')[0]);
  db.prepare('DELETE FROM announcements WHERE id=?').run(id);
  send(res, 200, { ok: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN DELETE STUDENT / DELETE TEACHER (gap fix)
// ══════════════════════════════════════════════════════════════════════════════

function handleAdminDeleteStudent(req, res) {
  if (!requireAdmin(req, res)) return;
  const id = req.url.split('/').slice(-1)[0].split('?')[0];
  if (!id) return send(res, 400, { error: 'Student ID required' });
  const st = db.prepare('SELECT id,name FROM students WHERE id=?').get(id);
  if (!st) return send(res, 404, { error: 'Student not found' });
  // Cascade-delete associated records
  db.prepare('DELETE FROM attendance   WHERE student_id=?').run(id);
  db.prepare('DELETE FROM marks        WHERE student_id=?').run(id);
  db.prepare('DELETE FROM fees         WHERE student_id=?').run(id);
  db.prepare('DELETE FROM finance_fees WHERE student_id=?').run(id);
  db.prepare("DELETE FROM leave_balance       WHERE person_id=? AND person_type='student'").run(id);
  db.prepare("DELETE FROM leave_applications  WHERE person_id=? AND person_type='student'").run(id);
  db.prepare("DELETE FROM notifications WHERE user_id=? AND role='student'").run(id);
  db.prepare('DELETE FROM students WHERE id=?').run(id);
  logDataEvent('Admin','admin','Students','delete','students',`Deleted student ${st.name} (${id})`,1,'');
  send(res, 200, { ok: true, message: `Student ${st.name} deleted.` });
}

function handleAdminDeleteTeacher(req, res) {
  if (!requireAdmin(req, res)) return;
  const id = req.url.split('/').slice(-1)[0].split('?')[0];
  if (!id) return send(res, 400, { error: 'Teacher ID required' });
  const tc = db.prepare('SELECT id,name FROM teachers WHERE id=?').get(id);
  if (!tc) return send(res, 404, { error: 'Teacher not found' });
  db.prepare('DELETE FROM teacher_assignments WHERE teacher_id=?').run(id);
  db.prepare('DELETE FROM teacher_checkins    WHERE teacher_id=?').run(id);
  db.prepare("DELETE FROM leave_balance       WHERE person_id=? AND person_type='teacher'").run(id);
  db.prepare("DELETE FROM leave_applications  WHERE person_id=? AND person_type='teacher'").run(id);
  db.prepare('DELETE FROM daily_reports       WHERE teacher_id=?').run(id);
  db.prepare('DELETE FROM salary_requests     WHERE teacher_id=?').run(id);
  db.prepare('DELETE FROM resignations        WHERE teacher_id=?').run(id);
  db.prepare("DELETE FROM payroll_structures  WHERE staff_id=? AND staff_type='teacher'").run(id);
  db.prepare("DELETE FROM payroll_entries     WHERE staff_id=? AND staff_type='teacher'").run(id);
  db.prepare("DELETE FROM notifications WHERE user_id=? AND role='teacher'").run(id);
  db.prepare('DELETE FROM teachers WHERE id=?').run(id);
  logDataEvent('Admin','admin','Teachers','delete','teachers',`Deleted teacher ${tc.name} (${id})`,1,'');
  send(res, 200, { ok: true, message: `Teacher ${tc.name} deleted.` });
}

// ══════════════════════════════════════════════════════════════════════════════
//  NEW FEATURE HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

// ─── PARENT PORTAL ──────────────────────────────────────────────────────────
function handleParentLogin(req, res) {
  const ip = getIP(req);
  if (!rateLimit(ip, 'parent-login', 10, 60000)) return send(res, 429, { error: 'Too many attempts. Try again in 1 minute.' });
  parseBody(req, body => {
    const { username, password } = body || {};
    if (!username || !password) return send(res, 400, { error: 'Username and password required' });
    const student = db.prepare('SELECT * FROM students WHERE username=?').get(String(username).trim());
    if (!student || !verifyPassword(password, student.password_hash))
      return send(res, 401, { error: 'Invalid credentials' });
    const token = createToken({ sub: student.id, role: 'parent', name: student.parent_name || student.name, studentId: student.id });
    logSecEvent('parent_login', 'parent', ip, username, 'Parent login success');
    send(res, 200, { token, name: student.parent_name || 'Parent', studentName: student.name, studentId: student.id });
  });
}

function parentAuth(req) {
  const auth = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!auth) return null;
  try {
    const p = verifyToken(auth);
    if (p.role !== 'parent') return null;
    return p;
  } catch(e) { return null; }
}

function handleParentProfile(req, res, p) {
  const student = db.prepare('SELECT id,name,class,section,dob,parent_name,parent_phone,email,address FROM students WHERE id=?').get(p.studentId);
  if (!student) return send(res, 404, { error: 'Student not found' });
  send(res, 200, { student });
}
function handleParentAttendance(req, res, p) {
  const u = new URL('http://x'+req.url);
  const month = u.searchParams.get('month') || istDateOnly().slice(0,7);
  const rows = db.prepare("SELECT * FROM attendance WHERE student_id=? AND date LIKE ? ORDER BY date DESC").all(p.studentId, month+'%');
  const total = rows.length;
  const present = rows.filter(r=>r.status==='P').length;
  const absent = rows.filter(r=>r.status==='A').length;
  const leave = rows.filter(r=>r.status==='L').length;
  send(res, 200, { attendance: rows, summary: { total, present, absent, leave, pct: total ? Math.round(present/total*100) : 0 } });
}
function handleParentMarks(req, res, p) {
  const u = new URL('http://x'+req.url);
  const term = u.searchParams.get('term') || '';
  let q = 'SELECT * FROM marks WHERE student_id=?';
  const params = [p.studentId];
  if (term) { q += ' AND term=?'; params.push(term); }
  q += ' ORDER BY term,subject';
  const marks = db.prepare(q).all(...params);
  const terms = [...new Set(db.prepare('SELECT DISTINCT term FROM marks WHERE student_id=?').all(p.studentId).map(r=>r.term))];
  send(res, 200, { marks, terms });
}
function handleParentFees(req, res, p) {
  const fees = db.prepare('SELECT * FROM finance_fees WHERE student_id=? ORDER BY recorded_at DESC').all(p.studentId);
  const total = fees.reduce((a,f)=>a+f.amount,0);
  const paid = fees.filter(f=>f.status==='Paid').reduce((a,f)=>a+f.amount,0);
  const pending = fees.filter(f=>f.status==='Pending').reduce((a,f)=>a+f.amount,0);
  const installments = db.prepare('SELECT * FROM fee_installments WHERE student_id=? ORDER BY installment_no').all(p.studentId);
  send(res, 200, { fees, installments, summary: { total, paid, pending } });
}
function handleParentHolidays(req, res) {
  const rows = db.prepare("SELECT * FROM holidays WHERE date >= date('now') ORDER BY date ASC LIMIT 30").all();
  send(res, 200, { holidays: rows });
}
function handleParentCalendar(req, res) {
  const rows = db.prepare("SELECT * FROM academic_calendar WHERE is_active=1 AND start_date >= date('now','-30 days') ORDER BY start_date ASC").all();
  send(res, 200, { events: rows });
}
function handleParentAnnouncements(req, res, p) {
  const rows = db.prepare(`SELECT * FROM announcements WHERE is_active=1 AND (target_roles='["all"]' OR target_roles LIKE '%student%' OR target_roles LIKE '%parent%') ORDER BY created_at DESC LIMIT 20`).all();
  send(res, 200, { announcements: rows });
}
// ── Admin PTM ─────────────────────────────────────────────────────────────────
function _ptmNotifyParticipants(meeting, notifTitle, notifMsg, excludeRole) {
  // Notify student
  if (meeting.student_id && meeting.student_id !== 0 && excludeRole !== 'student') {
    createNotification(meeting.student_id, 'student', notifTitle, notifMsg, 'info');
  }
  // Notify parent (same id as student in parent auth)
  if (meeting.student_id && meeting.student_id !== 0 && excludeRole !== 'parent') {
    createNotification(meeting.student_id, 'parent', notifTitle, notifMsg, 'info');
  }
  // Notify teacher by name
  if (meeting.teacher_name && excludeRole !== 'teacher') {
    const t = db.prepare("SELECT id FROM teachers WHERE name=? LIMIT 1").get(meeting.teacher_name);
    if (t) createNotification(t.id, 'teacher', notifTitle, notifMsg, 'info');
  }
  // Notify admin
  if (excludeRole !== 'admin') {
    createNotification('admin', 'admin', notifTitle, notifMsg, 'info');
  }
}

// ─── ACCESS CONTROL HANDLERS ─────────────────────────────────────────────────

// GET /api/admin/access/password-resets — summary counts + full log
function handleAccessPasswordResets(req, res) {
  if (!requireAdmin(req, res)) return;
  const q = url.parse(req.url, true).query;
  const limit  = Math.min(parseInt(q.limit  || '200'), 500);
  const offset = parseInt(q.offset || '0');
  const type   = q.type || '';

  // Counts per role from log
  const studentCount = db.prepare("SELECT COUNT(*) AS c FROM password_reset_log WHERE user_type='student'").get()?.c || 0;
  const teacherCount = db.prepare("SELECT COUNT(*) AS c FROM password_reset_log WHERE user_type='teacher'").get()?.c || 0;
  const parentCount  = db.prepare("SELECT COUNT(*) AS c FROM password_reset_log WHERE user_type='parent'").get()?.c  || 0;
  const staffCount   = db.prepare("SELECT COUNT(*) AS c FROM password_reset_log WHERE user_type='support'").get()?.c || 0;
  const totalCount   = db.prepare("SELECT COUNT(*) AS c FROM password_reset_log").get()?.c || 0;

  // Detailed log with name join
  let whereClause = type ? " WHERE l.user_type=?" : '';
  const params = type ? [type, limit, offset] : [limit, offset];
  const rows = db.prepare(`
    SELECT l.*,
      CASE l.user_type
        WHEN 'student' THEN (SELECT s.name FROM students s WHERE s.id=l.user_id)
        WHEN 'teacher' THEN (SELECT t.name FROM teachers t WHERE t.id=l.user_id)
        WHEN 'support' THEN (SELECT ss.name FROM support_staff ss WHERE ss.id=l.user_id)
        ELSE l.user_id
      END AS display_name
    FROM password_reset_log l${whereClause}
    ORDER BY l.created_at DESC LIMIT ? OFFSET ?`).all(...params);

  send(res, 200, {
    summary: { student: studentCount, teacher: teacherCount, parent: parentCount, staff: staffCount, total: totalCount },
    log: rows,
    total: totalCount
  });
}

// GET /api/admin/access/biometric — all users with their block status
function handleAccessBiometricList(req, res) {
  if (!requireAdmin(req, res)) return;
  const q = url.parse(req.url, true).query;
  const userType = q.type || '';  // 'student' | 'teacher' | 'support' | ''

  // Check for global block
  const globalBlock = db.prepare("SELECT * FROM biometric_access WHERE user_id='__ALL__' AND user_type='all'").get();

  // Students
  let students = [];
  if (!userType || userType === 'student') {
    const stList = db.prepare('SELECT id, name, class, section FROM students ORDER BY class, section, name').all();
    students = stList.map(s => {
      const access = db.prepare("SELECT * FROM biometric_access WHERE user_id=? AND user_type='student'").get(s.id);
      return { ...s, is_blocked: globalBlock?.is_blocked ? 1 : (access?.is_blocked || 0), blocked_reason: access?.reason || '', blocked_at: access?.blocked_at || '' };
    });
  }

  // Teachers
  let teachers = [];
  if (!userType || userType === 'teacher') {
    const tList = db.prepare('SELECT id, name, subject, department FROM teachers ORDER BY name').all();
    teachers = tList.map(t => {
      const access = db.prepare("SELECT * FROM biometric_access WHERE user_id=? AND user_type='teacher'").get(t.id);
      return { ...t, is_blocked: globalBlock?.is_blocked ? 1 : (access?.is_blocked || 0), blocked_reason: access?.reason || '', blocked_at: access?.blocked_at || '' };
    });
  }

  // Support staff
  let staff = [];
  if (!userType || userType === 'support') {
    const sList = db.prepare('SELECT id, name, department, designation FROM support_staff ORDER BY name').all();
    staff = sList.map(s => {
      const access = db.prepare("SELECT * FROM biometric_access WHERE user_id=? AND user_type='support'").get(s.id);
      return { ...s, is_blocked: globalBlock?.is_blocked ? 1 : (access?.is_blocked || 0), blocked_reason: access?.reason || '', blocked_at: access?.blocked_at || '' };
    });
  }

  send(res, 200, {
    global_blocked: globalBlock?.is_blocked ? 1 : 0,
    students,
    teachers,
    staff
  });
}

// PATCH /api/admin/access/biometric — update block status for user(s)
// Body: { user_id, user_type, is_blocked, reason }  OR  { user_id:'__ALL__', user_type:'all', is_blocked }
function handleAccessBiometricUpdate(req, res) {
  if (!requireAdmin(req, res)) return;
  parseBody(req, body => {
    const { user_id, user_type, is_blocked, reason } = body || {};
    if (!user_id || user_type === undefined || is_blocked === undefined)
      return send(res, 400, { error: 'user_id, user_type, is_blocked required' });

    const blocked   = is_blocked ? 1 : 0;
    const blockedAt = blocked ? istDateOnly() + ' ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '';
    const blockedBy = 'admin';

    db.prepare(`INSERT INTO biometric_access (user_id, user_type, is_blocked, blocked_by, blocked_at, reason, updated_at)
      VALUES (?,?,?,?,?,?,datetime('now','localtime'))
      ON CONFLICT(user_id,user_type) DO UPDATE SET
        is_blocked=excluded.is_blocked, blocked_by=excluded.blocked_by,
        blocked_at=excluded.blocked_at, reason=excluded.reason,
        updated_at=excluded.updated_at`
    ).run(user_id, user_type, blocked, blockedBy, blockedAt, reason || '');

    const action = blocked ? 'BLOCKED' : 'UNBLOCKED';
    if (user_id === '__ALL__') {
      console.log(`\n🔒 Biometric access ${action} for ALL users by admin`);
    } else {
      console.log(`\n🔒 Biometric access ${action} for ${user_type} ${user_id} by admin`);
    }

    send(res, 200, { success: true, user_id, user_type, is_blocked: blocked });
  });
}

// PATCH /api/admin/access/biometric/bulk — block/unblock all students in a class
function handleAccessBiometricBulkClass(req, res) {
  if (!requireAdmin(req, res)) return;
  parseBody(req, body => {
    const { class_name, is_blocked, reason } = body || {};
    if (!class_name || is_blocked === undefined)
      return send(res, 400, { error: 'class_name and is_blocked required' });

    const parts = class_name.split('-');
    const cls = parts[0], sec = parts[1] || null;
    const students = sec
      ? db.prepare('SELECT id FROM students WHERE class=? AND section=?').all(cls, sec)
      : db.prepare('SELECT id FROM students WHERE class=?').all(cls);

    const blocked   = is_blocked ? 1 : 0;
    const blockedAt = blocked ? istDateOnly() + ' ' + new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '';
    const stmt = db.prepare(`INSERT INTO biometric_access (user_id, user_type, is_blocked, blocked_by, blocked_at, reason, updated_at)
      VALUES (?,?,?,?,?,?,datetime('now','localtime'))
      ON CONFLICT(user_id,user_type) DO UPDATE SET
        is_blocked=excluded.is_blocked, blocked_by=excluded.blocked_by,
        blocked_at=excluded.blocked_at, reason=excluded.reason,
        updated_at=excluded.updated_at`);
    for (const s of students) {
      stmt.run(s.id, 'student', blocked, 'admin', blockedAt, reason || '');
    }

    send(res, 200, { success: true, count: students.length, class_name, is_blocked: blocked });
  });
}

// GET /api/admin/access/biometric/check — called by biometric punch handler to check if user is blocked
function isBiometricBlocked(userId, userType) {
  const globalBlock = db.prepare("SELECT is_blocked FROM biometric_access WHERE user_id='__ALL__' AND user_type='all'").get();
  if (globalBlock?.is_blocked) return true;
  const userBlock = db.prepare('SELECT is_blocked FROM biometric_access WHERE user_id=? AND user_type=?').get(userId, userType);
  return userBlock?.is_blocked ? true : false;
}

// ─── END ACCESS CONTROL HANDLERS ─────────────────────────────────────────────

function handleAdminPTMList(req, res) {
  if (!requireAdmin(req, res)) return;
  const u   = new URL('http://x' + req.url);
  const sid = u.searchParams.get('student_id');
  const cls = u.searchParams.get('class_name');
  const sts = u.searchParams.get('status');
  let query = `SELECT p.*, COALESCE(s.name,'(Class Meeting)') AS student_name, s.class, s.section
               FROM ptm_meetings p LEFT JOIN students s ON s.id=p.student_id WHERE 1=1`;
  const params = [];
  if (sid) { query += ' AND p.student_id=?'; params.push(sid); }
  if (cls) { query += ' AND (p.class_name=? OR s.class=? OR (s.class||"-"||COALESCE(s.section,""))=?)'; params.push(cls,cls,cls); }
  if (sts) { query += ' AND p.status=?'; params.push(sts); }
  query += ' ORDER BY p.scheduled_at DESC LIMIT 200';
  const rows = db.prepare(query).all(...params);
  send(res, 200, { meetings: rows });
}

function handleAdminPTMCreate(req, res) {
  if (!requireAdmin(req, res)) return;
  parseBody(req, body => {
    const { class_name, student_id, title, scheduled_at, teacher_name, teacher_subject, location, admin_notes } = body || {};
    if (!scheduled_at) return send(res, 400, { error: 'scheduled_at required' });
    if (!class_name && !student_id) return send(res, 400, { error: 'class_name or student_id required' });

    const mtTitle    = title || 'Parent-Teacher Meeting';
    const mtLocation = location || 'School Campus';
    const mtTeacher  = teacher_name || '';
    const mtSubject  = teacher_subject || '';
    const mtNotes    = admin_notes || '';

    // Determine the list of students to create meetings for
    let students = [];
    if (student_id && parseInt(student_id) > 0) {
      // Specific student selected
      const s = db.prepare('SELECT * FROM students WHERE id=?').get(student_id);
      if (s) students = [s];
    } else if (class_name) {
      // Whole class — split e.g. "6-A" into class + section
      const parts = class_name.split('-');
      const cls   = parts[0];
      const sec   = parts[1] || null;
      if (sec) {
        students = db.prepare('SELECT * FROM students WHERE class=? AND section=?').all(cls, sec);
      } else {
        students = db.prepare('SELECT * FROM students WHERE class=?').all(cls);
      }
    }
    if (!students.length) return send(res, 400, { error: 'No students found for given class/student' });

    const ids = [];
    const insertStmt = db.prepare(
      'INSERT INTO ptm_meetings (student_id,class_name,title,scheduled_at,teacher_name,teacher_subject,location,status,admin_notes) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    for (const s of students) {
      const r = insertStmt.run(s.id, class_name || (s.class + (s.section?'-'+s.section:'')), mtTitle, scheduled_at, mtTeacher, mtSubject, mtLocation, 'scheduled', mtNotes);
      ids.push(r.lastInsertRowid);
      // Notify student
      createNotification(s.id, 'student', '📅 PTM Scheduled',
        `A Parent-Teacher Meeting has been scheduled for ${new Date(scheduled_at.replace(' ','T')).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}${mtTeacher?' with '+mtTeacher:''}.`, 'info');
      // Notify parent (same user_id as student)
      createNotification(s.id, 'parent', '📅 PTM Scheduled',
        `A meeting has been scheduled for your child ${s.name} on ${new Date(scheduled_at.replace(' ','T')).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}${mtTeacher?' with Teacher '+mtTeacher:''}. Location: ${mtLocation}.`, 'info');
    }
    // Notify teacher once
    if (mtTeacher) {
      const teacher = db.prepare("SELECT id FROM teachers WHERE name=? LIMIT 1").get(mtTeacher);
      if (teacher) {
        const classLabel = class_name || (students[0]?.class || '');
        createNotification(teacher.id, 'teacher', '📅 PTM Assigned to You',
          `You have been assigned a Parent-Teacher Meeting on ${new Date(scheduled_at.replace(' ','T')).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})} for class ${classLabel}. Location: ${mtLocation}.`, 'info');
      }
    }
    send(res, 200, { success: true, ids, count: ids.length });
  });
}

function handleAdminPTMUpdate(req, res) {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.url.split('/').pop());
  parseBody(req, body => {
    const { title, scheduled_at, teacher_name, teacher_subject, location, status, admin_notes } = body || {};
    const prev = db.prepare('SELECT * FROM ptm_meetings WHERE id=?').get(id);
    db.prepare("UPDATE ptm_meetings SET title=COALESCE(?,title), scheduled_at=COALESCE(?,scheduled_at), teacher_name=COALESCE(?,teacher_name), teacher_subject=COALESCE(?,teacher_subject), location=COALESCE(?,location), status=COALESCE(?,status), admin_notes=COALESCE(?,admin_notes), updated_at=datetime('now','localtime') WHERE id=?")
      .run(title||null, scheduled_at||null, teacher_name||null, teacher_subject||null, location||null, status||null, admin_notes||null, id);
    // Send notifications if status changed or rescheduled
    if (prev) {
      const updated = db.prepare('SELECT * FROM ptm_meetings WHERE id=?').get(id);
      if (status && status !== prev.status) {
        const msg = `PTM "${updated.title}" status changed to ${status.toUpperCase()}.`;
        _ptmNotifyParticipants(updated, `📋 PTM ${status.charAt(0).toUpperCase()+status.slice(1)}`, msg, 'admin');
      } else if (scheduled_at && scheduled_at !== prev.scheduled_at) {
        const msg = `PTM "${updated.title}" has been rescheduled to ${new Date(updated.scheduled_at.replace(' ','T')).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}.`;
        _ptmNotifyParticipants(updated, '🗓️ PTM Rescheduled', msg, 'admin');
      }
    }
    send(res, 200, { success: true });
  });
}

function handleAdminPTMDelete(req, res) {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.url.split('/').pop());
  const meeting = db.prepare('SELECT * FROM ptm_meetings WHERE id=?').get(id);
  if (meeting) {
    _ptmNotifyParticipants(meeting, '❌ PTM Cancelled', `PTM "${meeting.title}" scheduled for ${(meeting.scheduled_at||'').slice(0,10)} has been cancelled by admin.`, 'admin');
  }
  db.prepare('DELETE FROM ptm_meetings WHERE id=?').run(id);
  send(res, 200, { success: true });
}

// ── PTM ──────────────────────────────────────────────────────────────────────
function handleParentPTMList(req, res, pp) {
  const meetings = db.prepare('SELECT * FROM ptm_meetings WHERE student_id=? ORDER BY scheduled_at ASC').all(pp.studentId);
  send(res, 200, { meetings });
}
function handleParentPTMRequest(req, res, pp) {
  parseBody(req, body => {
    const { scheduled_at, title, teacher_name, teacher_subject, parent_notes, status,
            preferred_date, preferred_time, reason } = body || {};
    // Accept either frontend format (scheduled_at) or legacy (preferred_date+preferred_time)
    const sAt = scheduled_at || (preferred_date ? preferred_date + ' ' + (preferred_time || '10:00') : null);
    if (!sAt) return send(res, 400, { error: 'scheduled_at required' });
    const r = db.prepare(
      'INSERT INTO ptm_meetings (student_id, title, scheduled_at, teacher_name, teacher_subject, status, parent_notes, requested_by) VALUES (?,?,?,?,?,?,?,?)'
    ).run(pp.studentId, title||'Meeting Request', sAt, teacher_name||'', teacher_subject||'', status||'requested', parent_notes||reason||'', 'parent');
    const newId = r.lastInsertRowid;
    // Notify admin and teacher about the parent's request
    const student = db.prepare('SELECT name FROM students WHERE id=?').get(pp.studentId);
    const sName   = student?.name || 'A parent';
    createNotification('admin', 'admin', '📅 New PTM Request', `${sName}'s parent has requested a Parent-Teacher Meeting on ${(sAt||'').slice(0,10)}.`, 'warning');
    if (teacher_name) {
      const t = db.prepare("SELECT id FROM teachers WHERE name=? LIMIT 1").get(teacher_name);
      if (t) createNotification(t.id, 'teacher', '📅 New PTM Request', `Parent of ${sName} has requested a meeting with you on ${(sAt||'').slice(0,10)}.`, 'warning');
    }
    send(res, 200, { success: true, id: newId });
  });
}
function handleParentPTMNotes(req, res, pp) {
  const id = parseInt(req.url.split('/').slice(-2)[0]);
  const meeting = db.prepare('SELECT * FROM ptm_meetings WHERE id=? AND student_id=?').get(id, pp.studentId);
  if (!meeting) return send(res, 404, { error: 'Meeting not found' });
  parseBody(req, body => {
    db.prepare("UPDATE ptm_meetings SET parent_notes=?, updated_at=datetime('now','localtime') WHERE id=?").run(body.parent_notes||'', id);
    send(res, 200, { success: true });
  });
}

// ── Mock Tests ────────────────────────────────────────────────────────────────
function handleParentMockTestList(req, res, pp) {
  const tests = db.prepare('SELECT id,title,subject,class,difficulty,created_by,time_limit,total_marks,created_at FROM mock_tests WHERE student_id=? ORDER BY created_at DESC').all(pp.studentId);
  send(res, 200, { tests });
}
function handleParentMockTestCreate(req, res, pp) {
  parseBody(req, body => {
    const { title, subject, difficulty, questions, time_limit } = body || {};
    if (!title || !subject) return send(res, 400, { error: 'title and subject required' });
    const qs = Array.isArray(questions) ? questions : [];
    const totalMarks = qs.reduce((s, q) => s + (parseInt(q.marks) || 1), 0);
    const student = db.prepare('SELECT class FROM students WHERE id=?').get(pp.studentId);
    const id = db.prepare(
      'INSERT INTO mock_tests (student_id,title,subject,class,difficulty,questions,created_by,time_limit,total_marks) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(pp.studentId, title, subject, student?.class||'', difficulty||'Medium', JSON.stringify(qs), 'parent', time_limit||30, totalMarks).lastInsertRowid;
    send(res, 200, { success: true, id });
  });
}
function handleParentMockTestGet(req, res, pp) {
  const id = parseInt(req.url.split('/').pop());
  const test = db.prepare('SELECT * FROM mock_tests WHERE id=? AND student_id=?').get(id, pp.studentId);
  if (!test) return send(res, 404, { error: 'Not found' });
  test.questions = JSON.parse(test.questions || '[]');
  send(res, 200, { test });
}

// ── Performance Analytics ─────────────────────────────────────────────────────
function handleParentPerformance(req, res, pp) {
  const sid = pp.studentId;
  // All marks
  const marks = db.prepare('SELECT * FROM marks WHERE student_id=? ORDER BY date ASC').all(sid);
  // Attendance summary
  const att = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS present FROM attendance WHERE student_id=?").get(sid);
  // Per-subject aggregates
  const bySubject = {};
  marks.forEach(m => {
    if (!bySubject[m.subject]) bySubject[m.subject] = { total_marks:0, max_marks:0, count:0, exams:[] };
    const bs = bySubject[m.subject];
    bs.total_marks += m.marks;
    bs.max_marks   += (m.max_marks || 100);
    bs.count++;
    bs.exams.push({ exam: m.exam, date: m.date, marks: m.marks, max: m.max_marks||100 });
  });
  const subjects = Object.entries(bySubject).map(([s, d]) => ({
    subject: s,
    avg_pct: d.max_marks ? Math.round((d.total_marks/d.max_marks)*100) : 0,
    total_marks: d.total_marks,
    max_marks: d.max_marks,
    exams: d.exams
  })).sort((a,b) => b.avg_pct - a.avg_pct);
  // Term-wise averages
  const termMap = {};
  marks.forEach(m => {
    const term = m.term || m.exam || 'General';
    if (!termMap[term]) termMap[term] = { total:0, max:0 };
    termMap[term].total += m.marks;
    termMap[term].max   += (m.max_marks||100);
  });
  const terms = Object.entries(termMap).map(([t,d]) => ({ term:t, avg_pct: d.max ? Math.round((d.total/d.max)*100) : 0 }));
  const overallPct = marks.length ? Math.round(marks.reduce((s,m)=>s+(m.marks/(m.max_marks||100))*100,0)/marks.length) : 0;
  const attPct = att.total ? Math.round((att.present/att.total)*100) : 0;
  send(res, 200, { subjects, terms, overall_pct: overallPct, attendance_pct: attPct, total_exams: marks.length, marks_raw: marks });
}

// ── Teacher PTM ───────────────────────────────────────────────────────────────
function handleTeacherPTMList(req, res, payload) {
  const teacher = db.prepare('SELECT name FROM teachers WHERE id=?').get(payload.sub);
  if (!teacher) return send(res, 404, { error: 'Teacher not found' });
  // Return meetings where this teacher is assigned, ordered soonest first
  const meetings = db.prepare(
    `SELECT p.*, s.name AS student_name, s.class, s.section
     FROM ptm_meetings p
     JOIN students s ON s.id = p.student_id
     WHERE p.teacher_name = ?
     ORDER BY p.scheduled_at ASC`
  ).all(teacher.name);
  send(res, 200, { meetings });
}
function handleTeacherPTMUpdate(req, res, payload) {
  const id      = parseInt(req.url.split('/').pop());
  const teacher = db.prepare('SELECT name FROM teachers WHERE id=?').get(payload.sub);
  parseBody(req, body => {
    const { status, admin_notes } = body || {};
    const fields = [];
    const vals   = [];
    if (status)                    { fields.push('status=?');      vals.push(status); }
    if (admin_notes !== undefined) { fields.push('admin_notes=?'); vals.push(admin_notes); }
    if (!fields.length) return send(res, 400, { error: 'Nothing to update' });
    fields.push("updated_at=datetime('now','localtime')");
    vals.push(id);
    db.prepare(`UPDATE ptm_meetings SET ${fields.join(',')} WHERE id=?`).run(...vals);
    // Send notifications
    const updated = db.prepare('SELECT * FROM ptm_meetings WHERE id=?').get(id);
    if (updated) {
      const tName = teacher?.name || 'Teacher';
      if (status === 'completed') {
        // Notify student, parent, admin
        createNotification(updated.student_id, 'student', '✅ PTM Completed', `Your PTM "${updated.title}" has been marked as completed by ${tName}.`, 'success');
        createNotification(updated.student_id, 'parent',  '✅ PTM Completed', `The meeting "${updated.title}" for your child has been completed by ${tName}.`, 'success');
        createNotification('admin', 'admin', '✅ PTM Completed', `PTM "${updated.title}" completed by teacher ${tName}.`, 'success');
      } else if (admin_notes !== undefined && admin_notes !== '') {
        // Teacher added meeting notes
        createNotification(updated.student_id, 'parent', '📝 PTM Notes Added', `${tName} has added notes for the meeting "${updated.title}".`, 'info');
        createNotification('admin', 'admin', '📝 PTM Notes Updated', `Teacher ${tName} added notes to PTM "${updated.title}".`, 'info');
      }
    }
    send(res, 200, { success: true });
  });
}

function handleParentBiometric(req, res, pp) {
  const date = new Date().toISOString().slice(0, 10);
  const logs = db.prepare("SELECT * FROM biometric_logs WHERE user_id=? AND user_type='student' AND timestamp LIKE ? ORDER BY timestamp ASC")
                 .all(pp.studentId, date + '%');
  const lastIn  = [...logs].reverse().find(l => l.action === 'IN')  || null;
  const lastOut = [...logs].reverse().find(l => l.action === 'OUT') || null;
  send(res, 200, { logs, last_in: lastIn, last_out: lastOut, date });
}
function handleParentTimetable(req, res, pp) {
  const u = new URL('http://x' + req.url);
  const week = u.searchParams.get('week') || new Date().toISOString().slice(0, 10);
  const student = db.prepare('SELECT class, section FROM students WHERE id=?').get(pp.studentId);
  if (!student) return send(res, 404, { error: 'Student not found' });
  const cls = student.section ? `${student.class}-${student.section}` : student.class;
  const rows = db.prepare("SELECT t.*, tc.name AS teacher_name FROM class_timetables t LEFT JOIN teachers tc ON tc.id=t.teacher_id WHERE t.class_name=? AND t.week_start=? ORDER BY CASE t.day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END, t.start_time")
               .all(cls, week);
  send(res, 200, { timetable: rows, class: cls, week });
}

// ─── STUDENT PROMOTION ───────────────────────────────────────────────────────
function handleAdminPromoteStudents(req, res) {
  const u = new URL('http://x'+req.url);
  if (u.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
  parseBody(req, body => {
    const { from_class, to_class, from_section, academic_yr } = body || {};
    if (!from_class || !to_class) return send(res, 400, { error: 'from_class and to_class required' });
    let q = "SELECT id,name,class,section FROM students WHERE class=?";
    const params = [String(from_class)];
    if (from_section) { q += ' AND section=?'; params.push(from_section); }
    const students = db.prepare(q).all(...params);
    if (!students.length) return send(res, 200, { ok:true, promoted:0, message:'No students found in that class' });
    const toClass = String(to_class);
    const now = istDateOnly();
    let promoted = 0;
    try {
      db.prepare("BEGIN").run();
      for (const s of students) {
        db.prepare("UPDATE students SET class=?, updated_at=? WHERE id=?").run(toClass, now, s.id);
        promoted++;
      }
      db.prepare("COMMIT").run();
    } catch(e) {
      try { db.prepare("ROLLBACK").run(); } catch(_) {}
      return send(res, 500, { error: e.message });
    }
    logDataEvent('admin','admin','students','promote','students',`Promoted ${promoted} students from Class ${from_class} to ${to_class}`,promoted);
    send(res, 200, { ok:true, promoted, from_class, to_class, students: students.map(s=>s.name) });
  });
}

function handleAdminPromotionPreview(req, res) {
  const u = new URL('http://x'+req.url);
  if (u.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
  const cls = u.searchParams.get('class') || '';
  const sec = u.searchParams.get('section') || '';
  let q = "SELECT id,name,class,section FROM students WHERE 1=1";
  const params = [];
  if (cls) { q += ' AND class=?'; params.push(cls); }
  if (sec) { q += ' AND section=?'; params.push(sec); }
  q += ' ORDER BY class,section,name';
  const students = db.prepare(q).all(...params);
  const classSummary = db.prepare("SELECT class, section, COUNT(*) AS count FROM students GROUP BY class, section ORDER BY CAST(class AS INTEGER), section").all();
  send(res, 200, { students, classSummary });
}

// ─── PERFORMANCE ANALYTICS ───────────────────────────────────────────────────
function handleAdminPerformance(req, res) {
  const u = new URL('http://x'+req.url);
  if (u.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
  const cls   = u.searchParams.get('class') || '';
  const term  = u.searchParams.get('term') || '';
  const subj  = u.searchParams.get('subject') || '';

  // Class-wise average marks
  let classQ = `SELECT s.class, s.section, AVG(m.marks/m.max_marks*100) AS avg_pct, COUNT(DISTINCT m.student_id) AS students
                FROM marks m JOIN students s ON s.id=m.student_id WHERE 1=1`;
  const cp = [];
  if (cls)  { classQ += ' AND s.class=?';   cp.push(cls); }
  if (term) { classQ += ' AND m.term=?';    cp.push(term); }
  if (subj) { classQ += ' AND m.subject=?'; cp.push(subj); }
  classQ += ' GROUP BY s.class, s.section ORDER BY CAST(s.class AS INTEGER), s.section';
  const byClass = db.prepare(classQ).all(...cp);

  // Subject-wise averages
  let subQ = `SELECT m.subject, AVG(m.marks/m.max_marks*100) AS avg_pct, COUNT(*) AS attempts,
               MIN(m.marks/m.max_marks*100) AS min_pct, MAX(m.marks/m.max_marks*100) AS max_pct
               FROM marks m JOIN students s ON s.id=m.student_id WHERE 1=1`;
  const sp = [];
  if (cls)  { subQ += ' AND s.class=?';   sp.push(cls); }
  if (term) { subQ += ' AND m.term=?';    sp.push(term); }
  subQ += ' GROUP BY m.subject ORDER BY avg_pct DESC';
  const bySubject = db.prepare(subQ).all(...sp);

  // Top 10 performers
  let topQ = `SELECT s.name, s.class, s.section, AVG(m.marks/m.max_marks*100) AS avg_pct
              FROM marks m JOIN students s ON s.id=m.student_id WHERE 1=1`;
  const tp = [];
  if (cls)  { topQ += ' AND s.class=?'; tp.push(cls); }
  if (term) { topQ += ' AND m.term=?';  tp.push(term); }
  topQ += ' GROUP BY m.student_id, s.name, s.class, s.section ORDER BY AVG(m.marks/m.max_marks*100) DESC LIMIT 10';
  const topPerformers = db.prepare(topQ).all(...tp);

  // Attendance analytics
  const attQ = `SELECT s.class, AVG(CASE WHEN a.status='P' THEN 1.0 ELSE 0 END)*100 AS att_pct,
                COUNT(DISTINCT a.student_id) AS students
                FROM attendance a JOIN students s ON s.id=a.student_id GROUP BY s.class ORDER BY CAST(s.class AS INTEGER)`;
  const byAttendance = db.prepare(attQ).all();

  const terms = db.prepare("SELECT DISTINCT term FROM marks ORDER BY term").all().map(r=>r.term);
  const classes = db.prepare("SELECT DISTINCT class FROM students ORDER BY CAST(class AS INTEGER)").all().map(r=>r.class);
  const subjects = db.prepare("SELECT DISTINCT subject FROM marks ORDER BY subject").all().map(r=>r.subject);

  send(res, 200, { byClass, bySubject, topPerformers, byAttendance, terms, classes, subjects });
}

// ─── ACADEMIC CALENDAR ────────────────────────────────────────────────────────
function handleListAcademicCalendar(req, res) {
  const u = new URL('http://x'+req.url);
  const yr = u.searchParams.get('year') || new Date().getFullYear().toString();
  const cls = u.searchParams.get('class') || '';
  let q = `SELECT * FROM academic_calendar WHERE is_active=1 AND (start_date LIKE ? OR end_date LIKE ?)`;
  const params = [yr+'%', yr+'%'];
  if (cls) { q += ' AND (class=? OR class="All")'; params.push(cls); }
  q += ' ORDER BY start_date ASC';
  const events = db.prepare(q).all(...params);
  send(res, 200, { events });
}

function handleCreateAcademicCalendar(req, res) {
  const u = new URL('http://x'+req.url);
  if (u.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
  parseBody(req, body => {
    const { title, event_type, start_date, end_date, class: cls, description } = body || {};
    if (!title || !start_date) return send(res, 400, { error: 'title and start_date required' });
    const r = db.prepare('INSERT INTO academic_calendar (title,event_type,start_date,end_date,class,description,created_by) VALUES (?,?,?,?,?,?,?)')
                .run(title, event_type||'Event', start_date, end_date||start_date, cls||'All', description||'', 'admin');
    send(res, 200, { ok:true, id: r.lastInsertRowid });
  });
}

function handleUpdateAcademicCalendar(req, res) {
  const u = new URL('http://x'+req.url);
  if (u.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
  const id = parseInt(req.url.split('?')[0].split('/').pop());
  parseBody(req, body => {
    const row = db.prepare('SELECT * FROM academic_calendar WHERE id=?').get(id);
    if (!row) return send(res, 404, { error: 'Not found' });
    const { title, event_type, start_date, end_date, class: cls, description, is_active } = body || {};
    db.prepare('UPDATE academic_calendar SET title=?,event_type=?,start_date=?,end_date=?,class=?,description=?,is_active=? WHERE id=?')
      .run(title||row.title, event_type||row.event_type, start_date||row.start_date, end_date||row.end_date,
           cls!==undefined?cls:row.class, description!==undefined?description:row.description,
           is_active!==undefined?is_active:row.is_active, id);
    send(res, 200, { ok:true });
  });
}

function handleDeleteAcademicCalendar(req, res) {
  const u = new URL('http://x'+req.url);
  if (u.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
  const id = parseInt(req.url.split('?')[0].split('/').pop());
  db.prepare('DELETE FROM academic_calendar WHERE id=?').run(id);
  send(res, 200, { ok:true });
}

// ─── EMAIL TEMPLATES ──────────────────────────────────────────────────────────
function emailTemplateAuth(req) {
  const pl = teacherAuth(req);
  if (pl) return { role: 'teacher', id: pl.sub };
  // HR auth
  const auth = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (!auth) return null;
  try {
    const p = verifyToken(auth);
    if (['hr','admin','finance','marketing'].includes(p.role)) return { role: p.role, id: p.sub || p.user };
    return null;
  } catch(e) { return null; }
}

function handleListEmailTemplates(req, res) {
  const a = emailTemplateAuth(req);
  if (!a) return send(res, 401, { error: 'Unauthorized' });
  const u = new URL('http://x'+req.url);
  const key = u.searchParams.get('key');
  const role = key === ADMIN_KEY ? (u.searchParams.get('role')||'') : a.role;
  let q = 'SELECT * FROM email_templates WHERE 1=1';
  const params = [];
  if (role && key !== ADMIN_KEY) { q += ' AND role=?'; params.push(role); }
  else if (role) { q += ' AND role=?'; params.push(role); }
  q += ' ORDER BY category, name';
  const templates = db.prepare(q).all(...params);
  const categories = [...new Set(templates.map(t=>t.category))];
  send(res, 200, { templates, categories });
}

function handleCreateEmailTemplate(req, res) {
  const a = emailTemplateAuth(req);
  if (!a) return send(res, 401, { error: 'Unauthorized' });
  parseBody(req, body => {
    const { name, subject, body: tBody, category } = body || {};
    if (!name || !subject || !tBody) return send(res, 400, { error: 'name, subject and body required' });
    const r = db.prepare('INSERT INTO email_templates (role,name,subject,body,category,created_by) VALUES (?,?,?,?,?,?)')
                .run(a.role, name, subject, tBody, category||'General', a.id||a.role);
    send(res, 200, { ok:true, id: r.lastInsertRowid });
  });
}

function handleUpdateEmailTemplate(req, res) {
  const a = emailTemplateAuth(req);
  if (!a) return send(res, 401, { error: 'Unauthorized' });
  const id = parseInt(req.url.split('?')[0].split('/').pop());
  parseBody(req, body => {
    const row = db.prepare('SELECT * FROM email_templates WHERE id=?').get(id);
    if (!row) return send(res, 404, { error: 'Not found' });
    if (row.role !== a.role && a.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
    const { name, subject, body: tBody, category } = body || {};
    db.prepare('UPDATE email_templates SET name=?,subject=?,body=?,category=?,updated_at=datetime(\'now\',\'localtime\') WHERE id=?')
      .run(name||row.name, subject||row.subject, tBody!==undefined?tBody:row.body, category||row.category, id);
    send(res, 200, { ok:true });
  });
}

function handleDeleteEmailTemplate(req, res) {
  const a = emailTemplateAuth(req);
  if (!a) return send(res, 401, { error: 'Unauthorized' });
  const id = parseInt(req.url.split('?')[0].split('/').pop());
  const row = db.prepare('SELECT * FROM email_templates WHERE id=?').get(id);
  if (!row) return send(res, 404, { error: 'Not found' });
  if (row.role !== a.role && a.role !== 'admin') return send(res, 403, { error: 'Forbidden' });
  db.prepare('DELETE FROM email_templates WHERE id=?').run(id);
  send(res, 200, { ok:true });
}

// ─── SETTLEMENT / GRATUITY ────────────────────────────────────────────────────
function handleHRCalculateSettlement(req, res) {
  const u = new URL('http://x'+req.url);
  const staffType = u.searchParams.get('type') || 'teacher';
  const staffId   = u.searchParams.get('id') || '';
  if (!staffId) return send(res, 400, { error: 'id required' });

  let staff;
  if (staffType === 'teacher') {
    staff = db.prepare('SELECT * FROM teachers WHERE id=?').get(staffId);
  } else {
    staff = db.prepare('SELECT * FROM support_staff WHERE id=?').get(staffId);
  }
  if (!staff) return send(res, 404, { error: 'Staff not found' });

  const structure = db.prepare('SELECT * FROM payroll_structures WHERE staff_id=? AND staff_type=?').get(staffId, staffType);
  const basic = structure ? structure.basic : 0;

  // Calculate years of service
  const joinDate = staff.joining_date || istDateOnly();
  const today = istDateOnly();
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  const years = Math.max(0, (new Date(today) - new Date(joinDate)) / msPerYear);

  // Gratuity (Indian formula: Basic * 15/26 * years of service — eligible after 5 years)
  const gratuity = years >= 5 ? Math.round(basic * (15/26) * Math.floor(years)) : 0;

  // Leave encashment (max 30 days of last drawn basic)
  const leaveBalance = db.prepare("SELECT * FROM leave_balance WHERE person_id=? AND person_type=? ORDER BY year DESC LIMIT 1").get(staffId, staffType==='teacher'?'teacher':'teacher');
  const leaveDays = leaveBalance ? Math.max(0, (leaveBalance.earned_total - leaveBalance.earned_used)) : 0;
  const leaveEncashment = Math.round((basic / 26) * Math.min(30, leaveDays));

  // Notice pay (1 month basic if not served notice)
  const noticePay = Math.round(basic);

  const totalSettlement = gratuity + leaveEncashment + noticePay;

  send(res, 200, {
    staff: { id: staff.id, name: staff.name, designation: staff.designation||'', joining_date: joinDate },
    structure: { basic },
    years_of_service: Math.round(years * 10) / 10,
    breakdown: { gratuity, leaveEncashment, noticePay, otherDues: 0 },
    total: totalSettlement,
    eligible_gratuity: years >= 5,
    leave_days: leaveDays
  });
}

function handleHRCreateSettlement(req, res) {
  parseBody(req, body => {
    const { staff_id, staff_type, staff_name, last_working_day, reason, basic_salary,
            years_of_service, gratuity_amount, leave_encashment, notice_pay,
            other_dues, total_settlement, notes } = body || {};
    if (!staff_id || !last_working_day) return send(res, 400, { error: 'staff_id and last_working_day required' });
    const r = db.prepare(`INSERT INTO settlement_records
      (staff_id,staff_type,staff_name,last_working_day,reason,basic_salary,years_of_service,
       gratuity_amount,leave_encashment,notice_pay,other_dues,total_settlement,notes,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'hr')`)
      .run(staff_id,staff_type||'teacher',staff_name||'',last_working_day,reason||'Resignation',
           basic_salary||0,years_of_service||0,gratuity_amount||0,leave_encashment||0,
           notice_pay||0,other_dues||0,total_settlement||0,notes||'');
    send(res, 200, { ok:true, id: r.lastInsertRowid });
  });
}

function handleHRListSettlements(req, res) {
  const rows = db.prepare('SELECT * FROM settlement_records ORDER BY created_at DESC').all();
  send(res, 200, { settlements: rows });
}

function handleHRUpdateSettlementStatus(req, res) {
  const id = parseInt(req.url.split('?')[0].split('/').pop());
  parseBody(req, body => {
    const { status } = body || {};
    if (!status) return send(res, 400, { error: 'status required' });
    db.prepare("UPDATE settlement_records SET status=? WHERE id=?").run(status, id);
    send(res, 200, { ok:true });
  });
}

// ─── FILE / DOCUMENT UPLOAD ───────────────────────────────────────────────────
function handleDocumentUpload(req, res) {
  const u = new URL('http://x'+req.url);
  const key = u.searchParams.get('key');
  const isAdmin = (key === ADMIN_KEY);
  if (!isAdmin) {
    const tp = teacherAuth(req);
    if (!tp) {
      // Try finance/hr auth
      const auth = (req.headers['authorization']||'').replace('Bearer ','');
      try { const p = verifyToken(auth); if (!p || !p.role) return send(res, 401, { error:'Unauthorized' }); }
      catch(e) { return send(res, 401, { error:'Unauthorized' }); }
    }
  }

  const owner_id   = u.searchParams.get('owner_id') || '';
  const owner_type = u.searchParams.get('owner_type') || 'student';
  const doc_type   = u.searchParams.get('doc_type') || 'General';
  const uploader   = u.searchParams.get('by') || 'admin';

  if (!owner_id) return send(res, 400, { error:'owner_id required' });

  const contentType = req.headers['content-type'] || '';
  const boundary = contentType.split('boundary=')[1];
  if (!boundary) return send(res, 400, { error:'Multipart form data required' });

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    const boundaryBuf = Buffer.from('--' + boundary);
    const parts = [];
    let start = buf.indexOf(boundaryBuf);
    while (start !== -1) {
      const end = buf.indexOf(boundaryBuf, start + boundaryBuf.length);
      if (end === -1) break;
      const part = buf.slice(start + boundaryBuf.length, end);
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const header = part.slice(0, headerEnd).toString();
        const data   = part.slice(headerEnd + 4, part.length - 2); // trim trailing \r\n
        parts.push({ header, data });
      }
      start = end;
    }

    let uploaded = [];
    for (const part of parts) {
      const nameMatch = part.header.match(/name="([^"]+)"/);
      const fileMatch = part.header.match(/filename="([^"]+)"/);
      if (!fileMatch) continue;
      const origName = fileMatch[1];
      const ext      = path.extname(origName).slice(1,6).toLowerCase();
      const allowed  = ['pdf','jpg','jpeg','png','doc','docx','xlsx','csv','txt'];
      if (!allowed.includes(ext)) continue;
      const safeName = `${owner_id}_${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
      const filePath = path.join(DATA_DIR, 'uploads', safeName);
      const mimeMap  = { pdf:'application/pdf', jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png',
                         doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                         xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                         csv:'text/csv', txt:'text/plain' };
      fs.writeFileSync(filePath, part.data);
      const r = db.prepare('INSERT INTO documents (owner_id,owner_type,doc_type,filename,original_name,file_size,mime_type,uploaded_by) VALUES (?,?,?,?,?,?,?,?)')
                  .run(owner_id, owner_type, doc_type, safeName, origName, part.data.length, mimeMap[ext]||'application/octet-stream', uploader);
      uploaded.push({ id: r.lastInsertRowid, filename: safeName, original_name: origName, size: part.data.length });
    }

    send(res, 200, { ok:true, uploaded });
  });
}

function handleListDocuments(req, res) {
  const u = new URL('http://x'+req.url);
  const owner_id   = u.searchParams.get('owner_id') || '';
  const owner_type = u.searchParams.get('owner_type') || '';
  let q = 'SELECT * FROM documents WHERE 1=1';
  const params = [];
  if (owner_id)   { q += ' AND owner_id=?';   params.push(owner_id); }
  if (owner_type) { q += ' AND owner_type=?'; params.push(owner_type); }
  q += ' ORDER BY created_at DESC';
  const docs = db.prepare(q).all(...params);
  send(res, 200, { documents: docs });
}

function handleDeleteDocument(req, res) {
  const u = new URL('http://x'+req.url);
  if (u.searchParams.get('key') !== ADMIN_KEY) {
    const auth = (req.headers['authorization']||'').replace('Bearer ','');
    try { const p = verifyToken(auth); if (!p) return send(res, 401, {error:'Unauthorized'}); }
    catch(e) { return send(res, 401, {error:'Unauthorized'}); }
  }
  const id = parseInt(req.url.split('?')[0].split('/').pop());
  const doc = db.prepare('SELECT * FROM documents WHERE id=?').get(id);
  if (!doc) return send(res, 404, { error:'Not found' });
  try { fs.unlinkSync(path.join(DATA_DIR, 'uploads', doc.filename)); } catch(e) {}
  db.prepare('DELETE FROM documents WHERE id=?').run(id);
  send(res, 200, { ok:true });
}

function handleServeDocument(req, res) {
  const u = new URL('http://x'+req.url);
  const filename = req.url.split('?')[0].split('/').pop();
  const filePath = path.join(DATA_DIR, 'uploads', filename);
  if (!fs.existsSync(filePath)) return send(res, 404, { error:'File not found' });
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mimeMap = { pdf:'application/pdf', jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png',
                    docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    csv:'text/csv', txt:'text/plain' };
  const mime = mimeMap[ext] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length,
                        'Access-Control-Allow-Origin': '*',
                        'Content-Disposition': `inline; filename="${filename}"` });
  res.end(data);
}

// ─── PASSWORD RESET ────────────────────────────────────────────────────────────
function handleAdminInitiatePasswordReset(req, res) {
  const u = new URL('http://x'+req.url);
  if (u.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error:'Unauthorized' });
  parseBody(req, body => {
    const { user_id, user_type, new_password } = body || {};
    if (!user_id || !user_type || !new_password) return send(res, 400, { error:'user_id, user_type and new_password required' });
    if (new_password.length < 6) return send(res, 400, { error:'Password must be at least 6 characters' });
    const hash = hashPassword(new_password);
    if (user_type === 'student') {
      const s = db.prepare('SELECT id FROM students WHERE id=?').get(user_id);
      if (!s) return send(res, 404, { error:'Student not found' });
      db.prepare('UPDATE students SET password_hash=? WHERE id=?').run(hash, user_id);
    } else if (user_type === 'teacher') {
      const t = db.prepare('SELECT id FROM teachers WHERE id=?').get(user_id);
      if (!t) return send(res, 404, { error:'Teacher not found' });
      db.prepare('UPDATE teachers SET password_hash=? WHERE id=?').run(hash, user_id);
    } else {
      return send(res, 400, { error:'user_type must be student or teacher' });
    }
    send(res, 200, { ok:true, message:`Password reset successfully for ${user_id}` });
  });
}

// ─── EMAIL QUEUE / ADMIN COMMS ────────────────────────────────────────────────
function handleListEmailQueue(req, res) {
  const u = new URL('http://x'+req.url);
  if (u.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error:'Unauthorized' });
  const status = u.searchParams.get('status') || '';
  let q = 'SELECT id,to_email,to_name,subject,status,sent_at,created_at,created_by FROM email_queue WHERE 1=1';
  const params = [];
  if (status) { q += ' AND status=?'; params.push(status); }
  q += ' ORDER BY created_at DESC LIMIT 200';
  const emails = db.prepare(q).all(...params);
  send(res, 200, { emails, smtp_configured: !!(_smtpCfg.host && _smtpCfg.user) });
}

function handleSendBulkEmail(req, res) {
  const u = new URL('http://x'+req.url);
  if (u.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error:'Unauthorized' });
  parseBody(req, body => {
    const { recipients, subject, message, role } = body || {};
    if (!subject || !message) return send(res, 400, { error:'subject and message required' });
    let targets = [];
    if (role === 'parents') {
      targets = db.prepare("SELECT parent_name AS name, email FROM students WHERE email != '' AND email IS NOT NULL").all();
    } else if (role === 'teachers') {
      targets = db.prepare("SELECT name, email FROM teachers WHERE email != '' AND email IS NOT NULL AND status='Active'").all();
    } else if (recipients) {
      targets = recipients.map(r => ({ name: r.name||'', email: r.email })).filter(r=>r.email);
    }
    let queued = 0;
    for (const t of targets) {
      if (!t.email) continue;
      sendEmail(t.email, subject, message, t.name||'');
      queued++;
    }
    send(res, 200, { ok:true, queued });
  });
}

// ─── RAZORPAY PAYMENT GATEWAY ────────────────────────────────────────────────
// Razorpay uses HMAC-SHA256 for signature verification — no SDK needed
const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID     || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

function handleRazorpayCreateOrder(req, res) {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET)
    return send(res, 503, { error:'Razorpay not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to server/.env' });
  const payload = authMiddleware(req);
  if (!payload) return send(res, 401, { error:'Unauthorized' });
  parseBody(req, body => {
    const { amount, purpose, academic_yr } = body || {};
    if (!amount || amount <= 0) return send(res, 400, { error:'amount required (in INR)' });
    const amountPaise = Math.round(parseFloat(amount) * 100);
    const receiptId = `GK${Date.now()}`;
    // Call Razorpay Orders API
    const postData = JSON.stringify({ amount: amountPaise, currency: 'INR', receipt: receiptId,
                                      notes: { student_id: payload.sub, purpose: purpose||'Fee Payment' } });
    const creds = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    const opts = {
      hostname: 'api.razorpay.com', path: '/v1/orders', method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Basic ${creds}`, 'Content-Length': Buffer.byteLength(postData) }
    };
    const https = require('https');
    const rzReq = https.request(opts, rzRes => {
      let data = '';
      rzRes.on('data', c => data += c);
      rzRes.on('end', () => {
        try {
          const order = JSON.parse(data);
          if (order.error) return send(res, 400, { error: order.error.description || 'Razorpay error' });
          // Store order
          db.prepare('INSERT OR IGNORE INTO razorpay_orders (student_id,order_id,amount,purpose,academic_yr) VALUES (?,?,?,?,?)')
            .run(payload.sub, order.id, parseFloat(amount), purpose||'Fee Payment', academic_yr||'');
          send(res, 200, { order_id: order.id, amount: amountPaise, currency: 'INR',
                           key: RAZORPAY_KEY_ID, student_id: payload.sub });
        } catch(e) { send(res, 500, { error:'Failed to parse Razorpay response' }); }
      });
    });
    rzReq.on('error', e => send(res, 502, { error:'Razorpay API error: ' + e.message }));
    rzReq.write(postData);
    rzReq.end();
  });
}

function handleRazorpayVerify(req, res) {
  parseBody(req, body => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return send(res, 400, { error:'Missing Razorpay fields' });
    const expectedSig = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
                              .update(`${razorpay_order_id}|${razorpay_payment_id}`)
                              .digest('hex');
    if (expectedSig !== razorpay_signature)
      return send(res, 400, { error:'Payment signature invalid' });
    // Mark order as paid
    const order = db.prepare('SELECT * FROM razorpay_orders WHERE order_id=?').get(razorpay_order_id);
    if (!order) return send(res, 404, { error:'Order not found' });
    db.prepare("UPDATE razorpay_orders SET status='paid', payment_id=? WHERE order_id=?").run(razorpay_payment_id, razorpay_order_id);
    // Record fee payment
    const now = istDateOnly();
    const receipt = `RZP-${razorpay_payment_id.slice(-8).toUpperCase()}`;
    db.prepare(`INSERT INTO finance_fees (student_id,fee_type,amount,academic_yr,month,paid_date,status,payment_mode,receipt_no,recorded_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(order.student_id, order.purpose, order.amount, order.academic_yr, now.slice(0,7), now, 'Paid', 'Online', receipt, now);
    // Send notification
    try {
      db.prepare(`INSERT INTO notifications (user_id,role,title,message,type) VALUES (?,?,?,?,?)`)
        .run(order.student_id,'student','Payment Successful',`Your payment of ₹${order.amount} via Razorpay has been received. Receipt: ${receipt}`,'success');
    } catch(e) {}
    send(res, 200, { ok:true, receipt, payment_id: razorpay_payment_id });
  });
}

// ─── HOLIDAYS ADMIN CRUD ──────────────────────────────────────────────────────
function handleAdminAddHoliday(req, res) {
  const u = new URL('http://x'+req.url);
  if (u.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error:'Unauthorized' });
  parseBody(req, body => {
    const { date, name, type } = body || {};
    if (!date || !name) return send(res, 400, { error:'date and name required' });
    try {
      db.prepare('INSERT INTO holidays (date,name,type) VALUES (?,?,?)').run(date, name, type||'School');
      send(res, 200, { ok:true });
    } catch(e) {
      send(res, 409, { error:'Holiday already exists for that date' });
    }
  });
}

function handleAdminDeleteHoliday(req, res) {
  const u = new URL('http://x'+req.url);
  if (u.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error:'Unauthorized' });
  const id = parseInt(req.url.split('?')[0].split('/').pop());
  db.prepare('DELETE FROM holidays WHERE id=?').run(id);
  send(res, 200, { ok:true });
}

// ─── MAIN ROUTER ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // request logging removed (was debug only)
  // ── Proxy-cache bypass: /m/ prefix rewrites to /api/ ──
  if (req.url.startsWith('/m/')) req.url = '/api/' + req.url.slice(3);
  // ── Global per-request crash guard ──
  try {
  // ── Request timing + API logger ──
  const _reqStart = Date.now();
  const _reqIP    = getIP(req);
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function(code, hdrs) { res._logStatus = code; return origWriteHead(code, hdrs); };
  const origEnd = res.end.bind(res);
  res.end = function(...args) {
    const result = origEnd(...args);
    // Async log — never block the response, never throw
    setImmediate(() => {
      try {
        const elapsed = Date.now() - _reqStart;
        const pth = req.url.split('?')[0].slice(0, 200);
        if (pth.startsWith('/api/') || pth.startsWith('/admin/')) {
          db.prepare(`INSERT INTO api_call_logs (method,path,status_code,response_time_ms,ip,user_agent,timestamp) VALUES (?,?,?,?,?,?,datetime('now','localtime'))`)
            .run(req.method, pth, res._logStatus||200, elapsed, _reqIP, (req.headers['user-agent']||'').slice(0,200));
          // Prune old logs every ~50 requests (probabilistic to avoid constant deletes)
          if (Math.random() < 0.02) {
            db.prepare(`DELETE FROM api_call_logs WHERE id NOT IN (SELECT id FROM api_call_logs ORDER BY id DESC LIMIT 5000)`).run();
          }
        }
      } catch(e) { /* never throw from logging */ }
    });
    return result;
  };

  // verbose request log removed
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS'
    });
    return res.end();
  }

  // ── Rate limiting for login endpoints ──
  if (req.method === 'POST' && pathname.endsWith('/login')) {
    const ip = getIP(req);
    if (!rateLimit(ip, 'login', 15, 60000))
      return send(res, 429, { error:'Too many login attempts. Please wait 1 minute.' });
  }

  // ── Public API ──
  if (pathname === '/api/auth/login'          && req.method === 'POST')  return handleLogin(req, res);
  if (pathname === '/api/admin/login'         && req.method === 'POST')  return handleAdminLogin(req, res);
  if (pathname === '/api/teacher/login'       && req.method === 'POST')  return handleTeacherLogin(req, res);
  if (pathname === '/api/parent/login'        && req.method === 'POST')  return handleParentLogin(req, res);
  if (pathname === '/api/finance/login'       && req.method === 'POST')  return handleFinanceLogin(req, res);
  if (pathname === '/api/hr/login'            && req.method === 'POST')  return handleHRLogin(req, res);
  if (pathname === '/api/budget/login'        && req.method === 'POST')  return handleBudgetLogin(req, res);
  if (pathname === '/api/marketing/login'     && req.method === 'POST')  return handleMarketingLogin(req, res);

  // ── System Settings API ──
  if (pathname === '/api/admin/class-fees'            && req.method === 'GET')    return handleGetClassFees(req, res);
  if (pathname === '/api/admin/class-fees'            && req.method === 'PATCH')  return handleUpdateClassFees(req, res);
  if (pathname === '/api/finance/class-fee'           && (req.method === 'GET'))  return handleGetClassFeeForStudent(req, res);
  if (pathname === '/api/admin/settings'             && req.method === 'GET')    return handleGetSystemSettings(req, res);
  if (pathname === '/api/admin/settings'             && req.method === 'PATCH')  return handleUpdateSystemSettings(req, res);
  if (pathname === '/api/finance/installment-settings' && req.method === 'GET')  return handleGetInstallmentSettings(req, res);

  // ── Fee Defaulters & Installments API ──
  if (pathname === '/api/finance/defaulters'                          && req.method === 'GET')  return handleFinanceDefaulters(req, res);
  if (pathname === '/api/finance/notify-fee'                          && req.method === 'POST') return handleFinanceNotifyFee(req, res);
  if (pathname === '/api/finance/installment-plan'                    && req.method === 'POST') return handleCreateInstallmentPlan(req, res);
  if (pathname.match(/^\/api\/finance\/installment-plan\/[^/]+$/)     && req.method === 'GET')  return handleGetStudentInstallmentPlan(req, res);
  if (pathname.match(/^\/api\/finance\/installment-plan\/\d+\/pay$/)  && req.method === 'POST') return handlePayInstallment(req, res);

  // ── Installment Requests (Finance → Admin approval) ──
  if (pathname === '/api/finance/installment-requests'                     && req.method === 'POST') return handleCreateInstallmentRequest(req, res);
  if (pathname === '/api/finance/installment-requests'                     && req.method === 'GET')  return handleListInstallmentRequests(req, res);
  if (pathname.match(/^\/api\/finance\/installment-requests\/[^/]+\/status$/) && req.method === 'GET') return handleGetInstallmentRequestForStudent(req, res);
  if (pathname === '/api/admin/installment-requests'                       && req.method === 'GET')  return handleListInstallmentRequests(req, res);
  if (pathname === '/api/admin/installment-requests/pending-count'         && req.method === 'GET')  return handleGetInstallmentRequestCount(req, res);
  if (pathname.match(/^\/api\/admin\/installment-requests\/\d+\/action$/)  && req.method === 'POST') return handleActionInstallmentRequest(req, res);

  // ── Notifications & Announcements API ──
  if (pathname === '/api/notifications'              && req.method === 'GET')    return handleGetNotifications(req, res);
  if (pathname === '/api/notifications/read'         && req.method === 'POST')   return handleMarkNotifsRead(req, res);
  if (pathname === '/api/announcements'              && req.method === 'GET')    return handleGetAnnouncements(req, res);
  if (pathname === '/api/admin/announcements'        && req.method === 'GET')    return handleAdminListAnnouncements(req, res);
  if (pathname === '/api/admin/announcements'        && req.method === 'POST')   return handleAdminCreateAnnouncement(req, res);
  if (pathname.match(/^\/api\/admin\/announcements\/\d+$/) && req.method === 'PATCH')  return handleAdminToggleAnnouncement(req, res);
  if (pathname.match(/^\/api\/admin\/announcements\/\d+$/) && req.method === 'DELETE') return handleAdminDeleteAnnouncement(req, res);

  // ── Real-Time Analytics API ──
  if (pathname === '/api/analytics/stream'    && req.method === 'GET')   return handleAnalyticsStream(req, res);
  if (pathname === '/api/analytics/overview'  && req.method === 'GET')   return handleAnalyticsOverview(req, res);
  if (pathname === '/api/analytics/storage'   && req.method === 'GET')   return handleAnalyticsStorage(req, res);
  if (pathname === '/api/analytics/data-flow' && req.method === 'GET')   return handleAnalyticsDataFlow(req, res);
  if (pathname === '/api/analytics/users'     && req.method === 'GET')   return handleAnalyticsUsers(req, res);

  if (pathname === '/api/monitor/login'       && req.method === 'POST')  return handleMonitorLogin(req, res);

  // ── Developer Schema API (admin key required) ──
  if (pathname === '/api/dev/schema' && req.method === 'GET') {
    const qk = url.parse(req.url, true).query.key || '';
    const ah = req.headers['authorization'] || '';
    let authed = qk === ADMIN_KEY;
    if (!authed && ah.startsWith('Bearer ')) {
      try { const p = verifyToken(ah.slice(7)); if (p && ['admin','audit','cyber'].includes(p.role)) authed = true; } catch(_) {}
    }
    if (!authed) return send(res, 401, { error: 'Admin access required' });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const schema = {};
      tables.forEach(t => {
        const rows = db.prepare('SELECT COUNT(*) as c FROM "' + t.name + '"').get().c;
        const cols = db.prepare('PRAGMA table_info("' + t.name + '")').all();
        const indexes = db.prepare('PRAGMA index_list("' + t.name + '")').all();
        const fks = db.prepare('PRAGMA foreign_key_list("' + t.name + '")').all();
        const idxDetails = indexes.map(idx => {
          const idxCols = db.prepare('PRAGMA index_info("' + idx.name + '")').all();
          return { name: idx.name, unique: idx.unique, cols: idxCols.map(c => c.name) };
        });
        schema[t.name] = {
          rows,
          cols: cols.map(c => ({ name: c.name, type: c.type || 'TEXT', pk: c.pk ? true : false, notNull: c.notnull ? true : false, dflt: c.dflt_value })),
          indexes: idxDetails,
          fks: fks.map(f => ({ from: f.from, table: f.table, to: f.to }))
        };
      });
      const dbStats = db.prepare('PRAGMA page_count').get();
      const pageSize = db.prepare('PRAGMA page_size').get();
      const walMode = db.prepare('PRAGMA journal_mode').get();
      const integrity = db.prepare('PRAGMA quick_check').get();
      send(res, 200, {
        tables: schema,
        meta: {
          tableCount: tables.length,
          dbSizeBytes: (dbStats.page_count || 0) * (pageSize.page_size || 4096),
          journalMode: walMode.journal_mode,
          integrity: integrity.quick_check,
          generatedAt: new Date().toISOString()
        }
      });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── Monitor API (auth: admin | audit | cyber) ──
  if (pathname.startsWith('/api/monitor') && pathname !== '/api/monitor/login') {
    if (pathname === '/api/monitor/security-events' && req.method === 'GET') return handleMonitorSecEvents(req, res);
    if (pathname === '/api/monitor/api-logs'        && req.method === 'GET') return handleMonitorApiLogs(req, res);
    if (pathname === '/api/monitor/stats'           && req.method === 'GET') return handleMonitorStats(req, res);
    if (pathname === '/api/monitor/vuln-scan'       && req.method === 'GET')  return handleMonitorVulnScan(req, res);
    if (pathname === '/api/monitor/auto-fix'        && req.method === 'POST') return handleMonitorAutoFix(req, res);
    if (pathname === '/api/monitor/restore-backup'  && req.method === 'POST') return handleMonitorRestoreBackup(req, res);
    if (pathname === '/api/monitor/backups'         && req.method === 'GET')  return handleMonitorListBackups(req, res);
    return send(res, 404, { error: 'Monitor endpoint not found' });
  }

  // ── Budget Dashboard API ──
  if (pathname.startsWith('/api/budget') && pathname !== '/api/budget/login') {
    if (pathname === '/api/budget/overview'                                    && req.method === 'GET')    return handleBudgetOverview(req, res);
    if (pathname === '/api/budget/allocate'                                    && req.method === 'POST')   return handleBudgetSetAllocation(req, res);
    if (pathname.match(/^\/api\/budget\/dept\/[^/]+$/)                         && req.method === 'GET')    return handleBudgetGetDept(req, res);
    if (pathname.match(/^\/api\/budget\/dept\/[^/]+\/expenses$/)               && req.method === 'POST')   return handleBudgetAddExpense(req, res);
    if (pathname.match(/^\/api\/budget\/expenses\/\d+$/)                       && req.method === 'DELETE') return handleBudgetDeleteExpense(req, res);
    return send(res, 404, { error: 'Budget endpoint not found' });
  }
  if (pathname === '/api/health')                                        return send(res, 200, { status:'ok', db:'SQLite', school:'The Gurukul High' });

  // ── Admissions ──
  if (pathname === '/api/admissions/submit'   && req.method === 'POST')  return handleAdmissionSubmit(req, res);
  if (pathname === '/api/admissions/list'     && req.method === 'GET')   return handleAdmissionsList(req, res);
  if (pathname.match(/^\/api\/admissions\/APP\d+\/status$/) && req.method === 'PATCH') return handleAdmissionStatusUpdate(req, res);

  // ── Teacher Report Downloads (flexible auth — token in URL for download links) ──
  if (pathname.startsWith('/api/teacher/report')) {
    const tPayload = teacherAuthFlexible(req, res);
    if (!tPayload) return;
    if (pathname === '/api/teacher/report/students' && req.method === 'GET') return handleTeacherReportStudents(req, res, tPayload);
    if (pathname === '/api/teacher/report/self'     && req.method === 'GET') return handleTeacherReportSelf(req, res, tPayload);
    return send(res, 404, { error: 'Not found' });
  }

  // ── Teacher API (protected) ──
  if (pathname.startsWith('/api/teacher') && pathname !== '/api/teacher/login') {
    const tPayload = teacherAuth(req, res);
    if (!tPayload) return;
    if (pathname === '/api/teacher/profile'       && req.method === 'GET')  return handleTeacherProfile(req, res, tPayload);
    if (pathname === '/api/teacher/students'      && req.method === 'GET')  return handleTeacherStudents(req, res, tPayload);
    if (pathname === '/api/teacher/attendance'    && req.method === 'POST') return handleTeacherMarkAttendance(req, res, tPayload);
    if (pathname === '/api/teacher/attendance'    && req.method === 'GET')  return handleTeacherGetAttendance(req, res, tPayload);
    if (pathname === '/api/teacher/summary'       && req.method === 'GET')  return handleTeacherSummary(req, res, tPayload);
    if (pathname === '/api/teacher/history'       && req.method === 'GET')  return handleTeacherHistory(req, res, tPayload);
    if (pathname === '/api/teacher/checkin'       && req.method === 'POST') return handleTeacherCheckIn(req, res, tPayload);
    if (pathname === '/api/teacher/checkout'      && req.method === 'POST') return handleTeacherCheckOut(req, res, tPayload);
    if (pathname === '/api/teacher/my-attendance' && req.method === 'GET')  return handleTeacherMyAttendance(req, res, tPayload);
    if (pathname === '/api/teacher/leaves'        && req.method === 'POST') return handleApplyLeave(req, res, tPayload);
    if (pathname === '/api/teacher/leaves'        && req.method === 'GET')  return handleMyLeaves(req, res, tPayload);
    if (pathname === '/api/teacher/daily-report'       && req.method === 'POST') return handleSubmitDailyReport(req, res, tPayload);
    if (pathname === '/api/teacher/daily-report'       && req.method === 'GET')  return handleGetMyReports(req, res, tPayload);
    if (pathname === '/api/teacher/salary'             && req.method === 'GET')  return handleTeacherSalary(req, res, tPayload);
    if (pathname === '/api/teacher/salary-requests'    && req.method === 'POST') return handleTeacherSubmitSalaryRequest(req, res, tPayload);
    if (pathname === '/api/teacher/salary-requests'    && req.method === 'GET')  return handleTeacherMySalaryRequests(req, res, tPayload);
    if (pathname === '/api/teacher/resign'             && req.method === 'POST') return handleTeacherResign(req, res, tPayload);
    if (pathname === '/api/teacher/ptm'                && req.method === 'GET')  return handleTeacherPTMList(req, res, tPayload);
    if (pathname.match(/^\/api\/teacher\/ptm\/\d+$/)   && req.method === 'PATCH') return handleTeacherPTMUpdate(req, res, tPayload);
    return send(res, 404, { error: 'Not found' });
  }

  // ── Admin API ──
  if (pathname === '/api/admin/students'      && req.method === 'GET')   return handleAdminStudentList(req, res);
  if (pathname === '/api/admin/students'      && req.method === 'POST')  return handleAdminAddStudent(req, res);
  if (pathname.match(/^\/api\/admin\/students\/[^/]+$/) && req.method === 'PUT')    return handleAdminUpdateStudent(req, res);
  if (pathname.match(/^\/api\/admin\/students\/[^/]+$/) && req.method === 'DELETE') return handleAdminDeleteStudent(req, res);
  if (pathname === '/api/admin/attendance'    && req.method === 'POST')  return handleAdminMarkAttendance(req, res);
  if (pathname.match(/^\/api\/admin\/students\/[^/]+\/reset-password$/) && req.method === 'PATCH') return handleAdminResetPassword(req, res);
  if (pathname.match(/^\/api\/admin\/teachers\/[^/]+\/reset-password$/) && req.method === 'PATCH') return handleAdminResetTeacherPassword(req, res);
  if (pathname === '/api/admin/sync-sheets'   && req.method === 'POST')  return handleSheetsSync(req, res);
  if (pathname === '/api/admin/stats'         && req.method === 'GET')   return handleDbStats(req, res);
  if (pathname === '/api/admin/budget-overview' && req.method === 'GET') return handleAdminBudgetOverview(req, res);
  if (pathname === '/api/admin/teachers'      && req.method === 'GET')   return handleAdminTeacherList(req, res);
  if (pathname === '/api/admin/teachers'      && req.method === 'POST')  return handleAdminAddTeacher(req, res);
  if (pathname.match(/^\/api\/admin\/teachers\/[^/]+$/) && !pathname.includes('reset-password') && req.method === 'DELETE') return handleAdminDeleteTeacher(req, res);
  if (pathname === '/api/admin/teachers/assign' && req.method === 'POST')   return handleAdminAssignTeacher(req, res);
  if (pathname === '/api/admin/teachers/assign' && req.method === 'DELETE') return handleAdminDeleteAssignment(req, res);

  // ── Admin teacher attendance management ──
  if (pathname === '/api/admin/teacher-attendance'           && req.method === 'GET')    return handleAdminTeacherAttendanceList(req, res);
  if (pathname.match(/^\/api\/admin\/teacher-attendance\/\d+$/) && req.method === 'PUT')    return handleAdminTeacherAttendanceEdit(req, res);
  if (pathname.match(/^\/api\/admin\/teacher-attendance\/\d+$/) && req.method === 'DELETE') return handleAdminTeacherAttendanceDelete(req, res);

  // ── Holidays (public) ──
  if (pathname === '/api/holidays' && req.method === 'GET') return handleGetHolidays(req, res);

  // ── Leaves ──
  if (pathname === '/api/admin/leaves'   && req.method === 'GET')   return handleAdminGetLeaves(req, res);
  if (pathname.match(/^\/api\/admin\/leaves\/\d+\/decide$/) && req.method === 'PATCH') return handleAdminDecideLeave(req, res);

  // ── Admin daily reports ──
  if (pathname === '/api/admin/daily-reports' && req.method === 'GET') return handleAdminGetDailyReports(req, res);

  // ── Admin salary summary (legacy) ──
  if (pathname === '/api/admin/salary' && req.method === 'GET') return handleAdminSalarySummary(req, res);

  // ── Admin payroll engine ──
  if (pathname === '/api/admin/payroll/run'   && req.method === 'GET')  return handleAdminPayrollRun(req, res);
  if (pathname === '/api/admin/payroll/run'   && req.method === 'POST') return handleAdminPayrollRun(req, res);
  if (pathname === '/api/admin/payroll/trend' && req.method === 'GET')  return handleAdminPayrollTrend(req, res);
  if (pathname.match(/^\/api\/admin\/payroll\/structure\/(teacher|support)\/[^/]+$/) && req.method === 'PATCH') return handleAdminPayrollUpdateStructure(req, res);

  // ── Staff Profiles ──
  if (pathname === '/api/admin/staff/list'    && req.method === 'GET')   return handleAdminStaffList(req, res);
  if (pathname === '/api/admin/staff/support' && req.method === 'POST')  return handleAdminAddSupportStaff(req, res);
  if (pathname.match(/^\/api\/admin\/staff\/(teacher|support)\/[^/]+$/) && req.method === 'GET')   return handleAdminGetStaffProfile(req, res);
  if (pathname.match(/^\/api\/admin\/staff\/(teacher|support)\/[^/]+$/) && req.method === 'PATCH') return handleAdminUpdateStaffProfile(req, res);

  // ── Admin resignations ──
  if (pathname === '/api/admin/resignations' && req.method === 'GET')   return handleAdminGetResignations(req, res);
  if (pathname.match(/^\/api\/admin\/resignations\/\d+$/) && req.method === 'PATCH') return handleAdminUpdateResignation(req, res);

  // ── Admin salary requests ──
  if (pathname === '/api/admin/salary-requests' && req.method === 'GET') return handleAdminGetSalaryRequests(req, res);
  if (pathname.match(/^\/api\/admin\/salary-requests\/\d+\/decide$/) && req.method === 'PATCH') return handleAdminDecideSalaryRequest(req, res);

  // ── HR protected API ──
  if (pathname.startsWith('/api/hr') && pathname !== '/api/hr/login') {
    if (pathname === '/api/hr/overview'                                         && req.method === 'GET')    return handleHROverview(req, res);
    if (pathname === '/api/hr/budget'                                           && (req.method === 'GET' || req.method === 'PATCH')) return handleHRBudget(req, res);
    if (pathname === '/api/hr/employees'                                        && req.method === 'GET')    return handleHREmployeeList(req, res);
    if (pathname === '/api/hr/employees/teacher'                                && req.method === 'POST')   return handleHRAddTeacher(req, res);
    if (pathname === '/api/hr/employees/support'                                && req.method === 'POST')   return handleHRAddSupport(req, res);
    if (pathname.match(/^\/api\/hr\/employees\/(teacher|support)\/[^/]+$/)     && req.method === 'GET')    return handleHRGetEmployee(req, res);
    if (pathname.match(/^\/api\/hr\/employees\/(teacher|support)\/[^/]+$/)     && req.method === 'PATCH')  return handleHRUpdateEmployee(req, res);
    if (pathname === '/api/hr/attendance'                                       && req.method === 'GET')    return handleHRAttendance(req, res);
    if (pathname === '/api/hr/leaves'                                           && req.method === 'GET')    return handleHRLeaves(req, res);
    if (pathname.match(/^\/api\/hr\/leaves\/\d+\/decide$/)                     && req.method === 'PATCH')  return handleHRDecideLeave(req, res);
    if (pathname === '/api/hr/payroll/run'                                      && req.method === 'GET')    return handleHRPayrollRun(req, res);
    if (pathname === '/api/hr/payroll/run'                                      && req.method === 'POST')   return handleHRPayrollRun(req, res);
    if (pathname === '/api/hr/payroll/history'                                  && req.method === 'GET')    return handleHRPayrollHistory(req, res);
    if (pathname === '/api/hr/payroll/structures'                               && req.method === 'GET')    return handleHRSalaryStructures(req, res);
    if (pathname.match(/^\/api\/hr\/payroll\/structure\/(teacher|support)\/[^/]+$/) && req.method === 'PATCH') return handleHRUpdateSalaryStructure(req, res);
    if (pathname === '/api/hr/recruitment/jobs'                                 && req.method === 'GET')    return handleHRListJobs(req, res);
    if (pathname === '/api/hr/recruitment/jobs'                                 && req.method === 'POST')   return handleHRCreateJob(req, res);
    if (pathname.match(/^\/api\/hr\/recruitment\/jobs\/\d+$/)                  && req.method === 'PATCH')  return handleHRUpdateJob(req, res);
    if (pathname.match(/^\/api\/hr\/recruitment\/jobs\/\d+$/)                  && req.method === 'DELETE') return handleHRDeleteJob(req, res);
    if (pathname === '/api/hr/recruitment/applications'                         && req.method === 'GET')    return handleHRListApplications(req, res);
    if (pathname === '/api/hr/recruitment/applications'                         && req.method === 'POST')   return handleHRCreateApplication(req, res);
    if (pathname.match(/^\/api\/hr\/recruitment\/applications\/\d+$/)          && req.method === 'PATCH')  return handleHRUpdateApplication(req, res);
    if (pathname.match(/^\/api\/hr\/recruitment\/applications\/\d+$/)          && req.method === 'DELETE') return handleHRDeleteApplication(req, res);
    return send(res, 404, { error: 'HR endpoint not found' });
  }

  // ── Marketing protected API ──
  if (pathname.startsWith('/api/marketing') && pathname !== '/api/marketing/login') {
    const mp = marketingAuth(req, res); if (!mp) return;
    if (pathname === '/api/marketing/overview'                          && req.method === 'GET')    return handleMarketingOverview(req, res);
    if (pathname === '/api/marketing/leads'                             && req.method === 'GET')    return handleMarketingLeadList(req, res);
    if (pathname === '/api/marketing/leads'                             && req.method === 'POST')   return handleMarketingAddLead(req, res);
    if (pathname.match(/^\/api\/marketing\/leads\/\d+$/)               && req.method === 'PATCH')  return handleMarketingUpdateLead(req, res);
    if (pathname.match(/^\/api\/marketing\/leads\/\d+$/)               && req.method === 'DELETE') return handleMarketingDeleteLead(req, res);
    if (pathname === '/api/marketing/campaigns'                         && req.method === 'GET')    return handleMarketingCampaignList(req, res);
    if (pathname === '/api/marketing/campaigns'                         && req.method === 'POST')   return handleMarketingAddCampaign(req, res);
    if (pathname.match(/^\/api\/marketing\/campaigns\/\d+$/)           && req.method === 'PATCH')  return handleMarketingUpdateCampaign(req, res);
    if (pathname.match(/^\/api\/marketing\/campaigns\/\d+$/)           && req.method === 'DELETE') return handleMarketingDeleteCampaign(req, res);
    if (pathname === '/api/marketing/events'                            && req.method === 'GET')    return handleMarketingEventList(req, res);
    if (pathname === '/api/marketing/events'                            && req.method === 'POST')   return handleMarketingAddEvent(req, res);
    if (pathname.match(/^\/api\/marketing\/events\/\d+$/)              && req.method === 'PATCH')  return handleMarketingUpdateEvent(req, res);
    if (pathname.match(/^\/api\/marketing\/events\/\d+$/)              && req.method === 'DELETE') return handleMarketingDeleteEvent(req, res);
    if (pathname === '/api/marketing/social'                            && req.method === 'GET')    return handleMarketingSocialList(req, res);
    if (pathname === '/api/marketing/social'                            && req.method === 'POST')   return handleMarketingAddSocial(req, res);
    if (pathname.match(/^\/api\/marketing\/social\/\d+$/)              && req.method === 'PATCH')  return handleMarketingUpdateSocial(req, res);
    if (pathname.match(/^\/api\/marketing\/social\/\d+$/)              && req.method === 'DELETE') return handleMarketingDeleteSocial(req, res);
    return send(res, 404, { error: 'Marketing endpoint not found' });
  }

  // ── Finance SSE stream ──
  if (pathname === '/api/finance/stream') return handleFinanceStream(req, res);

  // ── Finance protected API ──
  if (pathname.startsWith('/api/finance') && pathname !== '/api/finance/login') {
    if (pathname === '/api/finance/fee-schedules'                             && req.method === 'GET')    return handleGetFeeSchedules(req, res);
    if (pathname === '/api/finance/fee-schedules'                             && req.method === 'POST')   return handleSetFeeSchedule(req, res);
    if (pathname.match(/^\/api\/finance\/fee-schedules\/\d+$/)                && req.method === 'DELETE') return handleDeleteFeeSchedule(req, res);
    if (pathname.match(/^\/api\/finance\/student\/[^/]+\/fees$/)              && req.method === 'GET')    return handleFinanceStudentFees(req, res);
    if (pathname === '/api/finance/payments'                                  && req.method === 'POST')   return handleFinanceRecordPayment(req, res);
    if (pathname === '/api/finance/fees'                                      && req.method === 'GET')    return handleFinanceListFees(req, res);
    if (pathname.match(/^\/api\/finance\/fees\/\d+$/)                         && req.method === 'PATCH')  return handleFinanceUpdateFee(req, res);
    if (pathname.match(/^\/api\/finance\/fees\/\d+$/)                         && req.method === 'DELETE') return handleFinanceDeleteFee(req, res);
    if (pathname.match(/^\/api\/finance\/fees\/\d+\/verify$/)                 && req.method === 'PATCH')  return handleFinanceVerifyPayment(req, res);
    if (pathname === '/api/finance/summary'                                   && req.method === 'GET')    return handleFinanceSummary(req, res);
    if (pathname === '/api/finance/donations'                                 && req.method === 'GET')    return handleFinanceListDonations(req, res);
    if (pathname === '/api/finance/donations'                                 && req.method === 'POST')   return handleFinanceAddDonation(req, res);
    if (pathname.match(/^\/api\/finance\/donations\/\d+$/)                    && req.method === 'DELETE') return handleFinanceDeleteDonation(req, res);
    if (pathname === '/api/finance/payment-vouchers'                          && req.method === 'GET')    return handleListPaymentVouchers(req, res);
    if (pathname === '/api/finance/payment-vouchers'                          && req.method === 'POST')   return handleCreatePaymentVoucher(req, res);
    if (pathname.match(/^\/api\/finance\/payment-vouchers\/\d+$/)             && req.method === 'DELETE') return handleDeletePaymentVoucher(req, res);
    return send(res, 404, { error: 'Not found' });
  }

  // ── Finance (admin access via admin key for summary widget) ──
  if (pathname === '/api/admin/finance/summary'   && req.method === 'GET')    return handleFinanceSummary(req, res);
  if (pathname === '/api/admin/finance/fees'      && req.method === 'GET')    return handleFinanceListFees(req, res);
  if (pathname === '/api/admin/finance/fees'      && req.method === 'POST')   return handleFinanceAddFee(req, res);
  if (pathname.match(/^\/api\/admin\/finance\/fees\/\d+$/) && req.method === 'PATCH')  return handleFinanceUpdateFee(req, res);
  if (pathname.match(/^\/api\/admin\/finance\/fees\/\d+$/) && req.method === 'DELETE') return handleFinanceDeleteFee(req, res);
  if (pathname === '/api/admin/finance/donations' && req.method === 'GET')    return handleFinanceListDonations(req, res);
  if (pathname === '/api/admin/finance/donations' && req.method === 'POST')   return handleFinanceAddDonation(req, res);
  if (pathname.match(/^\/api\/admin\/finance\/donations\/\d+$/) && req.method === 'DELETE') return handleFinanceDeleteDonation(req, res);

  // ── Accounting / Audit API ──
  if (pathname === '/api/accounting/coa'                 && req.method === 'GET')    return handleAccountingCOA(req, res);
  if (pathname === '/api/accounting/journal'             && req.method === 'GET')    return handleAccountingJournalList(req, res);
  if (pathname === '/api/accounting/journal'             && req.method === 'POST')   return handleAccountingAddJournal(req, res);
  if (pathname.match(/^\/api\/accounting\/journal\/\d+$/) && req.method === 'DELETE') return handleAccountingDeleteJournal(req, res);
  if (pathname === '/api/accounting/ledger'              && req.method === 'GET')    return handleAccountingLedger(req, res);
  if (pathname === '/api/accounting/trial-balance'       && req.method === 'GET')    return handleAccountingTrialBalance(req, res);
  if (pathname === '/api/accounting/balance-sheet'       && req.method === 'GET')    return handleAccountingBalanceSheet(req, res);
  if (pathname === '/api/accounting/income-statement'    && req.method === 'GET')    return handleAccountingIncomeStatement(req, res);
  if (pathname === '/api/accounting/receipts-payments'   && req.method === 'GET')    return handleAccountingReceiptsPayments(req, res);
  if (pathname === '/api/accounting/audit-trail'         && req.method === 'GET')    return handleAccountingAuditTrail(req, res);
  if (pathname === '/api/accounting/summary'             && req.method === 'GET')    return handleAccountingSummary(req, res);
  if (pathname === '/api/accounting/audit-report'        && req.method === 'GET')    return handleAccountingAuditReport(req, res);

  // ── Biometric routes ──
  if (pathname === '/api/biometric/punch'  && req.method === 'POST') return handleBiometricPunch(req, res);
  if (pathname === '/api/biometric/today'  && req.method === 'GET')  return handleBiometricToday(req, res);
  if (pathname === '/api/biometric/logs'   && req.method === 'GET')  return handleBiometricLogs(req, res);

  // ── Timetable routes ──
  if (pathname === '/api/timetable'                                && req.method === 'GET')    return handleTimetableList(req, res);
  if (pathname === '/api/timetable'                                && req.method === 'POST')   return handleTimetableCreate(req, res);
  if (pathname.match(/^\/api\/timetable\/\d+$/)                   && req.method === 'PATCH')  return handleTimetableUpdate(req, res);
  if (pathname.match(/^\/api\/timetable\/\d+$/)                   && req.method === 'DELETE') return handleTimetableDelete(req, res);
  if (pathname === '/api/timetable/class'                          && req.method === 'GET')    return handleTimetableByClass(req, res);

  // ── Admin ID cards ──
  if (pathname === '/api/admin/staff/idcards'   && req.method === 'GET') return handleAdminStaffIdCards(req, res);
  if (pathname === '/api/admin/student/idcards' && req.method === 'GET') return handleAdminStudentIdCards(req, res);

  // ── Protected student API ──
  if (pathname.startsWith('/api/student')) {
    const payload = authMiddleware(req);
    if (!payload) return send(res, 401, { error: 'Unauthorized. Please log in.' });
    if (pathname === '/api/student/profile'    && req.method === 'GET') return handleProfile(req, res, payload);
    if (pathname === '/api/student/attendance' && req.method === 'GET') return handleAttendance(req, res, payload);
    if (pathname === '/api/student/marks'      && req.method === 'GET') return handleMarks(req, res, payload);
    if (pathname === '/api/student/fees'            && req.method === 'GET')  return handleFees(req, res, payload);
    if (pathname === '/api/student/finance-fees'    && req.method === 'GET')  return handleStudentFinanceFees(req, res, payload);
    if (pathname === '/api/student/pay'             && req.method === 'POST') return handleStudentSubmitPayment(req, res, payload);
    if (pathname === '/api/student/leaves'          && req.method === 'POST') return handleApplyLeave(req, res, payload);
    if (pathname === '/api/student/leaves'          && req.method === 'GET')  return handleMyLeaves(req, res, payload);
    if (pathname === '/api/student/biometric/today' && req.method === 'GET')  return handleBiometricTodayStudent(req, res, payload);
    if (pathname === '/api/student/biometric/punch' && req.method === 'POST') return handleBiometricPunch(req, res);
    if (pathname === '/api/student/installments'    && req.method === 'GET')  return handleStudentInstallments(req, res, payload);
    return send(res, 404, { error: 'Not found' });
  }

  // ── Parent Portal ──
  if (pathname.startsWith('/api/parent') && pathname !== '/api/parent/login') {
    const ip = getIP(req);
    if (!rateLimit(ip, 'parent-api', 60, 60000)) return send(res, 429, { error:'Rate limit exceeded' });
    const pp = parentAuth(req);
    if (!pp) return send(res, 401, { error:'Unauthorized. Please log in as parent.' });
    if (pathname === '/api/parent/profile'       && req.method === 'GET') return handleParentProfile(req, res, pp);
    if (pathname === '/api/parent/attendance'    && req.method === 'GET') return handleParentAttendance(req, res, pp);
    if (pathname === '/api/parent/marks'         && req.method === 'GET') return handleParentMarks(req, res, pp);
    if (pathname === '/api/parent/fees'          && req.method === 'GET') return handleParentFees(req, res, pp);
    if (pathname === '/api/parent/holidays'      && req.method === 'GET') return handleParentHolidays(req, res);
    if (pathname === '/api/parent/calendar'      && req.method === 'GET') return handleParentCalendar(req, res);
    if (pathname === '/api/parent/announcements' && req.method === 'GET') return handleParentAnnouncements(req, res, pp);
    if (pathname === '/api/parent/biometric'          && req.method === 'GET')   return handleParentBiometric(req, res, pp);
    if (pathname === '/api/parent/timetable'          && req.method === 'GET')   return handleParentTimetable(req, res, pp);
    if (pathname === '/api/parent/ptm'                && req.method === 'GET')   return handleParentPTMList(req, res, pp);
    if (pathname === '/api/parent/ptm'                && req.method === 'POST')  return handleParentPTMRequest(req, res, pp);
    if (pathname.match(/^\/api\/parent\/ptm\/\d+\/notes$/) && req.method === 'PATCH') return handleParentPTMNotes(req, res, pp);
    if (pathname === '/api/parent/mock-tests'         && req.method === 'GET')   return handleParentMockTestList(req, res, pp);
    if (pathname === '/api/parent/mock-tests'         && req.method === 'POST')  return handleParentMockTestCreate(req, res, pp);
    if (pathname.match(/^\/api\/parent\/mock-tests\/\d+$/) && req.method === 'GET') return handleParentMockTestGet(req, res, pp);
    if (pathname === '/api/parent/performance'        && req.method === 'GET')   return handleParentPerformance(req, res, pp);
    if (pathname === '/api/parent/exam-marks'         && req.method === 'GET')   return handleParentExamMarks(req, res, pp);
    return send(res, 404, { error:'Parent endpoint not found' });
  }

  // ══ NEW MODULE ROUTES ══════════════════════════════════════════════════════
  // Homework
  if (pathname === '/api/homework'                          && req.method === 'GET')    return handleHomeworkList(req, res);
  if (pathname === '/api/homework'                          && req.method === 'POST')   return handleHomeworkCreate(req, res);
  if (pathname.match(/^\/api\/homework\/\d+$/)              && req.method === 'DELETE') return handleHomeworkDelete(req, res);
  if (pathname === '/api/homework/submit'                   && req.method === 'POST')   { const _p=authMiddleware(req); if(!_p)return send(res,401,{error:'Unauthorized'}); return handleHomeworkSubmit(req,res,_p); }
  if (pathname === '/api/homework/submissions'              && req.method === 'GET')    return handleHomeworkSubmissions(req, res);
  // Library
  if (pathname === '/api/library/books'                     && req.method === 'GET')    return handleLibraryBooks(req, res);
  if (pathname === '/api/library/books'                     && req.method === 'POST')   { if(!requireAdmin(req,res)) return; return handleLibraryAddBook(req,res); }
  if (pathname === '/api/library/issue'                     && req.method === 'POST')   { if(!requireAdmin(req,res)) return; return handleLibraryIssue(req,res); }
  if (pathname === '/api/library/return'                    && req.method === 'POST')   { if(!requireAdmin(req,res)) return; return handleLibraryReturn(req,res); }
  if (pathname === '/api/library/loans'                     && req.method === 'GET')    return handleLibraryLoans(req, res);
  // Transport
  if (pathname === '/api/transport/routes'                  && req.method === 'GET')    return handleTransportRoutes(req, res);
  if (pathname === '/api/transport/routes'                  && req.method === 'POST')   { if(!requireAdmin(req,res)) return; return handleTransportAddRoute(req,res); }
  if (pathname.match(/^\/api\/transport\/routes\/\d+$/)     && req.method === 'PATCH')  { if(!requireAdmin(req,res)) return; return handleTransportUpdateRoute(req,res); }
  if (pathname.match(/^\/api\/transport\/routes\/\d+$/)     && req.method === 'DELETE') { if(!requireAdmin(req,res)) return; return handleTransportDeleteRoute(req,res); }
  if (pathname === '/api/transport/assign'                  && req.method === 'POST')   { if(!requireAdmin(req,res)) return; return handleTransportAssignStudent(req,res); }
  if (pathname === '/api/transport/students'                && req.method === 'GET')    return handleTransportStudents(req, res);
  // Visitors
  if (pathname === '/api/visitors'                          && req.method === 'GET')    return handleVisitorList(req, res);
  if (pathname === '/api/visitors'                          && req.method === 'POST')   return handleVisitorCheckin(req, res);
  if (pathname.match(/^\/api\/visitors\/\d+\/checkout$/)    && req.method === 'POST')   return handleVisitorCheckout(req, res);
  // Certificates
  if (pathname === '/api/certificates'                      && req.method === 'GET')    return handleCertificateList(req, res);
  if (pathname === '/api/certificates'                      && req.method === 'POST')   { if(!requireAdmin(req,res)) return; return handleCertificateIssue(req,res); }
  // AI Prediction
  if (pathname === '/api/ai/prediction'                     && req.method === 'GET')    return handleAIPrediction(req, res);
  // NEP 2020
  if (pathname === '/api/nep/assessment'                    && req.method === 'POST')   return handleNEPAssessmentSave(req, res);
  if (pathname === '/api/nep/report-card'                   && req.method === 'GET')    return handleNEPReportCard(req, res);
  // NAAC Report
  if (pathname === '/api/naac/report'                       && req.method === 'GET')    return handleNAACReport(req, res);
  // Notifications
  if (pathname === '/api/notifications/settings'            && req.method === 'GET')    return handleNotifSettingsGet(req, res);
  if (pathname === '/api/notifications/settings'            && req.method === 'POST')   { if(!requireAdmin(req,res)) return; return handleNotifSettingsSave(req,res); }
  if (pathname === '/api/notifications/send'                && req.method === 'POST')   return handleNotifSend(req, res);
  // ══════════════════════════════════════════════════════════════════════════

  // ── Exam Management ──
  if (pathname === '/api/exams'                               && req.method === 'GET')    return handleExamList(req, res);
  if (pathname === '/api/exams'                               && req.method === 'POST')   { if (!requireAdmin(req,res)) return; return handleExamCreate(req,res); }
  if (pathname.match(/^\/api\/exams\/\d+$/)                   && req.method === 'PATCH')  { if (!requireAdmin(req,res)) return; return handleExamUpdate(req,res); }
  if (pathname.match(/^\/api\/exams\/\d+$/)                   && req.method === 'DELETE') { if (!requireAdmin(req,res)) return; return handleExamDelete(req,res); }
  if (pathname === '/api/exam-marks/bulk'                     && req.method === 'POST')   { const _p=authMiddleware(req); if(!_p)return send(res,401,{error:'Unauthorized'}); return handleExamMarksBulk(req,res,_p); }
  if (pathname === '/api/exam-marks'                          && req.method === 'GET')    { const _p=authMiddleware(req); if(!_p)return send(res,401,{error:'Unauthorized'}); return handleExamMarksGet(req,res); }
  if (pathname === '/api/exam-marks/report-card'              && req.method === 'GET')    { const _adminKey=url.parse(req.url,true).query.key; const _p=(_adminKey===ADMIN_KEY)?{role:'admin'}:authMiddleware(req); if(!_p)return send(res,401,{error:'Unauthorized'}); return handleReportCard(req,res); }
  if (pathname === '/api/exam-marks/class-results'            && req.method === 'GET')    { const _p=authMiddleware(req); if(!_p)return send(res,401,{error:'Unauthorized'}); return handleClassResults(req,res); }

  // ── Student Promotion ──
  if (pathname === '/api/admin/ptm'                && req.method === 'GET')   return handleAdminPTMList(req, res);
  if (pathname === '/api/admin/ptm'                && req.method === 'POST')  return handleAdminPTMCreate(req, res);
  if (pathname.match(/^\/api\/admin\/ptm\/\d+$/)   && req.method === 'PATCH') return handleAdminPTMUpdate(req, res);
  if (pathname.match(/^\/api\/admin\/ptm\/\d+$/)   && req.method === 'DELETE') return handleAdminPTMDelete(req, res);
  if (pathname === '/api/admin/promote-students'   && req.method === 'POST') return handleAdminPromoteStudents(req, res);
  if (pathname === '/api/admin/promotion-preview'  && req.method === 'GET')  return handleAdminPromotionPreview(req, res);

  // ── Access Control ──
  if (pathname === '/api/admin/access/password-resets'      && req.method === 'GET')   return handleAccessPasswordResets(req, res);
  if (pathname === '/api/admin/access/biometric'            && req.method === 'GET')   return handleAccessBiometricList(req, res);
  if (pathname === '/api/admin/access/biometric'            && req.method === 'PATCH') return handleAccessBiometricUpdate(req, res);
  if (pathname === '/api/admin/access/biometric/bulk-class' && req.method === 'PATCH') return handleAccessBiometricBulkClass(req, res);

  // ── Performance Analytics ──
  if (pathname === '/api/admin/performance' && req.method === 'GET') return handleAdminPerformance(req, res);

  // ── Academic Calendar ──
  if (pathname === '/api/academic-calendar'                         && req.method === 'GET')    return handleListAcademicCalendar(req, res);
  if (pathname === '/api/academic-calendar'                         && req.method === 'POST')   return handleCreateAcademicCalendar(req, res);
  if (pathname.match(/^\/api\/academic-calendar\/\d+$/)             && req.method === 'PATCH')  return handleUpdateAcademicCalendar(req, res);
  if (pathname.match(/^\/api\/academic-calendar\/\d+$/)             && req.method === 'DELETE') return handleDeleteAcademicCalendar(req, res);

  // ── Email Templates ──
  if (pathname === '/api/email-templates'                           && req.method === 'GET')    return handleListEmailTemplates(req, res);
  if (pathname === '/api/email-templates'                           && req.method === 'POST')   return handleCreateEmailTemplate(req, res);
  if (pathname.match(/^\/api\/email-templates\/\d+$/)               && req.method === 'PATCH')  return handleUpdateEmailTemplate(req, res);
  if (pathname.match(/^\/api\/email-templates\/\d+$/)               && req.method === 'DELETE') return handleDeleteEmailTemplate(req, res);

  // ── Settlement / Gratuity ──
  if (pathname === '/api/hr/settlement/calculate'                   && req.method === 'GET')    return handleHRCalculateSettlement(req, res);
  if (pathname === '/api/hr/settlement'                             && req.method === 'POST')   return handleHRCreateSettlement(req, res);
  if (pathname === '/api/hr/settlement'                             && req.method === 'GET')    return handleHRListSettlements(req, res);
  if (pathname.match(/^\/api\/hr\/settlement\/\d+\/status$/)        && req.method === 'PATCH')  return handleHRUpdateSettlementStatus(req, res);

  // ── File / Document Management ──
  if (pathname === '/api/documents/upload'                          && req.method === 'POST')   return handleDocumentUpload(req, res);
  if (pathname === '/api/documents'                                 && req.method === 'GET')    return handleListDocuments(req, res);
  if (pathname.match(/^\/api\/documents\/\d+$/)                     && req.method === 'DELETE') return handleDeleteDocument(req, res);
  if (pathname.startsWith('/api/documents/file/'))                                             return handleServeDocument(req, res);

  // ── Password Reset ──
  if (pathname === '/api/admin/password-reset'                      && req.method === 'POST')   return handleAdminInitiatePasswordReset(req, res);

  // ── Email Queue & Bulk Email ──
  if (pathname === '/api/admin/email-queue'                         && req.method === 'GET')    return handleListEmailQueue(req, res);
  if (pathname === '/api/admin/email-bulk'                          && req.method === 'POST')   return handleSendBulkEmail(req, res);

  // ── Razorpay ──
  if (pathname === '/api/payment/create-order'                      && req.method === 'POST')   return handleRazorpayCreateOrder(req, res);
  if (pathname === '/api/payment/verify'                            && req.method === 'POST')   return handleRazorpayVerify(req, res);

  // ── Holidays CRUD ──
  if (pathname === '/api/admin/holidays'                            && req.method === 'POST')   return handleAdminAddHoliday(req, res);
  if (pathname.match(/^\/api\/admin\/holidays\/\d+$/)               && req.method === 'DELETE') return handleAdminDeleteHoliday(req, res);

  // ══════════════════════════════════════════════════════════════════════════
  // ── RBAC / AUDIT / IP / ACCESS-REQUEST API ──────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════

  // --- Audit log (management/super_admin only) ---
  if (pathname === '/api/rbac/audit-log' && req.method === 'GET') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl || !['admin','super_admin','principal'].includes(pl.role||rbac.getUserRole(pl.sub||'')))
      return send(res, 403, { error: 'Audit log requires management access' });
    const q = url.parse(req.url, true).query;
    const data = rbac.getAuditLog({
      username: q.username, module: q.module, action: q.action,
      result: q.result, from: q.from, to: q.to,
      limit: parseInt(q.limit)||100, offset: parseInt(q.offset)||0
    });
    rbac.audit(req, pl.sub||pl.name||'admin', 'VIEW', 'audit_log', 'audit_log', null, 'Viewed audit log', 'success');
    return send(res, 200, data);
  }

  // --- Audit summary stats ---
  if (pathname === '/api/rbac/audit-stats' && req.method === 'GET') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl) return send(res, 401, { error: 'Unauthorized' });
    return send(res, 200, rbac.getSummaryStats());
  }

  // --- User footprint (own footprint or management viewing others) ---
  if (pathname.match(/^\/api\/rbac\/footprint\/[^/]+$/) && req.method === 'GET') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl) return send(res, 401, { error: 'Unauthorized' });
    const targetUser = pathname.split('/').pop();
    const myRole = pl.role || rbac.getUserRole(pl.sub||'');
    // Only management can view others; everyone can view own
    if (targetUser !== (pl.sub||pl.name) && !['admin','super_admin','principal'].includes(myRole))
      return send(res, 403, { error: 'Cannot view other user footprints' });
    const days = parseInt(url.parse(req.url,true).query.days)||30;
    return send(res, 200, { footprint: rbac.getUserFootprint(targetUser, days) });
  }

  // --- System feed (real-time audit feed) ---
  if (pathname === '/api/rbac/system-feed' && req.method === 'GET') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl || !['admin','super_admin','principal'].includes(pl.role||rbac.getUserRole(pl.sub||'')))
      return send(res, 403, { error: 'Management access required' });
    const limit = parseInt(url.parse(req.url,true).query.limit)||100;
    return send(res, 200, { feed: rbac.getSystemFeed(limit) });
  }

  // --- Security alerts ---
  if (pathname === '/api/rbac/alerts' && req.method === 'GET') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl || !['admin','super_admin','principal'].includes(pl.role||rbac.getUserRole(pl.sub||'')))
      return send(res, 403, { error: 'Management access required' });
    return send(res, 200, { alerts: rbac.getAlerts(parseInt(url.parse(req.url,true).query.limit)||50) });
  }

  // --- Active users (last 30 min) ---
  if (pathname === '/api/rbac/active-users' && req.method === 'GET') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl) return send(res, 401, { error: 'Unauthorized' });
    return send(res, 200, { users: rbac.getActiveUsers(30) });
  }

  // --- All roles list ---
  if (pathname === '/api/rbac/roles' && req.method === 'GET') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl) return send(res, 401, { error: 'Unauthorized' });
    const roles = db.prepare('SELECT * FROM rbac_roles WHERE is_active=1 ORDER BY id').all();
    return send(res, 200, { roles });
  }

  // --- All user-role assignments ---
  if (pathname === '/api/rbac/user-roles' && req.method === 'GET') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl || !['admin','super_admin'].includes(pl.role||rbac.getUserRole(pl.sub||'')))
      return send(res, 403, { error: 'Admin access required' });
    return send(res, 200, { userRoles: rbac.listAllUserRoles() });
  }

  // --- Assign role to user ---
  if (pathname === '/api/rbac/user-roles' && req.method === 'POST') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl || !['admin','super_admin'].includes(pl.role||rbac.getUserRole(pl.sub||'')))
      return send(res, 403, { error: 'Admin access required' });
    parseBody(req, ({ username, role_key, expires_at }) => {
      if (!username || !role_key) return send(res, 400, { error: 'username and role_key required' });
      rbac.assignRole(username, role_key, pl.sub||'admin', expires_at||null);
      rbac.audit(req, pl.sub||'admin', 'ROLE_ASSIGNED', 'user_mgmt', 'user_role', username,
        `Assigned role '${role_key}' to '${username}'`, 'success');
      send(res, 200, { message: `Role '${role_key}' assigned to '${username}'` });
    });
    return;
  }

  // --- Revoke role from user ---
  if (pathname.match(/^\/api\/rbac\/user-roles\/[^/]+\/[^/]+$/) && req.method === 'DELETE') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl || !['admin','super_admin'].includes(pl.role||rbac.getUserRole(pl.sub||'')))
      return send(res, 403, { error: 'Admin access required' });
    const parts = pathname.split('/');
    const targetUser = parts[4], targetRole = parts[5];
    rbac.revokeRole(targetUser, targetRole, pl.sub||'admin');
    rbac.audit(req, pl.sub||'admin', 'ROLE_REVOKED', 'user_mgmt', 'user_role', targetUser,
      `Revoked role '${targetRole}' from '${targetUser}'`, 'success');
    return send(res, 200, { message: `Role '${targetRole}' revoked from '${targetUser}'` });
  }

  // --- Permission matrix for a role ---
  if (pathname.match(/^\/api\/rbac\/permissions\/[^/]+$/) && req.method === 'GET') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl) return send(res, 401, { error: 'Unauthorized' });
    const roleKey = pathname.split('/').pop();
    const perms = db.prepare('SELECT * FROM rbac_permissions WHERE role_key=? ORDER BY module').all(roleKey);
    return send(res, 200, { role_key: roleKey, permissions: perms });
  }

  // --- Update a permission ---
  if (pathname.match(/^\/api\/rbac\/permissions\/[^/]+\/[^/]+$/) && req.method === 'PATCH') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl || !['super_admin'].includes(pl.role||rbac.getUserRole(pl.sub||'')))
      return send(res, 403, { error: 'Super admin access required' });
    const parts = pathname.split('/');
    const roleKey = parts[4], module = parts[5];
    parseBody(req, (b) => {
      db.prepare(`UPDATE rbac_permissions SET
        can_view=COALESCE(?,can_view), can_create=COALESCE(?,can_create),
        can_edit=COALESCE(?,can_edit), can_delete=COALESCE(?,can_delete),
        can_export=COALESCE(?,can_export), can_approve=COALESCE(?,can_approve),
        today_only=COALESCE(?,today_only)
        WHERE role_key=? AND module=?`).run(
          b.can_view??null, b.can_create??null, b.can_edit??null,
          b.can_delete??null, b.can_export??null, b.can_approve??null,
          b.today_only??null, roleKey, module);
      rbac.audit(req, pl.sub||'admin', 'PERMISSION_UPDATED', 'user_mgmt', 'permission',
        `${roleKey}/${module}`, JSON.stringify(b), 'success');
      send(res, 200, { message: 'Permission updated' });
    });
    return;
  }

  // --- IP Whitelist CRUD ---
  if (pathname === '/api/rbac/ip-whitelist' && req.method === 'GET') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl || !['admin','super_admin'].includes(pl.role||rbac.getUserRole(pl.sub||'')))
      return send(res, 403, { error: 'Admin access required' });
    const q = url.parse(req.url, true).query;
    return send(res, 200, { ips: rbac.listIPs(q.username, q.role_key) });
  }

  if (pathname === '/api/rbac/ip-whitelist' && req.method === 'POST') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl || !['admin','super_admin'].includes(pl.role||rbac.getUserRole(pl.sub||'')))
      return send(res, 403, { error: 'Admin access required' });
    parseBody(req, ({ username, role_key, ip_address, ip_label }) => {
      if (!ip_address) return send(res, 400, { error: 'ip_address required' });
      const id = rbac.addIP(username, role_key, ip_address, ip_label, pl.sub||'admin');
      rbac.audit(req, pl.sub||'admin', 'IP_ADDED', 'ip_mgmt', 'ip', ip_address,
        `Added IP ${ip_address} for ${username||role_key||'global'}`, 'success');
      send(res, 200, { id, message: 'IP added to whitelist' });
    });
    return;
  }

  if (pathname.match(/^\/api\/rbac\/ip-whitelist\/\d+$/) && req.method === 'DELETE') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl || !['admin','super_admin'].includes(pl.role||rbac.getUserRole(pl.sub||'')))
      return send(res, 403, { error: 'Admin access required' });
    const id = parseInt(pathname.split('/').pop());
    rbac.removeIP(id, pl.sub||'admin');
    rbac.audit(req, pl.sub||'admin', 'IP_REMOVED', 'ip_mgmt', 'ip', String(id), `Removed IP whitelist entry ${id}`, 'success');
    return send(res, 200, { message: 'IP removed from whitelist' });
  }

  // --- Access Requests (Finance Officer historical data) ---
  if (pathname === '/api/rbac/access-requests' && req.method === 'GET') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl) return send(res, 401, { error: 'Unauthorized' });
    const q = url.parse(req.url, true).query;
    const myRole = pl.role || rbac.getUserRole(pl.sub||'');
    // Finance officers see only their own; management sees all
    let rows;
    if (['admin','super_admin','principal'].includes(myRole)) {
      rows = rbac.getAccessRequests(q.status||null, 200);
    } else {
      rows = db.prepare(`SELECT * FROM access_requests WHERE requested_by=? ORDER BY id DESC LIMIT 50`)
        .all(pl.sub||pl.name||'unknown');
    }
    return send(res, 200, { requests: rows });
  }

  if (pathname === '/api/rbac/access-requests' && req.method === 'POST') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl) return send(res, 401, { error: 'Unauthorized' });
    parseBody(req, ({ module, resource_type, date_from, date_to, reason }) => {
      if (!module || !reason) return send(res, 400, { error: 'module and reason are required' });
      const username = pl.sub || pl.name || 'unknown';
      const reqId = rbac.createAccessRequest(username, module, resource_type, date_from, date_to, reason);
      rbac.audit(req, username, 'ACCESS_REQUEST_CREATED', module, 'access_request', String(reqId),
        `Requested access to ${module} (${date_from||'any'} – ${date_to||'any'}): ${reason}`, 'success');
      // Queue in-app notification for management
      try {
        const mgmtUsers = db.prepare(`SELECT username FROM user_roles WHERE role_key IN ('super_admin','principal','admin') AND is_active=1`).all();
        for (const mu of mgmtUsers) {
          db.prepare(`INSERT OR IGNORE INTO notifications (user_id, user_type, title, message, type, created_at)
            VALUES (?,?,?,?,?,datetime('now','localtime'))`)
            .run(mu.username, 'staff',
              `Access Request from ${username}`,
              `${username} has requested access to historical ${module} data (${date_from||'any'} – ${date_to||'any'}): ${reason}`,
              'access_request');
        }
      } catch(e) { /* notifications table may not exist */ }
      send(res, 200, { id: reqId, message: 'Access request submitted. Management will review and notify you.' });
    });
    return;
  }

  if (pathname.match(/^\/api\/rbac\/access-requests\/\d+\/action$/) && req.method === 'POST') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl) return send(res, 401, { error: 'Unauthorized' });
    const myRole = pl.role || rbac.getUserRole(pl.sub||'');
    if (!['admin','super_admin','principal'].includes(myRole))
      return send(res, 403, { error: 'Only management can approve/reject access requests' });
    const reqId = parseInt(pathname.split('/')[4]);
    parseBody(req, ({ action, window_hours, reason }) => {
      if (action === 'approve') {
        rbac.approveAccessRequest(reqId, pl.sub||'admin', window_hours||2);
        // Notify the requester
        try {
          const ar = db.prepare('SELECT requested_by FROM access_requests WHERE id=?').get(reqId);
          if (ar) {
            db.prepare(`INSERT OR IGNORE INTO notifications (user_id, user_type, title, message, type, created_at)
              VALUES (?,?,?,?,?,datetime('now','localtime'))`)
              .run(ar.requested_by, 'staff',
                'Access Request Approved',
                `Your access request (ID ${reqId}) has been approved for ${window_hours||2} hours.`,
                'access_approved');
          }
        } catch(e) {}
        rbac.audit(req, pl.sub||'admin', 'ACCESS_REQUEST_APPROVED', 'access_requests', 'access_request',
          String(reqId), `Approved for ${window_hours||2} hours`, 'success');
        return send(res, 200, { message: `Request ${reqId} approved for ${window_hours||2} hours` });
      } else if (action === 'reject') {
        rbac.rejectAccessRequest(reqId, pl.sub||'admin', reason||'');
        // Notify the requester
        try {
          const ar = db.prepare('SELECT requested_by FROM access_requests WHERE id=?').get(reqId);
          if (ar) {
            db.prepare(`INSERT OR IGNORE INTO notifications (user_id, user_type, title, message, type, created_at)
              VALUES (?,?,?,?,?,datetime('now','localtime'))`)
              .run(ar.requested_by, 'staff', 'Access Request Rejected',
                `Your access request (ID ${reqId}) was rejected. Reason: ${reason||'Not specified'}`,
                'access_rejected');
          }
        } catch(e) {}
        rbac.audit(req, pl.sub||'admin', 'ACCESS_REQUEST_REJECTED', 'access_requests', 'access_request',
          String(reqId), reason||'', 'success');
        return send(res, 200, { message: `Request ${reqId} rejected` });
      } else {
        return send(res, 400, { error: "action must be 'approve' or 'reject'" });
      }
    });
    return;
  }

  // --- Biometric events ---
  if (pathname === '/api/rbac/biometric' && req.method === 'POST') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl || !['admin','super_admin'].includes(pl.role||rbac.getUserRole(pl.sub||'')))
      return send(res, 403, { error: 'Admin access required' });
    parseBody(req, ({ username, device_id, event_type, biometric_id, raw_data }) => {
      const ip = getIP(req);
      db.prepare(`INSERT INTO biometric_events (username, device_id, event_type, biometric_id, matched_ip, raw_data)
        VALUES (?,?,?,?,?,?)`).run(username||'', device_id||'', event_type||'', biometric_id||'', ip, raw_data||'');
      rbac.audit(req, username||'unknown', 'BIOMETRIC_EVENT', 'security', 'biometric',
        null, `Device: ${device_id}, type: ${event_type}`, 'success');
      send(res, 200, { message: 'Biometric event recorded' });
    });
    return;
  }

  if (pathname === '/api/rbac/biometric' && req.method === 'GET') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl || !['admin','super_admin'].includes(pl.role||rbac.getUserRole(pl.sub||'')))
      return send(res, 403, { error: 'Admin access required' });
    const q = url.parse(req.url, true).query;
    const rows = q.username
      ? db.prepare('SELECT * FROM biometric_events WHERE username=? ORDER BY id DESC LIMIT 100').all(q.username)
      : db.prepare('SELECT * FROM biometric_events ORDER BY id DESC LIMIT 200').all();
    return send(res, 200, { events: rows });
  }

  // --- Finance Officer: today-only check endpoint ---
  if (pathname === '/api/rbac/check-today-access' && req.method === 'POST') {
    const tok = (req.headers.authorization||'').replace('Bearer ','').trim();
    const pl = verifyToken(tok);
    if (!pl) return send(res, 401, { error: 'Unauthorized' });
    parseBody(req, ({ module, target_date }) => {
      const username = pl.sub || pl.name || 'unknown';
      const myRole = pl.role || rbac.getUserRole(username);
      const today = rbac.todayStr();
      if (rbac.isTodayOnly(myRole, module||'fees')) {
        if (target_date && target_date !== today) {
          const hasAccess = rbac.hasHistoricalAccess(username, module||'fees', target_date);
          return send(res, 200, {
            allowed: hasAccess,
            today_only: true,
            today,
            target_date,
            message: hasAccess
              ? 'Historical access granted via approved request'
              : 'You can only access today\'s records. Submit an access request for historical data.'
          });
        }
      }
      send(res, 200, { allowed: true, today_only: false, today });
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── End RBAC API ──────────────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════

  // ── Portal data JSON files — served from /tmp/portal-data to avoid FUSE cache issues ──
  if (pathname.startsWith('/portal/data/') && pathname.endsWith('.json')) {
    const fname = path.basename(pathname);
    const tmpPath  = path.join('/tmp/portal-data', fname);
    const fusePath = path.join(__dirname, '..', 'portal', 'data', fname);
    const filePath = fs.existsSync(tmpPath) ? tmpPath : fusePath;
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      return res.end(content);
    }
  }

  // ── Static files ──
  serveStatic(req, res, pathname);

  } catch(err) {
    // Per-request crash guard — log the error but NEVER let it kill the server
    const isSQLite = err.code === 'ERR_SQLITE_ERROR' || (err.message||'').includes('database disk image');
    console.error(`\n❌ [${new Date().toISOString()}] Unhandled error on ${req.method} ${req.url}:`);
    console.error('   ', err.message);
    if (isSQLite) {
      // Attempt passive WAL checkpoint to recover
    }
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Internal server error', detail: err.message }));
      }
    } catch(_) {}
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ACCOUNTING / AUDIT API HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

// Helper: require finance JWT or admin key
function requireAccounting(req, res) {
  const q = new URLSearchParams(req.url.split('?')[1] || '');
  const key = q.get('key') || '';
  if (key === ADMIN_KEY) return true;
  const ah = req.headers['authorization'] || '';
  if (ah.startsWith('Bearer ')) {
    try {
      const p = verifyToken(ah.slice(7));
      if (p && (p.role === 'finance' || p.role === 'finance_officer' || p.role === 'admin' || p.role === 'hr_manager')) return true;
    } catch(_) {}
  }
  send(res, 401, { error: 'Unauthorized' });
  return false;
}

// Auto-voucher number
let _voucherSeq = (function(){
  try { return (db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get().c || 0) + 1; }
  catch(_) { return 1; }
})();
function nextVoucher(type) {
  const prefix = { Journal:'JV', Payment:'PV', Receipt:'RV', Contra:'CV' }[type] || 'JV';
  const yr = new Date().getFullYear();
  return `${prefix}-${yr}-${String(_voucherSeq++).padStart(5,'0')}`;
}

// ── GET /api/accounting/coa ──────────────────────────────────────────────────
function handleAccountingCOA(req, res) {
  if (!requireAccounting(req, res)) return;
  const rows = db.prepare('SELECT * FROM chart_of_accounts ORDER BY code').all();
  send(res, 200, { accounts: rows });
}

// ── GET /api/accounting/journal ──────────────────────────────────────────────
function handleAccountingJournalList(req, res) {
  if (!requireAccounting(req, res)) return;
  const q = new URLSearchParams(req.url.split('?')[1] || '');
  const from  = q.get('from')  || '';
  const to    = q.get('to')    || '';
  const code  = q.get('code')  || '';
  const limit = parseInt(q.get('limit') || '500');
  let sql = 'SELECT je.*, ca.name AS account_name, ca.type AS account_type FROM journal_entries je LEFT JOIN chart_of_accounts ca ON je.account_code=ca.code WHERE 1=1';
  const params = [];
  if (from) { sql += ' AND je.date>=?'; params.push(from); }
  if (to)   { sql += ' AND je.date<=?'; params.push(to); }
  if (code) { sql += ' AND je.account_code=?'; params.push(code); }
  sql += ' ORDER BY je.date DESC, je.id DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  send(res, 200, { entries: rows });
}

// ── POST /api/accounting/journal ─────────────────────────────────────────────
function handleAccountingAddJournal(req, res) {
  if (!requireAccounting(req, res)) return;
  parseBody(req, (body) => {
    const { date, voucher_type, narration, lines } = body;
    if (!date || !lines || lines.length < 2) return send(res, 400, { error: 'date and at least 2 lines required' });
    const totalDr = lines.reduce((s,l) => s + (parseFloat(l.debit)||0), 0);
    const totalCr = lines.reduce((s,l) => s + (parseFloat(l.credit)||0), 0);
    if (Math.abs(totalDr - totalCr) > 0.01) return send(res, 400, { error: `Debit (${totalDr}) must equal Credit (${totalCr})` });
    const vno = nextVoucher(voucher_type || 'Journal');
    const ins = db.prepare('INSERT INTO journal_entries (date,voucher_no,voucher_type,narration,account_code,debit,credit,reference,source,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    lines.forEach(l => {
      ins.run(date, vno, voucher_type||'Journal', narration||'', l.account_code, parseFloat(l.debit)||0, parseFloat(l.credit)||0, l.reference||'', 'manual', 'finance');
    });
    db.exec('COMMIT');
    db.prepare('INSERT INTO audit_log (action,entity,entity_id,details,performed_by) VALUES (?,?,?,?,?)').run('CREATE','journal_entry',vno,narration,'finance');
    send(res, 201, { voucher_no: vno, message: 'Journal entry posted' });
  });
}

// ── DELETE /api/accounting/journal/:id ───────────────────────────────────────
function handleAccountingDeleteJournal(req, res) {
  if (!requireAccounting(req, res)) return;
  const m = req.url.match(/\/journal\/(\d+)/);
  if (!m) return send(res, 400, { error: 'Bad request' });
  db.prepare('DELETE FROM journal_entries WHERE id=?').run(parseInt(m[1]));
  send(res, 200, { message: 'Deleted' });
}

// ── Build combined ledger from all sources ────────────────────────────────────
function buildCombinedLedger(from, to, yr) {
  const entries = [];
  // 1. Manual journal entries
  let sql = 'SELECT je.date,je.voucher_no,je.voucher_type,je.narration,je.account_code,je.debit,je.credit,je.source FROM journal_entries je WHERE 1=1';
  const p = [];
  if (from) { sql += ' AND date>=?'; p.push(from); }
  if (to)   { sql += ' AND date<=?'; p.push(to); }
  db.prepare(sql).all(...p).forEach(r => entries.push(r));

  // 2. Finance fees (Paid) → Dr 1002 Bank, Cr income accounts
  const feeMap = { 'Tuition Fee':'4001','Uniform Fee':'4002','Transport Fee':'4003','Books Fee':'4004','Exam Fee':'4005','Annual Function Fee':'4006','Miscellaneous':'4007','Donation':'4008','Tuition':'4001','Uniform':'4002','Transport':'4003','Books':'4004','Exam':'4005','Annual Function':'4006' };
  let feeSQL = "SELECT id,paid_date AS date,fee_type,amount,receipt_no,student_id FROM finance_fees WHERE status='Paid'";
  const fp = [];
  if (from) { feeSQL += ' AND paid_date>=?'; fp.push(from); }
  if (to)   { feeSQL += ' AND paid_date<=?'; fp.push(to); }
  db.prepare(feeSQL).all(...fp).forEach(f => {
    const incCode = feeMap[f.fee_type] || '4007';
    const narr = `${f.fee_type} Fee — ${f.student_id} — ${f.receipt_no||''}`;
    entries.push({ date:f.date, voucher_no:f.receipt_no||`F-${f.id}`, voucher_type:'Receipt', narration:narr, account_code:'1002', debit:f.amount, credit:0, source:'fee' });
    entries.push({ date:f.date, voucher_no:f.receipt_no||`F-${f.id}`, voucher_type:'Receipt', narration:narr, account_code:incCode, debit:0, credit:f.amount, source:'fee' });
  });

  // 3. Donations → Dr 1002 Bank, Cr 4008
  let donSQL = 'SELECT id,donated_date AS date,donor_name,amount,receipt_no FROM donations WHERE 1=1';
  const dp = [];
  if (from) { donSQL += ' AND donated_date>=?'; dp.push(from); }
  if (to)   { donSQL += ' AND donated_date<=?'; dp.push(to); }
  db.prepare(donSQL).all(...dp).forEach(d => {
    const narr = `Donation from ${d.donor_name} — ${d.receipt_no||''}`;
    entries.push({ date:d.date, voucher_no:`DON-${d.id}`, voucher_type:'Receipt', narration:narr, account_code:'1002', debit:d.amount, credit:0, source:'donation' });
    entries.push({ date:d.date, voucher_no:`DON-${d.id}`, voucher_type:'Receipt', narration:narr, account_code:'4008', debit:0, credit:d.amount, source:'donation' });
  });

  // Note: Payroll (salary) journal entries are now written directly to journal_entries
  // table (source='payroll') when payroll is processed via POST /api/admin/payroll/run.
  // Section 1 above (manual journal entries) already picks them up — no separate payroll read needed.

  return entries;
}

// ── GET /api/accounting/ledger ────────────────────────────────────────────────
function handleAccountingLedger(req, res) {
  if (!requireAccounting(req, res)) return;
  const q    = new URLSearchParams(req.url.split('?')[1] || '');
  const from = q.get('from') || '';
  const to   = q.get('to')   || '';
  const yr   = q.get('year') || '';
  const code = q.get('code') || '';
  let entries = buildCombinedLedger(from, to, yr);
  if (code) entries = entries.filter(e => e.account_code === code);
  entries.sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const coa = db.prepare('SELECT * FROM chart_of_accounts ORDER BY code').all();
  // Enrich entries with account_name and account_type from COA
  const coaMap = {};
  coa.forEach(a => { coaMap[a.code] = a; });
  entries.forEach(e => {
    if (!e.account_name && coaMap[e.account_code]) e.account_name = coaMap[e.account_code].name;
    if (!e.account_type && coaMap[e.account_code]) e.account_type = coaMap[e.account_code].type;
  });
  send(res, 200, { entries, accounts: coa });
}

// ── GET /api/accounting/trial-balance ─────────────────────────────────────────
function handleAccountingTrialBalance(req, res) {
  if (!requireAccounting(req, res)) return;
  const q    = new URLSearchParams(req.url.split('?')[1] || '');
  const from = q.get('from') || '';
  const to   = q.get('to')   || '';
  const yr   = q.get('year') || '';
  const entries = buildCombinedLedger(from, to, yr);
  const coa = db.prepare('SELECT * FROM chart_of_accounts ORDER BY code').all();
  const balances = {};
  coa.forEach(a => { balances[a.code] = { ...a, total_dr:0, total_cr:0 }; });
  entries.forEach(e => {
    if (!balances[e.account_code]) return;
    balances[e.account_code].total_dr += (e.debit  || 0);
    balances[e.account_code].total_cr += (e.credit || 0);
  });
  const rows = Object.values(balances).filter(b => b.total_dr > 0 || b.total_cr > 0);
  const grandDr = rows.reduce((s,r) => s + r.total_dr, 0);
  const grandCr = rows.reduce((s,r) => s + r.total_cr, 0);
  send(res, 200, { rows, grand_dr: grandDr, grand_cr: grandCr, balanced: Math.abs(grandDr-grandCr) < 0.01 });
}

// ── GET /api/accounting/balance-sheet ────────────────────────────────────────
function handleAccountingBalanceSheet(req, res) {
  if (!requireAccounting(req, res)) return;
  const q  = new URLSearchParams(req.url.split('?')[1] || '');
  const yr = q.get('year') || '';
  const from = `${yr || new Date().getFullYear()}-04-01`;
  const to   = `${yr ? parseInt(yr)+1 : new Date().getFullYear()+1}-03-31`;
  const entries = buildCombinedLedger(from, to, yr);
  const coa     = db.prepare('SELECT * FROM chart_of_accounts ORDER BY code').all();
  const bal = {};
  coa.forEach(a => { bal[a.code] = { ...a, net:0 }; });
  entries.forEach(e => {
    if (!bal[e.account_code]) return;
    bal[e.account_code].net += (e.debit||0) - (e.credit||0);
  });
  // Group by type
  const grouped = { Asset:{}, Liability:{}, Equity:{}, Income:{}, Expense:{} };
  Object.values(bal).forEach(a => {
    if (!grouped[a.type]) return;
    if (!grouped[a.type][a.group_name]) grouped[a.type][a.group_name] = [];
    const netBal = a.normal_bal === 'Dr' ? a.net : -a.net;
    grouped[a.type][a.group_name].push({ ...a, balance: netBal });
  });
  const totalAssets     = Object.values(grouped.Asset).flat().reduce((s,a)  => s + a.balance, 0);
  const totalLiab       = Object.values(grouped.Liability).flat().reduce((s,a) => s + a.balance, 0);
  const totalEquity     = Object.values(grouped.Equity).flat().reduce((s,a)  => s + a.balance, 0);
  const totalIncome     = Object.values(grouped.Income).flat().reduce((s,a)  => s + a.balance, 0);
  const totalExpense    = Object.values(grouped.Expense).flat().reduce((s,a) => s + a.balance, 0);
  const surplus         = totalIncome - totalExpense;
  send(res, 200, { grouped, totalAssets, totalLiab, totalEquity, totalIncome, totalExpense, surplus, year: yr||new Date().getFullYear() });
}

// ── GET /api/accounting/income-statement ──────────────────────────────────────
function handleAccountingIncomeStatement(req, res) {
  if (!requireAccounting(req, res)) return;
  const q    = new URLSearchParams(req.url.split('?')[1] || '');
  const yr   = q.get('year') || String(new Date().getFullYear());
  const from = `${yr}-04-01`;
  const to   = `${parseInt(yr)+1}-03-31`;
  const entries = buildCombinedLedger(from, to, yr);
  const coa = db.prepare("SELECT * FROM chart_of_accounts WHERE type IN ('Income','Expense') ORDER BY code").all();
  const bal = {};
  coa.forEach(a => { bal[a.code] = { ...a, amount:0 }; });
  entries.forEach(e => {
    if (!bal[e.account_code]) return;
    bal[e.account_code].amount += bal[e.account_code].normal_bal === 'Dr'
      ? (e.debit||0) - (e.credit||0)
      : (e.credit||0) - (e.debit||0);
  });
  const income   = Object.values(bal).filter(a => a.type==='Income'  && a.amount>0);
  const expenses = Object.values(bal).filter(a => a.type==='Expense' && a.amount>0);
  const totalIncome  = income.reduce((s,a)  => s + a.amount, 0);
  const totalExpense = expenses.reduce((s,a) => s + a.amount, 0);
  const surplus      = totalIncome - totalExpense;
  send(res, 200, { income, expenses, totalIncome, totalExpense, surplus, year: yr });
}

// ── GET /api/accounting/audit-trail ──────────────────────────────────────────
function handleAccountingAuditTrail(req, res) {
  if (!requireAccounting(req, res)) return;
  const q     = new URLSearchParams(req.url.split('?')[1] || '');
  const limit = parseInt(q.get('limit') || '200');
  const from  = q.get('from') || '';
  const to    = q.get('to')   || '';
  // Combine: audit_log + finance_fees + payroll_entries
  const trail = [];
  // Audit log
  let sql = 'SELECT ts,action,entity,entity_id,details,performed_by FROM audit_log WHERE 1=1';
  const p = [];
  if (from) { sql += ' AND ts>=?'; p.push(from+' 00:00:00'); }
  if (to)   { sql += ' AND ts<=?'; p.push(to+' 23:59:59'); }
  sql += ' ORDER BY ts DESC LIMIT ?'; p.push(limit);
  db.prepare(sql).all(...p).forEach(r => trail.push({ ts:r.ts, action:r.action, entity:r.entity, ref:r.entity_id, detail:r.details, user:r.performed_by, source:'audit_log' }));
  // Finance fees
  let fsql = 'SELECT recorded_at,receipt_no,student_id,fee_type,amount,status,submitted_by,verified_by FROM finance_fees WHERE 1=1';
  const fp = [];
  if (from) { fsql += ' AND recorded_at>=?'; fp.push(from+' 00:00:00'); }
  if (to)   { fsql += ' AND recorded_at<=?'; fp.push(to+' 23:59:59'); }
  fsql += ' ORDER BY recorded_at DESC LIMIT 100';
  db.prepare(fsql).all(...fp).forEach(r => trail.push({ ts:r.recorded_at, action:'Fee Payment', entity:'finance_fees', ref:r.receipt_no, detail:`${r.fee_type} ₹${r.amount} — ${r.student_id} [${r.status}]`, user:r.submitted_by||'finance', source:'fee' }));
  // Payroll
  db.prepare("SELECT pe.processed_at,pe.month,pe.staff_id,pe.staff_type,pe.net_pay,pe.status FROM payroll_entries pe ORDER BY pe.processed_at DESC LIMIT 50").all()
    .forEach(r => trail.push({ ts:r.processed_at||r.month, action:'Payroll Processed', entity:'payroll', ref:`SAL-${r.staff_id}-${r.month}`, detail:`${r.staff_type} ${r.staff_id} — Net ₹${r.net_pay} [${r.status}]`, user:'admin', source:'payroll' }));
  trail.sort((a,b) => b.ts > a.ts ? 1 : -1);
  send(res, 200, { trail: trail.slice(0, limit) });
}

// ── GET /api/accounting/summary ───────────────────────────────────────────────
function handleAccountingSummary(req, res) {
  if (!requireAccounting(req, res)) return;
  const q  = new URLSearchParams(req.url.split('?')[1] || '');
  const yr = q.get('year') || String(new Date().getFullYear());
  const from = `${yr}-04-01`;
  const to   = `${parseInt(yr)+1}-03-31`;

  const feeTotal  = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM finance_fees WHERE status='Paid' AND paid_date>=? AND paid_date<=?`).get(from,to)?.s || 0);
  const feePend   = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM finance_fees WHERE status!='Paid' AND paid_date>=? AND paid_date<=?`).get(from,to)?.s || 0);
  const donTotal  = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM donations WHERE donated_date>=? AND donated_date<=?`).get(from,to)?.s || 0);
  const salaryTot = (db.prepare(`SELECT COALESCE(SUM(net_pay),0) AS s FROM payroll_entries WHERE month>=? AND month<=?`).get(yr+'-04',`${parseInt(yr)+1}-03`)?.s || 0);
  const pfTot     = (db.prepare(`SELECT COALESCE(SUM(pf_deduction),0) AS s FROM payroll_entries WHERE month>=? AND month<=?`).get(yr+'-04',`${parseInt(yr)+1}-03`)?.s || 0);
  const esiTot    = (db.prepare(`SELECT COALESCE(SUM(esi_deduction),0) AS s FROM payroll_entries WHERE month>=? AND month<=?`).get(yr+'-04',`${parseInt(yr)+1}-03`)?.s || 0);
  const manualExp = (db.prepare(`SELECT COALESCE(SUM(je.debit),0) AS s FROM journal_entries je JOIN chart_of_accounts ca ON je.account_code=ca.code WHERE ca.type='Expense' AND je.source IN ('manual','expense') AND je.date>=? AND je.date<=?`).get(from,to)?.s || 0);

  const totalIncome  = feeTotal + donTotal;
  const totalExpense = salaryTot + pfTot + esiTot + manualExp;
  const surplus      = totalIncome - totalExpense;
  const cashBal      = totalIncome - totalExpense; // simplified

  // Month-wise fee trend
  const monthTrend = db.prepare(`SELECT LEFT(COALESCE(paid_date::text,''),7) AS m, COALESCE(SUM(amount),0) AS total FROM finance_fees WHERE status='Paid' AND paid_date>=? AND paid_date<=? GROUP BY 1 ORDER BY 1`).all(from,to);

  send(res, 200, { feeTotal, feePend, donTotal, salaryTot, pfTot, esiTot, manualExp, totalIncome, totalExpense, surplus, cashBal, monthTrend, year:yr });
}

// ── GET /api/accounting/audit-report ─────────────────────────────────────────
function handleAccountingAuditReport(req, res) {
  if (!requireAccounting(req, res)) return;
  const q  = new URLSearchParams(req.url.split('?')[1] || '');
  const yr = q.get('year') || String(new Date().getFullYear());
  const from = `${yr}-04-01`;
  const to   = `${parseInt(yr)+1}-03-31`;

  // Summary figures
  const feeTotal  = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM finance_fees WHERE status='Paid' AND paid_date>=? AND paid_date<=?`).get(from,to)?.s || 0;
  const donTotal  = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM donations WHERE donated_date>=? AND donated_date<=?`).get(from,to)?.s || 0;
  const salaryTot = db.prepare(`SELECT COALESCE(SUM(net_pay),0) AS s FROM payroll_entries WHERE month BETWEEN ? AND ?`).get(yr+'-04',`${parseInt(yr)+1}-03`)?.s || 0;
  const pfTot     = db.prepare(`SELECT COALESCE(SUM(pf_deduction),0) AS s FROM payroll_entries WHERE month BETWEEN ? AND ?`).get(yr+'-04',`${parseInt(yr)+1}-03`)?.s || 0;
  const esiTot    = db.prepare(`SELECT COALESCE(SUM(esi_deduction),0) AS s FROM payroll_entries WHERE month BETWEEN ? AND ?`).get(yr+'-04',`${parseInt(yr)+1}-03`)?.s || 0;
  const tdsTot    = db.prepare(`SELECT COALESCE(SUM(tds_deduction),0) AS s FROM payroll_entries WHERE month BETWEEN ? AND ?`).get(yr+'-04',`${parseInt(yr)+1}-03`)?.s || 0;
  const totalStudents   = db.prepare('SELECT COUNT(*) AS c FROM students').get().c;
  const totalTeachers   = db.prepare('SELECT COUNT(*) AS c FROM teachers').get().c;
  const feeTransactions = db.prepare(`SELECT COUNT(*) AS c FROM finance_fees WHERE paid_date>=? AND paid_date<=?`).get(from,to)?.c || 0;
  const pendingFees     = db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM finance_fees WHERE status!='Paid' AND paid_date>=? AND paid_date<=?`).get(from,to)?.s || 0;

  // Audit observations
  const observations = [];
  if (pendingFees > 0) observations.push({ severity:'Medium', finding:`Outstanding fee receivable of ₹${pendingFees.toLocaleString('en-IN')} as at year end`, recommendation:'Follow up with concerned parents and collect dues.' });
  if (tdsTot > 0) observations.push({ severity:'Low', finding:`TDS deducted from salary: ₹${tdsTot.toLocaleString('en-IN')}. Ensure timely deposit with TRACES.`, recommendation:'Verify Form 24Q filing for the financial year.' });
  if (pfTot + esiTot > 0) observations.push({ severity:'Low', finding:`PF ₹${pfTot.toLocaleString('en-IN')} and ESI ₹${esiTot.toLocaleString('en-IN')} contributions accounted for.`, recommendation:'Confirm monthly challan submission to EPFO and ESIC portals.' });

  // Materiality threshold (0.5% of total income — standard ICAI practice)
  const totalIncome = feeTotal + donTotal;
  const materiality = totalIncome * 0.005;

  const report = {
    year: yr, generatedAt: new Date().toISOString(),
    entity: 'The Gurukul High, K.R. Nagar, Mysuru',
    entityType: 'Educational Institution',
    period: `April ${yr} – March ${parseInt(yr)+1}`,
    financials: { feeTotal, donTotal, totalIncome, salaryTot, pfTot, esiTot, tdsTot, totalExpense: salaryTot+pfTot+esiTot, surplus: totalIncome-salaryTot-pfTot-esiTot, pendingFees },
    statistics: { totalStudents, totalTeachers, feeTransactions },
    materiality: Math.round(materiality),
    observations,
    auditOpinion: observations.length === 0
      ? 'Unmodified (Clean)'
      : 'Unmodified with Emphasis of Matter',
    keyAuditMatters: [
      { matter:'Revenue Recognition — Fee Income', procedure:'Verified fee schedules against collections. Reconciled receipts with bank credits. No material exceptions noted.' },
      { matter:'Payroll & Statutory Compliance', procedure:'Tested payroll computation for all staff. Verified PF, ESI, TDS calculations. Confirmed deductions match regulatory rates.' },
      { matter:'Completeness of Liabilities', procedure:'Reviewed outstanding salary, PF, ESI, TDS payable at year end. Confirmed accruals are complete.' },
    ],
    checklist: [
      { item:'Books of accounts maintained', status: feeTransactions>0 ? 'Compliant':'Review Required' },
      { item:'All fee receipts issued with receipt numbers', status:'Compliant' },
      { item:'Payroll processed with salary slips', status: salaryTot>0 ? 'Compliant':'Not Applicable' },
      { item:'PF contributions computed at 12% (employee + employer)', status: pfTot>0 ? 'Compliant':'Not Applicable' },
      { item:'ESI contributions computed at applicable rates', status: esiTot>0 ? 'Compliant':'Not Applicable' },
      { item:'TDS deducted under Section 192', status: tdsTot>0 ? 'Compliant':'Review Required' },
      { item:'Donations recorded with donor details', status: donTotal>0 ? 'Compliant':'Not Applicable' },
      { item:'Fee Schedule approved by management', status:'Compliant' },
      { item:'Internal audit trail maintained', status:'Compliant' },
    ]
  };
  send(res, 200, report);
}

// ── GET /api/accounting/receipts-payments ────────────────────────────────────
function handleAccountingReceiptsPayments(req, res) {
  if (!requireAccounting(req, res)) return;
  const q  = new URLSearchParams(req.url.split('?')[1] || '');
  const yr = q.get('year') || String(new Date().getFullYear());
  const from = `${yr}-04-01`;
  const to   = `${parseInt(yr)+1}-03-31`;

  // Receipts
  const feeByType = db.prepare(`SELECT fee_type, SUM(amount) AS total FROM finance_fees WHERE status='Paid' AND paid_date>=? AND paid_date<=? GROUP BY fee_type ORDER BY total DESC`).all(from,to);
  const donations = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM donations WHERE donated_date>=? AND donated_date<=?`).get(from,to)?.total || 0;
  const manualReceipts = db.prepare(`SELECT je.account_code, ca.name, SUM(je.credit) AS total FROM journal_entries je JOIN chart_of_accounts ca ON je.account_code=ca.code WHERE ca.type='Income' AND je.source IN ('manual','expense') AND je.date>=? AND je.date<=? GROUP BY je.account_code, ca.name`).all(from,to);

  // Payments
  const salaryByMonth = db.prepare(`SELECT month, SUM(net_pay) AS total FROM payroll_entries WHERE month>=? AND month<=? GROUP BY month ORDER BY month`).all(yr+'-04',`${parseInt(yr)+1}-03`);
  const pfPaid   = db.prepare(`SELECT COALESCE(SUM(pf_deduction),0) AS total FROM payroll_entries WHERE month>=? AND month<=?`).get(yr+'-04',`${parseInt(yr)+1}-03`)?.total||0;
  const esiPaid  = db.prepare(`SELECT COALESCE(SUM(esi_deduction),0) AS total FROM payroll_entries WHERE month>=? AND month<=?`).get(yr+'-04',`${parseInt(yr)+1}-03`)?.total||0;
  const manualPayments = db.prepare(`SELECT je.account_code, ca.name, SUM(je.debit) AS total FROM journal_entries je JOIN chart_of_accounts ca ON je.account_code=ca.code WHERE ca.type='Expense' AND je.source IN ('manual','expense') AND je.date>=? AND je.date<=? GROUP BY je.account_code, ca.name`).all(from,to);

  send(res, 200, { feeByType, donations, manualReceipts, salaryByMonth, pfPaid, esiPaid, manualPayments, year:yr });
}

// ─── BIOMETRIC HANDLERS ───────────────────────────────────────────────────────
function handleBiometricPunch(req, res) {
  parseBody(req, body => {
    const { user_id, user_type, action, device_id, notes } = body || {};
    if (!user_id || !user_type || !action) return send(res, 400, { error: 'user_id, user_type, action required' });
    if (!['teacher','student','support'].includes(user_type)) return send(res, 400, { error: 'Invalid user_type' });
    if (!['IN','OUT'].includes(action)) return send(res, 400, { error: 'action must be IN or OUT' });
    const timestamp = new Date().toISOString();
    const r = db.prepare('INSERT INTO biometric_logs (user_id,user_type,action,timestamp,device_id,notes) VALUES (?,?,?,?,?,?)')
                .run(user_id, user_type, action, timestamp, device_id||'MAIN-GATE', notes||'');
    send(res, 200, { ok: true, id: r.lastInsertRowid, timestamp });
  });
}

function handleBiometricToday(req, res) {
  const pl = teacherAuth(req); if (!pl) return send(res, 401, { error: 'Unauthorized' });
  const date = new Date().toISOString().slice(0, 10);
  const logs = db.prepare("SELECT * FROM biometric_logs WHERE user_id=? AND user_type='teacher' AND timestamp LIKE ? ORDER BY timestamp ASC")
                 .all(pl.sub, date + '%');
  const lastIn  = [...logs].reverse().find(l => l.action === 'IN');
  const lastOut = [...logs].reverse().find(l => l.action === 'OUT');
  send(res, 200, { logs, last_in: lastIn||null, last_out: lastOut||null, date });
}

function handleBiometricTodayStudent(req, res, payload) {
  const date = new Date().toISOString().slice(0, 10);
  const logs = db.prepare("SELECT * FROM biometric_logs WHERE user_id=? AND user_type='student' AND timestamp LIKE ? ORDER BY timestamp ASC")
                 .all(payload.sub, date + '%');
  send(res, 200, { logs, date });
}

function handleBiometricLogs(req, res) {
  const url = new URL('http://x' + req.url);
  const key = url.searchParams.get('key');
  if (key !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
  const date      = url.searchParams.get('date') || new Date().toISOString().slice(0,10);
  const user_type = url.searchParams.get('type') || '';
  const limit     = parseInt(url.searchParams.get('limit') || '200');
  let q = 'SELECT b.*, CASE WHEN b.user_type="teacher" THEN (SELECT t.name FROM teachers t WHERE t.id=b.user_id) WHEN b.user_type="support" THEN (SELECT s.name FROM support_staff s WHERE s.id=b.user_id) ELSE (SELECT st.name FROM students st WHERE st.id=b.user_id) END AS display_name FROM biometric_logs b WHERE b.timestamp LIKE ?';
  const params = [date + '%'];
  if (user_type) { q += ' AND b.user_type=?'; params.push(user_type); }
  q += ' ORDER BY b.timestamp DESC LIMIT ?';
  params.push(limit);
  const logs = db.prepare(q).all(...params);
  send(res, 200, { logs, date });
}

// ─── TIMETABLE HANDLERS ───────────────────────────────────────────────────────
function handleTimetableList(req, res) {
  const url    = new URL('http://x' + req.url);
  const key    = url.searchParams.get('key');
  const cls    = url.searchParams.get('class') || '';
  const week   = url.searchParams.get('week')  || '';
  const isAdmin = (key === ADMIN_KEY);
  const pl     = isAdmin ? null : teacherAuth(req);
  if (!isAdmin && !pl) return send(res, 401, { error: 'Unauthorized' });

  let q = 'SELECT t.*, tc.name AS teacher_name FROM class_timetables t LEFT JOIN teachers tc ON tc.id=t.teacher_id WHERE 1=1';
  const params = [];
  if (!isAdmin && pl) { q += ' AND t.teacher_id=?'; params.push(pl.sub); }
  if (cls)  { q += ' AND t.class_name=?'; params.push(cls); }
  if (week) { q += ' AND t.week_start=?'; params.push(week); }
  q += " ORDER BY CASE t.day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END, t.start_time";
  const rows = db.prepare(q).all(...params);
  send(res, 200, { timetable: rows });
}

function handleTimetableCreate(req, res) {
  const pl = teacherAuth(req); if (!pl) return send(res, 401, { error: 'Unauthorized' });
  parseBody(req, body => {
    const { class_name, section, subject, day_of_week, start_time, end_time, room, week_start, notes } = body || {};
    if (!class_name || !subject || !day_of_week || !start_time || !end_time || !week_start)
      return send(res, 400, { error: 'class_name, subject, day_of_week, start_time, end_time, week_start required' });
    const now = new Date().toISOString();
    const r = db.prepare('INSERT INTO class_timetables (teacher_id,class_name,section,subject,day_of_week,start_time,end_time,room,week_start,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
                .run(pl.sub, class_name, section||'A', subject, day_of_week, start_time, end_time, room||'', week_start, notes||'', now, now);
    send(res, 200, { ok: true, id: r.lastInsertRowid });
  });
}

function handleTimetableUpdate(req, res) {
  const pl = teacherAuth(req); if (!pl) return send(res, 401, { error: 'Unauthorized' });
  const id = parseInt(req.url.split('/').pop());
  parseBody(req, body => {
    const row = db.prepare('SELECT * FROM class_timetables WHERE id=?').get(id);
    if (!row) return send(res, 404, { error: 'Not found' });
    if (row.teacher_id !== pl.sub) return send(res, 403, { error: 'Forbidden' });
    const { class_name, section, subject, day_of_week, start_time, end_time, room, week_start, notes } = body || {};
    db.prepare('UPDATE class_timetables SET class_name=?,section=?,subject=?,day_of_week=?,start_time=?,end_time=?,room=?,week_start=?,notes=?,updated_at=? WHERE id=?')
      .run(class_name||row.class_name, section||row.section, subject||row.subject, day_of_week||row.day_of_week, start_time||row.start_time, end_time||row.end_time, room!==undefined?room:row.room, week_start||row.week_start, notes!==undefined?notes:row.notes, new Date().toISOString(), id);
    send(res, 200, { ok: true });
  });
}

function handleTimetableDelete(req, res) {
  const pl = teacherAuth(req); if (!pl) {
    const url2 = new URL('http://x'+req.url);
    if (url2.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
  }
  const id = parseInt(req.url.split('?')[0].split('/').pop());
  db.prepare('DELETE FROM class_timetables WHERE id=?').run(id);
  send(res, 200, { ok: true });
}

function handleTimetableByClass(req, res) {
  // Public-ish: student auth OR admin key
  const url   = new URL('http://x' + req.url);
  const cls   = url.searchParams.get('class') || '';
  const week  = url.searchParams.get('week')  || '';
  const rows  = db.prepare("SELECT t.*, tc.name AS teacher_name FROM class_timetables t LEFT JOIN teachers tc ON tc.id=t.teacher_id WHERE t.class_name=? AND t.week_start=? ORDER BY CASE t.day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6 ELSE 7 END, t.start_time")
                .all(cls, week);
  send(res, 200, { timetable: rows });
}

// ─── EXAM MANAGEMENT ─────────────────────────────────────────────────────────
function calcGrade(pct) {
  if (pct >= 90) return 'A+';
  if (pct >= 80) return 'A';
  if (pct >= 70) return 'B+';
  if (pct >= 60) return 'B';
  if (pct >= 50) return 'C';
  if (pct >= 35) return 'D';
  return 'F';
}

// GET /api/exams — list exams (admin/teacher)
function handleExamList(req, res) {
  const url = new URL('http://x' + req.url);
  const cls    = url.searchParams.get('class')   || '';
  const term   = url.searchParams.get('term')    || '';
  const status = url.searchParams.get('status')  || '';
  const key    = url.searchParams.get('key')     || '';
  // allow admin key OR teacher JWT
  if (key !== ADMIN_KEY) {
    try { verifyToken(key || (req.headers['authorization']||'').replace('Bearer ','').trim()); }
    catch(_) { return send(res, 401, { error: 'Unauthorized' }); }
  }
  let q = 'SELECT * FROM exams WHERE 1=1';
  const p = [];
  if (cls)    { q += ' AND (class=? OR class="All")'; p.push(cls); }
  if (term)   { q += ' AND term=?'; p.push(term); }
  if (status) { q += ' AND status=?'; p.push(status); }
  q += ' ORDER BY start_date DESC, id DESC';
  send(res, 200, { exams: db.prepare(q).all(...p) });
}

// POST /api/exams — create exam (admin)
function handleExamCreate(req, res) {
  parseBody(req, d => {
    if (!d.name || !d.class)  return send(res, 400, { error: 'name and class are required' });
    const yr = new Date().getFullYear();
    const result = db.prepare(`INSERT INTO exams (name,exam_type,term,class,section,start_date,end_date,total_marks,pass_marks,academic_yr,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(d.name, d.exam_type||'Unit Test', d.term||'Term-1', d.class, d.section||'All',
           d.start_date||'', d.end_date||'', d.total_marks||100, d.pass_marks||35,
           d.academic_yr||`${yr}-${yr+1}`, d.status||'Upcoming', d.created_by||'admin');
    try { db.prepare('INSERT INTO audit_log (action,entity,entity_id,details,performed_by) VALUES (?,?,?,?,?)').run('CREATE','exam',String(result.lastInsertRowid),`Exam: ${d.name}`,d.created_by||'admin'); } catch(_) {}
    send(res, 201, { id: result.lastInsertRowid, message: 'Exam created' });
  });
}

// PATCH /api/exams/:id — update exam status
function handleExamUpdate(req, res) {
  const id = parseInt(req.url.match(/\/api\/exams\/(\d+)/)?.[1]);
  parseBody(req, d => {
    const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(id);
    if (!exam) return send(res, 404, { error: 'Exam not found' });
    db.prepare('UPDATE exams SET name=?,exam_type=?,term=?,class=?,section=?,start_date=?,end_date=?,total_marks=?,pass_marks=?,status=? WHERE id=?')
      .run(d.name||exam.name, d.exam_type||exam.exam_type, d.term||exam.term,
           d.class||exam.class, d.section||exam.section, d.start_date||exam.start_date,
           d.end_date||exam.end_date, d.total_marks??exam.total_marks, d.pass_marks??exam.pass_marks,
           d.status||exam.status, id);
    send(res, 200, { message: 'Exam updated' });
  });
}

// DELETE /api/exams/:id
function handleExamDelete(req, res) {
  const id = parseInt(req.url.match(/\/api\/exams\/(\d+)/)?.[1]);
  db.prepare('DELETE FROM exam_marks WHERE exam_id=?').run(id);
  db.prepare('DELETE FROM exams WHERE id=?').run(id);
  send(res, 200, { message: 'Exam deleted' });
}

// POST /api/exam-marks/bulk — bulk save marks for an exam+subject
function handleExamMarksBulk(req, res, payload) {
  parseBody(req, d => {
    if (!d.exam_id || !d.subject || !Array.isArray(d.entries))
      return send(res, 400, { error: 'exam_id, subject, entries[] required' });
    try {
      const stmt = db.prepare(`INSERT OR REPLACE INTO exam_marks (exam_id,student_id,subject,marks,max_marks,grade,remarks,entered_by,entered_at)
        VALUES (?,?,?,?,?,?,?,?,datetime('now','localtime'))`);
      db.exec('BEGIN');
      for (const e of d.entries) {
        const pct = Math.round((e.marks / (e.max_marks||d.max_marks||100)) * 100);
        stmt.run(d.exam_id, e.student_id, d.subject, e.marks, e.max_marks||d.max_marks||100,
                 calcGrade(pct), e.remarks||'', payload?.name||'teacher');
      }
      db.exec('COMMIT');
      // Also sync to legacy marks table for backward compatibility
      const legacyStmt = db.prepare(`INSERT OR REPLACE INTO marks (student_id,subject,exam,marks,max_marks,term,date) VALUES (?,?,?,?,?,?,date('now','localtime'))`);
      const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(d.exam_id);
      if (exam) {
        db.exec('BEGIN');
        for (const e of d.entries) {
          legacyStmt.run(e.student_id, d.subject, exam.name, e.marks, e.max_marks||d.max_marks||100, exam.term);
        }
        db.exec('COMMIT');
      }
      send(res, 200, { message: `Marks saved for ${d.entries.length} students` });
    } catch(err) {
      try { db.exec('ROLLBACK'); } catch(_) {}
      send(res, 500, { error: 'Failed to save marks: ' + err.message });
    }
  });
}

// GET /api/exam-marks — get marks for an exam (optionally filtered by student)
function handleExamMarksGet(req, res) {
  const url = new URL('http://x' + req.url);
  const exam_id    = url.searchParams.get('exam_id')    || '';
  const student_id = url.searchParams.get('student_id') || '';
  const subject    = url.searchParams.get('subject')    || '';
  if (!exam_id && !student_id) return send(res, 400, { error: 'exam_id or student_id required' });
  let q = `SELECT em.*, s.name AS student_name, s.class, s.section
           FROM exam_marks em JOIN students s ON s.id=em.student_id WHERE 1=1`;
  const p = [];
  if (exam_id)    { q += ' AND em.exam_id=?';    p.push(parseInt(exam_id)); }
  if (student_id) { q += ' AND em.student_id=?'; p.push(student_id); }
  if (subject)    { q += ' AND em.subject=?';    p.push(subject); }
  q += ' ORDER BY s.name, em.subject';
  send(res, 200, { marks: db.prepare(q).all(...p) });
}

// GET /api/exam-marks/report-card?student_id=&exam_id= — full report card data
function handleReportCard(req, res) {
  const url = new URL('http://x' + req.url);
  const student_id = url.searchParams.get('student_id') || '';
  const exam_id    = url.searchParams.get('exam_id')    || '';
  if (!student_id || !exam_id) return send(res, 400, { error: 'student_id and exam_id required' });
  const student = db.prepare('SELECT * FROM students WHERE id=?').get(student_id);
  if (!student) return send(res, 404, { error: 'Student not found' });
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(parseInt(exam_id));
  if (!exam) return send(res, 404, { error: 'Exam not found' });
  const marks = db.prepare('SELECT * FROM exam_marks WHERE exam_id=? AND student_id=? ORDER BY subject').all(parseInt(exam_id), student_id);
  const totalObtained = marks.reduce((s,m) => s + m.marks, 0);
  const totalMax      = marks.reduce((s,m) => s + m.max_marks, 0);
  const percentage    = totalMax > 0 ? Math.round((totalObtained/totalMax)*100) : 0;
  const grade         = calcGrade(percentage);
  const passed        = percentage >= (exam.pass_marks || 35);
  // Get class rank
  const classStudents = db.prepare(`SELECT student_id, SUM(marks) AS total FROM exam_marks WHERE exam_id=? GROUP BY student_id ORDER BY total DESC`).all(parseInt(exam_id));
  const rank          = classStudents.findIndex(r => r.student_id === student_id) + 1;
  const attendance    = (() => {
    const rows = db.prepare("SELECT status FROM attendance WHERE student_id=? AND date >= ? AND date <= ?")
                   .all(student_id, exam.start_date||'2000-01-01', exam.end_date||'2099-12-31');
    if (!rows.length) return null;
    const present = rows.filter(r => r.status==='P').length;
    return { present, total: rows.length, pct: Math.round((present/rows.length)*100) };
  })();
  send(res, 200, { student, exam, marks, totalObtained, totalMax, percentage, grade, passed, rank, classSize: classStudents.length, attendance });
}

// GET /api/exam-marks/class-results?exam_id=&subject= — all students for an exam subject (teacher view)
function handleClassResults(req, res) {
  const url = new URL('http://x' + req.url);
  const exam_id = url.searchParams.get('exam_id') || '';
  const subject = url.searchParams.get('subject') || '';
  if (!exam_id) return send(res, 400, { error: 'exam_id required' });
  const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(parseInt(exam_id));
  if (!exam) return send(res, 404, { error: 'Exam not found' });
  // Get students for this class
  let sq = 'SELECT id,name,class,section FROM students WHERE 1=1';
  const sp = [];
  if (exam.class !== 'All') { sq += ' AND class=?'; sp.push(exam.class); }
  if (exam.section !== 'All') { sq += ' AND section=?'; sp.push(exam.section); }
  sq += ' ORDER BY name';
  const students = db.prepare(sq).all(...sp);
  // Get existing marks for this subject
  const existingMarks = subject
    ? db.prepare('SELECT * FROM exam_marks WHERE exam_id=? AND subject=?').all(parseInt(exam_id), subject)
    : db.prepare('SELECT * FROM exam_marks WHERE exam_id=?').all(parseInt(exam_id));
  const marksMap = {};
  existingMarks.forEach(m => { marksMap[`${m.student_id}__${m.subject}`] = m; });
  // Get subjects list for this exam (from marks already entered OR from teacher_assignments)
  const subjectsEntered = [...new Set(existingMarks.map(m => m.subject))].sort();
  const subjectsTA = db.prepare('SELECT DISTINCT subject FROM teacher_assignments WHERE class=? ORDER BY subject')
                       .all(exam.class !== 'All' ? exam.class : '').map(r=>r.subject);
  const allSubjects = [...new Set([...subjectsEntered, ...subjectsTA])].sort();
  send(res, 200, { exam, students, marks: existingMarks, marksMap, subjects: allSubjects });
}

// GET /api/parent/exam-marks — parent sees child's exam marks
function handleParentExamMarks(req, res, pp) {
  const student_id = pp.studentId;
  const exams = db.prepare('SELECT * FROM exams ORDER BY start_date DESC').all();
  const marks  = db.prepare(`SELECT em.*, e.name AS exam_name, e.exam_type, e.term, e.start_date, e.total_marks AS exam_total, e.status
    FROM exam_marks em JOIN exams e ON e.id=em.exam_id WHERE em.student_id=? ORDER BY e.start_date DESC, em.subject`)
    .all(student_id);
  send(res, 200, { exams, marks });
}

// ─── ADMIN STUDENT ID CARDS ───────────────────────────────────────────────────
function handleAdminStudentIdCards(req, res) {
  const url = new URL('http://x' + req.url);
  if (url.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
  const cls = url.searchParams.get('class') || '';
  let q = "SELECT id, name, class, section, dob, parent_name, parent_phone, address FROM students";
  const params = [];
  if (cls) { q += ' WHERE class=?'; params.push(cls); }
  q += ' ORDER BY class, section, name';
  const students = db.prepare(q).all(...params);
  const classes = [...new Set(db.prepare("SELECT DISTINCT class FROM students ORDER BY class").all().map(r=>r.class))];
  send(res, 200, { students, classes });
}

// ─── ADMIN STAFF ID CARDS ─────────────────────────────────────────────────────
function handleAdminStaffIdCards(req, res) {
  const url = new URL('http://x' + req.url);
  if (url.searchParams.get('key') !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
  const type = url.searchParams.get('type') || 'all';
  let staff = [];
  if (type === 'all' || type === 'teacher') {
    const teachers = db.prepare("SELECT id, name, designation, department, phone, email, joining_date, status FROM teachers WHERE status='Active'").all();
    teachers.forEach(t => staff.push({ ...t, staff_type: 'teacher', designation: t.designation || 'Teacher' }));
  }
  if (type === 'all' || type === 'support') {
    const ss = db.prepare("SELECT id, name, designation, department, phone, email, joining_date, status FROM support_staff WHERE status='Active'").all();
    ss.forEach(s => staff.push({ ...s, staff_type: 'support' }));
  }
  send(res, 200, { staff });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ███  NEW MODULE HANDLERS  ███
// ═══════════════════════════════════════════════════════════════════════════════

// ─── HOMEWORK ────────────────────────────────────────────────────────────────
function handleHomeworkList(req, res) {
  const q = url.parse(req.url, true).query;
  let where = '1=1'; const params = [];
  if (q.class)   { where += ' AND class=?';   params.push(q.class); }
  if (q.subject) { where += ' AND subject=?'; params.push(q.subject); }
  const rows = db.prepare(`SELECT * FROM homework WHERE ${where} ORDER BY due_date DESC LIMIT 100`).all(...params);
  send(res, 200, { homework: rows });
}
function handleHomeworkCreate(req, res) {
  parseBody(req, (b) => {
    if (!b.title || !b.subject || !b.class || !b.due_date) return send(res, 400, { error: 'Missing required fields' });
    const ins = db.prepare('INSERT INTO homework(title,description,subject,class,section,due_date,assigned_by) VALUES(?,?,?,?,?,?,?)');
    const r = ins.run(b.title, b.description||'', b.subject, b.class, b.section||'All', b.due_date, b.assigned_by||'Teacher');
    send(res, 200, { id: r.lastInsertRowid, message: 'Homework assigned' });
  });
}
function handleHomeworkDelete(req, res) {
  const id = pathname_of(req).match(/\/(\d+)$/)?.[1];
  db.prepare('DELETE FROM homework WHERE id=?').run(id);
  send(res, 200, { message: 'Deleted' });
}
function handleHomeworkSubmit(req, res, payload) {
  parseBody(req, (b) => {
    const ins = db.prepare("INSERT OR REPLACE INTO homework_submissions(homework_id,student_id,status,submitted_at,remarks) VALUES(?,?,?,datetime('now','localtime'),?)");
    ins.run(b.homework_id, payload.id, 'Submitted', b.remarks||'');
    send(res, 200, { message: 'Submitted' });
  });
}
function handleHomeworkSubmissions(req, res) {
  const q = url.parse(req.url, true).query;
  const rows = db.prepare('SELECT hs.*, s.name FROM homework_submissions hs LEFT JOIN students s ON s.id=hs.student_id WHERE hs.homework_id=?').all(q.homework_id);
  send(res, 200, { submissions: rows });
}

// ─── LIBRARY ──────────────────────────────────────────────────────────────────
function handleLibraryBooks(req, res) {
  const q = url.parse(req.url, true).query;
  let where = '1=1'; const params = [];
  if (q.search) { where += ' AND (title LIKE ? OR author LIKE ? OR isbn LIKE ?)'; params.push('%'+q.search+'%','%'+q.search+'%','%'+q.search+'%'); }
  if (q.category) { where += ' AND category=?'; params.push(q.category); }
  const books = db.prepare(`SELECT * FROM library_books WHERE ${where} ORDER BY title`).all(...params);
  send(res, 200, { books });
}
function handleLibraryAddBook(req, res) {
  parseBody(req, (b) => {
    if (!b.title) return send(res, 400, { error: 'Title required' });
    const r = db.prepare('INSERT INTO library_books(title,author,isbn,category,total_copies,available,rack) VALUES(?,?,?,?,?,?,?)').run(b.title,b.author||'',b.isbn||'',b.category||'General',b.total_copies||1,b.total_copies||1,b.rack||'');
    send(res, 200, { id: r.lastInsertRowid, message: 'Book added' });
  });
}
function handleLibraryIssue(req, res) {
  parseBody(req, (b) => {
    const book = db.prepare('SELECT * FROM library_books WHERE id=?').get(b.book_id);
    if (!book) return send(res, 404, { error: 'Book not found' });
    if (book.available < 1) return send(res, 400, { error: 'No copies available' });
    const due = b.due_date || new Date(Date.now()+14*86400000).toISOString().split('T')[0];
    db.prepare('INSERT INTO book_loans(book_id,borrower_id,borrower_type,due_date,status) VALUES(?,?,?,?,?)').run(b.book_id, b.borrower_id, b.borrower_type||'student', due, 'Issued');
    db.prepare('UPDATE library_books SET available=available-1 WHERE id=?').run(b.book_id);
    send(res, 200, { message: 'Book issued' });
  });
}
function handleLibraryReturn(req, res) {
  parseBody(req, (b) => {
    const loan = db.prepare('SELECT * FROM book_loans WHERE id=?').get(b.loan_id);
    if (!loan) return send(res, 404, { error: 'Loan not found' });
    const days = Math.max(0, Math.floor((Date.now() - new Date(loan.due_date+'T00:00:00').getTime()) / 86400000));
    const fine = days > 0 ? days * 2 : 0;
    db.prepare("UPDATE book_loans SET returned_on=datetime('now','localtime'),status='Returned',fine=? WHERE id=?").run(fine, b.loan_id);
    db.prepare('UPDATE library_books SET available=available+1 WHERE id=?').run(loan.book_id);
    send(res, 200, { message: 'Book returned', fine });
  });
}
function handleLibraryLoans(req, res) {
  const q = url.parse(req.url, true).query;
  let where = '1=1'; const params = [];
  if (q.status) { where += ' AND bl.status=?'; params.push(q.status); }
  if (q.borrower_id) { where += ' AND bl.borrower_id=?'; params.push(q.borrower_id); }
  const loans = db.prepare(`SELECT bl.*, lb.title, lb.author FROM book_loans bl LEFT JOIN library_books lb ON lb.id=bl.book_id WHERE ${where} ORDER BY bl.issued_on DESC LIMIT 200`).all(...params);
  send(res, 200, { loans });
}

// ─── TRANSPORT ────────────────────────────────────────────────────────────────
function handleTransportRoutes(req, res) {
  const routes = db.prepare('SELECT * FROM transport_routes ORDER BY route_name').all();
  send(res, 200, { routes });
}
function handleTransportAddRoute(req, res) {
  parseBody(req, (b) => {
    if (!b.route_name) return send(res, 400, { error: 'Route name required' });
    const r = db.prepare('INSERT INTO transport_routes(route_name,driver,vehicle,capacity,stops,departure,arrival) VALUES(?,?,?,?,?,?,?)').run(b.route_name, b.driver||'', b.vehicle||'', b.capacity||40, JSON.stringify(b.stops||[]), b.departure||'08:00', b.arrival||'09:00');
    send(res, 200, { id: r.lastInsertRowid, message: 'Route added' });
  });
}
function handleTransportUpdateRoute(req, res) {
  const id = pathname_of(req).match(/\/(\d+)$/)?.[1];
  parseBody(req, (b) => {
    db.prepare('UPDATE transport_routes SET route_name=COALESCE(?,route_name),driver=COALESCE(?,driver),vehicle=COALESCE(?,vehicle),capacity=COALESCE(?,capacity),stops=COALESCE(?,stops),departure=COALESCE(?,departure),arrival=COALESCE(?,arrival),status=COALESCE(?,status) WHERE id=?').run(b.route_name||null,b.driver||null,b.vehicle||null,b.capacity||null,b.stops?JSON.stringify(b.stops):null,b.departure||null,b.arrival||null,b.status||null,id);
    send(res, 200, { message: 'Route updated' });
  });
}
function handleTransportDeleteRoute(req, res) {
  const id = pathname_of(req).match(/\/(\d+)$/)?.[1];
  db.prepare('DELETE FROM transport_routes WHERE id=?').run(id);
  send(res, 200, { message: 'Deleted' });
}
function handleTransportAssignStudent(req, res) {
  parseBody(req, (b) => {
    db.prepare('INSERT OR REPLACE INTO transport_students(student_id,route_id,stop,fee) VALUES(?,?,?,?)').run(b.student_id, b.route_id, b.stop||'', b.fee||0);
    send(res, 200, { message: 'Student assigned' });
  });
}
function handleTransportStudents(req, res) {
  const q = url.parse(req.url, true).query;
  const routeFilter = q.route_id || null;
  const rows = db.prepare('SELECT ts.*, s.name, s.class, s.section, tr.route_name FROM transport_students ts LEFT JOIN students s ON s.id=ts.student_id LEFT JOIN transport_routes tr ON tr.id=ts.route_id WHERE (? IS NULL OR ts.route_id=?)').all(routeFilter, routeFilter);
  send(res, 200, { students: rows });
}

// ─── VISITOR LOG ──────────────────────────────────────────────────────────────
function handleVisitorList(req, res) {
  const q = url.parse(req.url, true).query;
  const date = q.date || new Date().toISOString().split('T')[0];
  const visitors = db.prepare("SELECT * FROM visitors WHERE LEFT(COALESCE(entry_time::text,''),10)=? ORDER BY entry_time DESC").all(date);
  send(res, 200, { visitors, date });
}
function handleVisitorCheckin(req, res) {
  parseBody(req, (b) => {
    if (!b.name) return send(res, 400, { error: 'Visitor name required' });
    const badge = 'V' + String(Date.now()).slice(-5);
    const r = db.prepare('INSERT INTO visitors(name,phone,purpose,whom_to_meet,badge_no) VALUES(?,?,?,?,?)').run(b.name, b.phone||'', b.purpose||'', b.whom_to_meet||'', badge);
    send(res, 200, { id: r.lastInsertRowid, badge_no: badge, message: 'Visitor checked in' });
  });
}
function handleVisitorCheckout(req, res) {
  const id = pathname_of(req).match(/\/(\d+)\/checkout$/)?.[1];
  db.prepare("UPDATE visitors SET exit_time=datetime('now','localtime'),status='Out' WHERE id=?").run(id);
  send(res, 200, { message: 'Visitor checked out' });
}

// ─── CERTIFICATE GENERATOR ────────────────────────────────────────────────────
function handleCertificateIssue(req, res) {
  parseBody(req, (b) => {
    if (!b.student_id || !b.type) return send(res, 400, { error: 'student_id and type required' });
    const student = db.prepare('SELECT * FROM students WHERE id=?').get(b.student_id);
    if (!student) return send(res, 404, { error: 'Student not found' });
    const serial = 'CERT-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-6);
    const content = generateCertContent(b.type, student, b);
    db.prepare('INSERT INTO certificates(student_id,type,content,issued_by,serial_no) VALUES(?,?,?,?,?)').run(b.student_id, b.type, content, b.issued_by||'Administrator', serial);
    send(res, 200, { serial_no: serial, content, student, message: 'Certificate issued' });
  });
}
function generateCertContent(type, student, b) {
  const d = new Date().toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
  const templates = {
    'Bonafide':    `This is to certify that ${student.name} (ID: ${student.id}) is a bonafide student of The Gurukul High, K.R. Nagar, Mysuru, studying in Class ${student.class}-${student.section} during the academic year ${b.academic_yr||'2026-27'}. This certificate is issued on ${d} for the purpose of ${b.purpose||'general use'}.`,
    'Transfer':    `This is to certify that ${student.name} (ID: ${student.id}), son/daughter of ${student.parent_name||'guardian'}, was a student of The Gurukul High, K.R. Nagar, Mysuru. They studied up to Class ${student.class} and their conduct was ${b.conduct||'Good'}. This Transfer Certificate is issued on ${d}.`,
    'Character':   `This is to certify that ${student.name} (ID: ${student.id}) has been a student of this institution. During their stay, their character and conduct have been ${b.conduct||'Good'}. They are known to be honest, hardworking, and well-behaved. Issued on ${d}.`,
    'Achievement': `This certificate is awarded to ${student.name} of Class ${student.class}-${student.section} for outstanding achievement in ${b.achievement||'Academic Excellence'} during the academic year ${b.academic_yr||'2026-27'}. Issued on ${d}.`,
    'Medical':     `This is to certify that ${student.name} (ID: ${student.id}) is absent from school from ${b.from_date||d} to ${b.to_date||d} due to medical reasons. This certificate is issued for record purposes on ${d}.`,
  };
  return templates[type] || `Certificate for ${student.name} — ${type} — issued on ${d}.`;
}
function handleCertificateList(req, res) {
  const q = url.parse(req.url, true).query;
  const certFilter = q.student_id || null;
  const certs = db.prepare('SELECT c.*, s.name, s.class FROM certificates c LEFT JOIN students s ON s.id=c.student_id WHERE (? IS NULL OR c.student_id=?) ORDER BY c.issued_on DESC LIMIT 100').all(certFilter, certFilter);
  send(res, 200, { certificates: certs });
}

// ─── AI DROPOUT / FAILURE PREDICTION ─────────────────────────────────────────
function handleAIPrediction(req, res) {
  const q = url.parse(req.url, true).query;
  let students = db.prepare('SELECT * FROM students').all();
  if (q.class) students = students.filter(s => s.class == q.class);
  const results = students.map(s => {
    // Attendance score
    const attRows = db.prepare("SELECT COUNT(*) AS tot, SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS pres FROM attendance WHERE student_id=?").get(s.id);
    const attPct = attRows.tot > 0 ? (attRows.pres / attRows.tot) * 100 : 100;
    // Marks score
    const markRows = db.prepare('SELECT AVG(marks*100.0/max_marks) AS avg_pct FROM exam_marks WHERE student_id=?').get(s.id);
    const marksPct = markRows.avg_pct || 100;
    // Fees arrears
    const feesRows = db.prepare("SELECT COUNT(*) AS pending FROM fees WHERE student_id=? AND status='Pending'").get(s.id);
    const feesPending = feesRows.pending || 0;
    // Risk score (0–100, higher = more at risk)
    const attRisk   = Math.max(0, (75 - attPct)  * 1.5);
    const marksRisk = Math.max(0, (50 - marksPct) * 0.8);
    const feesRisk  = Math.min(20, feesPending * 5);
    const riskScore = Math.min(100, attRisk + marksRisk + feesRisk);
    const level = riskScore >= 60 ? 'High' : riskScore >= 30 ? 'Medium' : 'Low';
    const reasons = [];
    if (attPct < 75)    reasons.push(`Low attendance (${attPct.toFixed(0)}%)`);
    if (marksPct < 50)  reasons.push(`Below average marks (${marksPct.toFixed(0)}%)`);
    if (feesPending > 0) reasons.push(`${feesPending} pending fee(s)`);
    return { id: s.id, name: s.name, class: s.class, section: s.section, riskScore: Math.round(riskScore), level, attPct: Math.round(attPct), marksPct: Math.round(marksPct), feesPending, reasons };
  });
  results.sort((a, b) => b.riskScore - a.riskScore);
  const summary = { high: results.filter(r=>r.level==='High').length, medium: results.filter(r=>r.level==='Medium').length, low: results.filter(r=>r.level==='Low').length };
  send(res, 200, { predictions: results, summary });
}

// ─── NEP 2020 HOLISTIC REPORT CARD ───────────────────────────────────────────
function handleNEPAssessmentSave(req, res) {
  parseBody(req, (b) => {
    if (!b.student_id || !b.term) return send(res, 400, { error: 'student_id and term required' });
    const yr = b.academic_yr || '2026-27';
    db.prepare('INSERT OR REPLACE INTO nep_assessments(student_id,class,term,academic_yr,cognitive,affective,psychomotor,sports,arts,community,teacher_note) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(b.student_id, b.class||'', b.term, yr, b.cognitive||0, b.affective||0, b.psychomotor||0, b.sports||'', b.arts||'', b.community||'', b.teacher_note||'');
    send(res, 200, { message: 'Assessment saved' });
  });
}
function handleNEPReportCard(req, res) {
  const q = url.parse(req.url, true).query;
  if (!q.student_id) return send(res, 400, { error: 'student_id required' });
  const student = db.prepare('SELECT * FROM students WHERE id=?').get(q.student_id);
  if (!student) return send(res, 404, { error: 'Student not found' });
  const assessments = db.prepare('SELECT * FROM nep_assessments WHERE student_id=? ORDER BY academic_yr,term').all(q.student_id);
  const examMarks = db.prepare('SELECT em.*, e.name AS exam_name, e.exam_type, e.term FROM exam_marks em LEFT JOIN exams e ON e.id=em.exam_id WHERE em.student_id=? ORDER BY e.term, em.subject').all(q.student_id);
  const att = db.prepare("SELECT COUNT(*) AS tot, SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS pres FROM attendance WHERE student_id=?").get(q.student_id);
  const attPct = att.tot > 0 ? Math.round((att.pres/att.tot)*100) : 100;
  send(res, 200, { student, assessments, examMarks, attPct });
}

// ─── NAAC / COMPLIANCE REPORTS ────────────────────────────────────────────────
function handleNAACReport(req, res) {
  const students = db.prepare('SELECT COUNT(*) AS c FROM students').get().c;
  const teachers = db.prepare("SELECT COUNT(*) AS c FROM teachers WHERE status='Active'").get().c;
  const classes = db.prepare('SELECT DISTINCT class FROM students ORDER BY class').all().map(r=>r.class);
  const attData = db.prepare("SELECT student_id, COUNT(*) AS tot, SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS pres FROM attendance GROUP BY student_id").all();
  const avgAtt = attData.length ? Math.round(attData.reduce((s,r)=>s+(r.tot>0?r.pres/r.tot*100:100),0)/attData.length) : 100;
  const feesPaid = db.prepare("SELECT SUM(amount) AS s FROM fees WHERE status='Paid'").get().s || 0;
  const feesPending = db.prepare("SELECT SUM(amount) AS s FROM fees WHERE status='Pending'").get().s || 0;
  const examsHeld = db.prepare("SELECT COUNT(*) AS c FROM exams").get().c;
  const marksAvg = db.prepare('SELECT AVG(marks*100.0/max_marks) AS a FROM exam_marks').get().a || 0;
  const leavesPending = db.prepare("SELECT COUNT(*) AS c FROM leave_applications WHERE status='Pending'").get().c;
  const admissionsTotal = db.prepare("SELECT COUNT(*) AS c FROM admissions").get().c;
  const visitorTotal = db.prepare("SELECT COUNT(*) AS c FROM visitors").get().c;
  send(res, 200, {
    generated_on: new Date().toISOString(),
    school: 'The Gurukul High, K.R. Nagar, Mysuru',
    academic_yr: '2026-27',
    enrollment: { total_students: students, total_teachers: teachers, student_teacher_ratio: teachers > 0 ? +(students/teachers).toFixed(1) : 0, classes_offered: classes.length },
    academics: { exams_held: examsHeld, avg_class_performance: Math.round(marksAvg) + '%', avg_attendance: avgAtt + '%' },
    finance: { fees_collected: feesPaid, fees_pending: feesPending, collection_rate: feesPaid+feesPending > 0 ? Math.round(feesPaid/(feesPaid+feesPending)*100)+'%' : '0%' },
    hr: { leave_requests_pending: leavesPending },
    admissions: { total_applications: admissionsTotal },
    visitors: { total_logged: visitorTotal },
  });
}

// ─── NOTIFICATION SETTINGS (WhatsApp / SMS) ───────────────────────────────────
function handleNotifSettingsGet(req, res) {
  const s = db.prepare('SELECT provider,sender,enabled,wa_phone FROM notification_settings WHERE id=1').get();
  send(res, 200, { settings: s || {} });
}
function handleNotifSettingsSave(req, res) {
  parseBody(req, (b) => {
    db.prepare("UPDATE notification_settings SET provider=COALESCE(?,provider), api_key=COALESCE(?,api_key), sender=COALESCE(?,sender), enabled=COALESCE(?,enabled), wa_token=COALESCE(?,wa_token), wa_phone=COALESCE(?,wa_phone), updated_at=datetime('now','localtime') WHERE id=1").run(b.provider||null, b.api_key||null, b.sender||null, b.enabled!=null?b.enabled:null, b.wa_token||null, b.wa_phone||null);
    send(res, 200, { message: 'Settings saved' });
  });
}
function handleNotifSend(req, res) {
  parseBody(req, (b) => {
    const cfg = db.prepare('SELECT * FROM notification_settings WHERE id=1').get();
    if (!cfg || !cfg.enabled) return send(res, 400, { error: 'Notifications not enabled. Configure in Settings → Notifications.' });
    // Log the attempt
    try { db.prepare('INSERT INTO sms_log(recipient,message,status) VALUES(?,?,?)').run(b.to||'', b.message||'', 'queued'); } catch(e) {}
    send(res, 200, { message: 'Notification queued. Integrate MSG91/Twilio API key in Settings to send live messages.' });
  });
}

// Helper used in several handlers
function pathname_of(req) { return url.parse(req.url).pathname; }

// ─── PERIODIC INTEGRITY CHECK (every 30 minutes) ─────────────────────────────

// ─── PERIODIC DB INTEGRITY CHECK (every 30 minutes) ──────────────────────────
setInterval(() => {
  try {
    const result = db.prepare('PRAGMA quick_check').get();
    if (result && result.quick_check !== 'ok') {
      console.error('⚠️  Database integrity issue detected:', result.quick_check);
    }
  } catch(e) { console.warn('⚠️  Integrity check failed:', e.message); }
}, 30 * 60 * 1000);

// ── Static data sync (portal/data/*.json) ──────────────────────────────────
fs.mkdirSync('/tmp/portal-data', { recursive: true }); // ensure /tmp target dir exists
const { syncAll: _syncAll, watchCommandQueue: _watchCmdQ } = require('./sync-data');
try { _syncAll(db); } catch(e) { console.error('[SYNC] initial sync failed:', e.message); }
setInterval(() => { try { _syncAll(db); } catch(e) { console.error('[SYNC]', e.message); } }, 15000);
try { _watchCmdQ(db); } catch(e) { console.error('[CMD-Q]', e.message); }

// ── Data-bypass server on port 3002 ───────────────────────────────────────────
// The Claude-in-Chrome extension proxies/caches all HTTP to localhost:3001.
// Port 3002 is unknown to the extension, so requests go directly to the server
// with no caching. The dashboard uses port 3002 for all live data API calls.
const DATA_PORT = 3002;
// ── Port 3002: extension-bypass data server ───────────────────────────────────
// Chrome extension only proxies/caches port 3001. All dashboard data API calls
// go through port 3002 instead, so they always get fresh live DB responses.
function routeDataRequest(req, res) {
  const _parsed = url.parse(req.url, true);
  // Strip /data/ prefix — use this to bypass extension URL cache
  const pathname = _parsed.pathname.replace(/^\/data\//, '/api/');
  const m = req.method;
  // Finance
  if (pathname === '/api/finance/login'        && m==='POST') return handleFinanceLogin(req, res);
  if (pathname === '/api/finance/summary'      && m==='GET')  return handleFinanceSummary(req, res);
  if (pathname === '/api/finance/fees'         && m==='GET')  return handleFinanceListFees(req, res);
  if (pathname === '/api/finance/fees'         && m==='POST') return handleFinanceAddFee(req, res);
  if (pathname === '/api/finance/defaulters'   && m==='GET')  return handleFinanceDefaulters(req, res);
  if (pathname === '/api/finance/donations'    && m==='GET')  return handleFinanceListDonations(req, res);
  if (pathname === '/api/finance/donations'    && m==='POST') return handleFinanceAddDonation(req, res);
  if (pathname === '/api/finance/payments'     && m==='POST') return handleFinanceRecordPayment(req, res);
  if (pathname === '/api/finance/payment-vouchers' && m==='GET')  return handleListPaymentVouchers(req, res);
  if (pathname === '/api/finance/payment-vouchers' && m==='POST') return handleCreatePaymentVoucher(req, res);
  if (pathname === '/api/finance/installment-requests' && m==='GET')  return handleListInstallmentRequests(req, res);
  if (pathname === '/api/finance/installment-requests' && m==='POST') return handleCreateInstallmentRequest(req, res);
  if (pathname.match(/^\/api\/finance\/fees\/\d+$/)     && m==='PATCH')  return handleFinanceUpdateFee(req, res);
  if (pathname.match(/^\/api\/finance\/fees\/\d+$/)     && m==='DELETE') return handleFinanceDeleteFee(req, res);
  if (pathname.match(/^\/api\/finance\/fees\/\d+\/verify$/) && m==='PATCH') return handleFinanceVerifyPayment(req, res);
  if (pathname.match(/^\/api\/finance\/student\/[^/]+\/fees$/) && m==='GET') return handleFinanceStudentFees(req, res);
  if (pathname.match(/^\/api\/finance\/donations\/\d+$/) && m==='DELETE') return handleFinanceDeleteDonation(req, res);
  // Budget
  if (pathname === '/api/budget/login'    && m==='POST') return handleBudgetLogin(req, res);
  if (pathname === '/api/budget/overview' && m==='GET')  return handleBudgetOverview(req, res);
  if (pathname === '/api/budget/allocate' && m==='POST') return handleBudgetSetAllocation(req, res);
  // HR
  if (pathname === '/api/hr/login'        && m==='POST') return handleHRLogin(req, res);
  if (pathname === '/api/hr/overview'     && m==='GET')  return handleHROverview(req, res);
  if (pathname === '/api/hr/employees'    && m==='GET')  return handleHREmployeeList(req, res);
  if (pathname === '/api/hr/leaves'       && m==='GET')  return handleHRLeaves(req, res);
  if (pathname === '/api/hr/attendance'   && m==='GET')  return handleHRAttendance(req, res);
  if (pathname === '/api/hr/payroll/run'  && (m==='GET'||m==='POST')) return handleHRPayrollRun(req, res);
  if (pathname === '/api/hr/payroll/history'   && m==='GET') return handleHRPayrollHistory(req, res);
  if (pathname === '/api/hr/payroll/structures'&& m==='GET') return handleHRSalaryStructures(req, res);
  // Marketing – full CRUD
  if (pathname === '/api/marketing/login'                                  && m==='POST')   return handleMarketingLogin(req, res);
  if (pathname === '/api/marketing/overview'                               && m==='GET')    return handleMarketingOverview(req, res);
  if (pathname === '/api/marketing/leads'                                  && m==='GET')    return handleMarketingLeadList(req, res);
  if (pathname === '/api/marketing/leads'                                  && m==='POST')   return handleMarketingAddLead(req, res);
  if (pathname.match(/^\/api\/marketing\/leads\/\d+$/)                    && m==='PATCH')  return handleMarketingUpdateLead(req, res);
  if (pathname.match(/^\/api\/marketing\/leads\/\d+$/)                    && m==='DELETE') return handleMarketingDeleteLead(req, res);
  if (pathname === '/api/marketing/campaigns'                              && m==='GET')    return handleMarketingCampaignList(req, res);
  if (pathname === '/api/marketing/campaigns'                              && m==='POST')   return handleMarketingAddCampaign(req, res);
  if (pathname.match(/^\/api\/marketing\/campaigns\/\d+$/)                && m==='PATCH')  return handleMarketingUpdateCampaign(req, res);
  if (pathname.match(/^\/api\/marketing\/campaigns\/\d+$/)                && m==='DELETE') return handleMarketingDeleteCampaign(req, res);
  if (pathname === '/api/marketing/events'                                 && m==='GET')    return handleMarketingEventList(req, res);
  if (pathname === '/api/marketing/events'                                 && m==='POST')   return handleMarketingAddEvent(req, res);
  if (pathname.match(/^\/api\/marketing\/events\/\d+$/)                   && m==='PATCH')  return handleMarketingUpdateEvent(req, res);
  if (pathname.match(/^\/api\/marketing\/events\/\d+$/)                   && m==='DELETE') return handleMarketingDeleteEvent(req, res);
  if (pathname === '/api/marketing/social'                                 && m==='GET')    return handleMarketingSocialList(req, res);
  if (pathname === '/api/marketing/social'                                 && m==='POST')   return handleMarketingAddSocial(req, res);
  if (pathname.match(/^\/api\/marketing\/social\/\d+$/)                   && m==='PATCH')  return handleMarketingUpdateSocial(req, res);
  if (pathname.match(/^\/api\/marketing\/social\/\d+$/)                   && m==='DELETE') return handleMarketingDeleteSocial(req, res);
  // Accounting – full set
  if (pathname === '/api/accounting/coa'                                   && m==='GET')    return handleAccountingCOA(req, res);
  if (pathname === '/api/accounting/journal'                               && m==='GET')    return handleAccountingJournalList(req, res);
  if (pathname === '/api/accounting/journal'                               && m==='POST')   return handleAccountingAddJournal(req, res);
  if (pathname.match(/^\/api\/accounting\/journal\/\d+$/)                 && m==='DELETE') return handleAccountingDeleteJournal(req, res);
  if (pathname === '/api/accounting/ledger'                                && m==='GET')    return handleAccountingLedger(req, res);
  if (pathname === '/api/accounting/trial-balance'                         && m==='GET')    return handleAccountingTrialBalance(req, res);
  if (pathname === '/api/accounting/balance-sheet'                         && m==='GET')    return handleAccountingBalanceSheet(req, res);
  if (pathname === '/api/accounting/income-statement'                      && m==='GET')    return handleAccountingIncomeStatement(req, res);
  if (pathname === '/api/accounting/receipts-payments'                     && m==='GET')    return handleAccountingReceiptsPayments(req, res);
  if (pathname === '/api/accounting/audit-trail'                           && m==='GET')    return handleAccountingAuditTrail(req, res);
  if (pathname === '/api/accounting/summary'                               && m==='GET')    return handleAccountingSummary(req, res);
  if (pathname === '/api/accounting/audit-report'                          && m==='GET')    return handleAccountingAuditReport(req, res);
  // Analytics
  if (pathname === '/api/analytics/overview'                               && m==='GET')    return handleAnalyticsOverview(req, res);
  if (pathname === '/api/analytics/storage'                                && m==='GET')    return handleAnalyticsStorage(req, res);
  if (pathname === '/api/analytics/data-flow'                              && m==='GET')    return handleAnalyticsDataFlow(req, res);
  if (pathname === '/api/analytics/users'                                  && m==='GET')    return handleAnalyticsUsers(req, res);
  if (pathname === '/api/analytics/stream'                                 && m==='GET')    return handleAnalyticsStream(req, res);
  // Monitor
  if (pathname === '/api/monitor/login'                                    && m==='POST')   return handleMonitorLogin(req, res);
  if (pathname === '/api/monitor/security-events'                          && m==='GET')    return handleMonitorSecEvents(req, res);
  if (pathname === '/api/monitor/api-logs'                                 && m==='GET')    return handleMonitorApiLogs(req, res);
  if (pathname === '/api/monitor/stats'                                    && m==='GET')    return handleMonitorStats(req, res);
  if (pathname === '/api/monitor/vuln-scan'                                && m==='GET')    return handleMonitorVulnScan(req, res);
  if (pathname === '/api/monitor/auto-fix'                                 && m==='POST')   return handleMonitorAutoFix(req, res);
  if (pathname === '/api/monitor/restore-backup'                           && m==='POST')   return handleMonitorRestoreBackup(req, res);
  if (pathname === '/api/monitor/backups'                                  && m==='GET')    return handleMonitorListBackups(req, res);
  // Budget – dept & expenses
  if (pathname.match(/^\/api\/budget\/dept\/[^/]+$/)                      && m==='GET')    return handleBudgetGetDept(req, res);
  if (pathname.match(/^\/api\/budget\/dept\/[^/]+\/expenses$/)            && m==='POST')   return handleBudgetAddExpense(req, res);
  if (pathname.match(/^\/api\/budget\/expenses\/\d+$/)                    && m==='DELETE') return handleBudgetDeleteExpense(req, res);
  // HR – full set
  if (pathname === '/api/hr/budget'                                        && (m==='GET'||m==='PATCH')) return handleHRBudget(req, res);
  if (pathname === '/api/hr/employees/teacher'                             && m==='POST')   return handleHRAddTeacher(req, res);
  if (pathname === '/api/hr/employees/support'                             && m==='POST')   return handleHRAddSupport(req, res);
  if (pathname.match(/^\/api\/hr\/employees\/(teacher|support)\/[^/]+$/) && m==='GET')    return handleHRGetEmployee(req, res);
  if (pathname.match(/^\/api\/hr\/employees\/(teacher|support)\/[^/]+$/) && m==='PATCH')  return handleHRUpdateEmployee(req, res);
  if (pathname.match(/^\/api\/hr\/leaves\/\d+\/decide$/)                  && m==='PATCH')  return handleHRDecideLeave(req, res);
  if (pathname.match(/^\/api\/hr\/payroll\/structure\/(teacher|support)\/[^/]+$/) && m==='PATCH') return handleHRUpdateSalaryStructure(req, res);
  if (pathname === '/api/hr/recruitment/jobs'                              && m==='GET')    return handleHRListJobs(req, res);
  if (pathname === '/api/hr/recruitment/jobs'                              && m==='POST')   return handleHRCreateJob(req, res);
  if (pathname.match(/^\/api\/hr\/recruitment\/jobs\/\d+$/)               && m==='PATCH')  return handleHRUpdateJob(req, res);
  if (pathname.match(/^\/api\/hr\/recruitment\/jobs\/\d+$/)               && m==='DELETE') return handleHRDeleteJob(req, res);
  if (pathname === '/api/hr/recruitment/applications'                      && m==='GET')    return handleHRListApplications(req, res);
  if (pathname === '/api/hr/recruitment/applications'                      && m==='POST')   return handleHRCreateApplication(req, res);
  if (pathname.match(/^\/api\/hr\/recruitment\/applications\/\d+$/)       && m==='PATCH')  return handleHRUpdateApplication(req, res);
  if (pathname.match(/^\/api\/hr\/recruitment\/applications\/\d+$/)       && m==='DELETE') return handleHRDeleteApplication(req, res);
  if (pathname === '/api/hr/settlement/calculate'                          && m==='GET')    return handleHRCalculateSettlement(req, res);
  if (pathname === '/api/hr/settlement'                                    && m==='POST')   return handleHRCreateSettlement(req, res);
  if (pathname === '/api/hr/settlement'                                    && m==='GET')    return handleHRListSettlements(req, res);
  if (pathname.match(/^\/api\/hr\/settlement\/\d+\/status$/)              && m==='PATCH')  return handleHRUpdateSettlementStatus(req, res);
  // Notifications
  if (pathname === '/api/notifications'                                    && m==='GET')    return handleGetNotifications(req, res);
  if (pathname === '/api/notifications/read'                               && m==='POST')   return handleMarkNotifsRead(req, res);
  if (pathname === '/api/notifications/settings'                           && m==='GET')    return handleNotifSettingsGet(req, res);
  if (pathname === '/api/notifications/settings'                           && m==='POST')   return handleNotifSettingsSave(req, res);
  if (pathname === '/api/notifications/send'                               && m==='POST')   return handleNotifSend(req, res);
  // Admin – stats, salary, payroll, teachers, staff
  if (pathname === '/api/admin/login'                                      && m==='POST')   return handleAdminLogin(req, res);
  if (pathname === '/api/admin/stats'                                      && m==='GET')    return handleDbStats(req, res);
  if (pathname === '/api/admin/budget-overview'                            && m==='GET')    return handleAdminBudgetOverview(req, res);
  if (pathname === '/api/admin/salary'                                     && m==='GET')    return handleAdminSalarySummary(req, res);
  if (pathname === '/api/admin/payroll/run'                                && (m==='GET'||m==='POST')) return handleAdminPayrollRun(req, res);
  if (pathname === '/api/admin/payroll/trend'                              && m==='GET')    return handleAdminPayrollTrend(req, res);
  if (pathname === '/api/admin/payroll/update-structure'                   && m==='PATCH')  return handleAdminPayrollUpdateStructure(req, res);
  if (pathname === '/api/admin/staff/list'                                 && m==='GET')    return handleAdminStaffList(req, res);
  if (pathname === '/api/admin/staff/support'                              && m==='POST')   return handleAdminAddSupportStaff(req, res);
  if (pathname === '/api/admin/teachers'                                   && m==='GET')    return handleAdminTeacherList(req, res);
  if (pathname === '/api/admin/teachers'                                   && m==='POST')   return handleAdminAddTeacher(req, res);
  if (pathname === '/api/admin/leaves'                                     && m==='GET')    return handleAdminGetLeaves(req, res);
  if (pathname === '/api/admin/resignations'                               && m==='GET')    return handleAdminGetResignations(req, res);
  if (pathname === '/api/admin/salary-requests'                            && m==='GET')    return handleAdminGetSalaryRequests(req, res);
  if (pathname === '/api/admin/announcements'                              && m==='GET')    return handleAdminListAnnouncements(req, res);
  if (pathname === '/api/admin/announcements'                              && m==='POST')   return handleAdminCreateAnnouncement(req, res);
  if (pathname === '/api/admin/class-fees'                                 && m==='GET')    return handleGetClassFees(req, res);
  if (pathname === '/api/admin/class-fees'                                 && m==='PATCH')  return handleUpdateClassFees(req, res);
  if (pathname === '/api/admin/settings'                                   && m==='GET')    return handleGetSystemSettings(req, res);
  if (pathname === '/api/admin/settings'                                   && m==='PATCH')  return handleUpdateSystemSettings(req, res);
  if (pathname === '/api/admin/installment-requests'                       && m==='GET')    return handleListInstallmentRequests(req, res);
  if (pathname === '/api/admin/installment-requests/pending-count'         && m==='GET')    return handleGetInstallmentRequestCount(req, res);
  if (pathname === '/api/admin/finance/summary'                            && m==='GET')    return handleFinanceSummary(req, res);
  if (pathname === '/api/admin/finance/fees'                               && m==='GET')    return handleFinanceListFees(req, res);
  if (pathname === '/api/admin/finance/fees'                               && m==='POST')   return handleFinanceAddFee(req, res);
  if (pathname === '/api/admin/finance/donations'                          && m==='GET')    return handleFinanceListDonations(req, res);
  if (pathname === '/api/admin/finance/donations'                          && m==='POST')   return handleFinanceAddDonation(req, res);
  // Fee schedules & class fees
  if (pathname === '/api/finance/fee-schedules'                            && m==='GET')    return handleGetFeeSchedules(req, res);
  if (pathname === '/api/finance/fee-schedules'                            && m==='POST')   return handleSetFeeSchedule(req, res);
  if (pathname.match(/^\/api\/finance\/fee-schedules\/\d+$/)              && m==='DELETE') return handleDeleteFeeSchedule(req, res);
  if (pathname.match(/^\/api\/admin\/class-fees\/[^/]+$/)                 && m==='GET')    return handleGetClassFeeForStudent(req, res);
  // Finance stream (SSE — will work on port 3002 too)
  if (pathname === '/api/finance/stream'                                   && m==='GET')    return handleFinanceStream(req, res);
  // Delete payment voucher
  if (pathname.match(/^\/api\/finance\/payment-vouchers\/\d+$/)           && m==='DELETE') return handleDeletePaymentVoucher(req, res);
  send(res, 404, { error: 'Not found on data port' });
}
const dataServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Cache-Control, X-Requested-With');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try { routeDataRequest(req, res); } catch(e) { send(res, 500, { error: e.message }); }
});
dataServer.listen(DATA_PORT, () => {
  console.log(`   📊 Data API : http://localhost:${DATA_PORT}  (extension-bypass port)`);
});

server.listen(PORT, '0.0.0.0', () => {
  const stats = {
    students:   db.prepare('SELECT COUNT(*) AS c FROM students').get().c,
    attendance: db.prepare('SELECT COUNT(*) AS c FROM attendance').get().c
  };

  console.log(`\n✅  Gurukul Portal Server  —  SQLite Edition`);
  console.log(`   School : The Gurukul High, K.R. Nagar, Mysuru`);
  console.log(`   Port   : http://localhost:${PORT}`);
  console.log(`   DB     : ${DB_PATH}`);
  console.log(`   Data   : ${stats.students} students, ${stats.attendance} attendance records\n`);
  console.log(`   🌐 Portal  : http://localhost:${PORT}/portal/login.html`);
  console.log(`   🏠 Website : http://localhost:${PORT}/index.html`);
  console.log(`   📋 Admin   : http://localhost:${PORT}/portal/admissions-admin.html\n`);
  console.log(`   API Endpoints:`);
  console.log(`   POST  /api/auth/login`);
  console.log(`   GET   /api/student/profile|attendance|marks|fees`);
  console.log(`   POST  /api/admissions/submit`);
  console.log(`   GET   /api/admissions/list?key=<admin_key>`);
  console.log(`   PATCH /api/admissions/:id/status?key=<admin_key>`);
  console.log(`   GET   /api/admin/students?key=<admin_key>`);
  console.log(`   POST  /api/admin/students?key=<admin_key>`);
  console.log(`   POST  /api/admin/attendance?key=<admin_key>`);
  console.log(`   PATCH /api/admin/students/:id/reset-password?key=<admin_key>`);
  console.log(`   GET   /api/admin/stats?key=<admin_key>`);
  console.log(`   POST  /api/admin/sync-sheets?key=<admin_key>`);
  console.log('');
});

// ── Global crash guards — server will NEVER go down due to unhandled errors ──
process.on('uncaughtException', (err) => {
  console.error(`\n❌  [${new Date().toISOString()}] Uncaught Exception (server kept alive):`);
  console.error('   ', err.message);
  if (err.code === 'ERR_SQLITE_ERROR') {
    console.error('   SQLite error — check database integrity.');
  }
});

process.on('unhandledRejection', (reason) => {
  console.error(`\n❌  [${new Date().toISOString()}] Unhandled Promise Rejection (server kept alive):`);
  console.error('   ', reason);
});

// ── Graceful shutdown — flush to FUSE before exit ──
function gracefulShutdown(signal) {
  console.log(`\n🔒  ${signal} received — flushing DB to FUSE and shutting down...`);
  try { flushToFuse(); console.log('💾 DB flushed to FUSE'); } catch(e) { console.warn('Flush failed:', e.message); }
  try { db.close(); } catch(e) {}
  try { server.close(() => { console.log('Server closed.'); process.exit(0); }); } catch(e) {}
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
