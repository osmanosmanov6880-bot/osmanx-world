import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {assessGuestQuality,buildSafetyExport,REASONS,QUALITY_SCHEMA} from '../src/guest-safety.mjs';
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pilot={id:'pilot-r13',phase:'running',version:7,protocol:{
  startDate:'2026-11-01',endDate:'2026-11-18',
  outcomeWindowDays:1,allocation:'random',source:'pos',primaryMetric:'repeat_visit'
},protocol_registered_at:'2026-10-30T00:00:00.000Z',target_per_group:1000};
const rows=[
  {date:'2026-11-02',control:600,controlReturn:120,offer:600,offerReturn:180},
  {date:'2026-11-03',control:600,controlReturn:120,offer:600,offerReturn:180}
];
const now=new Date('2026-11-18T12:00:00Z');
test('R13 no false alarms on healthy balanced aggregate sample',()=>{
 const r=assessGuestQuality(pilot,rows,{now});
 assert.equal(r.schema,QUALITY_SCHEMA);
 assert.equal(r.highestSeverity,'none');
 assert.equal(r.flags.length,0);
 assert.equal(r.blocksAutomatically,false);
 assert.deepEqual(r.totals,{control:1200,offer:1200});
 assert.match(r.disclaimer,/не доказательство ошибки/);
});
test('R13 objective warnings on missing periods, retroactive registration and manual source',()=>{
 const empty=assessGuestQuality(pilot,[],{now});
 assert.equal(empty.flags[0].code,'NO_OBSERVATIONS');
 const late=assessGuestQuality({...pilot,protocol_registered_at:'2026-11-02T00:00:00Z'},rows,{now});
 assert.equal(late.flags[0].code,'LATE_REGISTRATION');
 const manual=assessGuestQuality({...pilot,protocol:{...pilot.protocol,source:'manual'}},rows,{now});
 assert.ok(manual.flags.some(x=>x.code==='MANUAL_SOURCE'));
});
test('R13 detects duplicate day, unbalanced allocation and protocol violations without modifying source',()=>{
 const source=[...rows,{date:'2026-11-03',control:600,controlReturn:120,offer:100,offerReturn:10},
   {date:'2026-12-01',control:600,controlReturn:110,offer:100,offerReturn:20}];
 const before=JSON.stringify(source);
 const r=assessGuestQuality(pilot,source,{now});
 assert.ok(r.flags.some(x=>x.code==='DUPLICATE_DAY'));
 assert.ok(r.flags.some(x=>x.code==='OUT_OF_PROTOCOL'));
 assert.ok(r.flags.some(x=>x.code==='GROUP_IMBALANCE'));
 assert.ok(r.flags.some(x=>x.code==='PERIOD_GAP'));
 assert.equal(JSON.stringify(source),before);
});
test('R13 invalid counts, abrupt returns and sample deficiency are accurately labeled',()=>{
 const bad=[
  {date:'2026-11-02',control:20,controlReturn:2,offer:20,offerReturn:5},
  {date:'2026-11-03',control:20,controlReturn:25,offer:20,offerReturn:19}
 ];
 const r=assessGuestQuality(pilot,bad,{now});
 for(const code of ['INVALID_COUNTS','RATE_SWING','INSUFFICIENT_SAMPLE'])
   assert.ok(r.flags.some(x=>x.code===code),code);
 assert.equal(r.highestSeverity,'high');
});
test('R13 safety pack preserves original evidence digest and is independently tamper-evident',()=>{
 const events=[{hold_version:2,event_type:'resumed',actor_id:'m'},
   {hold_version:1,event_type:'held',actor_id:'o'}];
 const quality=assessGuestQuality(pilot,rows,{now});
 const evidenceDigest='a'.repeat(64);
 const input={pilot,quality,events,hold:{active:false,reason_code:'data_quality'},evidenceDigest};
 const a=buildSafetyExport(input),b=buildSafetyExport(input);
 assert.deepEqual(a,b);
 assert.equal(a.format,'osmanx.guest.safety.export.v1');
 assert.equal(a.sha256,sha(a.snapshot));
 assert.equal(a.snapshot.originalEvidenceSha256,evidenceDigest);
 assert.deepEqual(a.snapshot.holdEvents.map(x=>x.hold_version),[1,2]);
 assert.match(a.disclaimer,/не является цифровой подписью/);
 assert.notEqual(buildSafetyExport({...input,events:events.slice(1)}).sha256,a.sha256);
 assert.throws(()=>buildSafetyExport({...input,evidenceDigest:'none'}),TypeError);
 assert.throws(()=>buildSafetyExport({...input,events:Array(101).fill(events[0])}),TypeError);
});
test('R13 allowed stop reasons are enumerated and no freeform client identifiers are accepted',()=>{
 assert.deepEqual(REASONS,['source_integrity','consent_review','data_quality','operational_incident']);
 assert.throws(()=>assessGuestQuality(pilot,Array(13).fill(rows[0])),TypeError);
});
