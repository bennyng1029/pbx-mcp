import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFixtureExpectations } from "../dist/fixture.js";
import { loadConfig } from "../dist/config.js";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pbx-expectations-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const file = path.join(tmp, "secret-path.json");
const write = value => { fs.writeFileSync(file, JSON.stringify(value)); return file; };
test("absent expectations and environment setting", () => {
  assert.deepEqual(Object.keys(loadFixtureExpectations(undefined, ["default"])), []);
  assert.equal(loadConfig({PBX_MCP_FIXTURE_EXPECTATIONS_FILE: " /tmp/x "}).fixtureExpectationsFile, "/tmp/x");
});
test("strict expectations are recursively immutable and retain exact identities", () => {
  const value = {version:"Asterisk 22",pbxUuid:"id",dialplan:{context:"mcp-test",extension:"*12#"},udpTransport:{bind:"::",port:6060},noActiveChannels:true,registrations:["Exact Name"]};
  const result = loadFixtureExpectations(write({targets:{default:value}}), ["default"]);
  assert.deepEqual(result.default, value);
  for (const object of [result, result.default, result.default.dialplan, result.default.udpTransport, result.default.registrations]) assert.equal(Object.isFrozen(object), true);
  assert.throws(() => result.default.registrations.push("new"), TypeError);
});
test("invalid files, schemas, names and secret fields fail without input or path leakage", () => {
  const secret="password-secret";
  const cases = [
    {targets:{[secret]:{}}}, {targets:{default:{password:secret}}}, {targets:{default:{version:"x\r\ny"}}},
    {targets:{default:{dialplan:{context:"x y",extension:"1"}}}},
    {targets:{default:{dialplan:{context:"x",extension:"1@x"}}}},
    {targets:{default:{udpTransport:{bind:"host",port:6060}}}},
    {targets:{default:{udpTransport:{bind:"127.0.0.1",port:0}}}},
    {targets:{default:{noActiveChannels:"true"}}}, {targets:{default:{registrations:["x","x"]}}},
    {targets:{default:{registrations:Array.from({length:129},(_,i)=>String(i))}}},
    {targets:{default:{version:""}}}, {targets:{default:{udpTransport:{bind:"127.0.0.1",port:6060,password:secret}}}},
    {targets:{default:{}},password:secret},
  ];
  for (const value of cases) assert.throws(() => loadFixtureExpectations(write(value),["default"]), error => {
    assert.doesNotMatch(error.message,/password-secret|secret-path|127\.0\.0\.1|x y/); return /is invalid/.test(error.message);
  });
  fs.writeFileSync(file, '{"password-secret":');
  for(const input of [file, path.join(tmp,"missing-password-secret")]) assert.throws(() => loadFixtureExpectations(input,["default"]), error => {
    assert.doesNotMatch(error.message,/password-secret|secret-path/); return /cannot be read/.test(error.message);
  });
});

// Exercise the public evaluator; evidence comes from observational AMI paths only.
const target = {name:'asterisk-dev',label:'Lab',host:'192.168.10.244',port:5038};
const expected = {version:'certified-22.8-cert4',pbxUuid:'uuid-one',dialplan:{context:'mcp-test',extension:'100'},udpTransport:{bind:'0.0.0.0',port:6060},noActiveChannels:true,registrations:['trunk-one']};
function fixture(overrides={}) {
 const commands=[];const coverage={generation:1,observationSince:'2026-01-01T00:00:00.000Z',ready:true,retentionSince:null,evictedCount:0,coverageHorizon:'2026-01-01T00:00:00.000Z',droppedGapCount:0,gaps:[],requestedRangeComplete:true,correlationComplete:true,correlationReasons:[]};
 const output={'core show version':'Asterisk certified/22.8-cert4 built by builder on host','core show settings':'PBX UUID: uuid-one','pjsip show transports':'Transport:  <TransportId........>  <Type>  <cos>  <tos>  <BindAddress....................>\nTransport: udp-main udp 0 0 0.0.0.0:6060\nObjects found: 1','dialplan show 100@mcp-test':"[ Context 'mcp-test' created by 'pbx_config' ]\n  '100' => 1. Answer() [extensions.conf:1]\n-= 1 extension (1 priority) in 1 context. =-",...overrides.output};
 const ami={command:async(c,timeout)=>{commands.push({command:c,timeout});if(overrides.delay)await new Promise(r=>setTimeout(r,overrides.delay));if(overrides.error)throw new Error(overrides.error);return output[c]??'';},action:async(a,timeout,options)=>{commands.push({...a,timeout,options});if(overrides.delay)await new Promise(r=>setTimeout(r,overrides.delay));if(overrides.error)throw new Error(overrides.error);return a.Action==='CoreShowChannels'?[{Response:'Success',EventList:'start'},...(overrides.channels??[]),{Event:'CoreShowChannelsComplete'}]:[{Response:'Success',EventList:'start'},...(overrides.registrations??[{Event:'OutboundRegistrationDetail',ObjectName:'trunk-one',Status:'Registered'}]),{Event:'OutboundRegistrationDetailComplete'}];}};
 const observer={ensureReady:async()=>{if(overrides.readyDelay)await new Promise(r=>setTimeout(r,overrides.readyDelay));if(overrides.readyError)throw new Error(overrides.readyError);return {generation:1,observationSince:coverage.observationSince};},coverage:()=>({...coverage,ready:!overrides.readyError})};
 return {commands,snapshot:{...target,fixtureExpectation:overrides.expectation===null?undefined:overrides.expectation??expected,getClient:async()=>ami,getObserver:()=>observer}};
}
const check=async f=>(await import('../dist/fixture.js')).checkFixture(f.snapshot,200);
test('fixture requires all exact configured evidence and readiness, without endpoints or writes',async()=>{
 const f=fixture();const result=await check(f);assert.equal(result.status,'PASS');assert.equal(result.observationReady,true);assert.ok(result.checks.every(c=>c.status==='PASS'));assert.equal(result.checks.find(c=>c.name==='version').observed,'certified-22.8-cert4');assert.ok(f.commands.every(c=>c.command||['CoreShowChannels','PJSIPShowRegistrationsOutbound'].includes(c.Action)));
 const empty=fixture({expectation:{...expected,registrations:[]}});assert.equal((await check(empty)).status,'PASS');assert.ok(!empty.commands.some(c=>/Endpoints|Registrations/.test(c.Action??'')));
});
test('fixture wrong version, UUID, UDP bind/port, TCP-only and exact missing extension fail despite readiness',async()=>{
 for(const output of [
 {'core show version':'Asterisk certified/22.7-cert3 built by builder'},
 {'core show settings':'PBX UUID: uuid-two'},
 {'pjsip show transports':'Transport: udp-main udp 0 0 0.0.0.0:5060\nObjects found: 1'},
 {'pjsip show transports':'Transport: udp-main udp 0 0 127.0.0.1:6060\nObjects found: 1'},
 {'pjsip show transports':'Transport: tcp-main tcp 0 0 0.0.0.0:6060\nObjects found: 1'},
 {'dialplan show 100@mcp-test':"[ Context 'mcp-test' created by 'pbx_config' ]\n '1000' => 1. NoOp(100) [file:1]\n-= 1 extension (1 priority) in 1 context. =-"},
 {'dialplan show 100@mcp-test':"There is no existence of '100' in context 'mcp-test'"},
 ]) {const r=await check(fixture({output}));assert.equal(r.status,'FAIL',JSON.stringify(output));assert.equal(r.observationReady,true);}
});
test('fixture unparsed and comment-only evidence is UNKNOWN; raw errors never leak',async()=>{
 for(const output of [{'core show version':'comment certified-22.8-cert4'},{'pjsip show transports':'comment udp 0.0.0.0:6060'},{'dialplan show 100@mcp-test':'comment extension 100 in mcp-test'}])assert.equal((await check(fixture({output}))).status,'UNKNOWN');
 for(const error of ['Permission denied password-secret','No such command password-secret','unexpected password-secret','timed out password-secret']){const r=await check(fixture({error}));assert.equal(r.status,'UNKNOWN');assert.doesNotMatch(JSON.stringify(r),/password-secret/);assert.ok(r.checks.some(c=>c.evidenceError));}
});
test('named registrations require exact ObjectName and registered status; FAIL overrides UNKNOWN',async()=>{
 for(const registrations of [[],[{Event:'OutboundRegistrationDetail',ObjectName:'trunk-one-extra',Status:'Registered'}],[{Event:'OutboundRegistrationDetail',ObjectName:'trunk-one',Status:'Unregistered'}]])assert.equal((await check(fixture({registrations}))).status,'FAIL');
 const r=await check(fixture({output:{'core show version':'unparsed','core show settings':'PBX UUID: wrong'}}));assert.equal(r.status,'FAIL');
});
test('absent expectations stay UNKNOWN but readiness is attempted; one total budget includes readiness',async()=>{
 assert.equal((await check(fixture({expectation:null}))).status,'UNKNOWN');assert.equal((await check(fixture({expectation:null}))).observationReady,true);
 const f=fixture({delay:80,readyDelay:180});const before=performance.now();const r=await (await import('../dist/fixture.js')).checkFixture(f.snapshot,100);assert.equal(r.status,'UNKNOWN');assert.equal(r.observationReady,false);assert.ok(performance.now()-before<160);assert.equal(r.observationSince,null);assert.equal(r.generation,null);
 assert.equal((await check(fixture({readyError:'Permission denied password-secret'}))).status,'UNKNOWN');
});
test('fixture cancellation and incomplete lists yield safe UNKNOWN rather than zero activity',async()=>{
 const f=fixture();f.snapshot.getClient=async()=>({command:async()=>'',action:async()=>[{Response:'Success',EventList:'start'}]});assert.equal((await check(f)).checks.find(c=>c.name==='noActiveChannels').status,'UNKNOWN');
 const c=new AbortController();c.abort();const r=await(await import('../dist/fixture.js')).checkFixture(fixture().snapshot,100,c.signal);assert.equal(r.status,'UNKNOWN');assert.ok(r.checks.some(c=>c.reason==='cancelled'));
});

test('configured activity mismatch and malformed registration fields retain honest evidence',async()=>{
 const active=await check(fixture({channels:[{Event:'CoreShowChannel',Channel:'PJSIP/test',Uniqueid:'one'}]}));assert.equal(active.status,'FAIL');assert.equal(active.checks.find(c=>c.name==='noActiveChannels').observed,1);
 const malformed=await check(fixture({registrations:[{Event:'OutboundRegistrationDetail',ObjectName:'trunk-one'}]}));assert.equal(malformed.status,'UNKNOWN');
 const zero=await check(fixture({output:{'pjsip show transports':'Objects found: 0'}}));assert.equal(zero.status,'FAIL');
});
test('example loads strictly without invented UUID, endpoint or registration expectations',()=>{
 const result=loadFixtureExpectations(new URL('../examples/asterisk-dev-expectations.json',import.meta.url).pathname,['asterisk-dev']);
 assert.deepEqual(result['asterisk-dev'],{version:'certified-22.8-cert4',dialplan:{context:'mcp-test',extension:'100'},udpTransport:{bind:'0.0.0.0',port:6060},noActiveChannels:true});
});
test('caller fixture timeout does not cancel shared observer startup; late evidence cannot pass',async()=>{
 const {CallObserver}=await import('../dist/call-observation.js');let release;let closes=0;
 const transport={subscribeEvents:()=>()=>{},subscribeLifecycle:()=>()=>{},close:()=>{closes++;},action:async a=>a.Action==='Events'?[{Response:'Success'}]:[{Response:'Success',EventList:'start'},{Event:'CoreShowChannelsComplete'}]};
 const observer=new CallObserver(target,()=>()=>new Promise(r=>{release=()=>r(transport);}),300);
 const f=fixture({delay:80});f.snapshot.getObserver=()=>observer;
 try{const before=performance.now();const r=await(await import('../dist/fixture.js')).checkFixture(f.snapshot,30);assert.equal(r.status,'UNKNOWN');assert.equal(r.observationReady,false);assert.ok(performance.now()-before<100);assert.ok(r.checks.some(c=>c.reason==='timed_out'));assert.equal(closes,0);release();await observer.ensureReady();assert.equal(observer.coverage().ready,true);assert.equal(r.observationReady,false);}finally{observer.close();}
});

test('explicit missing context and empty transports fail; contradictory list count is UNKNOWN',async()=>{
 assert.equal((await check(fixture({output:{'dialplan show 100@mcp-test':"There is no existence of 'mcp-test' context"}}))).status,'FAIL');
 assert.equal((await check(fixture({output:{'pjsip show transports':'No objects found.'}}))).status,'FAIL');
 const f=fixture({expectation:{noActiveChannels:true}});f.snapshot.getClient=async()=>({command:async()=> 'Asterisk 22.0.0',action:async()=>[{Response:'Success',EventList:'start'},{Event:'CoreShowChannelsComplete',ListItems:'1'}]});assert.equal((await check(f)).status,'UNKNOWN');
});
