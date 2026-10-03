# Setting up Asterisk

## Create an AMI user

Open `/etc/asterisk/manager.conf` on the Asterisk box. Make sure the general
section has the interface enabled:

```ini
[general]
enabled = yes
port = 5038
bindaddr = 0.0.0.0
```

`bindaddr = 0.0.0.0` listens on every interface. If your PBX is exposed to the
internet, use the specific internal IP instead, or leave it on `127.0.0.1` and
use an SSH tunnel.

Then add a user. Give it the least it needs:

```ini
[mcp]
secret = pick-something-long
deny = 0.0.0.0/0.0.0.0
permit = 192.168.1.0/255.255.255.0
read = system,call,reporting,command,config
write = system,call,reporting,command,config,originate
```

Change the `permit` line to the subnet your laptop is on. The `deny` line
first, then `permit`, means "block everything except this."

The permissions break down like this:

| Permission | Why it's needed |
|---|---|
| `read = system` | Server status, uptime, version |
| `read = call` | Live channel listings |
| `read = command` | Reading CLI output |
| `write = command` | Sending CLI commands at all |
| `write = system,reporting` | Channel and endpoint listings (`CoreShowChannels`, `PJSIPShowEndpoints`) |
| `write = call` | Hangup, and the Call-ID/From/To/Diversion columns of `asterisk_channels` (`Getvar`) |
| `write = originate` | Call control (`asterisk_originate`) |
| `write = config` | Trunk and extension provisioning (`UpdateConfig`) |

Asterisk checks an action against the user's `write` list, so the listing tools
need those classes in `write` even though they only read. Without them the tool
reports `Permission denied`.

Reload and confirm:

```bash
asterisk -rx "manager reload"
asterisk -rx "manager show users"
```

## Test the connection from your machine

```bash
telnet your-pbx-ip 5038
```

You should see `Asterisk Call Manager/8.0.0` or similar. If you see nothing,
the port is closed or blocked, and no amount of config on your laptop will fix
that. Press Ctrl+] then type `quit` to exit.

## More than one Asterisk

To drive several lab boxes from one server, list them in a JSON file and set
`PBX_MCP_TARGETS_FILE`; see the README ("Several Asterisk servers") and
`examples/targets.example.json`. Each box needs its own AMI user as above.

## Observing asterisk-dev calls

The observation tools use a configured named target (including the environment-backed
`default`); an ad hoc address returns `named_target_required`. The ordinary AMI client
keeps events off. A separate registry-owned observer explicitly enables events and
merges a bounded live-channel bootstrap before publishing `observationReady` and
`observationSince`. AMI access must permit Events, CoreShowChannels and Getvar;
fixture evidence also uses Command and, only for configured registration expectations,
PJSIPShowRegistrationsOutbound. Missing permissions produce unavailable evidence.
These observational tools are available without enabling write or provisioning gates.

Configure the named `asterisk-dev` target with AMI host `192.168.10.244`, port `5038`
and the existing credential mechanism, then set
`PBX_MCP_FIXTURE_EXPECTATIONS_FILE` to the absolute path of
`examples/asterisk-dev-expectations.json`. Select that target with the existing target
selection tool. The expectation file contains no credentials. It is strict JSON
`{"targets":{"configured-name":{...}}}`; unsupported fields, unknown names, unreadable
files and invalid values fail startup. Supported expectation fields are `version`,
`pbxUuid`, `dialplan` (`context`, `extension`), `udpTransport` (`bind`, `port`),
`noActiveChannels` and `registrations` (unique exact outbound registration object names,
maximum 128). Every configured expectation is required. The example requires version
`certified-22.8-cert4`, extension `100` in `mcp-test`, UDP `0.0.0.0:6060` and zero active
channels; it invents no UUID, endpoints or registrations.

Follow this sequence:

1. Call `asterisk_fixture_check` with `{}`. Require `status: "PASS"` and
   `observationReady: true`; retain its `observationSince` and `generation`.
2. Establish a separately authorized valid PJSIP ingress endpoint mapped to
   `mcp-test`. The recorded lab state has zero PJSIP endpoints, so live ingress
   acceptance remains blocked by this prerequisite. Existing provisioning is a
   separately authorized option; fixture checks do not configure the PBX.
3. Once ingress and call execution are separately authorized, launch one bounded
   external SIP test to UDP `192.168.10.244:6060`, extension `100`. Retain the actual
   complete SIP Call-ID. No call generation or remote configuration was performed
   by this implementation wave.
4. Call `asterisk_wait_call` with
   `{"callId":"actual-full-call-id","since":"retained-observationSince","timeoutSeconds":60}`.
   Replace both placeholder values with the actual evidence. If the full Call-ID
   is unavailable, `{"did":"100","context":"mcp-test","since":"retained-observationSince"}`
   is an alternative for an otherwise exclusive fixture; ambiguity stays explicit.
5. Inspect the structured result and `asterisk_recent_calls`, for example
   `{"callId":"actual-full-call-id","since":"retained-observationSince","limit":10}`.

Observation is armed before the external test, so even a fast call may be recovered
from retained terminal legs using `since`. A sequential MCP client can run the external
test between fixture_check and wait_call. Wait requires exactly one `callId` or `did`;
recent allows at most one, and `context` requires `did`. Matching is exact and
case-sensitive. Call-ID is limited to 4096 UTF-8 bytes, selectors reject CR/LF,
and `since` must be a valid nonfuture ISO UTC timestamp. Wait timeout is an integer
1–300 seconds (default 60); recent limit is an integer 1–100 (default 10).

New tools publish schemaVersion 1 structured evidence with selected target identity,
`source: "observed_ami"`, `unit: "channel_leg"` and coverage. `completed` proves the
observed channel leg's Hangup, rather than a complete multi-leg call. Other wait
outcomes are `timed_out_no_match`, `timed_out_active`, `ambiguous_match` and
`observation_gap`. Inspect nullable identity/metadata fields, availability/reasons,
continuity, correlation coverage, retention and gaps. Empty recent results describe
retained observation; they do not establish that no earlier calls happened. Each
observer retains at most 128 live legs and 256 terminal records with 16 concurrent
waiters. Process restart, gaps and eviction can remove coverage; the coverage horizon
states the conservative usable range. Displayed channel-table truncation is separate
from the new tools' exact full Call-ID matching.

Fixture checks share one total configured timeout for parallel evidence queries and
waiting for readiness. Caller timeout/cancellation does not cancel another caller's
shared observer startup. Exact parsed fields/rows establish version, optional UUID,
UDP bind/port, extension/context, activity and optional registrations. Unknown output
grammars, refusal, unsupported queries or timeout yield `UNKNOWN`; a required mismatch
wins as `FAIL`, even if the observer is ready. Absent expectations remain `UNKNOWN`.
The target identity check describes the configured name/address actually queried;
only an explicitly configured UUID supplies independent remote PBX identity evidence.
No-active-channels is a snapshot at the reported time and cannot guarantee later
exclusivity. A zero-endpoint fixture can PASS these observational expectations.

PASS never proves SIP ingress or external reachability. AMI Up/Hangup and Echo in the
dialplan never prove RTP or audible audio. Docker port mappings and RTP publication
remain unresolved; audio needs separate media evidence. Automated verification for
this wave uses local mocks, not live ingress or media acceptance.
