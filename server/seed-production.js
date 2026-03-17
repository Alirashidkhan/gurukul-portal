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

  // ── STUDENTS ─────────────────────────────────────────────────────────────
  // Schema: id, name, class, section, dob, parent_name, parent_phone, username, password_hash, email, address
  const existingStudents = await q(`SELECT COUNT(*) AS c FROM students`);
  if (!existingStudents || parseInt(existingStudents.rows[0].c) === 0) {
    const students = [
      ['STU001','Aarav Sharma',       '6','A','2013-04-12','Ramesh Sharma',   '9845100001','aarav.sharma',   '$2b$10$hash001','aarav@school.edu',  'Jayanagar, Bengaluru'],
      ['STU002','Ananya Gupta',       '6','A','2013-07-22','Suresh Gupta',    '9845100002','ananya.gupta',   '$2b$10$hash002','ananya@school.edu', 'Koramangala, Bengaluru'],
      ['STU003','Rohan Nair',         '6','A','2013-02-08','Vijay Nair',      '9845100003','rohan.nair',     '$2b$10$hash003','rohan@school.edu',  'HSR Layout, Bengaluru'],
      ['STU004','Priya Menon',        '7','A','2012-09-15','Anil Menon',      '9845100004','priya.menon',    '$2b$10$hash004','priya@school.edu',  'Indiranagar, Bengaluru'],
      ['STU005','Karthik Reddy',      '7','A','2012-11-30','Srini Reddy',     '9845100005','karthik.reddy',  '$2b$10$hash005','karthik@school.edu','Whitefield, Bengaluru'],
      ['STU006','Sneha Pillai',       '7','A','2012-06-18','Kumar Pillai',    '9845100006','sneha.pillai',   '$2b$10$hash006','sneha@school.edu',  'Banashankari, Bengaluru'],
      ['STU007','Arjun Kumar',        '8','A','2011-03-25','Mohan Kumar',     '9845100007','arjun.kumar',    '$2b$10$hash007','arjun@school.edu',  'Malleshwaram, Bengaluru'],
      ['STU008','Divya Krishnan',     '8','A','2011-08-10','Rajan Krishnan',  '9845100008','divya.krishnan', '$2b$10$hash008','divya@school.edu',  'Rajajinagar, Bengaluru'],
      ['STU009','Amit Joshi',         '8','A','2011-12-05','Prakash Joshi',   '9845100009','amit.joshi',     '$2b$10$hash009','amit@school.edu',   'Vijayanagar, Bengaluru'],
      ['STU010','Kavya Singh',        '9','A','2010-05-20','Deepak Singh',    '9845100010','kavya.singh',    '$2b$10$hash010','kavya@school.edu',  'JP Nagar, Bengaluru'],
      ['STU011','Rahul Verma',        '9','A','2010-01-14','Sunil Verma',     '9845100011','rahul.verma',    '$2b$10$hash011','rahul@school.edu',  'Yelahanka, Bengaluru'],
      ['STU012','Meghna Iyer',        '9','A','2010-10-28','Srinivas Iyer',   '9845100012','meghna.iyer',    '$2b$10$hash012','meghna@school.edu', 'Jayanagar, Bengaluru'],
      ['STU013','Vikram Patel',       '10','A','2009-07-03','Harish Patel',   '9845100013','vikram.patel',   '$2b$10$hash013','vikram@school.edu', 'Koramangala, Bengaluru'],
      ['STU014','Nithya Bhat',        '10','A','2009-04-17','Ramakrishna Bhat','9845100014','nithya.bhat',   '$2b$10$hash014','nithya@school.edu', 'Sadashivanagar, Bengaluru'],
      ['STU015','Suresh Rao',         '10','A','2009-11-22','Narayana Rao',   '9845100015','suresh.rao',     '$2b$10$hash015','suresh@school.edu', 'Basavanagudi, Bengaluru'],
    ];
    for (const [id,name,cls,section,dob,parent_name,parent_phone,username,password_hash,email,address] of students) {
      await q(`INSERT INTO students (id,name,class,section,dob,parent_name,parent_phone,username,password_hash,email,address,created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
               ON CONFLICT (id) DO NOTHING`,
        [id,name,cls,section,dob,parent_name,parent_phone,username,password_hash,email,address]);
    }
    console.log('✅ Students seeded (15 records)');
  } else {
    console.log('✅ Students already exist — skipping');
  }

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
  // First check if fees already exist to avoid duplicates (no UNIQUE constraint)
  const existingFees = await q(`SELECT COUNT(*) AS c FROM finance_fees`);
  const existingFeeCount = existingFees ? parseInt(existingFees.rows[0].c) : 0;
  console.log(`  ℹ finance_fees currently has ${existingFeeCount} records`);

  if (existingFeeCount < 100) {
    // Fetch student IDs — with fallback to hardcoded IDs if query fails
    let studIds = [];
    const studRes = await q(`SELECT id FROM students ORDER BY id LIMIT 60`);
    if (studRes && studRes.rows && studRes.rows.length > 0) {
      studIds = studRes.rows.map(r => r.id);
      console.log(`  ℹ Found ${studIds.length} students in DB: ${studIds.slice(0,5).join(', ')}...`);
    } else {
      // Fallback: use known student IDs from this school's seed
      studIds = Array.from({length: 30}, (_, i) => 'STU' + String(i+1).padStart(3,'0'));
      console.log(`  ⚠ Students query returned empty — using fallback IDs STU001-STU030`);
    }

    const feeTypes = [
      ['Tuition Fee', 8500], ['Exam Fee', 1200], ['Library Fee', 500],
      ['Sports Fee', 800],   ['Lab Fee', 600]
    ];
    const feeMonths = ['2025-06','2025-07','2025-08','2025-09','2025-10','2025-11',
                       '2025-12','2026-01','2026-02','2026-03'];
    let feeCount = 0;
    let recNo = 10000;

    for (const stuId of studIds) {
      for (const [ft, amt] of feeTypes) {
        for (const month of feeMonths) {
          const isPaid = Math.random() > 0.15;
          const status = isPaid ? 'Paid' : 'Pending';
          const paid_date = isPaid ? `${month}-${String(10 + Math.floor(Math.random()*15)).padStart(2,'0')}` : '';
          const receipt   = isPaid ? `RCP${String(++recNo)}` : '';
          await q(`INSERT INTO finance_fees
                   (student_id,fee_type,amount,academic_yr,month,paid_date,status,payment_mode,receipt_no,recorded_at)
                   VALUES ($1,$2,$3,'2025-26',$4,$5,$6,'Cash',$7,NOW())`,
            [stuId, ft, amt, month, paid_date, status, receipt]);
          feeCount++;
        }
      }
    }
    console.log(`✅ Finance fees seeded (${feeCount} new records)`);
  } else {
    console.log(`✅ Finance fees already seeded (${existingFeeCount} records) — skipping`);
  }

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

  // ── MARKETING EVENTS ──────────────────────────────────────────────────────
  // Schema: name, type, event_date, venue, description, registrations, attendees, status
  const existingME = await q(`SELECT COUNT(*) AS c FROM marketing_events`);
  if (!existingME || parseInt(existingME.rows[0].c) === 0) {
    const mktEvents = [
      ['Open House 2026-27','Open Day','2026-02-15','School Auditorium','Annual open house for prospective parents',85,72,'Completed'],
      ['Science Exhibition','Exhibition','2026-03-10','School Grounds','Annual science fair open to public',120,110,'Completed'],
      ['Annual Day 2026','Annual Event','2026-03-25','School Auditorium','Cultural day with performances and prize distribution',250,0,'Upcoming'],
      ['Admissions Orientation','Orientation','2026-04-05','Conference Hall','Orientation for new students and parents for 2026-27',60,0,'Upcoming'],
    ];
    for (const [name,type,event_date,venue,description,registrations,attendees,status] of mktEvents) {
      await q(`INSERT INTO marketing_events (name,type,event_date,venue,description,registrations,attendees,status,created_at,updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) ON CONFLICT DO NOTHING`,
        [name,type,event_date,venue,description,registrations,attendees,status]);
    }
    console.log('✅ Marketing events seeded');
  } else {
    console.log('✅ Marketing events already exist — skipping');
  }

  // ── MARKETING SOCIAL POSTS ────────────────────────────────────────────────
  // Schema: platform, content, scheduled_date, status, reach, engagement
  const existingSP = await q(`SELECT COUNT(*) AS c FROM marketing_social_posts`);
  if (!existingSP || parseInt(existingSP.rows[0].c) === 0) {
    const socialPosts = [
      ['Instagram','Annual Day is coming on March 25! Join us for performances. #GurukulHighSchool #AnnualDay2026','2026-03-20','Scheduled',0,0],
      ['Facebook','Admissions Open for 2026-27! Grades 1-10. Limited seats. Call 080-12345678. #Admissions','2026-03-18','Scheduled',0,0],
      ['Instagram','Congratulations to our Science Exhibition participants! #ScienceExhibition #Gurukul','2026-03-11','Published',412,89],
      ['WhatsApp','Dear Parents, Fee payment deadline is March 31, 2026. Please ensure timely payment.','2026-03-15','Published',380,0],
      ['Facebook','Open House was a success! Thank you to the 72 families who visited us.','2026-02-16','Published',620,145],
      ['Instagram','Library corner spotlight: New books added this month! #LibraryLife #GurukulHighSchool','2026-02-20','Published',290,67],
    ];
    for (const [platform,content,scheduled_date,status,reach,engagement] of socialPosts) {
      await q(`INSERT INTO marketing_social_posts (platform,content,scheduled_date,status,reach,engagement,created_at,updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW()) ON CONFLICT DO NOTHING`,
        [platform,content,scheduled_date,status,reach,engagement]);
    }
    console.log('✅ Marketing social posts seeded');
  } else {
    console.log('✅ Marketing social posts already exist — skipping');
  }

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
  // Actual schema: person_id, person_type, person_name, leave_type (sick/earned),
  //                from_date, to_date, days, reason, status (Pending/Approved/Rejected),
  //                admin_note, applied_at, decided_at
  const existingLeaves = await q(`SELECT COUNT(*) AS c FROM leave_applications`);
  if (!existingLeaves || parseInt(existingLeaves.rows[0].c) === 0) {
    const leaves = [
      ['TCH002','teacher','Priya Sharma',   'sick',  '2026-03-10','2026-03-11',2,'Fever',          'Approved','','2026-03-09','2026-03-09'],
      ['TCH004','teacher','Anitha Rao',     'earned','2026-03-05','2026-03-05',1,'Family function', 'Approved','','2026-03-04','2026-03-04'],
      ['TCH006','teacher','Meena Pillai',   'earned','2026-03-18','2026-03-18',1,'Personal work',   'Pending', '','2026-03-16',''],
      ['TCH001','teacher','Rajesh Kumar',   'sick',  '2026-02-20','2026-02-22',3,'Hospitalization', 'Approved','','2026-02-19','2026-02-19'],
      ['TCH007','teacher','Arun Menon',     'earned','2026-03-20','2026-03-20',1,'Personal work',   'Pending', '','2026-03-17',''],
      ['TCH003','teacher','Suresh Nair',    'earned','2026-03-25','2026-03-25',1,'Personal work',   'Pending', '','2026-03-17',''],
      ['TCH005','teacher','Vikram Shetty',  'sick',  '2026-03-12','2026-03-12',1,'Not well',        'Approved','','2026-03-11','2026-03-11'],
      ['TCH008','teacher','Deepa Krishnan', 'earned','2026-03-28','2026-03-28',1,'Family function', 'Pending', '','2026-03-17',''],
    ];
    for (const [person_id,person_type,person_name,leave_type,from_date,to_date,days,reason,status,admin_note,applied_at,decided_at] of leaves) {
      await q(`INSERT INTO leave_applications
               (person_id,person_type,person_name,leave_type,from_date,to_date,days,reason,status,admin_note,applied_at,decided_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
        [person_id,person_type,person_name,leave_type,from_date,to_date,days,reason,status,admin_note,applied_at,decided_at]);
    }
    console.log('✅ Leave applications seeded');
  } else {
    console.log('✅ Leave applications already exist — skipping');
  }

  // ── SUPPORT STAFF ─────────────────────────────────────────────────────────
  // Needed for HR dashboard totalStaff count
  const existingSupport = await q(`SELECT COUNT(*) AS c FROM support_staff`);
  if (!existingSupport || parseInt(existingSupport.rows[0].c) === 0) {
    const supportStaff = [
      ['SS001','Ganesh Naik',       'Administration', 'Office Manager',     '9845010001','ganesh@gurukulhigh.edu',  '2018-04-01','Active','Full-time'],
      ['SS002','Kavitha Srinivas',  'Administration', 'Receptionist',       '9845010002','kavitha@gurukulhigh.edu', '2020-06-15','Active','Full-time'],
      ['SS003','Ramu Hegde',        'Maintenance',    'Head Peon',          '9845010003','','2017-08-01','Active','Full-time'],
      ['SS004','Shanta Bai',        'Housekeeping',   'Cleaning Supervisor','9845010004','','2019-01-10','Active','Full-time'],
      ['SS005','Prasad N',          'Security',       'Security Guard',     '9845010005','','2021-03-01','Active','Full-time'],
      ['SS006','Kiran Kumar',       'Accounts',       'Accountant',         '9845010006','kiran@gurukulhigh.edu',   '2019-09-01','Active','Full-time'],
      ['SS007','Sowmya Devi',       'Library',        'Librarian',          '9845010007','sowmya@gurukulhigh.edu',  '2020-07-01','Active','Full-time'],
      ['SS008','Mahesh Transport',  'Transport',      'Transport Manager',  '9845010008','','2018-06-01','Active','Full-time'],
      ['SS009','Nalini P',          'Canteen',        'Canteen Supervisor', '9845010009','','2022-01-01','Active','Part-time'],
      ['SS010','Suresh Watchman',   'Security',       'Night Guard',        '9845010010','','2021-11-01','Active','Full-time'],
    ];
    for (const [id,name,department,designation,phone,email,joining_date,status,employment_type] of supportStaff) {
      await q(`INSERT INTO support_staff (id,name,department,designation,phone,email,joining_date,status,employment_type)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [id,name,department,designation,phone,email,joining_date,status,employment_type]);
    }
    console.log('✅ Support staff seeded (10 records)');
  } else {
    console.log('✅ Support staff already exist — skipping');
  }

  // ── ATTENDANCE RECORDS ────────────────────────────────────────────────────
  // Seed last 10 school days of attendance for students
  const existingAtt = await q(`SELECT COUNT(*) AS c FROM attendance`);
  const attCount = existingAtt ? parseInt(existingAtt.rows[0].c) : 0;
  if (attCount < 50) {
    let attStudIds = [];
    const attStudRes = await q(`SELECT id FROM students ORDER BY id LIMIT 40`);
    if (attStudRes && attStudRes.rows.length > 0) {
      attStudIds = attStudRes.rows.map(r => r.id);
    } else {
      attStudIds = Array.from({length: 20}, (_, i) => 'STU' + String(i+1).padStart(3,'0'));
    }
    const schoolDays = ['2026-03-10','2026-03-11','2026-03-12','2026-03-13','2026-03-14',
                        '2026-03-17','2026-02-24','2026-02-25','2026-02-26','2026-02-27'];
    let attInserted = 0;
    for (const date of schoolDays) {
      for (const sid of attStudIds.slice(0, 30)) {
        const status = Math.random() > 0.08 ? 'P' : 'A'; // 92% present
        const res = await q(`INSERT INTO attendance (student_id, date, status, marked_by)
                             VALUES ($1,$2,$3,'admin')
                             ON CONFLICT (student_id, date) DO NOTHING`,
          [sid, date, status]);
        if (res && res.rowCount > 0) attInserted++;
      }
    }
    console.log(`✅ Attendance seeded (${attInserted} records)`);
  } else {
    console.log(`✅ Attendance already seeded (${attCount} records) — skipping`);
  }

  // ── TEACHER CHECKINS ──────────────────────────────────────────────────────
  const existingCheckins = await q(`SELECT COUNT(*) AS c FROM teacher_checkins`);
  if (!existingCheckins || parseInt(existingCheckins.rows[0].c) === 0) {
    const tcherIds = ['TCH001','TCH002','TCH003','TCH004','TCH005','TCH006','TCH007','TCH008'];
    const checkDays = ['2026-03-17','2026-03-16','2026-03-13','2026-03-12','2026-03-11'];
    for (const date of checkDays) {
      for (const tid of tcherIds) {
        const hrsWorked = 6 + Math.random() * 2;
        await q(`INSERT INTO teacher_checkins (teacher_id, date, check_in, check_out, hours_worked)
                 VALUES ($1,$2,'09:00','16:00',$3)
                 ON CONFLICT (teacher_id, date) DO NOTHING`,
          [tid, date, hrsWorked.toFixed(1)]);
      }
    }
    console.log('✅ Teacher checkins seeded');
  } else {
    console.log('✅ Teacher checkins already exist — skipping');
  }

  // ── EXAMS ─────────────────────────────────────────────────────────────────
  const existingExams = await q(`SELECT COUNT(*) AS c FROM exams`);
  if (!existingExams || parseInt(existingExams.rows[0].c) === 0) {
    const examsList = [
      ['Unit Test 1 – Term 1','Unit Test','Term-1','6','A','2026-01-15','2026-01-15',25,10,'2025-26','Completed'],
      ['Unit Test 1 – Term 1','Unit Test','Term-1','7','A','2026-01-15','2026-01-15',25,10,'2025-26','Completed'],
      ['Unit Test 1 – Term 1','Unit Test','Term-1','8','A','2026-01-15','2026-01-15',25,10,'2025-26','Completed'],
      ['Mid Term Exam Term-1', 'Mid Term', 'Term-1','6','A','2025-10-01','2025-10-07',100,35,'2025-26','Results Published'],
      ['Mid Term Exam Term-1', 'Mid Term', 'Term-1','7','A','2025-10-01','2025-10-07',100,35,'2025-26','Results Published'],
      ['Mid Term Exam Term-1', 'Mid Term', 'Term-1','8','A','2025-10-01','2025-10-07',100,35,'2025-26','Results Published'],
      ['Final Exam 2025-26',   'Annual',   'Term-2','6','A','2026-04-05','2026-04-12',100,35,'2025-26','Upcoming'],
      ['Final Exam 2025-26',   'Annual',   'Term-2','7','A','2026-04-05','2026-04-12',100,35,'2025-26','Upcoming'],
      ['Final Exam 2025-26',   'Annual',   'Term-2','8','A','2026-04-05','2026-04-12',100,35,'2025-26','Upcoming'],
    ];
    for (const [name,exam_type,term,cls,section,start_date,end_date,total_marks,pass_marks,academic_yr,status] of examsList) {
      await q(`INSERT INTO exams (name,exam_type,term,class,section,start_date,end_date,total_marks,pass_marks,academic_yr,status,created_by,created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'admin',NOW()) ON CONFLICT DO NOTHING`,
        [name,exam_type,term,cls,section,start_date,end_date,total_marks,pass_marks,academic_yr,status]);
    }
    console.log('✅ Exams seeded');
  } else {
    console.log('✅ Exams already exist — skipping');
  }

  // ── FIX CORRUPT MONTH VALUES IN FINANCE_FEES ─────────────────────────────
  // Old records have month='April'/'October' (text names) instead of ISO '2025-04'/'2025-10'
  // Map month names → ISO format for academic year 2025-26
  const monthNameMap = {
    'January':'2026-01','February':'2026-02','March':'2026-03',
    'April':'2025-04','May':'2025-05','June':'2025-06',
    'July':'2025-07','August':'2025-08','September':'2025-09',
    'October':'2025-10','November':'2025-11','December':'2025-12'
  };
  for (const [name, iso] of Object.entries(monthNameMap)) {
    await q(`UPDATE finance_fees SET month=$1 WHERE month=$2`, [iso, name]);
  }
  console.log('✅ Finance_fees month names normalized to ISO format');

  // ── CLASS FEES ────────────────────────────────────────────────────────────
  // Needed for fee defaulters calculation (fallback when no fee_schedules)
  const existingCF = await q(`SELECT COUNT(*) AS c FROM class_fees`);
  if (!existingCF || parseInt(existingCF.rows[0].c) === 0) {
    const classFeesList = [
      ['1',12000,500],['2',12000,500],['3',13000,500],['4',13000,500],['5',14000,500],
      ['6',15000,750],['7',15000,750],['8',16000,750],['9',17000,1000],['10',18000,1000],
      ['11',20000,1000],['12',21000,1000]
    ];
    for (const [cls, annual_fee, processing_fee] of classFeesList) {
      await q(`INSERT INTO class_fees (class, annual_fee, processing_fee, updated_at)
               VALUES ($1, $2, $3, NOW())
               ON CONFLICT (class) DO NOTHING`,
        [cls, annual_fee, processing_fee]);
    }
    console.log('✅ Class fees seeded');
  } else {
    console.log('✅ Class fees already exist — skipping');
  }

  // ── FEE SCHEDULES ─────────────────────────────────────────────────────────
  // Needed for Fee Schedule page AND fee defaulters calculation (primary source)
  // Schema: class, fee_type, amount, academic_yr, term, UNIQUE(class, fee_type, academic_yr, term)
  const existingFS = await q(`SELECT COUNT(*) AS c FROM fee_schedules`);
  if (!existingFS || parseInt(existingFS.rows[0].c) === 0) {
    // Fee breakdown per class per fee_type for academic year 2025-26
    // Amounts sum to the annual_fee for each class (from class_fees above)
    const feeSchedules = [
      // Class 6  — annual total: 15000
      ['6','Tuition Fee',   9000,'2025-26','Annual'],
      ['6','Exam Fee',      1500,'2025-26','Annual'],
      ['6','Library Fee',   1000,'2025-26','Annual'],
      ['6','Sports Fee',    1500,'2025-26','Annual'],
      ['6','Lab Fee',       1250,'2025-26','Annual'],
      ['6','Transport Fee', 750, '2025-26','Annual'],
      // Class 7  — annual total: 15000
      ['7','Tuition Fee',   9000,'2025-26','Annual'],
      ['7','Exam Fee',      1500,'2025-26','Annual'],
      ['7','Library Fee',   1000,'2025-26','Annual'],
      ['7','Sports Fee',    1500,'2025-26','Annual'],
      ['7','Lab Fee',       1250,'2025-26','Annual'],
      ['7','Transport Fee', 750, '2025-26','Annual'],
      // Class 8  — annual total: 16000
      ['8','Tuition Fee',  10000,'2025-26','Annual'],
      ['8','Exam Fee',      1500,'2025-26','Annual'],
      ['8','Library Fee',   1000,'2025-26','Annual'],
      ['8','Sports Fee',    1500,'2025-26','Annual'],
      ['8','Lab Fee',       1250,'2025-26','Annual'],
      ['8','Transport Fee', 750, '2025-26','Annual'],
      // Class 9  — annual total: 17000
      ['9','Tuition Fee',  11000,'2025-26','Annual'],
      ['9','Exam Fee',      1500,'2025-26','Annual'],
      ['9','Library Fee',   1000,'2025-26','Annual'],
      ['9','Sports Fee',    1500,'2025-26','Annual'],
      ['9','Lab Fee',       1250,'2025-26','Annual'],
      ['9','Transport Fee', 750, '2025-26','Annual'],
      // Class 10 — annual total: 18000
      ['10','Tuition Fee', 12000,'2025-26','Annual'],
      ['10','Exam Fee',     1500,'2025-26','Annual'],
      ['10','Library Fee',  1000,'2025-26','Annual'],
      ['10','Sports Fee',   1500,'2025-26','Annual'],
      ['10','Lab Fee',      1250,'2025-26','Annual'],
      ['10','Transport Fee', 750,'2025-26','Annual'],
    ];
    for (const [cls, fee_type, amount, academic_yr, term] of feeSchedules) {
      await q(`INSERT INTO fee_schedules (class, fee_type, amount, academic_yr, term)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (class, fee_type, academic_yr, term) DO NOTHING`,
        [cls, fee_type, amount, academic_yr, term]);
    }
    console.log('✅ Fee schedules seeded');
  } else {
    console.log('✅ Fee schedules already exist — skipping');
  }

  // ── LIBRARY BOOKS ─────────────────────────────────────────────────────────
  // Schema: title, author, isbn, category, total_copies, available, rack
  const existingLB = await q(`SELECT COUNT(*) AS c FROM library_books`);
  if (!existingLB || parseInt(existingLB.rows[0].c) === 0) {
    const books = [
      ['Mathematics for Class 10','R.D. Sharma','9788193623400','Mathematics',5,4,'A1'],
      ['Science Textbook Class 9','NCERT','9788174504944','Science',6,5,'A2'],
      ['English Literature Anthology','Pearson','9780521605052','English',4,4,'B1'],
      ['Social Studies Class 8','NCERT','9788174509802','Social Studies',5,3,'B2'],
      ['Computer Science Basics','BPB Publications','9789386551498','Computer Science',3,3,'C1'],
      ['Hindi Sahitya Sanchayan','NCERT','9788174508751','Hindi',4,4,'B3'],
      ['Kannada Parichaya','Karnataka Govt','9788179871300','Kannada',4,3,'B4'],
      ['Physics Fundamentals','H.C. Verma','9788177091366','Science',3,2,'A3'],
      ['Chemistry Class 11','NCERT','9788174506788','Science',4,4,'A4'],
      ['The Story of My Experiments with Truth','M.K. Gandhi','9780807059098','Biography',2,2,'D1'],
      ['Wings of Fire','A.P.J. Abdul Kalam','9788173711466','Biography',3,3,'D1'],
      ['A Brief History of Time','Stephen Hawking','9780553380163','Science',2,2,'D2'],
      ['Discovery of India','Jawaharlal Nehru','9780195623598','History',2,2,'D3'],
      ['Mathematics Olympiad Problems','Titu Andreescu','9780817643270','Mathematics',2,2,'A1'],
      ['English Grammar in Use','Raymond Murphy','9780521189392','English',3,2,'B1'],
      ['Atlas of World Geography','Oxford','9780195663631','Geography',2,2,'E1'],
      ['Encyclopaedia Britannica Vol 1','Britannica','9780852299616','Reference',1,1,'E2'],
      ['Harry Potter and the Sorcerer Stone','J.K. Rowling','9780439708180','Fiction',3,3,'F1'],
      ['The Alchemist','Paulo Coelho','9780061122415','Fiction',2,2,'F1'],
      ['Diary of a Wimpy Kid','Jeff Kinney','9780810993136','Fiction',2,2,'F2'],
    ];
    for (const [title,author,isbn,category,total_copies,available,rack] of books) {
      await q(`INSERT INTO library_books (title,author,isbn,category,total_copies,available,rack)
               VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [title,author,isbn,category,total_copies,available,rack]);
    }
    console.log('✅ Library books seeded');
  } else {
    console.log('✅ Library books already exist — skipping');
  }

  // ── TRANSPORT ROUTES ──────────────────────────────────────────────────────
  // Schema: route_name, driver, vehicle, capacity, stops (JSON), departure, arrival, status
  const existingTR = await q(`SELECT COUNT(*) AS c FROM transport_routes`);
  if (!existingTR || parseInt(existingTR.rows[0].c) === 0) {
    const routes = [
      ['Route 1 – Jayanagar','Raju Naik','KA-01-AB-1234',40,'["Jayanagar 4th Block","Jayanagar 9th Block","Lalbagh Gate","School"]','07:30','08:15','Active'],
      ['Route 2 – Koramangala','Suresh Kumar','KA-01-CD-5678',45,'["Koramangala 5th Block","Koramangala 1st Block","Silk Board","School"]','07:15','08:10','Active'],
      ['Route 3 – HSR Layout','Mohan Das','KA-01-EF-9012',40,'["HSR Layout Sector 1","HSR Layout Sector 6","Agara Lake","School"]','07:20','08:15','Active'],
      ['Route 4 – Electronic City','Venkat Rao','KA-01-GH-3456',50,'["Electronic City Phase 1","Electronic City Phase 2","Bommanahalli","School"]','07:00','08:15','Active'],
    ];
    for (const [route_name,driver,vehicle,capacity,stops,departure,arrival,status] of routes) {
      await q(`INSERT INTO transport_routes (route_name,driver,vehicle,capacity,stops,departure,arrival,status)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [route_name,driver,vehicle,capacity,stops,departure,arrival,status]);
    }
    console.log('✅ Transport routes seeded');
  } else {
    console.log('✅ Transport routes already exist — skipping');
  }

  // ── TRANSPORT STUDENTS ────────────────────────────────────────────────────
  // Schema: student_id, route_id, stop, fee  UNIQUE(student_id)
  const existingTS = await q(`SELECT COUNT(*) AS c FROM transport_students`);
  if (!existingTS || parseInt(existingTS.rows[0].c) === 0) {
    const transportStudents = [
      ['STU001','Route 1 – Jayanagar','Jayanagar 4th Block',1200],
      ['STU002','Route 1 – Jayanagar','Jayanagar 9th Block',1200],
      ['STU003','Route 2 – Koramangala','Koramangala 5th Block',1200],
      ['STU004','Route 2 – Koramangala','Koramangala 1st Block',1200],
      ['STU005','Route 3 – HSR Layout','HSR Layout Sector 1',1200],
      ['STU006','Route 3 – HSR Layout','HSR Layout Sector 6',1200],
      ['STU007','Route 4 – Electronic City','Electronic City Phase 1',1400],
      ['STU008','Route 4 – Electronic City','Electronic City Phase 2',1400],
      ['STU009','Route 1 – Jayanagar','Lalbagh Gate',1200],
      ['STU010','Route 2 – Koramangala','Silk Board',1200],
    ];
    for (const [student_id, route_name, stop, fee] of transportStudents) {
      await q(`INSERT INTO transport_students (student_id, route_id, stop, fee)
               SELECT $1, id, $2, $3 FROM transport_routes WHERE route_name=$4 LIMIT 1
               ON CONFLICT (student_id) DO NOTHING`,
        [student_id, stop, fee, route_name]);
    }
    console.log('✅ Transport students seeded');
  } else {
    console.log('✅ Transport students already exist — skipping');
  }

  // ── MARKS (for report cards and performance analytics) ───────────────────
  // Schema: student_id, subject, exam, marks, max_marks, term, date
  const existingMarks = await q(`SELECT COUNT(*) AS c FROM marks`);
  if (!existingMarks || parseInt(existingMarks.rows[0].c) === 0) {
    // Subjects per class — matches teacher_assignments
    const subjectsByClass = {
      '6':  ['Mathematics','Science','English','Social Studies','Kannada','Hindi','Physical Education'],
      '7':  ['Mathematics','Science','English','Social Studies','Kannada','Hindi','Physical Education'],
      '8':  ['Mathematics','Science','English','Social Studies','Computer Science'],
      '9':  ['Mathematics','Science','English','Social Studies'],
      '10': ['Mathematics','Science','English','Social Studies'],
    };
    const students6to10 = [
      ['STU001','6'],['STU002','6'],['STU003','6'],
      ['STU004','7'],['STU005','7'],['STU006','7'],
      ['STU007','8'],['STU008','8'],['STU009','8'],
      ['STU010','9'],['STU011','9'],['STU012','9'],
      ['STU013','10'],['STU014','10'],['STU015','10'],
    ];
    const exams   = [['Mid Term','Term-1','2025-10-07'],['Unit Test 1','Term-1','2026-01-15']];
    const getRand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    for (const [sid, cls] of students6to10) {
      for (const [exam, term, date] of exams) {
        for (const subj of (subjectsByClass[cls] || [])) {
          const maxM = exam === 'Unit Test 1' ? 25 : 100;
          const minScore = Math.floor(maxM * 0.55);
          const scored = getRand(minScore, maxM);
          await q(`INSERT INTO marks (student_id,subject,exam,marks,max_marks,term,date)
                   VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [sid, subj, exam, scored, maxM, term, date]);
        }
      }
    }
    console.log('✅ Marks seeded');
  } else {
    console.log('✅ Marks already exist — skipping');
  }

  // ── CLASS TIMETABLES ──────────────────────────────────────────────────────
  // Schema: teacher_id, class_name, section, subject, day_of_week, start_time, end_time, room, week_start
  const existingTT = await q(`SELECT COUNT(*) AS c FROM class_timetables`);
  if (!existingTT || parseInt(existingTT.rows[0].c) === 0) {
    const weekStart = '2026-03-16'; // Monday of this week
    const timetable = [
      // Class 6
      ['TCH001','6','A','Mathematics','Monday',   '08:00','08:45','Room 101',weekStart],
      ['TCH002','6','A','Science',    'Monday',   '08:45','09:30','Room 101',weekStart],
      ['TCH003','6','A','English',    'Monday',   '10:00','10:45','Room 101',weekStart],
      ['TCH001','6','A','Mathematics','Tuesday',  '08:00','08:45','Room 101',weekStart],
      ['TCH004','6','A','Social Studies','Tuesday','08:45','09:30','Room 101',weekStart],
      ['TCH005','6','A','Kannada',    'Tuesday',  '10:00','10:45','Room 101',weekStart],
      ['TCH002','6','A','Science',    'Wednesday','08:00','08:45','Room 101',weekStart],
      ['TCH006','6','A','Hindi',      'Wednesday','08:45','09:30','Room 101',weekStart],
      ['TCH003','6','A','English',    'Thursday', '08:00','08:45','Room 101',weekStart],
      ['TCH007','6','A','Physical Education','Thursday','10:00','10:45','Ground',weekStart],
      ['TCH001','6','A','Mathematics','Friday',   '08:00','08:45','Room 101',weekStart],
      ['TCH002','6','A','Science',    'Friday',   '08:45','09:30','Room 101',weekStart],
      // Class 8
      ['TCH001','8','A','Mathematics','Monday',   '09:30','10:15','Room 201',weekStart],
      ['TCH002','8','A','Science',    'Monday',   '10:15','11:00','Lab 1',   weekStart],
      ['TCH003','8','A','English',    'Tuesday',  '09:30','10:15','Room 201',weekStart],
      ['TCH008','8','A','Computer Science','Tuesday','10:15','11:00','Lab 2',weekStart],
      ['TCH001','8','A','Mathematics','Wednesday','09:30','10:15','Room 201',weekStart],
      ['TCH002','8','A','Science',    'Thursday', '09:30','10:15','Lab 1',   weekStart],
      ['TCH008','8','A','Computer Science','Friday','09:30','10:15','Lab 2', weekStart],
    ];
    for (const [tid,cls,sec,subj,day,st,et,room,ws] of timetable) {
      await q(`INSERT INTO class_timetables (teacher_id,class_name,section,subject,day_of_week,start_time,end_time,room,week_start,created_at,updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW()) ON CONFLICT DO NOTHING`,
        [tid,cls,sec,subj,day,st,et,room,ws]);
    }
    console.log('✅ Class timetables seeded');
  } else {
    console.log('✅ Class timetables already exist — skipping');
  }

  // ── HOLIDAYS ──────────────────────────────────────────────────────────────
  // Schema: date TEXT UNIQUE, name, type (National|State|School)
  const existingHol = await q(`SELECT COUNT(*) AS c FROM holidays`);
  if (!existingHol || parseInt(existingHol.rows[0].c) === 0) {
    const holidays = [
      ['2026-01-26','Republic Day','National'],
      ['2026-02-19','Chhatrapati Shivaji Maharaj Jayanti','State'],
      ['2026-03-17','Holi','National'],
      ['2026-03-25','Annual Day (School Holiday)','School'],
      ['2026-04-05','Ram Navami','National'],
      ['2026-04-10','Good Friday','National'],
      ['2026-04-14','Dr. Ambedkar Jayanti','National'],
      ['2026-04-15','Summer Vacation Begins','School'],
      ['2026-06-01','School Reopens','School'],
      ['2026-08-15','Independence Day','National'],
      ['2026-08-19','Ganesh Chaturthi','State'],
      ['2026-10-02','Gandhi Jayanti','National'],
      ['2026-10-15','Dasara (Vijayadashami)','State'],
      ['2026-11-04','Diwali','National'],
      ['2026-11-05','Diwali Holiday','National'],
    ];
    for (const [date, name, type] of holidays) {
      await q(`INSERT INTO holidays (date,name,type) VALUES ($1,$2,$3) ON CONFLICT (date) DO NOTHING`,
        [date, name, type]);
    }
    console.log('✅ Holidays seeded');
  } else {
    console.log('✅ Holidays already exist — skipping');
  }

  // ── ACADEMIC CALENDAR ─────────────────────────────────────────────────────
  // Schema: title, event_type, start_date, end_date, class, description, is_active, created_by
  const existingAC = await q(`SELECT COUNT(*) AS c FROM academic_calendar`);
  if (!existingAC || parseInt(existingAC.rows[0].c) === 0) {
    const calEvents = [
      ['Term 1 Begins','Term','2025-06-02','2025-10-15','All','First academic term 2025-26',1,'Admin'],
      ['Mid Term Examinations','Exam','2025-10-01','2025-10-07','All','Mid-term exams for all classes',1,'Admin'],
      ['Dussehra Vacation','Vacation','2025-10-08','2025-10-20','All','Dussehra break',1,'Admin'],
      ['Term 2 Begins','Term','2025-10-21','2026-03-31','All','Second academic term 2025-26',1,'Admin'],
      ['Unit Test 1','Test','2026-01-15','2026-01-15','All','Class 6-8 unit test',1,'Admin'],
      ['Annual Day Celebrations','Event','2026-03-25','2026-03-25','All','Cultural programme and prize distribution',1,'Admin'],
      ['Final Examinations','Exam','2026-04-05','2026-04-12','All','Annual examinations for all classes',1,'Admin'],
      ['Summer Vacation','Vacation','2026-04-15','2026-05-31','All','Summer break',1,'Admin'],
      ['PTM – Term 1 Results','PTM','2025-11-10','2025-11-10','All','Parent-teacher meeting for Term 1 results',1,'Admin'],
      ['PTM – Unit Test 1','PTM','2026-01-25','2026-01-25','All','Parent-teacher meeting post unit test',1,'Admin'],
    ];
    for (const [title,event_type,start_date,end_date,cls,description,is_active,created_by] of calEvents) {
      await q(`INSERT INTO academic_calendar (title,event_type,start_date,end_date,class,description,is_active,created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [title,event_type,start_date,end_date,cls,description,is_active,created_by]);
    }
    console.log('✅ Academic calendar seeded');
  } else {
    console.log('✅ Academic calendar already exist — skipping');
  }

  // ── HOMEWORK ──────────────────────────────────────────────────────────────
  // Schema: title, description, subject, class, section, due_date, assigned_by
  const existingHW = await q(`SELECT COUNT(*) AS c FROM homework`);
  if (!existingHW || parseInt(existingHW.rows[0].c) === 0) {
    const homework = [
      ['Chapter 5 – Linear Equations','Solve exercises 5.1 to 5.3 from NCERT textbook','Mathematics','6','A','2026-03-20','TCH001'],
      ['Light & Reflection Lab Report','Write a 1-page lab report on the mirror experiment done in class','Science','6','A','2026-03-21','TCH002'],
      ['Essay – My Favourite Season','Write a 200-word essay on your favourite season','English','7','A','2026-03-19','TCH003'],
      ['Maps – South India','Draw and label the political map of South India','Social Studies','7','A','2026-03-22','TCH004'],
      ['Python Basics Practice','Complete exercises 1-10 from the Python workbook','Computer Science','8','A','2026-03-21','TCH008'],
      ['Algebra Worksheet','Complete the worksheet on factoring quadratic expressions','Mathematics','8','A','2026-03-20','TCH001'],
      ['Chemistry – Periodic Table','Memorise groups 1, 2, 17 and 18 of the periodic table and write their properties','Science','9','A','2026-03-22','TCH002'],
      ['History – World War II Summary','Write a 300-word summary of key events of World War II','Social Studies','10','A','2026-03-24','TCH004'],
    ];
    for (const [title,description,subject,cls,section,due_date,assigned_by] of homework) {
      await q(`INSERT INTO homework (title,description,subject,class,section,due_date,assigned_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [title,description,subject,cls,section,due_date,assigned_by]);
    }
    console.log('✅ Homework seeded');
  } else {
    console.log('✅ Homework already exist — skipping');
  }

  // ── ADMISSIONS ────────────────────────────────────────────────────────────
  // Schema: first_name, last_name, dob, gender, blood_group, grade_applying,
  //         prev_school, last_grade, last_percentage, father_name, father_mobile, father_email,
  //         mother_name, mother_mobile, address, city, pin, hear_about, reason_admission, status
  const existingAdm = await q(`SELECT COUNT(*) AS c FROM admissions`);
  if (!existingAdm || parseInt(existingAdm.rows[0].c) === 0) {
    // id is TEXT PRIMARY KEY — must be explicitly provided (format APP0001)
    // status must match: 'Pending Review' | 'Under Review' | 'Accepted' | 'Rejected'
    const admissions = [
      ['APP0001','Ishaan','Mehta','2014-05-10','Male','B+','6','St. Joseph School','5','88.0','Rakesh Mehta','Business Owner','9845201001','rakesh@gmail.com','Sunita Mehta','9845201002','12 MG Road','Bengaluru','560001','Google Search','Better academic environment','Pending Review'],
      ['APP0002','Shreya','Nanda','2013-11-20','Female','O+','7','The International School','6','92.5','Praveen Nanda','IT Engineer','9845201003','praveen@gmail.com','Deepa Nanda','9845201004','45 Residency Road','Bengaluru','560025','Referral','Recommended by neighbour','Under Review'],
      ['APP0003','Aditya','Kulkarni','2012-03-15','Male','A+','8','DPS North','7','79.0','Sanjeev Kulkarni','Doctor','9845201005','sanjeev@gmail.com','Priya Kulkarni','9845201006','23 Sadashivanagar','Bengaluru','560080','Social Media','Excellent sports facilities','Accepted'],
      ['APP0004','Pooja','Hegde','2011-07-04','Female','B-','9','Baldwin Girls','8','85.5','Sudhir Hegde','Govt Employee','9845201007','sudhir@gmail.com','Kavitha Hegde','9845201008','67 Basavanagudi','Bengaluru','560004','Walk-in Visit','Close to home','Pending Review'],
      ['APP0005','Nikhil','Shetty','2010-09-30','Male','AB+','10','Kendriya Vidyalaya','9','91.0','Dinesh Shetty','Banker','9845201009','dinesh@gmail.com','Usha Shetty','9845201010','89 Jayanagar','Bengaluru','560041','Newspaper Ad','Quality education and discipline','Rejected'],
      ['APP0006','Tanvi','Rao','2014-01-25','Female','O-','6','Government School','5','76.0','Venkat Rao','Teacher','9845201011','venkat@gmail.com','Latha Rao','9845201012','5 BTM Layout','Bengaluru','560076','Friend Referral','Affordable fee structure','Accepted'],
    ];
    for (const [id,fn,ln,dob,gender,bg,grade,prev,lg,lp,fname,focc,fmob,femail,mname,mmob,addr,city,pin,hear,reason,status] of admissions) {
      await q(`INSERT INTO admissions (id,submitted_at,status,first_name,last_name,dob,gender,blood_group,grade_applying,prev_school,last_grade,last_percentage,father_name,father_occupation,father_mobile,father_email,mother_name,mother_mobile,address,city,pin,hear_about,reason_admission)
               VALUES ($1,NOW(),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT (id) DO NOTHING`,
        [id,status,fn,ln,dob,gender,bg,grade,prev,lg,lp,fname,focc,fmob,femail,mname,mmob,addr,city,pin,hear,reason]);
    }
    console.log('✅ Admissions seeded');
  } else {
    console.log('✅ Admissions already exist — skipping');
  }

  // ── PTM MEETINGS ──────────────────────────────────────────────────────────
  // Schema: student_id, title, scheduled_at, teacher_name, teacher_subject, location, status
  const existingPTM = await q(`SELECT COUNT(*) AS c FROM ptm_meetings`);
  if (!existingPTM || parseInt(existingPTM.rows[0].c) === 0) {
    const ptms = [
      [1,'Progress Review – Term 1','2025-11-10 10:00:00','Rajesh Kumar','Mathematics','Room 101','completed'],
      [4,'Progress Review – Term 1','2025-11-10 10:30:00','Priya Sharma','Science','Room 102','completed'],
      [7,'Progress Review – Term 1','2025-11-10 11:00:00','Suresh Nair','English','Room 103','completed'],
      [1,'Unit Test 1 Feedback','2026-01-25 10:00:00','Rajesh Kumar','Mathematics','Room 101','scheduled'],
      [4,'Unit Test 1 Feedback','2026-01-25 10:30:00','Priya Sharma','Science','Room 102','scheduled'],
      [10,'Annual Progress Meeting','2026-03-28 11:00:00','Anitha Rao','Social Studies','Room 104','scheduled'],
    ];
    for (const [student_id,title,scheduled_at,teacher_name,teacher_subject,location,status] of ptms) {
      await q(`INSERT INTO ptm_meetings (student_id,title,scheduled_at,teacher_name,teacher_subject,location,status)
               VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [student_id,title,scheduled_at,teacher_name,teacher_subject,location,status]);
    }
    console.log('✅ PTM meetings seeded');
  } else {
    console.log('✅ PTM meetings already exist — skipping');
  }

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
