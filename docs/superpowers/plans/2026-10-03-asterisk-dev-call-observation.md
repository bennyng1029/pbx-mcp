# Asterisk-dev Call Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task in fresh contexts. Steps use checkboxes. This document contains pseudocode only; it does not authorize execution.

**Status:** Self-reviewed PLAN for owner review; fresh completeness and architecture reviews approved the revised plan. The owner approved the design spec on 2026-10-03 and requested this pseudocode-only plan. Runtime implementation remains a later stage.

**Goal:** Observe bounded PJSIP channel-leg lifecycles on named targets, preserve AMI CLI diagnostics, and report observational fixture readiness.

**Architecture:** Extend the canonical AmiClient and metadata collection. A registry-owned, retained CallObserver uses one additional lazy AMI transport per named target; tools bind an immutable snapshot once and adapt canonical records and fixture evidence into structured results.

**Tech Stack:** Existing TypeScript, Node >=18, node:net/node:tls, Zod, MCP SDK, node:test; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-03-asterisk-dev-call-observation-design.md` (approved).

## Global Constraints

- Per target: 128 live legs, 256 terminal records, 16 concurrent waiters; no unbounded observer arrays or accounting.
- Bootstrap: 128 CoreShowChannel rows TOTAL, including non-PJSIP; 130 matched messages including response plus 128 rows plus completion. Reject the 129th row or 131st message immediately, even without Complete.
- Bootstrap events/tombstones: combined 512-entry bound; reaching that bound invalidates bootstrap. Gap intervals: at most 256; discarded intervals advance the conservative coverage horizon and increment aggregate counters.
- Enrichment: at most 8 in-flight Getvar operations per observer, bounded pending queue tied to retained legs, one cfg.timeoutMs monotonic budget per leg; indexed headers at most 16 occurrences, 4096 UTF-8 bytes per occurrence.
- Planning detail: fullCallId maximum 4096 UTF-8 bytes; overlong values are unavailable/truncated, never prefix matches. From/To use the same per-value bound. Selectors reject CR/LF and overlong callId; do not sanitize matching identity into equivalence.
- wait timeoutSeconds integer 1–300 default 60; recent limit integer 1–100 default 10. Each invocation owns one monotonic deadline, including readiness. Fixture checks share one total cfg.timeoutMs budget.
- Observation supports configured named targets and environment-backed default only. Ad hoc observation returns named_target_required; existing ad hoc tools remain compatible.
- Existing clients retain Login Events off. Observer explicitly acknowledges Events call after installing listeners; an authenticated socket is not observation readiness.
- Preserve channels columns, first-20 enrichment, 128-character display cells and n/a behavior, existing selectors, read/write/provision gates, and ordinary action callers.
- Key a leg by generation plus Uniqueid; Linkedid is correlation only. fullCallId is distinct from display text. Completion always means one channel leg.
- No remote configuration, actual calls, provisioning expansion, guarded logging, CDR/CEL persistence, Docker/SSH inspection, other-container changes, or media claims.
- No new third-party dependency; preserve unrelated changes including .gitignore. No runtime files, tests, or runtime commits are changed in this planning stage.

## Canonical Files and Locked Interfaces

Exact targeted source reads are justified after the wave-front graphify query identified AmiClient, TargetRegistry, channel enrichment and tool registration; graph navigation does not supply exact compatibility contracts. Every future implementer records its own graphify reuse query and decision.

| File | Responsibility |
| --- | --- |
| src/ami.ts | Existing parser, command diagnostics, bounded/cancellable action collection, unsolicited events and lifecycle notifications |
| src/channel-metadata.ts (new) | Extract existing table enrichment; observer Getvar collection and metadata availability |
| src/call-observation.ts (new) | Per-target retained observer, bootstrap, records, gaps, selectors and waiters |
| src/fixture.ts (new) | Strict expectation loader and observational fixture evidence/check evaluation |
| src/targets.ts | Named observer ownership, secret-free snapshots, immutable expectation, full registry close |
| src/config.ts | Optional fixtureExpectationsFile from PBX_MCP_FIXTURE_EXPECTATIONS_FILE |
| src/lazy-client.ts | Existing shared transport connection capability, narrowly extended shutdown support |
| src/tools/call-observation.ts (new) | Strict schemas, published output schemas, snapshot-bound tool adapters |
| src/tools/asterisk.ts, src/tools/format.ts | Reuse extracted table helper; structured text rendering without changing old outputs |
| src/index.ts | Register new tools and own shutdown hooks for registry/server lifecycle |

All interface descriptions below are conceptual pseudocode, not TypeScript declarations:

```pseudocode
AmiClient.action(fields, optional timeoutMs, optional options) -> promise of AmiMessage list
  options: maxMessages, rowEvent, maxRows, signal; omitted preserves existing behavior
AmiClient.subscribeEvents(listener) -> unsubscribe
AmiClient.subscribeLifecycle(listener) -> unsubscribe
  lifecycle reason: socket_closed, socket_error, input_buffer_failure, explicit_close
lazyClient(create, alive, optional signal) -> shared asynchronous transport getter
  signal permanently shuts that holder, closes its connecting/current client,
  rejects pending getter and blocks both creation and second-pass retry;
  preexisting two-argument callers unchanged
createTransportHolder(startupDeadline, attemptSignal) -> asynchronous transport getter
  registry factory creates a fresh holder for one readiness attempt;
  both connection passes use only the remaining startup budget
enrichChannels(ami, rows, budgetMs) -> promise of budgetSpent boolean
collectChannelMetadata(ami, identity, deadline, signal, runGetvar) -> promise of ChannelMetadata
  identity: generation, uniqueid, channel; runGetvar supplied by observer's eight-slot queue
  ChannelMetadata: fullCallId nullable, sipMetadata, ownershipConfirmed boolean
CallObserver(target, createTransportHolder, timeoutMs)
  ensureReady() -> shared promise of ReadyBoundary; independent startup budget timeoutMs
  waitCall(request, invocationDeadline, optional signal) -> promise of WaitResult
  recentCalls(request, invocationDeadline) -> promise of RecentResult
  coverage() -> Coverage; close() -> idempotent permanent shutdown
loadFixtureExpectations(optional file, namedTargetNames) -> immutable map of FixtureExpectation
checkFixture(snapshot, timeoutMs, optional signal) -> promise of FixtureResult
Snapshot.getObserver() -> retained CallObserver; throws named_target_required for ad hoc
Snapshot.fixtureExpectation -> immutable FixtureExpectation or absent
TargetRegistry.close() -> idempotent shutdown; blocks all future snapshot getters
registerCallObservationTools(server, cfg, getSnapshot) -> registration only
structuredText(structuredContent, conciseBody, optional isError) -> ToolResult
```

The observer object outlives transport generations. Every shared readiness attempt owns its own deadline, AbortController and fresh lazyClient transport holder. Startup timeout or generation loss permanently cancels only that holder, closes its connecting/current socket, rejects pending work, blocks its second-pass retry and ignores late completion. A later invocation creates a new holder through the registry factory, retaining the observer's records. ensureReady shares one current readiness attempt; caller cancellation/deadline stops only its own wait. Shared startup retains its cfg.timeoutMs budget for other callers. Permanent registry/observer close aborts the current attempt and disables the factory, so no late success can publish readiness or reconnect.

### Stable data vocabulary (schemaVersion 1)

Published output schemas use these exact field names. Timestamp fields are ISO UTC or null; observed elapsed durations are milliseconds or null. Internal monotonic clocks and credentials are never serialized.

```pseudocode
Envelope: schemaVersion, target {name,label,host,port}, source observed_ami,
  unit channel_leg, observedAt, coverage
Coverage: generation, observationSince, ready, retentionSince, evictedCount,
  coverageHorizon, droppedGapCount, gaps, requestedRangeComplete,
  correlationComplete, correlationReasons
Gap: startedAt, endedAt nullable, reason
Reason: not_observed, unsupported, refused, truncated, timed_out, channel_gone,
  cancelled, observation_gap; lifecycle/capacity reasons additionally describe gap cause
FieldCoverage: availability available or unavailable or partial; reason nullable
SipMetadata: from, to nullable; historyInfo, diversion ordered arrays;
  fields {fullCallId,from,to,historyInfo,diversion} each FieldCoverage
CallRecord: target, generation, sequence, source, unit, uniqueid, channel,
  linkedid nullable, fullCallId nullable, originalExtension nullable,
  originalContext nullable, originalExtensionObserved, sipMetadata,
  observedStartedAt nullable, answeredAt nullable, endedAt nullable,
  startCoverage newchannel or preexisting_or_missing,
  continuity complete or incomplete, enrichmentCoverage, terminalReason nullable,
  answered yes or no or unknown, endState hangup or unknown,
  hangupCauseCode nullable, hangupCause nullable, duration nullable, talkDuration nullable
WaitResult adds: outcome, record nullable, candidates bounded to 128 identifiers
Candidate: generation, uniqueid, sequence, channel
RecentResult adds: records
FixtureResult adds: status PASS or FAIL or UNKNOWN, checks,
  observationReady, generation nullable, observationSince nullable
FixtureCheck: name, required, status, expected nullable, observed nullable,
  availability, reason nullable, evidenceError nullable
```

Record target uses the envelope's identity shape. sequence is the observer's monotonic record identifier; recent ordering uses a distinct internal terminal receipt sequence. readiness never implies metadata complete. correlationComplete/reasons describe eligible unknown/pending identities; completed records may still have incomplete correlation coverage. coverageHorizon includes generation startup gaps, evictions and discarded gap intervals. An older retained record never proves uninterrupted coverage around itself.

## Review Focus

1. ActionID rows mistaken for lifecycle events or action-bound rejection leaking timers/socket: Task 1 tests routing and immediate cleanup.
2. Cold caller times out and cancels another caller's readiness, or shutdown publishes late success: Tasks 3–4 test independent deadlines and retained history.
3. Bootstrap Hangup followed by stale baseline or delayed enrichment resurrects/relabels a recycled leg: Tasks 2–3 test tombstones and ownership tokens.
4. Partial original-extension evidence or pending Call-ID yields false exact/unique match: Tasks 3 and 5 test honest selector eligibility and coverage.
5. Old retained records conceal forgotten gaps, or fixture broad substring matches claim PASS: Tasks 3 and 6 test conservative horizon and parsed exact evidence.

---

### Task 1: Canonical AMI diagnostics, subscriptions and bounded actions

**Files:** Modify src/ami.ts, test/helpers/mock-ami.mjs, test/ami-reliability.test.mjs; extend test/observability.test.mjs for tool isError.
**Dependencies:** None. **Produces:** AmiClient interfaces above; mock raw-response/event injection controls using the existing server/parser.
**Approach/assumptions:** Add optional action options, leaving old positional arguments valid. Use cancellable waiter records with one settle/cleanup operation; deliver only relevant unsolicited events to subscribers without consuming matched rows.
**Risks/decision points:** Dispatch reentrancy, close during connect/login, repeated lifecycle notification; idempotent cleanup is required. No alternate parser or Command-output success heuristic.
**External dependencies:** Loopback mock only. **Acceptance:** Existing success/error classifications and action result lists unchanged; observer limits fail immediately and release all resources.

- [ ] Add failing tests for Success existing context and extension; raw Error with Message Command output follows and repeated Output for missing context/extension; empty Output and permission error. Assert AmiError includes useful output, tools retain isError true, success text unchanged.
- [ ] Extend mock to inject complete raw response envelopes, Events acknowledgements/refusals, unsolicited events between list rows, partial/no-Complete streams and transport close; keep defaults compatible.
- [ ] Implement command Error message composition from meaningful Message plus nonempty Output; retain generic command context when Message absent.
- [ ] Implement subscriber unsubscribe, lifecycle notifications, and optional bounded/cancellable collection with cleanup on resolve/reject/cancel/write failure/close.
- [ ] Tests: response +128 rows +Complete succeeds; 129th row including non-PJSIP or 131st matched message rejects before Complete; no observer event steals list rows; unsubscribe stops delivery; timers and action waiters removed on every settle path. Existing unbounded list caller still works.
- [ ] Future verifier runs npm run build, then node --test test/ami-reliability.test.mjs test/observability.test.mjs; all pass.

### Task 2: Canonical metadata extraction and observer enrichment

**Files:** Create src/channel-metadata.ts, test/channel-metadata.test.mjs; modify src/tools/asterisk.ts, test/observability.test.mjs, test/helpers/mock-ami.mjs.
**Dependencies:** Task 1. **Consumes/produces:** AmiClient.action; enrichChannels and collectChannelMetadata contracts above.
**Approach/assumptions:** Extract table behavior intact; extend canonical collection for full Call-ID, From/To and indexed History-Info/Diversion. Observer owns the small queue, not a new generic scheduler.
**Risks/decision points:** Very short channels and header permission differences cannot be repaired by inventing values. An in-flight lookup may complete after Hangup only with demonstrable original-leg ownership; otherwise discard it.
**External dependencies:** Existing AMI Getvar. **Acceptance:** Raw exact identity separate from display, explicit unknown reasons, bounded concurrency/bytes and unchanged table behavior.

- [ ] Add failing tests pinning first 20 rows, PJSIP only, existing four columns, shared table budget, n/a, sanitization and 128-character display.
- [ ] Implement extracted table path without new lookups or observable changes; observer path receives generation/Uniqueid/channel ownership token, cancellation and per-leg monotonic deadline.
- [ ] Read identity first; bracket each accepted metadata batch with CHANNEL(uniqueid) ownership checks matching the expected Uniqueid and unchanged generation. If the final check is unavailable, Hangup/reuse races validation, or either check disagrees, mark that batch unavailable and discard its values; never issue fresh historical queries by channel name. Return fullCallId explicitly in ChannelMetadata and copy it into CallRecord separately from display text.
- [ ] Tests: two Call-IDs differing after character 128 remain distinct; 4096-byte value fits, 4097-byte identity is truncated/unmatchable; repeated headers retain occurrence order. If occurrence 16 exists, stop indexed retrieval there and mark coverage partial with reason truncated because additional occurrences are unknown; never query occurrence 17. Earlier confirmed absence ends a complete list. Absent/refused/unsupported/timed-out/channel-gone reasons remain distinct.
- [ ] Test recycled same channel name and stale generation completion cannot mutate either record; at most 8 active observer Getvar operations, bounded queued work, CR/LF rejected before sending.
- [ ] Future verifier runs npm run build then node --test test/channel-metadata.test.mjs test/observability.test.mjs; all pass.

### Task 3: Retained observer, generation state and bounded waits

**Files:** Create src/call-observation.ts, test/call-observation.test.mjs; extend test/helpers/mock-ami.mjs.
**Dependencies:** Tasks 1–2. **Consumes/produces:** Attempt-scoped transport-holder factory, subscriptions and collectChannelMetadata; CallObserver/record/coverage contracts above.
**Approach/assumptions:** Fixed-size maps/rings and scalar sequence/counters; one shared readiness attempt and one eight-slot enrichment queue. Queue receive timestamps with events for durations; generation ownership guards every callback.
**Risks/decision points:** Partial records cannot establish original DID; pending metadata can change known-match count. Evaluate every retained eligible leg at result timestamp and expose uncertainty rather than claiming absent or unique global correlation.
**External dependencies:** Observational Events call, CoreShowChannels and Getvar. **Acceptance:** Bootstrap race, fast calls, all wait outcomes, bounds and retained reconnect history satisfy the spec.

- [ ] Add failing tests for subscribe-before-ack events, ack refusal/timeout, incomplete bootstrap, duplicate Newchannel/Up/Hangup, baseline-only Up and orphan Newstate/Hangup.
- [ ] Implement shared startup with one cfg.timeoutMs deadline and attempt controller across connect/subscription/bootstrap. Create a fresh attempt-scoped holder through the factory; pass remaining time to every connection/action. Expiration aborts and disposes this holder, preventing its automatic second connection pass or late readiness; later invocation gets a fresh holder without losing history. Merge baseline then ordered queued events with tombstones; preserve observed Newchannel original location, observed Up and terminal records; publish ready boundary only after merge.
- [ ] Tests: Newchannel/Up/Hangup inside bootstrap produces one terminal leg; stale baseline never resurrects it. Baseline/orphan extension remains inspectable but cannot DID-match; no synthetic start timestamp. Baseline Up proves answered yes; full lifecycle without Up proves no; incomplete coverage yields unknown.
- [ ] Implement exact selector matching, per-invocation deadline and cancellation; no-since eligible set starts atomically after readiness with active legs plus later new legs, excludes preexisting terminal records. Since also admits retained starts at or after since; reject future/invalid UTC times in adapter.
- [ ] Give every waiter a window watermark, including no-since waits. If eviction removes an eligible known candidate or unresolved identity needed to evaluate that window, settle affected waiters with observation_gap; do not report no-match or uniqueness from the shortened ring. Do not pin records beyond the fixed ring bounds. Test an active no-since waiter across eviction of pending Call-ID evidence and a competing match.
- [ ] While eligible identity lookups remain pending, defer a completed unique match until pending lookups settle or caller deadline. At deadline report known matches with correlation uncertainty; multiple known matches return ambiguous_match. Unknown identity never matches; no fabricated DID from changed Exten/baseline.
- [ ] Tests: ready marker then fast call then since wait yields completed; exact original DID/context survives dialplan movement; duplicate Call-ID/DID gives ambiguity; pending enrichment becoming second match is included; unavailable metadata timeout is not proof of no ingress. Ending one Linkedid leg does not complete another.
- [ ] Implement gap terminalization and waiter release for transport failures/capacity; never resume existing waiters across gaps. Retry only on later invocation. Retain terminal ring on unsuccessful readiness attempts and reconnect; stale callbacks ignored.
- [ ] Tests: 129 live legs invalidates generation; combined bootstrap queue/tombstones reaching 512 invalidates bootstrap; 257 terminal records evicts with counters; 17th waiter errors; >256 gaps caps intervals and advances horizon even with older retained records. Recent newest-terminal order deterministic; old since reports gap/incomplete range.
- [ ] Tests: caller short deadline during shared readiness ends its wait while longer caller succeeds; cancellation frees only its own slot/timer; connect/bootstrap/enrichment all charged to original deadline. A first connection spends most of startup budget then drops after login; a stalled retry is cancelled at the original deadline with no residual socket, and a later invocation connects through a fresh holder. Close frees queues/jobs/socket/listeners/timers and prevents late readiness. Duration/talkDuration/cause null when evidence missing.
- [ ] Future verifier runs npm run build then node --test test/call-observation.test.mjs test/channel-metadata.test.mjs; all pass.

### Task 4: Registry ownership, strict startup expectations and shutdown

**Files:** Modify src/config.ts, src/targets.ts, src/lazy-client.ts, src/index.ts, test/targets.test.mjs, test/ami-reliability.test.mjs; create expectation-loader portion of src/fixture.ts and test/fixture.test.mjs.
**Dependencies:** Task 3. **Consumes/produces:** CallObserver, loader, snapshot and registry contracts above.
**Approach/assumptions:** Load target names first, then validate immutable expectations. Hold one optional observer per named entry; supply a factory for fresh attempt-scoped lazyClient transport holders. Factory creation and both connection passes check the attempt signal, permanent registry shutdown and remaining startup deadline. Do not append observer generations to held.clients; keep only the active holder and dispose it before replacement.
**Risks/decision points:** Selected target may change during await; bound snapshot wins. Registry close is permanent and closes existing ordinary clients as well as observers; avoid changing existing ad hoc eviction semantics.
**External dependencies:** Local operator-owned file only. **Acceptance:** One observer per named/default target, isolated rings, startup validation safe, shutdown prevents reconnect.

- [ ] Pin strict expectation shape: top-level targets map; each value optional version, pbxUuid, dialplan {context,extension}, udpTransport {bind,port}, noActiveChannels boolean, registrations array of exact names. No unknown/secret-bearing fields; context/extension follow current dialplan validation, bind is valid IP, port 1–65535, strings nonempty and CR/LF-free; registrations unique, at most 128.
- [ ] Tests: malformed/unreadable file, unknown target/key, invalid values and secret fields fail startup without file contents/value/password leakage; no path override in tools; absent file valid with absent expectation.
- [ ] Implement cfg.fixtureExpectationsFile, loader, immutable snapshot expectation and secret-free getObserver. Ad hoc getter rejects named_target_required without opening socket.
- [ ] Tests: concurrent cold getters share observer socket and ready attempt; separate named targets isolate history; switching selection mid-await does not redirect result; failed reconnect leaves prior terminal records. Environment default works.
- [ ] Add idempotent registry.close, permanent holder shutdown, index ownership of SIGINT/SIGTERM and transport/server closure cleanup. Signal handlers registered once; late connection/subscription completions cannot publish or open new resources.
- [ ] Future verifier runs npm run build then node --test test/targets.test.mjs test/ami-reliability.test.mjs test/fixture.test.mjs; all pass.

### Task 5: Strict observation tools and structured results

**Files:** Create src/tools/call-observation.ts, test/call-observation-tools.test.mjs; modify src/tools/format.ts, src/index.ts.
**Dependencies:** Tasks 3–4. **Consumes/produces:** Snapshot, CallObserver, stable schemas and structuredText above; registers wait_call/recent_calls now, fixture_check handler in Task 6.
**Approach/assumptions:** Thin strict Zod adapters; selected target captured before first await. Published outputSchema describes all structured evidence and nullable fields.
**Risks/decision points:** MCP cancellation signal availability is SDK dependent; use supplied signal when available and always retain configured deadline. Validation/capacity/startup errors are tool errors; operational gap/timeouts are structured outcomes.
**External dependencies:** Existing SDK/Zod only. **Acceptance:** Inputs, results and target binding match spec; rendering never determines identity matches.

- [ ] Tests: wait exactly one nonempty callId/did; recent zero or one selector; context only with did; strict unknown-key rejection; exact comparisons preserve case; since ISO UTC valid and not future; timeout/limit ranges and defaults exact.
- [ ] Implement registerCallObservationTools and structuredText; always bound target identity, schemaVersion/source/unit/observedAt/coverage. Sanitize only text rendering; never synthesize From/To.
- [ ] Tests assert completed, timed_out_no_match, timed_out_active, ambiguous_match, observation_gap; candidate list bounded, gap records never completed; no-since excludes previously terminal and since recovers fast call; empty recent still has coverage and filter incompleteness. Output schema validates returned fields.
- [ ] Test caller cancellation and seventeenth waiter error; ad hoc named_target_required; tools available independent of allowWrite/allowProvision; existing tool registration/gates unaffected.
- [ ] Future verifier runs npm run build then node --test test/call-observation-tools.test.mjs test/targets.test.mjs test/observability.test.mjs; all pass.

### Task 6: Fixture evidence, operator example and observational recipe

**Files:** Complete src/fixture.ts and test/fixture.test.mjs; modify src/tools/call-observation.ts, test/call-observation-tools.test.mjs, README.md, docs/asterisk.md; create examples/asterisk-dev-expectations.json during future implementation only.
**Dependencies:** Tasks 4–5. **Consumes/produces:** Snapshot expectation, command/action paths and ensureReady; checkFixture and FixtureResult above.
**Approach/assumptions:** Parallel observational evidence queries share one cfg.timeoutMs invocation deadline, including waiting on shared readiness. Parse named fields/rows from core show version/settings, pjsip show transports, dialplan show extension@context and CoreShowChannels; optional registrations use PJSIPShowRegistrationsOutbound list and exact ObjectName/Status evidence.
**Risks/decision points:** Unknown version/output grammar yields UNKNOWN rather than substring PASS; shared ready attempt may continue after fixture budget expires. Identity check always compares queried bound target address/name; optional UUID strengthens remote PBX identity only with actual evidence.
**External dependencies:** Existing observational AMI actions/CLI and local example file. **Acceptance:** Required mismatches FAIL, refusal/timeout/unparsed/absent expectations UNKNOWN, all required PASS plus ready required for overall PASS.

- [ ] Tests: wrong UDP bind/port, matching TCP-only transport, missing exact extension and wrong expected version/UUID FAIL; comments/substrings naming an extension cannot pass. Refused/unsupported/unparsed/timed-out evidence UNKNOWN with safe evidenceError.
- [ ] Implement checkFixture; every configured expectation required, registrations each require exact named registered status. When expectation absent return UNKNOWN but still boundedly attempt observer readiness and report actual state. Any required FAIL wins, otherwise UNKNOWN wins, otherwise readiness required for PASS.
- [ ] Tests: zero channels/endpoints and no registration expectations can PASS configured checks; zero endpoints does not produce SIP-ingress claim; readiness true with fixture mismatch still FAIL; one total budget rather than timeout per query; no Docker/SSH/provision/write AMI actions issued.
- [ ] Add strict no-argument fixture_check schema/output and example expectations for asterisk-dev: version certified-22.8-cert4, dialplan mcp-test/100, UDP bind 0.0.0.0 port6060, noActiveChannels true, no UUID/endpoints/registrations invented.
- [ ] Document configure/select -> fixture PASS/ready -> retain observationSince -> separately authorized valid ingress -> external bounded SIP test -> exact full Call-ID/since wait -> recent inspection. Current live acceptance blocked by missing ingress; existing provisioning is a separately authorized prerequisite. AMI Up/Hangup and Echo never prove RTP/audio.
- [ ] Future verifier runs npm run build then node --test test/fixture.test.mjs test/call-observation-tools.test.mjs; all pass and docs/example agree with strict schema.

### Task 7: Fresh verification, wave reviews and closeout

**Files:** Runtime/test scope above; future docs/superpowers/closeouts/2026-10-03-asterisk-dev-call-observation.md; expected graphify-out artifacts at final update.
**Dependencies:** Tasks 1–6. **Approach/assumptions:** Fresh contexts verify task evidence, then independent whole-wave reviewers inspect cumulative diff against approved spec. No live success inferred from mocks.
**Risks/decision points:** New scope/dependency/destructive action requires owner approval; genuine ambiguity blocks its dependent work. No per-task LLM architecture review after successful functional verification.
**External dependencies:** Existing build/test tools and graphify; live ingress/call permission currently absent. **Acceptance:** Recorded static, mock compatibility, dual-review and bounded-risk evidence; graph maintenance last.

- [ ] Before dispatch, coordinator locks decisions and writes fresh implementation handoff under docs with exact allowed files, objective, approved plan/spec, success criteria, prior multi-target closeout and memory pointers, deterministic first action/resume prompt. Obtain owner approval of this concrete plan; no implementation in this turn.
- [ ] Each fresh implementer reads handoff and task package, records graphify-first reuse query/decision and changes only owned scope. Fresh verifier runs npm run build before narrow functional tests; record no separate formatter/linter command exists in package.json. Fix static failures in fresh context and rerun same gate before functional evidence.
- [ ] After narrow checks, fresh verifier runs npm test once for full compatibility; validate result schemas, resource release and bounded-memory tests, not timing alone. Repeated checks only justified by changes/failures.
- [ ] Run fresh synchronous Cycle A quality review over full changed scope and independent Cycle B architecture review challenging observer design, lifecycle ownership, partial correlation and fixture assumptions. Each returns findings directly; fix blockers in fresh implementation context and reverify/rereview affected cycle. Cap each fix -> verify/review loop at 3; unresolved blockers escalate.
- [ ] Optional separately authorized live acceptance remains BLOCKED until valid ingress mapped to mcp-test exists. Then perform ready-before-call recipe on UDP6060 and observe actual Call-ID/Up/Hangup; explicitly record whether audio was separately observed. Mock success is sufficient only for mock acceptance.
- [ ] Write closeout scope, decisions, issues/resolutions, risks, static/functional evidence, both review evidence and live limits. Prepare graph status field before update; report actual graphify output in final response without further repository mutation.
- [ ] Run graphify update . as the LAST repository-affecting operation after reviews and closeout artifacts, if graph maintenance remains expected/available. Record planned-last status in artifact, actual status in final response; if unavailable state reason rather than claim update.

## Spec Coverage Matrix

| Acceptance area | Owning tasks / proving checks |
| --- | --- |
| Canonical command | 1: raw success/error envelopes, repeated/empty Output, tool isError |
| Compatibility | 1,2,4,5,7: Events off, existing table/gates/ad hoc and full suite |
| Subscription / shared cold start | 1,3,4: interleaved events, ack, one socket, target isolation |
| Bootstrap race / answer semantics | 3: ordered replay/tombstones, partial records, yes/no/unknown |
| Fast call / matching / ambiguity | 2,3,5: ready marker/since, raw full identity, original DID, duplicate/pending candidates |
| Deadline | 2–6: per-leg, per-invocation, shared startup independence, total fixture budget |
| Disconnect / cancellation / close | 1–5: gap terminalization, generations, stale callbacks, permanent registry shutdown |
| Bounds | 1–4: 128/130 bootstrap, 512 queue, live/ring/waiter bounds, eight Getvars |
| Retention | 3,5: newest terminal order, eviction, 256 gaps/horizon, old since incomplete |
| Fixture expectations / evidence | 4,6: strict safe loader, exact parsed checks, PASS/FAIL/UNKNOWN and ready |
| SIP metadata / multi-leg honesty | 2,3,5: ordered bounded fields, explicit availability, per-leg duration/cause/identity |
| Recipe / optional live acceptance | 6,7: ready before external call, ingress prerequisite, distinct media evidence |

## Coordinator Self-Review

Completed directly by the coordinator against the approved spec on 2026-10-03:

- [x] Spec coverage: checked every acceptance area against the matrix and owning tasks; preserved conditional live acceptance and per-leg evidence limits.
- [x] Step scan: tasks specify files, dependencies, approach, assumptions, risks, decision points, external dependencies and checkable results. Algorithms and assertions remain pseudocode/prose.
- [x] Interface consistency: corrected the metadata return contract to carry the actual fullCallId, not only its availability; preserved a separate display representation and fixed ownership validation.
- [x] Review Focus: all five named failures have owning-task tests. Added active no-since waiter eviction coverage after Cycle A raised the lost-candidate case.
- [x] Proportion and pseudocode constraint: seven tasks fit one compact plan; no executable implementation/test/interface bodies or runtime execution. Future verification commands are instructions, not recorded results.

Corrections from this review: explicit ChannelMetadata return value, before/after Uniqueid validation, conservative coverage at the 16-header bound without a seventeenth query, and waiter-window invalidation on relevant retention loss. Cycle B additionally identified a startup ownership gap; the plan now separates a cancellable readiness-attempt holder from permanent observer/registry shutdown, with a stalled retry test.

## Fresh Plan Review Record

Cycle A1 (completeness/feasibility) returned REVISE for the active no-since waiter eviction gap. Cycle B1 (architecture/assumptions) returned REVISE for startup cancellation/reconnect ownership. The coordinator corrected both and checked the related interface contracts. Fresh independent Cycle A2 and Cycle B2 then returned APPROVE with no remaining blockers. These were document reviews; no runtime code, builds, tests or live calls were performed. A session handoff accompanies this plan; owner approval of the plan remains pending before implementation.
