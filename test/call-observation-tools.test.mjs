import test from 'node:test';
import assert from 'node:assert/strict';
import { CallObserver } from '../dist/call-observation.js';
import * as tools from '../dist/tools/call-observation.js';

const target = { name:'lab', label:'Lab\nbox', host:'127.0.0.1', port:5038 };
class Transport {
  events = new Set(); lifecycle = new Set(); denied = false;
  subscribeEvents(f) { this.events.add(f); return () => this.events.delete(f); }
  subscribeLifecycle(f) { this.lifecycle.add(f); return () => this.lifecycle.delete(f); }
  emit(Event, id, extra = {}) { for (const f of this.events) f({ Event, Uniqueid:id, Channel:`PJSIP/${id}`, Exten:'100', Context:'mcp-test', ...extra }); }
  close() { for (const f of this.lifecycle) f('socket_closed'); }
  async action(a) {
    if (a.Action === 'Events') return [{ Response:this.denied ? 'Error' : 'Success', Message:'Permission denied' }];
    if (a.Action === 'CoreShowChannels') return [{Response:'Success'}, {Event:'CoreShowChannelsComplete'}];
    return [{Response:'Error', Message:'No such variable'}];
  }
}
function setup(t, options={}) {
  const ami = new Transport(); const observer = new CallObserver(target, () => async () => ami, 100);
  const handlers = {}, definitions = {};
  let snapshot = { ...target, readOnly:true, getObserver:() => observer };
  tools.registerCallObservationTools({registerTool:(name, d, fn) => { handlers[name]=fn; definitions[name]=d; }}, {timeoutMs:100,allowWrite:false,allowProvision:false}, () => snapshot);
  t.after(() => observer.close());
  return {ami,observer,handlers,definitions,setSnapshot:s => {snapshot=s;}};
}
const tick = () => new Promise(r => setImmediate(r));
const content = r => r.structuredContent;

test('strict adapters reject malformed selectors, dates, keys and numeric bounds before observer creation', async t => {
  const {handlers:h} = setup(t);
  const badWait = [{},{callId:''},{did:''},{callId:'a',did:'100'},{callId:'a',context:'mcp-test'},{did:'100',context:''},{did:'100',unknown:true},{callId:'a\r\nb'},{callId:'é'.repeat(2049)},{did:'100',timeoutSeconds:0},{did:'100',timeoutSeconds:301},{did:'100',timeoutSeconds:1.5},{did:'100',since:'2026-02-30T00:00:00Z'},{did:'100',since:'2020-01-01T00:00:00+00:00'},{did:'100',since:'2999-01-01T00:00:00Z'}];
  for (const args of badWait) assert.equal((await h.asterisk_wait_call(args)).isError,true,JSON.stringify(args));
  for (const args of [{callId:'a',did:'b'},{context:'mcp-test'},{limit:0},{limit:101},{limit:1.5},{limit:'10'},{password:'x'}]) assert.equal((await h.asterisk_recent_calls(args)).isError,true);
});

test('completed and recent results validate full schemas, preserve raw evidence and recover fast since call', async t => {
  const {ami,observer,handlers:h,definitions:d} = setup(t); const ready=await observer.ensureReady();
  ami.emit('Newchannel','a',{Exten:'AbC'}); ami.emit('Hangup','a',{Cause:'16','Cause-txt':'Normal\nClearing'});
  const r=await h.asterisk_wait_call({did:'AbC',context:'mcp-test',since:ready.observationSince});
  assert.equal(r.isError,undefined); assert.equal(content(r).outcome,'completed'); assert.equal(content(r).target.label,'Lab\nbox');
  assert.equal(content(r).record.hangupCause,'Normal\nClearing'); assert.equal(content(r).record.sipMetadata.from,null);
  assert.ok(d.asterisk_wait_call.outputSchema.safeParse(content(r)).success);
  const recent=await h.asterisk_recent_calls({did:'AbC'}); assert.equal(content(recent).records.length,1);
  assert.ok(d.asterisk_recent_calls.outputSchema.safeParse(content(recent)).success);
  assert.equal(content(await h.asterisk_recent_calls({did:'abc'})).records.length,0);
  assert.ok(!r.content[0].text.includes('Lab\nbox'));
});

test('strict defaults and raw exact selector are forwarded with one monotonic invocation deadline',async t=>{
 const {handlers:h,setSnapshot}=setup(t);let seen;
 setSnapshot({...target,getObserver:()=>({ensureReady:async()=>({}),waitCall:async(...args)=>{seen=args;throw new Error('stop');},recentCalls:async(...args)=>{seen=args;throw new Error('stop');}})});
 const before=performance.now();await h.asterisk_wait_call({callId:' A\u0001Z '});assert.equal(seen[0].callId,' A\u0001Z ');assert.equal(seen[0].timeoutSeconds,60);assert.ok(seen[1]>=before+60000&&seen[1]<=performance.now()+60000);
 await h.asterisk_recent_calls({since:'2020-01-01T00:00:00Z'});assert.equal(seen[0].limit,10);assert.equal(seen[0].since,'2020-01-01T00:00:00.000Z');
});

test('snapshot is captured before awaiting readiness and ad hoc refuses observation',async t=>{
 const {ami,observer,handlers:h,setSnapshot}=setup(t);await observer.ensureReady();
 const p=h.asterisk_wait_call({did:'100'});setSnapshot({...target,name:'other',getObserver:()=>{throw new Error('wrong target');}});
 ami.emit('Newchannel','a');ami.emit('Hangup','a');const r=await p;assert.equal(content(r).outcome,'completed');assert.equal(content(r).target.name,'lab');
 setSnapshot({...target,getObserver:()=>{throw new Error('named_target_required');}});const error=await h.asterisk_recent_calls({});assert.equal(error.isError,true);assert.match(error.content[0].text,/named_target_required/);
});

test('ambiguity is structured and gap records remain unknown in recent results',async t=>{
 const {ami,observer,handlers:h,definitions:d}=setup(t);await observer.ensureReady();ami.emit('Newchannel','a');ami.emit('Newchannel','b');
 const r=await h.asterisk_wait_call({did:'100'});assert.equal(content(r).outcome,'ambiguous_match');assert.equal(content(r).candidates.length,2);assert.ok(d.asterisk_wait_call.outputSchema.safeParse(content(r)).success);
 const gap=h.asterisk_wait_call({did:'200'});await tick();ami.close();assert.equal(content(await gap).outcome,'observation_gap');
 const recent=await h.asterisk_recent_calls({});assert.ok(content(recent).records.every(r=>r.endState==='unknown'));assert.ok(d.asterisk_recent_calls.outputSchema.safeParse(content(recent)).success);
 const empty=await h.asterisk_recent_calls({did:'missing',since:'2020-01-01T00:00:00Z'});assert.deepEqual(content(empty).records,[]);assert.equal(content(empty).coverage.requestedRangeComplete,false);
});

test('permission readiness failure is a tool error for wait and recent',async t=>{
 const {ami,handlers:h}=setup(t);ami.denied=true;
 for(const name of ['asterisk_wait_call','asterisk_recent_calls']) {const r=await h[name]({did:'100'});assert.equal(r.isError,true);assert.match(r.content[0].text,/refused|Permission denied/);assert.match(r.content[0].text,/Target: lab \(127\.0\.0\.1:5038\)/);assert.ok(!r.content[0].text.includes('Lab\nbox'));}
});

test('SDK cancellation frees waiter slot; seventeenth invocation is a tool error',async t=>{
 const {observer,handlers:h}=setup(t);await observer.ensureReady();const controllers=Array.from({length:16},()=>new AbortController());
 const waits=controllers.map((c,i)=>h.asterisk_wait_call({did:String(i)}, {signal:c.signal}));
 const excess=await h.asterisk_wait_call({did:'extra'});assert.equal(excess.isError,true);assert.match(excess.content[0].text,/capacity/);
 controllers[0].abort();assert.equal((await waits[0]).isError,true);assert.equal(observer.coverage().ready,true);
 const c=new AbortController();const replacement=h.asterisk_wait_call({did:'replacement'},{signal:c.signal});c.abort();assert.equal((await replacement).isError,true);
 controllers.slice(1).forEach(c=>c.abort());await Promise.all(waits);
});

test('no-since excludes previously terminal; configured deadlines report both timeout outcomes',async t=>{
 const {ami,observer,handlers:h,definitions:d}=setup(t);await observer.ensureReady();ami.emit('Newchannel','old');ami.emit('Hangup','old');
 const noMatch=h.asterisk_wait_call({did:'100',timeoutSeconds:1});ami.emit('Newchannel','active',{Exten:'200'});const active=h.asterisk_wait_call({did:'200',timeoutSeconds:1});
 const [a,b]=await Promise.all([noMatch,active]);assert.equal(content(a).outcome,'timed_out_no_match');assert.equal(content(b).outcome,'timed_out_active');for(const r of [a,b])assert.ok(d.asterisk_wait_call.outputSchema.safeParse(content(r)).success);
});

test('caller deadline during shared startup is structured gap and does not cancel observer readiness',async t=>{
 const {handlers:h,setSnapshot}=setup(t);const ami=new Transport();let release;
 const observer=new CallObserver(target,(_deadline,signal)=>()=>new Promise((resolve,reject)=>{release=()=>resolve(ami);signal.addEventListener('abort',()=>reject(new Error('startup cancelled')),{once:true});}),2000);
 t.after(()=>observer.close());setSnapshot({...target,getObserver:()=>observer});
 const r=await h.asterisk_wait_call({did:'100',timeoutSeconds:1});assert.equal(r.isError,undefined);assert.equal(content(r).outcome,'observation_gap');assert.equal(observer.coverage().ready,false);
 release();await observer.ensureReady();assert.equal(observer.coverage().ready,true);
});

test('published schemas cover nested nullable evidence and SDK validates strict arguments',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {McpServer}=await import('@modelcontextprotocol/sdk/server/mcp.js');const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const ami=new Transport();const observer=new CallObserver(target,()=>async()=>ami,100);const server=new McpServer({name:'observation-test',version:'1'});const client=new Client({name:'test',version:'1'});
 tools.registerCallObservationTools(server,{timeoutMs:100,allowWrite:false,allowProvision:false},()=>({...target,getObserver:()=>observer}));
 const [a,b]=InMemoryTransport.createLinkedPair();t.after(async()=>{observer.close();await client.close();await server.close();});await Promise.all([server.connect(a),client.connect(b)]);
 const listed=await client.listTools();assert.deepEqual(listed.tools.map(t=>t.name).sort(),['asterisk_fixture_check','asterisk_recent_calls','asterisk_wait_call']);
 const schema=listed.tools.find(t=>t.name==='asterisk_wait_call').outputSchema;assert.equal(schema.properties.record.anyOf[0].properties.sipMetadata.properties.fields.additionalProperties,false);
 const invalid=await client.callTool({name:'asterisk_recent_calls',arguments:{password:'secret'}});assert.equal(invalid.isError,true);
 const empty=await client.callTool({name:'asterisk_recent_calls',arguments:{}});assert.equal(empty.isError,undefined);assert.deepEqual(empty.structuredContent.records,[]);assert.equal(empty.structuredContent.coverage.ready,true);
});

test('fixture tool is strict no-args, snapshot-bound and publishes full structured evidence',async t=>{
 const {handlers:h,definitions:d,setSnapshot,observer}=setup(t);
 setSnapshot({...target,fixtureExpectation:{noActiveChannels:true},getObserver:()=>observer,getClient:async()=>({command:async()=> 'Asterisk 22.0.0 built by builder',action:async()=>[{Response:'Success',EventList:'start'},{Event:'CoreShowChannelsComplete'}]})});
 assert.equal((await h.asterisk_fixture_check({path:'/tmp/x'})).isError,true);
 const result=await h.asterisk_fixture_check({});assert.equal(result.isError,undefined);assert.equal(content(result).status,'PASS');assert.equal(content(result).observationReady,true);assert.ok(d.asterisk_fixture_check.outputSchema.safeParse(content(result)).success);
 setSnapshot({...target,getObserver:()=>{throw new Error('named_target_required');}});assert.equal((await h.asterisk_fixture_check({})).isError,true);
});

test('recent adapter preserves selector uncertainty alongside a known limited match',async t=>{
 const {ami,observer,handlers:h,definitions:d}=setup(t);await observer.ensureReady();ami.emit('Newchannel','unknown');ami.emit('Hangup','unknown');
 const unknown=await h.asterisk_recent_calls({callId:'wanted'});assert.equal(content(unknown).coverage.correlationComplete,false);assert.deepEqual(content(unknown).coverage.correlationReasons,['channel_gone']);assert.deepEqual(content(unknown).records,[]);assert.ok(d.asterisk_recent_calls.outputSchema.safeParse(content(unknown)).success);
 ami.emit('Newchannel','partial',{Exten:undefined});ami.emit('Hangup','partial');ami.emit('Newchannel','known');ami.emit('Hangup','known');
 const recent=await h.asterisk_recent_calls({did:'100',limit:1});assert.deepEqual(content(recent).records.map(r=>r.uniqueid),['known']);assert.equal(content(recent).coverage.correlationComplete,false);assert.deepEqual(content(recent).coverage.correlationReasons,['not_observed']);assert.ok(d.asterisk_recent_calls.outputSchema.safeParse(content(recent)).success);
 assert.equal(content(await h.asterisk_recent_calls({})).coverage.correlationComplete,true);
});

test('wait and recent adapters expose missing original DID and requested context',async t=>{
 const cases=[[{Exten:undefined},{did:'100'}],[{Context:undefined},{did:'100',context:'mcp-test'}]];
 await Promise.all(cases.map(async([extra,selector])=>{
  const {ami,observer,handlers:h,definitions:d}=setup(t);await observer.ensureReady();const wait=h.asterisk_wait_call({...selector,timeoutSeconds:1});ami.emit('Newchannel','partial',extra);ami.emit('Hangup','partial');
  const result=await wait;assert.equal(content(result).outcome,'timed_out_no_match');assert.equal(content(result).coverage.correlationComplete,false);assert.deepEqual(content(result).coverage.correlationReasons,['not_observed']);assert.ok(d.asterisk_wait_call.outputSchema.safeParse(content(result)).success);
  const recent=await h.asterisk_recent_calls(selector);assert.deepEqual(content(recent).records,[]);assert.equal(content(recent).coverage.correlationComplete,false);assert.deepEqual(content(recent).coverage.correlationReasons,['not_observed']);assert.ok(d.asterisk_recent_calls.outputSchema.safeParse(content(recent)).success);
 }));
});
