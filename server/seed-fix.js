/**
 * FIX SEED — corrects column mismatches for tables that failed in seed-all.js
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/tmp/gurukul_working.db');

const today = new Date();
const yyyymmdd = d => d.toLocaleDateString('en-CA');
const daysAgo  = n => { const d = new Date(today); d.setDate(d.getDate()-n); return yyyymmdd(d); };
const daysAhead= n => { const d = new Date(today); d.setDate(d.getDate()+n); return yyyymmdd(d); };
const nowStr = () => new Date().toISOString().replace('T',' ').substring(0,19);

// ─── ADMISSIONS ──────────────────────────────────────────────────────────────
console.log('Fixing admissions...');
db.prepare('DELETE FROM admissions').run();
const adm = [
  [1,'2026-02-14T10:00:00Z','Approved','Merit-based','2026-02-15','Arun','Verma','2015-06-12','Male','O+','9','St. Joseph School','8','82.5','Venkat Verma','9876543210','venkat@email.com','Business','Suma Verma','9876543211','15, MG Road, Bangalore','Bangalore','560001','Friend','Better facilities'],
  [2,'2026-02-20T11:00:00Z','Approved','Good academics','2026-02-21','Sneha','Pillai','2016-03-20','Female','A+','8','DPS Mysuru','7','91.0','Rajesh Pillai','9823456789','rajesh@email.com','Engineer','Rekha Pillai','9823456788','22, 3rd Cross, K.R. Nagar','Mysuru','571602','Website','Academic excellence'],
  [3,'2026-03-01T09:00:00Z','Pending',null,null,'Mohammed','Khan','2014-11-05','Male','B+','10','Kendriya Vidyalaya','9','78.0','Salim Khan','9845671234','salim@email.com','Government','Ayesha Khan','9845671235','12, Nazarbad, Mysuru','Mysuru','570001','Advertisement','Sports program'],
  [4,'2026-03-05T14:00:00Z','Pending',null,null,'Pooja','Hegde','2017-01-15','Female','AB+','7','St. Mary School','6','88.5','Mohan Hegde','9900112233','mohan@email.com','Teacher','Geetha Hegde','9900112234','5, Temple Road, Hunsur','Hunsur','571105','Walk-in','Close to home'],
  [5,'2026-03-08T10:30:00Z','Rejected','Seat unavailable for class','2026-03-09','Rohit','Singh','2015-08-22','Male','O-','9','Narayana School','8','85.0','Ravi Singh','9988776655','ravi@email.com','Doctor','Anita Singh','9988776654','88, Vivekananda Road, Mysuru','Mysuru','570004','Social Media','Good teachers'],
  [6,'2026-03-10T09:00:00Z','Approved','Scholarship granted','2026-03-11','Lakshmi','Reddy','2016-07-30','Female','A-','8','Saraswathi Vidyalaya','7','94.0','Krishna Reddy','9911223344','krishna@email.com','Farmer','Kamala Reddy','9911223345','Near Temple, T Narasipura','T Narasipura','571124','Relative','Quality education'],
];
for (const [id,sat,status,snote,sudate,fn,ln,dob,g,bg,grade,prev,lg,lp,faN,fam,fae,fao,moN,mom,addr,city,pin,hear,reason] of adm) {
  db.prepare(`INSERT INTO admissions(id,submitted_at,status,status_note,status_updated_at,first_name,last_name,dob,gender,blood_group,grade_applying,prev_school,last_grade,last_percentage,father_name,father_mobile,father_email,father_occupation,mother_name,mother_mobile,address,city,pin,hear_about,reason_admission) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,sat,status,snote,sudate,fn,ln,dob,g,bg,grade,prev,lg,lp,faN,fam,fae,fao,moN,mom,addr,city,pin,hear,reason);
}
console.log(`   ✓ ${db.prepare('SELECT COUNT(*) as n FROM admissions').get().n} admissions`);

// ─── LEAVE APPLICATIONS ──────────────────────────────────────────────────────
console.log('Fixing leave_applications...');
db.prepare('DELETE FROM leave_applications').run();
const leaves = [
  [1,'T001','teacher','Suresh Kumar','sick',daysAgo(20),daysAgo(19),2,'Fever and cold','Approved','Get well soon. Substitute arranged.',daysAgo(22),daysAgo(19)],
  [2,'T002','teacher','Priya Sharma','earned',daysAgo(10),daysAgo(10),1,'Family function','Approved','Approved',daysAgo(11),daysAgo(9)],
  [3,'T003','teacher','Ramesh Rao','earned',daysAgo(5),daysAgo(4),2,'Personal work','Pending','',daysAgo(5),null],
  [4,'T004','teacher','Kavitha Nair','sick',daysAgo(15),daysAgo(15),1,'Doctor visit','Approved','',daysAgo(16),daysAgo(14)],
  [5,'T005','teacher','Anand Murthy','earned',daysAhead(20),daysAhead(21),2,'Family event','Approved','Approved in advance',daysAgo(3),daysAgo(2)],
  [6,'STU001','student','Rahul Kumar','sick',daysAgo(8),daysAgo(8),1,'High fever - doctor certificate submitted','Approved','',daysAgo(9),daysAgo(7)],
  [7,'STU003','student','Arjun Gowda','earned',daysAgo(3),daysAgo(2),2,'Family emergency','Approved','',daysAgo(3),daysAgo(2)],
];
for (const [id,pid,ptype,pname,ltype,from,to,days,reason,status,note,applied,decided] of leaves) {
  db.prepare(`INSERT INTO leave_applications(id,person_id,person_type,person_name,leave_type,from_date,to_date,days,reason,status,admin_note,applied_at,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,pid,ptype,pname,ltype,from,to,days,reason,status,note,applied,decided);
}
console.log(`   ✓ ${db.prepare('SELECT COUNT(*) as n FROM leave_applications').get().n} leave applications`);

// ─── ANNOUNCEMENTS ───────────────────────────────────────────────────────────
console.log('Fixing announcements...');
db.prepare('DELETE FROM announcements').run();
const anns = [
  [1,'PTM – March 25, 2026','Parent-Teacher Meeting is scheduled for March 25. Time slots have been allocated by class. Parents will receive SMS confirmation. Please bring your ward\'s report card.','announcement','parent,student,teacher','admin',daysAgo(3),daysAhead(30),1],
  [2,'Annual Sports Day – April 5','Annual Sports Day will be held on April 5, 2026 at the school grounds. Participation forms must be submitted to class teachers by March 20.','announcement','student,teacher,parent','admin',daysAgo(2),daysAhead(40),1],
  [3,'Term 2 Fee Deadline – March 31','Term 2 fees are due by March 31. Parents with pending dues are requested to clear payments at the finance office immediately to avoid penalty.','alert','parent','finance',daysAgo(4),daysAhead(20),1],
  [4,'New Library Arrivals','Over 50 new books (Science, History, Fiction) have been added to the library. Students may borrow up to 2 books per week.','announcement','student,teacher','admin',daysAgo(1),daysAhead(60),1],
  [5,'Term 2 Exam Time Table Published','Term 2 Unit Test 1 begins April 20. Detailed time tables have been shared with class teachers and will be displayed on notice boards.','circular','student,teacher,parent','admin',daysAgo(1),daysAhead(45),1],
];
for (const [id,title,body,type,roles,by,created,expires,active] of anns) {
  db.prepare(`INSERT INTO announcements(id,title,body,type,target_roles,created_by,created_at,expires_at,is_active) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id,title,body,type,roles,by,created,expires,active);
}
console.log(`   ✓ ${db.prepare('SELECT COUNT(*) as n FROM announcements').get().n} announcements`);

// ─── NOTIFICATIONS ───────────────────────────────────────────────────────────
console.log('Fixing notifications...');
db.prepare('DELETE FROM notifications').run();
// notifications cols: id,user_id,role,title,message,type,link,is_read,created_at
const notifs = [
  [1,'admin','admin','Fee Reminder','Term 2 fees overdue for 2 students — action required','warning','/portal/finance-dashboard.html',0,daysAgo(2)],
  [2,'admin','admin','New Admission','Sneha Pillai\'s application has been approved','success','/portal/admin-dashboard.html',1,daysAgo(3)],
  [3,'admin','admin','Leave Request Pending','Ramesh Rao has applied for 2-day casual leave','info','/portal/admin-dashboard.html',0,daysAgo(1)],
  [4,'admin','admin','Exam Marks Entered','Term 1 Final exam marks entry complete — 75 records','success','/portal/modules-dashboard.html',1,daysAgo(5)],
  [5,'admin','admin','PTM Scheduled','Parent-Teacher Meeting confirmed for March 25','info','/portal/admin-dashboard.html',1,daysAgo(4)],
  [6,'T001','teacher','Attendance Reminder','Class 8-A attendance not marked for today','warning','/portal/teacher-dashboard.html',0,daysAgo(0)],
  [7,'T002','teacher','PTM Reminder','You have 5 PTM appointments on March 25','info','/portal/teacher-dashboard.html',0,daysAgo(1)],
  [8,'STU001','student','Fee Receipt','Term 1 fee payment receipt available','info','/portal/dashboard.html',1,daysAgo(5)],
  [9,'STU001','student','Exam Results','Term 1 Mid-Term results published','success','/portal/dashboard.html',1,daysAgo(10)],
];
for (const [id,uid,role,title,msg,type,link,is_read,created] of notifs) {
  db.prepare(`INSERT INTO notifications(id,user_id,role,title,message,type,link,is_read,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id,uid,role,title,msg,type,link,is_read,created);
}
console.log(`   ✓ ${db.prepare('SELECT COUNT(*) as n FROM notifications').get().n} notifications`);

// ─── BUDGET EXPENSES ─────────────────────────────────────────────────────────
console.log('Fixing budget_expenses...');
db.prepare('DELETE FROM budget_expenses').run();
// cols: id,dept_key,fiscal_year,month,description,amount,category,reference_id,reference_type,created_by,created_at
const expenses = [
  [1,'hr','2025-26','2026-02','Salary — Teaching Staff (5)',320000,'Salary',null,'payroll','admin',daysAgo(15)],
  [2,'hr','2025-26','2026-02','Salary — Support Staff (7)',98000,'Salary',null,'payroll','admin',daysAgo(15)],
  [3,'hr','2025-26','2026-02','PF Contributions',45600,'Benefits',null,'payroll','admin',daysAgo(14)],
  [4,'marketing','2025-26','2025-11','Facebook + Google Ads Campaign',42000,'Digital Marketing',null,'campaign','admin',daysAgo(120)],
  [5,'marketing','2025-26','2026-01','Newspaper Advertisements',18000,'Print Media',null,'campaign','admin',daysAgo(65)],
  [6,'marketing','2025-26','2026-03','Banners & Hoardings',12000,'Outdoor Advertising',null,'campaign','admin',daysAgo(12)],
  [7,'operations','2025-26','2026-03','Electricity Bill',28000,'Utilities',null,'bill','admin',daysAgo(5)],
  [8,'operations','2025-26','2026-03','Water & Sanitation',8500,'Utilities',null,'bill','admin',daysAgo(8)],
  [9,'operations','2025-26','2026-02','Stationery & Supplies',12000,'Office Supplies',null,'purchase','admin',daysAgo(22)],
  [10,'academic','2025-26','2025-06','Textbooks & Workbooks',45000,'Books',null,'purchase','admin',daysAgo(280)],
  [11,'academic','2025-26','2025-09','Teaching Aids & Materials',15000,'Academic Resources',null,'purchase','admin',daysAgo(185)],
  [12,'it','2025-26','2026-03','Internet & Broadband Bill',8400,'Internet',null,'bill','admin',daysAgo(5)],
  [13,'it','2025-26','2025-04','Software Licenses Annual',22000,'Software',null,'purchase','admin',daysAgo(340)],
  [14,'sports','2025-26','2025-08','Sports Equipment Purchase',28000,'Equipment',null,'purchase','admin',daysAgo(220)],
  [15,'sports','2025-26','2026-02','Sports Day Prizes',12000,'Events',null,'event','admin',daysAgo(22)],
  [16,'library','2025-26','2025-07','New Books Purchase — 80 titles',18000,'Books',null,'purchase','admin',daysAgo(250)],
  [17,'maintenance','2025-26','2026-01','Building Repairs — Classroom Wing',35000,'Repair',null,'work_order','admin',daysAgo(55)],
  [18,'maintenance','2025-26','2026-02','Furniture Repair',8000,'Repair',null,'work_order','admin',daysAgo(18)],
  [19,'transport','2025-26','2026-03','Diesel — Bus Fleet (March)',42000,'Fuel',null,'purchase','admin',daysAgo(5)],
  [20,'transport','2025-26','2026-02','Vehicle Maintenance & Service',18500,'Maintenance',null,'work_order','admin',daysAgo(20)],
  [21,'events','2025-26','2026-02','Annual Day 2026 — Full Expenses',48000,'Events',null,'event','admin',daysAgo(25)],
  [22,'science','2025-26','2026-01','Lab Chemicals & Consumables',22000,'Lab Supplies',null,'purchase','admin',daysAgo(55)],
];
for (const [id,dk,fy,month,desc,amt,cat,refId,refType,by,created] of expenses) {
  db.prepare(`INSERT INTO budget_expenses(id,dept_key,fiscal_year,month,description,amount,category,reference_id,reference_type,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,dk,fy,month,desc,amt,cat,refId,refType,by,created);
}
console.log(`   ✓ ${db.prepare('SELECT COUNT(*) as n FROM budget_expenses').get().n} budget expenses`);

// ─── JOURNAL ENTRIES (double-entry — one row per line) ──────────────────────
console.log('Fixing journal_entries...');
db.prepare('DELETE FROM journal_entries').run();
// cols: id,date,voucher_no,voucher_type,narration,account_code,debit,credit,reference,source,created_by,created_at
const jEntries = [
  // VCH-001: Fee collection
  [1,daysAgo(15),'VCH-2026-0001','Receipt','Fee collection Term 2 batch 1 — 5 students','1001',145000,0,'BATCH-T2-01','fee','finance',daysAgo(15)],
  [2,daysAgo(15),'VCH-2026-0001','Receipt','Fee collection Term 2 batch 1 — 5 students','4001',0,145000,'BATCH-T2-01','fee','finance',daysAgo(15)],
  // VCH-002: Salary
  [3,daysAgo(14),'VCH-2026-0002','Payment','Salary February 2026 — All Staff','5001',418000,0,'PAYROLL-FEB','payroll','admin',daysAgo(14)],
  [4,daysAgo(14),'VCH-2026-0002','Payment','Salary February 2026 — All Staff','1001',0,418000,'PAYROLL-FEB','payroll','admin',daysAgo(14)],
  // VCH-003: Electricity
  [5,daysAgo(10),'VCH-2026-0003','Payment','Electricity bill March 2026','5010',28000,0,'ELEC-MAR26','utilities','admin',daysAgo(10)],
  [6,daysAgo(10),'VCH-2026-0003','Payment','Electricity bill March 2026','1001',0,28000,'ELEC-MAR26','utilities','admin',daysAgo(10)],
  // VCH-004: Donation
  [7,daysAgo(7),'VCH-2026-0004','Receipt','Donation — Parents Association','1001',50000,0,'DON-2026-01','donation','admin',daysAgo(7)],
  [8,daysAgo(7),'VCH-2026-0004','Receipt','Donation — Parents Association','4010',0,50000,'DON-2026-01','donation','admin',daysAgo(7)],
  // VCH-005: Diesel
  [9,daysAgo(5),'VCH-2026-0005','Payment','Transport diesel March 2026','5020',42000,0,'DIESEL-MAR26','transport','admin',daysAgo(5)],
  [10,daysAgo(5),'VCH-2026-0005','Payment','Transport diesel March 2026','1001',0,42000,'DIESEL-MAR26','transport','admin',daysAgo(5)],
  // VCH-006: Fee collection batch 2
  [11,daysAgo(3),'VCH-2026-0006','Receipt','Fee collection Term 2 batch 2','1001',85000,0,'BATCH-T2-02','fee','finance',daysAgo(3)],
  [12,daysAgo(3),'VCH-2026-0006','Receipt','Fee collection Term 2 batch 2','4001',0,85000,'BATCH-T2-02','fee','finance',daysAgo(3)],
];
for (const [id,date,vno,vtype,narration,accode,debit,credit,ref,src,by,created] of jEntries) {
  db.prepare(`INSERT INTO journal_entries(id,date,voucher_no,voucher_type,narration,account_code,debit,credit,reference,source,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,date,vno,vtype,narration,accode,debit,credit,ref,src,by,created);
}
console.log(`   ✓ ${db.prepare('SELECT COUNT(*) as n FROM journal_entries').get().n} journal entries`);

// ─── FEE SCHEDULES ───────────────────────────────────────────────────────────
console.log('Fixing fee_schedules...');
db.prepare('DELETE FROM fee_schedules').run();
// cols: id,class,fee_type,amount,academic_yr,term  (NO created_at)
const feeSched = [
  [1,'6','Tuition Fee',6750,'2025-26','Term-1'], [2,'7','Tuition Fee',6750,'2025-26','Term-1'],
  [3,'8','Tuition Fee',7200,'2025-26','Term-1'], [4,'9','Tuition Fee',7650,'2025-26','Term-1'],
  [5,'10','Tuition Fee',8100,'2025-26','Term-1'],
  [6,'6','Tuition Fee',6750,'2025-26','Term-2'], [7,'7','Tuition Fee',6750,'2025-26','Term-2'],
  [8,'8','Tuition Fee',7200,'2025-26','Term-2'], [9,'9','Tuition Fee',7650,'2025-26','Term-2'],
  [10,'10','Tuition Fee',8100,'2025-26','Term-2'],
  [11,'All','Transport Fee',3600,'2025-26','Annual'],
  [12,'All','Lab Fee',800,'2025-26','Annual'],
  [13,'All','Library Fee',500,'2025-26','Annual'],
  [14,'All','Sports Fee',1200,'2025-26','Annual'],
  [15,'All','Annual Fee',1000,'2025-26','Annual'],
];
for (const [id,cls,type,amt,yr,term] of feeSched) {
  db.prepare(`INSERT INTO fee_schedules(id,class,fee_type,amount,academic_yr,term) VALUES(?,?,?,?,?,?)`)
    .run(id,cls,type,amt,yr,term);
}
console.log(`   ✓ ${db.prepare('SELECT COUNT(*) as n FROM fee_schedules').get().n} fee schedules`);

// ─── PTM MEETINGS ────────────────────────────────────────────────────────────
console.log('Fixing ptm_meetings...');
db.prepare('DELETE FROM ptm_meetings').run();
const now = new Date();
const ptms = [
  [1,'STU001','Term 2 Progress PTM',`${daysAhead(9)} 10:00:00`,'Suresh Kumar','Mathematics','Class 8-A Room','scheduled','Please bring report card','','parent',daysAgo(3),'Class 8-A'],
  [2,'STU002','Term 2 Progress PTM',`${daysAhead(9)} 10:30:00`,'Priya Sharma','English','Class 7-B Room','scheduled','','','parent',daysAgo(3),'Class 7-B'],
  [3,'STU003','Term 2 Progress PTM',`${daysAhead(9)} 11:00:00`,'Ramesh Rao','Science','Class 9-A Room','scheduled','Student doing well in practicals','','parent',daysAgo(3),'Class 9-A'],
  [4,'STU004','Term 2 Progress PTM',`${daysAhead(9)} 11:30:00`,'Suresh Kumar','Mathematics','Class 6-A Room','scheduled','','','parent',daysAgo(3),'Class 6-A'],
  [5,'STU005','Term 2 Progress PTM',`${daysAhead(9)} 14:00:00`,'Kavitha Nair','Social Studies','Class 10-A Room','scheduled','Focus on board exam prep','','parent',daysAgo(3),'Class 10-A'],
  [6,'STU001','Term 1 Review PTM',`${daysAgo(30)} 10:00:00`,'Suresh Kumar','Mathematics','Principal Office','completed','Student needs extra practice in algebra. Recommended tuition.','Parent acknowledged and will arrange tuition.','parent',daysAgo(35),'Class 8-A'],
];
for (const [id,sid,title,sat,tname,tsub,loc,status,anotes,pnotes,reqby,created,cname] of ptms) {
  db.prepare(`INSERT INTO ptm_meetings(id,student_id,title,scheduled_at,teacher_name,teacher_subject,location,status,admin_notes,parent_notes,requested_by,created_at,updated_at,class_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id,sid,title,sat,tname,tsub,loc,status,anotes,pnotes,reqby,created,nowStr(),cname);
}
console.log(`   ✓ ${db.prepare('SELECT COUNT(*) as n FROM ptm_meetings').get().n} PTM meetings`);

// ─── SUMMARY ─────────────────────────────────────────────────────────────────
console.log('\n✅ Fix seed complete! Final counts:');
const check = ['admissions','leave_applications','announcements','notifications','budget_expenses','journal_entries','fee_schedules','ptm_meetings','finance_fees','marketing_leads','marketing_campaigns','marketing_events','marketing_social_posts','transport_students','payroll_entries','exam_marks','exams'];
for (const t of check) {
  const c = db.prepare('SELECT COUNT(*) as n FROM '+t).get();
  console.log(`   ${t}: ${c.n} rows`);
}
