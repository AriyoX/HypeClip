import ffprobe from '@ffprobe-installer/ffprobe';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname } from 'node:path';
const exec=promisify(execFile);
export async function probe(path:string,vertical=false){
 const {stdout}=await exec(process.env.FFPROBE || ffprobe.path,['-v','error','-show_format','-show_streams','-of','json','-i',path],{windowsHide:true,timeout:30000});
 const {streams,format}=JSON.parse(stdout);
 const video=streams.find((s:{codec_type:string;disposition?:{attached_pic:number}})=>s.codec_type==='video'&&!s.disposition?.attached_pic);
 const durationMs=Math.round(Number(format.duration)*1000);
 if(!video||!Number.isSafeInteger(durationMs)||durationMs<=0) throw Error('Missing video stream or duration');
 if(vertical && (extname(path).toLowerCase()!=='.mp4'||!format.format_name.split(',').includes('mp4')||format.tags?.major_brand?.trim()==='qt'||video.height<=video.width || (video.side_data_list??[]).some((s:{rotation?:number})=>Number(s.rotation||0)%180!==0))) throw Error('Expected a portrait MP4');
 return {width:Number(video.width),height:Number(video.height),durationMs};
}
