# Preflight (Rule 4 Cycle A) for multi-target.md

Run 2026-10-03 against branch feat/provisioning at 5a5b3e4. Fact-check only.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1a | `AmiClient.connect()` sets `connected = true` before Login finishes | VERIFIED | src/ami.ts:77 `this.connected = true;` precedes the `await this.action({Action:"Login"...})` at ami.ts:79. |
| 1b | `close()` calls `socket.destroy()` | VERIFIED | ami.ts:92-97. It also sets `waiters = []` (ami.ts:96). |
| 1c | `socket.destroy()` without an error emits no 'error' | VERIFIED | Ran a loopback node script that connects and then calls `destroy()`. Events seen: `close` only. ami.ts:68-70 has `'close'` set `connected=false` only. |
| 1d | A pending connect promise never settles after `close()` | VERIFIED, with a nuance | The TCP phase (ami.ts:46-70) rejects only through `onError` (error event) or the idle timer. `destroy()` emits no error and clears the idle timer, so the promise hangs forever. The Login phase is different: the outer promise has already resolved (the TCP connect callback is `resolve`). `close()` there clears `waiters`, but the `action()` timer (ami.ts:152-157) still rejects after `timeoutMs` with "timed out", so it does not hang forever. The plan's "close during connect rejects within timeoutMs" test is still the right test. The Task 1 hand-trace should say "forever" only for the TCP-connect window. |
| 1e | Hand-trace: B's `alive` check is false because `connected` is not yet set | PARTIAL | True only in the TCP-connect window (before ami.ts:77). After the TCP connect, `connected` is already true, so a second caller gets the un-logged-in client and sends actions before Login completes (the "unauthenticated action" defect that Task 1 tests separately). Both defects exist. The hand-trace describes one of them. |
| 2a | index.ts `lazyClient`: `alive = c.isConnected` | VERIFIED | src/index.ts:66-69 and 80-82. |
| 2b | A second concurrent caller during connect calls `client.close()` on the first client | VERIFIED | index.ts:51-53: `if (client && alive(client)) return client; client?.close(); client = create();`. In the TCP window `alive` is false, so the second caller closes the first. |
| 2c | `EslClient.connect()` resolves only when authenticated | VERIFIED | src/esl.ts:63-74: it awaits `auth/request`, writes `auth`, awaits the reply and throws unless `+OK`. Only then does it return. It also sets `connected=true` early (esl.ts:60), but that is not visible to a shared-promise holder. The "neutral for FreeSWITCH" claim holds. |
| 3a | `asterisk_channels` renders an Error reply as "No active channels" | VERIFIED | src/tools/asterisk.ts:60-68. `ami.action` returns the Error message without throwing (ami.ts:166-176). `listRows` yields `[]`, so it returns `"No active channels."`. |
| 3b | `asterisk_endpoints` has a bare catch around PJSIPShowEndpoints | VERIFIED | asterisk.ts:107-112 `try {...} catch { rows = []; }`. Note the catch fires only on a thrown timeout. An Error reply does not throw. It yields empty rows and falls through to SIPpeers (asterisk.ts:114-119). |
| 3c | `asterisk_hangup_preview` uses `listRows` on CoreShowChannels | VERIFIED | asterisk.ts:228. |
| 4a | mock-ami answers any action without requiring Login | VERIFIED | test/helpers/mock-ami.mjs:30-48. `respond(req)` is called for every request and nothing checks that Login came first. |
| 4b | Actions and CLI commands supported today | VERIFIED | Actions: `Login`, `GetConfig`, `UpdateConfig` (newcat, append, renamecat, delcat), `Command`. CLI: `module reload res_pjsip.so` and `pjsip show endpoint <name>`. Anything else returns `Response: Error` ("Invalid/unknown command: ..." for an Action, "No such command '...'" for a Command). `CoreShowChannels`, `PJSIPShowEndpoints`, `SIPpeers`, `Getvar`, `core show settings`, `core show uptime`/`version`/`calls` are all unsupported today, which agrees with the plan adding fixtures. `delayMs` (mock-ami.mjs:19) delays every reply, Login included, but it is global, not login-specific. |
| 5a | `Provisioner` constructor takes `(getClient, ProvisionOptions{file,trunkAllow,contextAllow})` | VERIFIED | src/provision.ts:63-67 and 266-269. |
| 5b | `registerProvisioningTools` builds ONE Provisioner from cfg at registration | VERIFIED | src/tools/provision.ts:28-33. |
| 5c | `PREFIX = 'mcp-'` | VERIFIED | provision.ts:20. |
| 5d | Config shape and `asterisk` optional | VERIFIED | src/config.ts:7-28 and 42-71. Fields: `asterisk?`, `freeswitch?`, `allowWrite`, `allowProvision`, `pjsipFile`, `trunkAllow`, `contextAllow`, `timeoutMs`. |
| 5e | index.ts exits when neither asterisk nor freeswitch is configured | VERIFIED | index.ts:22-29. The provisioning registration at index.ts:71 sits inside `if (cfg.asterisk)`, so Task 2 must also move or widen that guard for a targets-file-only setup. It is already implied by "accept targets without ASTERISK_AMI_HOST". |
| 6a | `zod` already a dependency | VERIFIED | package.json: `"zod": "^3.25.0"` under dependencies. No new dependency is needed. |
| 6b | `npm test` script text | VERIFIED | package.json: `"test": "npm run build && node --test test/*.test.mjs"`, `"build": "tsc"`. |
| 7 | `npm test` result and tree state | VERIFIED | tests 36, pass 34, fail 0, skipped 2 (the opt-in `provision.it.test.mjs` cases, gated by PBX_MCP_IT=1), duration about 9.7 s. `git status --short` afterwards shows only `?? docs/plans/` and `?? docs/superpowers/`. No tracked-file changes (`dist/` is gitignored). |
| 8 | Environment | VERIFIED | `command -v`: `/usr/local/bin/sipp`, `/usr/bin/tcpdump`, `/usr/bin/node`, `/usr/bin/nc`. `node --version` v22.23.2. `ls -l /usr/local/bin/sipp`: `-rwxr-xr-x 1 root root 1066744 Sep 20 20:53`. `curl http://127.0.0.1:8100/mcp` returned HTTP 401, so it is reachable and wants an auth token. Task 0/4/6 must use the token via the registered `sipclient-mcp` MCP server. `~/.claude/scripts/wave-verify.py` exists and supports `--baseline` (writes `DIR/.wave-baseline.json`). |
| 9 | Unauthenticated action gets `Response: Error` from the lab AMI | VERIFIED | Probe, no login, to 192.168.10.244:5038: banner `Asterisk Call Manager/11.0.0`, then `Response: Error` / `ActionID: pf1` / `Message: Permission denied`. The plan's "Error reply" claim is confirmed, and the Message is "Permission denied". The mock's `errorFor` / requireLogin reply could use that exact text. |
| 10 | Task ordering | VERIFIED | Task 2 uses Task 1's holder (`src/lazy-client.ts`) and Task 1 precedes it. Tasks 3 and 4 need Task 2's `src/targets.ts`. Task 5 follows 3 and 4. Task 6 needs Task 0's baseline and `.wave-baseline.json`. No task needs a later artifact. Parallel 3 and 4: file sets are disjoint (3: provision.ts files, targets.ts, provision/targets tests; 4: asterisk.ts, ami.ts, mock-ami.mjs, observability test). Minor: Task 4 reads label/host/dialplanHint from the registry but does not list `src/targets.ts` among its files. If it needs a new accessor it would collide with Task 3's edit of the same file. |
| 11 | Success criteria are runnable as written | see below | |

## Item 11, per-task criteria checkability

Runnable as written: Task 1 (named tests appear in TAP output of `npm test`; `node --test test/provision.test.mjs test/policy.test.mjs` runs), Task 3 test names, Task 4 test names, Task 5 (`grep -c`, `python3.13 -c json.load`, `npm test`), Task 6 `npm test` and `wave-verify.py`.

Issues:

1. Task 0 criterion text is garbled and partly impossible.
   - It names `pjsip show endpoints` twice.
   - "Expected output: No objects found" will not occur on a shared lab that has other endpoints, and the CLI cannot filter by `vfy-` (no grep in `asterisk_cli`). Suggested fix: "`pjsip show endpoints` output (read by the verifier) contains no line matching `vfy-`".
2. Naming mismatch for `vfy-` objects. The provisioner forces `PREFIX = "mcp-"` (provision.ts:114, 140, 293, 303, 374), so objects created by the tools are named `mcp-vfy-...` in the file and in `pjsip show endpoints`. `asterisk_trunk_list` strips the prefix (provision.ts:353) and shows `vfy-...`. A substring check for `vfy-` works, but an anchored `^vfy-` check or a cleanup keyed on "starts with vfy-" against CLI output will miss them. Suggested fix: state the raw object name as `mcp-vfy-*` for CLI and file checks, and `vfy-*` for tool listings.
3. Task 2 criterion `grep -rn "password" dist/tools/targets.js` "expected: no match on a return/format path" is not mechanically checkable (the file will contain `password` in the schema and descriptions, and the expected output is a judgement). The named test "tool output never contains the password" already covers it. Suggested fix: drop the grep, or replace it with a deterministic grep such as `grep -c "\.password" dist/tools/targets.js` prints 0.
4. Task 3 criterion `git diff test/provision.test.mjs shows additions only` works only while changes are uncommitted. After the task commit it prints nothing. Suggested fix: `git diff --numstat <base-sha> -- test/provision.test.mjs` reports 0 deletions.
5. Task 0 and 6 `.wave-baseline.json` is not gitignored (.gitignore lacks it). It will show as untracked in the repo. Decide whether to commit or ignore it. This is not a plan fact error.
6. Task 4 criterion (Call-ID from the tool equals the sipclient-mcp `call_ladder` Call-ID) is runnable. It depends on sipclient-mcp auth (HTTP 401 without token) and on the registered MCP server being connected.

## Counts

VERIFIED: 24 table rows (rows 1a, 1b, 1c, 1d, 2a, 2b, 2c, 3a, 3b, 3c, 4a, 4b, 5a, 5b, 5c, 5d, 5e, 6a, 6b, 7, 8, 9, 10, plus 1d with nuance). PARTIAL: 1 (1e hand-trace). MISMATCH: 0 hard mismatches. UNVERIFIABLE: 0. Item 11 flags 5 criterion/wording issues.

## Addendum (round 2 new claims, checked by planner 2026-10-03)

| Claim | Verdict | Evidence |
|---|---|---|
| `action()` detects list responses via the `EventList` header (`start`) and `...Complete` event | VERIFIED | src/ami.ts:154-158 |
| `asterisk_originate`/`asterisk_hangup` are registered only when `cfg.allowWrite`; `asterisk_cli` computes policy with `write` at call time | VERIFIED | src/tools/asterisk.ts (`const write = cfg.allowWrite`, `if (!write) return;`, `checkAsteriskCommand(command, write)`) |
| zod `.strict()`, `net.isIP`, `dns.promises.lookup` exist on node v22 / zod ^3.25 | VERIFIED | node -e probe printed `function function function` |
| `src/index.ts:64-72` is the `if (cfg.asterisk)` block containing the provisioning registration | VERIFIED | sed 62,72 |
| Lab answers unauthenticated action with `Response: Error` / `Permission denied` | VERIFIED | Cycle A probe |
