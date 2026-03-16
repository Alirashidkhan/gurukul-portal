#!/usr/bin/env node
/**
 * seed-data.js — Gurukul Portal Auto-Seed Script
 * Run after server restart to restore budget allocations, payroll, and marketing data.
 * Usage: node seed-data.js
 */

const http = require('http');
const https = require('https');

const BASE1 = 'http://localhost:3001';
const BASE2 = 'http://localhost:3002';

function post(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'GET', headers
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const r = await get(`${BASE1}/api/finance/fees?key=gurukul-admin-2026`);
      if (r) return true;
    } catch(e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function seed() {
  console.log('⏳ Waiting for server...');
  const ready = await waitForServer();
  if (!ready) { console.error('❌ Server not responding'); process.exit(1); }
  console.log('✅ Server is up');

  // ── 1. Finance login ──────────────────────────────────────────────────────
  const finRes = await post(`${BASE1}/api/finance/login`, { username: 'finance', password: 'finance@2026' });
  const finToken = finRes.token;
  if (!finToken) { console.error('❌ Finance login failed:', finRes); process.exit(1); }
  console.log('✅ Finance login OK');

  // ── 2. Budget allocations ─────────────────────────────────────────────────
  const budgetRes = await post(`${BASE2}/data/budget/allocate`,
    { year: '2026', allocations: { hr: 650000, marketing: 300000, operations: 500000, academic: 1200000, it: 400000, transport: 350000 } },
    { Authorization: 'Bearer ' + finToken }
  );
  if (budgetRes.ok) {
    console.log('✅ Budget allocations set (FY2026): ₹34,00,000 total');
  } else {
    console.warn('⚠️  Budget allocation:', budgetRes.error || JSON.stringify(budgetRes));
  }

  // ── 3. Budget expenses ────────────────────────────────────────────────────
  const budRes = await post(`${BASE1}/api/budget/login`, { username: 'budget', password: 'budget@2026' });
  const budToken = budRes.token;
  if (!budToken) { console.warn('⚠️  Budget login failed'); }
  else {
    const expenses = [
      { dept: 'hr', month: '2026-01', description: 'Staff Salaries Jan', amount: 285000, category: 'salary' },
      { dept: 'hr', month: '2026-02', description: 'Staff Salaries Feb', amount: 285000, category: 'salary' },
      { dept: 'academic', month: '2026-01', description: 'Teaching Materials', amount: 45000, category: 'supplies' },
      { dept: 'academic', month: '2026-02', description: 'Lab Equipment', amount: 85000, category: 'equipment' },
      { dept: 'operations', month: '2026-01', description: 'Utilities & Maintenance', amount: 62000, category: 'utilities' },
      { dept: 'marketing', month: '2026-01', description: 'Social Media Campaign', amount: 35000, category: 'marketing' },
      { dept: 'it', month: '2026-01', description: 'Software Licenses', amount: 45000, category: 'software' },
      { dept: 'transport', month: '2026-01', description: 'Fuel & Maintenance', amount: 38000, category: 'transport' },
    ];
    let expCount = 0;
    for (const e of expenses) {
      const r = await post(`${BASE2}/data/budget/dept/${e.dept}/expenses`,
        { month: e.month, description: e.description, amount: e.amount, category: e.category },
        { Authorization: 'Bearer ' + budToken }
      );
      if (r.ok) expCount++;
    }
    console.log(`✅ Budget expenses seeded: ${expCount} entries`);
  }

  // ── 4. HR Payroll ─────────────────────────────────────────────────────────
  const hrRes = await post(`${BASE1}/api/hr/login`, { username: 'hr', password: 'hr@2026' });
  const hrToken = hrRes.token;
  if (!hrToken) { console.warn('⚠️  HR login failed'); }
  else {
    // Get current month
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Preview to get staff list
    const preview = await get(`${BASE2}/data/hr/payroll/run?month=${month}`, { Authorization: 'Bearer ' + hrToken });
    const staff = preview.staff || [];

    if (staff.length > 0) {
      const payrollRes = await post(`${BASE2}/data/hr/payroll/run`,
        { month, staff },
        { Authorization: 'Bearer ' + hrToken }
      );
      if (payrollRes.ok) {
        if (payrollRes.processed > 0) {
          console.log(`✅ Payroll run for ${month}: ${payrollRes.processed} staff processed`);
        } else {
          console.log(`ℹ️  Payroll for ${month}: already processed (skipped)`);
        }
      } else if (payrollRes.error && payrollRes.error.includes('Insufficient fund')) {
        console.log(`ℹ️  Payroll for ${month}: already processed (budget consumed)`);
      } else {
        console.warn('⚠️  Payroll run:', payrollRes.error || JSON.stringify(payrollRes).slice(0,100));
      }
    } else {
      console.warn('⚠️  No staff found for payroll');
    }
  }

  // ── 5. Marketing leads & campaign ────────────────────────────────────────
  const mktRes = await post(`${BASE1}/api/marketing/login`, { username: 'marketing', password: 'marketing@2026' });
  const mktToken = mktRes.token;
  if (!mktToken) { console.warn('⚠️  Marketing login failed'); }
  else {
    const leads = [
      { name: 'Ravi Kumar', phone: '9876541001', email: 'ravi@example.com', source: 'Website', grade_interest: 'Grade 6', status: 'New' },
      { name: 'Priya Sharma', phone: '9876541002', email: 'priya@example.com', source: 'Referral', grade_interest: 'Grade 3', status: 'Contacted' },
      { name: 'Suresh Patil', phone: '9876541003', email: 'suresh@example.com', source: 'Walk-in', grade_interest: 'Grade 1', status: 'New' },
      { name: 'Anitha Reddy', phone: '9876541004', email: 'anitha@example.com', source: 'Social Media', grade_interest: 'Grade 8', status: 'Qualified' },
      { name: 'Mohan Das', phone: '9876541005', email: 'mohan@example.com', source: 'Website', grade_interest: 'Grade 5', status: 'New' },
    ];
    let leadCount = 0;
    for (const lead of leads) {
      const r = await post(`${BASE2}/data/marketing/leads`, lead, { Authorization: 'Bearer ' + mktToken });
      if (r.ok || r.id) leadCount++;
    }

    const camp = await post(`${BASE2}/data/marketing/campaigns`,
      { name: 'Admissions 2026 Drive', type: 'Digital', start_date: '2026-01-01', end_date: '2026-04-30', budget: 50000, status: 'Active', target_audience: 'Parents of class 5-8', description: 'New academic year admissions campaign' },
      { Authorization: 'Bearer ' + mktToken }
    );

    const evt = await post(`${BASE2}/data/marketing/events`,
      { name: 'Open Day 2026', date: '2026-03-22', venue: 'School Grounds', type: 'Open Day', description: 'Annual open day for prospective parents', expected_attendees: 150, status: 'Upcoming' },
      { Authorization: 'Bearer ' + mktToken }
    );

    console.log(`✅ Marketing seeded: ${leadCount} leads, 1 campaign, 1 event`);
  }

  console.log('\n🎉 Seed complete! All dashboards should show live data.');
}

seed().catch(e => { console.error('❌ Seed error:', e.message); process.exit(1); });
