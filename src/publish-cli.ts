import {Command,Option} from 'commander';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {env} from './local.ts';
import {openDb,status} from './db.ts';
import {publish,reconcile} from './publisher.ts';
export const print=(v:unknown)=>console.log(JSON.stringify(v,null,2));
export function publisherCommands(cli:Command){
 cli.command('status').description('Read local jobs, publishing intents and policy').action(()=>print(status()));
 cli.command('publish').requiredOption('--file <mp4>').requiredOption('--highlight <id>').requiredOption('--caption-file <path>')
 .option('--channel <id>','Confirm configured TikTok destination for live send')
 .addOption(new Option('--mode <mode>').choices(['shareNow','addToQueue']).default('addToQueue'))
 .addOption(new Option('--dry-run').conflicts('live')).option('--live','Upload and send the selected video')
 .action(async o=>{
 const channel=o.live?env('BUFFER_CHANNEL_ID'):(process.env.BUFFER_CHANNEL_ID || 'unconfigured');if(o.live&&o.channel!==channel)throw Error('--live requires --channel matching BUFFER_CHANNEL_ID');
 const db=openDb(!o.live);try{print(await publish(db,{path:o.file,highlight:o.highlight,caption:readFileSync(o.captionFile,'utf8').trim(),channel,mode:o.mode,live:!!o.live}));}finally{db?.close();}
 });
 cli.command('reconcile <intent>').option('--post-id <id>','Verify a specific remote post').action(async(id,o)=>{
 const db=openDb()!;try{print(await reconcile(db,z.coerce.number().int().positive().parse(id),undefined,o.postId));}finally{db.close();}
 });
}
