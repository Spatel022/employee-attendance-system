const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const DATA_FILE = path.join(__dirname, 'attendance-data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function initialData() {
  return {
    admin: { id: 1, email: process.env.ADMIN_EMAIL || 'admin@example.com', password: process.env.ADMIN_PASSWORD || 'admin123' },
    employees: [],
    attendance: [],
    nextEmployeeId: 1,
    nextAttendanceId: 1
  };
}
function load() {
  if (!fs.existsSync(DATA_FILE)) {
    const d = initialData();
    fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
    return d;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function save(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2)); }
const iso = () => new Date().toISOString();
const day = () => new Date().toISOString().slice(0, 10);
const mins = (a, b) => Math.max(0, Math.floor((new Date(b) - new Date(a)) / 60000));

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
      const u = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET);
      if (role && u.role !== role) return res.sendStatus(403);
      req.user = u; next();
    } catch { res.sendStatus(401); }
  };
}
function sign(role, id) { return jwt.sign({ role, id }, SECRET, { expiresIn: '12h' }); }
function publicEmployee(e) { return { id: e.id, name: e.name, email: e.email, active: e.active, created_at: e.created_at }; }
function getAttendance(d, id) { return d.attendance.find(a => a.employee_id === Number(id) && a.date === day()); }

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/employee', (req, res) => res.sendFile(path.join(__dirname, 'public', 'employee.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/admin/login', (req, res) => {
  const d = load(), a = d.admin;
  if (req.body.email !== a.email || req.body.password !== a.password) return res.status(401).json({ error: 'Invalid admin credentials' });
  res.json({ token: sign('admin', 1), admin: { id: 1, email: a.email } });
});

app.post('/api/employee/login', (req, res) => {
  const d = load(), e = d.employees.find(x => x.email === String(req.body.email || '').trim().toLowerCase() && x.password === req.body.password);
  if (!e || !e.active) return res.status(401).json({ error: 'Invalid employee credentials' });
  res.json({ token: sign('employee', e.id), employee: publicEmployee(e) });
});

app.get('/api/employee/today', auth('employee'), (req, res) => {
  const a = getAttendance(load(), req.user.id);
  res.json(a ? { ...a, ...calc(a) } : null);
});

app.post('/api/employee/check-in', auth('employee'), (req, res) => {
  const d = load();
  if (getAttendance(d, req.user.id)) return res.status(400).json({ error: 'Already checked in today' });
  const t = iso(), a = { id: d.nextAttendanceId++, employee_id: req.user.id, date: day(), check_in: t, lunch_start: null, lunch_end: null, check_out: null, created_at: t, updated_at: t };
  d.attendance.push(a); save(d); res.json({ id: a.id, check_in: t });
});

app.post('/api/employee/lunch-start', auth('employee'), (req, res) => {
  const d = load(), a = getAttendance(d, req.user.id);
  if (!a || a.check_out || a.lunch_start) return res.status(400).json({ error: 'Cannot start lunch' });
  a.lunch_start = iso(); a.updated_at = iso(); save(d); res.json({ ok: true });
});
app.post('/api/employee/lunch-end', auth('employee'), (req, res) => {
  const d = load(), a = getAttendance(d, req.user.id);
  if (!a || !a.lunch_start || a.lunch_end) return res.status(400).json({ error: 'Lunch is not active' });
  a.lunch_end = iso(); a.updated_at = iso(); save(d); res.json({ ok: true });
});
app.post('/api/employee/check-out', auth('employee'), (req, res) => {
  const d = load(), a = getAttendance(d, req.user.id);
  if (!a || a.check_out) return res.status(400).json({ error: 'Invalid check-out' });
  if (a.lunch_start && !a.lunch_end) return res.status(400).json({ error: 'End lunch first' });
  a.check_out = iso(); a.updated_at = iso(); save(d); res.json(calc(a));
});

app.get('/api/admin/dashboard', auth('admin'), (req, res) => {
  const d = load();
  const attendance = d.attendance.filter(a => a.date === day()).map(a => {
    const e = d.employees.find(x => x.id === a.employee_id); return { ...a, ...calc(a), name: e?.name || 'Unknown', email: e?.email || '' };
  }).sort((a,b) => a.name.localeCompare(b.name));
  res.json({ employees: d.employees.map(publicEmployee).sort((a,b) => a.name.localeCompare(b.name)), attendance, date: day() });
});

app.post('/api/admin/employees', auth('admin'), (req, res) => {
  const d = load(), name = String(req.body.name || '').trim(), email = String(req.body.email || '').trim().toLowerCase(), password = String(req.body.password || '');
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (d.employees.some(e => e.email === email)) return res.status(400).json({ error: 'Email already exists' });
  const e = { id: d.nextEmployeeId++, name, email, password, active: true, created_at: iso() };
  d.employees.push(e); save(d); res.json({ id: e.id });
});

app.patch('/api/admin/employees/:id', auth('admin'), (req, res) => {
  const d = load(), e = d.employees.find(x => x.id === Number(req.params.id));
  if (!e) return res.sendStatus(404);
  const email = String(req.body.email ?? e.email).trim().toLowerCase();
  if (d.employees.some(x => x.id !== e.id && x.email === email)) return res.status(400).json({ error: 'Email already exists' });
  e.name = String(req.body.name ?? e.name).trim(); e.email = email; e.password = req.body.password || e.password;
  if (req.body.active !== undefined) e.active = !!req.body.active;
  save(d); res.json({ ok: true });
});

app.get('/api/admin/attendance', auth('admin'), (req, res) => {
  const d = load();
  let rows = d.attendance.slice();
  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) rows = rows.filter(a => a.date.startsWith(req.query.month));
  if (req.query.employee_id) rows = rows.filter(a => a.employee_id === Number(req.query.employee_id));
  rows = rows.map(a => { const e = d.employees.find(x => x.id === a.employee_id); return { ...a, ...calc(a), name: e?.name || 'Unknown', email: e?.email || '' }; });
  rows.sort((a,b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  res.json(rows);
});

app.patch('/api/admin/attendance/:id', auth('admin'), (req, res) => {
  const d = load(), a = d.attendance.find(x => x.id === Number(req.params.id));
  if (!a) return res.sendStatus(404);
  const n = { ...a, ...req.body };
  if (!n.check_in) return res.status(400).json({ error: 'Check-in is required' });
  if (n.lunch_start && n.lunch_end && new Date(n.lunch_end) < new Date(n.lunch_start)) return res.status(400).json({ error: 'Lunch end cannot be before lunch start' });
  if (n.check_out && new Date(n.check_out) < new Date(n.check_in)) return res.status(400).json({ error: 'Check-out cannot be before check-in' });
  Object.assign(a, { check_in: n.check_in, lunch_start: n.lunch_start || null, lunch_end: n.lunch_end || null, check_out: n.check_out || null, updated_at: iso() });
  save(d); res.json({ ok: true, ...calc(a) });
});

app.listen(PORT, () => console.log('Attendance system running on ' + PORT));
