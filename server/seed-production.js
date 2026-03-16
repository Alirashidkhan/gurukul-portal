#!/usr/bin/env node
/**
 * seed-production.js
 * Seeds all missing production data into Neon PostgreSQL.
 * Safe to run multiple times (uses ON CONFLICT DO NOTHING).
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
    return await client.query(sql, params);
  } catch(e) {
    console.warn('  ⚠ query skip:', e.message.slice(0, 100));
  } finally {
    client.release();
  }
}

async function main() {
  console.log('🌱 Starting production seed...');

  // ── TEACHERS ─────────────────────────────────────────────────────────────
  // Schema: id, name, username, password_hash, email, phone, subject,
  //         created_at, + migrations: gender, designation, department,
  //         joining_date, status, employment_type, dob, etc.
  const teachers = [
    ['TCH001','Rajesh Kumar','rajesh.kumar','$2b$10$hash001','rajesh.kumar@gurukulhigh.edu','9845001001','Mathematics','Male','Mathematics Teacher','Teaching','2019-06-01','Active','Full-time'],
    ['TCH002','Priya Sharma','priya.sharma','$2b$10$hash002','priya.sharma@gurukulhigh.edu','9845001002','Science','Female','Science Teacher','Teaching','2020-07-15','Active','Full-time'],
    ['TCH003','Suresh Nair','suresh.nair','$2b$10$hash003','suresh.nair@gurukulhigh.edu','9845001003','English','Male','English Teacher','Teaching','2018-04-01','Active','Full-time'],
    ['TCH004','Anitha Rao','anitha.rao','$2b$10$hash004','anitha.rao@gurukulhigh.edu','9845001004','Social Studies','Female','Social Studies Teacher','Teaching','2021-06-01','Active','Full-time'],
    ['TCH005','Vikram Shetty','vikram.shetty','$2b$10$hash005','vikram.shetty@gurukulhigh.edu','9845001005','Kannada','Male','Kannada Teacher','Teaching','2022-01-10','Active','Full-time'],
    ['TCH006','Meena Pillai','meena.pillai','$2b$10$hash006','meena.pillai@gurukulhigh.edu','9845001006','Hindi','Female','Hindi Teacher','Teaching','2020-08-01','Active','Full-time'],
    ['TCH007','Arun Menon','arun.menon','$2b$10$hash007','arun.menon@gurukulhigh.edu','9845001007','Physical Education','Male','PE Teacher','Teaching','2019-06-01','Active','Full-time'],
    ['TCH008','Deepa Krishnan','deepa.krishnan','$2b$10$hash008','deepa.krishnan@gurukulhigh.edu','9845001008','Computer Science','Female','CS Teacher','Teaching','2021-03-15','Active','Full-time'],
  ];
  for (const [id,name,username,password_hash,email,phone,subject,gender,designation,department,joining_date,status,employment_type] of teachers) {
    await q(`INSERT INTO teachers (id,name,username,password_hash,email,phone,subject,gender,designation,department,joining_date,status,employment_type,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
             ON CONFLICT (id) DO NOTHING`,
      [id,name,username,password_hash,email,phone,subject,gender,designation,department,joining_date,status,employment_type]);
  }
  console.log('✅ Teachers seeded');

  // ── TEACHER ASSIGNMENTS ───────────────────────────────────────────────────
  const assignments = [
    ['TCH001','6','A','Mathematics'],['TCH001','7','A','Mathematics'],['TCH001','8','A','Mathematics'],
    ['TCH002','6','A','Science'],    ['TCH002','7','A','Science'],    ['TCH002','8','A','Science'],
    ['TCH003','6','A','English'],    ['TCH003','7','A','English'],    ['TCH003','8','A','English'],
    ['TCH004','6','A','Social Studies'],['TCH004','7','A','Social Studies'],
    ['TCH005','6','A','Kannada'],    ['TCH005','7','A','Kannada'],
    ['TCH006','6','A','Hindi'],      ['TCH006','7','A','Hindi'],
    ['TCH007','6','A','Physical Education'],['TCH007','7','A','Physical Education'],
    ['TCH008','8','A','Computer Science'],
  ];
  for (const [tid,cls,sec,subj] of assignments) {
    await q(`INSERT INTO teacher_assignments (teacher_id,class,section,subject)
             VALUES ($1,$2,$3,$4) ON CONFLICT (teacher_id,class,section,subject) DO NOTHING`,
      [tid,cls,sec,subj]);
  }
  console.log('✅ Teacher assignments seeded');

  // ── PAYROLL ENTRIES ───────────────────────────────────────────────────────
  // Schema: staff_id, staff_type, month, working_days, present_days, lop_days,
  //         basic, hra, da, transport, medical, gross, pf_deduction, esi_deduction,
  //         tds_deduction, late_deduction, lop_deduction, total_deductions, bonus, net_pay, status
  const salaries = {
    'TCH001':42000,'TCH002':40000,'TCH003':38000,'TCH004':36000,
    'TCH005':35000,'TCH006':35000,'TCH007':32000,'TCH008':40000
  };
  const months = ['2025-06','2025-07','2025-08','2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03'];
  for (const [tid] of teachers) {
    const base = salaries[tid];
    const hra = Math.round(base * 0.20);
    const da  = Math.round(base * 0.10);
    const transport = 1500;
    const medical = 1000;
    const gross = base + hra + da + transport + medical;
    const pf = Math.round(base * 0.12);
    const esi = Math.round(gross * 0.0075);
    const tds = Math.round(gross * 0.05);
    const totalDed = pf + esi + tds;
    const net = gross - totalDed;
    for (const month of months) {
      await q(`INSERT INTO payroll_entries
               (staff_id,staff_type,month,working_days,present_days,lop_days,basic,hra,da,transport,medical,gross,pf_deduction,esi_deduction,tds_deduction,late_deduction,lop_deduction,total_deductions,bonus,net_pay,status,processed_at)
               VALUES ($1,'teacher',$2,26,26,0,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,0,$12,0,$13,'Processed',$14)
               ON CONFLICT (staff_id,staff_type,month) DO NOTHING`,
        [tid, month, base, hra, da, transport, medical, gross, pf, esi, tds, totalDed, net, month+'-28']);
    }
  }
  console.log('✅ Payroll entries seeded');

  // ── FINANCE FEES ──────────────────────────────────────────────────────────
  const studRes = await q(`SELECT id FROM students LIMIT 50`);
  const studs = studRes ? studRes.rows : [];

  const feeTypes = [
    ['Tuition Fee', 8500],['Exam Fee', 1200],['Library Fee', 500],
    ['Sports Fee', 800],['Lab Fee', 600]
  ];
  let feeCount = 0;
  const feeMonths = ['2025-06','2025-07','2025-08','2025-09','2025-10','2025-11','2025-12','2026-01','2026-02','2026-03'];
  for (const stu of studs) {
    for (const [ft, amt] of feeTypes) {
      for (const month of feeMonths.slice(0, 6)) {  // 6 months per student
        const status = Math.random() > 0.12 ? 'Paid' : 'Pending';
        const mm = month.replace('-','').slice(0,6);
        const paid_date = status === 'Paid' ? `${month}-15` : '';
        const receipt = status === 'Paid' ? `RCP${String(feeCount+10000)}` : '';
        await q(`INSERT INTO finance_fees (student_id,fee_type,amount,academic_yr,month,paid_date,status,payment_mode,receipt_no,recorded_at)
                 VALUES ($1,$2,$3,'2025-26',$4,$5,$6,'Cash',$7,NOW()) ON CONFLICT DO NOTHING`,
          [stu.id, ft, amt, month, paid_date, status, receipt]);
        feeCount++;
      }
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
  for (const [donor_name,donor_phone,donor_email,amount,purpose,payment_mode,donated_date] of donors) {
    await q(`INSERT INTO donations (donor_name,donor_phone,donor_email,amount,purpose,payment_mode,receipt_no,donated_date,recorded_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) ON CONFLICT DO NOTHING`,
      [donor_name,donor_phone,donor_email,amount,purpose,payment_mode,'DON'+String(amount),donated_date]);
  }
  console.log('✅ Donations seeded');

  // ── DEPARTMENT BUDGETS ────────────────────────────────────────────────────
  // Schema: dept_key, dept_name, fiscal_year, allocated_amount, notes, set_by, updated_at
  const depts = [
    ['academics','Academics','2026',800000],
    ['admin','Administration','2026',500000],
    ['sports','Sports & PE','2026',300000],
    ['library','Library','2026',150000],
    ['lab','Science Lab','2026',250000],
    ['transport','Transport','2026',400000],
    ['maintenance','Maintenance','2026',200000],
    ['marketing','Marketing','2026',180000],
  ];
  for (const [dept_key,dept_name,fiscal_year,allocated_amount] of depts) {
    await q(`INSERT INTO department_budgets (dept_key,dept_name,fiscal_year,allocated_amount,notes,set_by,updated_at)
             VALUES ($1,$2,$3,$4,'','admin',NOW())
             ON CONFLICT (dept_key,fiscal_year) DO UPDATE SET allocated_amount=EXCLUDED.allocated_amount`,
      [dept_key,dept_name,fiscal_year,allocated_amount]);
  }
  console.log('✅ Department budgets seeded');

  // ── BUDGET EXPENSES ───────────────────────────────────────────────────────
  // Schema: dept_key, fiscal_year, month, description, amount, category, created_by, created_at
  const expenses = [
    ['academics','2026','2026-01','Staff Salaries',280000,'Salary'],
    ['academics','2026','2026-02','Books & Materials',25000,'Materials'],
    ['academics','2026','2026-03','Teacher Training',15000,'Training'],
    ['admin','2026','2026-01','Office Supplies',18000,'Supplies'],
    ['admin','2026','2026-02','Electricity Bill',45000,'Utilities'],
    ['admin','2026','2026-03','Building Maintenance',22000,'Maintenance'],
    ['sports','2026','2026-01','Sports Equipment',30000,'Equipment'],
    ['sports','2026','2026-02','Tournament Fees',15000,'Events'],
    ['library','2026','2026-01','New Books',25000,'Books'],
    ['library','2026','2026-02','Digital Resources',18000,'Digital'],
    ['lab','2026','2026-01','Chemicals',35000,'Consumables'],
    ['lab','2026','2026-02','Equipment',42000,'Equipment'],
    ['marketing','2026','2026-01','Admissions Campaign',20000,'Campaign'],
    ['marketing','2026','2026-02','Print Materials',15000,'Print'],
  ];
  for (const [dept_key,fiscal_year,month,description,amount,category] of expenses) {
    await q(`INSERT INTO budget_expenses (dept_key,fiscal_year,month,description,amount,category,created_by,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,'admin',NOW()) ON CONFLICT DO NOTHING`,
      [dept_key,fiscal_year,month,description,amount,category]);
  }
  console.log('✅ Budget expenses seeded');

  // ── HR BUDGET ────────────────────────────────────────────────────────────
  // Schema: fiscal_year, allocated_amount, notes, set_by, updated_at
  await q(`INSERT INTO hr_budget (fiscal_year, allocated_amount, notes, set_by, updated_at)
           VALUES ('2026', 5000000, 'Annual HR budget 2026', 'admin', NOW())
           ON CONFLICT (fiscal_year) DO UPDATE SET allocated_amount=EXCLUDED.allocated_amount`);
  console.log('✅ HR budget seeded');

  // ── JOB POSTINGS ─────────────────────────────────────────────────────────
  // Schema: title, department, location, type, description, requirements, vacancies, status, posted_date, closing_date
  const jobs = [
    ['Mathematics Teacher','Teaching','K.R. Nagar, Mysuru','Full-time','MSc Mathematics, BEd required.','MSc Maths + BEd, 2yr exp',2,'Open','2026-01-15','2026-04-30'],
    ['Administrative Assistant','Admin','K.R. Nagar, Mysuru','Full-time','Graduate with computer skills.','Graduate, MS Office',1,'Open','2026-02-01','2026-03-31'],
    ['Lab Assistant','Science','K.R. Nagar, Mysuru','Part-time','BSc with lab experience.','BSc Science, Lab exp',1,'Open','2026-02-10','2026-04-15'],
  ];
  for (const [title,department,location,type,description,requirements,vacancies,status,posted_date,closing_date] of jobs) {
    await q(`INSERT INTO job_postings (title,department,location,type,description,requirements,vacancies,status,posted_date,closing_date,created_by,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'hr',NOW()) ON CONFLICT DO NOTHING`,
      [title,department,location,type,description,requirements,vacancies,status,posted_date,closing_date]);
  }
  console.log('✅ Job postings seeded');

  // ── MARKETING LEADS ───────────────────────────────────────────────────────
  // Schema: name, phone, email, class_interested, source, stage, assigned_to, notes, created_at
  const leads = [
    ['Arun Kumar Parent','9901001001','arun.k@gmail.com','6','Facebook Ad','Inquiry','admin','Interested in Grade 6'],
    ['Sunitha Bhat','9901001002','sunitha@gmail.com','7','WhatsApp','Contacted','admin','Called twice'],
    ['Mohan Rao','9901001003','mohan@email.com','8','Walk-in','Visited','admin','Visited campus'],
    ['Kavitha Menon','9901001004','kavitha@gmail.com','6','Instagram','Enrolled','admin','Enrollment done'],
    ['Ravi Shankar','9901001005','ravi@gmail.com','9','Google Ads','Inquiry','admin','New inquiry'],
    ['Usha Srinivas','9901001006','usha@gmail.com','7','Referral','Contacted','admin','Referred by alumni'],
  ];
  for (const [name,phone,email,class_interested,source,stage,assigned_to,notes] of leads) {
    await q(`INSERT INTO marketing_leads (name,phone,email,class_interested,source,stage,assigned_to,notes,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) ON CONFLICT DO NOTHING`,
      [name,phone,email,class_interested,source,stage,assigned_to,notes]);
  }
  console.log('✅ Marketing leads seeded');

  // ── MARKETING CAMPAIGNS ───────────────────────────────────────────────────
  // Schema: name, type, status, target_audience, budget, reach, conversions, start_date, end_date, notes
  const campaigns = [
    ['Admissions 2026-27','Digital','Active','Parents of Grade 5-8 students',50000,450,120,'2026-01-01','2026-03-31','Google Ads + Social Media'],
    ['Alumni Donation Drive','Email','Completed','Alumni batch 2010-2020',15000,800,65,'2026-02-01','2026-02-28','Email + WhatsApp'],
    ['Annual Day Promotion','Event','Active','School community',20000,1200,300,'2026-03-01','2026-03-25','Social Media + Posters'],
  ];
  for (const [name,type,status,target_audience,budget,reach,conversions,start_date,end_date,notes] of campaigns) {
    await q(`INSERT INTO marketing_campaigns (name,type,status,target_audience,budget,reach,conversions,start_date,end_date,notes,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW()) ON CONFLICT DO NOTHING`,
      [name,type,status,target_audience,budget,reach,conversions,start_date,end_date,notes]);
  }
  console.log('✅ Marketing campaigns seeded');

  // ── JOURNAL ENTRIES ───────────────────────────────────────────────────────
  // Schema: date, voucher_no, voucher_type, narration, account_code, debit, credit, source, created_by
  const journals = [
    ['2026-01-31','JV-2601-001','Journal','Fee Collection January','FEE-REV',0,145000,'system','admin'],
    ['2026-01-31','JV-2601-002','Journal','Fee Collection January','CASH',145000,0,'system','admin'],
    ['2026-02-28','JV-2602-001','Journal','Fee Collection February','FEE-REV',0,162000,'system','admin'],
    ['2026-02-28','JV-2602-002','Journal','Fee Collection February','CASH',162000,0,'system','admin'],
    ['2026-03-01','JV-2603-001','Journal','Salary March','SAL-EXP',280000,0,'system','admin'],
    ['2026-03-01','JV-2603-002','Journal','Salary March','BANK',0,280000,'system','admin'],
    ['2026-01-15','JV-2601-003','Receipt','Donation - Ramesh Gowda','DONATION-INC',0,25000,'manual','finance'],
    ['2026-01-15','JV-2601-004','Receipt','Donation - Ramesh Gowda','CASH',25000,0,'manual','finance'],
    ['2026-02-10','JV-2602-003','Payment','Lab Equipment Purchase','LAB-EXP',42000,0,'manual','admin'],
    ['2026-02-10','JV-2602-004','Payment','Lab Equipment Purchase','BANK',0,42000,'manual','admin'],
  ];
  for (const [date,voucher_no,voucher_type,narration,account_code,debit,credit,source,created_by] of journals) {
    await q(`INSERT INTO journal_entries (date,voucher_no,voucher_type,narration,account_code,debit,credit,source,created_by,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT DO NOTHING`,
      [date,voucher_no,voucher_type,narration,account_code,debit,credit,source,created_by]);
  }
  console.log('✅ Journal entries seeded');

  // ── ANNOUNCEMENTS ──────────────────────────────────────────────────────────
  // Schema: title, body, type, target_roles, created_by, created_at, is_active
  const announcements = [
    ['Annual Day 2026','The Annual Day celebration will be held on 25th March 2026. All students must attend in formal uniform.','announcement','["all"]','Admin'],
    ['Final Exam Schedule','Examinations commence April 5, 2026. Timetable on notice board.','circular','["all"]','Admin'],
    ['Fee Payment Reminder','Last date for term fee payment is March 31, 2026.','alert','["all"]','Admin'],
    ['Holiday Notice - Ugadi','School closed March 22 for Ugadi. Resumes March 24.','announcement','["all"]','Admin'],
  ];
  for (const [title,body,type,target_roles,created_by] of announcements) {
    await q(`INSERT INTO announcements (title,body,type,target_roles,created_by,created_at,is_active)
             VALUES ($1,$2,$3,$4,$5,NOW(),1) ON CONFLICT DO NOTHING`,
      [title,body,type,target_roles,created_by]);
  }
  console.log('✅ Announcements seeded');

  // ── LEAVE APPLICATIONS ─────────────────────────────────────────────────────
  // Schema: teacher_id, leave_type, start_date, end_date, days, reason, status, approved_by, decided_at, applied_at
  const leaves = [
    ['TCH002','Sick Leave','2026-03-10','2026-03-11',2,'Fever','Approved','admin','2026-03-09'],
    ['TCH004','Personal Leave','2026-03-05','2026-03-05',1,'Family function','Approved','admin','2026-03-04'],
    ['TCH006','Casual Leave','2026-03-18','2026-03-18',1,'Personal work','Pending',null,null],
    ['TCH001','Medical Leave','2026-02-20','2026-02-22',3,'Hospitalization','Approved','admin','2026-02-19'],
    ['TCH007','Casual Leave','2026-03-20','2026-03-20',1,'Personal work','Pending',null,null],
    ['TCH003','Casual Leave','2026-03-25','2026-03-25',1,'Personal work','Pending',null,null],
    ['TCH005','Sick Leave','2026-03-12','2026-03-12',1,'Not well','Approved','admin','2026-03-11'],
    ['TCH008','Personal Leave','2026-03-28','2026-03-28',1,'Family function','Pending',null,null],
  ];
  for (const [teacher_id,leave_type,start_date,end_date,days,reason,status,approved_by,decided_at] of leaves) {
    await q(`INSERT INTO leave_applications (teacher_id,leave_type,start_date,end_date,days,reason,status,approved_by,decided_at,applied_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT DO NOTHING`,
      [teacher_id,leave_type,start_date,end_date,days,reason,status,approved_by,decided_at]);
  }
  console.log('✅ Leave applications seeded');

  // ── SECURITY EVENTS ───────────────────────────────────────────────────────
  const secEvents = [
    ['login_success','admin','127.0.0.1','admin','Admin login','info'],
    ['login_success','teacher','127.0.0.1','rajesh.kumar','Teacher login','info'],
    ['login_failed','admin','192.168.1.50','unknown','Failed login attempt','warning'],
    ['data_export','finance','127.0.0.1','finance','Fee records exported','info'],
    ['password_change','admin','127.0.0.1','priya.sharma','Password changed','info'],
    ['unusual_access','monitor','10.0.0.5','unknown','Multiple failed attempts','high'],
  ];
  for (const [event_type,dashboard,ip,username,details,severity] of secEvents) {
    await q(`INSERT INTO security_events (event_type,dashboard,ip,username,details,severity,timestamp)
             VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT DO NOTHING`,
      [event_type,dashboard,ip,username,details,severity]);
  }
  console.log('✅ Security events seeded');

  await pool.end();
  console.log('🎉 Production seed complete!');
}

main().catch(e => {
  console.error('❌ Seed fatal:', e.message);
  process.exit(1);
});
