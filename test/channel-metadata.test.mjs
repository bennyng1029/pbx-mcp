import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectChannelMetadata, enrichChannels } from '../dist/channel-metadata.js';

const channel = 'PJSIP/test-00000001';
function fixture(values = {}, hook = () => {}) {
  const requests = [];
  return { requests, action: async (fields) => {
    requests.push(fields); hook(fields, requests);
    const value = fields.Variable === 'CHANNEL(uniqueid)' ? 'u1' : values[fields.Variable];
    if (value instanceof Error) throw value;
    return [{ Response: 'Success', Value: value ?? '' }];
  } };
}
const collect = (ami, extra = {}) => collectChannelMetadata(ami, { generation: 1, uniqueid: 'u1', channel, ...extra }, performance.now() + 1000, new AbortController().signal);

test('table preserves four lookups, first twenty rows, PJSIP restriction and display bound', async () => {
  const ami = fixture({ 'CHANNEL(pjsip,call-id)': 'a'.repeat(140), 'PJSIP_HEADER(read,From)': 'x\n y' });
  const rows = Array.from({length:22}, (_, i) => ({Channel: i === 0 ? 'Local/test' : channel}));
  assert.equal(await enrichChannels(ami, rows, 1000), false);
  assert.equal(ami.requests.length, 19 * 4);
  assert.equal(rows[1]['Call-ID'].length, 128);
  assert.equal(rows[1].From, 'x  y');
  assert.equal(rows[20]['Call-ID'], undefined);
});
test('raw identity remains distinct after display prefix, and byte cap is exact', async () => {
  const a = await collect(fixture({'CHANNEL(pjsip,call-id)': 'a'.repeat(128)+'x'}));
  const b = await collect(fixture({'CHANNEL(pjsip,call-id)': 'a'.repeat(128)+'y'}));
  assert.notEqual(a.fullCallId, b.fullCallId);
  assert.equal((await collect(fixture({'CHANNEL(pjsip,call-id)': 'é'.repeat(2048)}))).fullCallId.length, 2048);
  const over = await collect(fixture({'CHANNEL(pjsip,call-id)': 'é'.repeat(2048)+'x'}));
  assert.equal(over.fullCallId, null); assert.equal(over.sipMetadata.fields.fullCallId.reason, 'truncated');
});
test('indexed occurrences preserve order and stop at sixteen with partial coverage', async () => {
  const values = Object.fromEntries(Array.from({length:16},(_,i)=>[`PJSIP_HEADER(read,History-Info,${i+1})`, `h${i+1}`]));
  const ami = fixture(values); const out = await collect(ami);
  assert.deepEqual(out.sipMetadata.historyInfo, Array.from({length:16},(_,i)=>`h${i+1}`));
  assert.deepEqual(out.sipMetadata.fields.historyInfo,{availability:'partial', reason:'truncated'});
  assert.ok(!ami.requests.some(r=>r.Variable.includes(',17)')));
  assert.deepEqual(out.sipMetadata.fields.diversion,{availability:'available',reason:null});
});
test('unavailable reasons stay distinct', async () => {
  for (const [error,reason] of [['Permission denied','refused'],['Unknown function','unsupported'],['AMI action timed out','timed_out'],['No such channel','channel_gone']]) {
    const out = await collect(fixture({'CHANNEL(pjsip,call-id)': new Error(error)}));
    assert.equal(out.sipMetadata.fields.fullCallId.reason, reason);
  }
  assert.equal((await collect(fixture())).sipMetadata.fields.fullCallId.reason,'not_observed');
});
test('recycled channel and stale generation discard all values', async () => {
  const ami = fixture();
  // Direct runner makes the final ownership result deterministic.
  let uniqueChecks=0;
  const out = await collectChannelMetadata(ami,{generation:1,uniqueid:'u1',channel},performance.now()+1000,new AbortController().signal,async variable=> variable==='CHANNEL(uniqueid)' ? [{Response:'Success',Value:++uniqueChecks===1?'u1':'u2'}] : [{Response:'Success',Value:variable==='CHANNEL(pjsip,call-id)'?'old':''}]);
  assert.equal(out.ownershipConfirmed,false); assert.equal(out.fullCallId,null);
  let current = true;
  const stale = fixture({'CHANNEL(pjsip,call-id)':'old'}, f=>{if(f.Variable==='CHANNEL(pjsip,call-id)') current=false;});
  const staleOut=await collect(stale,{isCurrent:()=>current});
  assert.equal(staleOut.fullCallId,null); assert.equal(staleOut.ownershipConfirmed,false);
});
test('CR/LF identifiers and cancellation are rejected before dispatch', async () => {
  const ami = fixture();
  await assert.rejects(collect(ami,{channel:channel+'\r\nAction: Hangup'}), /CR|LF|newline/i);
  assert.equal(ami.requests.length,0);
  const controller = new AbortController(); controller.abort();
  const out = await collectChannelMetadata(ami,{generation:1,uniqueid:'u1',channel},performance.now()+1000,controller.signal);
  assert.equal(out.sipMetadata.fields.fullCallId.reason,'cancelled'); assert.equal(ami.requests.length,0);
});
test('one monotonic deadline applies before queued work and final ownership', async () => {
  const ami=fixture();
  const out=await collectChannelMetadata(ami,{generation:1,uniqueid:'u1',channel},performance.now()-1,new AbortController().signal);
  assert.equal(out.sipMetadata.fields.fullCallId.reason,'timed_out'); assert.equal(ami.requests.length,0);
});
test('unclassified lookup failure is not a confirmed end of a header list', async () => {
  const out = await collect(fixture({'PJSIP_HEADER(read,History-Info,1)': new Error('unexpected reply')}));
  assert.deepEqual(out.sipMetadata.fields.historyInfo,{availability:'unavailable',reason:'not_observed'});
});
test('overlong From/To and repeated header values are omitted without prefix matching', async () => {
  const out = await collect(fixture({
    'PJSIP_HEADER(read,From)': 'x'.repeat(4097),
    'PJSIP_HEADER(read,To)': 'x'.repeat(4096),
    'PJSIP_HEADER(read,Diversion,1)': 'one',
    'PJSIP_HEADER(read,Diversion,2)': 'x'.repeat(4097),
  }));
  assert.equal(out.sipMetadata.from,null);
  assert.equal(out.sipMetadata.fields.from.reason,'truncated');
  assert.equal(out.sipMetadata.to.length,4096);
  assert.deepEqual(out.sipMetadata.diversion,['one']);
  assert.deepEqual(out.sipMetadata.fields.diversion,{availability:'partial',reason:'truncated'});
});
test('unavailable final ownership proof discards values without further historical lookup', async () => {
  const ami=fixture(); let ownership=0; const requested=[];
  const out=await collectChannelMetadata(ami,{generation:1,uniqueid:'u1',channel},performance.now()+1000,new AbortController().signal,async variable=>{
    requested.push(variable);
    if(variable==='CHANNEL(uniqueid)') {
      if(++ownership===2) throw new Error('Permission denied');
      return [{Response:'Success',Value:'u1'}];
    }
    return [{Response:'Success',Value:variable==='CHANNEL(pjsip,call-id)'?'full-id':''}];
  });
  assert.equal(out.ownershipConfirmed,false); assert.equal(out.fullCallId,null);
  assert.equal(out.sipMetadata.fields.fullCallId.reason,'refused');
  assert.equal(requested.at(-1),'CHANNEL(uniqueid)');
});
