# pbx-mcp: AMI reliability, session-selected targets, provisioning on, observability

Date: 2026-10-03. Status: draft for owner review. Source: manager review `/tmp/pbx-mcp-review-for-pbx-mcp-agent.md` (HEAD 5a5b3e4) plus owner decisions in session.

## Objective

Let one pbx-mcp server drive several lab Asterisk instances (different trunks, different boxes) with a target chosen at agent session start, with read tools that can be trusted, provisioning usable on the lab, and enough identity/call detail for a manager to correlate an answerer-side call with edge/SBC captures. Lab only; default stays read-only; writes need explicit flags.

## Understanding (owner-confirmed)

- Two target kinds. **Named**: pre-configured in an operator-owned JSON file (host, port, tls, username, password via `passwordEnv` or literal, label, safety gates). **Ad hoc**: agent supplies `host`/`port`; credentials are the server's default env credentials, never tool arguments; host must match `PBX_MCP_HOST_ALLOW`; read-only.
- Safety gates (`trunkAllow`, `contextAllow`, `pjsipFile`, `provision`) are operator-owned, per target, falling back to the global env values. The agent can never set or widen them.
- Hardening agreed after plan review (tightening only): per-target `readOnly`; effective write permission = `PBX_MCP_ALLOW_WRITE` AND the selected target permits writes, checked on one snapshot (covers originate, hangup, write CLI and the four provisioning mutators); one provisioner per named target; provisioning mutators take an explicit `target` argument equal to the selected target whenever more than one target exists; file targets default to provisioning off with empty allowlists (only the env-only `default` target uses global values); ad hoc hosts are IP literals inside `PBX_MCP_HOST_ALLOW` CIDRs on `PBX_MCP_ADHOC_PORTS` (default 5038), at most one live ad hoc client, hostnames only via named targets; a list that times out after `EventList: start` is an incomplete-list error; connect + login share one `timeoutMs`; strict tool-arg schemas; a file target named `default` is rejected. Limitation: AMI is plaintext and TLS verification stays disabled as today, so ad hoc credentials are for trusted lab networks only.
- Out of scope: FreeSWITCH, CDR/last-N-calls view (only `cdr-custom` file backend on the lab box, AMI cannot read it; unanswered calls not logged), any new third-party dependency.

## Verified facts (code and lab probe, 2026-10-03)

- `ami.ts:77` sets `connected = true` before Login completes; `index.ts:50` `lazyClient` treats it as alive.
- Hang cause (code-derived, to be reproduced in a test): a second caller during A's connect fails the `alive` check, calls `A.close()` (socket destroyed: emits `close`, not `error`, and cancels the socket timeout), so A's connect promise never settles.
- `asterisk_channels` renders an `Error` reply as "No active channels"; `asterisk_endpoints` swallows `PJSIPShowEndpoints` failure in a bare `catch`.
- Lab Asterisk `certified-22.8-cert4`: `core show settings` exposes config path and PBX UUID, "System name" empty; contexts `mcp-test` only; no endpoints; CDR backend `cdr-custom`.
- `asterisk_hangup` / `asterisk_hangup_preview` already exist (write behind `PBX_MCP_ALLOW_WRITE`).

## Design

### 1. Reliability (canonical module: `src/ami.ts` + client holder)
- One shared in-flight connect promise per target; concurrent callers await it.
- `connected = true` only after Login returns Success; a socket `close` or `error` during connect rejects the connect promise; connect + login together bounded by `timeoutMs`.
- List handlers (`CoreShowChannels`, `PJSIPShowEndpoints`, hangup preview) treat a first message of `Response: Error` as a tool error, never an empty list.
- Endpoints: distinguish module-not-loaded / query error / zero endpoints in output; chan_sip fallback only on a not-loaded response.
- Every tool call is bounded end to end and returns a clear error at the limit.

### 2. Targets
- New `src/targets.ts`: loads `PBX_MCP_TARGETS_FILE` (optional), validates, resolves `passwordEnv`, warns at startup if a literal-password file is group/world-readable. Env-only setup (`ASTERISK_AMI_*`) remains valid and is exposed as an implicit target named `default`.
- Tools: `pbx_list_targets` (names, label, host, provision flag; never secrets), `pbx_select_target {name | host,port,tls?}`, `pbx_get_target`.
- Until a target is selected every Asterisk tool returns `no_target_selected`; with exactly one configured target it is selected implicitly.
- Clients held in a map keyed by target; selection is per server process.
- Provisioning tools resolve gates from the selected target; ad hoc targets get none (provisioning refused).

### 3. Provisioning on (lab)
- Operator config: `PBX_MCP_ALLOW_PROVISION=true` globally enables registration; per target `provision` gates use. Docs updated for per-target setup (`manager.conf` write permission, `#include pjsip_mcp.conf`).
- Every provisioning result names the target. Rule 23: any provisioning write is confirmed by the user naming that environment before the call; lab approval does not carry to another target.
- Docs note: managed names are `mcp-` prefixed in `pjsip_mcp.conf`; repo-managed answerer config must not define the same names.

### 4. Observability
- `asterisk_status` adds: target name/label, host:port, config path and PBX UUID (from `core show settings`), optional `dialplanHint` from the target entry.
- `asterisk_channels` adds Call-ID, From/To, Diversion via per-channel `Getvar` (`CHANNEL(pjsip,call-id)`, `PJSIP_HEADER(read,Diversion)`); a failed Getvar renders `n/a`, never an error; at most 20 channels are enriched (truncation note) within one extra `timeoutMs` budget; fall back to `core show channel` if `Getvar` cannot return the Call-ID. Unprobed until a live call exists: the task begins with a live probe.
- `asterisk_dialplan` description notes pattern-aware DID lookup (`dialplan show <did>@<ctx>`); no code.

## Testing
Mock AMI (`test/helpers/mock-ami.mjs`, extended with login delay and error-reply modes): three parallel cold calls all return data; a delayed login never leaks an unauthenticated client; an Error reply never renders "No active…"; connect closed mid-flight rejects within the timeout; target loading (file, env, bad file, `passwordEnv` missing, permissions warning); selection and `no_target_selected`; ad hoc host allowlist; allowlist non-overridable by tool args; per-target provisioning gates. Existing 3 test files keep passing unchanged.

## Live verification (every Asterisk function, not only the new ones)

The upstream project is unfinished, so the wave verifies all shipped Asterisk tools against the real lab Asterisk, not just the mock. FreeSWITCH is excluded. Driver: **sipclient-mcp** (UAs, dial/answer/hangup, DTMF, ladder, pcap). Fallback only where sipclient-mcp cannot do it: **SIPp** (installed, v3.7.7) for custom headers (Diversion/History-Info), scripted UAS and load; raw TCP/AMI scripts for protocol faults; `tcpdump` (non-sudo, per ENVIRONMENT.md) where a claim concerns the wire (Rule 21: capture wins over any log).

Two passes: **Baseline** on current HEAD before any change (records which shipped functions already fail; becomes the Rule 13 Cycle 2 baseline), and **Final** after the last task (the same matrix, plus the new functions). Lab writes name the environment (Rule 23); every object created uses a `vfy-` prefix and is deleted at the end (Rule 25), with the managed file checked clean afterwards.

| Function | How verified | Pass condition |
|---|---|---|
| `asterisk_status` | call with no calls, then during a call | version/uptime correct; "1 active call" during the call |
| `asterisk_endpoints` | create extension; sipclient UA `register`s to it; unregister | registered contact count 1 then 0; zero-endpoints and module-unloaded cases distinct |
| `asterisk_extension_create/list/delete` | create `vfy-1001`; list; register with sipclient using the returned credentials; delete | list shows it, never a password; register succeeds; gone after delete; managed file clean |
| `asterisk_trunk_create/list/delete` | create `vfy-trunk` toward the workstation; sipclient UA in `direct` mode as the carrier; originate through it | carrier UA sees the INVITE (ladder + pcap); list/delete correct; allowlist refusals for a host/context outside the allow lists |
| `asterisk_channels` | sipclient UA A calls UA B through Asterisk (`mcp-test` context) | channel rows appear with state/bridge; Call-ID equals the Call-ID in sipclient `call_ladder` and the pcap; after hangup "No active channels" |
| `asterisk_dialplan` | `dialplan show 100@mcp-test`; pattern DID; invalid chars refused | matched extension/app returned; bad input refused without an AMI call |
| `asterisk_cli` | allowed read commands; a write command in read-only mode; metacharacters | read ok; refused with the reason; refused |
| `asterisk_hangup_preview` / `asterisk_hangup` | during a sipclient call: preview, then hangup (write flag on) | preview exact/partial match correct and read-only; hangup ends both legs (BYE on pcap); a hangup in read-only mode is not registered |
| `asterisk_originate` | originate to a registered sipclient UA | UA rings and answers; call visible in channels; clean teardown |
| Diversion / From / To in channels | SIPp INVITE carrying Diversion and History-Info (sipclient cannot set arbitrary headers) | headers shown; absent headers render `n/a` |
| Reliability | fresh server process, three parallel cold calls; Asterisk reachable; then Asterisk port blocked/unreachable | all three return correct data; unreachable returns a bounded timeout error, never a hang and never an empty list |
| Targets | list, select named, select ad hoc in/out of `PBX_MCP_HOST_ALLOW`, call before selecting, switch back | per the design; secrets never in output or logs (grep the log) |
| Provisioning gates | tool args try to widen allowlist/file; ad hoc target tries provisioning | refused; non-`mcp-` objects untouched |

Evidence for each row is kept as text in the verification report (commands, tool output, ladder excerpts, capture summaries). Pcaps are extracted from, then deleted.

## Constraints
Lab only; no AMI credentials in logs or tool output; compact plain-text output; no new dependencies; existing single-target env setups behave identically.

## Decisions recorded (Rule 26)
Asterisk only; JSON file optional; selection in process memory; ad hoc read-only. Reverse by follow-up change; none is irreversible.
