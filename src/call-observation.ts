import { AmiClient, type AmiMessage, listRows } from './ami.js';
import { collectChannelMetadata, unavailableChannelMetadata, type SipMetadata, type FieldCoverage } from './channel-metadata.js';

export interface TargetIdentity { name: string; label: string; host: string; port: number }
export interface ReadyBoundary { generation: number; observationSince: string }
export type TransportHolderFactory = (startupDeadline: number, attemptSignal: AbortSignal) => () => Promise<AmiClient>;
export interface Gap { startedAt: string; endedAt: string | null; reason: string }
export interface Coverage {
  generation: number; observationSince: string | null; ready: boolean; retentionSince: string | null;
  evictedCount: number; coverageHorizon: string; droppedGapCount: number; gaps: Gap[];
  requestedRangeComplete: boolean; correlationComplete: boolean; correlationReasons: string[];
}
export interface CallRecord {
  target: TargetIdentity; generation: number; sequence: number; source: 'observed_ami'; unit: 'channel_leg';
  uniqueid: string; channel: string; linkedid: string | null; fullCallId: string | null;
  originalExtension: string | null; originalContext: string | null; originalExtensionObserved: boolean;
  sipMetadata: SipMetadata; observedStartedAt: string | null; answeredAt: string | null; endedAt: string | null;
  startCoverage: 'newchannel' | 'preexisting_or_missing'; continuity: 'complete' | 'incomplete'; enrichmentCoverage: FieldCoverage;
  terminalReason: string | null; answered: 'yes' | 'no' | 'unknown'; endState: 'hangup' | 'unknown';
  hangupCauseCode: string | null; hangupCause: string | null; duration: number | null; talkDuration: number | null;
}
export interface Selector { callId?: string; did?: string; context?: string; since?: string }
export interface WaitRequest extends Selector { timeoutSeconds?: number }
export interface RecentRequest extends Selector { limit?: number }
export interface Candidate { generation: number; uniqueid: string; sequence: number; channel: string }
interface Envelope { schemaVersion: 1; target: TargetIdentity; source: 'observed_ami'; unit: 'channel_leg'; observedAt: string; coverage: Coverage }
export type WaitOutcome = 'completed' | 'timed_out_no_match' | 'timed_out_active' | 'ambiguous_match' | 'observation_gap';
export interface WaitResult extends Envelope { outcome: WaitOutcome; record: CallRecord | null; candidates: Candidate[] }
export interface RecentResult extends Envelope { records: CallRecord[] }
interface Leg { record: CallRecord; started: number | null; answered: number | null; terminal: number; pending: boolean; controller: AbortController }
interface Receipt { event: AmiMessage; at: string; mono: number }
interface Attempt { generation: number; controller: AbortController; deadline: number; promise: Promise<ReadyBoundary>; ami?: AmiClient; off: Array<() => void>; timer?: ReturnType<typeof setTimeout>; queue: Receipt[]; tombstones: Set<string>; bootstrapping: boolean }
interface Waiter { request: WaitRequest; watermark: number; active: Set<number>; resolve: (r: WaitResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; cancel: () => void; armed: boolean }
interface Job { leg: Leg; variable: string; deadline: number; signal: AbortSignal; resolve: (v: AmiMessage[]) => void; reject: (e: Error) => void; cancel: () => void }
const iso = () => new Date().toISOString();
const copy = <T>(v: T): T => structuredClone(v);

/** One retained observer per named target; each readiness attempt owns its transport. */
export class CallObserver {
  private generation = 0;
  private sequence = 0;
  private terminalSequence = 0;
  private live = new Map<string, Leg>();
  private terminal: Leg[] = [];
  private waiters = new Set<Waiter>();
  private jobs: Job[] = [];
  private running = 0;
  private attempt?: Attempt;
  private readyBoundary: ReadyBoundary | null = null;
  private closed = false;
  private gaps: Gap[] = [];
  private horizon = iso();
  private evictedCount = 0;
  private droppedGapCount = 0;
  constructor(private target: TargetIdentity, private createTransportHolder: TransportHolderFactory, private timeoutMs: number) {}

  ensureReady(): Promise<ReadyBoundary> {
    if (this.closed) return Promise.reject(new Error('Call observer closed'));
    if (this.readyBoundary) return Promise.resolve(copy(this.readyBoundary));
    if (this.attempt) return this.attempt.promise;
    const controller = new AbortController();
    const attempt: Attempt = { generation: ++this.generation, controller, deadline: performance.now() + this.timeoutMs,
      promise: undefined!, off: [], queue: [], tombstones: new Set(), bootstrapping: true };
    this.attempt = attempt;
    this.addGap('startup');
    attempt.promise = new Promise<ReadyBoundary>((resolve, reject) => {
      const fail = (error: unknown) => { if (this.attempt === attempt) this.invalidate(error instanceof Error ? error.message : String(error)); reject(error); };
      attempt.timer = setTimeout(() => fail(new Error('Observation startup timed out')), Math.max(1, attempt.deadline - performance.now()));
      void (async () => {
        try {
          const get = this.createTransportHolder(attempt.deadline, controller.signal);
          const ami = await get();
          this.checkAttempt(attempt); attempt.ami = ami;
          attempt.off.push(ami.subscribeEvents(event => this.receive(attempt, event)));
          attempt.off.push(ami.subscribeLifecycle(reason => { if (this.attempt === attempt) fail(new Error(reason)); }));
          const ack = await ami.action({ Action: 'Events', EventMask: 'call' }, this.remaining(attempt), { signal: controller.signal, maxMessages: 1 });
          this.checkAttempt(attempt);
          if (ack[0]?.Response?.toLowerCase() !== 'success') throw new Error(`Event subscription refused: ${ack[0]?.Message ?? 'no acknowledgement'}`);
          const baseline = await ami.action({ Action: 'CoreShowChannels' }, this.remaining(attempt), { signal: controller.signal, maxRows: 128, rowEvent: 'CoreShowChannel', maxMessages: 130 });
          this.checkAttempt(attempt);
          if (!baseline.some(m => m.Event === 'CoreShowChannelsComplete')) throw new Error('Incomplete observation bootstrap');
          const rows = listRows(baseline, 'CoreShowChannel');
          if (rows.length > 128 || baseline.length > 130) throw new Error('Bootstrap capacity exceeded');
          for (const row of rows) { this.checkAttempt(attempt); this.apply(attempt, { event: row, at: iso(), mono: performance.now() }, true); }
          for (const receipt of attempt.queue) { this.checkAttempt(attempt); this.apply(attempt, receipt); }
          this.checkAttempt(attempt);
          attempt.queue = []; attempt.tombstones.clear(); attempt.bootstrapping = false;
          clearTimeout(attempt.timer);
          const now = iso(); const last = this.gaps.at(-1); if (last?.endedAt === null) last.endedAt = now;
          this.readyBoundary = { generation: attempt.generation, observationSince: now };
          for (const leg of this.live.values()) this.enrich(attempt, leg);
          resolve(copy(this.readyBoundary));
        } catch (error) { fail(error); }
      })();
    });
    return attempt.promise;
  }
  private remaining(a: Attempt): number { this.checkAttempt(a); return Math.max(1, a.deadline - performance.now()); }
  private checkAttempt(a: Attempt): void {
    if (this.closed || this.attempt !== a || a.controller.signal.aborted || performance.now() >= a.deadline && a.bootstrapping) throw new Error('Observation attempt expired');
  }
  private addGap(reason: string): void {
    const now = iso(); const open = this.gaps.at(-1);
    if (open?.endedAt === null) open.endedAt = now;
    this.gaps.push({ startedAt: now, endedAt: null, reason });
    if (this.gaps.length > 256) { const discarded = this.gaps.shift()!; this.horizon = discarded.endedAt ?? now; this.droppedGapCount++; }
  }
  private invalidate(reason: string): void {
    const a = this.attempt; if (!a) return;
    this.attempt = undefined; this.readyBoundary = null;
    clearTimeout(a.timer); for (const off of a.off) off(); a.off = [];
    a.controller.abort(); a.ami?.close(); a.queue = []; a.tombstones.clear();
    this.addGap(reason);
    for (const leg of [...this.live.values()]) {
      leg.record.continuity = 'incomplete'; leg.record.terminalReason = reason; leg.record.endedAt = iso();
      this.finishLeg(leg);
    }
    for (const w of [...this.waiters]) this.settle(w, 'observation_gap');
  }
  private receive(a: Attempt, event: AmiMessage): void {
    if (this.attempt !== a || a.controller.signal.aborted || event.ActionID || !['Newchannel','Newstate','Hangup'].includes(event.Event ?? '') || !event.Uniqueid || !event.Channel?.startsWith('PJSIP/')) return;
    const receipt = { event: { ...event }, at: iso(), mono: performance.now() };
    if (a.bootstrapping) {
      a.queue.push(receipt); if (event.Event === 'Hangup') a.tombstones.add(event.Uniqueid);
      if (a.queue.length + a.tombstones.size >= 512) this.invalidate('bootstrap_capacity');
    } else { this.apply(a, receipt); queueMicrotask(() => this.evaluateAll()); }
  }
  private apply(a: Attempt, receipt: Receipt, baseline = false): void {
    const e = receipt.event;
    if (!e.Uniqueid || !e.Channel?.startsWith('PJSIP/') || /[\r\n]/.test(e.Channel + e.Uniqueid)) return;
    let leg = this.live.get(e.Uniqueid) ?? this.terminal.find(l => l.record.generation === a.generation && l.record.uniqueid === e.Uniqueid);
    if (leg?.record.endedAt) return;
    if (!leg) {
      if (this.live.size >= 128) { this.invalidate('live_capacity'); return; }
      const metadata = unavailableChannelMetadata('not_observed');
      const newchannel = !baseline && e.Event === 'Newchannel';
      const record: CallRecord = { target: copy(this.target), generation: a.generation, sequence: ++this.sequence, source: 'observed_ami', unit: 'channel_leg',
        uniqueid: e.Uniqueid, channel: e.Channel, linkedid: e.Linkedid ?? null, fullCallId: null,
        originalExtension: e.Exten ?? null, originalContext: e.Context ?? null, originalExtensionObserved: newchannel,
        sipMetadata: metadata.sipMetadata, observedStartedAt: newchannel ? receipt.at : null, answeredAt: null, endedAt: null,
        startCoverage: newchannel ? 'newchannel' : 'preexisting_or_missing', continuity: newchannel ? 'complete' : 'incomplete',
        enrichmentCoverage: { availability: 'unavailable', reason: 'not_observed' }, terminalReason: null, answered: 'unknown', endState: 'unknown',
        hangupCauseCode: null, hangupCause: null, duration: null, talkDuration: null };
      leg = { record, started: newchannel ? receipt.mono : null, answered: null, terminal: 0, pending: false, controller: new AbortController() };
      this.live.set(e.Uniqueid, leg);
      if (!a.bootstrapping) this.enrich(a, leg);
    } else if (!baseline && e.Event === 'Newchannel' && leg.record.startCoverage !== 'newchannel') {
      leg.record.originalExtension = e.Exten ?? null; leg.record.originalContext = e.Context ?? null;
      leg.record.originalExtensionObserved = true; leg.record.observedStartedAt = receipt.at;
      leg.record.startCoverage = 'newchannel'; leg.record.continuity = 'complete'; leg.started = receipt.mono;
    }
    if ((e.ChannelStateDesc === 'Up' || e.ChannelState === '6') && leg.answered === null) {
      leg.record.answered = 'yes'; if (!baseline) { leg.answered = receipt.mono; leg.record.answeredAt = receipt.at; }
    }
    if (!baseline && e.Event === 'Hangup') {
      leg.record.endedAt = receipt.at; leg.record.endState = 'hangup'; leg.record.terminalReason = 'hangup';
      leg.record.hangupCauseCode = e.Cause ?? null; leg.record.hangupCause = e['Cause-txt'] ?? null;
      if (leg.record.answered !== 'yes') leg.record.answered = leg.record.continuity === 'complete' ? 'no' : 'unknown';
      leg.record.duration = leg.started === null ? null : Math.max(0, receipt.mono - leg.started);
      leg.record.talkDuration = leg.answered === null ? null : Math.max(0, receipt.mono - leg.answered);
      this.finishLeg(leg);
    }
  }
  private finishLeg(leg: Leg): void {
    this.live.delete(leg.record.uniqueid);
    if (leg.pending) {
      const metadata = unavailableChannelMetadata(leg.record.endState === 'hangup' ? 'channel_gone' : 'observation_gap');
      leg.record.sipMetadata = metadata.sipMetadata; leg.record.enrichmentCoverage = metadata.sipMetadata.fields.fullCallId;
    }
    leg.controller.abort(); leg.pending = false;
    leg.terminal = ++this.terminalSequence; this.terminal.push(leg);
    if (this.terminal.length > 256) {
      const evicted = this.terminal.shift()!; this.evictedCount++;
      const boundary = evicted.record.endedAt ?? iso(); if (boundary > this.horizon) this.horizon = boundary;
      for (const w of [...this.waiters]) if (w.armed && this.eligible(w, evicted)) this.settle(w, 'observation_gap');
    }
  }
  private enrich(a: Attempt, leg: Leg): void {
    if (leg.pending || leg.controller.signal.aborted || !a.ami) return;
    leg.pending = true;
    const end = performance.now() + this.timeoutMs;
    const current = () => this.attempt === a && !a.controller.signal.aborted && this.live.get(leg.record.uniqueid) === leg;
    void collectChannelMetadata(a.ami, { generation: a.generation, uniqueid: leg.record.uniqueid, channel: leg.record.channel, isCurrent: current }, end, leg.controller.signal,
      (variable, deadline, signal) => this.runGetvar(a, leg, variable, deadline, signal)).then(metadata => {
        if (!current() || leg.controller.signal.aborted) return;
        leg.record.fullCallId = metadata.fullCallId; leg.record.sipMetadata = metadata.sipMetadata;
        leg.record.enrichmentCoverage = metadata.sipMetadata.fields.fullCallId; leg.pending = false;
      }).finally(() => { if (current()) { leg.pending = false; this.evaluateAll(); } });
  }
  private runGetvar(a: Attempt, leg: Leg, variable: string, deadline: number, signal: AbortSignal): Promise<AmiMessage[]> {
    return new Promise((resolve, reject) => {
      const job: Job = { leg, variable, deadline, signal, resolve, reject, cancel: () => {
        const index = this.jobs.indexOf(job); if (index >= 0) { this.jobs.splice(index, 1); signal.removeEventListener('abort', job.cancel); reject(new Error('Getvar cancelled')); }
      } };
      if (signal.aborted || performance.now() >= deadline) { reject(new Error('Getvar timed out or cancelled')); return; }
      signal.addEventListener('abort', job.cancel, { once: true }); this.jobs.push(job); this.pump(a);
    });
  }
  private pump(a: Attempt): void {
    while (this.running < 8 && this.jobs.length) {
      const job = this.jobs.shift()!; job.signal.removeEventListener('abort', job.cancel);
      if (job.signal.aborted || this.attempt !== a || performance.now() >= job.deadline) { job.reject(new Error('Getvar timed out or cancelled')); continue; }
      this.running++;
      void a.ami!.action({ Action: 'Getvar', Channel: job.leg.record.channel, Variable: job.variable }, Math.max(1, job.deadline - performance.now()), { signal: job.signal, maxMessages: 1 })
        .then(job.resolve, job.reject).finally(() => { this.running--; if (this.attempt) this.pump(this.attempt); });
    }
  }
  coverage(): Coverage {
    return { generation: this.generation, observationSince: this.readyBoundary?.observationSince ?? null, ready: !!this.readyBoundary,
      retentionSince: this.terminal[0]?.record.observedStartedAt ?? this.terminal[0]?.record.endedAt ?? null,
      evictedCount: this.evictedCount, coverageHorizon: this.horizon, droppedGapCount: this.droppedGapCount, gaps: copy(this.gaps),
      requestedRangeComplete: true, correlationComplete: true, correlationReasons: [] };
  }
  private envelope(coverage = this.coverage()): Envelope { return { schemaVersion: 1, target: copy(this.target), source: 'observed_ami', unit: 'channel_leg', observedAt: iso(), coverage }; }
  private rangeComplete(since?: string): boolean {
    if (!since) return true;
    if (since < this.horizon) return false;
    return !this.gaps.some(g => (g.endedAt === null || g.endedAt > since) && g.startedAt < iso());
  }
  private matches(r: CallRecord, s: Selector): boolean {
    return s.callId !== undefined ? r.fullCallId !== null && r.fullCallId === s.callId
      : s.did !== undefined ? r.originalExtensionObserved && r.originalExtension === s.did && (s.context === undefined || r.originalContext === s.context) : true;
  }
  private eligible(w: Waiter, l: Leg): boolean {
    return w.active.has(l.record.sequence) || l.record.sequence > w.watermark
      || w.request.since !== undefined && l.record.observedStartedAt !== null && l.record.observedStartedAt >= w.request.since;
  }
  private eligibleLegs(w: Waiter): Leg[] { return [...this.live.values(), ...this.terminal].filter(l => this.eligible(w, l)); }
  private correlationReasons(legs: Leg[], selector: Selector): string[] {
    if (selector.callId !== undefined) return [...new Set(legs.filter(l => l.record.fullCallId === null)
      .map(l => l.pending ? 'pending' : l.record.sipMetadata.fields.fullCallId.reason ?? 'not_observed'))];
    if (selector.did !== undefined && legs.some(l => !l.record.originalExtensionObserved || l.record.originalExtension === null
      || selector.context !== undefined && l.record.originalContext === null)) return ['not_observed'];
    return [];
  }
  private result(w: Waiter, outcome: WaitOutcome): WaitResult {
    const legs = this.eligibleLegs(w); const matches = legs.filter(l => this.matches(l.record, w.request));
    const coverage = this.coverage(); coverage.requestedRangeComplete = outcome !== 'observation_gap' && this.rangeComplete(w.request.since);
    coverage.correlationReasons = this.correlationReasons(legs, w.request);
    coverage.correlationComplete = coverage.correlationReasons.length === 0;
    return { ...this.envelope(coverage), outcome, record: matches.length === 1 ? copy(matches[0].record) : null,
      candidates: matches.slice(0,128).map(l => ({ generation: l.record.generation, uniqueid: l.record.uniqueid, sequence: l.record.sequence, channel: l.record.channel })) };
  }
  private settle(w: Waiter, outcome: WaitOutcome): void {
    if (!this.waiters.delete(w)) return; clearTimeout(w.timer); w.signal?.removeEventListener('abort', w.cancel); w.resolve(this.result(w, outcome));
  }
  private evaluate(w: Waiter, expired = false): void {
    if (!w.armed) { if (expired) this.settle(w, 'observation_gap'); return; }
    if (!this.readyBoundary || !this.rangeComplete(w.request.since)) { this.settle(w, 'observation_gap'); return; }
    const legs = this.eligibleLegs(w); const matches = legs.filter(l => this.matches(l.record, w.request));
    if (matches.length > 1) this.settle(w, 'ambiguous_match');
    else if (matches.length === 1 && matches[0].record.endState === 'hangup' && (expired || w.request.callId === undefined || !legs.some(l => l.pending && l.record.fullCallId === null))) this.settle(w, 'completed');
    else if (expired) this.settle(w, matches.length ? 'timed_out_active' : 'timed_out_no_match');
  }
  private evaluateAll(): void { for (const w of [...this.waiters]) this.evaluate(w); }
  waitCall(request: WaitRequest, invocationDeadline: number, signal?: AbortSignal): Promise<WaitResult> {
    if (this.waiters.size >= 16) return Promise.reject(new Error('Observer waiter capacity exceeded (16)'));
    if (this.closed || signal?.aborted) return Promise.reject(new Error('Call wait cancelled or observer closed'));
    return new Promise((resolve, reject) => {
      const w: Waiter = { request: { ...request }, watermark: this.sequence, active: new Set(), resolve, reject, signal, armed: false, timer: undefined!, cancel: () => {
        if (!this.waiters.delete(w)) return; clearTimeout(w.timer); signal?.removeEventListener('abort', w.cancel); reject(new Error('Call wait cancelled'));
      } };
      w.timer = setTimeout(() => this.evaluate(w, true), Math.max(0, invocationDeadline - performance.now()));
      this.waiters.add(w); signal?.addEventListener('abort', w.cancel, { once: true });
      const arm = () => {
        if (!this.waiters.has(w)) return;
        // This continuation is the atomic eligibility boundary after shared readiness.
        w.watermark = this.sequence; w.active = new Set([...this.live.values()].map(l => l.record.sequence)); w.armed = true;
        this.evaluate(w, performance.now() >= invocationDeadline);
      };
      if (this.readyBoundary) arm();
      else void this.ensureReady().then(arm, () => this.settle(w, 'observation_gap'));
    });
  }
  async recentCalls(request: RecentRequest, invocationDeadline: number): Promise<RecentResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.ensureReady(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Observation invocation timed out')), Math.max(0, invocationDeadline - performance.now())); })]); }
    finally { clearTimeout(timer); }
    const coverage = this.coverage(); coverage.requestedRangeComplete = this.rangeComplete(request.since);
    const legs = this.terminal.filter(l => !request.since || l.record.observedStartedAt !== null && l.record.observedStartedAt >= request.since);
    coverage.correlationReasons = this.correlationReasons(legs, request);
    coverage.correlationComplete = coverage.correlationReasons.length === 0;
    const records = legs.filter(l => this.matches(l.record,request))
      .sort((a,b) => b.terminal - a.terminal).slice(0,request.limit ?? 10).map(l => copy(l.record));
    return { ...this.envelope(coverage), records };
  }
  close(): void {
    if (this.closed) return; this.closed = true; this.invalidate('explicit_close');
    for (const w of [...this.waiters]) this.settle(w,'observation_gap');
  }
}
