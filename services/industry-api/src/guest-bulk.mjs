// Guest R9: strict aggregate CSV import — no names, contacts, identifiers or formulas.
// The server independently parses and hashes before any database write.
import {createHash} from 'node:crypto';
const HEADER='date,control,controlReturn,offer,offerReturn';
const NUMBER=/^(0|[1-9]\d{0,7})$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
function error(message){throw new RangeError(message)}
export function parseAggregateCsv(raw){
  if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>4096)
    error('CSV: максимум 4 КБ, строго обезличенные агрегаты');
  const normalized=raw.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
  if(/\r/.test(normalized)||/[";\t=+@]/.test(normalized))
    error('CSV: разрешены только запятые, ISO-даты и целые числа, формулы запрещены');
  const lines=normalized.trimEnd().split('\n');
  if(lines[0]!==HEADER||lines.length<2||lines.length>13)
    error('CSV: точный заголовок и от 1 до 12 периодов');
  const used=new Set(),rows=[];
  for(let index=1;index<lines.length;index++){
    const parts=lines[index].split(',');
    if(parts.length!==5||!DATE.test(parts[0]))
      error('CSV: некорректный формат даты или числа столбцов в строке '+(index+1));
    const date=parts[0],stamp=Date.parse(date+'T00:00:00.000Z');
    if(!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==date)
      error('CSV: несуществующая дата');
    if(used.has(date))error('CSV: повторяется дата '+date);
    used.add(date);
    const values=parts.slice(1).map(part=>{
      if(!NUMBER.test(part))error('CSV: допустимы только неотрицательные целые числа');
      const n=Number(part);
      if(!Number.isSafeInteger(n)||n>10000000)error('CSV: значение превышает лимит');
      return n;
    });
    const [control,controlReturn,offer,offerReturn]=values;
    if(control<1||offer<1||controlReturn>control||offerReturn>offer)
      error('CSV: некорректный размер групп или число возвратов');
    rows.push({date,control,controlReturn,offer,offerReturn});
  }
  return rows.sort((a,b)=>a.date.localeCompare(b.date));
}
export function validateBatchWindow(rows,protocol,now=new Date()){
  if(!protocol||!DATE.test(protocol.startDate)||!DATE.test(protocol.endDate))
    error('Необходим зарегистрированный протокол');
  const today=now.toISOString().slice(0,10);
  for(const r of rows)
    if(r.date<protocol.startDate||r.date>protocol.endDate||r.date>today)
      error('CSV: дата за пределами протокола или в будущем');
  return rows;
}
export function batchDigest(pilotId,expectedVersion,rows){
  if(typeof pilotId!=='string'||!Number.isSafeInteger(expectedVersion)||expectedVersion<1)
    error('Некорректный идентификатор пилота или версия');
  return createHash('sha256').update(JSON.stringify({
    schema:'osmanx.guest.aggregate.batch.v1',pilotId,expectedVersion,rows
  })).digest('hex');
}
export function summarizeBatch(rows){
  return {rowCount:rows.length,firstDate:rows[0].date,lastDate:rows.at(-1).date,
    totals:rows.reduce((totals,row)=>{
      for(const key of Object.keys(totals))totals[key]+=row[key];
      return totals;
    },{control:0,controlReturn:0,offer:0,offerReturn:0})};
}
