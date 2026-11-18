import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {stateDir} from './local.ts';
export function openDb(readOnly=false){
 const path=join(stateDir(),'jobs.sqlite');
 if(!readOnly)mkdirSync(stateDir(),{recursive:true});
 if(readOnly&&!existsSync(path))return null;
 const db=new DatabaseSync(path,{readOnly});
 db.exec('PRAGMA busy_timeout=10000');
 if(!readOnly){
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON');
 const v=db.prepare('PRAGMA user_version').get()!.user_version;
 if(v===0)atomic(db,()=>db.exec(readFileSync(new URL('../migrations/001.sql',import.meta.url),'utf8')));
 else if(v!==1)throw Error('Unknown database version');
 }
 return db;
}
export function atomic<T>(db:DatabaseSync,f:()=>T):T{db.exec('BEGIN IMMEDIATE');try{const r=f();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
export function status(){const db=openDb(true);if(!db)return {jobs:[],intents:[],policy:[]};try{return {
 jobs:db.prepare('SELECT id,session,state,reason,result,evaluation,intent FROM jobs ORDER BY rowid DESC').all(),
 intents:db.prepare('SELECT * FROM intents ORDER BY id DESC').all(),
 policy:db.prepare('SELECT * FROM policy').all(),cooldowns:db.prepare('SELECT * FROM cooldown').all()
 };}finally{db.close();}}
