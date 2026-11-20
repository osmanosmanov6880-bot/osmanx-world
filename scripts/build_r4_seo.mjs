/** Build static SEO tags ONLY from an approved public snapshot. No fictional episode videos. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));const root=path.resolve(here,'..');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
export function renderSeo(snapshot,{origin='https://osmanx.world',source=root}={}){
 if(snapshot?.status!=='published'||snapshot.schemaVersion!==3||!Array.isArray(snapshot.episodes)||!/^https:\/\/[a-z0-9.-]+$/.test(origin))throw Error('A verified public release is required');
 const updated=new Map(snapshot.episodes.map(x=>[Number(x.day),x]));if(updated.size!==snapshot.episodes.length)throw Error('Duplicate published episode');
 const pages=new Map();const loc=[origin+'/moscow-1000/'];
 for(let i=1;i<=10;i++){
  const n=String(i).padStart(2,'0'),src=fs.readFileSync(path.join(source,'moscow-1000/episodes',n,'index.html'),'utf8');let html=src;
  const ep=updated.get(i);if(ep){if(typeof ep.title!=='string'||!/^20\d{2}-/.test(ep.publishedAt)||!(ep.videoUrl?.startsWith('/assets/')||ep.videoUrl?.startsWith('stream:')))throw Error('Untrusted published episode metadata');
    const page=origin+'/moscow-1000/episodes/'+n+'/';const embed=ep.videoUrl.startsWith('stream:')?ep.iframeUrl:origin+ep.videoUrl;
    if(typeof embed!=='string'||(!embed.startsWith(origin+'/assets/')&&!/^https:\/\/customer-[a-z0-9]{6,40}\.cloudflarestream\.com\/[a-f0-9]{32}\/iframe$/.test(embed)))throw Error('Untrusted video URL');
    const schema={'@context':'https://schema.org','@type':'VideoObject',name:ep.title,description:'Документальный эпизод OSMANX MOSCOW 1000.',uploadDate:ep.publishedAt,url:page,embedUrl:embed};
    if(ep.posterUrl&&/^https:\/\/customer-[a-z0-9]{6,40}\.cloudflarestream\.com\/[a-f0-9]{32}\/thumbnails\/thumbnail\.jpg$/.test(ep.posterUrl))schema.thumbnailUrl=ep.posterUrl;
    const json=JSON.stringify(schema).replace(/</g,'\\u003c');
    const title=`<meta property="og:video" content="${esc(embed)}"><script type="application/ld+json">${json}</script>`;
    html=html.replace('</head>',title+'</head>');loc.push(page);
  }
  pages.set('moscow-1000/episodes/'+n+'/index.html',html);
 }
 const sitemap='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+loc.map(u=>`<url><loc>${esc(u)}</loc></url>`).join('\n')+'\n</urlset>\n';pages.set('moscow-1000/sitemap.xml',sitemap);return pages;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const src=process.argv[2],dest=process.argv[3];if(!src||!dest){console.error('Usage: node scripts/build_r4_seo.mjs approved-public-release.json output-directory');process.exit(2);}const obj=JSON.parse(fs.readFileSync(src,'utf8'));const pages=renderSeo(obj);for(const [name,html] of pages){const target=path.join(dest,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,html);}console.log(`Generated ${pages.size} SEO files. Only verified episodes are indexed.`);
}
