# Closeout summary: multi-target wave

Wave: multi-target (full track, 7 tasks). Branch feat/multi-target, one commit per task plus a review-fix commit since the plan commit 0182ad2. Not tagged: the owner picks the release tag.

Delivered: shared AMI connect with login-gated readiness, bounded calls and no false empties (Task 1); named targets file, registry, select/list/get tools and read-only enforcement on one snapshot (Task 2); per-target provisioning gates with a `target` argument (Task 3); target identity in status and Call-ID/From/To/Diversion in channels (Task 4); docs (Task 5); baseline and final live verification (Tasks 0 and 6).

Cycle 2: script-only, 0 new failures (npm test: 121 tests, 119 pass, 2 opt-in skipped).
Review rounds: R13=1 (one fix round, re-verified by the full suite and an 8x loop of the targets tests).
Blocking findings: C2=0 C3=2 C4=1 C5=0
Cycle 3 (Opus): 2 blocking (zero-endpoints reply modelled wrongly, missing connect-phase test), both fixed. Cycle 4 (codex): 1 blocking (ad hoc eviction race), fixed with a regression test. Cycle 5 (Opus): none blocking; hardening fixed (CIDR extra slashes, ad hoc TLS follows env, newline channel names).
Planning-phase cycle counts (A/B/C) are in the planning session's record, not re-stated here.

Live verification: docs/verification/baseline.md, task1.md, task4-probe.md, final.md. The lab AMI permissions were fixed afterwards and the blocked rows re-run and passed (final.md). Graphify is not installed, so Rule 13a was skipped.

Owner decision 2026-10-03: the BLOCKED live rows were accepted as carry-forward CF-001, then the lab AMI permissions were fixed and the rows re-run live and passed (docs/verification/final.md). Wave closed.

## Carry-forward follow-up (2026-10-03)

All carry-forward items CF-001 through CF-008 have been resolved:
- **CF-001**: Lab AMI permissions updated in `manager.conf` on 192.168.10.244 (`read = system,call,reporting,command,config`, `write = system,call,reporting,command,config,originate`) and reloaded.
- **CF-002**: Strict schemas and `target` argument validation on `asterisk_originate`, `asterisk_hangup`, and `asterisk_cli`.
- **CF-003**: Default `readOnly: true` on file targets; warning on group/world-writable targets file.
- **CF-004**: Read CLI allowlist tightened (removed `database show`/`get`, blocked `pjsip show/list auth`).
- **CF-005**: Reconciled Decision 1 to reflect independent `PBX_MCP_ALLOW_PROVISION` gating.
- **CF-006**: Consolidated canonical CIDR matcher using `net.BlockList`.
- **CF-007**: AMI Error responses returned as tool errors (`isError: true`) for `originate` and `hangup`.
- **CF-008**: Added 1 MB buffer limit (`MAX_AMI_BUFFER`) and 128-char cap + sanitization on channel cells.
Test suite: 127 pass, 2 opt-in skipped.

## Lab port change (2026-10-03)

The lab Asterisk (`asterisk-dev` on 192.168.10.244) moved its SIP listeners off 5060 to avoid a clash with another container on the host: 6060/udp, 6060/tcp and 6061/tls (self-signed certificate). AMI stays on 5038. Integration tests against it need `PBX_MCP_IT_SIP_PORT=6060`; sipclient-mcp UAs must register to 6060 (6061 for TLS).
