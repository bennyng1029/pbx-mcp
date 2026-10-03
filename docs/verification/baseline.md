# Baseline live verification (Task 0) — 2026-10-03

HEAD 0182ad2 (dist built from it). Lab Asterisk 192.168.10.244 (certified-22.8-cert4), via the registered `pbx-lab` server, `docs/verification/cold-start.mjs` / `rows.mjs` (fresh server processes from `dist/`, 30 s hard timeout per call) and sipclient-mcp. Lab writes (Rule 23, owner-confirmed for this lab only): `vfy-1001` and `vfy-trunk` only, all deleted; `pjsip show endpoints|aors` show no objects and trunk/extension lists are empty afterwards.

## Root causes found

1. **Lab AMI user `mcp` has `read perm: system,call,command` and `write perm: command,config,originate`** (`manager show user mcp`). `CoreShowChannels`, `PJSIPShowEndpoints` and `CoreStatus` need `reporting` (read); `Hangup` needs `call` (write). Raw AMI check with a fully logged-in client: all three read actions return `Response: Error / Permission denied`. The current code renders that as an empty list, hence the false empties below. This is a lab configuration precondition for Task 4/6 live rows, not a code defect; the code defect is that the error is hidden.
2. **Cold-start race** (Task 1 scope): confirmed live.

## Matrix

| Row | Result | Evidence |
|---|---|---|
| asterisk_status idle / during call | PASS | version, uptime, "0 active calls" / "1 active call" |
| asterisk_dialplan context, extension; bad input | PASS | ext 100 Answer/Echo/Hangup; bad context refused without AMI |
| asterisk_cli read; write cmd read-only; metacharacters | PASS | read ok; "not on the read-only allow list"; "shell metacharacters" |
| asterisk_cli with write enabled | PASS | `core show uptime` |
| extension create/list/delete | PASS | created mcp-vfy-1001, list shows no password, deleted, Asterisk no longer reports it |
| sipclient register with returned credentials | PASS | register_code 200, `Contact ... NonQual` in CLI |
| call to 100@mcp-test | PASS | ladder INVITE, 401, INVITE, 100, 200, ACK; CLI `PJSIP/mcp-vfy-1001-00000000/Echo Up` |
| trunk create/list/delete | PASS | mcp-vfy-trunk created, listed as vfy-trunk, deleted |
| trunk allowlist refusals (host, context) | PASS | "not on the PBX_MCP_TRUNK_ALLOW list" / "CONTEXT_ALLOW list"; nothing created |
| asterisk_originate | PASS | queued; UA rang (180), answered, CLI shows Echo channel Up |
| hangup / originate not registered read-only | PASS | tool list of the read-only server lacks both |
| **asterisk_endpoints with a registered contact** | **FAIL (false empty)** | "No endpoints found" while CLI lists the endpoint; cause: root cause 1 |
| **asterisk_channels during a live call** | **FAIL (false empty)** | "No active channels." while CLI shows the channel; cause: root cause 1 |
| **asterisk_hangup_preview during a live call** | **FAIL (false empty)** | 'Nothing matches "mcp-vfy-1001"'; cause: root cause 1 |
| **asterisk_hangup** | **FAIL (error not diagnosed)** | "Error: Permission denied" (write perm lacks `call`); correct to report as error, lab config needs `call` write |
| **cold-start race, lab, 3 fresh processes** | **FAIL (hang)** | status and endpoints HUNG > 30 s in all 3 rows; channels returned "No active channels." (un-authenticated client, Permission denied rendered as empty) |
| cold-start race, closed port 127.0.0.1:1 | FAIL (hang) | status and endpoints HUNG > 30 s; channels ECONNREFUSED in 16 ms |
| Diversion/From/To, targets, Call-ID, identity, no_target_selected | NOT-YET-IMPLEMENTED | Tasks 2 and 4 |
| unreachable-Asterisk bounded timeout | covered above | closed port shows the hang, not a bounded error |

## Owner action needed before Task 4 and Task 6 live rows can pass

Add `reporting` to the `mcp` AMI user's read perm and `call` to its write perm in the lab `manager.conf`, then `manager reload`. Without it the new code will (correctly) report "Permission denied" for channels, endpoints and hangup, and the live Call-ID and hangup rows cannot pass. Alternatively accept those rows as BLOCKED with the reason.

Code baseline: `npm test` before any change: see `.wave-baseline.json`.
