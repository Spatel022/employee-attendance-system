const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const PRODUCTION = !!process.env.DATABASE_URL;
const SECRET = process.env.JWT_SECRET || (PRODUCTION ? null : 'local-development-secret-change-me');
if (PRODUCTION && !SECRET) throw new Error('JWT_SECRET is required in production');
const DATA_FILE = path.join(__dirname, 'attendance-data.json');

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const pool = PRODUCTION ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, max: 10 }) : null;

const iso = () => new Date().toISOString();
const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const mins = (a, b) => Math.max(0, Math.floor((new Date(b) - new Date(a)) / 60000));
const nextId = items => items.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
function calc(a) {
  const end = a.check_out || iso();
  const office = mins(a.check_in, end);
  const lunch = a.lunch_start ? mins(a.lunch_start, a.lunch_end || end) : 0;
  const working = Math.max(0, office - lunch);
  return { office_minutes: office, lunch_minutes: lunch, working_minutes: working, overtime_minutes: Math.max(0, working - 540) };
}

function auth(role) {
  return (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return res.sendStatus(401);
      const u = jwt.verify(token, SECRET);
      if (role && u.role !== role) return res.sendStatus(403);
      req.user = u;
      next();
    } catch {
      res.sendStatus(401);
    }
  };
}
const sign = (role, id) => jwt.sign({ role, id }, SECRET, { expiresIn: '12h' });

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!String(stored).startsWith('scrypt:')) return String(password) === String(stored);
  const [, salt, expected] = String(stored).split(':');
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

const localDefaults = () => ({
  admin: {
    id: 1,
    email: process.env.ADMIN_EMAIL || 'admin@example.com',
    password: process.env.ADMIN_PASSWORD || 'admin123'
  },
  employees: [],
  attendance: [],
  leaves: []
});

function loadLocal() {
  if (!fs.existsSync(DATA_FILE)) {
    const data = localDefaults();
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return data;
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data.employees ||= [];
  data.attendance ||= [];
  data.leaves ||= [];
  data.admin ||= localDefaults().admin;
  return data;
}
function saveLocal(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

async function dbInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      check_in TIMESTAMPTZ NOT NULL,
      lunch_start TIMESTAMPTZ,
      lunch_end TIMESTAMPTZ,
      check_out TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(employee_id, date)
    );
    CREATE TABLE IF NOT EXISTS leaves (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('full','half')),
      half_day TEXT,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      admin_note TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS attendance_date_idx ON attendance(date);
    CREATE INDEX IF NOT EXISTS leaves_dates_idx ON leaves(start_date,end_date);
  `);
  const existing = await pool.query('SELECT id FROM admins LIMIT 1');
  if (!existing.rowCount) {
    const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    if (!email || !password) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required when initializing production database');
    await pool.query('INSERT INTO admins (email,password_hash) VALUES ($1,$2)', [email, hashPassword(password)]);
  }
}

async function getAdmin() {
  if (!PRODUCTION) return loadLocal().admin;
  const r = await pool.query('SELECT id,email,password_hash FROM admins ORDER BY id LIMIT 1');
  return r.rows[0] || null;
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/employee', (req, res) => res.sendFile(path.join(__dirname, 'public', 'employee.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/health', async (req, res) => {
  try {
    if (PRODUCTION) await pool.query('SELECT 1');
    res.json({ ok: true, storage: PRODUCTION ? 'postgresql' : 'local-json' });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!PRODUCTION) {
      const data = loadLocal();
      const a = data.admin;
      if (!a || a.email !== email || !verifyPassword(password, a.password)) return res.status(401).json({ error: 'Invalid admin credentials' });
      if (!String(a.password).startsWith('scrypt:')) { a.password = hashPassword(a.password); saveLocal(data); }
      return res.json({ token: sign('admin', 1), admin: { id: 1, email: a.email } });
    }
    const a = await getAdmin();
    if (!a || a.email !== email || !verifyPassword(password, a.password_hash)) return res.status(401).json({ error: 'Invalid admin credentials' });
    res.json({ token: sign('admin', a.id), admin: { id: a.id, email: a.email } });
  } catch (e) { res.status(500).json({ error: 'Login failed' }); }
});

app.post('/api/employee/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!PRODUCTION) {
      const data = loadLocal();
      const e = data.employees.find(x => x.email === email && x.active && verifyPassword(password, x.password));
      if (!e) return res.status(401).json({ error: 'Invalid employee credentials' });
      if (!String(e.password).startsWith('scrypt:')) { e.password = hashPassword(e.password); saveLocal(data); }
      return res.json({ token: sign('employee', e.id), employee: { id:e.id,name:e.name,email:e.email,active:e.active } });
    }
    const r = await pool.query('SELECT id,name,email,active,password_hash FROM employees WHERE email=$1 AND active=true LIMIT 1', [email]);
    const e = r.rows[0];
    if (!e || !verifyPassword(password, e.password_hash)) return res.status(401).json({ error: 'Invalid employee credentials' });
    res.json({ token: sign('employee', e.id), employee: { id:e.id,name:e.name,email:e.email,active:e.active } });
  } catch { res.status(500).json({ error: 'Login failed' }); }
});

async function findTodayAttendance(employeeId) {
  if (!PRODUCTION) {
    const data = loadLocal();
    return data.attendance.find(x => x.employee_id === employeeId && x.date === day()) || null;
  }
  const r = await pool.query('SELECT * FROM attendance WHERE employee_id=$1 AND date=$2 LIMIT 1', [employeeId, day()]);
  return r.rows[0] || null;
}

app.get('/api/employee/today', auth('employee'), async (req,res) => {
  try { const a = await findTodayAttendance(req.user.id); res.json(a ? { ...a, ...calc(a) } : null); } catch { res.status(500).json({error:'Could not load attendance'}); }
});

app.post('/api/employee/check-in', auth('employee'), async (req,res) => {
  try {
    const t = iso();
    if (!PRODUCTION) {
      const data=loadLocal();
      if (data.attendance.some(x=>x.employee_id===req.user.id && x.date===day())) return res.status(400).json({error:'Already checked in today'});
      const a={id:nextId(data.attendance),employee_id:req.user.id,date:day(),check_in:t,lunch_start:null,lunch_end:null,check_out:null,created_at:t,updated_at:t};data.attendance.push(a);saveLocal(data);return res.json({id:a.id,check_in:t});
    }
    const r=await pool.query('INSERT INTO attendance(employee_id,date,check_in) VALUES($1,$2,$3) ON CONFLICT(employee_id,date) DO NOTHING RETURNING id,check_in',[req.user.id,day(),t]);
    if(!r.rowCount)return res.status(400).json({error:'Already checked in today'});
    res.json(r.rows[0]);
  } catch { res.status(500).json({error:'Could not check in'}); }
});

app.post('/api/employee/lunch-start', auth('employee'), async (req,res) => {
  try {
    const a=await findTodayAttendance(req.user.id);
    if(!a||a.check_out||a.lunch_start)return res.status(400).json({error:'Cannot start lunch'});
    const t=iso();
    if(!PRODUCTION){const data=loadLocal();const x=data.attendance.find(v=>v.id===a.id);x.lunch_start=t;x.updated_at=t;saveLocal(data);return res.json({ok:true});}
    await pool.query('UPDATE attendance SET lunch_start=$1,updated_at=NOW() WHERE id=$2',[t,a.id]);res.json({ok:true});
  } catch { res.status(500).json({error:'Could not start lunch'}); }
});

app.post('/api/employee/lunch-end', auth('employee'), async (req,res) => {
  try {
    const a=await findTodayAttendance(req.user.id);
    if(!a||!a.lunch_start||a.lunch_end)return res.status(400).json({error:'Lunch is not active'});
    const t=iso();
    if(!PRODUCTION){const data=loadLocal();const x=data.attendance.find(v=>v.id===a.id);x.lunch_end=t;x.updated_at=t;saveLocal(data);return res.json({ok:true});}
    await pool.query('UPDATE attendance SET lunch_end=$1,updated_at=NOW() WHERE id=$2',[t,a.id]);res.json({ok:true});
  } catch { res.status(500).json({error:'Could not end lunch'}); }
});

app.post('/api/employee/check-out', auth('employee'), async (req,res) => {
  try {
    const a=await findTodayAttendance(req.user.id);
    if(!a||a.check_out)return res.status(400).json({error:'Invalid check-out'});
    if(a.lunch_start&&!a.lunch_end)return res.status(400).json({error:'End lunch first'});
    const t=iso();
    if(!PRODUCTION){const data=loadLocal();const x=data.attendance.find(v=>v.id===a.id);x.check_out=t;x.updated_at=t;saveLocal(data);return res.json(calc(x));}
    await pool.query('UPDATE attendance SET check_out=$1,updated_at=NOW() WHERE id=$2',[t,a.id]);a.check_out=t;res.json(calc(a));
  } catch { res.status(500).json({error:'Could not check out'}); }
});

app.post('/api/employee/leave-request', auth('employee'), async (req,res) => {
  try {
    const type=req.body.type==='half'?'half':'full';
    const startDate=req.body.start_date;const endDate=type==='half'?startDate:(req.body.end_date||startDate);const reason=String(req.body.reason||'').trim();const half=type==='half'?(req.body.half_day==='afternoon'?'afternoon':'morning'):null;
    if(!startDate||!/^\d{4}-\d{2}-\d{2}$/.test(startDate)||!/^\d{4}-\d{2}-\d{2}$/.test(endDate)||!reason)return res.status(400).json({error:'Leave date and reason are required'});
    if(endDate<startDate)return res.status(400).json({error:'End date cannot be before start date'});
    if(!PRODUCTION){const data=loadLocal();const overlap=data.leaves.some(l=>l.employee_id===req.user.id&&l.status!=='rejected'&&!(endDate<l.start_date||startDate>l.end_date));if(overlap)return res.status(400).json({error:'A leave request already exists for this date'});const l={id:nextId(data.leaves),employee_id:req.user.id,type,half_day:half,start_date:startDate,end_date:endDate,reason,status:'pending',admin_note:'',created_at:iso(),updated_at:iso()};data.leaves.push(l);saveLocal(data);return res.json({ok:true,request:l});}
    const overlap=await pool.query(`SELECT id FROM leaves WHERE employee_id=$1 AND status<>'rejected' AND NOT ($3::date < start_date OR $2::date > end_date) LIMIT 1`,[req.user.id,startDate,endDate]);
    if(overlap.rowCount)return res.status(400).json({error:'A leave request already exists for this date'});
    const r=await pool.query('INSERT INTO leaves(employee_id,type,half_day,start_date,end_date,reason) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[req.user.id,type,half,startDate,endDate,reason]);res.json({ok:true,request:r.rows[0]});
  } catch { res.status(500).json({error:'Could not submit leave request'}); }
});

app.get('/api/employee/leaves', auth('employee'), async (req,res) => {
  try {
    if(!PRODUCTION){const data=loadLocal();return res.json(data.leaves.filter(l=>l.employee_id===req.user.id).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))));}
    const r=await pool.query('SELECT * FROM leaves WHERE employee_id=$1 ORDER BY created_at DESC',[req.user.id]);res.json(r.rows);
  } catch { res.status(500).json({error:'Could not load leaves'}); }
});

async function adminDashboard() {
  if(!PRODUCTION){
    const data=loadLocal();const employees=data.employees.map(e=>({id:e.id,name:e.name,email:e.email,phone:e.phone||'',active:e.active,created_at:e.created_at}));const today=day();const attendance=data.attendance.filter(a=>a.date===today).map(a=>{const e=data.employees.find(x=>x.id===a.employee_id)||{};return{...a,name:e.name||'Unknown',email:e.email||'',phone:e.phone||'',...calc(a)};}).sort((a,b)=>a.name.localeCompare(b.name));const todayLeaveIds=new Set(data.leaves.filter(l=>l.status==='approved'&&l.start_date<=today&&l.end_date>=today).map(l=>l.employee_id));const active=employees.filter(e=>e.active);const startedIds=new Set(attendance.map(a=>a.employee_id));const started=active.filter(e=>startedIds.has(e.id)).length;const onLeave=active.filter(e=>todayLeaveIds.has(e.id)&&!startedIds.has(e.id)).length;const notStarted=active.filter(e=>!startedIds.has(e.id)&&!todayLeaveIds.has(e.id)).map(e=>({id:e.id,name:e.name,email:e.email,phone:e.phone||''}));const leaves=data.leaves.filter(l=>l.status==='pending').map(l=>{const e=data.employees.find(x=>x.id===l.employee_id)||{};return{...l,employee_name:e.name||'Unknown',employee_email:e.email||'',employee_phone:e.phone||''};}).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));return{employees,attendance,pending_leaves:leaves,not_started_employees:notStarted,date:today,stats:{total_employees:active.length,work_started:started,remaining:notStarted.length,on_leave:onLeave}};
  }
  const today=day();
  const employees=(await pool.query('SELECT id,name,email,phone,active,created_at FROM employees ORDER BY name')).rows;
  const attendanceRaw=(await pool.query(`SELECT a.*,e.name,e.email,e.phone FROM attendance a JOIN employees e ON e.id=a.employee_id WHERE a.date=$1 ORDER BY e.name`,[today])).rows;
  const attendance=attendanceRaw.map(a=>({...a,...calc(a)}));
  const approved=(await pool.query('SELECT DISTINCT employee_id FROM leaves WHERE status=$1 AND start_date <= $2 AND end_date >= $2',['approved',today])).rows;
  const leaveIds=new Set(approved.map(x=>x.employee_id));const active=employees.filter(e=>e.active);const startedIds=new Set(attendance.map(a=>a.employee_id));const started=active.filter(e=>startedIds.has(e.id)).length;const onLeave=active.filter(e=>leaveIds.has(e.id)&&!startedIds.has(e.id)).length;const notStarted=active.filter(e=>!startedIds.has(e.id)&&!leaveIds.has(e.id)).map(e=>({id:e.id,name:e.name,email:e.email,phone:e.phone||''}));
  const pending=(await pool.query(`SELECT l.*,e.name AS employee_name,e.email AS employee_email,e.phone AS employee_phone FROM leaves l JOIN employees e ON e.id=l.employee_id WHERE l.status='pending' ORDER BY l.created_at DESC`)).rows;
  return{employees,attendance,pending_leaves:pending,not_started_employees:notStarted,date:today,stats:{total_employees:active.length,work_started:started,remaining:notStarted.length,on_leave:onLeave}};
}

app.get('/api/admin/dashboard', auth('admin'), async (req,res)=>{try{res.json(await adminDashboard());}catch{res.status(500).json({error:'Could not load dashboard'});}});

app.post('/api/admin/employees', auth('admin'), async (req,res)=>{
  try {
    const name=String(req.body.name||'').trim();const email=String(req.body.email||'').trim().toLowerCase();const phone=String(req.body.phone||'').trim();const password=String(req.body.password||'');
    if(!name||!email||!password)return res.status(400).json({error:'Name, email and password are required'});
    if(!PRODUCTION){const data=loadLocal();if(data.employees.some(e=>e.email===email))return res.status(400).json({error:'Email already exists'});const e={id:nextId(data.employees),name,email,phone,password:hashPassword(password),active:true,created_at:iso()};data.employees.push(e);saveLocal(data);return res.json({id:e.id});}
    const r=await pool.query('INSERT INTO employees(name,email,phone,password_hash) VALUES($1,$2,$3,$4) RETURNING id',[name,email,phone,hashPassword(password)]);res.json({id:r.rows[0].id});
  } catch(e) { if(e.code==='23505')return res.status(400).json({error:'Email already exists'}); res.status(500).json({error:'Could not add employee'}); }
});

app.patch('/api/admin/employees/:id', auth('admin'), async (req,res)=>{
  try {
    const id=Number(req.params.id);const name=String(req.body.name||'').trim();const email=String(req.body.email||'').trim().toLowerCase();const phone=String(req.body.phone??'').trim();
    if(!PRODUCTION){const data=loadLocal();const e=data.employees.find(x=>x.id===id);if(!e)return res.sendStatus(404);if(data.employees.some(x=>x.id!==id&&x.email===email))return res.status(400).json({error:'Email already exists'});e.name=name||e.name;e.email=email||e.email;e.phone=phone;if(req.body.password)e.password=hashPassword(String(req.body.password));if(req.body.active!==undefined)e.active=!!req.body.active;saveLocal(data);return res.json({ok:true});}
    const r=await pool.query('SELECT * FROM employees WHERE id=$1 LIMIT 1',[id]);if(!r.rowCount)return res.sendStatus(404);const e=r.rows[0];const passwordHash=req.body.password?hashPassword(String(req.body.password)):e.password_hash;await pool.query('UPDATE employees SET name=$1,email=$2,phone=$3,password_hash=$4,active=$5 WHERE id=$6',[name||e.name,email||e.email,phone,passwordHash,req.body.active===undefined?e.active:!!req.body.active,id]);res.json({ok:true});
  } catch(e){if(e.code==='23505')return res.status(400).json({error:'Email already exists'});res.status(500).json({error:'Could not update employee'});}
});

app.delete('/api/admin/employees/:id', auth('admin'), async (req,res)=>{
  try {
    const id=Number(req.params.id);
    if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:'Invalid employee id'});
    if(!PRODUCTION){
      const data=loadLocal();
      const index=data.employees.findIndex(e=>Number(e.id)===id);
      if(index===-1)return res.sendStatus(404);
      const deleted=data.employees[index];
      data.employees.splice(index,1);
      data.attendance=data.attendance.filter(a=>Number(a.employee_id)!==id);
      data.leaves=data.leaves.filter(l=>Number(l.employee_id)!==id);
      saveLocal(data);
      return res.json({ok:true,deleted_employee:{id:deleted.id,name:deleted.name,email:deleted.email}});
    }
    const r=await pool.query('DELETE FROM employees WHERE id=$1 RETURNING id,name,email',[id]);
    if(!r.rowCount)return res.sendStatus(404);
    res.json({ok:true,deleted_employee:r.rows[0]});
  } catch(e){res.status(500).json({error:'Could not delete employee'});}
});

function addDerivedRows(rows){return rows.map(a=>({...a,...calc(a)}));}

app.get('/api/admin/attendance', auth('admin'), async (req,res)=>{
  try{
    if(!PRODUCTION){const data=loadLocal();let rows=data.attendance.slice();if(req.query.month&&/^\d{4}-\d{2}$/.test(req.query.month))rows=rows.filter(a=>a.date.startsWith(req.query.month));if(req.query.employee_id)rows=rows.filter(a=>a.employee_id===Number(req.query.employee_id));rows=rows.map(a=>{const e=data.employees.find(x=>x.id===a.employee_id)||{};return{...a,name:e.name||'Unknown',email:e.email||'',phone:e.phone||'',...calc(a)};}).sort((a,b)=>b.date.localeCompare(a.date)||a.name.localeCompare(b.name));return res.json(rows);}
    const params=[];const where=[];if(req.query.month&&/^\d{4}-\d{2}$/.test(req.query.month)){params.push(req.query.month);where.push(`a.date >= ($${params.length} || '-01')::date AND a.date < (($${params.length} || '-01')::date + INTERVAL '1 month')`);}if(req.query.employee_id){params.push(Number(req.query.employee_id));where.push(`a.employee_id=$${params.length}`);}const sql=`SELECT a.*,e.name,e.email,e.phone FROM attendance a JOIN employees e ON e.id=a.employee_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY a.date DESC,e.name`;const rows=(await pool.query(sql,params)).rows;res.json(addDerivedRows(rows));
  }catch{res.status(500).json({error:'Could not load attendance'});}
});

app.patch('/api/admin/attendance/:id', auth('admin'), async (req,res)=>{
  try{
    const id=Number(req.params.id);const checkIn=req.body.check_in;if(!checkIn)return res.status(400).json({error:'Check-in is required'});const lunchStart=req.body.lunch_start||null;const lunchEnd=req.body.lunch_end||null;const checkOut=req.body.check_out||null;if(lunchStart&&lunchEnd&&new Date(lunchEnd)<new Date(lunchStart))return res.status(400).json({error:'Lunch end cannot be before lunch start'});if(checkOut&&new Date(checkOut)<new Date(checkIn))return res.status(400).json({error:'Check-out cannot be before check-in'});
    if(!PRODUCTION){const data=loadLocal();const a=data.attendance.find(x=>x.id===id);if(!a)return res.sendStatus(404);a.check_in=checkIn;a.lunch_start=lunchStart;a.lunch_end=lunchEnd;a.check_out=checkOut;a.updated_at=iso();saveLocal(data);return res.json({ok:true,...calc(a)});}
    const r=await pool.query('UPDATE attendance SET check_in=$1,lunch_start=$2,lunch_end=$3,check_out=$4,updated_at=NOW() WHERE id=$5 RETURNING *',[checkIn,lunchStart,lunchEnd,checkOut,id]);if(!r.rowCount)return res.sendStatus(404);res.json({ok:true,...calc(r.rows[0])});
  }catch{res.status(500).json({error:'Could not update attendance'});}
});

app.get('/api/admin/leaves', auth('admin'), async (req,res)=>{
  try{
    if(!PRODUCTION){const data=loadLocal();let rows=data.leaves;if(req.query.status)rows=rows.filter(l=>l.status===req.query.status);if(req.query.employee_id)rows=rows.filter(l=>l.employee_id===Number(req.query.employee_id));return res.json(rows.map(l=>{const e=data.employees.find(x=>x.id===l.employee_id)||{};return{...l,employee_name:e.name||'Unknown',employee_email:e.email||'',employee_phone:e.phone||''};}).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))));}
    const params=[];const where=[];if(req.query.status){params.push(String(req.query.status));where.push(`l.status=$${params.length}`);}if(req.query.employee_id){params.push(Number(req.query.employee_id));where.push(`l.employee_id=$${params.length}`);}const sql=`SELECT l.*,e.name AS employee_name,e.email AS employee_email,e.phone AS employee_phone FROM leaves l JOIN employees e ON e.id=l.employee_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY l.created_at DESC`;res.json((await pool.query(sql,params)).rows);
  }catch{res.status(500).json({error:'Could not load leaves'});}
});

app.patch('/api/admin/leaves/:id', auth('admin'), async (req,res)=>{
  try{
    const id=Number(req.params.id);const status=String(req.body.status||'');if(!['approved','rejected','pending'].includes(status))return res.status(400).json({error:'Invalid leave status'});const note=String(req.body.admin_note||'').trim();
    if(!PRODUCTION){const data=loadLocal();const l=data.leaves.find(x=>x.id===id);if(!l)return res.sendStatus(404);l.status=status;l.admin_note=note;l.updated_at=iso();saveLocal(data);return res.json({ok:true,leave:l});}
    const r=await pool.query('UPDATE leaves SET status=$1,admin_note=$2,updated_at=NOW() WHERE id=$3 RETURNING *',[status,note,id]);if(!r.rowCount)return res.sendStatus(404);res.json({ok:true,leave:r.rows[0]});
  }catch{res.status(500).json({error:'Could not update leave'});}
});

async function start(){
  if(PRODUCTION) await dbInit();
  app.listen(PORT,()=>console.log(`Attendance system running on port ${PORT} using ${PRODUCTION?'PostgreSQL':'local JSON'} storage`));
}
start().catch(err=>{console.error(err);process.exit(1);});
