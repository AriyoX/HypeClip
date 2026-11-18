import {appendFileSync,existsSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {z} from 'zod';
import {Chat,readChat} from './detector.ts';
import {env,jsonFile,writeJson} from './local.ts';
const socketUrl='wss://eventsub.wss.twitch.tv/ws';
const type='channel.chat.message';
const authSchema=z.object({client_id:z.string().min(1),user_id:z.string().min(1),scopes:z.array(z.string())});
async function identity(token:string){
 const r=await fetch('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:'OAuth '+token},redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error('Twitch token validation HTTP '+r.status);
 const id=authSchema.parse(await r.json());if(!id.scopes.includes('user:read:chat'))throw Error('Twitch user token requires user:read:chat');return id;
}
const event=z.object({metadata:z.object({message_id:z.string(),message_timestamp:z.string(),subscription_type:z.literal(type)}),payload:z.object({event:z.object({broadcaster_user_id:z.string(),message_id:z.string(),chatter_user_id:z.string(),message:z.object({text:z.string(),fragments:z.array(z.object({type:z.string(),text:z.string()}))})})})});
export function notification(value:unknown,broadcaster:string,receivedAt:string){
 const f=event.parse(value);const e=f.payload.event;
 if(e.broadcaster_user_id!==broadcaster)throw Error('Unexpected Twitch broadcaster');
 return {...Chat.parse({eventId:f.metadata.message_id,eventAt:f.metadata.message_timestamp,receivedAt,userId:e.chatter_user_id,text:e.message.text,emotes:e.message.fragments.filter(x=>x.type==='emote').map(x=>x.text)}),messageId:e.message_id,broadcasterId:broadcaster};
}
export function handoffUrl(raw:string){
 const u=new URL(raw);if(u.protocol!=='wss:'||!u.hostname.endsWith('.twitch.tv')||u.username||u.password)throw Error('Unexpected Twitch reconnect URL');return u.href;
}
type Transport={connect:(url:string)=>WebSocket;subscribe:(sessionId:string)=>Promise<void>;write:(data:unknown,receivedAt:string)=>void;validate:()=>Promise<unknown>};
export function listen(t:Transport,signal:AbortSignal){
 return new Promise<void>((resolve,reject)=>{
 const sockets=new Set<WebSocket>();let active:WebSocket|undefined,connecting:WebSocket|undefined,stopped=false;
 let attempts=0,retry:NodeJS.Timeout|undefined;const timers=new Map<WebSocket,NodeJS.Timeout>();
 const hourly=setInterval(()=>void t.validate().catch(stop),3600000);
 const abort=()=>stop();
 function stop(error?:unknown){
 if(stopped)return;stopped=true;clearInterval(hourly);clearTimeout(retry);for(const timer of timers.values())clearTimeout(timer);
 signal.removeEventListener('abort',abort);for(const ws of sockets)ws.close();if(error)reject(error);else resolve();
 }
 function connect(url:string,handoff=false){
 if(stopped||connecting)return;
 const ws=t.connect(url);sockets.add(ws);connecting=ws;let keepalive=15000;
 function deadline(){clearTimeout(timers.get(ws));timers.set(ws,setTimeout(()=>ws.close(),keepalive));}
 deadline();
 ws.addEventListener('message',async m=>{
 const receivedAt=new Date().toISOString();if(stopped)return;deadline();
 try{
 const frame=JSON.parse(String(m.data)),kind=frame.metadata.message_type;
 if(kind==='session_welcome'){
 const old=active;active=ws;connecting=undefined;attempts=0;
 keepalive=(z.number().positive().parse(frame.payload.session.keepalive_timeout_seconds)+2)*1000;deadline();
 if(handoff)old?.close();else await t.subscribe(z.string().min(1).parse(frame.payload.session.id));
 }else if(kind==='notification'&&frame.metadata.subscription_type===type)t.write(frame,receivedAt);
 else if(kind==='session_reconnect'&&ws===active)connect(handoffUrl(frame.payload.session.reconnect_url),true);
 else if(kind==='revocation')throw Error('Twitch subscription revoked: '+frame.payload.subscription.status);
 }catch(e){stop(e);}
 });
 ws.addEventListener('error',()=>ws.close());
 ws.addEventListener('close',()=>{
 clearTimeout(timers.get(ws));timers.delete(ws);sockets.delete(ws);
 if(active===ws)active=undefined;if(connecting===ws)connecting=undefined;
 if(!stopped&&!active&&!connecting){console.error('Twitch disconnected. Reconnecting. Messages during the gap may be missing.');clearTimeout(retry);retry=setTimeout(()=>connect(socketUrl),Math.min(30000,1000*2**Math.min(5,attempts++)));}
 });
 }
 signal.addEventListener('abort',abort,{once:true});
 if(signal.aborted)stop();else connect(socketUrl);
 });
}
export async function collect(session:string,path:string,signal:AbortSignal){
 const token=env('TWITCH_USER_TOKEN'),broadcaster=env('TWITCH_BROADCASTER_ID');const id=await identity(token);
 mkdirSync(dirname(path),{recursive:true});const meta=path+'.session.json';if(existsSync(meta)){const m=jsonFile(meta);if(m.session!==session||m.broadcaster!==broadcaster)throw Error('Chat log belongs to another session or channel');}
 else{if(existsSync(path))throw Error('Choose a fresh chat path or resume a bound session');writeJson(meta,{session,broadcaster});}
 appendFileSync(path,'',{mode:0o600});const seen=new Set(readChat(path).map(x=>x.eventId));
 await listen({connect:url=>new WebSocket(url),validate:()=>identity(token),subscribe:async session_id=>{
 const r=await fetch('https://api.twitch.tv/helix/eventsub/subscriptions',{method:'POST',headers:{Authorization:'Bearer '+token,'Client-Id':id.client_id,'Content-Type':'application/json'},body:JSON.stringify({type,version:'1',condition:{broadcaster_user_id:broadcaster,user_id:id.user_id},transport:{method:'websocket',session_id}}),redirect:'error',signal:AbortSignal.timeout(10000)});
 if(r.status!==202)throw Error('Twitch chat subscription HTTP '+r.status);console.error('Collecting Twitch chat from '+broadcaster+' into '+path);
 },write:(frame,time)=>{const m=notification(frame,broadcaster,time);if(!seen.has(m.eventId)){appendFileSync(path,JSON.stringify(m)+'\n',{flush:true});seen.add(m.eventId);}}},signal);
 return {session,broadcaster,messages:seen.size,path};
}
