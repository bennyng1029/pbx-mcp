/** Operator-owned expectations. Tools cannot supply files or credential fields. */
import fs from "node:fs";
import net from "node:net";
import { z } from "zod";

const safeString = z.string().min(1).refine(value => !/[\r\n]/.test(value));
const expectationSchema = z.object({
  version: safeString.optional(),
  pbxUuid: safeString.optional(),
  dialplan: z.object({ context: z.string().regex(/^[\w.\-]+$/), extension: z.string().regex(/^[\w.\-*#+]+$/) }).strict().optional(),
  udpTransport: z.object({ bind: safeString.refine(value => net.isIP(value) !== 0), port: z.number().int().min(1).max(65535) }).strict().optional(),
  noActiveChannels: z.boolean().optional(),
  registrations: z.array(safeString).max(128).refine(values => new Set(values).size === values.length).optional(),
}).strict();
const fileSchema = z.object({ targets: z.record(expectationSchema) }).strict();
export interface FixtureExpectation {
  readonly version?: string;
  readonly pbxUuid?: string;
  readonly dialplan?: Readonly<{ context: string; extension: string }>;
  readonly udpTransport?: Readonly<{ bind: string; port: number }>;
  readonly noActiveChannels?: boolean;
  readonly registrations?: readonly string[];
}
export type FixtureExpectations = Readonly<Record<string, FixtureExpectation>>;

export function loadFixtureExpectations(file: string | undefined, namedTargetNames: readonly string[]): FixtureExpectations {
  if (!file) return Object.freeze(Object.create(null)) as FixtureExpectations;
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("PBX_MCP_FIXTURE_EXPECTATIONS_FILE cannot be read as JSON."); }
  const parsed = fileSchema.safeParse(raw);
  // Even validator paths and unknown keys may contain secrets. Never serialize issues.
  if (!parsed.success || Object.keys(parsed.data.targets).some(name => !namedTargetNames.includes(name))) {
    throw new Error("PBX_MCP_FIXTURE_EXPECTATIONS_FILE is invalid.");
  }
  const out: Record<string, FixtureExpectation> = Object.create(null);
  for (const [name, value] of Object.entries(parsed.data.targets)) {
    if (value.dialplan) Object.freeze(value.dialplan);
    if (value.udpTransport) Object.freeze(value.udpTransport);
    if (value.registrations) Object.freeze(value.registrations);
    out[name] = Object.freeze(value);
  }
  return Object.freeze(out);
}

import { performance } from 'node:perf_hooks';
import { listRows, type AmiMessage } from './ami.js';
import type { Snapshot } from './targets.js';
import type { Coverage, TargetIdentity } from './call-observation.js';
import type { FieldCoverage } from './channel-metadata.js';

type Status = 'PASS' | 'FAIL' | 'UNKNOWN';
export interface FixtureCheck {
  name: string; required: boolean; status: Status; expected: unknown; observed: unknown;
  availability: FieldCoverage['availability']; reason: FieldCoverage['reason']; evidenceError: string | null;
}
export interface FixtureResult {
  schemaVersion: 1; target: TargetIdentity; source: 'observed_ami'; unit: 'channel_leg'; observedAt: string; coverage: Coverage;
  status: Status; checks: FixtureCheck[]; observationReady: boolean; generation: number | null; observationSince: string | null;
}
class EvidenceUnavailable extends Error {
  constructor(readonly reason: FieldCoverage['reason']) { super(`Fixture evidence ${reason}`); }
}
function unavailable(err: unknown): EvidenceUnavailable {
  if (err instanceof EvidenceUnavailable) return err;
  const message = err instanceof Error ? err.message : '';
  if (/permission|refused|denied/i.test(message)) return new EvidenceUnavailable('refused');
  if (/no such command|unknown command|unknown action|invalid\/unknown|unsupported/i.test(message)) return new EvidenceUnavailable('unsupported');
  if (/timed out|incomplete list|timeout/i.test(message)) return new EvidenceUnavailable('timed_out');
  if (/cancelled|aborted/i.test(message)) return new EvidenceUnavailable('cancelled');
  if (/maxRows|maxMessages|exceeded/i.test(message)) return new EvidenceUnavailable('truncated');
  return new EvidenceUnavailable('not_observed');
}
// Only a caller's wait is cancelled. The shared observer startup retains its own budget.
function within<T>(work: () => Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new EvidenceUnavailable('cancelled')); return; }
    const remaining = deadline - performance.now();
    if (remaining <= 0) { reject(new EvidenceUnavailable('timed_out')); return; }
    const cancel = () => finish(new EvidenceUnavailable('cancelled'));
    const timer = setTimeout(() => finish(new EvidenceUnavailable('timed_out')), remaining);
    const finish = (err?: unknown, value?: T) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (err) reject(err); else resolve(value as T); };
    signal?.addEventListener('abort', cancel, {once:true});
    Promise.resolve().then(work).then(value => finish(undefined, value), err => finish(err));
  });
}
function evidenceCheck(name: string, expected: unknown, observed: unknown, pass: boolean): FixtureCheck {
  return {name, required:true, status:pass?'PASS':'FAIL', expected, observed, availability:'available', reason:null, evidenceError:null};
}
function unknownCheck(name: string, expected: unknown, err: unknown): FixtureCheck {
  const failure=unavailable(err);
  return {name, required:true, status:'UNKNOWN', expected, observed:null, availability:'unavailable', reason:failure.reason, evidenceError:failure.message};
}
function uniqueField(output: string, pattern: RegExp): string {
  const matches = [...output.matchAll(pattern)];
  if (matches.length !== 1) throw new EvidenceUnavailable('not_observed');
  return matches[0][1].trim();
}
function completeRows(messages: AmiMessage[], rowEvent: string, completeEvent: string): AmiMessage[] {
  const rows=listRows(messages,rowEvent);
  const completions=messages.filter(m=>m.Event===completeEvent);
  const count=completions[0]?.ListItems;
  if ((messages[0]?.Response??'').toLowerCase() !== 'success' || completions.length!==1 || messages.at(-1)?.Event!==completeEvent ||
      messages.some(m=>m.Event!==undefined&&m.Event!==rowEvent&&m.Event!==completeEvent) ||
      count!==undefined&&(!/^\d+$/.test(count)||Number(count)!==rows.length)) throw new EvidenceUnavailable('not_observed');
  return rows;
}

/** Read-only fixture snapshot. PASS is configured evidence plus acknowledged observer readiness, never SIP/media proof. */
export async function checkFixture(snapshot: Snapshot, timeoutMs: number, signal?: AbortSignal): Promise<FixtureResult> {
  const deadline=performance.now()+timeoutMs;
  const target={name:snapshot.name,label:snapshot.label,host:snapshot.host,port:snapshot.port};
  const observer=snapshot.getObserver(); // named-target boundary before any network operation
  const expectation=snapshot.fixtureExpectation;
  const client=within(()=>snapshot.getClient(),deadline,signal);
  // An already-cancelled invocation may never await this shared connection promise.
  void client.catch(()=>{});
  const remaining=()=>{
    if(signal?.aborted)throw new EvidenceUnavailable('cancelled');
    if(performance.now()>=deadline)throw new EvidenceUnavailable('timed_out');
    return Math.max(1,Math.ceil(deadline-performance.now()));
  };
  const command=(cli:string)=>within(async()=> (await client).command(cli,remaining()),deadline,signal);
  const list=(Action:string,rowEvent:string,completeEvent:string)=>within(async()=>completeRows(await(await client).action({Action},remaining(),{rowEvent,maxRows:128,maxMessages:130,signal}),rowEvent,completeEvent),deadline,signal);
  const evaluate=async(name:string,expected:unknown,query:()=>Promise<unknown>,matches:(value:unknown)=>boolean):Promise<FixtureCheck>=>{
    try {const observed=await query();return evidenceCheck(name,expected,observed,matches(observed));}
    catch(err){return unknownCheck(name,expected,err);}
  };
  const readiness=within(()=>observer.ensureReady(),deadline,signal).then(()=>true,()=>false);
  // A bound successful query establishes which configured address was queried; UUID
  // below is the optional independent PBX identity, not an inferred remote name.
  const version=command('core show version');
  const jobs:Promise<FixtureCheck>[]=[evaluate('targetIdentity',{name:target.name,host:target.host,port:target.port},async()=>{await version;return {name:target.name,host:target.host,port:target.port};},v=>JSON.stringify(v)===JSON.stringify({name:target.name,host:target.host,port:target.port}))];
  if (!expectation || Object.keys(expectation).length===0) jobs.push(Promise.resolve(unknownCheck('expectations',null,new EvidenceUnavailable('not_observed'))));
  if(expectation?.version!==undefined) jobs.push(evaluate('version',expectation.version,async()=>{
    const token=uniqueField(await version,/^Asterisk ([A-Za-z0-9][A-Za-z0-9./_-]*)(?: built by .+)?\s*$/gm);
    return token.startsWith('certified/')?token.replace('certified/','certified-'):token;
  },v=>v===expectation.version));
  if(expectation?.pbxUuid!==undefined) jobs.push(evaluate('pbxUuid',expectation.pbxUuid,async()=>uniqueField(await command('core show settings'),/^\s*PBX UUID:\s*(\S+)\s*$/gm),v=>v===expectation.pbxUuid));
  if(expectation?.udpTransport) {
    const expected=expectation.udpTransport;
    jobs.push(evaluate('udpTransport',expected,async()=>{
      const output=await command('pjsip show transports');
      if(output.trim()==='No objects found.')return [];
      const rows=[...output.matchAll(/^\s*Transport:\s+(\S+)\s+(udp|tcp|tls|ws|wss)\s+\d+\s+\d+\s+(\[[0-9a-fA-F:]+\]|[0-9.]+):(\d+)\s*$/gm)];
      const counts=[...output.matchAll(/^\s*Objects found:\s*(\d+)\s*$/gm)];
      if(counts.length!==1||Number(counts[0][1])!==rows.length)throw new EvidenceUnavailable('not_observed');
      return rows.map(m=>({name:m[1],protocol:m[2],bind:m[3].replace(/^\[|\]$/g,''),port:Number(m[4])}));
    },v=>(v as {protocol:string;bind:string;port:number}[]).some(r=>r.protocol==='udp'&&r.bind===expected.bind&&r.port===expected.port)));
  }
  if(expectation?.dialplan) {
    const expected=expectation.dialplan;
    jobs.push(evaluate('dialplan',expected,async()=>{
      let output:string;
      try{output=await command(`dialplan show ${expected.extension}@${expected.context}`);}
      catch(err){
        // Canonical command errors preserve exact CLI diagnostics. Only this known
        // diagnostic is absence evidence; all other errors remain UNKNOWN.
        if(unavailable(err).reason!=='not_observed')throw err;
        const message=err instanceof Error?err.message:'';
        const missing=[...message.matchAll(/^There is no existence of '([^']+)' in context '([^']+)'\.?\s*$/gm)];
        if(missing.length===1&&missing[0][1]===expected.extension&&missing[0][2]===expected.context)return {context:expected.context,extensions:[]};
        const contextMissing=/^There is no existence of '([^']+)' context\.?\s*$/m.exec(message);
        if(contextMissing?.[1]===expected.context)return {context:expected.context,extensions:[]};
        throw err;
      }
      const contextMissing=/^There is no existence of '([^']+)' context\.?\s*$/m.exec(output);
      if(contextMissing?.[1]===expected.context)return {context:expected.context,extensions:[]};
      const missing=/^There is no existence of '([^']+)' in context '([^']+)'\.?\s*$/m.exec(output);
      if(missing&&missing[1]===expected.extension&&missing[2]===expected.context)return {context:expected.context,extensions:[]};
      const contexts=[...output.matchAll(/^\s*\[ Context '([^']+)' created by '[^']+' \]\s*$/gm)];
      const summary=/^\s*-= (\d+) extensions? \(\d+ priorit(?:y|ies)\) in (\d+) contexts?\. =-\s*$/m.exec(output);
      const extensions=[...output.matchAll(/^\s*'([^']+)'\s*=>\s*\d+\.\s*\S.*$/gm)].map(m=>m[1]);
      if(contexts.length!==1||!summary||Number(summary[1])!==extensions.length||Number(summary[2])!==1)throw new EvidenceUnavailable('not_observed');
      return {context:contexts[0][1],extensions};
    },v=>{const result=v as {context:string;extensions:string[]};return result.context===expected.context&&result.extensions.includes(expected.extension);}));
  }
  if(expectation?.noActiveChannels!==undefined) jobs.push(evaluate('noActiveChannels',expectation.noActiveChannels,async()=>(await list('CoreShowChannels','CoreShowChannel','CoreShowChannelsComplete')).length,v=>expectation.noActiveChannels ? v===0 : (v as number)>0));
  if(expectation?.registrations?.length) {
    const registrations=list('PJSIPShowRegistrationsOutbound','OutboundRegistrationDetail','OutboundRegistrationDetailComplete');
    for(const name of expectation.registrations)jobs.push(evaluate(`registration:${name}`,'Registered',async()=>{
      const rows=await registrations;
      if(rows.some(r=>!r.ObjectName||!r.Status))throw new EvidenceUnavailable('not_observed');
      const matches=rows.filter(r=>r.ObjectName===name);
      if(matches.length>1)throw new EvidenceUnavailable('not_observed');
      return matches[0]?.Status??'absent';
    },v=>v==='Registered'));
  }
  const [checks,readyWithinBudget]=await Promise.all([Promise.all(jobs),readiness]);
  const coverage=observer.coverage();
  const observationReady=readyWithinBudget&&coverage.ready;
  const status:Status=checks.some(c=>c.required&&c.status==='FAIL')?'FAIL':checks.some(c=>c.required&&c.status==='UNKNOWN')||!observationReady?'UNKNOWN':'PASS';
  return {schemaVersion:1,target,source:'observed_ami',unit:'channel_leg',observedAt:new Date().toISOString(),coverage,status,checks,observationReady,generation:observationReady?coverage.generation:null,observationSince:observationReady?coverage.observationSince:null};
}
