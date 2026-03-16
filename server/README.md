# Gurukul Student Portal – Server

## Quick Start
```
cd server
node server.js
```
Server runs at http://localhost:3000

## Default Login (Demo)
| Username | Password |
|---|---|
| rahul.kumar | gurukul123 |
| priya.sharma | gurukul123 |
| arjun.gowda | gurukul123 |

## Adding Students
Edit `data/students.json` – run this to generate a hashed password:
```
node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');console.log(s+':'+c.pbkdf2Sync('YOURPASSWORD',s,10000,64,'sha512').toString('hex'))"
```

## Google Sheets Sync
1. Copy `.env.example` to `.env`
2. Fill in GOOGLE_SHEET_ID and GOOGLE_API_KEY
3. POST to http://localhost:3000/api/admin/sync-sheets
