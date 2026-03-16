/**
 * migrate-to-sqlite.js
 * One-time migration: JSON files → SQLite database
 * Run once: node server/migrate-to-sqlite.js
 */

const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'gurukul.db');

// ── Helpers ────────────────────────────────────────────────────────────────
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch(e) { return null; }
}
function log(msg) { process.stdout.write(msg + '\n'); }

// ── Create DB ──────────────────────────────────────────────────────────────
log('\n🗄️  Gurukul SQLite Migration');
log('─'.repeat(50));

if (fs.existsSync(DB_PATH)) {
  const backup = DB_PATH + '.backup-' + Date.now();
  fs.copyFileSync(DB_PATH, backup);
  log(`⚠️  Existing DB backed up → ${path.basename(backup)}`);
}

const db = new DatabaseSync(DB_PATH);

// ── Schema ─────────────────────────────────────────────────────────────────
log('\n📐 Creating tables…');

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

  CREATE INDEX IF NOT EXISTS idx_att_student ON attendance(student_id);
  CREATE INDEX IF NOT EXISTS idx_att_date    ON attendance(date);
  CREATE INDEX IF NOT EXISTS idx_marks_stud  ON marks(student_id);
  CREATE INDEX IF NOT EXISTS idx_marks_term  ON marks(student_id, term);
  CREATE INDEX IF NOT EXISTS idx_fees_stud   ON fees(student_id);
  CREATE INDEX IF NOT EXISTS idx_adm_status  ON admissions(status);
`);

log('   ✅ Tables created');

// ── Migrate Students ───────────────────────────────────────────────────────
log('\n👩‍🎓 Migrating students…');
const students = readJSON('students.json') || [];
const insStudent = db.prepare(`
  INSERT OR REPLACE INTO students
    (id, name, class, section, dob, parent_name, parent_phone, username, password_hash, email, address)
  VALUES
    (:id,:name,:class,:section,:dob,:parentName,:parentPhone,:username,:passwordHash,:email,:address)
`);

let count = 0;
db.exec('BEGIN');
for (const s of students) {
  insStudent.run({
    id:           s.id,
    name:         s.name,
    class:        s.class,
    section:      s.section       || '',
    dob:          s.dob           || '',
    parentName:   s.parentName    || '',
    parentPhone:  s.parentPhone   || '',
    username:     s.username,
    passwordHash: s.passwordHash,
    email:        s.email         || '',
    address:      s.address       || ''
  });
  count++;
}
db.exec('COMMIT');
log(`   ✅ ${count} students migrated`);

// ── Migrate Attendance ─────────────────────────────────────────────────────
log('\n📅 Migrating attendance…');
const attendanceData = readJSON('attendance.json') || {};
const insAtt = db.prepare(`
  INSERT OR IGNORE INTO attendance (student_id, date, status) VALUES (?,?,?)
`);

let attCount = 0;
db.exec('BEGIN');
for (const [studentId, records] of Object.entries(attendanceData)) {
  for (const r of records) {
    insAtt.run(studentId, r.date, r.status);
    attCount++;
  }
}
db.exec('COMMIT');
log(`   ✅ ${attCount} attendance records migrated`);

// ── Migrate Marks ──────────────────────────────────────────────────────────
log('\n📝 Migrating marks…');
const marksData = readJSON('marks.json') || {};
const insMark = db.prepare(`
  INSERT INTO marks (student_id, subject, exam, marks, max_marks, term, date)
  VALUES (?,?,?,?,?,?,?)
`);

let markCount = 0;
db.exec('BEGIN');
for (const [studentId, records] of Object.entries(marksData)) {
  for (const r of records) {
    insMark.run(studentId, r.subject, r.exam, r.marks, r.maxMarks || 100, r.term || '', r.date || '');
    markCount++;
  }
}
db.exec('COMMIT');
log(`   ✅ ${markCount} mark records migrated`);

// ── Migrate Fees ───────────────────────────────────────────────────────────
log('\n💰 Migrating fees…');
const feesData = readJSON('fees.json') || {};
const insFee = db.prepare(`
  INSERT INTO fees (student_id, fee_type, amount, due_date, paid_date, status, receipt)
  VALUES (?,?,?,?,?,?,?)
`);

let feeCount = 0;
db.exec('BEGIN');
for (const [studentId, records] of Object.entries(feesData)) {
  for (const r of records) {
    insFee.run(studentId, r.feeType, r.amount, r.dueDate || '', r.paidDate || '', r.status || 'Pending', r.receipt || '');
    feeCount++;
  }
}
db.exec('COMMIT');
log(`   ✅ ${feeCount} fee records migrated`);

// ── Migrate Admissions ─────────────────────────────────────────────────────
log('\n📋 Migrating admissions…');
const admissions = readJSON('admissions.json') || [];
const insAdm = db.prepare(`
  INSERT OR REPLACE INTO admissions
    (id, submitted_at, status, status_note, status_updated_at,
     first_name, last_name, dob, gender, blood_group, grade_applying,
     prev_school, last_grade, last_percentage, father_name, father_mobile,
     father_email, father_occupation, mother_name, mother_mobile,
     address, city, pin, hear_about, reason_admission)
  VALUES
    (:id,:submittedAt,:status,:statusNote,:statusUpdatedAt,
     :firstName,:lastName,:dob,:gender,:bloodGroup,:gradeApplying,
     :prevSchool,:lastGrade,:lastPercentage,:fatherName,:fatherMobile,
     :fatherEmail,:fatherOccupation,:motherName,:motherMobile,
     :address,:city,:pin,:hearAbout,:reasonAdmission)
`);

let admCount = 0;
db.exec('BEGIN');
for (const a of admissions) {
  insAdm.run({
    id:               a.id,
    submittedAt:      a.submittedAt       || new Date().toISOString(),
    status:           a.status            || 'Pending Review',
    statusNote:       a.statusNote        || '',
    statusUpdatedAt:  a.statusUpdatedAt   || '',
    firstName:        a.firstName         || '',
    lastName:         a.lastName          || '',
    dob:              a.dob               || '',
    gender:           a.gender            || '',
    bloodGroup:       a.bloodGroup        || '',
    gradeApplying:    a.gradeApplying     || '',
    prevSchool:       a.prevSchool        || '',
    lastGrade:        a.lastGrade         || '',
    lastPercentage:   a.lastPercentage    || '',
    fatherName:       a.fatherName        || '',
    fatherMobile:     a.fatherMobile      || '',
    fatherEmail:      a.fatherEmail       || '',
    fatherOccupation: a.fatherOccupation  || '',
    motherName:       a.motherName        || '',
    motherMobile:     a.motherMobile      || '',
    address:          a.address           || '',
    city:             a.city              || '',
    pin:              a.pin               || '',
    hearAbout:        a.hearAbout         || '',
    reasonAdmission:  a.reasonAdmission   || ''
  });
  admCount++;
}
db.exec('COMMIT');
log(`   ✅ ${admCount} admission records migrated`);

// ── Create Teacher tables ──────────────────────────────────────────────────
db.exec(`
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
`);

// Add marked_by column if not present
try { db.exec('ALTER TABLE attendance ADD COLUMN marked_by TEXT DEFAULT ""'); } catch(e) {}

// ── Seed Sample Teachers ───────────────────────────────────────────────────
log('\n👨‍🏫 Seeding sample teachers…');

const crypto = require('crypto');
function hashPwd(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.pbkdf2Sync(p, salt, 10000, 64, 'sha512').toString('hex');
}

const sampleTeachers = [
  { id:'T001', name:'Suresh Kumar',    username:'suresh.math',    subject:'Mathematics', phone:'9845001001', email:'suresh@gurukul.edu',
    assignments:[{class:'8',section:'A',subject:'Mathematics'},{class:'8',section:'B',subject:'Mathematics'},{class:'9',section:'A',subject:'Mathematics'}] },
  { id:'T002', name:'Priya Sharma',    username:'priya.science',  subject:'Science',     phone:'9845001002', email:'priya@gurukul.edu',
    assignments:[{class:'7',section:'A',subject:'Science'},{class:'7',section:'B',subject:'Science'},{class:'8',section:'A',subject:'Science'}] },
  { id:'T003', name:'Ramesh Rao',      username:'ramesh.english', subject:'English',     phone:'9845001003', email:'ramesh@gurukul.edu',
    assignments:[{class:'9',section:'A',subject:'English'},{class:'9',section:'B',subject:'English'},{class:'10',section:'A',subject:'English'}] },
  { id:'T004', name:'Kavitha Nair',    username:'kavitha.hindi',  subject:'Hindi',       phone:'9845001004', email:'kavitha@gurukul.edu',
    assignments:[{class:'6',section:'A',subject:'Hindi'},{class:'6',section:'B',subject:'Hindi'},{class:'7',section:'A',subject:'Hindi'}] },
  { id:'T005', name:'Anand Murthy',    username:'anand.social',   subject:'Social Studies', phone:'9845001005', email:'anand@gurukul.edu',
    assignments:[{class:'10',section:'A',subject:'Social Studies'},{class:'10',section:'B',subject:'Social Studies'}] },
];

const insTeacher = db.prepare('INSERT OR IGNORE INTO teachers (id,name,username,password_hash,email,phone,subject) VALUES (?,?,?,?,?,?,?)');
const insAssign  = db.prepare('INSERT OR IGNORE INTO teacher_assignments (teacher_id,class,section,subject) VALUES (?,?,?,?)');

db.exec('BEGIN');
let tCount = 0;
for (const t of sampleTeachers) {
  insTeacher.run(t.id, t.name, t.username, hashPwd('teacher123'), t.email, t.phone, t.subject);
  for (const a of t.assignments) insAssign.run(t.id, a.class, a.section, a.subject);
  tCount++;
}
db.exec('COMMIT');
log(`   ✅ ${tCount} teachers seeded (default password: teacher123)`);
log('   Teachers: suresh.math, priya.science, ramesh.english, kavitha.hindi, anand.social');

// ── Summary ────────────────────────────────────────────────────────────────
const stats = {
  students:   db.prepare('SELECT COUNT(*) AS c FROM students').get().c,
  attendance: db.prepare('SELECT COUNT(*) AS c FROM attendance').get().c,
  marks:      db.prepare('SELECT COUNT(*) AS c FROM marks').get().c,
  fees:       db.prepare('SELECT COUNT(*) AS c FROM fees').get().c,
  admissions: db.prepare('SELECT COUNT(*) AS c FROM admissions').get().c,
  teachers:   db.prepare('SELECT COUNT(*) AS c FROM teachers').get().c,
};

db.close();

log('\n' + '─'.repeat(50));
log('✅ Migration complete!  Database: server/data/gurukul.db');
log('─'.repeat(50));
log(`   Students:   ${stats.students}`);
log(`   Teachers:   ${stats.teachers}`);
log(`   Attendance: ${stats.attendance} records`);
log(`   Marks:      ${stats.marks} records`);
log(`   Fees:       ${stats.fees} records`);
log(`   Admissions: ${stats.admissions} records`);
log('\n👉 Steps to start:');
log('   1. node server/server.js');
log('   2. Open http://localhost:3000/portal/login.html     (student)');
log('   3. Open http://localhost:3000/portal/teacher-login.html  (teacher)');
log('\n   Student login:  rahul.kumar / gurukul123');
log('   Teacher login:  suresh.math / teacher123\n');
