/** Offline, read-only gallery for actual Chromium QA screenshots (Wave 27).
 * Uses Node 22 standard library only. No browser network, credentials, or
 * uploaded application database. Gallery is labeled verified only when the
 * actual acceptance log and all expected screenshots both agree.
 */
import {readFileSync,writeFileSync,readdirSync} from "node:fs";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";

const directory=resolve(process.argv[2]||"");
if(process.argv.length!==3)throw Error("Artifact directory argument required");
const imagePattern=/^[0-9]{2}-[a-z0-9-]+\.png$/;
const found=readdirSync(directory).filter(n=>imagePattern.test(n)).sort();
if(!found.length)throw Error("No real Chromium screenshots found");
if(found.length>100)throw Error("Screenshot count outside intended bound");

const escapeHtml=s=>String(s).replace(/[&<>"']/g,x=>({
  "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
})[x]);
function caption(name){
  const text=name.slice(3,-4).replaceAll("-"," ");
  return text.charAt(0).toUpperCase()+text.slice(1);
}
function screenshotItem(name){
  const bytes=readFileSync(join(directory,name));
  if(bytes.length<100||bytes.length>8*1024*1024)throw Error("Invalid PNG size");
  if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
    throw Error("Not a PNG: "+name);
  return {file:name,label:caption(name),bytes:bytes.length,
    sha256:createHash("sha256").update(bytes).digest("hex")};
}
const items=found.map(screenshotItem);
let acceptance=null;
try{
  const log=readFileSync(join(directory,"acceptance.log"),"utf8");
  const line=log.split(/\r?\n/).filter(x=>x.includes("BROWSER_ACCEPTANCE_SUCCESS ")).pop();
  if(line){
    const data=JSON.parse(line.split("BROWSER_ACCEPTANCE_SUCCESS ")[1]);
    if(data?.browser==="Chromium" && Array.isArray(data.flows) &&
       data.flows.every(x=>typeof x==="string"&&/^[a-z0-9-]+$/.test(x)) &&
       Number.isInteger(data.screenshots) &&
       Number.isInteger(data.console_exceptions) &&
       typeof data.horizontal_overflow==="number"){
      acceptance=data;
    }
  }
}catch(e){
  if(e.code!=="ENOENT")throw e;
}
const verified=acceptance!==null && acceptance.screenshots===items.length &&
  acceptance.console_exceptions===0 && acceptance.horizontal_overflow<=2 &&
  acceptance.production_deployed===false;
const details={
  schema:"osgard.original180.offline-browser-evidence/1",
  verified_chromium:verified,
  test_flow_count:acceptance?.flows.length||0,
  test_flows:acceptance?.flows||[],
  screenshot_count:items.length,
  screenshot_items:items,
  console_exceptions:acceptance?.console_exceptions??null,
  horizontal_overflow_px:acceptance?.horizontal_overflow??null,
  local_only:true,production_deployed:false,
  independent_original_180_acceptance:false,
};
writeFileSync(join(directory,"QA_RESULTS.json"),
  JSON.stringify(details,null,2)+"\n","utf8");
const cards=items.map((x,i)=>
  '<article class="shot" id="shot-'+i+'">'+
  '<a href="'+escapeHtml(x.file)+'" target="_blank" rel="noopener">'+
  '<img loading="lazy" src="'+escapeHtml(x.file)+'" alt="'+escapeHtml(x.label)+'"></a>'+
  '<div class="shot-body"><strong>'+escapeHtml(x.label)+'</strong>'+
  '<small>'+escapeHtml(x.file)+'</small>'+
  '<small>SHA-256 '+escapeHtml(x.sha256.slice(0,20))+'…</small></div></article>'
).join("\n");
const status=verified?
  "Chromium PASS · подлинная QA-приёмка":
  "Не подтверждено: неполный QA-журнал";
const styles=[
  "*,*::before,*::after{box-sizing:border-box}",
  "body{margin:0;background:#091528;color:#e1eaf7;font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5}",
  ".shell{width:min(1320px,100%);margin:auto;padding:clamp(18px,4vw,54px)}",
  "header{border-bottom:1px solid #2d4665;padding-bottom:22px;margin-bottom:25px}",
  "h1{font-size:clamp(26px,4vw,45px);font-weight:590;letter-spacing:-.035em;margin:8px 0}",
  "p{max-width:800px;color:#aec2df}",
  ".eyebrow{color:#8fafd5;font-size:11px;letter-spacing:.14em;text-transform:uppercase}",
  ".metrics{display:flex;flex-wrap:wrap;gap:10px;margin:19px 0}",
  ".metric{border:1px solid #36506f;border-radius:8px;background:#11243d;padding:10px 14px;color:#dce8f7;font-size:13px}",
  ".gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:16px}",
  ".shot{min-width:0;border:1px solid #304b69;background:#11243d;border-radius:12px;overflow:hidden}",
  ".shot a{display:block;aspect-ratio:16/10;background:#152d4a;overflow:hidden}",
  ".shot img{width:100%;height:100%;object-fit:contain}",
  ".shot-body{display:grid;gap:5px;padding:12px 14px;overflow-wrap:anywhere}",
  ".shot-body strong{font-size:13px;font-weight:570}",
  ".shot-body small{font-size:11px;color:#91aaca}",
  "input{width:100%;max-width:410px;padding:11px 13px;background:#182d49;color:#f0f6ff;border:1px solid #4d698a;border-radius:8px}",
  ".alert{border-left:2px solid #7ca7d7;padding:13px;background:#112942;margin:18px 0}",
  "a{color:#bed9fa}",
  "[hidden]{display:none!important}",
].join("");
const safeStatus=escapeHtml(status);
const page=[
  "<!doctype html>",
  '<html lang="ru"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  "<title>OSGARD — Фактические скриншоты QA</title>",
  "<style>"+styles+"</style></head><body><main class=\"shell\">",
  "<header><div class=\"eyebrow\">OSGARD / ORIGINAL 180 / QA EVIDENCE</div>",
  "<h1>Работающий интерфейс. Реальные скриншоты.</h1>",
  "<p>Изображения получены из изолированной сессии Chromium с настоящим локальным SQLite/API. Это не изображения концептов и не публичный сайт.</p>",
  '<div class="metrics"><span class="metric">'+safeStatus+'</span>',
  '<span class="metric">'+items.length+' скриншота</span>',
  '<span class="metric">'+details.test_flow_count+' проверенных сценариев</span>',
  '<span class="metric">Production: NO-GO</span></div>',
  '<p class="alert">Демонстрационная приёмка не равна независимому выполнению 180 исходных задач. Полные хеши файлов — в QA_RESULTS.json.</p>',
  '<label for="search">Поиск экрана</label><p><input id="search" placeholder="Например: задачи, мобильный, откат"></p>',
  "</header>",
  '<section id="gallery" class="gallery">'+cards+"</section>",
  "</main><script>",
  '(function(){const input=document.getElementById("search");'+
  'input.addEventListener("input",()=>{const q=input.value.trim().toLowerCase();'+
  'for(const card of document.querySelectorAll(".shot")){'+
  'card.hidden=!card.textContent.toLowerCase().includes(q);}})})();',
  "</script></body></html>",
].join("\n");
writeFileSync(join(directory,"index.html"),page,"utf8");
if(!verified)throw Error("QA evidence gallery created but browser acceptance not verified");
console.log("OSGARD_GALLERY_PASS: "+items.length+
  " verified screenshots, "+details.test_flow_count+" flows");
