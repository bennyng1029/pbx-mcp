# Asterisk-dev Call Observation Session Handoff

## Objective

Implement bounded, observational PJSIP channel-leg tracking for named targets,
preserve canonical AMI CLI diagnostics and existing tool behavior, and expose
fixture readiness with explicit evidence limits.

The owner approved the [design spec](superpowers/specs/2026-10-03-asterisk-dev-call-observation-design.md)
on 2026-10-03 and authorized a pseudocode-only plan with coordinator self-review.
The [implementation plan](superpowers/plans/2026-10-03-asterisk-dev-call-observation.md)
has coordinator self-review and fresh A2/B2 approval after A1/B1 revisions.
The owner explicitly approved the PLAN and authorized runtime implementation in
the execution session on 2026-10-03 at planning commit `f99b2ef`. Tasks 1–7 have
fresh static/mock verification; final compatibility is 206 passed and two live
tests skipped. Both wave reviews approved after one correlation-coverage fix
round. Final graph status is tracked in the closeout artifact/session response.
Remote
configuration, provisioning, actual calls and new dependencies remain outside
that authorization.

## Approved References and Context

- Spec: `docs/superpowers/specs/2026-10-03-asterisk-dev-call-observation-design.md`.
- Plan: `docs/superpowers/plans/2026-10-03-asterisk-dev-call-observation.md`.
- Prior closeout: [multi-target closeout](closeout-multi-target.md).
- Branch snapshot: `feat/asterisk-dev-call-observation`.
- Named lab target: `asterisk-dev`, AMI `192.168.10.244:5038`, SIP UDP `6060`.
- Optional prior-context lookup: `/home/bennyng/.codex/memories/MEMORY.md`;
  consult only when needed and verify any applicable historical facts.

## Locked Cross-Cutting Decisions

The plan's Canonical Files and Locked Interfaces and Stable data vocabulary
are the canonical contracts; do not create competing interface definitions.
Use one retained registry-owned observer per named target with a separate lazy
AMI transport and fresh cancellable transport holder for each readiness attempt.
Preserve ordinary clients' Events-off behavior and existing gates/ad hoc tools.
Completion describes one generation/Uniqueid channel leg; Linkedid only correlates.
Use exact full identities independently of display sanitization and expose unknown
identity, continuity, retention and enrichment evidence rather than inventing it.
Follow every plan bound, deadline, ownership check and conservative coverage rule.
Fixture PASS proves configured observational checks and observer readiness only.
Use existing TypeScript/Node/MCP/Zod facilities; no new dependency is approved.

## Allowed Files

After owner PLAN approval, dispatch only the files enumerated for the active task.
The cumulative runtime scope is `src/ami.ts`, `src/channel-metadata.ts`,
`src/call-observation.ts`, `src/fixture.ts`, `src/targets.ts`, `src/config.ts`,
`src/lazy-client.ts`, `src/tools/call-observation.ts`, `src/tools/asterisk.ts`,
`src/tools/format.ts`, and `src/index.ts`.
The cumulative test scope is `test/helpers/mock-ami.mjs`,
`test/ami-reliability.test.mjs`, `test/observability.test.mjs`,
`test/channel-metadata.test.mjs`, `test/call-observation.test.mjs`,
`test/targets.test.mjs`, `test/fixture.test.mjs`, and
`test/call-observation-tools.test.mjs`.
Documentation/example scope is `README.md`, `docs/asterisk.md`,
`examples/asterisk-dev-expectations.json`, this handoff, and the future closeout
`docs/superpowers/closeouts/2026-10-03-asterisk-dev-call-observation.md`.
Expected graph artifacts under `graphify-out/` are updated only at final closeout.
Read direct contracts/callers as needed using graphify-first navigation; preserve
unrelated changes, including `.gitignore`, and do not expand write ownership.

## DO NOT

Do not implement until explicit owner PLAN approval is present in the session.
Do not add third-party dependencies, make destructive changes, choose unresolved
scope alternatives, or expand remote writes/provisioning without owner approval.
Do not change remote configuration, create actual calls, inspect Docker/SSH,
enable persistence/guarded logging, alter other containers, or provision media.
Do not claim whole-call completion, SIP ingress, RTP/audio, or live acceptance
from fixture checks, AMI state, Echo, documentation reviews or mock results.

## First Action

A fresh implementation executor reads this handoff and the exact plan/spec,
verifies explicit owner PLAN approval, and records the wave-start status in
`docs/superpowers/closeouts/2026-10-03-asterisk-dev-call-observation.md` before coding.
If approval is absent, report the pending gate and leave runtime work pending.

## Steps

1. Dispatch Task 1 to a fresh worker for canonical AMI diagnostics/subscriptions
   and bounded actions, with its exact file package and acceptance checks.
2. Dispatch Task 2 to a fresh worker for canonical metadata extraction/enrichment.
3. Dispatch Task 3 to a fresh worker for retained observer, generations and waits.
4. Dispatch Task 4 to a fresh worker for registry/config ownership and shutdown.
5. Dispatch Task 5 to a fresh worker for strict tools and structured result schemas.
6. Dispatch Task 6 to a fresh worker for fixture evidence, example and recipe.
7. Execute Task 7 with fresh full-suite verification, synchronous independent
   wave Cycle A quality and Cycle B architecture reviews, then write closeout.

For each task, carry the plan's dependencies, approach, assumptions, risks,
decision points and success criteria into its dispatch. Require the implementer
to record its graphify reuse query and canonical reuse decision. A fresh verifier
runs static/build checks before the task's narrow functional checks. Use fresh
contexts for fixes and verification, capped at three fix/verify attempts; escalate
unresolved blockers. Reviews return findings directly and do not delegate.
After reviews and all closeout artifacts, run `graphify update .` as the last
repository-affecting operation when available/expected; report actual status in
the final response without subsequent repository mutations.

## Success Criteria and Output Format

Use the plan's Spec Coverage Matrix and exact per-task commands as pass/fail
criteria: `npm run build` before narrow `node --test` commands, then `npm test`
once for cumulative compatibility. Record applicable static checks and limitations.
Each task result gives scope/files, reuse query/decision, checks and outcomes,
evidence, unresolved issues and limitations. Closeout records decisions, risks,
static/functional evidence, both wave reviews and planned-last graph status.
Live ingress is currently blocked by missing valid PJSIP ingress to `mcp-test`;
RTP/audio remains unverified. Record those limits truthfully. Covered lab checks
do not require a new approval gate; provisioning and actual calls remain outside
this wave unless separately authorized and their prerequisites satisfied.

## Resume Prompt

Resume the reviewed Asterisk-dev call-observation plan after owner PLAN approval.
Read this handoff, plan and spec; preserve locked contracts and task ownership.
Expected outputs are Tasks 1–6 changes, fresh static/mock verification, full-suite
compatibility evidence, independent wave A/B reviews and the named closeout.
Validate against the plan matrix/commands; retain explicit blocked-live limits.
Next actions: verify approval, record wave start, dispatch fresh Task 1 worker,
then proceed in dependency order and finish with graphify maintenance last.
