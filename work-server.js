const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const expressPath = require.resolve('express');
const originalExpress = require(expressPath);
const originalListen = Symbol('originalListen');
let registered = false;

function workMinutes(start, end) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const total = (eh * 60 + em) - (sh * 60 + sm);
  return total > 0 ? total : null;
}

function minutesLabel(m) {
  m = Math.max(0, Number(m) || 0);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function getDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function auth(role) {
  return (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const secret = process.env.JWT_SECRET || 'local-development-secret-change-me';
      if (!token) return res.sendStatus(401);
      const u = jwt.verify(token, secret);
      if (role && u.role !== role) return res.sendStatus(403);
      req.user = u;
      next();
    } catch { res.sendStatus(401); }
  };
}

function localFile() { return path.join(__dirname, 'attendance-data.json'); }
function localLoad() {
  const file = localFile();
  if (!fs.existsSync(file)) return { admin: { id: 1 }, employees: [], attendance: [], leaves: [], work_reports: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.employees ||= [];
  data.attendance ||= [];
  data.leaves ||= [];
  data.work_reports ||= [];
  return data;
}
function localSave(data) { fs.writeFileSync(localFile(), JSON.stringify(data, null, 2)); }
function nextId(items) { return items.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1; }

async function registerWorkRoutes(app) {
  if (registered) return;
  registered = true;
  const production = !!process.env.DATABASE_URL;
  const pool = production ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10
  }) : null;

  if (production) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS work_reports (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        project_name TEXT NOT NULL,
        work_description TEXT NOT NULL,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        total_minutes INTEGER NOT NULL CHECK (total_minutes > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS work_reports_date_idx ON work_reports(date);
      CREATE INDEX IF NOT EXISTS work_reports_employee_date_idx ON work_reports(employee_id, date);
    `);
  }

  async function employeeReports(employeeId, query) {
    if (!production) {
      const data = localLoad();
      let rows = data.work_reports.filter(r => Number(r.employee_id) === Number(employeeId));
      if (query.date && /^\d{4}-\d{2}-\d{2}$/.test(query.date)) rows = rows.filter(r => r.date === query.date);
      if (query.month && /^\d{4}-\d{2}$/.test(query.month)) rows = rows.filter(r => r.date.startsWith(query.month));
      return rows.sort((a,b) => String(b.date).localeCompare(String(a.date)) || String(a.start_time).localeCompare(String(b.start_time)));
    }
    const params = [employeeId];
    const where = ['employee_id=$1'];
    if (query.date && /^\d{4}-\d{2}-\d{2}$/.test(query.date)) { params.push(query.date); where.push(`date=$${params.length}`); }
    if (query.month && /^\d{4}-\d{2}$/.test(query.month)) { params.push(query.month); where.push(`date >= ($${params.length} || '-01')::date AND date < (($${params.length} || '-01')::date + INTERVAL '1 month')`); }
    return (await pool.query(`SELECT * FROM work_reports WHERE ${where.join(' AND ')} ORDER BY date DESC,start_time`, params)).rows;
  }

  function addProjectTotals(rows) {
    const totals = new Map();
    for (const r of rows) {
      const key = `${r.date}||${r.project_name}`;
      totals.set(key, (totals.get(key) || 0) + Number(r.total_minutes || 0));
    }
    return rows.map(r => ({ ...r, total_time: minutesLabel(r.total_minutes), total_hrs_on_project: minutesLabel(totals.get(`${r.date}||${r.project_name}`) || 0) }));
  }

  app.get('/api/employee/work-reports', auth('employee'), async (req, res) => {
    try { res.json(addProjectTotals(await employeeReports(req.user.id, req.query))); }
    catch { res.status(500).json({ error: 'Could not load work reports' }); }
  });

  app.post('/api/employee/work-reports', auth('employee'), async (req, res) => {
    try {
      const date = String(req.body.date || '').trim();
      const project = String(req.body.project_name || '').trim();
      const description = String(req.body.work_description || '').trim();
      const start = String(req.body.start_time || '').trim();
      const end = String(req.body.end_time || '').trim();
      const total = workMinutes(start, end);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !project || !description || total === null) return res.status(400).json({ error: 'Date, project, description and valid start/end times are required' });
      if (!production) {
        const data = localLoad();
        data.work_reports ||= [];
        const now = new Date().toISOString();
        const row = { id: nextId(data.work_reports), employee_id: Number(req.user.id), date, project_name: project, work_description: description, start_time: start, end_time: end, total_minutes: total, created_at: now, updated_at: now };
        data.work_reports.push(row); localSave(data); return res.json({ ok: true, report: row });
      }
      const r = await pool.query('INSERT INTO work_reports(employee_id,date,project_name,work_description,start_time,end_time,total_minutes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [req.user.id,date,project,description,start,end,total]);
      res.json({ ok: true, report: r.rows[0] });
    } catch { res.status(500).json({ error: 'Could not add work report' }); }
  });

  app.patch('/api/employee/work-reports/:id', auth('employee'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const date = String(req.body.date || '').trim();
      const project = String(req.body.project_name || '').trim();
      const description = String(req.body.work_description || '').trim();
      const start = String(req.body.start_time || '').trim();
      const end = String(req.body.end_time || '').trim();
      const total = workMinutes(start, end);
      if (!date || !project || !description || total === null) return res.status(400).json({ error: 'Valid work report details are required' });
      if (!production) {
        const data = localLoad(); const r = data.work_reports.find(x => Number(x.id) === id && Number(x.employee_id) === Number(req.user.id));
        if (!r) return res.sendStatus(404);
        Object.assign(r, { date, project_name: project, work_description: description, start_time: start, end_time: end, total_minutes: total, updated_at: new Date().toISOString() }); localSave(data); return res.json({ ok:true });
      }
      const r = await pool.query('UPDATE work_reports SET date=$1,project_name=$2,work_description=$3,start_time=$4,end_time=$5,total_minutes=$6,updated_at=NOW() WHERE id=$7 AND employee_id=$8 RETURNING id', [date,project,description,start,end,total,id,req.user.id]);
      if (!r.rowCount) return res.sendStatus(404); res.json({ ok:true });
    } catch { res.status(500).json({ error: 'Could not update work report' }); }
  });

  app.delete('/api/employee/work-reports/:id', auth('employee'), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!production) {
        const data = localLoad(); const i = data.work_reports.findIndex(x => Number(x.id) === id && Number(x.employee_id) === Number(req.user.id));
        if (i < 0) return res.sendStatus(404); data.work_reports.splice(i,1); localSave(data); return res.json({ok:true});
      }
      const r = await pool.query('DELETE FROM work_reports WHERE id=$1 AND employee_id=$2 RETURNING id',[id,req.user.id]);
      if (!r.rowCount) return res.sendStatus(404); res.json({ok:true});
    } catch { res.status(500).json({ error: 'Could not delete work report' }); }
  });

  app.get('/api/admin/work-reports', auth('admin'), async (req, res) => {
    try {
      let rows;
      if (!production) {
        const data = localLoad(); rows = data.work_reports.map(r => { const e = data.employees.find(x => Number(x.id) === Number(r.employee_id)) || {}; return { ...r, employee_name:e.name||'Unknown', employee_email:e.email||'', employee_phone:e.phone||'' }; });
        if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) rows = rows.filter(r => r.date === req.query.date);
        if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) rows = rows.filter(r => r.date.startsWith(req.query.month));
        if (req.query.employee_id) rows = rows.filter(r => Number(r.employee_id) === Number(req.query.employee_id));
        rows.sort((a,b)=>String(b.date).localeCompare(String(a.date))||String(a.employee_name).localeCompare(String(b.employee_name))||String(a.start_time).localeCompare(String(b.start_time)));
      } else {
        const params=[]; const where=[];
        if(req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)){params.push(req.query.date);where.push(`w.date=$${params.length}`)}
        if(req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)){params.push(req.query.month);where.push(`w.date >= ($${params.length} || '-01')::date AND w.date < (($${params.length} || '-01')::date + INTERVAL '1 month')`)}
        if(req.query.employee_id){params.push(Number(req.query.employee_id));where.push(`w.employee_id=$${params.length}`)}
        rows=(await pool.query(`SELECT w.*,e.name AS employee_name,e.email AS employee_email,e.phone AS employee_phone FROM work_reports w JOIN employees e ON e.id=w.employee_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY w.date DESC,e.name,w.start_time`,params)).rows;
      }
      const totals = new Map();
      for(const r of rows){const key=`${r.date}||${r.employee_id}||${r.project_name}`;totals.set(key,(totals.get(key)||0)+Number(r.total_minutes||0));}
      res.json(rows.map(r=>({...r,total_time:minutesLabel(r.total_minutes),total_hrs_on_project:minutesLabel(totals.get(`${r.date}||${r.employee_id}||${r.project_name}`)||0)})));
    } catch { res.status(500).json({error:'Could not load admin work reports'}); }
  });

  app.patch('/api/admin/work-reports/:id', auth('admin'), async (req, res) => {
    try {
      const id=Number(req.params.id), date=String(req.body.date||'').trim(), project=String(req.body.project_name||'').trim(), description=String(req.body.work_description||'').trim(), start=String(req.body.start_time||'').trim(), end=String(req.body.end_time||'').trim(), total=workMinutes(start,end);
      if(!date||!project||!description||total===null)return res.status(400).json({error:'Valid work report details are required'});
      if(!production){const data=localLoad();const r=data.work_reports.find(x=>Number(x.id)===id);if(!r)return res.sendStatus(404);Object.assign(r,{date,project_name:project,work_description:description,start_time:start,end_time:end,total_minutes:total,updated_at:new Date().toISOString()});localSave(data);return res.json({ok:true});}
      const r=await pool.query('UPDATE work_reports SET date=$1,project_name=$2,work_description=$3,start_time=$4,end_time=$5,total_minutes=$6,updated_at=NOW() WHERE id=$7 RETURNING id',[date,project,description,start,end,total,id]);if(!r.rowCount)return res.sendStatus(404);res.json({ok:true});
    }catch{res.status(500).json({error:'Could not update work report'});}
  });

  app.delete('/api/admin/work-reports/:id', auth('admin'), async (req,res)=>{
    try{const id=Number(req.params.id);if(!production){const data=localLoad();const i=data.work_reports.findIndex(x=>Number(x.id)===id);if(i<0)return res.sendStatus(404);data.work_reports.splice(i,1);localSave(data);return res.json({ok:true});}const r=await pool.query('DELETE FROM work_reports WHERE id=$1 RETURNING id',[id]);if(!r.rowCount)return res.sendStatus(404);res.json({ok:true});}catch{res.status(500).json({error:'Could not delete work report'});}
  });

  app.get('/api/work-reports/summary', auth(), async (req,res)=>{
    try{
      const employeeId=req.user.role==='employee'?req.user.id:req.query.employee_id;
      let rows;
      if(!production){const data=localLoad();rows=data.work_reports.filter(r=>!employeeId||Number(r.employee_id)===Number(employeeId));if(req.query.date)rows=rows.filter(r=>r.date===req.query.date);}
      else{const p=[],w=[];if(employeeId){p.push(Number(employeeId));w.push(`employee_id=$${p.length}`)}if(req.query.date){p.push(req.query.date);w.push(`date=$${p.length}`)}rows=(await pool.query(`SELECT * FROM work_reports ${w.length?'WHERE '+w.join(' AND '):''}`,p)).rows;}
      const projects={};for(const r of rows){const k=r.project_name;projects[k]=(projects[k]||0)+Number(r.total_minutes||0);}res.json(Object.entries(projects).map(([project_name,total_minutes])=>({project_name,total_minutes,total_time:minutesLabel(total_minutes)})));
    }catch{res.status(500).json({error:'Could not load project summary'});}
  });
}

function wrappedExpress(...args) {
  const app = originalExpress(...args);
  if (!app[originalListen]) {
    app[originalListen] = app.listen.bind(app);
    app.listen = function(port, cb) {
      Promise.resolve(registerWorkRoutes(app)).then(() => app[originalListen](port, cb)).catch(err => { console.error('Work report setup failed:', err); process.exit(1); });
    };
  }
  return app;
}
Object.assign(wrappedExpress, originalExpress);
require.cache[expressPath].exports = wrappedExpress;
require('./server.js');
