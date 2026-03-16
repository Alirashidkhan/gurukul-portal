#!/usr/bin/env node
/**
 * seed-production.js
 * Seeds all missing production data into Neon PostgreSQL.
 * Safe to run multiple times (uses INSERT ... ON CONFLICT DO NOTHING).
 */
'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function q(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

async function main() {
  console.log('🌱 Starting production seed...');

  // ── TEACHERS ─────────────────────────────────────────────────────────────
  const teachers = [
    ['TCH001','Rajesh Kumar','rajesh.kumar','teacher123','Mathematics','MSc Mathematics, BEd','Male','9845001001','rajesh.kumar@gurukulhigh.edu','2019-06-01','Active',42000],
    ['TCH002','Priya Sharma','priya.sharma','teacher123','Science','MSc Physics, BEd','Female','9845001002','priya.sharma@gurukulhigh.edu','2020-07-15','Active',40000],
    ['TCH003','Suresh Nair','suresh.nair','teacher123','English','MA English, BEd','Male','9845001003','suresh.nair@gurukulhigh.edu','2018-04-01','Active',38000],
    ['TCH004','Anitha Rao','anitha.rao','teacher123','Social Studies','MA History, BEd','Female','9845001004','anitha.rao@gurukulhigh.edu','2021-06-01','Active',36000],
    ['TCH005','Vikram Shetty','vikram.shetty','teacher123','Kannada','MA Kannada, BEd','Male','9845001005','vikram.shetty@gurukulhigh.edu','2022-01-10','Active',35000],
    ['TCH006','Meena Pillai','meena.pillai','teacher123','Hindi','MA Hindi, BEd','Female','9845001006','meena.pillai@gurukulhigh.edu','2020-08-01','Active',35000],
    ['TCH007','Arun Menon','arun.menon','teacher123','Physical Education','BPEd','Male','9845001007','arun.menon@gurukulhigh.edu','2019-06-01','Active',32000],
    ['TCH008','Deepa Krishnan','deepa.krishnan','teacher123','Computer Science','MCA, BEd','Female','9845001008','deepa.krishnan@gurukulhigh.edu','2021-03-15','Active',40000],
  ];
  for (const [id,name,uname,pwd,subj,qual,gender,phone,email,join_date,status,salary] of teachers) {
    await q(`INSERT INTO teachers (id,name,username,password,subject,qualifications,gender,phone,email,join_date,status,base_salary)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (id) DO NOTHING`, [id,name,uname,pwd,subj,qual,gender,phone,email,join_date,status,salary]);
  }
  console.log('✅ Teachers seeded');

  // ── TEACHER ASSIGNMENTS ───────────────────────────────────────────────────
  const assignments = [
    ['TCH001','6','A','Mathematics'],['TCH001','7','A','Mathematics'],['TCH001','8','A','Mathematics'],
    ['TCH002','6','A','Science'],['TCH002','7','A','Science'],['TCH002','8','A','Science'],
    ['TCH003','6','A','English'],['TCH003','7','A','English'],['TCH003','8','A','English'],
    ['TCH004','6','A','Social Studies'],['TCH004','7','A','Social Studies'],
    ['TCH005','6','A','Kannada'],['TCH005','7','A','Kannada'],
    ['TCH006','6','A','Hindi'],['TCH006','7','A','Hindi'],
    ['TCH007','6','A','Physical Education'],['TCH007','7','A','Physical Education'],
    ['TCH008','8','A','Computer Science'],
  ];
  for (const [tid,cls,sec,subj] of assignments) {
    await q(`INSERT INTO teacher_assignments (teacher_id,class,section,subject)
             VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tid,cls,sec,subj]);
  }
  console.log('✅ Teacher assignments seeded');

  // ── PAYROLL ENTRIES ───────────────────────────────────────────────────────
  const months = ['2025-06','2025-07','2025-08','2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03'];
  for (const [tid,,,,,,,,,,, salary] of teachers) {
    for (const month of months) {
      const gross = salary;
      const pf = Math.round(gross * 0.12);
      const tax = Math.round(gross * 0.05);
      const net = gross - pf - tax;
      await q(`INSERT INTO payroll_entries (teacher_id, month, base_salary, gross_pay, deductions, net_pay, status, paid_date)
               VALUES ($1,$2,$3,$4,$5,$6,'Paid',$7) ON CONFLICT DO NOTHING`,
        [tid, month, salary, gross, pf+tax, net, month+'-01']);
    }
  }
  console.log('✅ Payroll entries seeded');

  // ── FINANCE FEES ──────────────────────────────────────────────────────────
  // Get student IDs
  const studRes = await q(`SELECT id, class FROM students LIMIT 50`);
  const students = studRes.rows;

  const feeTypes = ['Tuition Fee','Exam Fee','Library Fee','Sports Fee','Lab Fee','Transport Fee'];
  const feeAmounts = { 'Tuition Fee': 8500, 'Exam Fee': 1200, 'Library Fee': 500, 'Sports Fee': 800, 'Lab Fee': 600, 'Transport Fee': 1500 };
  const feeMonths = ['2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10','2026-11','2026-12','2026-01','2026-02','2026-03'];

  let feeCount = 0;
  for (const stu of students) {
    for (const ft of feeTypes) {
      const amt = feeAmounts[ft];
      const month = feeMonths[Math.floor(Math.random() * feeMonths.length)];
      const status = Math.random() > 0.15 ? 'Paid' : 'Pending';
      const paid_date = status === 'Paid' ? `2026-0${Math.floor(Math.random()*9)+1}-${String(Math.floor(Math.random()*28)+1).padStart(2,'0')}` : '';
      const receipt = status === 'Paid' ? `RCP${String(Math.floor(Math.random()*90000)+10000)}` : '';
      await q(`INSERT INTO finance_fees (student_id, fee_type, amount, academic_yr, month, paid_date, status, payment_mode, receipt_no, recorded_at)
               VALUES ($1,$2,$3,'2025-26',$4,$5,$6,'Cash',$7,NOW()) ON CONFLICT DO NOTHING`,
        [stu.id, ft, amt, month, paid_date, status, receipt]);
      feeCount++;
    }
  }
  console.log(`✅ Finance fees seeded (${feeCount} records)`);

  // ── DONATIONS ─────────────────────────────────────────────────────────────
  const donors = [
    ['Ramesh Gowda','9900001001','ramesh@gmail.com',25000,'Infrastructure','Cheque','2026-01-15'],
    ['Sujatha Rao','9900001002','sujatha@gmail.com',10000,'Scholarship','Online','2026-02-20'],
    ['Karnataka Merchants Association','9900001003','kma@email.com',50000,'Library','NEFT','2026-01-05'],
    ['Alumni Association 2010','9900001004','alumni@gurukulhigh.edu',30000,'Sports','Cheque','2026-03-01'],
    ['Prakash Industries','9900001005','info@prakash.com',75000,'General','NEFT','2025-12-10'],
    ['Lakshmi Narayan Trust','9900001006','trust@email.com',15000,'Scholarship','Cash','2026-02-14'],
    ['Dr. Vijay Kumar','9900001007','vijay@hospital.com',20000,'Lab Equipment','Cheque','2026-01-22'],
    ['Mysuru Lions Club','9900001008','lions@mysuru.com',35000,'Infrastructure','NEFT','2025-11-30'],
  ];
  for (const [donor_name, donor_phone, donor_email, amount, purpose, payment_mode, donated_date] of donors) {
    await q(`INSERT INTO donations (donor_name, donor_phone, donor_email, amount, purpose, payment_mode, receipt_no, donated_date, recorded_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT DO NOTHING`,
      [donor_name, donor_phone, donor_email, amount, purpose, payment_mode,
       'DON'+String(Math.floor(Math.random()*90000)+10000), donated_date]);
  }
  console.log('✅ Donations seeded');

  // ── DEPARTMENT BUDGETS ────────────────────────────────────────────────────
  const depts = [
    ['academics','Academics','2026',800000,320000],
    ['admin','Administration','2026',500000,210000],
    ['sports','Sports & PE','2026',300000,95000],
    ['library','Library','2026',150000,62000],
    ['lab','Science Lab','2026',250000,110000],
    ['transport','Transport','2026',400000,185000],
    ['maintenance','Maintenance','2026',200000,88000],
    ['marketing','Marketing','2026',180000,75000],
  ];
  for (const [dept_key, dept_name, fiscal_year, allocated, spent_ytd] of depts) {
    await q(`INSERT INTO department_budgets (dept_key, dept_name, fiscal_year, allocated, spent_ytd)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (dept_key, fiscal_year) DO UPDATE SET allocated=EXCLUDED.allocated, spent_ytd=EXCLUDED.spent_ytd`,
      [dept_key, dept_name, fiscal_year, allocated, spent_ytd]);
  }
  console.log('✅ Department budgets seeded');

  // ── BUDGET EXPENSES ────────────────────────────────────────────────────────
  const expenseData = [
    ['academics','Salaries','2026-01',280000],['academics','Books & Materials','2026-02',25000],['academics','Training','2026-03',15000],
    ['admin','Office Supplies','2026-01',18000],['admin','Utilities','2026-02',45000],['admin','Maintenance','2026-03',22000],
    ['sports','Equipment','2026-01',30000],['sports','Tournament Fees','2026-02',15000],['sports','Uniforms','2026-03',20000],
    ['library','New Books','2026-01',25000],['library','Digital Resources','2026-02',18000],['library','Repairs','2026-03',9000],
    ['lab','Chemicals','2026-01',35000],['lab','Equipment','2026-02',42000],['lab','Safety Gear','2026-03',8000],
    ['marketing','Events','2026-01',20000],['marketing','Printing','2026-02',15000],['marketing','Social Media','2026-03',10000],
  ];
  for (const [dept_key, description, month, amount] of expenseData) {
    await q(`INSERT INTO budget_expenses (dept_key, description, amount, month, fiscal_year, recorded_at)
             VALUES ($1,$2,$3,$4,'2026',NOW()) ON CONFLICT DO NOTHING`,
      [dept_key, description, amount, month]);
  }
  console.log('✅ Budget expenses seeded');

  // ── HR BUDGET ────────────────────────────────────────────────────────────
  await q(`INSERT INTO hr_budget (fiscal_year, total_budget, salary_allocated, benefits_allocated, recruitment_allocated, training_allocated, used_salary, used_benefits, used_recruitment, used_training)
           VALUES ('2026', 5000000, 3500000, 500000, 300000, 200000, 3200000, 420000, 180000, 95000)
           ON CONFLICT (fiscal_year) DO UPDATE SET
             total_budget=EXCLUDED.total_budget, salary_allocated=EXCLUDED.salary_allocated,
             used_salary=EXCLUDED.used_salary`);
  console.log('✅ HR budget seeded');

  // ── JOB POSTINGS ─────────────────────────────────────────────────────────
  const jobs = [
    ['Mathematics Teacher','Teaching','Full-time','MSc Mathematics, BEd required. Min 2 years exp.','2026-04-30','Open'],
    ['Administrative Assistant','Admin','Full-time','Graduate with computer skills.','2026-03-31','Open'],
    ['Lab Assistant','Science','Part-time','BSc with lab experience.','2026-04-15','Open'],
  ];
  for (const [title, department, type, description, deadline, status] of jobs) {
    await q(`INSERT INTO job_postings (title, department, type, description, deadline, status, posted_at)
             VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT DO NOTHING`,
      [title, department, type, description, deadline, status]);
  }
  console.log('✅ Job postings seeded');

  // ── MARKETING DATA ────────────────────────────────────────────────────────
  const leads = [
    ['Arun Kumar','Parent','9901001001','arun.k@gmail.com','Grade 6','2026-01-10','New','Facebook Ad'],
    ['Sunitha Bhat','Parent','9901001002','sunitha@gmail.com','Grade 7','2026-01-15','Contacted','WhatsApp'],
    ['Mohan Rao','Parent','9901001003','mohan@email.com','Grade 8','2026-02-01','Visited','Walk-in'],
    ['Kavitha Menon','Parent','9901001004','kavitha@gmail.com','Grade 6','2026-02-10','Enrolled','Instagram'],
    ['Ravi Shankar','Parent','9901001005','ravi@gmail.com','Grade 9','2026-02-20','New','Google Ads'],
    ['Usha Srinivas','Parent','9901001006','usha@gmail.com','Grade 7','2026-03-01','Contacted','Referral'],
  ];
  for (const [name, lead_type, phone, email, interested_class, lead_date, status, source] of leads) {
    await q(`INSERT INTO marketing_leads (name, lead_type, phone, email, interested_class, lead_date, status, source, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT DO NOTHING`,
      [name, lead_type, phone, email, interested_class, lead_date, status, source]);
  }

  const campaigns = [
    ['Admissions 2026-27','Admissions','2026-01-01','2026-03-31','Active',50000,32000,450,120,'Google Ads, Social Media'],
    ['Alumni Donation Drive','Fundraising','2026-02-01','2026-02-28','Completed',15000,14200,800,65,'Email, WhatsApp'],
    ['Annual Day Promotion','Events','2026-03-01','2026-03-15','Active',20000,8500,1200,300,'Social Media, Posters'],
  ];
  for (const [name, type, start_date, end_date, status, budget, spent, reach, conversions, channels] of campaigns) {
    await q(`INSERT INTO marketing_campaigns (name, type, start_date, end_date, status, budget, spent, reach, conversions, channels, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) ON CONFLICT DO NOTHING`,
      [name, type, start_date, end_date, status, budget, spent, reach, conversions, channels]);
  }
  console.log('✅ Marketing data seeded');

  // ── ACCOUNTING / JOURNAL ENTRIES ───────────────────────────────────────────
  const journals = [
    ['2026-01-01','Fee Collection - January','revenue','1001',120000,'Fee Revenue'],
    ['2026-01-01','Fee Collection - January','asset','2001',120000,'Cash Account'],
    ['2026-02-01','Fee Collection - February','revenue','1001',135000,'Fee Revenue'],
    ['2026-02-01','Fee Collection - February','asset','2001',135000,'Cash Account'],
    ['2026-03-01','Salary Disbursement - March','expense','3001',280000,'Salary Expense'],
    ['2026-03-01','Salary Disbursement - March','liability','4001',280000,'Bank Account'],
    ['2026-01-15','Donation Received','asset','2001',25000,'Cash Account'],
    ['2026-01-15','Donation Received','equity','5001',25000,'Donation Income'],
    ['2026-02-10','Lab Equipment Purchase','expense','3002',42000,'Lab Expense'],
    ['2026-02-10','Lab Equipment Purchase','liability','4001',42000,'Bank Account'],
  ];
  for (const [entry_date, description, account_type, account_code, amount, narration] of journals) {
    await q(`INSERT INTO journal_entries (entry_date, description, account_type, account_code, amount, narration, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT DO NOTHING`,
      [entry_date, description, account_type, account_code, amount, narration]);
  }
  console.log('✅ Journal entries seeded');

  // ── SECURITY EVENTS ───────────────────────────────────────────────────────
  const secEvents = [
    ['login_success','admin','127.0.0.1','admin','Admin login','info'],
    ['login_success','teacher','127.0.0.1','rajesh.kumar','Teacher login','info'],
    ['login_failed','admin','192.168.1.50','unknown','Failed login attempt','warning'],
    ['data_export','finance','127.0.0.1','finance','Fee records exported','info'],
    ['password_change','admin','127.0.0.1','priya.sharma','Password changed','info'],
    ['unusual_access','monitor','10.0.0.5','unknown','Multiple failed attempts','high'],
  ];
  for (const [event_type, dashboard, ip, username, details, severity] of secEvents) {
    await q(`INSERT INTO security_events (event_type, dashboard, ip, username, details, severity, timestamp)
             VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT DO NOTHING`,
      [event_type, dashboard, ip, username, details, severity]);
  }
  console.log('✅ Security events seeded');

  // ── ANNOUNCEMENTS ──────────────────────────────────────────────────────────
  const announcements = [
    ['Annual Day 2026','The Annual Day celebration will be held on 25th March 2026. All students must attend in formal uniform.','general','admin','2026-03-25'],
    ['Exam Schedule Released','Final examinations for all classes will commence from April 5, 2026. Timetable available on notice board.','academic','admin','2026-04-05'],
    ['Fee Reminder','Last date for term fee payment is March 31, 2026. Late fee will be charged after the due date.','finance','admin','2026-03-31'],
    ['Holiday Notice','School will remain closed on March 22 for Ugadi festival. Classes resume on March 24.','general','admin','2026-03-22'],
  ];
  for (const [title, body, type, created_by, scheduled_for] of announcements) {
    await q(`INSERT INTO announcements (title, body, type, created_by, scheduled_for, created_at)
             VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT DO NOTHING`,
      [title, body, type, created_by, scheduled_for]);
  }
  console.log('✅ Announcements seeded');

  // ── LEAVES ────────────────────────────────────────────────────────────────
  const leaves = [
    ['TCH002','Sick Leave','2026-03-10','2026-03-11','2','Fever and cold','Approved','admin','2026-03-09'],
    ['TCH004','Personal Leave','2026-03-05','2026-03-05','1','Family function','Approved','admin','2026-03-04'],
    ['TCH006','Casual Leave','2026-03-18','2026-03-18','1','Personal work','Pending',null,null],
    ['TCH001','Medical Leave','2026-02-20','2026-02-22','3','Hospitalization','Approved','admin','2026-02-19'],
    ['TCH007','Casual Leave','2026-03-20','2026-03-20','1','Personal work','Pending',null,null],
    ['TCH003','Casual Leave','2026-03-25','2026-03-25','1','Personal work','Pending',null,null],
    ['TCH005','Sick Leave','2026-03-12','2026-03-12','1','Not well','Approved','admin','2026-03-11'],
    ['TCH008','Personal Leave','2026-03-28','2026-03-28','1','Family function','Pending',null,null],
  ];
  for (const [teacher_id, leave_type, start_date, end_date, days, reason, status, approved_by, decided_at] of leaves) {
    await q(`INSERT INTO leave_applications (teacher_id, leave_type, start_date, end_date, days, reason, status, approved_by, decided_at, applied_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT DO NOTHING`,
      [teacher_id, leave_type, start_date, end_date, days, reason, status, approved_by, decided_at]);
  }
  console.log('✅ Leave applications seeded');

  // ── API CALL LOGS ──────────────────────────────────────────────────────────
  const apiLogs = [
    ['/api/finance/summary','GET',200,'finance',28,'2026-03-17 04:00:00'],
    ['/api/admin/stats','GET',200,'admin',15,'2026-03-17 04:01:00'],
    ['/api/teacher/profile','GET',200,'rajesh.kumar',12,'2026-03-17 04:02:00'],
    ['/api/hr/employees','GET',200,'hr',22,'2026-03-17 04:03:00'],
    ['/api/budget/overview','GET',200,'budget',18,'2026-03-17 04:04:00'],
    ['/api/marketing/overview','GET',200,'marketing',25,'2026-03-17 04:05:00'],
  ];
  for (const [path, method, status_code, user, response_ms, timestamp] of apiLogs) {
    await q(`INSERT INTO api_call_logs (path, method, status_code, "user", response_ms, timestamp)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [path, method, status_code, user, response_ms, timestamp]);
  }
  console.log('✅ API logs seeded');

  await pool.end();
  console.log('🎉 All production data seeded successfully!');
}

main().catch(e => {
  console.error('❌ Seed error:', e.message);
  process.exit(1);
});
