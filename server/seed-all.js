/**
 * COMPREHENSIVE SEED SCRIPT — The Gurukul High
 * Seeds ALL empty tables with realistic, demo-ready data
 * Run: node server/seed-all.js
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/tmp/gurukul_working.db');

function run(sql, ...params) { try { db.prepare(sql).run(...params); } catch(e) { console.error('ERR:', sql.substring(0,60), e.message); } }
function all(sql) { return db.prepare(sql).all(); }

const today = new Date();
const yyyymmdd = d => d.toLocaleDateString('en-CA');
const daysAgo  = n => { const d = new Date(today); d.setDate(d.getDate()-n); return yyyymmdd(d); };
const daysAhead= n => { const d = new Date(today); d.setDate(d.getDate()+n); return yyyymmdd(d); };
const now = () => new Date().toISOString().replace('T',' ').substring(0,19);

console.log('🌱 Starting full database seed...\n');

// ─── 1. EXAMS (multiple across all classes) ──────────────────────────────────
console.log('1. Seeding exams...');
run(`DELETE FROM exams WHERE id > 0`);
run(`DELETE FROM exam_marks WHERE id > 0`);
const examsData = [
  [1, 'Term 1 – Unit Test 1', 'Unit Test', 'Term-1', 'All', 'All', daysAgo(60), daysAgo(58), 50, 18, '2025-26', 'Completed', 'admin'],
  [2, 'Term 1 – Mid-Term Examination', 'Mid Term', 'Term-1', 'All', 'All', daysAgo(30), daysAgo(25), 100, 35, '2025-26', 'Completed', 'admin'],
  [3, 'Term 1 – Final Examination', 'Final', 'Term-1', 'All', 'All', daysAgo(10), daysAgo(5), 100, 35, '2025-26', 'Completed', 'admin'],
  [4, 'Term 2 – Unit Test 1', 'Unit Test', 'Term-2', 'All', 'All', daysAhead(20), daysAhead(22), 50, 18, '2025-26', 'Upcoming', 'admin'],
];
for (const [id,name,type,term,cls,sec,sd,ed,tm,pm,yr,status,by] of examsData) {
  run(`INSERT OR REPLACE INTO exams(id,name,exam_type,term,class,section,start_date,end_date,total_marks,pass_marks,academic_yr,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,name,type,term,cls,sec,sd,ed,tm,pm,yr,status,by,now());
}
console.log('   ✓ 4 exams created');

// Exam marks for all students across all completed exams
const students = [
  {id:'STU001', name:'Rahul Kumar'},
  {id:'STU002', name:'Priya Sharma'},
  {id:'STU003', name:'Arjun Gowda'},
  {id:'STU004', name:'Divya Nair'},
  {id:'STU005', name:'Kiran Patel'},
];
const subjects = ['Mathematics','Science','English','Social Studies','Hindi'];
const gradeFor = (m,mx) => {
  const p = m/mx*100;
  if (p>=90) return 'A+'; if (p>=80) return 'A'; if (p>=70) return 'B+';
  if (p>=60) return 'B'; if (p>=50) return 'C'; if (p>=35) return 'D'; return 'F';
};
// Seed marks for exams 1, 2, 3 (completed)
let markId = 1;
for (const exam of examsData.slice(0,3)) {
  const [examId,,,,,,,,maxMarks] = exam;
  for (const stu of students) {
    for (const sub of subjects) {
      const base = 55 + Math.floor(Math.random()*35); // 55–90 range
      const marks = Math.min(maxMarks, Math.round(base * maxMarks / 100));
      const grade = gradeFor(marks, maxMarks);
      run(`INSERT OR REPLACE INTO exam_marks(id,exam_id,student_id,subject,marks,max_marks,grade,remarks,entered_by,entered_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        markId++, examId, stu.id, sub, marks, maxMarks, grade, '', 'T001', now());
    }
  }
}
console.log(`   ✓ ${markId-1} exam mark records created`);

// ─── 2. FINANCE FEES (payment records) ──────────────────────────────────────
console.log('2. Seeding finance fees...');
run(`DELETE FROM finance_fees WHERE id > 0`);
const feeTypes = ['Tuition Fee','Transport Fee','Library Fee','Lab Fee','Sports Fee','Annual Fee'];
const payModes = ['Cash','UPI','Cheque','NEFT'];
const classAnnualFees = {'6':15000,'7':15000,'8':16000,'9':17000,'10':18000};
const stuClasses = {'STU001':'8','STU002':'7','STU003':'9','STU004':'6','STU005':'10'};
let ffId = 1;
let receiptNo = 1001;
for (const stu of students) {
  const cls = stuClasses[stu.id];
  const annualFee = classAnnualFees[cls] || 15000;
  // Term 1 full payment
  run(`INSERT INTO finance_fees(id,student_id,fee_type,amount,academic_yr,month,paid_date,status,payment_mode,receipt_no,notes,recorded_at,term,submitted_by,verified_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ffId++, stu.id, 'Tuition Fee', Math.round(annualFee*0.45), '2025-26', 'April', daysAgo(180), 'Paid', payModes[ffId%4], `RCP-${receiptNo++}`, 'Term 1 tuition', now(), 'Term-1', 'finance', 'finance');
  run(`INSERT INTO finance_fees(id,student_id,fee_type,amount,academic_yr,month,paid_date,status,payment_mode,receipt_no,notes,recorded_at,term,submitted_by,verified_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ffId++, stu.id, 'Transport Fee', 3600, '2025-26', 'April', daysAgo(178), 'Paid', 'UPI', `RCP-${receiptNo++}`, 'Annual transport', now(), 'Term-1', 'finance', 'finance');
  // Annual fee
  run(`INSERT INTO finance_fees(id,student_id,fee_type,amount,academic_yr,month,paid_date,status,payment_mode,receipt_no,notes,recorded_at,term,submitted_by,verified_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ffId++, stu.id, 'Annual Fee', 1000, '2025-26', 'April', daysAgo(175), 'Paid', 'Cash', `RCP-${receiptNo++}`, 'Registration + annual', now(), 'Term-1', 'finance', 'finance');
  // Term 2 — some paid, some pending
  const term2Status = ffId % 3 === 0 ? 'Pending' : 'Paid';
  run(`INSERT INTO finance_fees(id,student_id,fee_type,amount,academic_yr,month,paid_date,status,payment_mode,receipt_no,notes,recorded_at,term,submitted_by,verified_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ffId++, stu.id, 'Tuition Fee', Math.round(annualFee*0.45), '2025-26', 'October', term2Status==='Paid'?daysAgo(90):null, term2Status, term2Status==='Paid'?'NEFT':null, term2Status==='Paid'?`RCP-${receiptNo++}`:`PEND-${receiptNo++}`, 'Term 2 tuition', now(), 'Term-2', 'finance', term2Status==='Paid'?'finance':null);
  // Lab fee
  run(`INSERT INTO finance_fees(id,student_id,fee_type,amount,academic_yr,month,paid_date,status,payment_mode,receipt_no,notes,recorded_at,term,submitted_by,verified_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ffId++, stu.id, 'Lab Fee', 800, '2025-26', 'June', daysAgo(150), 'Paid', 'Cash', `RCP-${receiptNo++}`, 'Science lab', now(), 'Term-1', 'finance', 'finance');
}
// Add a couple of overdue
run(`INSERT INTO finance_fees(id,student_id,fee_type,amount,academic_yr,month,paid_date,status,payment_mode,receipt_no,notes,recorded_at,term,submitted_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ffId++, 'STU003','Library Fee',500,'2025-26','January',null,'Overdue',null,`OVER-${receiptNo++}`,'Overdue since Jan',now(),'Term-2','finance');
run(`INSERT INTO finance_fees(id,student_id,fee_type,amount,academic_yr,month,paid_date,status,payment_mode,receipt_no,notes,recorded_at,term,submitted_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ffId++, 'STU005','Sports Fee',1200,'2025-26','December',null,'Overdue',null,`OVER-${receiptNo++}`,'Overdue since Dec',now(),'Term-2','finance');
console.log(`   ✓ ${ffId-1} fee records created`);

// ─── 3. ADMISSIONS ──────────────────────────────────────────────────────────
console.log('3. Seeding admissions...');
run(`DELETE FROM admissions WHERE id > 0`);
const admissionsData = [
  ['Arun', 'Verma', '2015-06-12', 'Male', 'O+', '9', 'St. Joseph School', '8', '82.5', 'Venkat Verma', '9876543210', 'venkat@email.com', 'Business', 'Suma Verma', '9876543211', 'Bangalore', '560001', 'Friend', 'Better facilities', 'Approved'],
  ['Sneha', 'Pillai', '2016-03-20', 'Female', 'A+', '8', 'DPS Mysuru', '7', '91.0', 'Rajesh Pillai', '9823456789', 'rajesh@email.com', 'Engineer', 'Rekha Pillai', '9823456788', 'K.R. Nagar', '571602', 'Website', 'Academic excellence', 'Approved'],
  ['Mohammed', 'Khan', '2014-11-05', 'Male', 'B+', '10', 'Kendriya Vidyalaya', '9', '78.0', 'Salim Khan', '9845671234', 'salim@email.com', 'Government', 'Ayesha Khan', '9845671235', 'Mysuru', '570001', 'Advertisement', 'Sports program', 'Pending'],
  ['Pooja', 'Hegde', '2017-01-15', 'Female', 'AB+', '7', 'St. Mary School', '6', '88.5', 'Mohan Hegde', '9900112233', 'mohan@email.com', 'Teacher', 'Geetha Hegde', '9900112234', 'Hunsur', '571105', 'Walk-in', 'Close to home', 'Pending'],
  ['Rohit', 'Singh', '2015-08-22', 'Male', 'O-', '9', 'Narayana School', '8', '85.0', 'Ravi Singh', '9988776655', 'ravi@email.com', 'Doctor', 'Anita Singh', '9988776654', 'Mysuru', '570004', 'Social Media', 'Good teachers', 'Rejected'],
  ['Lakshmi', 'Reddy', '2016-07-30', 'Female', 'A-', '8', 'Saraswathi Vidyalaya', '7', '94.0', 'Krishna Reddy', '9911223344', 'krishna@email.com', 'Farmer', 'Kamala Reddy', '9911223345', 'T Narasipura', '571124', 'Relative', 'Quality education', 'Approved'],
];
let admId = 1;
const admStatuses = ['Approved','Approved','Pending','Pending','Rejected','Approved'];
for (let i=0; i<admissionsData.length; i++) {
  const [fn,ln,dob,g,bg,grade,prev,lastG,lastP,faN,fam,fae,fao,moN,mom,addr,city,pin,hear,reason,status] = admissionsData[i];
  run(`INSERT INTO admissions(id,submitted_at,status,first_name,last_name,dob,gender,blood_group,grade_applying,prev_school,last_grade,last_percentage,father_name,father_mobile,father_email,father_occupation,mother_name,mother_mobile,address,city,pin,hear_about,reason_admission) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    admId++, daysAgo(30-i*4)+'T10:00:00.000Z', status, fn,ln,dob,g,bg,grade,prev,lastG,lastP,faN,fam,fae,fao,moN,mom,addr,city,pin,hear,reason);
}
console.log(`   ✓ ${admId-1} admissions created`);

// ─── 4. TRANSPORT STUDENTS ──────────────────────────────────────────────────
console.log('4. Seeding transport students...');
run(`DELETE FROM transport_students WHERE id > 0`);
const transportAssignments = [
  ['STU001', 1, 'K.R. Nagar Bus Stand', 3600],
  ['STU002', 2, 'Hunsur Road Junction', 3600],
  ['STU003', 1, 'Bannur Cross', 3600],
  ['STU004', 3, 'Jayanagar Circle', 4200],
  ['STU005', 2, 'Ring Road Stop', 3600],
];
for (const [sid,rid,stop,fee] of transportAssignments) {
  run(`INSERT INTO transport_students(student_id,route_id,stop,fee) VALUES(?,?,?,?)`, sid,rid,stop,fee);
}
console.log(`   ✓ ${transportAssignments.length} transport assignments created`);

// ─── 5. MARKETING LEADS ─────────────────────────────────────────────────────
console.log('5. Seeding marketing leads...');
run(`DELETE FROM marketing_leads WHERE id > 0`);
const stages = ['New Lead','Contacted','Visited','Applied','Enrolled','Lost'];
const sources = ['Website','Social Media','Walk-in','Referral','Advertisement','Phone Enquiry'];
const leadsData = [
  ['Amit Sharma', '9876501111', 'amit@gmail.com', '9', 'Website', 'Enrolled', 'Priya M', 'Good candidate'],
  ['Sunita Rao', '9876502222', 'sunita@gmail.com', '6', 'Referral', 'Applied', 'Priya M', 'Father is ex-student'],
  ['Deepak Patel', '9876503333', 'deepak@gmail.com', '7', 'Social Media', 'Visited', 'Raju K', 'Interested in sports'],
  ['Meena Iyer', '9876504444', 'meena@gmail.com', '8', 'Walk-in', 'Contacted', 'Raju K', 'Wants scholarship info'],
  ['Vikram Gowda', '9876505555', 'vikram@gmail.com', '10', 'Advertisement', 'Applied', 'Priya M', 'Strong academics'],
  ['Ritu Singh', '9876506666', 'ritu@gmail.com', '11', 'Phone Enquiry', 'New Lead', 'Raju K', 'Science stream interest'],
  ['Harsh Kumar', '9876507777', 'harsh@gmail.com', '9', 'Website', 'Enrolled', 'Priya M', 'Fee paid'],
  ['Kavya Nair', '9876508888', 'kavya@gmail.com', '6', 'Social Media', 'Visited', 'Raju K', 'Parent very interested'],
  ['Sanjay Reddy', '9876509999', 'sanjay@gmail.com', '7', 'Referral', 'Applied', 'Priya M', 'Board topper sibling'],
  ['Preethi Bhat', '9876510000', 'preethi@gmail.com', '8', 'Walk-in', 'Contacted', 'Raju K', 'Looking for hostel'],
  ['Nikhil Verma', '9876511111', 'nikhil@gmail.com', '12', 'Advertisement', 'New Lead', 'Priya M', ''],
  ['Ananya Das', '9876512222', 'ananya@gmail.com', '6', 'Website', 'Enrolled', 'Raju K', 'Full fee paid'],
  ['Rohan Mehta', '9876513333', 'rohan@gmail.com', '9', 'Referral', 'Lost', 'Priya M', 'Chose competitor school'],
  ['Sowmya Kaur', '9876514444', 'sowmya@gmail.com', '7', 'Social Media', 'Contacted', 'Raju K', ''],
  ['Teja Pillai', '9876515555', 'teja@gmail.com', '8', 'Phone Enquiry', 'Applied', 'Priya M', 'Needs transport'],
];
let leadId = 1;
for (const [name,phone,email,cls,src,stage,assigned,notes] of leadsData) {
  run(`INSERT INTO marketing_leads(id,name,phone,email,class_interested,source,stage,assigned_to,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    leadId++, name,phone,email,cls,src,stage,assigned,notes, daysAgo(45-leadId*2), daysAgo(5));
}
console.log(`   ✓ ${leadId-1} marketing leads created`);

// ─── 6. MARKETING CAMPAIGNS ─────────────────────────────────────────────────
console.log('6. Seeding marketing campaigns...');
run(`DELETE FROM marketing_campaigns WHERE id > 0`);
const campaigns = [
  ['Admissions 2025–26', 'Digital', 'Completed', 'Parents of Class 5–9', 80000, 12500, 45, daysAgo(120), daysAgo(60), 'Facebook & Google Ads'],
  ['Annual Day Promotion', 'Event', 'Completed', 'Local Community', 15000, 3200, 12, daysAgo(45), daysAgo(15), 'Newspaper + WhatsApp'],
  ['School Open Day Campaign', 'Offline', 'Active', 'Prospective Parents', 20000, 1800, 8, daysAgo(10), daysAhead(20), 'Banners + SMS blast'],
  ['CBSE Results Celebration', 'Social Media', 'Active', 'Current Parents', 5000, 8900, 28, daysAgo(7), daysAhead(14), 'Instagram + Facebook'],
  ['Admissions 2026–27', 'Digital', 'Planned', 'Parents of Class 4–9', 100000, 0, 0, daysAhead(30), daysAhead(90), 'Full digital campaign'],
];
let campId = 1;
for (const [name,type,status,target,budget,reach,conv,sd,ed,notes] of campaigns) {
  run(`INSERT INTO marketing_campaigns(id,name,type,status,target_audience,budget,reach,conversions,start_date,end_date,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    campId++,name,type,status,target,budget,reach,conv,sd,ed,notes,daysAgo(130),daysAgo(2));
}
console.log(`   ✓ ${campId-1} campaigns created`);

// ─── 7. MARKETING EVENTS ────────────────────────────────────────────────────
console.log('7. Seeding marketing events...');
run(`DELETE FROM marketing_events WHERE id > 0`);
const events = [
  ['Annual Day 2025', 'Cultural', daysAgo(20), 'School Auditorium', 'Grand annual cultural event with performances', 280, 265, 'Completed'],
  ['Science Fair 2025', 'Academic', daysAgo(45), 'School Grounds', 'Inter-class science project exhibition', 150, 140, 'Completed'],
  ['Open House – Jan 2026', 'Admission', daysAgo(10), 'School Campus', 'Campus tour for prospective parents', 85, 72, 'Completed'],
  ['Sports Day 2026', 'Sports', daysAhead(15), 'School Ground', 'Annual inter-house sports competition', 320, 0, 'Upcoming'],
  ['Open House – Mar 2026', 'Admission', daysAhead(5), 'School Campus', 'Campus tour for prospective parents', 60, 0, 'Upcoming'],
  ['Parent-Teacher Meet', 'Academic', daysAhead(25), 'Classrooms', 'Term 2 PTM for all classes', 200, 0, 'Upcoming'],
];
let evtId = 1;
for (const [name,type,date,venue,desc,reg,att,status] of events) {
  run(`INSERT INTO marketing_events(id,name,type,event_date,venue,description,registrations,attendees,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    evtId++,name,type,date,venue,desc,reg,att,status,daysAgo(60),daysAgo(1));
}
console.log(`   ✓ ${evtId-1} events created`);

// ─── 8. MARKETING SOCIAL POSTS ──────────────────────────────────────────────
console.log('8. Seeding social posts...');
run(`DELETE FROM marketing_social_posts WHERE id > 0`);
const posts = [
  ['Facebook', '🎉 Congratulations to all our Class 10 students who scored above 90% in Unit Test! #GurkulProud #Excellence', daysAgo(3), 'Published', 2400, 187],
  ['Instagram', '📚 Admissions Open for 2026–27! Limited seats available. Visit us at K.R. Nagar, Mysuru. DM for details. #GurkulAdmissions', daysAgo(5), 'Published', 3100, 245],
  ['WhatsApp', 'Dear Parents, reminder: Science Fair is coming up next month. Please encourage your ward to participate. - The Gurukul High', daysAgo(7), 'Published', 1850, 310],
  ['Facebook', '🏆 Our students shine at District Science Olympiad! 3 Gold medals, 2 Silver. #ScienceOlympiad #Mysuru', daysAgo(12), 'Published', 1920, 156],
  ['Instagram', '🌟 Open House this Saturday! Come meet our faculty and see our world-class facilities. Register at gurukul.edu.in', daysAhead(2), 'Scheduled', 0, 0],
  ['Facebook', '📝 PTM scheduled for March 25. All parents are requested to attend. Check your registered email for time slot. #PTM', daysAhead(5), 'Scheduled', 0, 0],
];
let postId = 1;
for (const [plat,content,date,status,reach,eng] of posts) {
  run(`INSERT INTO marketing_social_posts(id,platform,content,scheduled_date,status,reach,engagement,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    postId++,plat,content,date,status,reach,eng,daysAgo(20),daysAgo(1));
}
console.log(`   ✓ ${postId-1} social posts created`);

// ─── 9. DEPARTMENT BUDGETS ──────────────────────────────────────────────────
console.log('9. Seeding department budgets...');
const budgetAllocations = {
  'hr':          { name:'Human Resources',       alloc:850000 },
  'marketing':   { name:'Marketing',             alloc:200000 },
  'operations':  { name:'Operations & Admin',    alloc:450000 },
  'academic':    { name:'Academic & Curriculum', alloc:320000 },
  'it':          { name:'IT & Infrastructure',   alloc:180000 },
  'sports':      { name:'Sports & Extra-Curr',   alloc:120000 },
  'library':     { name:'Library',               alloc:60000  },
  'maintenance': { name:'Maintenance',           alloc:250000 },
  'transport':   { name:'Transport',             alloc:340000 },
  'science':     { name:'Science Labs',          alloc:150000 },
  'events':      { name:'Events & Functions',    alloc:90000  },
  'admin':       { name:'Administration',        alloc:130000 },
};
for (const [key, {name, alloc}] of Object.entries(budgetAllocations)) {
  run(`UPDATE department_budgets SET allocated_amount=?, set_by='admin', updated_at=? WHERE dept_key=? AND fiscal_year='2025-26'`,
    alloc, yyyymmdd(today), key);
  // Insert if not exists
  run(`INSERT OR IGNORE INTO department_budgets(dept_key,dept_name,fiscal_year,allocated_amount,notes,set_by,updated_at) VALUES(?,?,?,?,?,?,?)`,
    key, name, '2025-26', alloc, '', 'admin', yyyymmdd(today));
}
console.log(`   ✓ Budget allocations set for 12 departments`);

// ─── 10. BUDGET EXPENSES ────────────────────────────────────────────────────
console.log('10. Seeding budget expenses...');
run(`DELETE FROM budget_expenses WHERE id > 0`);
const expenseData = [
  ['hr', 'Salary — Teaching Staff', 320000, daysAgo(15), 'Bank Transfer', 'T001'],
  ['hr', 'Salary — Support Staff',  98000,  daysAgo(15), 'Bank Transfer', 'T001'],
  ['hr', 'PF Contributions',        45600,  daysAgo(14), 'Bank Transfer', 'admin'],
  ['marketing', 'Facebook Ads — Admission Campaign', 42000, daysAgo(90), 'Online', 'admin'],
  ['marketing', 'Newspaper Advertisements', 18000, daysAgo(45), 'Cheque', 'admin'],
  ['marketing', 'Banners & Hoardings', 12000, daysAgo(12), 'Cash', 'admin'],
  ['operations', 'Electricity Bill — March', 28000, daysAgo(5), 'NEFT', 'admin'],
  ['operations', 'Water & Sanitation', 8500, daysAgo(8), 'Cash', 'admin'],
  ['operations', 'Stationery & Supplies', 12000, daysAgo(20), 'Cash', 'admin'],
  ['academic', 'Textbooks & Workbooks', 45000, daysAgo(60), 'Cheque', 'T001'],
  ['academic', 'Teaching Aids', 15000, daysAgo(40), 'Online', 'T001'],
  ['it', 'Internet & Broadband', 8400, daysAgo(5), 'Auto Debit', 'admin'],
  ['it', 'Software Licenses', 22000, daysAgo(30), 'Online', 'admin'],
  ['sports', 'Sports Equipment', 28000, daysAgo(50), 'Cash', 'admin'],
  ['sports', 'Sports Day Prizes', 12000, daysAgo(22), 'Cash', 'admin'],
  ['library', 'New Book Purchases', 18000, daysAgo(45), 'Cheque', 'T003'],
  ['maintenance', 'Building Repairs', 35000, daysAgo(30), 'Cheque', 'admin'],
  ['maintenance', 'Furniture Repair', 8000, daysAgo(18), 'Cash', 'admin'],
  ['transport', 'Diesel — Bus Fleet', 42000, daysAgo(5), 'Cash', 'admin'],
  ['transport', 'Vehicle Maintenance', 18500, daysAgo(20), 'Cheque', 'admin'],
  ['events', 'Annual Day Expenses', 48000, daysAgo(25), 'Multiple', 'admin'],
  ['science', 'Lab Chemicals & Consumables', 22000, daysAgo(35), 'Cheque', 'T003'],
];
let expId = 1;
for (const [dept,desc,amt,date,mode,by] of expenseData) {
  run(`INSERT INTO budget_expenses(id,dept_key,description,amount,expense_date,payment_mode,added_by,created_at) VALUES(?,?,?,?,?,?,?,?)`,
    expId++, dept, desc, amt, date, mode, by, now());
}
console.log(`   ✓ ${expId-1} expense records created`);

// ─── 11. LEAVE APPLICATIONS ─────────────────────────────────────────────────
console.log('11. Seeding leave applications...');
run(`DELETE FROM leave_applications WHERE id > 0`);
const leaveData = [
  ['T001','teacher','Suresh Kumar','Sick Leave', daysAgo(20), daysAgo(19), 2,'Fever and cold','Approved','Approved',daysAgo(19)],
  ['T002','teacher','Priya Sharma','Personal Leave',daysAgo(10),daysAgo(10),1,'Family function','Approved','Get sub',daysAgo(9)],
  ['T003','teacher','Ramesh Rao','Casual Leave',daysAgo(5),daysAgo(4),2,'Personal work','Pending','',null],
  ['T004','teacher','Kavitha Nair','Sick Leave',daysAgo(15),daysAgo(15),1,'Doctor visit','Approved','',daysAgo(14)],
  ['T005','teacher','Anand Murthy','Maternity Leave',daysAhead(20),daysAhead(110),91,'Maternity','Approved','Approved',daysAgo(3)],
  ['STU001','student','Rahul Kumar','Medical Leave',daysAgo(8),daysAgo(8),1,'Fever','Approved','',daysAgo(7)],
  ['STU003','student','Arjun Gowda','Family Emergency',daysAgo(3),daysAgo(2),2,'Family emergency','Approved','',daysAgo(2)],
];
let leaveId = 1;
for (const [pid,ptype,pname,ltype,from,to,days,reason,status,note,decided] of leaveData) {
  run(`INSERT INTO leave_applications(id,person_id,person_type,person_name,leave_type,from_date,to_date,days,reason,status,admin_note,applied_at,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    leaveId++,pid,ptype,pname,ltype,from,to,days,reason,status,note,daysAgo(days+2),decided);
}
console.log(`   ✓ ${leaveId-1} leave applications created`);

// ─── 12. PAYROLL ENTRIES ────────────────────────────────────────────────────
console.log('12. Seeding payroll entries...');
run(`DELETE FROM payroll_entries WHERE id > 0`);
const payrollMonth = '2026-02'; // February 2026
const staffPayroll = [
  ['T001','teacher',22,22,0,45000,18000,2250,1500,2250,69000,5400,0,0,0,0,0,0,500,64100],
  ['T002','teacher',22,20,2,38000,15200,1900,1500,1900,58500,4560,0,0,0,2400,2400,0,400,51140],
  ['T003','teacher',22,22,0,42000,16800,2100,1500,2100,64500,5040,0,0,0,0,0,0,450,59010],
  ['T004','teacher',22,21,1,35000,14000,1750,1500,1750,54000,4200,0,0,0,1190,1190,0,350,48860],
  ['T005','teacher',22,22,0,25000,10000,1250,1500,1250,39000,3000,0,0,500,0,3500,0,300,35500],
  ['SS001','support',26,26,0,18000,7200,900,800,900,27800,2160,0,0,0,0,2160,0,200,25440],
  ['SS002','support',26,25,1,15000,6000,750,800,750,23300,1800,0,0,0,430,2230,0,150,21220],
];
let payId = 1;
for (const [sid,stype,wd,pd,lop,basic,hra,da,transport,medical,gross,pf,esi,tds,late,lopD,totalD,bonus,net] of staffPayroll) {
  run(`INSERT INTO payroll_entries(id,staff_id,staff_type,month,working_days,present_days,lop_days,basic,hra,da,transport,medical,gross,pf_deduction,esi_deduction,tds_deduction,late_deduction,lop_deduction,total_deductions,bonus,net_pay,status,processed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    payId++,sid,stype,payrollMonth,wd,pd,lop,basic,hra,da,transport,medical,gross,pf,esi,tds,late,lopD,totalD,bonus,net,'Paid',daysAgo(14));
}
console.log(`   ✓ ${payId-1} payroll entries created`);

// ─── 13. ANNOUNCEMENTS ──────────────────────────────────────────────────────
console.log('13. Seeding announcements...');
run(`DELETE FROM announcements WHERE id > 0`);
const announcements = [
  ['PTM Scheduled for March 25', 'Parent-Teacher Meeting is scheduled for March 25, 2026. All parents are requested to attend the session for their ward. Time slots will be communicated via SMS.', 'info', 'parent,student,teacher', 'admin', daysAhead(30)],
  ['Annual Sports Day – April 5', 'Annual Sports Day will be held on April 5, 2026 at the school grounds. Students participating in events should submit their forms to the class teacher by March 20.', 'event', 'student,teacher,parent', 'admin', daysAhead(40)],
  ['Term 2 Fee Due Reminder', 'Term 2 fees are due by March 31. Parents who have not paid are requested to clear dues at the finance office immediately.', 'warning', 'parent', 'finance', daysAhead(20)],
  ['New Library Books Available', 'Over 50 new books have been added to the school library. Students are encouraged to borrow and enhance their reading.', 'info', 'student,teacher', 'admin', daysAhead(25)],
  ['Exam Time Table – Term 2', 'Term 2 Unit Test 1 is scheduled to begin April 20. The detailed time table has been shared with all class teachers.', 'academic', 'student,teacher,parent', 'admin', daysAhead(35)],
];
let annId = 1;
for (const [title,body,type,roles,by,exp] of announcements) {
  run(`INSERT INTO announcements(id,title,body,type,target_roles,created_by,created_at,expires_at,is_active) VALUES(?,?,?,?,?,?,?,?,?)`,
    annId++,title,body,type,roles,by,daysAgo(3),exp,1);
}
console.log(`   ✓ ${annId-1} announcements created`);

// ─── 14. PTM MEETINGS ───────────────────────────────────────────────────────
console.log('14. Seeding PTM meetings...');
run(`DELETE FROM ptm_meetings WHERE id > 0`);
const ptmData = [
  ['STU001','PTM – Term 2 Progress',daysAhead(9)+' 10:00','Suresh Kumar','Mathematics','Class 8-A','Scheduled','','Please bring the report card','parent','Class 8-A'],
  ['STU002','PTM – Term 2 Progress',daysAhead(9)+' 10:30','Priya Sharma','English','Class 7-B','Scheduled','','','parent','Class 7-B'],
  ['STU003','PTM – Term 2 Progress',daysAhead(9)+' 11:00','Ramesh Rao','Science','Class 9-A','Scheduled','','','parent','Class 9-A'],
  ['STU004','PTM – Term 2 Progress',daysAhead(9)+' 11:30','Suresh Kumar','Mathematics','Class 6-A','Scheduled','','','parent','Class 6-A'],
  ['STU005','PTM – Term 2 Progress',daysAhead(9)+' 14:00','Kavitha Nair','Social Studies','Class 10-A','Scheduled','','','parent','Class 10-A'],
  ['STU001','Term 1 Review Meet',daysAgo(30)+' 10:00','Suresh Kumar','Mathematics','Class 8-A','Completed','Student needs more practice in algebra','Noted','parent','Class 8-A'],
];
let ptmId = 1;
for (const [sid,title,sat,tname,tsub,loc,status,anotes,pnotes,reqby,cname] of ptmData) {
  run(`INSERT INTO ptm_meetings(id,student_id,title,scheduled_at,teacher_name,teacher_subject,location,status,admin_notes,parent_notes,requested_by,created_at,updated_at,class_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ptmId++,sid,title,sat,tname,tsub,loc,status,anotes,pnotes,reqby,daysAgo(5),now(),cname);
}
console.log(`   ✓ ${ptmId-1} PTM meetings created`);

// ─── 15. JOURNAL ENTRIES (Accounting) ───────────────────────────────────────
console.log('15. Seeding journal entries...');
run(`DELETE FROM journal_entries WHERE id > 0`);
const journals = [
  [daysAgo(15),'Receipt', 'Fee collection — Term 2 batch 1', '[[{"account_id":1,"account_name":"Cash & Bank","debit":145000,"credit":0},{"account_id":10,"account_name":"Fee Income","debit":0,"credit":145000}]]', 'finance', 1],
  [daysAgo(14),'Payment', 'Salary disbursement — February 2026', '[[{"account_id":5,"account_name":"Salary Expense","debit":320000,"credit":0},{"account_id":1,"account_name":"Cash & Bank","debit":0,"credit":320000}]]', 'admin', 2],
  [daysAgo(10),'Payment', 'Electricity bill payment', '[[{"account_id":6,"account_name":"Utilities Expense","debit":28000,"credit":0},{"account_id":1,"account_name":"Cash & Bank","debit":0,"credit":28000}]]', 'admin', 3],
  [daysAgo(7), 'Receipt', 'Donation received — Parents Association', '[[{"account_id":1,"account_name":"Cash & Bank","debit":50000,"credit":0},{"account_id":12,"account_name":"Donations Income","debit":0,"credit":50000}]]', 'admin', 4],
  [daysAgo(5), 'Payment', 'Transport diesel expense', '[[{"account_id":7,"account_name":"Transport Expense","debit":42000,"credit":0},{"account_id":1,"account_name":"Cash & Bank","debit":0,"credit":42000}]]', 'admin', 5],
  [daysAgo(3), 'Receipt', 'Fee collection — Term 2 batch 2', '[[{"account_id":1,"account_name":"Cash & Bank","debit":85000,"credit":0},{"account_id":10,"account_name":"Fee Income","debit":0,"credit":85000}]]', 'finance', 6],
];
let jrnId = 1;
for (const [date,vtype,narration,lines,by,ref] of journals) {
  run(`INSERT INTO journal_entries(id,date,voucher_type,narration,lines,entered_by,voucher_ref,created_at) VALUES(?,?,?,?,?,?,?,?)`,
    jrnId++, date, vtype, narration, lines, by, `VCH-2026-${String(ref).padStart(4,'0')}`, now());
}
console.log(`   ✓ ${jrnId-1} journal entries created`);

// ─── 16. NOTIFICATIONS ──────────────────────────────────────────────────────
console.log('16. Seeding notifications...');
run(`DELETE FROM notifications WHERE id > 0`);
const notifs = [
  ['Fee Reminder', 'Term 2 fees due for 2 students', 'warning', 'admin', 0],
  ['New Admission', 'Sneha Pillai application approved', 'success', 'admin', 0],
  ['PTM Scheduled', 'PTM set for March 25 - 156 parents notified', 'info', 'admin', 1],
  ['Leave Request', 'Ramesh Rao applied for casual leave', 'info', 'admin', 0],
  ['Exam Marks', 'Term 1 Final marks entry complete', 'success', 'admin', 1],
];
let notifId = 1;
for (const [title,msg,type,for_role,is_read] of notifs) {
  run(`INSERT INTO notifications(id,title,message,type,for_role,is_read,created_at) VALUES(?,?,?,?,?,?,?)`,
    notifId++,title,msg,type,for_role,is_read,daysAgo(notifId));
}
console.log(`   ✓ ${notifId-1} notifications created`);

// ─── 17. FEE SCHEDULES ──────────────────────────────────────────────────────
console.log('17. Seeding fee schedules...');
run(`DELETE FROM fee_schedules WHERE id > 0`);
const feeSchedules = [
  ['6','Tuition Fee',6750,'2025-26','Term-1'],['7','Tuition Fee',6750,'2025-26','Term-1'],
  ['8','Tuition Fee',7200,'2025-26','Term-1'],['9','Tuition Fee',7650,'2025-26','Term-1'],
  ['10','Tuition Fee',8100,'2025-26','Term-1'],
  ['6','Tuition Fee',6750,'2025-26','Term-2'],['7','Tuition Fee',6750,'2025-26','Term-2'],
  ['8','Tuition Fee',7200,'2025-26','Term-2'],['9','Tuition Fee',7650,'2025-26','Term-2'],
  ['10','Tuition Fee',8100,'2025-26','Term-2'],
  ['All','Transport Fee',3600,'2025-26','Annual'],
  ['All','Lab Fee',800,'2025-26','Annual'],
  ['All','Library Fee',500,'2025-26','Annual'],
  ['All','Sports Fee',1200,'2025-26','Annual'],
  ['All','Annual Fee',1000,'2025-26','Annual'],
];
let fsId = 1;
for (const [cls,type,amt,yr,term] of feeSchedules) {
  run(`INSERT INTO fee_schedules(id,class,fee_type,amount,academic_yr,term,created_at) VALUES(?,?,?,?,?,?,?)`,
    fsId++,cls,type,amt,yr,term,now());
}
console.log(`   ✓ ${fsId-1} fee schedules created`);

// ─── FINAL SUMMARY ──────────────────────────────────────────────────────────
console.log('\n✅ Full seed complete! Summary:');
const tables = ['finance_fees','marketing_leads','marketing_campaigns','marketing_events','marketing_social_posts','admissions','transport_students','leave_applications','payroll_entries','exam_marks','exams','announcements','department_budgets','ptm_meetings','journal_entries','notifications','fee_schedules','budget_expenses'];
for (const t of tables) {
  try {
    const c = db.prepare('SELECT COUNT(*) as n FROM '+t).get();
    console.log(`   ${t}: ${c.n} rows`);
  } catch(e) { console.log(`   ${t}: ERROR`); }
}
