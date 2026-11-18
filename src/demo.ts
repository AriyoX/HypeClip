import {mkdirSync,copyFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Request,Result} from './worker.ts';
import {hashFile,writeJson} from './local.ts';
import {processSession,runtime} from './pipeline.ts';
import type {DatabaseSync} from 'node:sqlite';
const fixture=(name:string)=>fileURLToPath(new URL('../tests/fixtures/'+name,import.meta.url));
export async function fixtureResult(r:Request):Promise<Result>{
 const dir=r.candidate.outputDir;mkdirSync(dir,{recursive:true});
 const result:Result={version:1,ok:true,originalPath:join(dir,'original.mp4'),verticalPath:join(dir,'vertical.mp4'),transcriptPath:join(dir,'transcript.json'),subtitlePath:join(dir,'subtitles.srt'),durationMs:55000,sha256:'',qualityFlags:[]};
 copyFileSync(fixture('cut.mp4'),result.originalPath);copyFileSync(fixture('cut-vertical.mp4'),result.verticalPath);
 const text='I caught the last train with one second left.';
 writeJson(result.transcriptPath,{segments:[{startMs:28500,endMs:31200,text}]});writeFileSync(result.subtitlePath,'1\n00:00:28,500 --> 00:00:31,200\n'+text+'\n');
 result.sha256=await hashFile(result.verticalPath);writeJson(join(dir,'request.json'),r);writeJson(join(dir,'result.json'),result);return result;
}
export async function demo(db:DatabaseSync,worker=false){
 return {media:worker?'workers.media':'prerendered contract fixture',jobs:await processSession(db,{session:worker?'demo-worker':'demo',source:fixture('recording.mp4'),chat:fixture('chat.jsonl'),mediaStart:'2026-01-01T00:00:00Z',offsetMs:0,reactionMs:4000,rights:true,layout:'fit-pad',fixture:true},worker?runtime:{...runtime,render:fixtureResult})};
}
