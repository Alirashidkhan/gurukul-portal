/**
 * sync-data.js — exports live DB data to portal/data/*.json files
 * Serves as static files to bypass the Claude-in-Chrome proxy cache.
 *
 * Generated files:
 *  library-books.json, library-loans.json, homework.json
 *  transport-routes.json, transport-students.json, visitors.json
 *  certificates.json, ai-predictions.json, nep.json
 *  naac-report.json, notifications.json
 *  admin-stats.json, admin-budget.json
 *  finance-summary.json, hr-overview.json
 *  budget-overview.json, marketing-overview.json
 */

const DEPT_META = {
  hr:          { name: 'Human Resources'     },
  marketing:   { name: 'Marketing'           },
  operations:  { name: 'Operations & Admin'  },
  academic:    { name: 'Academic & Teaching' },
  it:          { name: 'IT & Infrastructure' },
  transport:   { name: 'Transport'           },
};
const { DatabaseSync } = require('node:sqlite');
const fs   = require('fs');
const path = require('path');

// Write to /tmp/portal-data/ to avoid FUSE page-cache writeback issues.
// The server routes GET /portal/data/* to this directory directly.
const DATA_DIR     = '/tmp/portal-data';
const DATA_DIR_ALT = path.join(__dirname, '..', 'portal', 'data'); // FUSE backup copy

function write(filename, data) {
  const content = JSON.stringify(data, null, 2);
  // Primary: write to /tmp (immediately visible to server reads)
  fs.writeFileSync(path.join(DATA_DIR, filename), content);
  // Backup: also write to FUSE for persistence (best-effort, ignore failures)
  try { fs.writeFileSync(path.join(DATA_DIR_ALT, filename), content); } catch(_) {}
}

function syncAll(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // ── Library ──────────────────────────────────────────────────────────
  try {
    const books = db.prepare('SELECT * FROM library_books ORDER BY title').all();
    const loans = db.prepare(`
      SELECT l.*, b.title, b.author
      FROM book_loans l JOIN library_books b ON l.book_id=b.id
      ORDER BY l.issued_on DESC
    `).all();
    const total     = books.length;
    const available = books.reduce((s, b) => s + (b.available || 0), 0);
    const issued    = loans.filter(l => l.status === 'Issued').length;
    const today     = new Date().toISOString().slice(0, 10);
    const overdue   = loans.filter(l => l.status === 'Issued' && l.due_date < today).length;
    write('library-books.json', { books, stats: { total, available, issued, overdue } });
    write('library-loans.json', { loans });
  } catch(e) {
    write('library-books.json', { books: [], stats: { total: 0, available: 0, issued: 0, overdue: 0 }, error: e.message });
    write('library-loans.json', { loans: [], error: e.message });
  }

  // ── Homework ──────────────────────────────────────────────────────────
  try {
    const homework = db.prepare('SELECT * FROM homework ORDER BY due_date DESC').all();
    write('homework.json', { homework });
  } catch(e) { write('homework.json', { homework: [], error: e.message }); }

  // ── Transport ─────────────────────────────────────────────────────────
  try {
    const routes = db.prepare('SELECT * FROM transport_routes ORDER BY route_name').all();
    // Parse stops JSON for each route
    routes.forEach(r => { try { r.stops_arr = JSON.parse(r.stops || '[]'); } catch(_) { r.stops_arr = []; } });
    write('transport-routes.json', { routes });
  } catch(e) { write('transport-routes.json', { routes: [], error: e.message }); }
  try {
    const students = db.prepare(`
      SELECT ts.id, ts.student_id, ts.route_id, ts.stop, ts.fee,
             s.name AS student_name, s.class, s.section, r.route_name
      FROM transport_students ts
      LEFT JOIN students s ON ts.student_id = s.id
      LEFT JOIN transport_routes r ON ts.route_id = r.id
    `).all();
    write('transport-students.json', { students });
  } catch(e) { write('transport-students.json', { students: [], error: e.message }); }

  // ── Visitors ──────────────────────────────────────────────────────────
  try {
    const visitors = db.prepare('SELECT * FROM visitors ORDER BY entry_time DESC LIMIT 100').all();
    write('visitors.json', { visitors });
  } catch(e) { write('visitors.json', { visitors: [], error: e.message }); }

  // ── Certificates ─────────────────────────────────────────────────────
  try {
    const certificates = db.prepare(`
      SELECT c.*, s.name AS student_name
      FROM certificates c
      LEFT JOIN students s ON c.student_id = s.id
      ORDER BY c.issued_on DESC
    `).all();
    write('certificates.json', { certificates });
  } catch(e) { write('certificates.json', { certificates: [], error: e.message }); }

  // ── AI Prediction ─────────────────────────────────────────────────────
  try {
    const studentRows = db.prepare('SELECT id, name, class, section FROM students ORDER BY class, section, name').all();
    const predictions = studentRows.map(s => {
      const att   = db.prepare("SELECT COUNT(*) AS tot, SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS pres FROM attendance WHERE student_id=?").get(s.id);
      const mrks  = db.prepare('SELECT AVG(CAST(marks AS REAL)*100.0/NULLIF(max_marks,0)) AS avg FROM marks WHERE student_id=?').get(s.id);
      const fees  = db.prepare("SELECT COUNT(*) AS c FROM fees WHERE student_id=? AND status!='Paid'").get(s.id);
      const attPct   = att && att.tot > 0 ? Math.round(att.pres * 100 / att.tot) : 0;
      const marksPct = mrks && mrks.avg != null ? Math.round(mrks.avg) : 0;
      const feesPending = fees ? fees.c : 0;
      const reasons = [];
      if (attPct < 75) reasons.push('Low attendance (' + attPct + '%)');
      if (marksPct < 50) reasons.push('Below average marks (' + marksPct + '%)');
      if (feesPending > 0) reasons.push('Fee dues (' + feesPending + ' unpaid)');
      let level = 'Low';
      if (attPct < 60 || marksPct < 40)      level = 'High';
      else if (attPct < 75 || marksPct < 55)  level = 'Medium';
      const riskScore = Math.round(
        (attPct < 75 ? (75 - attPct) * 0.6 : 0) +
        (marksPct < 60 ? (60 - marksPct) * 0.4 : 0)
      );
      return {
        student_id: s.id, name: s.name, class: s.class, section: s.section,
        attPct, marksPct, feesPending, reasons, level, riskScore,
        prediction: level === 'High' ? 'Needs Intervention' : level === 'Medium' ? 'Monitor Closely' : 'On Track'
      };
    });
    const summary = {
      high: predictions.filter(p => p.level === 'High').length,
      medium: predictions.filter(p => p.level === 'Medium').length,
      low: predictions.filter(p => p.level === 'Low').length
    };
    write('ai-predictions.json', { predictions, summary });
  } catch(e) { write('ai-predictions.json', { predictions: [], summary: { high:0, medium:0, low:0 }, error: e.message }); }

  // ── NEP 2020 ──────────────────────────────────────────────────────────
  try {
    const studentRows = db.prepare('SELECT id AS student_id, name, class FROM students ORDER BY class, name').all();
    const assessments = db.prepare('SELECT * FROM nep_assessments ORDER BY created_at DESC').all();
    write('nep.json', { students: studentRows, assessments });
  } catch(e) { write('nep.json', { students: [], assessments: [], error: e.message }); }

  // ── NAAC Report ───────────────────────────────────────────────────────
  try {
    // Open a fresh connection for NAAC to avoid any shared-db state issues
    const naacDb = new DatabaseSync('/tmp/gurukul_working.db');
    const totalStudents  = naacDb.prepare('SELECT COUNT(*) AS c FROM students').get().c;
    const classes        = naacDb.prepare("SELECT COUNT(DISTINCT class) AS c FROM students").get().c;
    const attRows = naacDb.prepare("SELECT student_id, COUNT(*) AS tot, SUM(CASE WHEN status='P' THEN 1 ELSE 0 END) AS pres FROM attendance GROUP BY student_id").all();
    const avgAttNum = attRows.length > 0
      ? Math.round(attRows.reduce((s, r) => s + (r.tot > 0 ? r.pres * 100 / r.tot : 0), 0) / attRows.length)
      : 0;
    const marksRows     = naacDb.prepare('SELECT marks, max_marks FROM marks').all();
    const avgPerf       = marksRows.length > 0
      ? Math.round(marksRows.reduce((s, r) => s + (r.max_marks > 0 ? r.marks * 100 / r.max_marks : 0), 0) / marksRows.length)
      : 0;
    const examsHeld     = naacDb.prepare("SELECT COUNT(*) AS c FROM exams WHERE status='Completed'").get().c || naacDb.prepare("SELECT COUNT(DISTINCT exam) AS c FROM marks").get().c;
    const feeRows       = naacDb.prepare("SELECT SUM(amount) AS total, SUM(CASE WHEN status='Paid' THEN amount ELSE 0 END) AS paid FROM fees").get();
    const feeTotal      = feeRows && feeRows.total ? feeRows.total : 0;
    const feePaid       = feeRows && feeRows.paid ? feeRows.paid : 0;
    const feeRate       = feeTotal > 0 ? Math.round(feePaid * 100 / feeTotal) + '%' : '0%';
    const admissions    = naacDb.prepare("SELECT COUNT(*) AS c FROM admissions WHERE status IN ('approved','Approved')").get().c;
    const totalApps     = naacDb.prepare('SELECT COUNT(*) AS c FROM admissions').get().c;
    const visitorsCount = naacDb.prepare('SELECT COUNT(*) AS c FROM visitors').get().c;
    const totalTeachers = naacDb.prepare('SELECT COUNT(*) AS c FROM teachers').get().c;
    const totalSupport  = naacDb.prepare('SELECT COUNT(*) AS c FROM support_staff').get().c;
    const totalStaff    = totalTeachers + totalSupport;
    const pendingLeave  = naacDb.prepare("SELECT COUNT(*) AS c FROM leave_applications WHERE status='Pending'").get().c;
    naacDb.close();
    write('naac-report.json', {
      generated_on: new Date().toISOString(),
      school: 'The Gurukul High',
      academic_yr: '2025-26',
      enrollment: {
        total_students: totalStudents,
        total_teachers: totalTeachers,
        total_staff: totalStaff,
        student_teacher_ratio: totalTeachers > 0 ? Math.round(totalStudents / totalTeachers) : totalStudents,
        classes_offered: classes
      },
      academics: {
        avg_attendance: avgAttNum + '%',
        avg_class_performance: avgPerf + '%',
        exams_held: examsHeld
      },
      finance: {
        collection_rate: feeRate,
        fees_collected: feePaid
      },
      hr: { leave_requests_pending: pendingLeave },
      admissions: { total_applications: totalApps },
      visitors: { total_logged: visitorsCount }
    });
  } catch(e) { write('naac-report.json', { error: e.message, generated_on: new Date().toISOString(), school:'The Gurukul High', academic_yr:'2025-26', enrollment:{total_students:0,total_teachers:0,student_teacher_ratio:0,classes_offered:0}, academics:{avg_attendance:'0%',avg_class_performance:'0%',exams_held:0}, finance:{collection_rate:'0%',fees_collected:0}, hr:{leave_requests_pending:0}, admissions:{total_applications:0}, visitors:{total_logged:0} }); }

  // ── Notifications ─────────────────────────────────────────────────────
  try {
    const settings = db.prepare('SELECT * FROM notification_settings WHERE id=1').get() || {};
    write('notifications.json', { settings });
  } catch(e) { write('notifications.json', { settings: {}, error: e.message }); }

  // ── Admissions List ───────────────────────────────────────────────────────
  try {
    const submissions = db.prepare(`SELECT id, submitted_at, status, status_note,
      first_name, last_name, dob, gender, grade_applying, prev_school,
      father_name, father_mobile, father_email, mother_name, mother_mobile,
      address, city, pin FROM admissions ORDER BY submitted_at DESC`).all();
    const mapped = submissions.map(r => ({
      id: r.id, submittedAt: r.submitted_at, status: r.status, statusNote: r.status_note || '',
      studentName: `${r.first_name} ${r.last_name}`.trim(),
      firstName: r.first_name, lastName: r.last_name, dob: r.dob, gender: r.gender,
      gradeApplying: r.grade_applying, prevSchool: r.prev_school || '',
      fatherName: r.father_name, fatherMobile: r.father_mobile, fatherEmail: r.father_email || '',
      motherName: r.mother_name || '', motherMobile: r.mother_mobile || '',
      address: r.address || '', city: r.city || '', pin: r.pin || ''
    }));
    write('admissions.json', { submissions: mapped, total: mapped.length });
  } catch(e) { write('admissions.json', { submissions: [], total: 0, error: e.message }); }

  // ── Admin Stats ───────────────────────────────────────────────────────────
  try {
    const today2 = new Date().toISOString().slice(0, 10);
    const classCounts = db.prepare('SELECT class, section, COUNT(*) as count FROM students GROUP BY class, section ORDER BY class, section').all();
    const attToday    = db.prepare('SELECT COUNT(DISTINCT student_id) as c FROM attendance WHERE date=?').get(today2);
    const pendingAdm  = db.prepare("SELECT COUNT(*) as c FROM admissions WHERE status='Pending Review'").get();
    write('admin-stats.json', {
      students:          db.prepare('SELECT COUNT(*) AS c FROM students').get().c,
      teachers:          db.prepare('SELECT COUNT(*) AS c FROM teachers').get().c,
      attendance:        db.prepare('SELECT COUNT(*) AS c FROM attendance').get().c,
      markedToday:       attToday ? attToday.c : 0,
      marks:             db.prepare('SELECT COUNT(*) AS c FROM marks').get().c,
      fees:              db.prepare('SELECT COUNT(*) AS c FROM fees').get().c,
      admissions:        db.prepare('SELECT COUNT(*) AS c FROM admissions').get().c,
      pendingAdmissions: pendingAdm ? pendingAdm.c : 0,
      classCounts,
    });
  } catch(e) { write('admin-stats.json', { students:0, teachers:0, admissions:0, pendingAdmissions:0, markedToday:0, classCounts:[], error:e.message }); }

  // ── Admin Budget + Budget Overview (shared) ───────────────────────────────
  try {
    const year = new Date().getFullYear().toString();
    function getDeptBudgetSync(deptKey) {
      const row       = db.prepare('SELECT * FROM department_budgets WHERE dept_key=? AND fiscal_year=?').get(deptKey, year);
      const allocated = row ? row.allocated_amount : 0;
      let spent = 0;
      if (deptKey === 'hr') {
        const hrS  = db.prepare("SELECT COALESCE(SUM(net_pay),0) as s FROM payroll_entries WHERE month LIKE ?").get(year + '%');
        const expS = db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM budget_expenses WHERE dept_key=? AND fiscal_year=?").get(deptKey, year);
        spent = (hrS ? hrS.s : 0) + (expS ? expS.s : 0);
      } else {
        const r2 = db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM budget_expenses WHERE dept_key=? AND fiscal_year=?").get(deptKey, year);
        spent = r2 ? r2.s : 0;
      }
      const remaining = allocated - spent;
      const pct_used  = allocated > 0 ? Math.round(spent / allocated * 100) : 0;
      const monthly_expenses = db.prepare("SELECT month, SUM(amount) as total FROM budget_expenses WHERE dept_key=? AND fiscal_year=? GROUP BY month ORDER BY month").all(deptKey, year);
      return {
        dept_key: deptKey,
        dept_name: (row && row.dept_name) || (DEPT_META[deptKey] && DEPT_META[deptKey].name) || deptKey,
        fiscal_year: year, allocated, spent, remaining, pct_used,
        budget_ok: remaining >= 0, monthly_expenses,
      };
    }
    const depts = Object.keys(DEPT_META).map(k => getDeptBudgetSync(k));
    const totalAllocated = depts.reduce((s, d) => s + d.allocated, 0);
    const totalSpent     = depts.reduce((s, d) => s + d.spent, 0);
    const totalRemaining = totalAllocated - totalSpent;
    const overallPct     = totalAllocated > 0 ? Math.round(totalSpent / totalAllocated * 100) : 0;
    const mTotals        = {};
    depts.forEach(d => { (d.monthly_expenses || []).forEach(me => { mTotals[me.month] = (mTotals[me.month] || 0) + me.total; }); });
    const monthly = Object.entries(mTotals).sort(([a],[b]) => a.localeCompare(b)).map(([month, total]) => ({ month, total }));
    const budgetPayload = { year, depts, totalAllocated, totalSpent, totalRemaining, overallPct, monthly };
    write('admin-budget.json', budgetPayload);
    write('budget-overview.json', budgetPayload);
  } catch(e) {
    const empty = { year: new Date().getFullYear().toString(), depts:[], totalAllocated:0, totalSpent:0, totalRemaining:0, overallPct:0, monthly:[], error:e.message };
    write('admin-budget.json', empty);
    write('budget-overview.json', empty);
  }

  // ── Finance Summary ───────────────────────────────────────────────────────
  try {
    const calYear  = new Date().getFullYear().toString();
    const acYear   = (parseInt(calYear) - 1) + '-' + calYear.slice(2); // e.g. 2025-26
    // Match current academic year OR calendar year OR empty
    const yrC = "(academic_yr=? OR academic_yr=? OR academic_yr='' OR academic_yr IS NULL)";
    const byType       = db.prepare(`SELECT fee_type, SUM(amount) AS total, COUNT(*) AS count FROM finance_fees WHERE status IN ('Paid','Partial') AND ${yrC} GROUP BY fee_type ORDER BY total DESC`).all(acYear, calYear);
    const monthlyTrend = db.prepare(`SELECT COALESCE(NULLIF(month,''), LEFT(COALESCE(paid_date::text, recorded_at::text, '2026-01'), 7)) AS mon, SUM(amount) AS total FROM finance_fees WHERE status IN ('Paid','Partial') AND ${yrC} GROUP BY 1 ORDER BY 1`).all(acYear, calYear);
    const outstanding  = db.prepare(`SELECT SUM(amount) AS total FROM finance_fees WHERE status='Pending' AND ${yrC}`).get(acYear, calYear);
    const donationTotal= db.prepare("SELECT SUM(amount) AS total FROM donations WHERE donated_date LIKE ?").get(calYear + '%');
    const byClass      = db.prepare(`SELECT s.class, SUM(f.amount) AS total, COUNT(DISTINCT f.student_id) AS students FROM finance_fees f JOIN students s ON f.student_id=s.id WHERE f.status IN ('Paid','Partial') AND ${yrC} GROUP BY s.class ORDER BY total DESC`).all(acYear, calYear);
    const grandTotal   = db.prepare(`SELECT SUM(amount) AS total FROM finance_fees WHERE status IN ('Paid','Partial') AND ${yrC}`).get(acYear, calYear);
    write('finance-summary.json', {
      year: calYear,
      total_collected:   (grandTotal && grandTotal.total) || 0,
      total_outstanding: (outstanding && outstanding.total) || 0,
      total_donations:   (donationTotal && donationTotal.total) || 0,
      by_type: byType, monthly_trend: monthlyTrend, by_class: byClass,
    });
  } catch(e) { write('finance-summary.json', { year: new Date().getFullYear().toString(), total_collected:0, total_outstanding:0, total_donations:0, by_type:[], monthly_trend:[], by_class:[], error:e.message }); }

  // ── Teacher Profiles (all teachers with assignments + payroll) ────────────
  try {
    const teachers = db.prepare('SELECT id, name, username, email, phone, subject, dob, gender, blood_group, emergency_name, emergency_phone, address, bank_name, account_number, ifsc, account_type, pan, uan, esi_number, employment_type, designation, department, joining_date, status FROM teachers').all();
    const allTeacherData = {};
    teachers.forEach(t => {
      const assignments = db.prepare('SELECT class, section, subject FROM teacher_assignments WHERE teacher_id=?').all(t.id);
      const payStruct   = db.prepare('SELECT * FROM payroll_structures WHERE staff_id=?').get(t.id) || null;
      const payEntries  = db.prepare('SELECT * FROM payroll_entries WHERE staff_id=? ORDER BY month DESC LIMIT 6').all(t.id);
      allTeacherData[t.id] = { ...t, assignments, payroll_structure: payStruct, payroll_entries: payEntries };
    });
    // Also write per-teacher profile files for direct lookup
    Object.entries(allTeacherData).forEach(([id, data]) => {
      write(`teacher-profile-${id}.json`, data);
    });
    write('teacher-profiles.json', allTeacherData);
  } catch(e) { write('teacher-profiles.json', { error: e.message }); }

  // ── Finance Fee Records (all transactions, for Fee Records list) ──────────
  try {
    const calYr = new Date().getFullYear().toString();
    const acYr2 = `${parseInt(calYr)-1}-${calYr.slice(-2)}`;
    const yrC2  = `(f.academic_yr=? OR f.academic_yr=? OR f.academic_yr='' OR f.academic_yr IS NULL)`;
    const feeRecs = db.prepare(`SELECT f.*, s.name AS student_name, s.class, s.section FROM finance_fees f JOIN students s ON f.student_id=s.id WHERE ${yrC2} ORDER BY f.recorded_at DESC`).all(acYr2, calYr);
    write('finance-fee-records.json', { fees: feeRecs, total: feeRecs.length, year: calYr });
  } catch(e) { write('finance-fee-records.json', { fees: [], total: 0, error: e.message }); }

  // ── Finance Fee Defaulters ────────────────────────────────────────────────
  try {
    const calYr = new Date().getFullYear().toString();
    const acYr2 = `${parseInt(calYr)-1}-${calYr.slice(-2)}`;
    const students2 = db.prepare('SELECT id, name, class, section, parent_phone FROM students').all();
    // Expected: use class_fees annual_fee as fallback
    const schedMap = {};
    const fsR = db.prepare(`SELECT class, SUM(amount) as total FROM fee_schedules WHERE academic_yr=? GROUP BY class`).all(calYr);
    if (fsR.length > 0) { fsR.forEach(r => { schedMap[r.class] = r.total; }); }
    else { db.prepare('SELECT class, annual_fee FROM class_fees').all().forEach(r => { schedMap[r.class] = r.annual_fee; }); }
    // Paid: dual format match
    const paidMap2 = {};
    db.prepare(`SELECT student_id, SUM(amount) as paid FROM finance_fees WHERE (academic_yr=? OR academic_yr=? OR academic_yr='' OR academic_yr IS NULL) AND status IN ('Paid','Partial') GROUP BY student_id`).all(acYr2, calYr)
      .forEach(r => { paidMap2[r.student_id] = r.paid; });
    const defaulters2 = [];
    for (const s of students2) {
      const expected = schedMap[s.class] || 0;
      if (expected <= 0) continue;
      const paid2 = paidMap2[s.id] || 0;
      const balance = Math.max(0, expected - paid2);
      if (balance <= 0) continue;
      defaulters2.push({ ...s, expected, paid: paid2, balance });
    }
    defaulters2.sort((a, b) => b.balance - a.balance);
    write('finance-defaulters.json', { defaulters: defaulters2, year: calYr, count: defaulters2.length });
  } catch(e) { write('finance-defaulters.json', { defaulters: [], year: '', count: 0, error: e.message }); }

  // ── Accounting Summary (Company Financials overview) ─────────────────────
  // Helper: compute and write accounting JSON for a given fiscal year
  function writeAccountingForYear(yr) {
    const from  = `${yr}-04-01`;
    const to    = `${parseInt(yr)+1}-03-31`;
    const mFrom = `${yr}-04`;
    const mTo   = `${parseInt(yr)+1}-03`;
    try {
      const feeTotal  = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM finance_fees WHERE status='Paid' AND paid_date>=? AND paid_date<=?`).get(from,to)||{}).s || 0;
      const feePend   = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM finance_fees WHERE status!='Paid' AND paid_date>=? AND paid_date<=?`).get(from,to)||{}).s || 0;
      const donTotal  = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM donations WHERE donated_date>=? AND donated_date<=?`).get(from,to)||{}).s || 0;
      const salaryTot = (db.prepare(`SELECT COALESCE(SUM(net_pay),0) AS s FROM payroll_entries WHERE month>=? AND month<=?`).get(mFrom,mTo)||{}).s || 0;
      const pfTot     = (db.prepare(`SELECT COALESCE(SUM(pf_deduction),0) AS s FROM payroll_entries WHERE month>=? AND month<=?`).get(mFrom,mTo)||{}).s || 0;
      const esiTot    = (db.prepare(`SELECT COALESCE(SUM(esi_deduction),0) AS s FROM payroll_entries WHERE month>=? AND month<=?`).get(mFrom,mTo)||{}).s || 0;
      const manualExp = (() => { try { return (db.prepare(`SELECT COALESCE(SUM(je.debit),0) AS s FROM journal_entries je JOIN chart_of_accounts ca ON je.account_code=ca.code WHERE ca.type='Expense' AND je.source IN ('manual','expense') AND je.date>=? AND je.date<=?`).get(from,to)||{}).s || 0; } catch(_){ return 0; } })();
      const totalIncome  = feeTotal + donTotal;
      const totalExpense = salaryTot + pfTot + esiTot + manualExp;
      const surplus      = totalIncome - totalExpense;
      const monthTrend   = db.prepare(`SELECT strftime('%Y-%m',paid_date) AS m, COALESCE(SUM(amount),0) AS total FROM finance_fees WHERE status='Paid' AND paid_date>=? AND paid_date<=? GROUP BY m ORDER BY m`).all(from,to);
      write(`accounting-summary-${yr}.json`, { feeTotal, feePend, donTotal, salaryTot, pfTot, esiTot, manualExp, totalIncome, totalExpense, surplus, cashBal: surplus, monthTrend, year: yr });
    } catch(e) { write(`accounting-summary-${yr}.json`, { feeTotal:0, feePend:0, donTotal:0, salaryTot:0, pfTot:0, esiTot:0, manualExp:0, totalIncome:0, totalExpense:0, surplus:0, cashBal:0, monthTrend:[], year: yr, error:e.message }); }
    try {
      const feeByType      = db.prepare(`SELECT fee_type, SUM(amount) AS total FROM finance_fees WHERE status='Paid' AND paid_date>=? AND paid_date<=? GROUP BY fee_type ORDER BY total DESC`).all(from,to);
      const donations      = (db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM donations WHERE donated_date>=? AND donated_date<=?`).get(from,to)||{}).total || 0;
      const salaryByMonth  = db.prepare(`SELECT month, SUM(net_pay) AS total FROM payroll_entries WHERE month>=? AND month<=? GROUP BY month ORDER BY month`).all(mFrom,mTo);
      const pfPaid         = (db.prepare(`SELECT COALESCE(SUM(pf_deduction),0) AS total FROM payroll_entries WHERE month>=? AND month<=?`).get(mFrom,mTo)||{}).total || 0;
      const esiPaid        = (db.prepare(`SELECT COALESCE(SUM(esi_deduction),0) AS total FROM payroll_entries WHERE month>=? AND month<=?`).get(mFrom,mTo)||{}).total || 0;
      const manualReceipts = (() => { try { return db.prepare(`SELECT je.account_code, ca.name, SUM(je.credit) AS total FROM journal_entries je JOIN chart_of_accounts ca ON je.account_code=ca.code WHERE ca.type='Income' AND je.source IN ('manual','expense') AND je.date>=? AND je.date<=? GROUP BY je.account_code`).all(from,to); } catch(_){ return []; } })();
      const manualPayments = (() => { try { return db.prepare(`SELECT je.account_code, ca.name, SUM(je.debit) AS total FROM journal_entries je JOIN chart_of_accounts ca ON je.account_code=ca.code WHERE ca.type='Expense' AND je.source IN ('manual','expense') AND je.date>=? AND je.date<=? GROUP BY je.account_code`).all(from,to); } catch(_){ return []; } })();
      write(`accounting-receipts-${yr}.json`, { feeByType, donations, manualReceipts, salaryByMonth, pfPaid, esiPaid, manualPayments, year: yr });
    } catch(e) { write(`accounting-receipts-${yr}.json`, { feeByType:[], donations:0, manualReceipts:[], salaryByMonth:[], pfPaid:0, esiPaid:0, manualPayments:[], year: yr, error:e.message }); }
  }

  // ── Accounting Summary + Receipts (year-specific files) ──────────────────
  try {
    // FY starts April: if Jan–Mar use prev year (e.g. Mar 2026 → FY 2025-26 → year=2025)
    const _now1  = new Date();
    const curFY  = (_now1.getMonth() >= 3 ? _now1.getFullYear() : _now1.getFullYear() - 1).toString();
    // Generate current FY + previous FY (for year-selector history)
    writeAccountingForYear(curFY);
    writeAccountingForYear((parseInt(curFY) - 1).toString());
  } catch(e) { /* silently skip on outer error */ }

  // ── Accounting Chart of Accounts (year-independent) ──────────────────────
  try {
    let coaRows = [];
    try { coaRows = db.prepare('SELECT * FROM chart_of_accounts ORDER BY code').all(); } catch(_) {}
    write('accounting-coa.json', { accounts: coaRows });
  } catch(e) { write('accounting-coa.json', { accounts: [], error: e.message }); }

  // ── HR Overview ───────────────────────────────────────────────────────────
  try {
    const hrToday     = new Date().toISOString().slice(0, 10);
    const hrThisMonth = hrToday.slice(0, 7);
    const hrYear      = hrToday.slice(0, 4);
    const totalTeachers   = (db.prepare("SELECT COUNT(*) as c FROM teachers WHERE status='Active'").get() || {}).c || 0;
    const totalSupport    = (db.prepare("SELECT COUNT(*) as c FROM support_staff WHERE status='Active'").get() || {}).c || 0;
    const presentToday    = (db.prepare('SELECT COUNT(*) as c FROM teacher_checkins WHERE date=?').get(hrToday) || {}).c || 0;
    const pendingLeaves   = (db.prepare("SELECT COUNT(*) as c FROM leave_applications WHERE status='Pending'").get() || {}).c || 0;
    const openJobs        = (db.prepare("SELECT COUNT(*) as c FROM job_postings WHERE status='Open'").get() || {}).c || 0;
    const newApplications = (db.prepare("SELECT COUNT(*) as c FROM job_applications WHERE status='Applied'").get() || {}).c || 0;
    const payrollRow      = db.prepare("SELECT COALESCE(SUM(net_pay),0) as total FROM payroll_entries WHERE month=?").get(hrThisMonth) || { total: 0 };
    const deptTeachers    = db.prepare("SELECT department, COUNT(*) as count FROM teachers WHERE status='Active' GROUP BY department ORDER BY count DESC").all();
    const deptSupport     = db.prepare("SELECT department, COUNT(*) as count FROM support_staff WHERE status='Active' GROUP BY department ORDER BY count DESC").all();
    const recentLeaves    = db.prepare("SELECT id, person_name, leave_type, from_date, to_date, days, reason, status, applied_at FROM leave_applications ORDER BY applied_at DESC LIMIT 8").all();
    const hrBudgetRow     = db.prepare("SELECT * FROM hr_budget WHERE fiscal_year=?").get(hrYear) || { allocated_amount: 0 };
    const hrUsed          = (db.prepare("SELECT COALESCE(SUM(net_pay),0) as total FROM payroll_entries WHERE month LIKE ?").get(hrYear + '%') || {}).total || 0;
    const hrBudget        = {
      fiscal_year: hrYear, allocated: hrBudgetRow.allocated_amount, used: Math.round(hrUsed),
      remaining: Math.round(hrBudgetRow.allocated_amount - hrUsed),
      pct_used: hrBudgetRow.allocated_amount > 0 ? Math.round(hrUsed / hrBudgetRow.allocated_amount * 100) : 0,
    };
    write('hr-overview.json', {
      totalStaff: totalTeachers + totalSupport, totalTeachers, totalSupport,
      presentToday, pendingLeaves, openJobs, newApplications,
      payrollThisMonth: payrollRow.total,
      deptTeachers, deptSupport, recentLeaves, budget: hrBudget,
    });
  } catch(e) { write('hr-overview.json', { totalStaff:0, totalTeachers:0, totalSupport:0, presentToday:0, pendingLeaves:0, openJobs:0, newApplications:0, payrollThisMonth:0, deptTeachers:[], deptSupport:[], recentLeaves:[], budget:{}, error:e.message }); }

  // ── Marketing Overview ────────────────────────────────────────────────────
  try {
    const mktToday        = new Date().toISOString().slice(0, 10);
    const totalLeads      = db.prepare('SELECT COUNT(*) AS c FROM marketing_leads').get().c;
    const todayLeads      = db.prepare('SELECT COUNT(*) AS c FROM marketing_leads WHERE created_at LIKE ?').get(mktToday + '%').c;
    const enrolled        = db.prepare("SELECT COUNT(*) AS c FROM marketing_leads WHERE stage='Enrolled'").get().c;
    const activeCampaigns = db.prepare("SELECT COUNT(*) AS c FROM marketing_campaigns WHERE status='Active'").get().c;
    const upcomingEvents  = db.prepare("SELECT COUNT(*) AS c FROM marketing_events WHERE status='Upcoming'").get().c;
    const reachRow        = db.prepare("SELECT COALESCE(SUM(reach),0) AS s FROM marketing_campaigns").get();
    const convRow         = db.prepare("SELECT COALESCE(SUM(conversions),0) AS s FROM marketing_campaigns").get();
    const totalReach      = reachRow ? reachRow.s : 0;
    const totalConv       = convRow  ? convRow.s  : 0;
    const conversionRate  = totalReach > 0 ? Math.round((totalConv / totalReach) * 100) : 0;
    const stageRows       = db.prepare("SELECT stage, COUNT(*) AS c FROM marketing_leads GROUP BY stage").all();
    const sourceRows      = db.prepare("SELECT source, COUNT(*) AS c FROM marketing_leads GROUP BY source ORDER BY c DESC LIMIT 6").all();
    const recentLeads     = db.prepare("SELECT * FROM marketing_leads ORDER BY id DESC LIMIT 5").all();
    write('marketing-overview.json', {
      totalLeads, todayLeads, enrolled, activeCampaigns, upcomingEvents,
      totalReach, conversionRate, stageRows, sourceRows, recentLeads,
    });
  } catch(e) { write('marketing-overview.json', { totalLeads:0, todayLeads:0, enrolled:0, activeCampaigns:0, upcomingEvents:0, totalReach:0, conversionRate:0, stageRows:[], sourceRows:[], recentLeads:[], error:e.message }); }

  // ── Parent Dashboard Data (demo student STU005 – Kiran Patel) ────────────────
  try {
    const DEMO_STU = 'STU005';
    // Profile
    const stu = db.prepare('SELECT * FROM students WHERE id=?').get(DEMO_STU) || {};
    write('parent-profile.json', { student: {
      id: stu.id, name: stu.name, class: stu.class, section: stu.section,
      dob: stu.dob, parent_name: stu.parent_name, parent_phone: stu.parent_phone, email: stu.email || ''
    }});

    // Fees
    const feeRows = db.prepare('SELECT * FROM finance_fees WHERE student_id=? ORDER BY recorded_at DESC').all(DEMO_STU);
    const fTotal = feeRows.reduce((a,f)=>a+f.amount,0);
    const fPaid  = feeRows.filter(f=>f.status==='Paid').reduce((a,f)=>a+f.amount,0);
    const fPend  = feeRows.filter(f=>f.status==='Pending'||f.status==='Partial').reduce((a,f)=>a+f.amount,0);
    const instRows = db.prepare('SELECT * FROM fee_installments WHERE student_id=? ORDER BY installment_no').all(DEMO_STU);
    write('parent-fees.json', { fees: feeRows, installments: instRows, summary: { total: fTotal, paid: fPaid, pending: fPend }});

    // Attendance – current month + summary
    const nowStr = new Date().toISOString().substring(0,7); // e.g. "2026-03"
    const attRows = db.prepare("SELECT * FROM attendance WHERE student_id=? AND date LIKE ? ORDER BY date DESC").all(DEMO_STU, nowStr+'%');
    const attAll = db.prepare("SELECT * FROM attendance WHERE student_id=? ORDER BY date DESC LIMIT 180").all(DEMO_STU);
    const present = attRows.filter(r=>r.status==='P'||r.status==='Present').length;
    const absent  = attRows.filter(r=>r.status==='A'||r.status==='Absent').length;
    const leave   = attRows.filter(r=>r.status==='L'||r.status==='Leave').length;
    const total   = attRows.length;
    const pctNum  = total > 0 ? Math.round((present/total)*100) : 0;
    // Overall attendance for overview
    const pAll = attAll.filter(r=>r.status==='P'||r.status==='Present').length;
    const pctAll = attAll.length > 0 ? Math.round((pAll/attAll.length)*100) : 0;
    write('parent-attendance.json', {
      attendance: attRows, allAttendance: attAll,
      summary: { present, absent, leave, total_days: total, pct: pctNum, percentage: pctNum+'%', pctAll }
    });

    // Marks
    const markRows = db.prepare('SELECT * FROM marks WHERE student_id=? ORDER BY subject, date').all(DEMO_STU);
    const subjectCount = [...new Set(markRows.map(m=>m.subject))].length;
    write('parent-marks.json', { marks: markRows, subjectCount });

    // Performance – average per subject
    const subjs = [...new Set(markRows.map(m=>m.subject))];
    const subjPerf = subjs.map(sub => {
      const subMarks = markRows.filter(m=>m.subject===sub);
      const totM = subMarks.reduce((a,m)=>a+m.marks,0);
      const totMax = subMarks.reduce((a,m)=>a+m.max_marks,0);
      const avg = totMax > 0 ? Math.round((totM/totMax)*100) : 0;
      return { subject: sub, avg_pct: avg, total_marks: totM, max_marks: totMax, exams: subMarks.map(m=>({exam:m.exam,date:m.date,marks:m.marks,max:m.max_marks})) };
    });
    const overallPct = subjPerf.length > 0 ? Math.round(subjPerf.reduce((a,s)=>a+s.avg_pct,0)/subjPerf.length) : 0;
    write('parent-performance.json', { subjects: subjPerf, overallPct });

    // Calendar & Holidays
    const calRows = db.prepare("SELECT * FROM academic_calendar WHERE is_active=1 ORDER BY start_date ASC").all();
    write('parent-calendar.json', { events: calRows });
    const holRows = db.prepare("SELECT * FROM holidays ORDER BY date ASC LIMIT 40").all();
    write('parent-holidays.json', { holidays: holRows });

  } catch(e) {
    write('parent-profile.json', { student: {}, error: e.message });
    write('parent-fees.json', { fees: [], installments: [], summary: { total:0, paid:0, pending:0 }, error: e.message });
    write('parent-attendance.json', { attendance: [], allAttendance: [], summary: { present:0, absent:0, leave:0, total_days:0, pct:0, percentage:'0%', pctAll:0 }, error: e.message });
    write('parent-marks.json', { marks: [], subjectCount: 0, error: e.message });
    write('parent-performance.json', { subjects: [], overallPct: 0, error: e.message });
    write('parent-calendar.json', { events: [], error: e.message });
    write('parent-holidays.json', { holidays: [], error: e.message });
  }

  console.log(`[SYNC] portal/data/*.json refreshed at ${new Date().toLocaleTimeString()}`);
}

// ── Command queue: server polls portal/data/cmd-in.json ──────────────────────
function watchCommandQueue(db) {
  const cmdFile    = path.join(DATA_DIR, 'cmd-in.json');
  const resultFile = path.join(DATA_DIR, 'cmd-out.json');
  let lastMtime = 0;

  setInterval(() => {
    try {
      if (!fs.existsSync(cmdFile)) return;
      const stat = fs.statSync(cmdFile);
      if (stat.mtimeMs <= lastMtime) return;
      lastMtime = stat.mtimeMs;

      const cmd = JSON.parse(fs.readFileSync(cmdFile, 'utf8'));
      console.log('[CMD]', cmd.type, JSON.stringify(cmd.data || {}).slice(0, 120));

      const result = processCommand(db, cmd);
      fs.writeFileSync(resultFile, JSON.stringify({ ok: true, result, ts: Date.now() }));
      syncAll(db);
    } catch(e) {
      try { fs.writeFileSync(resultFile, JSON.stringify({ ok: false, error: e.message, ts: Date.now() })); } catch(_) {}
      console.error('[CMD] error:', e.message);
    }
  }, 400);
}

function processCommand(db, cmd) {
  const d = cmd.data || {};
  switch (cmd.type) {
    case 'addBook':
      return db.prepare(`INSERT INTO library_books (title,author,isbn,category,total_copies,available,rack,added_on) VALUES (?,?,?,?,?,?,?,datetime('now','localtime'))`)
        .run(d.title, d.author || '', d.isbn || '', d.category || 'General', d.total_copies || 1, d.total_copies || 1, d.rack || 'A1');

    case 'issueBook': {
      db.prepare('UPDATE library_books SET available=available-1 WHERE id=? AND available>0').run(d.book_id);
      return db.prepare(`INSERT INTO book_loans (book_id,borrower_id,borrower_type,status,issued_on,due_date) VALUES (?,?,?,'Issued',datetime('now','localtime'),?)`)
        .run(d.book_id, d.borrower_id, d.borrower_type || 'student', d.due_date);
    }
    case 'returnBook': {
      const loan = db.prepare('SELECT * FROM book_loans WHERE id=?').get(d.loan_id);
      if (!loan) throw new Error('Loan not found');
      db.prepare("UPDATE book_loans SET status='Returned', returned_on=datetime('now','localtime') WHERE id=?").run(d.loan_id);
      db.prepare('UPDATE library_books SET available=available+1 WHERE id=?').run(loan.book_id);
      return { returned: true };
    }
    case 'addHomework':
      return db.prepare(`INSERT INTO homework (title,subject,class,section,assigned_by,description,due_date,created_at) VALUES (?,?,?,?,?,?,?,datetime('now','localtime'))`)
        .run(d.title, d.subject, d.class, d.section || 'All', d.assigned_by || 'Teacher', d.description || '', d.due_date);

    case 'deleteHomework':
      return db.prepare('DELETE FROM homework WHERE id=?').run(d.id);

    case 'addRoute':
      return db.prepare(`INSERT INTO transport_routes (route_name,driver,vehicle,capacity,stops,departure,arrival) VALUES (?,?,?,?,?,?,?)`)
        .run(d.route_name, d.driver || '', d.vehicle || '', d.capacity || 40, JSON.stringify(d.stops || []), d.departure || '07:00', d.arrival || '08:00');

    case 'deleteRoute':
      return db.prepare('DELETE FROM transport_routes WHERE id=?').run(d.id);

    case 'assignTransportStudent':
      return db.prepare('INSERT OR REPLACE INTO transport_students (student_id,route_id,stop,fee) VALUES (?,?,?,?)')
        .run(d.student_id, d.route_id, d.stop || '', d.fee || 0);

    case 'checkInVisitor':
      return db.prepare(`INSERT INTO visitors (name,phone,purpose,whom_to_meet,entry_time,status) VALUES (?,?,?,?,datetime('now','localtime'),'In')`)
        .run(d.name, d.phone || '', d.purpose || '', d.whom_to_meet || '');

    case 'checkOutVisitor':
      return db.prepare("UPDATE visitors SET status='Out', exit_time=datetime('now','localtime') WHERE id=?").run(d.id);

    case 'issueCertificate':
      return db.prepare(`INSERT INTO certificates (student_id,type,content,issued_by,issued_on,serial_no) VALUES (?,?,?,?,datetime('now','localtime'),?)`)
        .run(d.student_id, d.type || 'Bonafide', d.content || '', d.issued_by || 'Principal', d.serial_no || 'CERT-' + Date.now());

    case 'saveNepAssessment':
      return db.prepare(`INSERT OR REPLACE INTO nep_assessments (student_id,class,term,academic_yr,cognitive,affective,psychomotor,sports,arts,community,teacher_note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`)
        .run(d.student_id, d.class || '', d.term || 'Term-1', d.academic_yr || '2025-26', d.cognitive || 0, d.affective || 0, d.psychomotor || 0, d.sports || '', d.arts || '', d.community || '', d.teacher_note || '');

    case 'saveNotifSettings':
      return db.prepare(`UPDATE notification_settings SET provider=?, api_key=?, sender=?, enabled=?, wa_token=?, wa_phone=?, updated_at=datetime('now','localtime') WHERE id=1`)
        .run(d.provider || 'msg91', d.api_key || '', d.sender || 'GURUKL', d.enabled ? 1 : 0, d.wa_token || '', d.wa_phone || '');

    default:
      throw new Error('Unknown command: ' + cmd.type);
  }
}

module.exports = { syncAll, watchCommandQueue };
