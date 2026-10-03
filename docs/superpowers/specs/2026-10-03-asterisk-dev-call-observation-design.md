# Asterisk-dev call observation and fixture readiness

Date: 2026-10-03. Branch: `feat/asterisk-dev-call-observation`.

Status: architectural spec for owner review. This wave currently authorizes investigation and specification. Runtime implementation, real calls, and remote configuration changes have not been performed. Live SIP acceptance is currently blocked by the absence of a valid ingress endpoint and remains pending separate provisioning and execution authorization; this document does not require another approval for lab checks already covered by an eventual implementation approval.

## Objective

Make pbx-mcp a reliable observer for calls reaching the existing `asterisk-dev` container on `192.168.10.244`, using SIP UDP port 6060 and AMI TCP port 5038. Let an operator confirm fixture readiness, launch a call externally, and obtain a bounded account of the observed channel's answer and termination without repeated manual polling.

The observation unit is one PJSIP channel leg. A completed leg is not evidence that every leg of a bridged, transferred, or forked call has ended. Results must make missing evidence explicit.

## Scope

This wave proposes:

1. Preserve useful AMI CLI error output in the canonical command path, including missing dialplan contexts.
2. Reuse and extend canonical PJSIP channel metadata collection, retaining complete SIP Call-ID values for matching and repeated diversion metadata for inspection.
3. Add `asterisk_wait_call`, `asterisk_recent_calls`, and `asterisk_fixture_check` with bounded, per-target AMI observation.
4. Document a before/during/after recipe for this existing fixture and the distinction between AMI observation and proof of SIP or media reachability.

Guarded SIP logging, persistent CDR/CEL ingestion, new provisioning features, remote configuration edits, RTP port publication, and other containers are deferred. No new third-party dependency is proposed.

## Evidence and current constraints

Read-only investigation on 2026-10-03 established the following live state. It is a point-in-time observation, not a deployed guarantee:

| Item | Observed state |
| --- | --- |
| Host access | `sanntsu@192.168.10.244` |
| Container | `asterisk-dev`; Docker bridge network |
| Image/version | `andrius/asterisk:22.8-cert4_debian-trixie`; certified-22.8-cert4 |
| Published services | Host `192.168.10.244:5038/tcp`, `6060/udp`, `6060/tcp`, `6061/tcp` |
| PJSIP transports | Bound to `0.0.0.0:6060` UDP/TCP and `0.0.0.0:6061` TLS |
| Fixture dialplan | `mcp-test`, extension `100`: Answer, Echo, Hangup |
| Activity | No active channels; no calls processed since startup |
| Endpoints/registrations | None configured |
| Recording | CDR enabled with `cdr-custom`; unanswered CDRs disabled; CEL disabled |
| Configuration | Missing `asterisk.conf` and `rtp.conf`; built-in defaults in use |
| Media | Default RTP range 5000–31000; no published Docker RTP ports observed |
| AMI user | `mcp`, permitted local subnet, action write classes present |

AMI action authorization uses write classes even for observational actions such as Command and Getvar. A tool with read-only behavior does not imply that its AMI account can omit those action privileges. Existing documentation explains this distinction in `docs/asterisk.md:40`.

Raw AMI probes returned Success plus real Output for both `dialplan show mcp-test` and `dialplan show 100@mcp-test`. A missing context returned Error, Message `Command output follows`, and Output explaining that the context did not exist and the command failed. The recommendation's reported failure for an existing context was not reproduced. The confirmed defect is lost diagnostic Output on Error; do not implement a workaround that converts all such errors into success.

Source inspection supports these design constraints:

- `src/ami.ts:103` logs in with Events off; `src/ami.ts:152` dispatches only to action waiters. There is no existing unsolicited-event subscription path.
- `src/ami.ts:222` is the canonical CLI command method. It currently throws only the Message field on Error and discards Output. `parseMessage` at `src/ami.ts:235` already joins repeated Output keys.
- `src/tools/asterisk.ts:25` owns the existing metadata capability. Its Getvar path at `src/tools/asterisk.ts:47` has eight workers and a shared budget; `src/tools/asterisk.ts:35` truncates displayed cells to 128 characters. Matching must not use those display values.
- `src/tools/asterisk.ts:265` exposes the existing dialplan tool through the canonical command method.
- `src/targets.ts:197` creates registry-held clients; `src/targets.ts:287` binds a snapshot to one selected target before asynchronous work. Preserve that ownership pattern.
- `src/lazy-client.ts:16` provides shared cold connection attempts and rejects stale attempt ownership; reuse this capability rather than creating a parallel connection manager.
- `test/observability.test.mjs` and `test/helpers/mock-ami.mjs` provide existing in-process tool and AMI fixtures to extend. Their current models do not prove unsolicited event behavior.
- `package.json` defines `npm run build` and `npm test`; the latter builds and runs `test/*.test.mjs`.

The initial graphify query failed because no usable graph was present, so targeted source reads were the justified fallback. A later available graphify query supplied orientation to the canonical AMI client, target registry, and Asterisk tools. Source inspection remains the evidence for their exact behavior. Implementation must record its own graphify-first reuse check and the canonical capability it extends.

## Architecture

### AMI transport and observer ownership

Extend `AmiClient` with an opt-in unsolicited-event subscription and a transport lifecycle notification. Existing action matching remains keyed by ActionID and unchanged; observer delivery must not consume action responses or list rows. Default clients retain Events off and existing behavior.

Each configured named target owns one lazy observer and one additional event-enabled AMI connection. Waiters share that observer; there is no per-waiter socket. The registry owns construction, shutdown, and credentials. A target snapshot exposes a secret-free observer accessor bound to that target, together with an immutable fixture expectation when configured.

The observer subscribes to the call event class using the AMI Events action and requires successful acknowledgement before readiness. Install the event listener before requesting subscription so events interleaved with the acknowledgement cannot be lost. A connected/logged-in socket alone is insufficient readiness. Event permission denial, timeout, or incomplete bootstrap prevents readiness.

One canonical call-observation module owns the state machine, retention, matching, and waiters. Extend the existing metadata collection into a canonical shared capability rather than duplicating Getvar logic in tool handlers. Registry and tools remain adapters around those capabilities.

New observation tools support configured named targets, including the environment-backed `default` target. Ad hoc selections return `named_target_required`; existing tools retain their current ad hoc behavior. This bounds observer lifecycle and prevents transient target selections from accumulating subscriptions or history.

### Generation, bootstrap, and event merging

A generation identifies one uninterrupted subscription plus successfully completed bootstrap. Start with event delivery installed, acknowledge subscription, then request CoreShowChannels on the same connection. Queue relevant live events while collecting that snapshot, merge baseline rows with the queue, and only then publish readiness. The observer opts into bounds in the canonical AmiClient action collection: at most 128 CoreShowChannel rows total, counting non-PJSIP rows while collecting, and at most 130 total ActionID-matched messages including response and completion wrappers. Reject immediately on the 129th row or 131st message, even before CoreShowChannelsComplete arrives. A normal response plus 128 rows plus completion fits the 130-message bound. On rejection, unregister the action waiter, invalidate bootstrap with observation_gap, close the dedicated observer connection, and release queued bootstrap state and related resources. Existing action callers retain their current collection behavior unless they explicitly opt into a bound.

Identify each leg by `(generation, Uniqueid)`, not the reusable channel name. Linkedid is correlation metadata only. Newchannel, Newstate with state Up, and Hangup establish observed start, answer, and end respectively. A baseline row is preexisting and has partial start coverage. A Newstate or Hangup without a known Newchannel can establish a partial record; do not invent an earlier start.

Apply queued events in receive order. Baseline data must never resurrect a channel already terminated by a queued Hangup, overwrite its original extension, or downgrade an observed answer. Hold bounded bootstrap tombstones until the merge finishes. Duplicate lifecycle events are idempotent. Action-list events are not lifecycle events.

The generation's ready boundary is created after the merge. `observationSince` returned by fixture_check is a UTC timestamp suitable for a later `since` filter. A test call launched after fixture_check returns is within that boundary; observations before readiness are either bootstrap partial records or retained events with their own stated coverage.

A socket close, error, explicit observer shutdown, input-buffer failure, or observer capacity loss invalidates readiness. Mark unresolved active records terminal with `endState: unknown` and coverage incomplete, wake affected waiters with `observation_gap`, and release their resources. Such records are never reported as completed.

The next observation invocation may lazily create a new connection and generation. Do not silently resume a waiter across a gap or infer that a channel ended during it. Retained terminal records survive a reconnect in this process and carry their original generation and gap reason. There is no background reconnect guarantee, history backfill, or persistence across process restart.

### Bounded state and metadata

Per named target, retain at most 128 live legs, 256 terminal records, and 16 concurrent waiters. Keep bootstrap events/tombstones within an explicit 512-entry bound; reaching that bound fails bootstrap with an observation gap. Live capacity loss invalidates the generation rather than silently dropping a leg and continuing to claim full coverage. Terminal ring eviction is expected retention loss and updates coverage metadata with the oldest retained boundary and dropped count. Retain at most 256 gap intervals per named target. When discarding the oldest interval, advance the conservative coverage horizon past that interval; intervals before this horizon cannot be claimed as uninterrupted coverage. A wait requesting since before the horizon returns observation_gap, and recent_calls marks that requested range explicitly incomplete. An older retained record can retain its own gap reason without establishing coverage for its surrounding interval. Report aggregate dropped-gap counters rather than retaining unbounded per-gap accounting.

Metadata collection has at most eight in-flight Getvar operations per observer, a bounded queue tied to retained legs, and one `cfg.timeoutMs` budget per leg. A hangup or generation change cancels pending enrichment and prevents stale results from mutating another generation or recycled channel. Missing Getvar data leaves fields unknown and records an enrichment reason; it does not fabricate a match.

Keep full Call-ID separately from table rendering. Metadata contains From, To, and arrays of History-Info and Diversion occurrences, preserving order and original text. Indexed header retrieval is bounded to 16 occurrences and 4096 bytes per occurrence. Values exceeding bounds are omitted or marked truncated with explicit metadata; a truncated Call-ID is never an exact-match candidate. Reject CR/LF in outgoing channel/variable identifiers. Control characters in output are sanitized for rendering without converting distinct identifiers into equivalent matches.

The `asterisk_channels` table keeps its existing columns, first-20 enrichment limit, display truncation, and n/a behavior. Its canonical metadata helper may expose raw values to the observer while preserving the table's existing observable behavior. No speculative general scheduler or shared transport abstraction is required.

### Call record semantics

Each record reports:

- Target identity, generation, record sequence, source `observed_ami`, and unit `channel_leg`.
- Uniqueid, channel, Linkedid, complete Call-ID or null, first observed DID/extension and context or null, and collected SIP metadata.
- `observedStartedAt`, `answeredAt`, and `endedAt` as UTC timestamps when observed; nullable timestamps are not synthesized from channel uptime.
- Start coverage (`newchannel` or `preexisting_or_missing`), continuity, enrichment coverage, and terminal reason.
- `answered: yes | no | unknown`: yes requires observed Up or baseline Up; no requires a complete observed lifecycle ending without Up; otherwise unknown.
- `endState: hangup | unknown`, observed hangup cause/code when present, and no fabricated cause on a gap.
- Nullable duration and talkDuration measured from monotonic receipt times. Full duration requires observed Newchannel through Hangup; talkDuration requires observed answer through Hangup. They are observed elapsed times, not authoritative billed durations.

Preserve the first extension/context rather than later dialplan locations when matching DID. For a baseline-only record, that first observed location is not asserted to be the original dialed number; DID matching requires original-extension coverage. Full Call-ID matching remains possible when enrichment supplies it. A leg with unavailable identity remains inspectable in recent history but cannot satisfy a selector whose field is unknown.

## Tool contracts

All new tools have strict schemas, bind the selected target once at entry, and send only observational AMI actions/CLI commands. All responses include the bound target identity. Operational outcomes use MCP `structuredContent` with a concise text rendering; malformed inputs, unsupported target, permission/startup failure, or exhausted waiter capacity are tool errors. An observation gap is an explicit operational outcome and never a success claim about call completion.

The stable new-tool envelope has `schemaVersion: 1`, `target: { name, label, host, port }`, `source: "observed_ami"`, `unit: "channel_leg"`, `observedAt`, and `coverage`. Coverage includes generation, ready boundary, current readiness, retention boundary, evicted count, conservative coverage horizon, aggregate dropped-gap count, and at most 256 explicit gap intervals/reasons. wait_call adds outcome and nullable record plus bounded candidates for ambiguity; recent_calls adds records; fixture_check adds status, checks, observationReady, and nullable observationSince. Structured fields use null for absent evidence and separate availability/reason fields to distinguish not-observed, unsupported, refused, truncated, and timed-out values. Never invent default From/To values. Published output schemas must describe these fields. Existing channels table output remains compatible; JSON output for that existing tool is not required in this wave because the new tools supply full correlation metadata.

### `asterisk_wait_call`

Inputs:

| Field | Contract |
| --- | --- |
| `callId` / `did` | Exactly one nonempty exact selector; no substring or case folding |
| `context` | Optional exact context, accepted only with did |
| `since` | Optional valid ISO UTC timestamp; malformed or future timestamp rejected |
| `timeoutSeconds` | Integer 1–300; default 60 |

The deadline includes observer connection, subscription, bootstrap, matching, and waiting. Without since, candidates are legs active when the invocation starts waiting after readiness plus new legs observed thereafter; previously completed records are excluded. With since, retained records with `observedStartedAt >= since` are also eligible, allowing a short call to finish before the wait invocation. A request predating retained uninterrupted coverage returns observation_gap rather than silently implying no matching call existed.

Match full Call-ID exactly, or an exactly observed original DID and optional original context. A Call-ID may occur on more than one leg; if more than one eligible record matches, return ambiguous_match with bounded candidate identifiers. DID concurrency has the same rule. Do not pick the first or most recent candidate arbitrarily. A result speaks only about candidates observed through its returned timestamp, not future legs sharing a Call-ID.

| Outcome | Meaning |
| --- | --- |
| `completed` | One eligible matched leg with an observed Hangup; record coverage remains explicit |
| `timed_out_no_match` | Continuous available observation reached deadline without an eligible known match |
| `timed_out_active` | One eligible matched leg remained active at deadline |
| `ambiguous_match` | Multiple eligible matching legs; caller must inspect candidates |
| `observation_gap` | Subscription continuity, bootstrap, retention, or capacity cannot support the requested interval |

Unavailable full Call-ID metadata is reported as correlation coverage uncertainty alongside timeout outcomes. It must not be phrased as proof that a supplied Call-ID never reached the PBX. Metadata pending at Hangup may finish only if the identity lookup still demonstrably belongs to that leg; do not query a reused channel name to fill a historical record.

Cancellation releases only that waiter's timer/listener; the shared observer remains ready. If the server integration lacks a usable cancellation signal, the configured deadline still bounds every waiter. The observer's explicit close releases all waiters, timers, listeners, queued work, and its socket.

### `asterisk_recent_calls`

Inputs: `limit` integer 1–100 (default 10); optional callId or did, optional context only with did, and optional since using the same validation as wait_call. Omit both selectors to list all terminal observed legs; supplying both is invalid.

Return terminal records newest first by terminal receipt sequence, including incomplete records closed by an observation gap. Return generation/coverage metadata even when the list is empty. An empty ring means no retained observed terminal records, not zero historical calls. Return retention range, evicted count, current readiness, and gap boundaries; a filter older than retention is explicitly incomplete. This is process-local AMI history, not CDR history. Active legs remain available through channels/wait_call and are not presented as recent completed calls.

### `asterisk_fixture_check`

Input: no arguments. Expectations are controlled by the operator, not by tool callers. Add optional `PBX_MCP_FIXTURE_EXPECTATIONS_FILE`, containing strict JSON keyed by configured named target. Read and validate it at startup; invalid JSON, unknown target keys, unsupported fields, or unreadable configured file fail startup without echoing file contents. No tool path override and no secret-bearing fields. Capture the validated immutable expectation in the target snapshot.

The future example `examples/asterisk-dev-expectations.json` will specify target asterisk-dev, required dialplan context mcp-test/extension 100, required UDP transport bound to 0.0.0.0:6060, expected version certified-22.8-cert4, and no active channels. No endpoints or registrations are required by these observational fixture expectations. Their absence does not establish SIP ingress readiness; the current fixture has no configured PJSIP endpoints. A configured PBX UUID can strengthen identity; it is not invented from the current missing-config state. Optional explicitly named expected registrations can be supported for existing fixtures, but are absent here.

Return checks with PASS, FAIL, or UNKNOWN, expected/observed values, and evidence errors. Check target identity, version, optional PBX UUID, transport, dialplan, activity, and any configured registration expectations. Missing expected dialplan/transport or an observed wrong identity is FAIL. Permission refusal, timeout, unsupported query, unparsable output, or absent expectation is UNKNOWN. Required checks must use actual AMI/CLI output, not broad substring matches; dialplan success alone does not prove the requested extension exists.

Overall PASS requires every required expectation to pass and the observer to be ready. PASS proves only the configured observational checks and observer readiness; it does not prove that a SIP caller can enter the dialplan. Any required mismatch yields FAIL; otherwise an unknown required check yields UNKNOWN. Return `observationReady`, generation, and `observationSince` only when acknowledged subscription and bootstrap have completed; readiness can be true while another fixture check fails, and the overall status remains non-PASS.

Use one total cfg.timeoutMs budget for parallel observational checks plus observer readiness. A no-active-channels expectation is a snapshot, so its result is valid at the reported time and does not guarantee subsequent exclusivity. No Docker or SSH inspection is performed by this MCP tool. External SIP reachability, Docker port mappings, RTP, and audio remain unverified by it.

## Dialplan diagnostic correction

Change only the canonical `AmiClient.command` error path to include a useful nonempty Output after its Message/context. Preserve Response Error as AmiError, retain tool `isError: true`, and preserve ordinary successful Output. Permission errors without Output retain their meaningful Message. Tests cover repeated Output lines, empty Output, existing context, existing extension, missing context, missing extension, and permission refusal.

Do not add a second AMI parser or special-case `Command output follows` as success. This repair also benefits other CLI consumers without changing their error/success classification.

## Operator recipe

1. Configure/select the named asterisk-dev target at 192.168.10.244:5038, using the existing AMI credential mechanism. Configure the fixture expectations file without credentials.
2. Call fixture_check. Proceed with observation only after overall PASS and observationReady true; retain observationSince and generation. PASS does not establish a valid SIP ingress route.
3. Before launching a SIP test, require a separately authorized valid ingress endpoint mapped to mcp-test, using existing provisioning if suitable. The current fixture has zero PJSIP endpoints, so this live SIP acceptance step is blocked. Provisioning work is outside this wave. Once that prerequisite and call execution are authorized and satisfied, launch an external SIP test to UDP 6060 and extension 100. Call generation was not performed during this investigation.
4. Call wait_call with the actual complete SIP Call-ID and retained since. If Call-ID is unavailable, use did 100/context mcp-test only when the fixture is otherwise exclusive; ambiguity remains an explicit outcome.
5. Inspect the result and recent_calls. Completed is evidence of the observed leg's Hangup. Audio assertions require separate media evidence; Echo in the dialplan and Up in AMI do not prove a working external RTP path.

This sequence arms observation before a fast call and supports sequential MCP clients. A long wait does not require a second simultaneous MCP request to launch the call.

## Alternatives considered

| Approach | Assessment |
| --- | --- |
| Poll CoreShowChannels only | Reuses existing listings, but can miss an entire short call and cannot prove its answer/hangup transitions. Unsuitable as the history source. |
| Parse cdr-custom files | Potential historical source, but currently excludes unanswered calls, requires filesystem access, and introduces persistence/schema ownership beyond this wave. |
| Enable CEL | Better lifecycle evidence for some deployments, but changes remote configuration and is outside authorized scope. |
| Share event stream with command client | Saves one socket but exposes existing callers to subscription/lifecycle changes. An opt-in registry-owned observer on the canonical client keeps the compatibility boundary smaller. |
| Per-waiter AMI connection | Makes gaps and cold start race harder to explain and grows sockets with waiters. One observer per named target supplies reusable retained history. |

## Acceptance criteria for later implementation

The future implementation must pass build/static checks and meaningful mock behavior checks in a fresh verifier context. Planned commands: `npm run build`, then the narrow new/changed test files using `node --test`, then `npm test` once for compatibility. These checks have not been run in this specification turn.

| Area | Required observable result |
| --- | --- |
| Canonical command | Existing context/extension preserve text; Error with repeated Output preserves diagnosis and isError; permission failures remain errors. |
| Compatibility | Existing clients log in Events off; existing status/channels/provisioning and ad hoc tests retain behavior. |
| Subscription | Call subscription is acknowledged; unsolicited events interleaved with list actions reach observer exactly once without disturbing action results. |
| Shared cold start | Concurrent observation tools on one named target open one observer socket; separate targets have separate observers/history. |
| Bootstrap race | Newchannel/Up/Hangup during the snapshot yields one terminal record; stale baseline never resurrects it; baseline-only channel is partial. |
| Answer semantics | Full unanswered lifecycle yields no; observed Up yields yes; missing start/answer evidence yields unknown where appropriate. |
| Fast call | fixture_check readiness, externally simulated short call, then wait_call with since returns retained completed record. |
| Matching | Long Call-IDs differing beyond column 128 remain distinct; exact DID/context uses original location; unknown/truncated identity cannot match. |
| Ambiguity | Two legs with same Call-ID or DID/context return ambiguous_match; no arbitrary selection. |
| Deadline | Cold connection, bootstrap, enrichment, and waiting respect one wait deadline; fixture checks respect one config timeout budget. |
| Disconnect | Active legs become unknown terminal records; waiters receive observation_gap; next invocation gets new generation; old callbacks cannot mutate new records. |
| Bounds | Live/bootstrap overflow fails coverage explicitly; the 129th CoreShowChannel row, including non-PJSIP rows, or 131st ActionID message rejects immediately even in a stream without Complete, unregisters the waiter, closes the observer connection, and cleans up; response plus 128 rows plus Complete succeeds within the collection bound; existing unbounded callers retain behavior; terminal eviction reports retention loss; seventeenth waiter errors; header jobs stay within eight operations. |
| Retention | recent_calls deterministic newest order; limit/filter validation; empty response includes coverage; more than 256 reconnect gaps retains at most 256 intervals and advances the conservative horizon; since before that horizon returns observation_gap for wait_call and explicit incomplete coverage for recent_calls, even if an older record remains retained. |
| Cancellation/close | Waiter cancellation frees its resources; observer shutdown releases every socket/timer/listener/job and prevents reconnect through a closed registry. |
| Fixture expectations | Invalid/unreadable/unknown-target config fails startup; callers cannot override paths; no passwords in errors/results; absence yields UNKNOWN. |
| Fixture evidence | Wrong UDP port or missing extension is FAIL; refused/timeout query is UNKNOWN; configured checks plus observer readiness required for PASS; zero endpoints can satisfy these expectations but PASS does not claim SIP ingress. |
| SIP metadata | Repeated headers preserve order within bounds; absence/permission/channel disappearance/truncation are explicit; no stale enrichment of recycled channels. |
| Multi-leg honesty | Ending one leg never claims whole Linkedid/Call-ID completion; durations/cause remain nullable when evidence is incomplete. |

Optional live SIP acceptance is currently blocked: the fixture has no valid configured PJSIP ingress endpoint. A separately authorized endpoint mapped to mcp-test must first be available, using existing provisioning if suitable; provisioning is outside this wave. After satisfying that prerequisite and authorizing call execution, repeat read-only fixture/dialplan checks against asterisk-dev; place one bounded call to UDP 6060; demonstrate the ready-before-call recipe; verify Call-ID correlation, observed answer and Hangup; separately document whether audio was actually observed. It is not a prerequisite to claim this spec was produced and is not assumed by mock success.

## Risks and decisions for owner review

Provisional choices are one observer socket per named target, leg-level completion, in-memory retention, named-target-only observation, strict operator expectations, exact selectors, and the stated bounds. They define the proposed wave and require owner acceptance before implementation planning and handoff.

AMI event filtering or missing permissions can suppress evidence. Subscription acknowledgement establishes that the server accepted the requested event setting; it cannot prove delivery of all future events. Header collection is inherently racy for very short channels, so Call-ID may remain unknown even when lifecycle events are observed. Process restart and retention eviction lose history. The empty fixture currently supplies no real-call evidence, and the absence of PJSIP endpoints blocks live SIP acceptance until separate authorized provisioning supplies valid ingress. Docker RTP publication is unresolved, so successful fixture_check and AMI completion must never be reported as media verification.

After owner acceptance, produce a reviewed implementation plan and fresh-context handoff under docs, including locked decisions, allowed files, success criteria, and prior multi-target closeout context. Implementation requires fresh workers, fresh static/functional verification, and the mandatory independent wave review cycles; no implementation work is included in this spec-only deliverable.

## Spec review record

Fresh Cycle A1 (completeness and feasibility) and Cycle B1 (architecture and assumptions) returned REVISE. The ingress prerequisite, bounded bootstrap action collection, and bounded gap metadata were corrected by a fresh revision worker. Fresh independent Cycle A2 and Cycle B2 reviewers then returned APPROVE with no remaining blocking findings. Reviews inspected the document and relevant source; they did not run tests or live calls. Graphify evidence was refreshed separately after a graph became available.

Specification closeout: investigation and this reviewed document are the delivered scope. No runtime code or fixture configuration was changed, and no test calls were placed. Build and functional checks remain acceptance requirements for later implementation. No graphify update is required for this spec-only wave because no code changed. Owner approval of this written spec remains pending; the reviews above approve its consistency and feasibility, not implementation execution.

## Primary protocol references

Asterisk's version 22 AMI documentation describes the event identity/state fields and Events action used by this design:

- [Newchannel](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Events/Newchannel/)
- [Newstate](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Events/Newstate/)
- [Hangup](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Events/Hangup/)
- [Events action](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/AMI_Actions/Events/)

These event definitions provide channel evidence; aggregation and coverage guarantees are explicitly defined here and are not claimed as guarantees made by AMI itself.
