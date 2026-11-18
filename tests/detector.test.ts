import {expect,it} from 'vitest';
import {detect,readChat} from '../src/detector.ts';
const chat=readChat('tests/fixtures/chat.jsonl'),t={mediaStart:'2026-01-01T00:00:00Z',durationMs:95000};
it('maps event time to source time, subtracts reaction delay and pads the event',()=>{
 expect(detect(chat,t)[0]).toMatchObject({peakMs:60000,eventMs:56000,startMs:26000,endMs:81000,score:92,ready:true});
 expect(detect(chat,{...t,offsetMs:-6000})[0].startMs).toBe(20000);
 expect(detect(chat,{...t,offsetMs:2000})[0].startMs).toBe(28000);
 expect(detect(chat,{...t,durationMs:65000})[0].endMs).toBe(65000);
 expect(detect(chat,{...t,durationMs:65000,live:true})[0]).toMatchObject({endMs:81000,ready:false});
});
it('caps a single user, deduplicates deliveries and merges adjacent spikes deterministically',()=>{
 expect(detect(chat.map(m=>({...m,userId:'one'})),t)).toEqual([]);
 const more=chat.map(m=>({...m,eventId:m.eventId+'b',eventAt:'2026-01-01T00:01:10Z'}));
 const a=detect([...chat,...more],t);expect(a).toHaveLength(1);expect(a[0].endMs).toBe(91000);
 expect(detect([...more,...chat,...chat].reverse(),t)).toEqual(a);
});
