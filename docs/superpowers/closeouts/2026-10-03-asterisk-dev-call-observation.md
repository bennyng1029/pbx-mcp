# Asterisk-dev call-observation wave closeout

Status: Tasks 1–7 implementation, fresh static/mock verification and both mandatory wave reviews completed on 2026-10-04. No unresolved reviewer concern remains. Final graph maintenance is scheduled after this artifact; actual output is reported in the session's final response.

## Wave start

Owner explicitly approved the reviewed implementation plan and authorized Tasks 1–7 on 2026-10-03. Execution began on branch `feat/asterisk-dev-call-observation` at planning commit `f99b2ef796a9c183c4899085ca63a7996f6942c1` after reading the handoff, plan and design. The pre-existing `.gitignore` modification is unrelated and must be preserved.

Scope: canonical AMI diagnostics, metadata, bounded observation, tools, fixture checks and documentation. No new dependencies, remote configuration, provisioning or actual test calls are authorized.

Live prerequisite: the recorded fixture lacks valid PJSIP ingress to `mcp-test`. SIP acceptance remains blocked pending separate provisioning and call authorization. RTP/audio remains unverified; AMI Up, Echo and fixture PASS cannot establish media reachability. Historical live facts from the design are not fresh deployment evidence.

## Execution evidence

Task 1 implemented and independently verified: `npm run build`, then `node --test test/ami-reliability.test.mjs test/observability.test.mjs` passed 46/46. Loopback checks required sandbox escalation; no remote actions. Reuse query and decision are recorded in the task report; timer/abort-listener cleanup was inspected and waiter removal tested. Fresh verification report: `/tmp/pbx-task1-verification.md`. No fix cycle required.

Task 2 implemented and independently verified: `npm run build`, then `node --test test/channel-metadata.test.mjs test/observability.test.mjs` passed 23/23. Canonical table extraction, raw identity byte/occurrence limits and ownership invalidation verified. Observer queue and publication checks are Task 3 responsibilities. Fresh report: `/tmp/pbx-task2-verification.md`. No fix cycle required.

Task 3 implemented and independently verified: `npm run build`, then `node --test test/call-observation.test.mjs test/channel-metadata.test.mjs` passed 31/31. Bounds, bootstrap merging, selectors/ambiguity, eviction gaps, lifecycle, cancellation and retained history verified. Real lazyClient retry suppression remains Task 4 integration acceptance. Fresh report: `/tmp/pbx-task3-verification.md`. No fix cycle required.

Task 4 implemented and independently verified: `npm run build`, then `node --test test/targets.test.mjs test/ami-reliability.test.mjs test/fixture.test.mjs` passed 100/100. Additional stdin EOF, SIGINT and SIGTERM process checks exited cleanly and released the mock AMI socket. Strict immutable loader, target isolation, bounded holders, permanent shutdown and real two-pass original-deadline behavior verified. Fresh report: `/tmp/pbx-task4-verification.md`. No fix cycle required.

Task 5 implemented and independently verified: `npm run build`, then `node --test test/call-observation-tools.test.mjs test/targets.test.mjs test/observability.test.mjs` passed 85/85. Seven supplemental actual SDK scenarios passed, covering every wait outcome, pending ambiguity and startup failure. Published schemas, strict inputs and bound-target outcomes verified. Fresh report: `/tmp/pbx-task5-verification.md`. No fix cycle required.

Task 6 implemented and independently verified: `npm run build`, then `node --test test/fixture.test.mjs test/call-observation-tools.test.mjs` passed both files; direct execution confirmed 24/24 individual tests. Strict example, exact fixture evidence, safe UNKNOWN errors, FAIL precedence, total-budget readiness and published schema validation verified. Documentation records blocked live ingress and unverified media. Fresh report: `/tmp/pbx-task6-verification.md`. No fix cycle required.

Task 7 fresh compatibility verification: `npm test` passed 202 cases (200 passed, 2 opt-in live tests skipped, zero failures), including TypeScript build. Four new test files additionally ran directly to confirm 55 individual cases passed where the runner aggregates files. `git diff --check` passed; dependencies unchanged. Fresh report: `/tmp/pbx-wave-full-verification.md`. Restricted loopback failure was resolved by local-only escalation, with no source change.

Independent synchronous quality and architecture reviews both returned REVISE with the same two P2 blockers: recent-history selectors inherited complete correlation despite unknown terminal identities, and DID/context waits omitted missing original selector fields from uncertainty. Both were reproduced with in-memory transports. Reports: `/tmp/pbx-wave-review-a.md`, `/tmp/pbx-wave-review-b.md`.

Fix round 1/3 added a canonical selector-relative uncertainty helper shared by wait/recent. Recent coverage evaluates all time-eligible terminal legs before filtering/limit; DID/context coverage requires the actual original fields. Five RED regressions reproduced both defects; preservation tests cover known/unfiltered/time-range behavior. Fresh verification passed build, 48/48 narrow tests and final `npm test`: 208 total, 206 passed, 2 opt-in live skips, zero failures. `git diff --check` passed. Evidence: `/tmp/pbx-wave-fix-round1.md`, `/tmp/pbx-wave-fix1-verification.md`.

Fresh quality rereview APPROVED, A1/A2 ADDRESSED, with no new blockers or actionable nonblocking findings (`/tmp/pbx-wave-rereview-a1.md`). Fresh independent architecture rereview APPROVED, B1/B2 ADDRESSED, with no concrete blocker or fix-induced architectural regression (`/tmp/pbx-wave-rereview-b1.md`). Both review cycles resolved in one fix/verify round, within the three-round cap. No separate formatter/linter script exists in `package.json`; TypeScript build is the static gate.

Execution interruptions: the initial fix worker hit a usage limit before writing a fix report; a fresh worker completed the same first round after owner resume. A temporary reviewer thread limit delayed architecture rereview. A CLI fallback failed read-only initialization and its escalated attempt was rejected by automatic approval review for unverified external-service transmission risk. That rejected command did not run; a native fresh reviewer became available and was dispatched instead.

## Implemented scope and decisions

- Canonical AMI Error diagnostics retain useful Output while preserving errors and ordinary Events-off callers. Opt-in action bounds, cancellation and unsolicited event/lifecycle subscriptions reuse the existing parser and transport.
- Canonical metadata extraction preserves the channels table; observer metadata retains exact raw identities with byte/occurrence limits and before/after Uniqueid ownership proof.
- One registry-owned retained observer per named/default target owns a dedicated lazy transport, acknowledged subscription, bounded bootstrap/history/waiters/gaps and eight-operation enrichment queue. Each readiness attempt gets its own cancellable holder; callers retain independent deadlines.
- `asterisk_wait_call`, `asterisk_recent_calls` and `asterisk_fixture_check` use strict inputs and published structured schemas. Completion describes one channel leg; Linkedid only correlates. Tool errors use the existing error convention with bound-target text when available; the SDK exempts error responses from success output schemas.
- Strict immutable startup expectations, parsed fixture evidence, the credential-free example and operator recipe expose UNKNOWN/gaps/retention/correlation limits. Fixture PASS requires configured checks and observation readiness.

## Remaining risks and evidence limits

All new functional acceptance is deterministic in-process, loopback AMI or SDK verification. No deployment, remote configuration, provisioning or actual call occurred. Very short calls can lose metadata; acknowledged Events settings cannot prove every future event is delivered. Unrecognized CLI grammar returns UNKNOWN. History is process-local and bounded; restart/eviction and observation gaps lose evidence. Snapshot name/address describe the configured target queried; only an optional independently observed PBX UUID strengthens remote identity. SIP ingress and RTP/audio remain outside verified scope. Changes remain in the working tree on the authorized branch; no commit, merge or push was performed. The unrelated pre-existing `.gitignore` change remains outside this wave.

## Graph maintenance

Planned-last: `graphify update .` is available and expected, and is scheduled as the final repository-affecting operation after reviews and closeout artifact consistency checking. Actual status will be reported in the final response without subsequent repository mutations. This field deliberately records the planned-last status rather than claiming success before execution.
