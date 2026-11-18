import {it,expect,vi,afterEach} from 'vitest';
import {evaluate} from '../src/evaluator.ts';
import {detect,readChat} from '../src/detector.ts';
const spike=detect(readChat('tests/fixtures/chat.jsonl'),{mediaStart:'2026-01-01T00:00:00Z',durationMs:95000})[0];
const decision={decision:'accept',reason:'Clear outcome',suggestedCaption:'The finish',score:84,reviewFlags:[]};
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
function setup(){vi.stubEnv('OLLAMA_MODEL','test:local');vi.stubEnv('OLLAMA_BASE_URL','http://127.0.0.1:11434');}
it('constrains schema and input, sends no file or source metadata, and gates visual-only clips',async()=>{
 setup();const mock=vi.fn(async()=>Response.json({done:true,message:{content:JSON.stringify(decision)}}));vi.stubGlobal('fetch',mock);
 expect((await evaluate({segments:[]},spike)).decision).toMatchObject({decision:'review',reviewFlags:['visual_only']});
 const [,init]=mock.mock.calls[0] as unknown as [string,RequestInit];const body=JSON.parse(String(init.body));expect(body.stream).toBe(false);expect(body.format.required).toContain('reviewFlags');
 expect(Object.keys(JSON.parse(body.messages[1].content))).toEqual(['transcript','nearbyChat','detection']);expect(body.messages[0].content).toContain('untrusted');
});
it.each(['unreachable','invalid','missing','timeout'])('keeps %s evaluation from authorizing a post',async kind=>{
 setup();vi.stubGlobal('fetch',async()=>{if(kind==='unreachable'||kind==='timeout')throw Error(kind);if(kind==='missing')return new Response(null,{status:404});return Response.json({done:true,message:{content:JSON.stringify({...decision,score:101})}});});
 const r=await evaluate({segments:[{startMs:0,endMs:500,text:'Test'}]},spike);expect(r.error).toBeTruthy();expect(r.decision).toBeUndefined();expect(r.model).toBe('test:local');
});
