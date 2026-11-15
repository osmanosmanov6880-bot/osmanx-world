'use strict';
const {app,BrowserWindow,ipcMain,shell,dialog} = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const catalog = require('./catalog.json');

const OFFICIAL_SITE = 'https://osmanx.world/';
function permittedURL(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    if (u.origin === 'https://osmanx.world') return true;
    return u.origin === 'https://github.com' && u.pathname.startsWith('/osmanosmanov6880-bot/');
  } catch { return false; }
}
function validateTasks(value) {
  if (!Array.isArray(value) || value.length > 500) throw Error('Ограничение: максимум 500 задач');
  return value.map((v) => {
    if (!v || typeof v !== 'object') throw Error('Повреждённая запись задачи');
    const title = typeof v.title === 'string' ? v.title.trim() : '';
    if (!title || title.length > 180) throw Error('Недопустимый текст задачи');
    const id = typeof v.id === 'string' ? v.id.slice(0,80) : '';
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw Error('Недопустимый ID задачи');
    const createdAt = typeof v.createdAt === 'string' ? v.createdAt.slice(0,40) : '';
    return {id,title,projectId:catalog.some((p)=>p.id===v.projectId) ? v.projectId : 'general',
      done:v.done===true,createdAt};
  });
}
function createWindow() {
  const win=new BrowserWindow({
    width:1330,height:850,minWidth:880,minHeight:600,
    backgroundColor:'#070d16',title:'OSMANX Desktop',
    show:false,autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,
      contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false}
  });
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event)=>event.preventDefault());
  win.webContents.on('will-attach-webview',(event)=>event.preventDefault());
  win.loadFile(path.join(__dirname,'renderer','index.html'));
  win.once('ready-to-show',()=>win.show());
}
ipcMain.handle('catalog:list',()=>catalog.map(({id,category,name,label,description,status,access})=>
  ({id,category,name,label,description,status,access,canOpen:!!catalog.find(p=>p.id===id&&p.url)})));
ipcMain.handle('catalog:open',async(_event,id)=>{
  const p=catalog.find((v)=>v.id===id);
  if(!p || !permittedURL(p.url)) return false;
  await shell.openExternal(p.url,{activate:true});
  return true;
});
ipcMain.handle('site:open',async()=>{await shell.openExternal(OFFICIAL_SITE);return true;});
ipcMain.handle('app:version',()=>app.getVersion());
ipcMain.handle('data:export',async(_event,payload)=>{
  const tasks=validateTasks(payload);
  const selected=await dialog.showSaveDialog({title:'Экспорт задач OSMANX',
    defaultPath:'osmanx-desktop-tasks.json',
    filters:[{name:'JSON',extensions:['json']}],properties:['createDirectory','showOverwriteConfirmation']});
  if(selected.canceled||!selected.filePath) return {cancelled:true};
  const document={schema:1,exportedAt:new Date().toISOString(),tasks};
  await fs.writeFile(selected.filePath,JSON.stringify(document,null,2)+'\n',{encoding:'utf8',flag:'w'});
  return {cancelled:false,count:tasks.length};
});
ipcMain.handle('data:import',async()=>{
  const selected=await dialog.showOpenDialog({title:'Импорт задач OSMANX',
    properties:['openFile'],filters:[{name:'JSON',extensions:['json']}]});
  if(selected.canceled||!selected.filePaths[0]) return {cancelled:true};
  const stats=await fs.stat(selected.filePaths[0]);
  if(stats.size>350000) throw Error('Файл импорта слишком большой');
  const file=JSON.parse(await fs.readFile(selected.filePaths[0],'utf8'));
  if(file.schema!==1) throw Error('Неподдерживаемая версия файла');
  return {cancelled:false,tasks:validateTasks(file.tasks)};
});
app.whenReady().then(()=>{
  app.setAppUserModelId('world.osmanx.desktop');
  createWindow();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
