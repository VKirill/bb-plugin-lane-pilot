const fs = require('fs'), path = require('path'), ts = require('typescript'), Module = require('module');
const base=process.cwd();
const readSource=(f)=>require('child_process').execFileSync('git',['show','295497fc:'+path.relative(base,f)],{encoding:'utf8'});
const cache={};
const mocks={};
function load(file){
 const f=path.resolve(base,file); if(cache[f])return cache[f].exports;
 const m={exports:{}};cache[f]=m;
 const req=(id)=>{
  if(id in mocks)return mocks[id];
  if(id==='@lane-pilot/jev')return {jev:()=>null};
  if(id.endsWith('/predict'))return {};
  if(id.startsWith('.')) {const p=path.resolve(path.dirname(f),id);if(p in mocks)return mocks[p];return p.endsWith('.json')?JSON.parse(readSource(p)):load(p+'.ts');}
  return require(id);
 };
 new Function('require','module','exports',ts.transpileModule(readSource(f),{compilerOptions:{esModuleInterop:true,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(req,m,m.exports);return m.exports;
}
const DB=require('better-sqlite3'),db=new DB(':memory:');
for(const sql of load('src/rooms/lead/migrations.ts').leadMigrations) db.exec(sql);
for(const sql of load('src/rooms/owner-waiting/migrations.ts').ownerWaitingMigrations) db.exec(sql);
const logic=load('src/rooms/lead/logic.ts'), rights=load('src/rooms/lead/server/rights.ts');
const rows=Array.from({length:200},(_,i)=>({class:'next_step',risk:'low',judge_verdict:i>=190?'miss':'exact',owner_label:i<2?'exact':null,predicted_at:1,answered_at:i+2,split:'exam',answered_by:'owner'}));
const exam=logic.examClass('next_step',rows);
const tiers=[];for(let i=0;i<4;i++){rights.applyExam(db,[exam],1000+i);tiers.push(rights.tierOf(db,'next_step'));}
console.log('F-001',JSON.stringify({n:exam.n,lb:exam.wilsonLb,window:exam.windowLb,revert:exam.revert,tiers}));
const road=load('src/rooms/lead/server/road.ts'), journal=load('src/rooms/lead/server/journal.ts'),inbox=load('src/rooms/owner-waiting/items.ts');
road.addRoad(db,{id:'dir:p',projectId:'p',title:'Direction',kind:'direction',source:'lead',why:'test direction'},1);
road.addRoad(db,{id:'r',parentId:'dir:p',projectId:'p',title:'Proposal',kind:'option',source:'lead',why:'test proposal',class:'next_step'},2);
const input={id:'lead:r',surface:'lead',class:'next_step',situation:{},options:['yes','later','no']};
journal.openDecision(db,input,3);road.proposeRoad(db,'r','lead:r',3);inbox.postOwnerItem(db,{key:'lead:r',source:'lead',kind:'proposal',what:'Proposal',why:'test proposal'},3);
road.decideRoad(db,'r','later',undefined,4);journal.answerDecision(db,'lead:r',{option:'later'},'owner',4);inbox.closeOwnerItem(db,'lead:r','owner',4);
const reopenedDecision=journal.openDecision(db,input,5);road.proposeRoad(db,'r','lead:r',5);const reopenedInbox=inbox.postOwnerItem(db,{key:'lead:r',source:'lead',kind:'proposal',what:'Proposal again',why:'test proposal'},5);
journal.answerDecision(db,'lead:r',{option:'yes'},'agent',6);
console.log('F-002',JSON.stringify({reopenedDecision,reopenedInbox,road:road.getRoad(db,'r').state,inbox:db.prepare('SELECT state FROM lane_pilot_owner_item WHERE key=?').get('lead:r'),answer:journal.getDecision(db,'lead:r').answer_json,by:journal.getDecision(db,'lead:r').answered_by}));
db.close();

async function more(){
const pm=load('src/rooms/core/server/pm-notice.ts');
let sendCalls=0; const delivered=await pm.sendPmNotice({sdk:{threads:{get:async()=>({updatedAt:1000}),send:async()=>{sendCalls++;throw Error('archived')}}}},'synthetic', 'question',1001);
console.log('F-005',JSON.stringify({sendCalls,sendRejected:true,returnedDelivered:delivered,inboxWouldBeSkipped:delivered}));
const mock=(rel,value)=>mocks[path.resolve(base,rel)]=value;
mock('src/rooms/storage',{loadProjectSettings:()=>({'integration.gate_command':'test','integration.gate_when':'every_n','integration.gate_every':5}),getRunSettingsScopes:()=>[]});
mock('src/rooms/runs/server/stage-records',{recordGateEvaluation:()=>{}});
mock('src/rooms/core/server',{stringAt:(o,k)=>o?.[k]??null});
mock('src/rooms/writer/server/sticky',{saveFollowUp:async()=>{}});
const sends=[];
mock('src/rooms/relay/server',{sendServiceMessage:async(bb,msg)=>sends.push(msg.threadId)});
mock('src/rooms/runs',{isEnvironmentCheckFailure:()=>false});
mock('src/rooms/tasks',{readCheckRun:(r)=>({verdict:r.exitCode===0?'pass':'fail',reason:'synthetic host result'})});
mock('src/rooms/verification/server/gate-detect',{gateResolverFor:()=>async()=>({command:'test',source:'explicit',detail:'test'}),gateLabel:()=> 'test'});
mock('src/rooms/owner-waiting',{postOwnerItem:()=>({created:true})});
mock('src/rooms/verification/machine-pressure',{readingFrom:()=>null});
const {IntegrationGateRunner}=load('src/rooms/verification/server/integration-gate.ts');
let exitCode=0;const hostCalls=[];
const gate=new IntegrationGateRunner({db:{prepare:()=>({get:()=>undefined})},bb:{storage:{kv:{set:async()=>{}}},sdk:{files:{write:async()=>{}}}},host:{call:async(name,input)=>{hostCalls.push({name,basePath:input.basePath});if(name==='gateRun')return {exitCode,stdout:'synthetic check result',stderr:'',head:'bbbbbbbb'};if(name==='readBoundedFile')return null;return null;}},log:()=>{}},{});
const task=(id)=>({taskId:id,commitSha:'aaaaaaaa',threadId:'writer-'+id,produced:['unrelated.ts']});
for(let i=0;i<4;i++)gate.noteMergedTask(task('A-'+i));
gate.noteMergedTask(task('B-0'));
const input={runId:'runB',projectId:'B',pmThreadId:'pmB',basePath:'/synthetic-B',configHostId:'fake',trigger:'merge'};
const green=await gate.maybeRunGate(input);
console.log('F-007',JSON.stringify({mergesA:4,mergesB:1,thresholdB:5,result:green,pendingAfterB:gate.getPendingMergeCount(),hostCalls}));
exitCode=1; const single=new IntegrationGateRunner(gate.ctx,{});single.noteMergedTask(task('innocent'));
const red=await single.maybeRunGate({...input,trigger:'drain'});
console.log('F-009',JSON.stringify({failingTests:0,attribution:'none',result:red,sends}));
const d=new DB(':memory:');for(const sql of load('src/rooms/lead/migrations.ts').leadMigrations)d.exec(sql);for(const sql of load('src/rooms/owner-waiting/migrations.ts').ownerWaitingMigrations)d.exec(sql);
mocks['@lane-pilot/settings-catalog']={GLOBAL_SETTINGS_PROJECT_ID:'*'};
mock('src/rooms/storage',{loadProjectSettings:()=>({'lead.projects':'P','lead.enabled':'on'})});
mock('src/rooms/owner-waiting',{...inbox,loadPushConfig:()=>({timezone:'UTC'})});
mock('src/rooms/phase',{listPhases:()=>[]});mock('src/rooms/memory/server',{taskMemoryContext:()=>''});
mock('src/rooms/lead/server/identity',{identityBlock:()=>'',loadIdentity:()=>({sha:'test',text:'test',path:'none',seeded:false})});
const tick=load('src/rooms/lead/server/tick.ts');const actions={};
tick.registerLeadTickActions({register:(id,executor)=>actions[id]=executor},{db:d,bb:{sdk:{projects:{list:async()=>[{id:'P',name:'P'},{id:'Q',name:'Q'}]}},log:{warn:()=>{}}}},{});
const c=(values)=>({runId:'synthetic',resolve:(k)=>values[k]});
await actions['lp.lead_propose'].run(c({'$inputs.tickId':'one','think.branches':[{project_id:'Q',title:'Future work',kind:'option',why:'A synthetic reason'}],'think.proposals':[]}));
const branch=road.listRoad(d,{kind:'option'})[0];
const result=await actions['lp.lead_propose'].run(c({'$inputs.tickId':'two','think.branches':[],'think.proposals':[{road_id:branch.id,project_id:'Q',title:'Future work',class:'next_step',risk:'low',why:'A synthetic reason',evidence:[{kind:'note',ref:'synthetic'}],cost_estimate:'1 hour'}]}));
console.log('F-003/F-010',JSON.stringify({zone:['P'],proposed:result.output.proposed,roadClass:road.getRoad(d,branch.id).class,decisionClass:journal.getDecision(d,'lead:'+branch.id).class,postedProject:d.prepare('SELECT project_id FROM lane_pilot_owner_item').get().project_id}));
mock('src/rooms/stability/server',{SANDBOX_PROJECT_ID:'sandbox',isDrillTask:()=>false});mock('src/rooms/memory-eval/server',{});
const mem=load('src/rooms/lead/server/memory-exam.ts');journal.answerDecision(d,'lead:'+branch.id,{option:'yes'},'agent',Date.now()+100);
const measured=await mem.runMemoryExam(d,{recall:false});console.log('F-011',JSON.stringify({onlyAnswerBy:'agent',measuredRows:measured.decisions.n}));
d.close();
}
more().catch(e=>{console.error(e);process.exitCode=1;});
