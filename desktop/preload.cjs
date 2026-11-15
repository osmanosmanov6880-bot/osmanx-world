'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('osmanx',Object.freeze({
  projects:()=>ipcRenderer.invoke('catalog:list'),
  openProject:(id)=>ipcRenderer.invoke('catalog:open',id),
  openSite:()=>ipcRenderer.invoke('site:open'),
  version:()=>ipcRenderer.invoke('app:version'),
  exportTasks:(items)=>ipcRenderer.invoke('data:export',items),
  importTasks:()=>ipcRenderer.invoke('data:import')
}));
