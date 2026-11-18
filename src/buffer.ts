import {z} from 'zod';
import {env,safeMessage} from './local.ts';
export class ProviderError extends Error{
 retryAt:number; definitive:boolean;
 constructor(message:string, retryAt=0, definitive=false){super(message);this.retryAt=retryAt;this.definitive=definitive;}
}
export function retryTime(value:string|null,now=Date.now()){
 if(!value) return 0;
 const time=/^\d+$/.test(value)?now+Number(value)*1000:Date.parse(value);
 return Number.isFinite(time)?Math.max(now,time):0;
}
const fields='id channelId status schedulingType notificationStatus sentAt externalLink error { message } text assets { source }';
const postSchema=z.object({id:z.string().min(1),channelId:z.string(),status:z.string(),schedulingType:z.string().nullable(),notificationStatus:z.string().nullable(),sentAt:z.string().nullable(),externalLink:z.string().nullable(),error:z.object({message:z.string()}).nullable(),text:z.string(),assets:z.array(z.object({source:z.string()}))});
export type Post=z.infer<typeof postSchema>;
export type Mode='shareNow'|'addToQueue';
const channelSchema=z.object({id:z.string(),name:z.string(),service:z.string(),organizationId:z.string(),isLocked:z.boolean(),isDisconnected:z.boolean(),isQueuePaused:z.boolean(),allowedActions:z.array(z.string())});
export type Channel=z.infer<typeof channelSchema>;
export type Input={channelId:string,text:string,url:string,mode:Mode};
export interface Provider{
 channel(id:string):Promise<Channel>;create(input:Input):Promise<string>;read(id:string):Promise<Post>; matches(channel:Channel,input:Input):Promise<Post[]>;
}
async function gql(query:string, variables:object){
 const token=env('BUFFER_ACCESS_TOKEN');
 const r=await fetch('https://api.buffer.com',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw new ProviderError('Buffer HTTP '+r.status,retryTime(r.headers.get('retry-after')),r.status===429);
 const b=await r.json();
 if(b.errors?.length)throw new ProviderError(safeMessage(Error(b.errors.map((e:{message:string})=>e.message).join(', '))),retryTime(r.headers.get('retry-after')));
 if(!b.data)throw Error('Buffer returned no data');return b.data;
}
export function sameAsset(p:Post,i:Input){return p.channelId===i.channelId && p.text===i.text && p.assets.some(a=>a.source===i.url);}
export const buffer:Provider={
 async channel(id){
 const data=await gql('query($input:ChannelInput!){channel(input:$input){ id name service organizationId isLocked isDisconnected isQueuePaused allowedActions }}',{input:{id}});
 const channel=channelSchema.parse(data.channel);if(channel.id!==id||channel.service!=='tiktok') throw Error('Configured destination must resolve to that TikTok channel'); return channel;
 },
 async create({channelId,text,url,mode}){
 const data=await gql('mutation($input:CreatePostInput!){createPost(input:$input){__typename ... on PostActionSuccess {post{id}} ... on MutationError {message}}}',{input:{channelId,text,mode,schedulingType:'automatic',assets:[{video:{url}}]}});
 const result=data.createPost;if(result?.__typename==='PostActionSuccess')return z.string().min(1).parse(result.post.id);
 if(result?.message)throw new ProviderError(safeMessage(Error(result.message)),0,true);throw Error('Unknown mutation outcome');
 },
 async read(id){const d=await gql('query($input:PostInput!){post(input:$input){'+fields+'}}',{input:{id}});return postSchema.parse(d.post);},
 async matches(channel,input){
 const found:Post[]=[];let after:string|null=null;const cursors=new Set<string>();
 do{
 const d=await gql('query($input:PostsInput!,$after:String){posts(input:$input,first:100,after:$after){edges{node{'+fields+'}} pageInfo{hasNextPage endCursor}}}',{input:{organizationId:channel.organizationId,filter:{channelIds:[channel.id]}},after});
 for(const edge of d.posts.edges){const post=postSchema.parse(edge.node);if(sameAsset(post,input))found.push(post);}
 if(!d.posts.pageInfo.hasNextPage)break;after=z.string().min(1).parse(d.posts.pageInfo.endCursor);if(cursors.has(after))throw Error('Buffer repeated a page cursor');cursors.add(after);
 }while(true);return found;
 }
};
export function restriction(c:Channel){
 if(c.service!=='tiktok')return 'Destination is not TikTok';
 if(c.isLocked||c.isDisconnected)return 'Channel locked or disconnected';
 if(c.isQueuePaused)return 'Channel queue paused';
 if(!c.allowedActions.includes('scheduleUpdates'))return 'Channel lacks scheduling permission or requires approval';
 return process.env.HYPECLIP_CHANNEL_REQUIREMENTS || '';
}
