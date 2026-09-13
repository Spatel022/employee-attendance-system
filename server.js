const express = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'change-this-in-production';
const DATA_FILE = path.join(__dirname, 'attendance-data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const data = {
      admin: { id: 1, email: process.env.ADMIN_EMAIL || 'admin@example.com', password: process.env.ADMIN_PASSWORD || 'admin123' },
      employees: [],
      attendance: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    return data;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();
const iso = () => new Date().toISOString();
const day = () => new Date().toISOString().slice(0, 10);
const mins = (a, b) => Math.max(0, Math.floor((new Date(b) - new Date(a)) / 60000));
const nextId = (items) => items.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;

function calc(a) {
  const end = a.check_out || iso();
  const office = mins(a.check_in, end);
  const lunch = a.lunch_start ? mins(a.lunch_start, a.lunch_end || end) : 0;
  const working = Math.max(0, office - lunch);
  return {
    office_minutes: office,
    lunch_minutes: lunch,
    working_minutes: working,
    overtime_minutes: Math.max(0, working - 540)
  };
}

function auth(role) {
  return (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').replace('Bearer ', '');
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/employee', (req, res) => res.sendFile(path.join(__dirname, 'public', 'employee.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/admin/login', (req, res) => {
  data = loadData();
  const a = data.admin;
  if (!a || a.email !== req.body.email || a.password !== req.body.password) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }
  res.json({ token: sign('admin', 1), admin: { id: 1, email: a.email } });
});

app.post('/api/employee/login', (req, res) => {
  data = loadData();
  const e = data.employees.find(x => x.email === String(req.body.email || '').trim().toLowerCase() && x.password === req.body.password && x.active);
  if (!e) return res.status(401).json({ error: 'Invalid employee credentials' });
  res.json({ token: sign('employee', e.id), employee: { id: e.id, name: e.name, email: e.email, active: e.active } });
});

app.get('/api/employee/today', auth('employee'), (req, res) => {
  data = loadData();
  const a = data.attendance.find(x => x.employee_id === req.user.id && x.date === day());
  res.json(a ? { ...a, ...calc(a) } : null);
});

app.post('/api/employee/check-in', auth('employee'), (req, res) => {
  data = loadData();
  if (data.attendance.some(x => x.employee_id === req.user.id && x.date === day())) {
    return res.status(400).json({ error: 'Already checked in today' });
  }
  const t = iso();
  const a = { id: nextId(data.attendance), employee_id: req.user.id, date: day(), check_in: t, lunch_start: null, lunch_end: null, check_out: null, created_at: t, updated_at: t };
  data.attendance.push(a);
  saveData(data);
  res.json({ id: a.id, check_in: t });
});

app.post('/api/employee/lunch-start', auth('employee'), (req, res) => {
  data = loadData();
  const a = data.attendance.find(x => x.employee_id === req.user.id && x.date === day());
  if (!a || a.check_out || a.lunch_start) return res.status(400).json({ error: 'Cannot start lunch' });
  a.lunch_start = iso();
  a.updated_at = iso();
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/employee/lunch-end', auth('employee'), (req, res) => {
  data = loadData();
  const a = data.attendance.find(x => x.employee_id === req.user.id && x.date === day());
  if (!a || !a.lunch_start || a.lunch_end) return res.status(400).json({ error: 'Lunch is not active' });
  a.lunch_end = iso();
  a.updated_at = iso();
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/employee/check-out', auth('employee'), (req, res) => {
  data = loadData();
  const a = data.attendance.find(x => x.employee_id === req.user.id && x.date === day());
  if (!a || a.check_out) return res.status(400).json({ error: 'Invalid check-out' });
  if (a.lunch_start && !a.lunch_end) return res.status(400).json({ error: 'End lunch first' });
  a.check_out = iso();
  a.updated_at = iso();
  saveData(data);
  res.json(calc(a));
});

app.get('/api/admin/dashboard', auth('admin'), (req, res) => {
  data = loadData();
  const employees = data.employees.map(e => ({ id: e.id, name: e.name, email: e.email, active: e.active, created_at: e.created_at }));
  const attendance = data.attendance.filter(a => a.date === day()).map(a => {
    const e = data.employees.find(x => x.id === a.employee_id) || {};
    return { ...a, name: e.name || 'Unknown', email: e.email || '', ...calc(a) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ employees, attendance, date: day() });
});

app.post('/api/admin/employees', auth('admin'), (req, res) => {
  data = loadData();
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (data.employees.some(e => e.email === email)) return res.status(400).json({ error: 'Email already exists' });
  const e = { id: nextId(data.employees), name, email, password, active: true, created_at: iso() };
  data.employees.push(e);
  saveData(data);
  res.json({ id: e.id });
});

app.patch('/api/admin/employees/:id', auth('admin'), (req, res) => {
  data = loadData();
  const e = data.employees.find(x => x.id === Number(req.params.id));
  if (!e) return res.sendStatus(404);
  const email = String(req.body.email ?? e.email).trim().toLowerCase();
  if (data.employees.some(x => x.id !== e.id && x.email === email)) return res.status(400).json({ error: 'Email already exists' });
  e.name = String(req.body.name ?? e.name).trim();
  e.email = email;
  if (req.body.password) e.password = String(req.body.password);
  if (req.body.active !== undefined) e.active = !!req.body.active;
  saveData(data);
  res.json({ ok: true });
});

app.get('/api/admin/attendance', auth('admin'), (req, res) => {
  data = loadData();
  let rows = data.attendance;
  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) rows = rows.filter(a => a.date.startsWith(req.query.month));
  if (req.query.employee_id) rows = rows.filter(a => a.employee_id === Number(req.query.employee_id));
  rows = rows.map(a => {
    const e = data.employees.find(x => x.id === a.employee_id) || {};
    return { ...a, name: e.name || 'Unknown', email: e.email || '', ...calc(a) };
  }).sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  res.json(rows);
});

app.patch('/api/admin/attendance/:id', auth('admin'), (req, res) => {
  data = loadData();
  const a = data.attendance.find(x => x.id === Number(req.params.id));
  if (!a) return res.sendStatus(404);
  const n = { ...a, ...req.body };
  if (!n.check_in) return res.status(400).json({ error: 'Check-in is required' });
  if (n.lunch_start && n.lunch_end && new Date(n.lunch_end) < new Date(n.lunch_start)) return res.status(400).json({ error: 'Lunch end cannot be before lunch start' });
  if (n.check_out && new Date(n.check_out) < new Date(n.check_in)) return res.status(400).json({ error: 'Check-out cannot be before check-in' });
  a.check_in = n.check_in;
  a.lunch_start = n.lunch_start || null;
  a.lunch_end = n.lunch_end || null;
  a.check_out = n.check_out || null;
  a.updated_at = iso();
  saveData(data);
  res.json({ ok: true, ...calc(a) });
});

app.listen(PORT, () => console.log('Attendance system running on ' + PORT));
