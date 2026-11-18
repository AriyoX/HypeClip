import {Ajv2020} from 'ajv/dist/2020.js';
import {fileURLToPath} from 'node:url';
import {readFileSync,realpathSync,statSync,mkdirSync} from 'node:fs';
import {dirname,relative,isAbsolute,sep,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {jsonFile,writeJson,hashFile} from './local.ts';
import {probe} from './probe.ts';
const ajv=new Ajv2020();
const schema=(name:string)=>ajv.compile(jsonFile(fileURLToPath(new URL('../contracts/v1/'+name+'.schema.json',import.meta.url))));
const request=schema('request'),result=schema('result'),transcript=schema('transcript');
export interface Request{version:1;candidate:{sessionId:string;candidateId:string;sourcePath:string;startMs:number;endMs:number;outputDir:string};output:{width:number;height:number;layout:'fit-pad'|'center-crop'}}
export interface Result{version:1;ok:true;originalPath:string;verticalPath:string;transcriptPath:string;subtitlePath:string;durationMs:number;sha256:string;qualityFlags:string[]}
export interface Transcript{segments:{startMs:number;endMs:number;text:string}[]}
export function checkRequest(r:Request){if(!request(r)||r.candidate.startMs>=r.candidate.endMs)throw Error('Invalid worker request: '+ajv.errorsText(request.errors));}
const repo=fileURLToPath(new URL('../',import.meta.url));
export async function render(r:Request):Promise<Result>{
 checkRequest(r);const dir=r.candidate.outputDir;
 mkdirSync(dir,{recursive:true});const input=join(dir,'request.json'),output=join(dir,'result.json');writeJson(input,r);
 // Allowlist only environment needed by Python, multimedia tools and local models.
 const allow=/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMDATA|PROGRAMFILES.*|LANG|LC_ALL|VIRTUAL_ENV|CUDA_PATH.*|HF_HOME|HF_HUB_OFFLINE|XDG_CACHE_HOME|FFMPEG|FFPROBE|HYPECLIP_(?:FFMPEG|FFPROBE|WHISPER_[A-Z_]+))$/i;
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>allow.test(k)));
 let failed=false;
 try{await promisify(execFile)(process.env.HYPECLIP_PYTHON||'python',['-m','workers.media','--request',input,'--result',output],{cwd:repo,env,windowsHide:true,timeout:60*60*1000,maxBuffer:1024*1024});}catch{failed=true;}
 let body;try{body=jsonFile(output);}catch{throw Error('Media worker did not write a result. Check python -m workers.media and the worker dependencies.');}
 if(!result(body))throw Error('Invalid worker result: '+ajv.errorsText(result.errors));
 if((body as Result).ok!==true){const err=(body as {error:unknown}).error as {code:string;message:string};throw Error((failed?'':'Worker exit mismatch. ')+err.code+': '+err.message);}
 if(failed)throw Error('Worker reported success with a failing exit code');
 return body as unknown as Result;
}
export async function validateOutput(r:Request,b:Result):Promise<Transcript>{
 if(!result(b)||!b.ok)throw Error('Invalid worker result');
 const root=realpathSync(r.candidate.outputDir);
 const paths=[b.originalPath,b.verticalPath,b.transcriptPath,b.subtitlePath].map(p=>realpathSync(p));
 for(const p of paths){const rel=relative(root,p);if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)||!statSync(p).isFile())throw Error('Worker output outside candidate directory');}
 if(new Set(paths).size!==4)throw Error('Expected four distinct worker artifacts');
 const [media,original,hash]=await Promise.all([probe(b.verticalPath,true),probe(b.originalPath),hashFile(b.verticalPath)]);
 if(hash!==b.sha256||Math.abs(media.durationMs-b.durationMs)>250||Math.abs(original.durationMs-b.durationMs)>1000||Math.abs(b.durationMs-(r.candidate.endMs-r.candidate.startMs))>1000||media.width!==r.output.width||media.height!==r.output.height)throw Error('Worker media dimensions, duration or SHA-256 mismatch');
 const doc=jsonFile(b.transcriptPath);if(!transcript(doc))throw Error('Invalid transcript');
 const data=doc as unknown as Transcript;
 if(data.segments.some(s=>s.endMs<=s.startMs||s.endMs>b.durationMs))throw Error('Transcript exceeds clip timeline');
 const srt=readFileSync(b.subtitlePath,'utf8').replace(/^\uFEFF/,'').trim();
 if(data.segments.length&&!srt)throw Error('Missing subtitle cues');
 for(const block of srt?srt.split(/\r?\n\s*\r?\n/):[]){
 const lines=block.split(/\r?\n/);const match=lines[1]?.match(/^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3}) --> (\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/);
 if(!match||!/^\d+$/.test(lines[0])||!lines.slice(2).join('').trim())throw Error('Invalid SRT cue');
 const [h,m,s,ms,H,M,S,MS]=match.slice(1).map(Number);const start=((h*60+m)*60+s)*1000+ms,end=((H*60+M)*60+S)*1000+MS;
 if(end<=start||end>b.durationMs)throw Error('Subtitle exceeds clip timeline');
 }return data;
}
