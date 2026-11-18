import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3';
import {createReadStream,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {env} from './local.ts';
export function assetUrl(hash:string){
 const base=new URL(env('HYPECLIP_R2_PUBLIC_URL'));
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash) throw Error('Use a permanent public HTTPS R2 URL');
 return base.href.replace(/\/$/,'')+'/clips/'+hash+'.mp4';
}
export async function host(path:string,hash:string,url:string){
 const account=env('HYPECLIP_R2_ACCOUNT_ID');
 if(!/^[a-f0-9]{32}$/i.test(account)) throw Error('Invalid R2 account ID');
 const client=new S3Client({requestChecksumCalculation:'WHEN_REQUIRED',region:'auto',endpoint:'https://'+account+'.r2.cloudflarestorage.com',credentials:{accessKeyId:env('HYPECLIP_R2_ACCESS_KEY_ID'),secretAccessKey:env('HYPECLIP_R2_SECRET_ACCESS_KEY')}});
 try{ await client.send(new PutObjectCommand({Bucket:env('HYPECLIP_R2_BUCKET'),Key:'clips/'+hash+'.mp4',Body:createReadStream(path),ContentLength:statSync(path).size,ContentType:'video/mp4'})); } finally {client.destroy();}
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(120000)});
 if(response.status!==200||response.headers.get('content-type')?.split(';')[0]!=='video/mp4'||!response.body) throw Error('Anonymous public video check failed ('+response.status+')');
 const digest=createHash('sha256'); for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>) digest.update(chunk);
 if(digest.digest('hex')!==hash) throw Error('Public video digest mismatch');
}
