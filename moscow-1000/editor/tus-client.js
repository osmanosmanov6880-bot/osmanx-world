/* R5 private editor-only tus 1.0.0 uploader. Upload URL is a bearer capability: never persist or log it. */
(function(root){'use strict';
const CHUNK=8*1024*1024; // Cloudflare minimum non-final tus chunk 5 MiB.
function validTarget(s){try{const u=new URL(s);return u.protocol==='https:'&&u.hostname==='upload.videodelivery.net'&&!u.username&&!u.password&&!u.hash;}catch{return false;}}
function makeTransfer(file,provision,{fetcher=fetch,onProgress=()=>{},chunkBytes=CHUNK}={}){
 if(!file||!Number.isSafeInteger(file.size)||file.size<=0||file.size>5*1024*1024*1024)throw Error('Размер видео не поддерживается');
 if(typeof provision!=='function')throw Error('Нет защищённого API загрузки');
 if(!Number.isInteger(chunkBytes)||chunkBytes<5242880||chunkBytes>50*1024*1024)throw Error('Неверный размер части');
 let uploadURL=null,session=null,paused=false,completed=false,controller=null,running=null,offset=0;
 async function remoteOffset(){const res=await fetcher(uploadURL,{method:'HEAD',headers:{'Tus-Resumable':'1.0.0'},cache:'no-store',signal:controller.signal});if(!res.ok)throw Error('Stream не вернул позицию загрузки (HEAD '+res.status+')');const n=Number(res.headers.get('Upload-Offset'));if(!Number.isSafeInteger(n)||n<0||n>file.size)throw Error('Некорректная позиция Stream');return n;}
 async function run(){if(completed)return {complete:true,session};if(running)return running;paused=false;controller=new AbortController();
 running=(async()=>{try{
   if(!session){session=await provision();if(!session?.ok||!validTarget(session.uploadURL)||session.protocol!=='tus-1.0.0')throw Error('Неверный одноразовый адрес Stream');uploadURL=session.uploadURL;}
   offset=await remoteOffset();onProgress({offset,total:file.size,percent:Math.floor(100*offset/file.size),state:'uploading'});
   while(offset<file.size&&!paused){const end=Math.min(offset+chunkBytes,file.size);const response=await fetcher(uploadURL,{method:'PATCH',headers:{'Tus-Resumable':'1.0.0','Upload-Offset':String(offset),'Content-Type':'application/offset+octet-stream'},body:file.slice(offset,end),signal:controller.signal});if(response.status!==204)throw Error('Stream отклонил часть видео (HTTP '+response.status+')');const newOffset=Number(response.headers.get('Upload-Offset'));
    if(!Number.isSafeInteger(newOffset)||newOffset<=offset||newOffset>end)throw Error('Stream вернул неожиданную позицию. Перепроверьте загрузку.');offset=newOffset;onProgress({offset,total:file.size,percent:Math.floor(100*offset/file.size),state:'uploading'});
   }
   if(offset===file.size){completed=true;onProgress({offset,total:file.size,percent:100,state:'uploaded'});return {complete:true,session};}
   onProgress({offset,total:file.size,percent:Math.floor(100*offset/file.size),state:'paused'});return {complete:false,session};
 }catch(e){if(paused){onProgress({offset,total:file.size,percent:Math.floor(100*offset/file.size),state:'paused'});return {complete:false,session};}
 onProgress({offset,total:file.size,percent:Math.floor(100*offset/file.size),state:'interrupted'});throw e;
 }finally{running=null;controller=null;}})();return running;
 }
 function pause(){paused=true;controller?.abort();}
 return {start:run,resume:run,pause,get state(){return {offset,total:file.size,hasSession:!!session,completed,paused};}};
}
root.OSMANXTus={makeTransfer,validTarget,chunkBytes:CHUNK};
})(typeof window!=='undefined'?window:globalThis);
