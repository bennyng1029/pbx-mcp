# Task 4 live probe — 2026-10-03

Lab Asterisk 192.168.10.244 (certified-22.8-cert4). A sipclient-mcp UA (`mcp-vfy-1001`) called `100@mcp-test` (Echo) with `Diversion: <sip:5551234@example.com>;reason=unconditional`; Asterisk accepted, channel `PJSIP/mcp-vfy-1001-00000002` Up. Raw AMI through `AmiClient` with the registered credentials.

| Probe | Result |
|---|---|
| `Getvar` `CHANNEL(pjsip,call-id)`, `PJSIP_HEADER(read,Diversion|From|To|Call-ID)`, `CALLERID(num)`, `CHANNEL(pjsip,remote_uri|local_uri)` | all `Response: Error / Permission denied` (the AMI user's write permission lacks `call` and `reporting`) |
| `core show channel <name>` | works (command perm) but has no SIP Call-ID: only `Call Identifier: [C-00000003]` (Asterisk's internal id), caller ID, DNID |
| `pjsip show channels` / `channelstats` | channel name and time only |
| `core show settings` | `Configuration file:`, `PBX UUID:` present, readable |
| sipclient `call_ladder` (json) | INVITE Call-ID `NObdaGcils@192.168.10.120` (what the tool must equal) |

Conclusion: neither Getvar (under this lab's AMI permissions) nor `core show channel` yields the SIP Call-ID. The code is written against `Getvar` (the only AMI route to the SIP Call-ID and headers); each cell renders `n/a` when Getvar is refused, so the tool stays correct under restricted permissions. The live success criterion (tool Call-ID equals the ladder Call-ID) needs the owner to grant the AMI user write `system,call,reporting`; recorded as an owner action, the same one that unblocks channels/endpoints/hangup. Not a design change, so not a stop. Dialplan: no pattern extension exists on the lab, so the `asterisk_dialplan` description claims nothing about pattern matching beyond what was observed (literal `dialplan show 100@mcp-test`).
