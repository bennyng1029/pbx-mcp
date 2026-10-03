# Final live verification (Task 6) — 2026-10-03

Build: HEAD after Task 5 (`dist/` rebuilt). A fresh server process per phase (`docs/verification/rows.mjs`), a targets file with three targets (`default` from env, `lab` = 192.168.10.244 with provisioning gates, `dead` = 127.0.0.1:1), `PBX_MCP_HOST_ALLOW=192.168.10.0/24`. sipclient-mcp drove the calls. Lab writes (Rule 23, owner-confirmed for 192.168.10.244 only): `vfy-1001` only. Credentials never appear in the captured outputs (grep for the secret: 0 matches).

| Row | Baseline | Final | Evidence |
|---|---|---|---|
| asterisk_status (idle, with identity) | PASS | PASS | `Target: lab (192.168.10.244:5038)`, label, `Config file: /etc/asterisk/asterisk.conf`, PBX UUID, dialplan hint, version/uptime |
| asterisk_status during a call | PASS | PASS (CLI `core show channels concise` shows the Echo channel Up) | |
| asterisk_dialplan; bad input | PASS | PASS | ext 100 Answer/Echo/Hangup |
| asterisk_cli read / write refused read-only / metachar | PASS | PASS | unit tests and live (ad hoc refuses write CLI with the target named) |
| extension create/list/delete | PASS | PASS | created, listed without password, deleted via the `target` argument; sipclient register 200 |
| trunk create/list/delete + allowlist refusals | PASS | PASS | host outside `trunkAllow` and context outside `contextAllow` refused with the operator-list message; `trunkAllow` passed as a tool argument rejected (`Unrecognized key(s)`) |
| call to 100@mcp-test (with Diversion header) | PASS | PASS | UA registered, INVITE answered, BYE 200; no channel left behind |
| asterisk_originate / hangup on a writable named target | originate PASS, hangup FAIL (Permission denied) | originate not re-run live (code path unchanged, unit-tested); hangup **BLOCKED** | lab AMI write perm lacks `call` |
| asterisk_endpoints with a registered contact | FAIL (false empty) | **BLOCKED**: now an honest `Error: Permission denied` | lab AMI write perm lacks `system,reporting` |
| asterisk_channels during a live call | FAIL (false empty) | **BLOCKED**: honest `Error: Permission denied` | same |
| asterisk_hangup_preview during a call | FAIL (false empty) | **BLOCKED**: honest `Error: Permission denied` | same |
| Call-ID / From / To / Diversion cross-check against `call_ladder` | n/a | **BLOCKED** (Getvar needs `call,reporting` write) | tool behaviour with Getvar refused is unit-tested (`n/a` cells); sipclient ladder Call-ID for the probe call `NObdaGcils@192.168.10.120` |
| cold-start race, 3 fresh processes, live | FAIL (hang) | PASS (no hang; status correct in ~23 ms; others honest errors) | `task1.md` |
| unreachable Asterisk | FAIL (hang) | PASS | `dead` target: `AMI connect failed: ECONNREFUSED` in milliseconds (whole phase 2.7 s) |
| targets: list, get, call before selecting | n/a | PASS | `no_target_selected` for status and CLI; list shows default, lab, dead |
| select named, switch, switch back | n/a | PASS | dead -> lab -> ad hoc |
| ad hoc in CIDR | n/a | PASS | 192.168.10.244:5038 read-only, status works |
| ad hoc outside CIDR / bad port / hostname | n/a | PASS (refused) | 203.0.113.9; port 5039; `localhost` |
| ad hoc refuses originate / hangup / write CLI / provisioning | n/a | PASS | all refused naming the target, no AMI write |
| mismatched `target` argument | n/a | PASS | `target "dead" is not the selected target "lab"; nothing was sent.` |
| provisioning gates per target | n/a | PASS | gates only from the file; `default`/file targets as designed |
| secrets in output/logs | n/a | PASS | grep of captured output for the AMI password: 0 matches |

## Cleanup (Rule 25)

`vfy-1001` deleted; `pjsip show endpoints` and `pjsip show aors` print `No objects found.`; trunk and extension lists empty; `core show channels concise` empty; UAs destroyed; no container or process of this wave left running (the one `dist/index.js` process is the owner's registered `pbx-lab` server). A call originated earlier in the baseline was left up on the PBX when sipclient's hangup sent no BYE (`sip_code 0`); it was hung up with `channel request hangup`.

## Owner decision (2026-10-03)

The owner accepted the BLOCKED rows as carry-forward CF-001 and will re-run them manually after changing the lab `manager.conf`.

## Owner action

The BLOCKED rows need one `manager.conf` change on the lab Asterisk: for the `mcp` user, `write = system,call,reporting,command,config,originate`, then `manager reload`. Then re-run channels, endpoints, hangup_preview, hangup and the Call-ID cross-check; or carry them forward.
