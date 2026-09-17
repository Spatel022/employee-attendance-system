const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const expressPath = require.resolve('express');
const baseExpress = require(expressPath);
const SECRET = process.env.JWT_SECRET || 'local-development-secret-change-me';
const production = !!process.env.DATABASE_URL;
const pool = production ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10
}) : null;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
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
    } catch { res.sendStatus(401); }
  };
}
function localFile(){ return path.join(__dirname,'attendance-data.json'); }
function localLoad(){
  const d = fs.existsSync(localFile()) ? JSON.parse(fs.readFileSync(localFile(),'utf8')) : {employees:[]};
  d.employees ||= []; d.attendance ||= []; d.leaves ||= []; d.work_reports ||= [];
  return d;
}
function localSave(d){ fs.writeFileSync(localFile(), JSON.stringify(d,null,2)); }
function getBaseUrl(req){ return String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/,''); }

function transporter(){
  if(!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase()==='true' || Number(process.env.SMTP_PORT||587)===465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function registerInviteRoutes(app){
  if (production) await pool.query('SELECT 1');

  app.post('/api/admin/employees/:id/invite', auth('admin'), async (req,res)=>{
    try{
      const id=Number(req.params.id);
      let employee;
      if(!production){
        const d=localLoad(); employee=d.employees.find(e=>Number(e.id)===id);
        if(!employee)return res.sendStatus(404);
        employee.active=false;
        employee.password=hashPassword(crypto.randomBytes(32).toString('hex'));
        localSave(d);
      } else {
        const r=await pool.query('SELECT id,name,email,phone FROM employees WHERE id=$1 LIMIT 1',[id]);
        if(!r.rowCount)return res.sendStatus(404); employee=r.rows[0];
        await pool.query('UPDATE employees SET active=false,password_hash=$1 WHERE id=$2',[hashPassword(crypto.randomBytes(32).toString('hex')),id]);
      }
      const inviteToken=jwt.sign({type:'employee-invite',employee_id:id,email:employee.email},SECRET,{expiresIn:'48h'});
      const link=`${getBaseUrl(req)}/employee-accept.html?token=${encodeURIComponent(inviteToken)}`;
      const mail=transporter();
      if(!mail)return res.status(503).json({error:'Email service is not configured. Add SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS and MAIL_FROM.'});
      await mail.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: employee.email,
        subject:'Linn Point · Accept your employee account',
        text:`Hello ${employee.name},\n\nYour Linn Point employee account has been created. Please accept your invitation and set your password using this link:\n\n${link}\n\nThis invitation expires in 48 hours.\n\nRegards,\nLinn Point Attendance System`,
        html:`<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;padding:30px;color:#101828"><h2 style="margin-bottom:8px">Welcome to Linn Point</h2><p>Hello ${String(employee.name).replace(/[&<>]/g,'')},</p><p>Your employee account has been created. Click the button below to accept your invitation and set your password.</p><p style="margin:28px 0"><a href="${link}" style="background:#2563eb;color:#fff;text-decoration:none;padding:13px 22px;border-radius:8px;display:inline-block;font-weight:700">Accept Invitation</a></p><p style="font-size:13px;color:#667085">This invitation expires in 48 hours.</p></div>`
      });
      res.json({ok:true,email:employee.email});
    }catch(e){ console.error('Invite email failed:',e); res.status(500).json({error:'Could not send employee invitation email'}); }
  });

  app.post('/api/employee/accept-invite', async (req,res)=>{
    try{
      const token=String(req.body.token||'');
      const password=String(req.body.password||'');
      if(!token || password.length<8)return res.status(400).json({error:'Invitation token and a password of at least 8 characters are required'});
      const invite=jwt.verify(token,SECRET);
      if(invite.type!=='employee-invite')return res.status(400).json({error:'Invalid invitation'});
      if(!production){
        const d=localLoad(); const e=d.employees.find(x=>Number(x.id)===Number(invite.employee_id)&&String(x.email).toLowerCase()===String(invite.email).toLowerCase());
        if(!e)return res.status(404).json({error:'Employee account not found'});
        if(e.active)return res.status(400).json({error:'This invitation has already been accepted'});
        e.password=hashPassword(password); e.active=true; e.updated_at=new Date().toISOString(); localSave(d);
      }else{
        const r=await pool.query('SELECT id,email,active FROM employees WHERE id=$1 AND email=$2 LIMIT 1',[invite.employee_id,invite.email]);
        const e=r.rows[0]; if(!e)return res.status(404).json({error:'Employee account not found'});
        if(e.active)return res.status(400).json({error:'This invitation has already been accepted'});
        await pool.query('UPDATE employees SET password_hash=$1,active=true WHERE id=$2',[hashPassword(password),e.id]);
      }
      res.json({ok:true});
    }catch(e){
      const message=e && e.name==='TokenExpiredError'?'This invitation has expired. Please ask the admin to send a new invitation.':'Invalid or expired invitation.';
      res.status(400).json({error:message});
    }
  });
}

function wrappedExpress(...args){
  const app=baseExpress(...args);
  const originalListen=app.listen.bind(app);
  let started=false;
  app.listen=function(port,cb){
    if(started)return originalListen(port,cb); started=true;
    Promise.resolve(registerInviteRoutes(app)).then(()=>originalListen(port,cb)).catch(err=>{console.error('Invite setup failed:',err);process.exit(1)});
  };
  return app;
}
Object.assign(wrappedExpress,baseExpress);
require.cache[expressPath].exports=wrappedExpress;
require('./work-server.js');
