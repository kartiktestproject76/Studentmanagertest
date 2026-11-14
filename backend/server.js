const crypto=require('crypto'),express=require('express'),{createClient}=require('@libsql/client'),pino=require('pino'),QRCode=require('qrcode');
const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
app.use(require('helmet')({crossOriginResourcePolicy:{policy:'cross-origin'}}));
app.use(require('compression')());app.use(express.json({limit:'500kb'}));
app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store');next()});

let db;
class ObjectId {constructor(id){this.id=String(id||Math.floor(Date.now()/1000).toString(16).padStart(8,'0')+crypto.randomBytes(8).toString('hex'))}toString(){return this.id}toJSON(){return this.id}getTimestamp(){return new Date(parseInt(this.id.slice(0,8),16)*1000)}}
const decode=v=>{if(Array.isArray(v))return v.map(decode);if(v&&typeof v==='object'){if(v.$date)return new Date(v.$date);if(v.$oid)return new ObjectId(v.$oid);for(const k of Object.keys(v))v[k]=decode(v[k]);return v}if(typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v))return new Date(v);return v};
const encode=v=>{if(v instanceof Date)return {$date:v.toISOString()};if(v instanceof ObjectId)return {$oid:v.toString()};if(Array.isArray(v))return v.map(encode);if(v&&typeof v==='object'){const o={};for(const k of Object.keys(v))o[k]=encode(v[k]);return o}return v};
const plain=v=>JSON.parse(JSON.stringify(encode(v)));
const get=(o,p)=>p.split('.').reduce((a,k)=>a==null?undefined:a[k],o);
const eq=(a,b)=>a instanceof Date&&b instanceof Date?a.getTime()===b.getTime():String(a instanceof ObjectId?a.toString():a)===String(b instanceof ObjectId?b.toString():b);
const matches=(doc,q={})=>Object.entries(q).every(([k,w])=>{if(k==='$or')return w.some(x=>matches(doc,x));const v=get(doc,k);if(w&&typeof w==='object'&&!Array.isArray(w)&&!(w instanceof Date)&&!(w instanceof ObjectId))return Object.entries(w).every(([op,x])=>op==='$gte'?v>=x:op==='$lte'?v<=x:op==='$ne'?!eq(v,x):op==='$in'?x.some(y=>eq(v,y)):false);return eq(v,w)});
class Cursor {constructor(rows){this.rows=rows}sort(spec){const [[k,d]]=Object.entries(spec||{});this.rows.sort((a,b)=>{const x=get(a,k),y=get(b,k);return(x<y?-1:x>y?1:0)*(d<0?-1:1)});return this}limit(n){this.rows=this.rows.slice(0,n);return this}async toArray(){return this.rows}}
const sessCache=new Map();
const FIELD=/^[A-Za-z_][A-Za-z0-9_]*$/;
// Turns simple conditions (equal, in, from/to on text) into SQL so only matching rows are read. The JS matcher still double-checks every row.
function plan(name,q){
 const where=['collection=?'],args=[name];
 for(const [k,w] of Object.entries(q||{})){
  if(k==='_id'){
   if(typeof w==='string'||w instanceof ObjectId){where.push('id=?');args.push(String(w))}
   else if(w&&Array.isArray(w.$in)&&w.$in.length&&w.$in.length<=3000){where.push('id IN ('+w.$in.map(()=>'?').join(',')+')');args.push(...w.$in.map(String))}
   continue}
  if(!FIELD.test(k))continue;
  const p="json_extract(data,'$."+k+"')";
  if(typeof w==='string'){where.push(p+'=?');args.push(w)}
  else if(w&&typeof w==='object'&&!Array.isArray(w)&&!(w instanceof Date)&&!(w instanceof ObjectId)){
   if(Array.isArray(w.$in)&&w.$in.length&&w.$in.length<=3000&&w.$in.every(x=>typeof x==='string')){where.push(p+' IN ('+w.$in.map(()=>'?').join(',')+')');args.push(...w.$in)}
   if(typeof w.$gte==='string'){where.push(p+'>=?');args.push(w.$gte)}
   if(typeof w.$lte==='string'){where.push(p+'<=?');args.push(w.$lte)}}}
 return{sql:'SELECT data FROM records WHERE '+where.join(' AND '),args}}
class Collection {
 constructor(name){this.name=name}
 async rows(q){const p=plan(this.name,q);const r=await db.execute({sql:p.sql,args:p.args});return r.rows.map(x=>decode(JSON.parse(x.data)))}
 async all(){return this.rows({})}
 async findOne(q={}){return(await this.rows(q)).find(x=>matches(x,q))||null}
 find(q={}){return new CursorPromise(this.rows(q).then(a=>a.filter(x=>matches(x,q))))}
 async insertOne(doc){const d=decode(plain(doc));if(d._id===undefined)d._id=new ObjectId();await db.execute({sql:'INSERT INTO records(collection,id,data) VALUES(?,?,?)',args:[this.name,String(d._id),JSON.stringify(plain(d))]});return{insertedId:d._id}}
 async insertMany(docs){if(!docs.length)return{insertedCount:0};
  const st=docs.map(doc=>{const d=decode(plain(doc));if(d._id===undefined)d._id=new ObjectId();return{sql:'INSERT INTO records(collection,id,data) VALUES(?,?,?)',args:[this.name,String(d._id),JSON.stringify(plain(d))]}});
  for(let i=0;i<st.length;i+=200)await db.batch(st.slice(i,i+200),'write');return{insertedCount:docs.length}}
 async updateOne(q,u,opts={}){let d=await this.findOne(q),ins=false;if(!d&&opts.upsert){d={};for(const[k,v]of Object.entries(q))if(!k.startsWith('$')&&!(v&&typeof v==='object'&&!Array.isArray(v)))d[k]=v;d._id=d._id??new ObjectId();ins=true}if(!d)return{matchedCount:0,modifiedCount:0};if(u.$set)Object.assign(d,decode(plain(u.$set)));if(ins&&u.$setOnInsert)Object.assign(d,decode(plain(u.$setOnInsert)));if(u.$inc)for(const[k,v]of Object.entries(u.$inc))d[k]=(d[k]||0)+v;await db.execute({sql:'INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data',args:[this.name,String(d._id),JSON.stringify(plain(d))]});return{matchedCount:ins?0:1,modifiedCount:1,upsertedId:ins?d._id:null}}
 async deleteOne(q){const d=await this.findOne(q);if(d)await db.execute({sql:'DELETE FROM records WHERE collection=? AND id=?',args:[this.name,String(d._id)]});if(this.name==='sessions')sessCache.clear();return{deletedCount:d?1:0}}
 async deleteMany(q){const a=await this.find(q).toArray();
  for(let i=0;i<a.length;i+=200){const ids=a.slice(i,i+200).map(d=>String(d._id));await db.execute({sql:'DELETE FROM records WHERE collection=? AND id IN ('+ids.map(()=>'?').join(',')+')',args:[this.name,...ids]})}
  if(this.name==='sessions')sessCache.clear();return{deletedCount:a.length}}
 async countDocuments(q={}){return(await this.find(q).toArray()).length}
 async createIndex(){return 'compat-index'}
}
class CursorPromise extends Cursor{constructor(p){super([]);this.promise=p}sort(s){this.sortSpec=s;return this}limit(n){this.limitN=n;return this}async toArray(){let a=await this.promise;const c=new Cursor(a);if(this.sortSpec)c.sort(this.sortSpec);if(this.limitN)c.limit(this.limitN);return c.rows}}
const col=n=>new Collection(n);

class HttpErr extends Error{constructor(s,m){super(m);this.s=s}}
const bad=m=>new HttpErr(400,m);
const h=f=>(req,res)=>f(req,res).catch(e=>{if(e&&e.s)return res.status(e.s).json({error:e.message});console.error(e);res.status(500).json({error:'Something went wrong. Please try again.'})});
// ---- input checks: every value from the browser is checked before it reaches the database ----
const str=(v,max=100)=>typeof v==='string'?v.trim().slice(0,max):(typeof v==='number'&&Number.isFinite(v)?String(v).slice(0,max):'');
const isId=v=>typeof v==='string'&&/^[a-f0-9]{24}$/i.test(v);
const needId=v=>{if(!isId(v))throw bad('Invalid student.');return v};
const isDate=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&!isNaN(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
const needDate=v=>{if(!isDate(v))throw bad('Invalid date.');return v};
const isMonth=v=>typeof v==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const markTime=x=>{if(x.at instanceof Date)return x.at;const t=x._id.getTimestamp(),y=t.getUTCFullYear();return(y>=2024&&y<=2100)?t:new Date()};
const num=(v,min,max)=>{const n=typeof v==='number'?v:(typeof v==='string'&&v.trim()!==''?Number(v):NaN);if(!Number.isFinite(n)||n<min||n>max)throw bad('Invalid number.');return n};
const okPhone=p=>p===''||/^[0-9+\-\s()]{3,20}$/.test(p);
const fd=d=>String(d).slice(0,10).split('-').reverse().join('-');
const fill=(t,o)=>String(t).replace(/\{(\w+)\}/g,(m,k)=>o[k]!==undefined?o[k]:m);
const phoneOf=p=>{p=String(p||'').replace(/\D/g,'');return p.length===10?'91'+p:p};
const oid=id=>new ObjectId(needId(String(id)));
const C={};
const getStudents=async()=>C.s||(C.s=(await col('students').find().sort({_id:1}).toArray()).map(s=>({id:String(s._id),name:s.name,cls:s.cls,roll:s.roll,phone:s.phone,email:s.email||''})));
const getTemplates=async()=>C.t||(C.t=(await col('templates').find().toArray()).map(t=>({key:t._id,body:t.body,wa_template:t.wa_template,wa_lang:t.wa_lang})));
const drop=k=>(req,res,next)=>{if(req.method!=='GET'){C[k]=null;res.on('finish',()=>{C[k]=null})}next()};
app.use('/api/students',drop('s'));app.use('/api/templates',drop('t'));
const DEFAULTS=[
 {_id:'present',body:'Dear Parent, {name} ({class}) was present in school on {date}.',wa_template:'attendance_present',wa_lang:'en'},
 {_id:'absent',body:'Dear Parent, {name} ({class}) was absent from school on {date}. Please share the reason.',wa_template:'attendance_absent',wa_lang:'en'},
 {_id:'marks',body:'Dear Parent, {name} ({class}) scored {marks}/{total} in {exam}.',wa_template:'marks_report',wa_lang:'en'}];

const ORIGINS=String(process.env.FRONTEND_URL||'').split(',').map(x=>x.trim().replace(/\/+$/,'')).filter(Boolean);
if(!ORIGINS.length)console.warn('FRONTEND_URL is not set. Any website could call this API (a login is still required). Set FRONTEND_URL.');
app.use((req,res,next)=>{const o=req.get('origin');
 if(!ORIGINS.length)res.set('Access-Control-Allow-Origin','*');else if(o&&ORIGINS.includes(o)){res.set('Access-Control-Allow-Origin',o);res.vary('Origin')}
 res.set({'Access-Control-Allow-Headers':'Content-Type,Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Access-Control-Max-Age':'600'});
 if(req.method==='OPTIONS')return res.sendStatus(204);next()});
app.get('/',(req,res)=>res.send('Student Manager API running'));

// ---------- Login with email code (OTP), sessions and roles ----------
const AUTH_SECRET=process.env.AUTH_SECRET||crypto.randomBytes(24).toString('hex');
if(!process.env.AUTH_SECRET)console.warn('AUTH_SECRET is not set. Login codes will stop working after a restart.');
const sha=x=>crypto.createHash('sha256').update(String(x)).digest('hex');
const hashOtp=(email,code)=>sha(AUTH_SECRET+'|'+email+'|'+code);
const SESSION_MS=6*3600*1000,OTP_MS=10*60*1000;
const hits=new Map(),lastReq=new Map();
const limit=(max,ms,key)=>(req,res,next)=>{const k=key?key(req):req.ip+req.path,n=Date.now(),a=(hits.get(k)||[]).filter(t=>n-t<ms);
 if(a.length>=max)return res.status(429).json({error:'Too many attempts. Please try again later.'});a.push(n);hits.set(k,a);next()};
app.use('/api',limit(600,60*1000,r=>r.ip+'|all'));
const eqh=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const fails=new Map(),reqs=new Map();
setInterval(()=>{const n=Date.now();
 for(const[k,v]of hits){const a=v.filter(t=>n-t<3600e3);a.length?hits.set(k,a):hits.delete(k)}
 for(const[k,v]of reqs){const a=v.filter(t=>n-t<3600e3);a.length?reqs.set(k,a):reqs.delete(k)}
 for(const[k,v]of fails)if((v.until&&v.until<n)||n-v.first>900e3)fails.delete(k);
 for(const[k,v]of lastReq)if(n-v>60000)lastReq.delete(k)},10*60*1000).unref();
async function audit(req,action,detail,who,role){
 try{await col('audit').insertOne({at:new Date(),who:who||(req.user&&req.user.email)||'',role:role||(req.user&&req.user.role)||'',action,detail:String(detail||'').slice(0,200),ip:req.ip})}catch(e){}}
async function findLogin(email){
 const u=await col('users').findOne({_id:email});
 if(u&&u.active!==false)return{role:u.role,name:u.name||email,student_id:null};
 const s=await col('students').findOne({email});
 if(s)return{role:'student',name:s.name,student_id:String(s._id)};
 return null}
async function sendMail(to,subject,html){
 if(!process.env.BREVO_API_KEY||!process.env.MAIL_FROM)throw new HttpErr(503,'Email sending is not set up on the server yet.');
 const r=await fetch('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':process.env.BREVO_API_KEY,'content-type':'application/json',accept:'application/json'},
  body:JSON.stringify({sender:{name:process.env.MAIL_FROM_NAME||'Student Manager',email:process.env.MAIL_FROM},to:[{email:to}],subject,htmlContent:html})});
 if(!r.ok){const t=await r.text().catch(()=>'');console.error('Brevo error',r.status,t.slice(0,300));throw new HttpErr(502,'Could not send the email. Please try again.')}}

app.post('/api/auth/request',limit(60,10*60*1000),h(async(req,res)=>{
 const email=normEmail(req.body.email);
 if(!okEmail(email))throw bad('Enter a valid email');
 const now=Date.now();
 if(now-(lastReq.get(email)||0)<60000)throw new HttpErr(429,'Please wait a minute before asking for another code.');
 const rr=(reqs.get(email)||[]).filter(t=>now-t<3600e3);
 if(rr.length>=5)throw new HttpErr(429,'Too many codes requested. Please try again in an hour.');
 lastReq.set(email,now);rr.push(now);reqs.set(email,rr);
 const u=await findLogin(email);
 if(u){
  const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
  await col('otps').updateOne({_id:email},{$set:{hash:hashOtp(email,code),expires:new Date(now+OTP_MS),attempts:0}},{upsert:true});
  await sendMail(email,'Your Student Manager login code',`<div style="font-family:Arial,sans-serif"><p>Your login code is</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p><p>It is valid for 10 minutes. Do not share it with anyone.</p></div>`)}
 res.json({ok:true})}));
app.post('/api/auth/verify',limit(120,10*60*1000),h(async(req,res)=>{
 const email=normEmail(req.body.email),code=str(req.body.code,12),now=Date.now();
 if(!okEmail(email)||!/^\d{6}$/.test(code))throw bad('Enter the 6-digit code.');
 const f=fails.get(email)||{n:0,first:now,until:0};
 if(f.until>now)throw new HttpErr(429,'Too many wrong tries. Please try again in 15 minutes.');
 const o=await col('otps').findOne({_id:email});
 if(!o||o.expires<new Date())throw bad('This code has expired. Please ask for a new one.');
 if(o.attempts>=5)throw new HttpErr(429,'Too many wrong tries. Please ask for a new code.');
 if(!eqh(o.hash,hashOtp(email,code))){
  await col('otps').updateOne({_id:email},{$inc:{attempts:1}});
  if(now-f.first>900e3){f.n=0;f.first=now}f.n++;if(f.n>=8)f.until=now+900e3;fails.set(email,f);
  await audit(req,'login_failed','wrong code',email);throw bad('Wrong code. Please try again.')}
 const u=await findLogin(email);if(!u)throw bad('This email is not allowed to log in.');
 fails.delete(email);await col('otps').deleteOne({_id:email});
 const token=crypto.randomBytes(32).toString('hex'),expires=new Date(now+SESSION_MS);
 await col('sessions').insertOne({_id:sha(token),email,role:u.role,name:u.name,student_id:u.student_id,expires,created:new Date(),ip:req.ip,ua:str(req.get('user-agent'),150)});
 const all=(await col('sessions').find({email}).toArray()).sort((a,b)=>b.created-a.created);
 for(const o2 of all.slice(5))await col('sessions').deleteOne({_id:o2._id});
 await audit(req,'login','',email,u.role);
 res.json({token,expires:expires.getTime(),user:{email,name:u.name,role:u.role,student_id:u.student_id}})}));

const TEACHER_GET=new Set(['/students','/bootstrap','/attendance','/marks','/templates','/send-status']);
const TEACHER_WRITE=new Set(['PUT /attendance','PUT /marks','POST /send','POST /send-all','POST /queue','POST /mark-sent']);
function allowed(role,method,path){
 if(path==='/auth/me'||path==='/auth/logout')return true;
 if(role==='admin')return true;
 if(role==='teacher')return (method==='GET'&&TEACHER_GET.has(path))||TEACHER_WRITE.has(method+' '+path);
 if(role==='student')return method==='GET'&&path==='/my';
 return false}
app.use('/api',async(req,res,next)=>{
 try{
  if(req.path==='/auth/request'||req.path==='/auth/verify')return next();
  const tok=(req.get('authorization')||'').replace(/^Bearer\s+/i,'');
  let ses=null;
  if(tok){const key=sha(tok),c=sessCache.get(key);
   if(c&&c.t>Date.now()-30000)ses=c.s;
   else{ses=await col('sessions').findOne({_id:key});if(sessCache.size>2000)sessCache.clear();if(ses)sessCache.set(key,{s:ses,t:Date.now()});else sessCache.delete(key)}}
  if(!ses||ses.expires<new Date())return res.status(401).json({error:'Your session ended. Please log in again.'});
  req.user=ses;
  if(!allowed(ses.role,req.method,req.path))return res.status(403).json({error:'You do not have access to this.'});
  next()}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/auth/me',(req,res)=>res.json({user:{email:req.user.email,name:req.user.name,role:req.user.role,student_id:req.user.student_id},expires:req.user.expires.getTime()}));
app.post('/api/auth/logout',h(async(req,res)=>{await col('sessions').deleteOne({_id:req.user._id});res.json({ok:true})}));

app.get('/api/users',h(async(req,res)=>res.json((await col('users').find({}).toArray()).sort((a,b)=>a._id.localeCompare(b._id)).map(u=>({email:u._id,name:u.name,role:u.role})))));
app.post('/api/users',h(async(req,res)=>{
 const email=normEmail(req.body.email),role=req.body.role==='admin'?'admin':'teacher',name=str(req.body.name,60)||email;
 if(!okEmail(email))throw bad('Enter a valid email');
 if(await col('students').findOne({email}))throw new HttpErr(409,'This email belongs to a student');
 if(await col('users').findOne({_id:email}))throw new HttpErr(409,'This user is already added');
 await col('users').insertOne({_id:email,role,name,active:true});await audit(req,'user_added',email+' as '+role);res.json({ok:true})}));
app.delete('/api/users/:email',h(async(req,res)=>{
 const email=normEmail(req.params.email);
 if(email===req.user.email)throw bad('You cannot remove yourself.');
 const u=await col('users').findOne({_id:email});
 if(u&&u.role==='admin'&&await col('users').countDocuments({role:'admin'})<=1)throw bad('Keep at least one admin.');
 await col('users').deleteOne({_id:email});await col('sessions').deleteMany({email});await audit(req,'user_removed',email);res.json({ok:true})}));
app.get('/api/audit',h(async(req,res)=>{
 const r=await db.execute({sql:"SELECT data FROM records WHERE collection='audit' ORDER BY json_extract(data,'$.at.\"$date\"') DESC LIMIT 100",args:[]});
 res.json(r.rows.map(x=>decode(JSON.parse(x.data))).map(a=>({at:a.at,who:a.who,role:a.role,action:a.action,detail:a.detail,ip:a.ip})))}));
app.get('/api/my',h(async(req,res)=>{
 const s=(await getStudents()).find(x=>x.id===req.user.student_id);
 if(!s)throw new HttpErr(404,'Your student record was not found. Please ask the admin.');
 const month=isMonth(req.query.month)?req.query.month:new Date().toISOString().slice(0,7);
 const [y,mo]=month.split('-').map(Number),days=new Date(Date.UTC(y,mo,0)).getUTCDate(),from=month+'-01',to=month+'-'+String(days).padStart(2,'0');
 const A=(await col('attendance').find({student_id:s.id,date:{$gte:from,$lte:to}}).toArray()).sort((a,b)=>a.date.localeCompare(b.date));
 const M=await col('marks').find({student_id:s.id}).toArray();
 res.json({student:{name:s.name,cls:s.cls,roll:s.roll,phone:s.phone,email:s.email},month,
  attendance:A.map(a=>({date:a.date,status:a.status})),marks:M.map(m=>({exam:m.exam,marks:m.marks,total:m.total}))})}));

app.get('/api/students',h(async(req,res)=>res.json(await getStudents())));
app.get('/api/bootstrap',h(async(req,res)=>res.json({students:await getStudents(),templates:await getTemplates(),mode:waMode()})));
const normEmail=e=>str(e,260).toLowerCase();
const okEmail=e=>e.length<=254&&/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
async function emailTaken(email,exceptId){if(!email)return false;
 if(await col('users').findOne({_id:email}))return true;
 const s=await col('students').findOne({email});return !!s&&String(s._id)!==String(exceptId||'')}
function studentFields(b){
 const name=str(b.name,100);if(!name)throw bad('Name required');
 const phone=str(b.phone,20);if(!okPhone(phone))throw bad('Enter a valid WhatsApp number');
 const email=normEmail(b.email);if(email&&!okEmail(email))throw bad('Enter a valid student email');
 return{name,cls:str(b.cls,20)||'-',roll:str(b.roll,20),phone,email}}
app.post('/api/students',h(async(req,res)=>{const f=studentFields(req.body);
 if(await emailTaken(f.email))throw new HttpErr(409,'This email is already used by someone else');
 await col('students').insertOne(f);await audit(req,'student_added',f.name);res.json({ok:true})}));
app.post('/api/students/bulk',h(async(req,res)=>{
 const rows=Array.isArray(req.body.rows)?req.body.rows.slice(0,2000):[];
 const have=new Set((await col('students').find({}).toArray()).map(s=>s.email).filter(Boolean));
 (await col('users').find({}).toArray()).forEach(u=>have.add(u._id));
 let skipped=0;const r=[];
 for(const x of rows){if(!x||typeof x!=='object')continue;let f;try{f=studentFields(x)}catch(e){skipped++;continue}
  if(f.email&&have.has(f.email)){f.email='';skipped++}if(f.email)have.add(f.email);r.push(f)}
 if(r.length)await col('students').insertMany(r);await audit(req,'students_imported',r.length+' students');res.json({count:r.length,skipped})}));
app.put('/api/students/:id',h(async(req,res)=>{const id=needId(req.params.id),f=studentFields(req.body);
 if(await emailTaken(f.email,id))throw new HttpErr(409,'This email is already used by someone else');
 const old=await col('students').findOne({_id:oid(id)});
 await col('students').updateOne({_id:oid(id)},{$set:f});
 if(old&&(old.email||'')!==f.email)await col('sessions').deleteMany({student_id:id});await audit(req,'student_edited',f.name);res.json({ok:true})}));
app.delete('/api/students/:id',h(async(req,res)=>{const id=needId(req.params.id);
 await col('students').deleteOne({_id:oid(id)});await col('attendance').deleteMany({student_id:id});await col('marks').deleteMany({student_id:id});await col('sessions').deleteMany({student_id:id});
 await audit(req,'student_deleted',id);res.json({ok:true})}));

app.get('/api/attendance',h(async(req,res)=>{
 const r=await col('attendance').find({date:needDate(req.query.date)}).toArray();
 res.json(r.map(a=>({student_id:a.student_id,status:a.status,sent:!!a.sent})))}));
app.put('/api/attendance',h(async(req,res)=>{const b=req.body,f={student_id:needId(b.student_id),date:needDate(b.date)};
 if(b.status==='C'){await col('attendance').deleteOne(f);return res.json({ok:true,cleared:true})}
 if(b.status!=='P'&&b.status!=='A')throw bad('Invalid status.');
 const cur=await col('attendance').findOne(f);
 await col('attendance').updateOne(f,{$set:{status:b.status,sent:cur&&cur.status===b.status?!!cur.sent:false}},{upsert:true});res.json({ok:true})}));

app.get('/api/marks',h(async(req,res)=>{
 const r=await col('marks').find({exam:str(req.query.exam,60)}).toArray();
 res.json(r.map(m=>({student_id:m.student_id,marks:m.marks,total:m.total,sent:!!m.sent})))}));
app.put('/api/marks',h(async(req,res)=>{const b=req.body,f={student_id:needId(b.student_id),exam:str(b.exam,60)};
 if(b.marks===''||b.marks==null){await col('marks').deleteOne(f);return res.json({ok:true})}
 const cur=await col('marks').findOne(f),mk=num(b.marks,0,100000),tt=num(b.total,0.01,100000);
 const same=cur&&cur.marks===mk&&cur.total===tt;
 await col('marks').updateOne(f,{$set:{marks:mk,total:tt,sent:same?!!cur.sent:false},$setOnInsert:{at:new Date()}},{upsert:true});res.json({ok:true})}));

app.get('/api/report',h(async(req,res)=>{
 const month=req.query.month,cls=str(req.query.cls,20),student_id=req.query.student_id;
 if(!isMonth(month))throw bad('Choose a month');
 const [y,mo]=month.split('-').map(Number),days=new Date(Date.UTC(y,mo,0)).getUTCDate();
 const from=month+'-01',to=month+'-'+String(days).padStart(2,'0');
 const f={};if(student_id!==undefined)f._id=oid(student_id);else if(cls)f.cls=cls;
 const S=await col('students').find(f).sort({_id:1}).toArray(),ids=S.map(s=>String(s._id));
 const A=await col('attendance').find({student_id:{$in:ids},date:{$gte:from,$lte:to}}).toArray();
 const t0=new Date(Date.UTC(y,mo-1,1)),t1=new Date(Date.UTC(y,mo,1));
 const M=(await col('marks').find({student_id:{$in:ids}}).toArray()).filter(x=>{const t=markTime(x);return t>=t0&&t<t1});
 await audit(req,'report',(student_id?'student ':'standard '+cls+' ')+month);
 res.json({month,days,
  students:S.map(s=>({id:String(s._id),name:s.name,cls:s.cls,roll:s.roll,phone:s.phone})),
  attendance:A.map(a=>({student_id:a.student_id,date:a.date,status:a.status})),
  marks:M.map(x=>({student_id:x.student_id,exam:x.exam,marks:x.marks,total:x.total}))})}));

app.get('/api/templates',h(async(req,res)=>res.json(await getTemplates())));
app.put('/api/templates/:key',h(async(req,res)=>{const k=req.params.key;
 if(!['present','absent','marks'].includes(k))throw bad('Unknown message.');
 const b=req.body,body=str(b.body,1000);if(!body)throw bad('The message cannot be empty.');
 await col('templates').updateOne({_id:k},{$set:{body,wa_template:str(b.wa_template,100),wa_lang:str(b.wa_lang,10)||'en'}});
 await audit(req,'message_edited',k);res.json({ok:true})}));


const waMode=()=>process.env.WA_UNOFFICIAL==='true'?'baileys':(process.env.WA_TOKEN&&process.env.WA_PHONE_ID?'cloud':'none');
let B=null,sock=null,waState='disconnected',waQr=null,waNumber=null,waStarting=false;
async function mongoAuthState(coll){
 const {BufferJSON,initAuthCreds,proto}=B;
 const wr=(d,id)=>coll.updateOne({_id:id},{$set:{v:JSON.stringify(d,BufferJSON.replacer)}},{upsert:true});
 const rd=async id=>{const r=await coll.findOne({_id:id});return r?JSON.parse(r.v,BufferJSON.reviver):null};
 const creds=(await rd('creds'))||initAuthCreds();
 return{state:{creds,keys:{
  get:async(type,ids)=>{const data={};await Promise.all(ids.map(async id=>{let v=await rd(type+'-'+id);if(type==='app-state-sync-key'&&v)v=proto.Message.AppStateSyncKeyData.fromObject(v);data[id]=v}));return data},
  set:async data=>{const t=[];for(const c in data)for(const id in data[c]){const v=data[c][id],k=c+'-'+id;t.push(v?wr(v,k):coll.deleteOne({_id:k}))}await Promise.all(t)}}},
  saveCreds:()=>wr(creds,'creds')}
}
async function startWA(){
 if(waStarting)return;waStarting=true;
 try{
  B=B||await import('@whiskeysockets/baileys');
  const makeWASocket=B.default,{DisconnectReason,fetchLatestBaileysVersion}=B;
  const {state,saveCreds}=await mongoAuthState(col('wa_auth'));
  let version;try{version=(await fetchLatestBaileysVersion()).version}catch(e){}
  sock=makeWASocket({version,auth:state,logger:pino({level:'silent'}),browser:['Student Manager','Chrome','1.0'],syncFullHistory:false,markOnlineOnConnect:false});
  sock.ev.on('creds.update',saveCreds);
  sock.ev.on('connection.update',async u=>{
   const {connection,lastDisconnect,qr}=u;
   if(qr){waQr=await QRCode.toDataURL(qr);waState='qr'}
   if(connection==='open'){waState='connected';waQr=null;waNumber=String((sock.user&&sock.user.id)||'').split(':')[0].split('@')[0]}
   if(connection==='close'){
    const code=lastDisconnect&&lastDisconnect.error&&lastDisconnect.error.output&&lastDisconnect.error.output.statusCode;
    waState='disconnected';waQr=null;waNumber=null;sock=null;waStarting=false;
    if(code===DisconnectReason.loggedOut)await col('wa_auth').deleteMany({});
    setTimeout(startWA,code===DisconnectReason.loggedOut?1000:5000)}
  });
 }catch(e){console.error('WhatsApp start error:',e.message);waStarting=false;setTimeout(startWA,10000)}
}
app.get('/api/wa/status',h(async(req,res)=>res.json({mode:waMode(),state:waState,qr:waQr,number:waNumber})));
app.post('/api/wa/logout',h(async(req,res)=>{if(sock){try{await sock.logout()}catch(e){}}await audit(req,'whatsapp_disconnected','');res.json({ok:true})}));

async function sendMsg(key,s,o){
 const t=(await getTemplates()).find(x=>x.key===key);const to=phoneOf(s.phone);
 if(!to)return{ok:false,error:'No WhatsApp number for '+s.name};
 if(waMode()==='baileys'){
  if(waState!=='connected'||!sock)return{ok:false,error:'WhatsApp is not connected. Open the Students page and scan the QR code.'};
  try{const jid=to+'@s.whatsapp.net',[c]=await sock.onWhatsApp(jid);
   if(!c||!c.exists)return{ok:false,error:s.name+': this number is not on WhatsApp'};
   await sock.sendMessage(c.jid||jid,{text:fill(t.body,o)});return{ok:true}}catch(e){return{ok:false,error:e.message}}}
 if(!process.env.WA_TOKEN||!process.env.WA_PHONE_ID)return{ok:false,notConfigured:true,link:'https://wa.me/'+to+'?text='+encodeURIComponent(fill(t.body,o))};
 const order=key==='marks'?['name','class','marks','total','exam']:['name','class','date'];
 const r=await fetch(`https://graph.facebook.com/v21.0/${process.env.WA_PHONE_ID}/messages`,{method:'POST',headers:{Authorization:'Bearer '+process.env.WA_TOKEN,'Content-Type':'application/json'},
  body:JSON.stringify({messaging_product:'whatsapp',to,type:'template',template:{name:t.wa_template,language:{code:t.wa_lang},components:[{type:'body',parameters:order.map(k=>({type:'text',text:String(o[k])}))}]}})});
 const j=await r.json().catch(()=>({}));
 return r.ok?{ok:true}:{ok:false,error:(j.error&&j.error.message)||'WhatsApp API error'};
}
async function sendOne(type,b){
 const s=(await getStudents()).find(x=>x.id===String(b.student_id));if(!s)return{ok:false,error:'Student not found'};
 const sid=s.id,base={name:s.name,class:s.cls};
 if(type==='attendance'){
  const f={student_id:sid,date:b.date},a=await col('attendance').findOne(f);if(!a)return{ok:false,error:'Mark attendance first'};
  const r=await sendMsg(a.status==='P'?'present':'absent',s,{...base,date:fd(b.date)});
  if(r.ok)await col('attendance').updateOne(f,{$set:{sent:true}});return r}
 const f={student_id:sid,exam:b.exam||''},m=await col('marks').findOne(f);if(!m)return{ok:false,error:'Enter marks first'};
 const r=await sendMsg('marks',s,{...base,marks:m.marks,total:m.total,exam:b.exam});
 if(r.ok)await col('marks').updateOne(f,{$set:{sent:true}});return r}

function sendArgs(b,needStudent){
 if(!b||!['attendance','marks'].includes(b.type))throw bad('Invalid request.');
 const a={type:b.type,cls:str(b.cls,20)};
 if(needStudent)a.student_id=needId(b.student_id);
 if(b.type==='attendance')a.date=needDate(b.date);else a.exam=str(b.exam,60);
 return a}
app.post('/api/send',limit(200,3600e3,r=>'send|'+r.user.email),h(async(req,res)=>{const a=sendArgs(req.body,true);res.json(await sendOne(a.type,a))}));
app.post('/api/queue',h(async(req,res)=>{const {type,date,exam,cls}=sendArgs(req.body);
 const S=await col('students').find(cls?{cls}:{}).toArray(),byId=Object.fromEntries(S.map(s=>[String(s._id),s])),ids=Object.keys(byId);
 const rows=type==='attendance'?await col('attendance').find({date,sent:{$ne:true},student_id:{$in:ids}}).toArray():await col('marks').find({exam,sent:{$ne:true},student_id:{$in:ids}}).toArray();
 const T=Object.fromEntries((await col('templates').find().toArray()).map(t=>[t._id,t.body]));
 res.json(rows.map(r=>{const s=byId[r.student_id],to=phoneOf(s.phone);
  const text=type==='attendance'?fill(T[r.status==='P'?'present':'absent'],{name:s.name,class:s.cls,date:fd(date)}):fill(T.marks,{name:s.name,class:s.cls,marks:r.marks,total:r.total,exam});
  return{student_id:r.student_id,name:s.name,cls:s.cls,link:to?'https://wa.me/'+to+'?text='+encodeURIComponent(text):''}}))}));
app.post('/api/mark-sent',h(async(req,res)=>{const a=sendArgs(req.body,true);
 if(a.type==='attendance')await col('attendance').updateOne({student_id:a.student_id,date:a.date},{$set:{sent:true}});
 else await col('marks').updateOne({student_id:a.student_id,exam:a.exam},{$set:{sent:true}});res.json({ok:true})}));
const job={running:false,sent:0,failed:0,total:0,lastError:''};
app.get('/api/send-status',(req,res)=>res.json(job));
app.post('/api/send-all',limit(30,3600e3,r=>'sendall|'+r.user.email),h(async(req,res)=>{const {type,date,exam,cls}=sendArgs(req.body);
 if(waMode()==='none')return res.json({notConfigured:true});
 if(job.running)return res.status(409).json({error:'Messages are already being sent. Please wait.'});
 const ids=(await col('students').find(cls?{cls}:{}).toArray()).map(s=>String(s._id));
 const rows=type==='attendance'
  ?await col('attendance').find({date,sent:{$ne:true},student_id:{$in:ids}}).toArray()
  :await col('marks').find({exam,sent:{$ne:true},student_id:{$in:ids}}).toArray();
 Object.assign(job,{running:rows.length>0,sent:0,failed:0,total:rows.length,lastError:''});
 res.json({queued:rows.length});
 if(!rows.length)return;
 try{for(const r of rows){
  const x=await sendOne(type,{student_id:r.student_id,date,exam}).catch(e=>({ok:false,error:e.message}));
  if(x.ok)job.sent++;else{job.failed++;job.lastError=x.error||'';if(/not connected/i.test(job.lastError))break}
  await new Promise(z=>setTimeout(z,waMode()==='baileys'?3000+Math.random()*4000:250))}}
 finally{job.running=false}}));

// ---------- Send one file to every parent in a standard (needs the linked WhatsApp) ----------
const FILE_TYPES={pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',txt:'text/plain',mp4:'video/mp4'};
const sniff=(b,ext)=>{const is=(t,o=0)=>b.subarray(o,o+t.length).toString('latin1')===t;
 if(ext==='pdf')return is('%PDF');
 if(ext==='jpg'||ext==='jpeg')return b[0]===0xFF&&b[1]===0xD8&&b[2]===0xFF;
 if(ext==='png')return b[0]===0x89&&is('PNG',1);
 if(ext==='gif')return is('GIF8');
 if(ext==='webp')return is('RIFF')&&is('WEBP',8);
 if(['docx','xlsx','pptx'].includes(ext))return b[0]===0x50&&b[1]===0x4B;
 if(['doc','xls','ppt'].includes(ext))return b[0]===0xD0&&b[1]===0xCF&&b[2]===0x11&&b[3]===0xE0;
 if(ext==='mp4')return is('ftyp',4);
 if(ext==='txt')return !b.subarray(0,2000).includes(0);
 return false};
async function fileRecipients(cls){
 const S=(await getStudents()).filter(s=>s.cls===cls),seen=new Set(),list=[];let noPhone=0;
 for(const s of S){const to=phoneOf(s.phone);if(!to||to.length<10){noPhone++;continue}if(seen.has(to))continue;seen.add(to);list.push({to,name:s.name})}
 return{students:S.length,noPhone,list}}
async function broadcast(list,msg){
 const gap=+process.env.FILE_SEND_GAP_MS||3000;
 try{for(const x of list){
  try{if(waState!=='connected'||!sock)throw new Error('WhatsApp is not connected.');
   const jid=x.to+'@s.whatsapp.net',[c]=await sock.onWhatsApp(jid);
   if(!c||!c.exists)throw new Error(x.name+': this number is not on WhatsApp');
   await sock.sendMessage(c.jid||jid,msg);job.sent++}
  catch(e){job.failed++;job.lastError=e.message;if(/not connected/i.test(e.message))break}
  await new Promise(z=>setTimeout(z,gap+Math.random()*gap))}}
 finally{job.running=false}}
app.post('/api/messages/send',limit(20,3600e3,r=>'msg|'+r.user.email),h(async(req,res)=>{
 const cls=str(req.body&&req.body.cls,20),text=str(req.body&&req.body.text,1000);
 if(!cls)throw bad('Choose a standard.');if(!text)throw bad('Type a message first.');
 const r=await fileRecipients(cls);if(!r.list.length)throw bad('No student in this standard has a WhatsApp number.');
 if(waMode()!=='baileys'){await audit(req,'message_prepared',cls+' | '+r.list.length+' numbers');
  return res.json({linkMode:true,noPhone:r.noPhone,items:r.list.map(x=>({name:x.name,cls,link:'https://wa.me/'+x.to+'?text='+encodeURIComponent(text)}))})}
 if(waState!=='connected'||!sock)throw bad('WhatsApp is not connected. Open the Students page and scan the QR code.');
 if(job.running)throw new HttpErr(409,'Messages are already being sent. Please wait until they finish.');
 Object.assign(job,{running:true,sent:0,failed:0,total:r.list.length,lastError:''});
 await audit(req,'message_sent',cls+' | '+r.list.length+' numbers | '+text.slice(0,60));
 res.json({queued:r.list.length,skippedNoNumber:r.noPhone});
 broadcast(r.list,{text})}));
app.get('/api/files/preview',h(async(req,res)=>{
 const cls=str(req.query.cls,20);if(!cls)throw bad('Choose a standard.');
 const r=await fileRecipients(cls);res.json({students:r.students,noPhone:r.noPhone,recipients:r.list.length})}));
app.post('/api/files/send',express.raw({type:()=>true,limit:'10mb'}),limit(10,3600e3,r=>'file|'+r.user.email),h(async(req,res)=>{
 if(waMode()!=='baileys')throw bad('Sending files needs the linked WhatsApp. Connect it on the Students page first.');
 const cls=str(req.query.cls,20),caption=str(req.query.caption,500);
 const name=str(req.query.name,120).replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_')||'file';
 const ext=(name.includes('.')?name.split('.').pop():'').toLowerCase();
 if(!cls)throw bad('Choose a standard.');
 if(!FILE_TYPES[ext])throw bad('This file type is not allowed. Use PDF, image, Word, Excel, PowerPoint, text or MP4.');
 const buf=req.body;if(!Buffer.isBuffer(buf)||!buf.length)throw bad('Choose a file first.');
 if(!sniff(buf,ext))throw bad('This does not look like a real .'+ext+' file.');
 if(waState!=='connected'||!sock)throw bad('WhatsApp is not connected. Open the Students page and scan the QR code.');
 if(job.running)throw new HttpErr(409,'Messages are already being sent. Please wait until they finish.');
 const r=await fileRecipients(cls);if(!r.list.length)throw bad('No student in this standard has a WhatsApp number.');
 Object.assign(job,{running:true,sent:0,failed:0,total:r.list.length,lastError:''});
 await audit(req,'file_sent',cls+' | '+name+' | '+r.list.length+' numbers');
 res.json({queued:r.list.length,skippedNoNumber:r.noPhone});
 const mime=FILE_TYPES[ext],cap=caption?{caption}:{};
 const msg=['jpg','jpeg','png','webp','gif'].includes(ext)?{image:buf,...cap}:ext==='mp4'?{video:buf,...cap}:{document:buf,mimetype:mime,fileName:name,...cap};
 broadcast(r.list,msg)}));

app.use('/api',(req,res)=>res.status(404).json({error:'Not found'}));
app.use((err,req,res,next)=>{res.status(err&&err.status&&err.status<500?err.status:400).json({error:err&&err.status===413?'The file is too big (maximum 10 MB).':'Invalid request'})});

(async()=>{try{ const url=process.env.TURSO_DATABASE_URL,authToken=process.env.TURSO_AUTH_TOKEN;
 if(!url)throw new Error('TURSO_DATABASE_URL is required');
 db=createClient({url,authToken});
 await db.execute('CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(collection,id))');
 for(const f of ['student_id','date','exam','email','role','cls']){try{await db.execute("CREATE INDEX IF NOT EXISTS ix_rec_"+f+" ON records(collection, json_extract(data,'$."+f+"'))")}catch(e){console.warn('Index '+f+' not created:',e.message)}}
 const purge=async()=>{try{const now=new Date().toISOString();
  await db.batch([{sql:"DELETE FROM records WHERE collection IN ('sessions','otps') AND json_extract(data,'$.expires.\"$date\"')<?",args:[now]},
   {sql:"DELETE FROM records WHERE collection='audit' AND json_extract(data,'$.at.\"$date\"')<?",args:[new Date(Date.now()-90*864e5).toISOString()]}],'write')}catch(e){console.warn('Clean-up failed:',e.message)}};
 await purge();setInterval(purge,30*60*1000).unref();
 await col('attendance').createIndex({student_id:1,date:1},{unique:true});
 await col('marks').createIndex({student_id:1,exam:1},{unique:true});
 await col('sessions').createIndex({expires:1},{expireAfterSeconds:0});await col('otps').createIndex({expires:1},{expireAfterSeconds:0});
 await col('audit').createIndex({at:1},{expireAfterSeconds:90*24*3600});
 await col('attendance').createIndex({date:1});await col('marks').createIndex({exam:1});
 for(const e of String(process.env.ADMIN_EMAIL||'').split(',').map(normEmail).filter(Boolean))await col('users').updateOne({_id:e},{$setOnInsert:{role:'admin',name:'Admin',active:true}},{upsert:true});
 if(!await col('users').findOne({role:'admin'}))console.warn('No admin exists. Set ADMIN_EMAIL on the server so someone can log in.');
 for(const d of DEFAULTS){const {_id,...rest}=d;await col('templates').updateOne({_id},{$setOnInsert:rest},{upsert:true})}
 app.listen(process.env.PORT||3000,()=>console.log('Running'));
 if(waMode()==='baileys')startWA()
}catch(e){console.error('Startup error:',e.message);process.exit(1)}})();
