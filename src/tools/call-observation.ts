/** Strict adapters for the canonical, registry-owned channel-leg observer. */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { Snapshot } from '../targets.js';
import { structuredText, text, toolError } from './format.js';
import { checkFixture } from '../fixture.js';

const utc = z.string().datetime();
const nullableUtc = utc.nullable();
const exactSelector = z.string().min(1).refine(v => !/[\r\n]/.test(v), 'Selector must not contain CR/LF');
const callId = exactSelector.refine(v => Buffer.byteLength(v, 'utf8') <= 4096, 'Call-ID exceeds 4096 bytes');
const since = utc.refine(v => {
  const ms = Date.parse(v);
  // Date.parse normalizes some invalid dates; compare the calendar components.
  return Number.isFinite(ms) && ms <= Date.now() && new Date(ms).toISOString().slice(0,19) === v.slice(0,19);
}, 'since must be a valid nonfuture ISO UTC timestamp').transform(v => new Date(v).toISOString());
const selectors = { callId:callId.optional(), did:exactSelector.optional(), context:exactSelector.optional(), since:since.optional() };
export const waitCallInputSchema = z.object({ ...selectors, timeoutSeconds:z.number().int().min(1).max(300).default(60) }).strict();
export const recentCallsInputSchema = z.object({ ...selectors, limit:z.number().int().min(1).max(100).default(10) }).strict();

export const targetIdentitySchema = z.object({ name:z.string(), label:z.string(), host:z.string(), port:z.number().int().min(1).max(65535) }).strict();
export const fieldCoverageSchema = z.object({
  availability:z.enum(['available','unavailable','partial']),
  reason:z.enum(['not_observed','unsupported','refused','truncated','timed_out','channel_gone','cancelled','observation_gap']).nullable(),
}).strict();
export const sipMetadataSchema = z.object({
  from:z.string().nullable(), to:z.string().nullable(), historyInfo:z.array(z.string()).max(16), diversion:z.array(z.string()).max(16),
  fields:z.object({ fullCallId:fieldCoverageSchema, from:fieldCoverageSchema, to:fieldCoverageSchema, historyInfo:fieldCoverageSchema, diversion:fieldCoverageSchema }).strict(),
}).strict();
export const coverageSchema = z.object({
  generation:z.number().int().nonnegative(), observationSince:nullableUtc, ready:z.boolean(), retentionSince:nullableUtc,
  evictedCount:z.number().int().nonnegative(), coverageHorizon:utc, droppedGapCount:z.number().int().nonnegative(),
  gaps:z.array(z.object({startedAt:utc,endedAt:nullableUtc,reason:z.string()}).strict()).max(256),
  requestedRangeComplete:z.boolean(), correlationComplete:z.boolean(), correlationReasons:z.array(z.string()),
}).strict();
export const observationEnvelopeSchema = z.object({
  schemaVersion:z.literal(1),target:targetIdentitySchema,source:z.literal('observed_ami'),unit:z.literal('channel_leg'),observedAt:utc,coverage:coverageSchema,
}).strict();
export const callRecordSchema = z.object({
  target:targetIdentitySchema,generation:z.number().int().nonnegative(),sequence:z.number().int().nonnegative(),source:z.literal('observed_ami'),unit:z.literal('channel_leg'),
  uniqueid:z.string(),channel:z.string(),linkedid:z.string().nullable(),fullCallId:z.string().nullable(),originalExtension:z.string().nullable(),originalContext:z.string().nullable(),originalExtensionObserved:z.boolean(),
  sipMetadata:sipMetadataSchema,observedStartedAt:nullableUtc,answeredAt:nullableUtc,endedAt:nullableUtc,
  startCoverage:z.enum(['newchannel','preexisting_or_missing']),continuity:z.enum(['complete','incomplete']),enrichmentCoverage:fieldCoverageSchema,terminalReason:z.string().nullable(),
  answered:z.enum(['yes','no','unknown']),endState:z.enum(['hangup','unknown']),hangupCauseCode:z.string().nullable(),hangupCause:z.string().nullable(),duration:z.number().nonnegative().nullable(),talkDuration:z.number().nonnegative().nullable(),
}).strict();
export const waitCallOutputSchema = observationEnvelopeSchema.extend({
  outcome:z.enum(['completed','timed_out_no_match','timed_out_active','ambiguous_match','observation_gap']),record:callRecordSchema.nullable(),
  candidates:z.array(z.object({generation:z.number().int().nonnegative(),uniqueid:z.string(),sequence:z.number().int().nonnegative(),channel:z.string()}).strict()).max(128),
});
export const recentCallsOutputSchema = observationEnvelopeSchema.extend({records:z.array(callRecordSchema).max(100)});

const fixtureScalarSchema = z.union([z.string(),z.number(),z.boolean(),z.null()]);
const fixtureObjectSchema = z.record(z.union([fixtureScalarSchema,z.array(z.string()).max(128)]));
const fixtureValueSchema = z.union([fixtureScalarSchema,fixtureObjectSchema,z.array(fixtureObjectSchema).max(128)]);
export const fixtureCheckInputSchema = z.object({}).strict();
export const fixtureCheckOutputSchema = observationEnvelopeSchema.extend({
  status:z.enum(['PASS','FAIL','UNKNOWN']),
  checks:z.array(z.object({
    name:z.string(),required:z.boolean(),status:z.enum(['PASS','FAIL','UNKNOWN']),expected:fixtureValueSchema,observed:fixtureValueSchema,
    availability:fieldCoverageSchema.shape.availability,reason:fieldCoverageSchema.shape.reason,evidenceError:z.string().nullable(),
  }).strict()).max(134),
  observationReady:z.boolean(),generation:z.number().int().nonnegative().nullable(),observationSince:nullableUtc,
});

function validateSelector(args: {callId?:string;did?:string;context?:string}, required:boolean): void {
  const count = Number(args.callId !== undefined) + Number(args.did !== undefined);
  if (count > 1 || required && count !== 1) throw new Error(required ? 'Give exactly one callId or did selector' : 'Give at most one callId or did selector');
  if (args.context !== undefined && args.did === undefined) throw new Error('context requires did');
}
const annotations = {readOnlyHint:true,destructiveHint:false,openWorldHint:false};
const inline = (value:string) => value.replace(/[\x00-\x1f\x7f]/g, " ");
const label = (s:Snapshot) => `Target: ${inline(s.name)} (${inline(s.host)}:${s.port})\nLabel: ${inline(s.label)}`;
const boundError = (err:unknown,snapshot?:Snapshot) => {
  const error = toolError(err);
  return text(`${snapshot ? `${label(snapshot)}\n` : ''}${inline(error.content[0].text)}`,true);
};

export function registerCallObservationTools(server:McpServer,cfg:Config,getSnapshot:()=>Snapshot): void {
  server.registerTool('asterisk_fixture_check', {
    title:'Check observational fixture readiness',
    description:'Read configured operator expectations and acknowledged observer readiness for a named target. PASS proves observational checks only; SIP ingress and RTP/audio require separate evidence. No arguments or path overrides.',
    inputSchema:fixtureCheckInputSchema,outputSchema:fixtureCheckOutputSchema,annotations,
  }, async (raw, extra) => {
    let snapshot:Snapshot | undefined;
    try {
      fixtureCheckInputSchema.parse(raw);snapshot=getSnapshot();
      const evidence=fixtureCheckOutputSchema.parse(await checkFixture(snapshot,cfg.timeoutMs,extra?.signal));
      return structuredText(evidence,`${label(snapshot)}\nFixture: ${evidence.status}\nObservation ready: ${evidence.observationReady}\nSIP ingress and RTP/audio: unverified`);
    } catch(err){return boundError(err,snapshot);}
  });
  server.registerTool('asterisk_wait_call', {
    title:'Wait for an observed channel leg',
    description:'Wait for exactly one full Call-ID or observed original DID/context. Completion proves an observed channel-leg Hangup; coverage and correlation limitations remain explicit. Named targets only.',
    inputSchema:waitCallInputSchema,outputSchema:waitCallOutputSchema,annotations,
  }, async (raw, extra) => {
    let snapshot:Snapshot | undefined;
    const controller = new AbortController();
    const signal = extra?.signal;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort',cancel,{once:true});
    if (signal?.aborted) controller.abort();
    try {
      const args = waitCallInputSchema.parse(raw); validateSelector(args,true);
      const deadline = performance.now() + args.timeoutSeconds * 1000;
      snapshot = getSnapshot(); const observer = snapshot.getObserver();
      // waitCall deliberately maps failed readiness to an operational gap. Preserve
      // the original readiness error at the tool boundary, without waiting past
      // this caller's deadline or cancelling another caller's shared startup.
      if (controller.signal.aborted) throw new Error('Call wait cancelled');
      let readinessError:unknown; let readinessFailed=false;
      void observer.ensureReady().catch(err => {readinessError=err;readinessFailed=true;});
      const result = await observer.waitCall(args,deadline,controller.signal);
      // Generation invalidation settles waiters before rejecting shared readiness.
      await Promise.resolve();
      if (readinessFailed) throw readinessError;
      const evidence = waitCallOutputSchema.parse(result);
      return structuredText(evidence,`${label(snapshot)}\nOutcome: ${evidence.outcome}\nUnit: channel_leg\nCorrelation complete: ${evidence.coverage.correlationComplete}`);
    } catch (err) { return boundError(err,snapshot); }
    finally {signal?.removeEventListener('abort',cancel);controller.abort();}
  });
  server.registerTool('asterisk_recent_calls', {
    title:'List recent observed channel legs',
    description:'List retained terminal channel legs, including incomplete gap records, newest first. Empty results describe retained AMI observation, not historical zero calls. Named targets only.',
    inputSchema:recentCallsInputSchema,outputSchema:recentCallsOutputSchema,annotations,
  }, async raw => {
    let snapshot:Snapshot | undefined;
    try {
      const args=recentCallsInputSchema.parse(raw);validateSelector(args,false);
      const deadline=performance.now()+cfg.timeoutMs;
      snapshot=getSnapshot(); const observer=snapshot.getObserver();
      const evidence=recentCallsOutputSchema.parse(await observer.recentCalls(args,deadline));
      return structuredText(evidence,`${label(snapshot)}\nRetained terminal channel legs: ${evidence.records.length}\nRequested range complete: ${evidence.coverage.requestedRangeComplete}\nCorrelation complete: ${evidence.coverage.correlationComplete}`);
    } catch (err) {return boundError(err,snapshot);}
  });
}
