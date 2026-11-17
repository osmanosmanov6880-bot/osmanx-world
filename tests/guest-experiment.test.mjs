import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {count,money,cohort,economics,csv,protocol,riskFlags,createSnapshot,readSnapshot,pilotBrief,SCHEMA} from '../assets/guest/experiment-model.js';
const close=(actual,expected,tol=1e-10)=>assert.ok(Math.abs(actual-expected)<tol,'expected '+actual+' near '+expected);
const base={control:100,controlReturn:20,offer:100,offerReturn:30,margin:250,discount:10,fixed:100,fee:15000};
const p={startDate:'2026-11-18',endDate:'2026-12-17',allocation:'random',outcomeWindowDays:30};
test('R2: bounded integer input, empty, decimal, exponent and Unicode injection rejected',()=>{
  assert.equal(count('0','n'),0);
  assert.equal(count('100','n',{positive:true}),100);
  for(const v of ['',-1,1.1,'1e3','01','12\n4','Infinity','10000001'])assert.throws(()=>count(v,'n'));
  assert.throws(()=>count(0,'n',{positive:true}));
});
test('R2: money is nonnegative with at most two decimal digits and bounded',()=>{
  assert.equal(money('0.01','R'),.01);
  assert.equal(money('25000.00','R'),25000);
  for(const v of ['',-1,'1.001','1e3','Infinity','0,5','100000001'])assert.throws(()=>money(v,'R'));
});
test('R2: confidence intervals valid at central and extreme proportions',()=>{
  const c=cohort(base);
  close(c.controlRate,.2);close(c.offerRate,.3);close(c.difference,.1);
  assert.ok(c.range[0]<0&&c.range[1]>0);
  assert.equal(c.uncertain,true);assert.equal(c.small,false);
  for(const [ctr,offer] of [[0,0],[10,10],[0,10],[10,0]]){
    const sample=cohort({control:10,controlReturn:ctr,offer:10,offerReturn:offer});
    assert.ok(sample.range[0]>=-1&&sample.range[1]<=1);
    assert.ok(sample.range[0]<=sample.difference&&sample.range[1]>=sample.difference);
    assert.equal(sample.small,true);
  }
});
test('R2: invalid denominators and return overflow fail closed',()=>{
  for(const candidate of [
    {...base,control:0},{...base,offer:0},
    {...base,controlReturn:101},{...base,offerReturn:101},
    {...base,controlReturn:-2},{...base,offerReturn:'x'},
  ])assert.throws(()=>cohort(candidate));
});
test('R2: net revenue interval includes point estimate with nonnegative margin and exact costs',()=>{
  const c=cohort(base);
  const e=economics(base,c);
  close(e.incrementalVisits,10);close(e.costs,16100);close(e.net,-13600);
  assert.equal(e.breakEven,65);
  assert.ok(e.rangeNet[0]<=e.net && e.net<=e.rangeNet[1]);
  close(e.rangeNet[0],c.range[0]*100*250-16100);
  const zero=economics({...base,margin:0,discount:0,fixed:0,fee:0},c);
  assert.equal(zero.breakEven,null);close(zero.net,0);
});
test('R2: protocol validates real dates, range, allocation and return window',()=>{
  const got=protocol(p);
  assert.equal(got.days,30);assert.equal(got.randomized,true);
  assert.equal(protocol({...p,startDate:'2028-02-29',endDate:'2028-02-29'}).days,1);
  for(const v of [
    {...p,startDate:'2026-02-29'},
    {...p,startDate:'2026-12-18'},
    {...p,startDate:'2026-10-01',endDate:'2027-01-31'},
    {...p,allocation:'pretend-random'},
    {...p,outcomeWindowDays:91},
    {...p,outcomeWindowDays:0},
  ])assert.throws(()=>protocol(v));
});
test('R2: warnings distinguish uncertain effect and observational groups',()=>{
  const warning=riskFlags(cohort(base),protocol({...p,allocation:'matched'})).join('\n');
  assert.match(warning,/ноль/);assert.match(warning,/случайно/);
  assert.match(warning,/кластеризацию/);
});
test('R2: JSON snapshots have allowlisted fields, deterministic round trip and reject personal data',()=>{
  const snapshot=createSnapshot(base,p);
  assert.equal(snapshot.schema,SCHEMA);
  assert.deepEqual(readSnapshot(JSON.stringify(snapshot)),snapshot);
  const extra={...snapshot,customerName:'Петров'};
  assert.throws(()=>readSnapshot(JSON.stringify(extra)));
  assert.throws(()=>readSnapshot(JSON.stringify({...snapshot,inputs:{...snapshot.inputs,phone:'89991234567'}})));
  assert.throws(()=>readSnapshot(JSON.stringify({...snapshot,protocol:{...snapshot.protocol,client:'secret'}})));
  assert.throws(()=>readSnapshot(JSON.stringify({...snapshot,schema:'osmanx.guest.experiment.v99'})));
  assert.throws(()=>readSnapshot('{bad'));
  assert.throws(()=>readSnapshot('x'.repeat(16385)));
});
test('R2: report states all limitations without inventing an actual sale',()=>{
  const brief=pilotBrief(createSnapshot(base,p));
  assert.match(brief,/ПАСПОРТ ПИЛОТА/);
  assert.match(brief,/НЕ ЯВЛЯЕТСЯ ДОКАЗАТЕЛЬСТВОМ/);
  assert.match(brief,/−|-/);
  assert.ok(!brief.includes('Петров'));
});
test('R2: CSV escapes quotations, newlines and mitigates leading whitespace formula injection',()=>{
  const s=csv([['=2+2',' hello'],['  @SUM(1)', '\t+2'],['-10','hello "world"'],['normal','abc']]);
  assert.ok(s.startsWith('\uFEFF'));
  assert.ok(s.includes('"\'=2+2"'));
  assert.ok(s.includes('"\'  @SUM(1)"'));
  assert.ok(s.includes('""world""'));
  assert.ok(s.includes('"\'-10"'));
  assert.ok(s.endsWith('\r\n'));
});
test('R2: all direct JavaScript DOM references exist and public offer links to the pilot lab',async()=>{
  const page=await readFile(new URL('../assets/guest/experiment.html',import.meta.url),'utf8');
  const js=await readFile(new URL('../assets/guest/experiment.js',import.meta.url),'utf8');
  const offer=await readFile(new URL('../assets/guest/offer.html',import.meta.url),'utf8');
  for(const match of js.matchAll(/\$\('([^']+)'\)/g))assert.ok(page.includes('id="'+match[1]+'"'),'Missing DOM id: '+match[1]);
  for(const id of ['control','controlReturn','offer','offerReturn','margin','discount','fixed','fee','startDate','endDate','allocation','outcomeWindowDays'])assert.ok(page.includes('id="'+id+'"'));
  assert.match(page,/type="module" src="\.\/experiment\.js"/);
  assert.match(offer,/href="\.\/experiment\.html"/);
  assert.match(page,/на сервер ничего не отправляется/);
});
