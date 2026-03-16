/**
 * ============================================================
 *  Gurukul RBAC + Audit System  — rbac.js
 *  Role-Based Access Control, IP Restriction, Audit Footprint
 *  The Gurukul High, K.R. Nagar, Mysuru
 * ============================================================
 *
 *  Usage (in server.js):
 *    const rbac = require('./rbac');
 *    rbac.init(db);                          // call once after DB is open
 *    rbac.audit(req, user, action, module, resourceType, resourceId, details, result)
 *    const ok = rbac.checkIP(req, user);     // returns true / sends 403
 *    const ok = rbac.can(user, module, perm); // returns true/false
 *    rbac.guard(req, res, user, module, perm) // sends 403 and returns false if denied
 */

'use strict';

let _db = null;

// ─── ROLE DEFINITIONS ────────────────────────────────────────────────────────
const ROLES = [
  { key: 'super_admin',    name: 'Super Administrator',  desc: 'Unrestricted access to everything including system config and all audit logs' },
  { key: 'principal',      name: 'Principal',             desc: 'View all modules, approve access requests, cannot edit financial records' },
  { key: 'admin',          name: 'Administrator',         desc: 'Manage school operations, users, admissions, HR. Cannot access private financials' },
  { key: 'finance_officer',name: 'Finance Officer',       desc: 'Today-only fee collection. Must request approval for historical financial data' },
  { key: 'accountant',     name: 'Accountant',            desc: 'Full read/write access to all financial records, payroll, and accounting' },
  { key: 'hr_manager',     name: 'HR Manager',            desc: 'Full HR access: staff, payroll, leave, teacher management' },
  { key: 'teacher',        name: 'Teacher',               desc: 'Own schedule, mark attendance, view own salary slip only' },
  { key: 'parent',         name: 'Parent / Guardian',     desc: 'View own child data: marks, attendance, fee status, school notices' },
];

// ─── PERMISSION MATRIX ───────────────────────────────────────────────────────
// Format: [role_key, module, view, create, edit, delete, export, approve, today_only]
// 1=yes, 0=no
const PERMISSIONS = [
  // ── super_admin: everything ─────────────────────────────────────────────
  ['super_admin','students',        1,1,1,1,1,1,0],
  ['super_admin','attendance',      1,1,1,1,1,1,0],
  ['super_admin','marks',           1,1,1,1,1,1,0],
  ['super_admin','fees',            1,1,1,1,1,1,0],
  ['super_admin','admissions',      1,1,1,1,1,1,0],
  ['super_admin','payroll',         1,1,1,1,1,1,0],
  ['super_admin','hr',              1,1,1,1,1,1,0],
  ['super_admin','leave',           1,1,1,1,1,1,0],
  ['super_admin','teacher_mgmt',    1,1,1,1,1,1,0],
  ['super_admin','finance',         1,1,1,1,1,1,0],
  ['super_admin','accounting',      1,1,1,1,1,1,0],
  ['super_admin','budget',          1,1,1,1,1,1,0],
  ['super_admin','marketing',       1,1,1,1,1,1,0],
  ['super_admin','analytics',       1,1,1,1,1,1,0],
  ['super_admin','audit_log',       1,1,1,1,1,1,0],
  ['super_admin','security',        1,1,1,1,1,1,0],
  ['super_admin','user_mgmt',       1,1,1,1,1,1,0],
  ['super_admin','system_config',   1,1,1,1,1,1,0],
  ['super_admin','access_requests', 1,1,1,1,1,1,0],
  ['super_admin','ip_mgmt',         1,1,1,1,1,1,0],

  // ── principal: view all + approve requests ──────────────────────────────
  ['principal','students',         1,0,0,0,1,0,0],
  ['principal','attendance',       1,0,0,0,1,0,0],
  ['principal','marks',            1,0,0,0,1,0,0],
  ['principal','fees',             1,0,0,0,1,0,0],
  ['principal','admissions',       1,1,1,0,1,1,0],
  ['principal','payroll',          1,0,0,0,1,0,0],
  ['principal','hr',               1,0,0,0,1,0,0],
  ['principal','leave',            1,0,1,0,1,1,0],
  ['principal','teacher_mgmt',     1,0,0,0,1,0,0],
  ['principal','finance',          1,0,0,0,1,0,0],
  ['principal','accounting',       1,0,0,0,1,0,0],
  ['principal','budget',           1,0,0,0,1,0,0],
  ['principal','marketing',        1,0,0,0,1,0,0],
  ['principal','analytics',        1,0,0,0,1,0,0],
  ['principal','audit_log',        1,0,0,0,1,0,0],
  ['principal','security',         1,0,0,0,0,0,0],
  ['principal','access_requests',  1,0,0,0,0,1,0],

  // ── admin ───────────────────────────────────────────────────────────────
  ['admin','students',             1,1,1,0,1,0,0],
  ['admin','attendance',           1,1,1,0,1,0,0],
  ['admin','marks',                1,1,1,0,1,0,0],
  ['admin','fees',                 1,0,0,0,1,0,0],
  ['admin','admissions',           1,1,1,1,1,1,0],
  ['admin','payroll',              0,0,0,0,0,0,0],
  ['admin','hr',                   1,1,1,0,1,0,0],
  ['admin','leave',                1,1,1,0,1,1,0],
  ['admin','teacher_mgmt',         1,1,1,0,1,0,0],
  ['admin','finance',              0,0,0,0,0,0,0],
  ['admin','accounting',           0,0,0,0,0,0,0],
  ['admin','budget',               1,0,0,0,1,0,0],
  ['admin','marketing',            1,1,1,0,1,0,0],
  ['admin','analytics',            1,0,0,0,1,0,0],
  ['admin','audit_log',            0,0,0,0,0,0,0],
  ['admin','security',             1,0,0,0,0,0,0],
  ['admin','user_mgmt',            1,1,1,0,0,0,0],
  ['admin','access_requests',      1,0,0,0,0,0,0],

  // ── finance_officer: today-only, view+create only, NO edit/delete ────────
  ['finance_officer','fees',           1,1,0,0,1,0,1],  // today_only=1
  ['finance_officer','students',       1,0,0,0,0,0,0],
  ['finance_officer','finance',        1,0,0,0,0,0,1],  // today_only=1
  ['finance_officer','accounting',     0,0,0,0,0,0,0],
  ['finance_officer','payroll',        0,0,0,0,0,0,0],
  ['finance_officer','access_requests',1,1,0,0,0,0,0],  // can create requests for history

  // ── accountant: full financial access ───────────────────────────────────
  ['accountant','fees',            1,1,1,0,1,0,0],
  ['accountant','students',        1,0,0,0,0,0,0],
  ['accountant','finance',         1,1,1,0,1,0,0],
  ['accountant','accounting',      1,1,1,0,1,0,0],
  ['accountant','payroll',         1,1,1,0,1,1,0],
  ['accountant','budget',          1,1,1,0,1,0,0],
  ['accountant','hr',              0,0,0,0,0,0,0],
  ['accountant','access_requests', 1,0,0,0,0,0,0],

  // ── hr_manager ─────────────────────────────────────────────────────────
  ['hr_manager','hr',              1,1,1,1,1,0,0],
  ['hr_manager','payroll',         1,1,1,0,1,1,0],
  ['hr_manager','leave',           1,1,1,1,1,1,0],
  ['hr_manager','teacher_mgmt',    1,1,1,0,1,0,0],
  ['hr_manager','students',        1,0,0,0,0,0,0],
  ['hr_manager','attendance',      1,0,0,0,1,0,0],
  ['hr_manager','budget',          1,0,0,0,1,0,0],
  ['hr_manager','analytics',       1,0,0,0,1,0,0],
  ['hr_manager','access_requests', 1,0,0,0,0,0,0],

  // ── teacher: own data only ──────────────────────────────────────────────
  ['teacher','attendance',         1,1,0,0,0,0,0],  // mark own classes only
  ['teacher','marks',              1,1,1,0,0,0,0],  // own classes only
  ['teacher','students',           1,0,0,0,0,0,0],  // view only
  ['teacher','leave',              1,1,0,0,0,0,0],  // apply own leave
  ['teacher','teacher_mgmt',       1,0,0,0,0,0,0],  // view own schedule

  // ── parent: own child only ──────────────────────────────────────────────
  ['parent','students',            1,0,0,0,0,0,0],  // own child only
  ['parent','attendance',          1,0,0,0,0,0,0],  // own child only
  ['parent','marks',               1,0,0,0,0,0,0],  // own child only
  ['parent','fees',                1,1,0,0,1,0,0],  // pay own fees
];

// ─── MODULE ALIASES ──────────────────────────────────────────────────────────
// Maps URL path prefixes → module key
const MODULE_MAP = {
  '/api/students':       'students',
  '/api/attendance':     'attendance',
  '/api/marks':          'marks',
  '/api/fees':           'fees',
  '/api/finance':        'fees',
  '/api/accounting':     'accounting',
  '/api/admissions':     'admissions',
  '/api/payroll':        'payroll',
  '/api/hr':             'hr',
  '/api/leave':          'leave',
  '/api/teachers':       'teacher_mgmt',
  '/api/timetable':      'teacher_mgmt',
  '/api/budget':         'budget',
  '/api/marketing':      'marketing',
  '/api/analytics':      'analytics',
  '/api/audit':          'audit_log',
  '/api/security':       'security',
  '/api/users':          'user_mgmt',
  '/api/access-request': 'access_requests',
  '/api/ip':             'ip_mgmt',
  '/api/rbac':           'user_mgmt',
};

// ─── INIT: create tables + seed roles/permissions ────────────────────────────
function init(db) {
  _db = db;

  db.exec(`
    -- ── Roles registry ────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS rbac_roles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      role_key    TEXT    UNIQUE NOT NULL,
      role_name   TEXT    NOT NULL,
      description TEXT,
      is_active   INTEGER DEFAULT 1,
      created_at  TEXT    DEFAULT (datetime('now','localtime'))
    );

    -- ── Permission matrix ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS rbac_permissions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      role_key    TEXT    NOT NULL,
      module      TEXT    NOT NULL,
      can_view    INTEGER DEFAULT 0,
      can_create  INTEGER DEFAULT 0,
      can_edit    INTEGER DEFAULT 0,
      can_delete  INTEGER DEFAULT 0,
      can_export  INTEGER DEFAULT 0,
      can_approve INTEGER DEFAULT 0,
      today_only  INTEGER DEFAULT 0,
      UNIQUE(role_key, module)
    );

    -- ── User → Role assignments ───────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS user_roles (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    NOT NULL,
      role_key    TEXT    NOT NULL,
      assigned_by TEXT,
      assigned_at TEXT    DEFAULT (datetime('now','localtime')),
      expires_at  TEXT,
      is_active   INTEGER DEFAULT 1,
      UNIQUE(username, role_key)
    );

    -- ── IP Whitelist ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ip_whitelist (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT,
      role_key    TEXT,
      ip_address  TEXT    NOT NULL,
      ip_label    TEXT    DEFAULT '',
      added_by    TEXT,
      added_at    TEXT    DEFAULT (datetime('now','localtime')),
      is_active   INTEGER DEFAULT 1
    );

    -- ── Access Requests (Finance Officer → history) ───────────────────────
    CREATE TABLE IF NOT EXISTS access_requests (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      requested_by   TEXT    NOT NULL,
      module         TEXT    NOT NULL,
      resource_type  TEXT,
      date_from      TEXT,
      date_to        TEXT,
      reason         TEXT    NOT NULL,
      status         TEXT    DEFAULT 'Pending',
      reviewed_by    TEXT,
      reviewed_at    TEXT,
      expires_at     TEXT,
      notified       INTEGER DEFAULT 0,
      created_at     TEXT    DEFAULT (datetime('now','localtime'))
    );

    -- ── Comprehensive Audit Log ───────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS user_audit_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL,
      role_key      TEXT,
      action        TEXT    NOT NULL,
      module        TEXT,
      resource_type TEXT,
      resource_id   TEXT,
      details       TEXT,
      ip_address    TEXT,
      user_agent    TEXT,
      session_id    TEXT,
      result        TEXT    DEFAULT 'success',
      timestamp     TEXT    DEFAULT (datetime('now','localtime'))
    );

    -- ── Biometric Events ──────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS biometric_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      username     TEXT,
      device_id    TEXT,
      event_type   TEXT,
      biometric_id TEXT,
      matched_ip   TEXT,
      raw_data     TEXT,
      timestamp    TEXT    DEFAULT (datetime('now','localtime')),
      synced       INTEGER DEFAULT 0
    );
  `);

  // Seed roles
  const roleIns = db.prepare(`INSERT OR IGNORE INTO rbac_roles (role_key, role_name, description) VALUES (?,?,?)`);
  for (const r of ROLES) roleIns.run(r.key, r.name, r.desc);

  // Seed permission matrix
  const permIns = db.prepare(`
    INSERT OR IGNORE INTO rbac_permissions
      (role_key, module, can_view, can_create, can_edit, can_delete, can_export, can_approve, today_only)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  for (const p of PERMISSIONS) permIns.run(...p);

  // Seed default user→role mappings for existing users
  const roleMap = [
    ['admin',     'super_admin'],
    ['finance',   'finance_officer'],
    ['hr',        'hr_manager'],
    ['marketing', 'admin'],
    ['budget',    'accountant'],
    ['audit',     'principal'],
    ['cyber',     'super_admin'],
  ];
  const urIns = db.prepare(`INSERT OR IGNORE INTO user_roles (username, role_key, assigned_by) VALUES (?,?,'system')`);
  for (const [u, r] of roleMap) urIns.run(u, r);

  // Seed school network IP (localhost + common local)
  const ipIns = db.prepare(`INSERT OR IGNORE INTO ip_whitelist (username, role_key, ip_address, ip_label, added_by) VALUES (?,?,?,?,?)`);
  ipIns.run(null, null,             '127.0.0.1',  'Localhost',       'system');
  ipIns.run(null, null,             '::1',         'Localhost IPv6',  'system');
  ipIns.run(null, 'parent',         '0.0.0.0/0',   'Any (Parents)',   'system');  // parents not restricted
  ipIns.run(null, 'student',        '0.0.0.0/0',   'Any (Students)',  'system');

  // Index for fast audit log queries
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_username  ON user_audit_log(username);
      CREATE INDEX IF NOT EXISTS idx_audit_module    ON user_audit_log(module);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON user_audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_action    ON user_audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_access_req_user ON access_requests(requested_by, status);
    `);
  } catch(e) { /* indexes may already exist */ }

  console.log('✅ RBAC system initialised — roles, permissions, IP whitelist seeded');
}

// ─── GET USER'S ROLE FROM DB (cached per session via JWT) ────────────────────
function getUserRole(username) {
  if (!_db || !username) return null;
  const row = _db.prepare(`
    SELECT role_key FROM user_roles
    WHERE username=? AND is_active=1
    AND (expires_at IS NULL OR expires_at > datetime('now','localtime'))
    ORDER BY id DESC LIMIT 1
  `).get(username);
  return row ? row.role_key : null;
}

// ─── PERMISSION CHECK ─────────────────────────────────────────────────────────
// perm: 'view' | 'create' | 'edit' | 'delete' | 'export' | 'approve'
function can(roleKey, module, perm) {
  if (!_db || !roleKey || !module) return false;
  if (roleKey === 'super_admin') return true;  // super admin bypasses all checks
  const row = _db.prepare(`
    SELECT can_view, can_create, can_edit, can_delete, can_export, can_approve
    FROM rbac_permissions WHERE role_key=? AND module=?
  `).get(roleKey, module);
  if (!row) return false;
  const map = { view:'can_view', create:'can_create', edit:'can_edit', delete:'can_delete', export:'can_export', approve:'can_approve' };
  return row[map[perm] || 'can_view'] === 1;
}

// ─── TODAY-ONLY CHECK ────────────────────────────────────────────────────────
function isTodayOnly(roleKey, module) {
  if (!_db || !roleKey) return false;
  if (roleKey === 'super_admin') return false;
  const row = _db.prepare(`SELECT today_only FROM rbac_permissions WHERE role_key=? AND module=?`).get(roleKey, module);
  return row ? row.today_only === 1 : false;
}

// ─── GUARD HELPER (send 403 + return false if denied) ────────────────────────
function guard(req, res, roleKey, module, perm, sendFn) {
  if (can(roleKey, module, perm)) return true;
  audit(req, req._user || 'unknown', 'DENIED', module, perm, null, `Permission denied: ${perm} on ${module}`, 'denied');
  sendFn(res, 403, { error: `Access denied. Your role (${roleKey}) does not have ${perm} permission on ${module}.` });
  return false;
}

// ─── IP RESTRICTION ──────────────────────────────────────────────────────────
// Roles that bypass IP restriction
const IP_EXEMPT_ROLES = new Set(['parent', 'student']);

function checkIP(req, username, roleKey, sendFn) {
  if (IP_EXEMPT_ROLES.has(roleKey)) return true;
  if (!_db) return true;  // fail open if DB not ready

  const clientIP = getClientIP(req);

  // Check user-specific whitelist first, then role whitelist, then global
  const rows = _db.prepare(`
    SELECT ip_address FROM ip_whitelist
    WHERE is_active=1
    AND (
      username=?
      OR role_key=?
      OR (username IS NULL AND role_key IS NULL)
    )
  `).all(username || '', roleKey || '');

  for (const row of rows) {
    if (matchesIP(clientIP, row.ip_address)) return true;
  }

  // Log the blocked attempt
  audit(req, username || 'unknown', 'IP_BLOCKED', 'security', 'access',
    null, `IP not whitelisted: ${clientIP}`, 'denied');

  if (sendFn) sendFn(req._res, 403, {
    error: `Access denied. Your IP address (${clientIP}) is not registered for school network access. Contact your administrator.`,
    ip: clientIP,
    code: 'IP_NOT_WHITELISTED'
  });
  return false;
}

function matchesIP(clientIP, rule) {
  if (!rule || rule === '0.0.0.0/0') return true;
  if (rule === clientIP) return true;
  // CIDR check (simple /24 support)
  if (rule.includes('/')) {
    const [base, bits] = rule.split('/');
    const mask = ~0 << (32 - parseInt(bits));
    const ipToInt = ip => ip.split('.').reduce((a,b) => (a<<8)+parseInt(b), 0);
    try { return (ipToInt(clientIP) & mask) === (ipToInt(base) & mask); } catch(e) { return false; }
  }
  // Wildcard prefix e.g. "192.168.1."
  if (rule.endsWith('.*') || rule.endsWith('.0')) {
    return clientIP.startsWith(rule.replace('.*','').replace('.0',''));
  }
  return false;
}

function getClientIP(req) {
  return ((req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
    .split(',')[0].trim().slice(0,45));
}

// ─── AUDIT LOGGER ────────────────────────────────────────────────────────────
function audit(req, username, action, module, resourceType, resourceId, details, result) {
  if (!_db) return;
  try {
    const ip = req ? getClientIP(req) : '–';
    const ua = req ? (req.headers['user-agent'] || '').slice(0, 200) : '';
    const sid = req ? (req.headers['x-session-id'] || req.headers['authorization'] || '').slice(-20) : '';
    const roleKey = req && req._rbacRole ? req._rbacRole : null;
    _db.prepare(`
      INSERT INTO user_audit_log
        (username, role_key, action, module, resource_type, resource_id, details, ip_address, user_agent, session_id, result)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      username || 'unknown',
      roleKey || '',
      action  || 'ACTION',
      module  || '',
      resourceType || '',
      resourceId   ? String(resourceId) : '',
      details      ? String(details).slice(0, 500) : '',
      ip, ua, sid,
      result || 'success'
    );
    // Trim to last 50,000 entries
    _db.prepare(`DELETE FROM user_audit_log WHERE id NOT IN (SELECT id FROM user_audit_log ORDER BY id DESC LIMIT 50000)`).run();
  } catch(e) { /* never break the main request */ }
}

// ─── ACCESS REQUEST HELPERS ──────────────────────────────────────────────────
function createAccessRequest(username, module, resourceType, dateFrom, dateTo, reason) {
  if (!_db) return null;
  const result = _db.prepare(`
    INSERT INTO access_requests (requested_by, module, resource_type, date_from, date_to, reason, status)
    VALUES (?,?,?,?,?,?,'Pending')
  `).run(username, module, resourceType || '', dateFrom || '', dateTo || '', reason);
  return result.lastInsertRowid;
}

function approveAccessRequest(requestId, reviewerUsername, windowHours) {
  if (!_db) return false;
  const expiresAt = new Date(Date.now() + (windowHours || 2) * 3600 * 1000)
    .toISOString().replace('T',' ').slice(0,19);
  _db.prepare(`
    UPDATE access_requests
    SET status='Approved', reviewed_by=?, reviewed_at=datetime('now','localtime'), expires_at=?
    WHERE id=?
  `).run(reviewerUsername, expiresAt, requestId);
  return true;
}

function rejectAccessRequest(requestId, reviewerUsername, reason) {
  if (!_db) return false;
  _db.prepare(`
    UPDATE access_requests
    SET status='Rejected', reviewed_by=?, reviewed_at=datetime('now','localtime'), details=?
    WHERE id=?
  `).run(reviewerUsername, reason || '', requestId);
  return true;
}

// Check if finance officer has an active approved request for historical data
function hasHistoricalAccess(username, module, targetDate) {
  if (!_db) return false;
  const row = _db.prepare(`
    SELECT id FROM access_requests
    WHERE requested_by=?
    AND module=?
    AND status='Approved'
    AND expires_at > datetime('now','localtime')
    AND (date_from <= ? OR date_from='')
    AND (date_to >= ? OR date_to='')
    ORDER BY id DESC LIMIT 1
  `).get(username, module, targetDate || '9999', targetDate || '0000');
  return !!row;
}

// ─── DATE FILTER ENFORCEMENT ──────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0,10);  // YYYY-MM-DD
}

// ─── AUDIT LOG QUERIES (for dashboard) ───────────────────────────────────────
function getAuditLog({ username, module, action, result, from, to, limit, offset }) {
  if (!_db) return { logs: [], total: 0 };
  let where = 'WHERE 1=1';
  const params = [];
  if (username) { where += ' AND username=?'; params.push(username); }
  if (module)   { where += ' AND module=?';   params.push(module); }
  if (action)   { where += ' AND action=?';   params.push(action); }
  if (result)   { where += ' AND result=?';   params.push(result); }
  if (from)     { where += ' AND timestamp>=?'; params.push(from + ' 00:00:00'); }
  if (to)       { where += ' AND timestamp<=?'; params.push(to   + ' 23:59:59'); }
  const total = _db.prepare(`SELECT COUNT(*) as c FROM user_audit_log ${where}`).get(...params)?.c || 0;
  const logs  = _db.prepare(`SELECT * FROM user_audit_log ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit || 100, offset || 0);
  return { logs, total };
}

function getUserFootprint(username, days) {
  if (!_db) return [];
  return _db.prepare(`
    SELECT action, module, resource_type, details, ip_address, result, timestamp
    FROM user_audit_log
    WHERE username=?
    AND timestamp >= datetime('now','localtime', '-' || ? || ' days')
    ORDER BY id DESC LIMIT 500
  `).all(username, days || 30);
}

function getSystemFeed(limit) {
  if (!_db) return [];
  return _db.prepare(`
    SELECT * FROM user_audit_log
    ORDER BY id DESC LIMIT ?
  `).all(limit || 100);
}

function getAlerts(limit) {
  if (!_db) return [];
  return _db.prepare(`
    SELECT * FROM user_audit_log
    WHERE result='denied' OR action IN ('IP_BLOCKED','LOGIN_FAILED','BRUTE_FORCE')
    ORDER BY id DESC LIMIT ?
  `).all(limit || 50);
}

function getAccessRequests(status, limit) {
  if (!_db) return [];
  let q = `SELECT * FROM access_requests`;
  if (status) q += ` WHERE status=?`;
  q += ` ORDER BY id DESC LIMIT ?`;
  return status
    ? _db.prepare(q).all(status, limit || 100)
    : _db.prepare(q).all(limit || 100);
}

function getActiveUsers(minutes) {
  if (!_db) return [];
  return _db.prepare(`
    SELECT username, role_key, COUNT(*) as actions, MAX(timestamp) as last_seen, ip_address
    FROM user_audit_log
    WHERE timestamp >= datetime('now','localtime', '-' || ? || ' minutes')
    GROUP BY username ORDER BY last_seen DESC
  `).all(minutes || 30);
}

function getSummaryStats() {
  if (!_db) return {};
  const today = todayStr();
  return {
    totalLogsToday: _db.prepare(`SELECT COUNT(*) as c FROM user_audit_log WHERE timestamp LIKE ?`).get(today+'%')?.c || 0,
    deniedToday:    _db.prepare(`SELECT COUNT(*) as c FROM user_audit_log WHERE result='denied' AND timestamp LIKE ?`).get(today+'%')?.c || 0,
    activeUsers:    _db.prepare(`SELECT COUNT(DISTINCT username) as c FROM user_audit_log WHERE timestamp >= datetime('now','localtime','-30 minutes')`).get()?.c || 0,
    pendingRequests:_db.prepare(`SELECT COUNT(*) as c FROM access_requests WHERE status='Pending'`).get()?.c || 0,
    blockedIPs:     _db.prepare(`SELECT COUNT(*) as c FROM user_audit_log WHERE action='IP_BLOCKED' AND timestamp LIKE ?`).get(today+'%')?.c || 0,
  };
}

// ─── IP MANAGEMENT ───────────────────────────────────────────────────────────
function listIPs(username, roleKey) {
  if (!_db) return [];
  if (username) return _db.prepare(`SELECT * FROM ip_whitelist WHERE username=? AND is_active=1`).all(username);
  if (roleKey)  return _db.prepare(`SELECT * FROM ip_whitelist WHERE role_key=? AND is_active=1`).all(roleKey);
  return _db.prepare(`SELECT * FROM ip_whitelist WHERE is_active=1 ORDER BY role_key, username`).all();
}

function addIP(username, roleKey, ipAddress, ipLabel, addedBy) {
  if (!_db) return null;
  const result = _db.prepare(`
    INSERT OR IGNORE INTO ip_whitelist (username, role_key, ip_address, ip_label, added_by)
    VALUES (?,?,?,?,?)
  `).run(username || null, roleKey || null, ipAddress, ipLabel || '', addedBy || 'admin');
  return result.lastInsertRowid;
}

function removeIP(id, removedBy) {
  if (!_db) return false;
  _db.prepare(`UPDATE ip_whitelist SET is_active=0 WHERE id=?`).run(id);
  return true;
}

// ─── USER MANAGEMENT ─────────────────────────────────────────────────────────
function assignRole(username, roleKey, assignedBy, expiresAt) {
  if (!_db) return false;
  _db.prepare(`
    INSERT OR REPLACE INTO user_roles (username, role_key, assigned_by, expires_at, is_active)
    VALUES (?,?,?,?,1)
  `).run(username, roleKey, assignedBy || 'admin', expiresAt || null);
  return true;
}

function revokeRole(username, roleKey, revokedBy) {
  if (!_db) return false;
  _db.prepare(`UPDATE user_roles SET is_active=0 WHERE username=? AND role_key=?`).run(username, roleKey);
  audit(null, revokedBy || 'admin', 'ROLE_REVOKED', 'user_mgmt', 'role', username, `Revoked ${roleKey} from ${username}`, 'success');
  return true;
}

function listUserRoles(username) {
  if (!_db) return [];
  return _db.prepare(`
    SELECT ur.*, r.role_name, r.description
    FROM user_roles ur
    JOIN rbac_roles r ON r.role_key = ur.role_key
    WHERE ur.username=? AND ur.is_active=1
  `).all(username);
}

function listAllUserRoles() {
  if (!_db) return [];
  return _db.prepare(`
    SELECT ur.username, ur.role_key, r.role_name, ur.assigned_by, ur.assigned_at, ur.expires_at
    FROM user_roles ur
    JOIN rbac_roles r ON r.role_key = ur.role_key
    WHERE ur.is_active=1
    ORDER BY ur.username
  `).all();
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = {
  init,
  can,
  guard,
  isTodayOnly,
  checkIP,
  audit,
  getUserRole,
  todayStr,
  getClientIP,

  // Access requests
  createAccessRequest,
  approveAccessRequest,
  rejectAccessRequest,
  hasHistoricalAccess,

  // Audit dashboard queries
  getAuditLog,
  getUserFootprint,
  getSystemFeed,
  getAlerts,
  getAccessRequests,
  getActiveUsers,
  getSummaryStats,

  // IP management
  listIPs,
  addIP,
  removeIP,

  // User/role management
  assignRole,
  revokeRole,
  listUserRoles,
  listAllUserRoles,

  // Constants
  ROLES,
  PERMISSIONS,
  MODULE_MAP,
};
