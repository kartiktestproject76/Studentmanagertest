// One-time migration. Requires MONGODB_URI, TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
const {MongoClient}=require('mongodb');
const {createClient}=require('@libsql/client');
const names=['students','templates','users','otps','sessions','audit','attendance','marks','wa_auth'];
const mongo=new MongoClient(process.env.MONGODB_URI);
const turso=createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN});
function encode(v){
 if(v instanceof Date)return {$date:v.toISOString()};
 if(v&&v._bsontype==='ObjectId')return {$oid:v.toString()};
 if(Array.isArray(v))return v.map(encode);
 if(v&&typeof v==='object'){const o={};for(const [k,x] of Object.entries(v))o[k]=encode(x);return o}
 return v;
}
(async()=>{if(!process.env.MONGODB_URI||!process.env.TURSO_DATABASE_URL)throw Error('Set MongoDB and Turso environment variables.');
 await mongo.connect();await turso.execute('CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collection,id))');
 const source=mongo.db(process.env.DB_NAME||'studentmanager');
 for(const name of names){const docs=await source.collection(name).find({}).toArray();for(const doc of docs){const id=String(doc._id);
  await turso.execute({sql:'INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data',args:[name,id,JSON.stringify(encode(doc))]});}
  const count=await turso.execute({sql:'SELECT COUNT(*) AS n FROM records WHERE collection=?',args:[name]});console.log(`${name}: copied ${docs.length}; Turso rows ${count.rows[0].n}`)}
 await mongo.close();turso.close();console.log('Migration complete.');
})().catch(async e=>{console.error(e);try{await mongo.close()}catch{};try{turso.close()}catch{};process.exit(1)});
