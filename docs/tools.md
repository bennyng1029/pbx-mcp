# The tools, one by one

## Targets

**`pbx_list_targets`** - The configured Asterisk targets with address,
read-only and provisioning flags, and which one is selected. No credentials.

**`pbx_get_target`** - Which target the tools are talking to now, or
`no_target_selected`.

**`pbx_select_target`** - Choose the target: `name` for a named one, or `host`
(an IP literal inside `PBX_MCP_HOST_ALLOW`, optional `port` and `tls`) for an ad
hoc, read-only one. Give one or the other. Until a target is selected, every
Asterisk tool returns `no_target_selected` and sends nothing. Configuration:
`PBX_MCP_TARGETS_FILE`, `PBX_MCP_HOST_ALLOW`, `PBX_MCP_ADHOC_PORTS`; see the
README.

## Asterisk

**`asterisk_status`** - Version, uptime, active calls, calls processed. Run
this first when something looks wrong. If it fails, everything else will too,
and the error message tells you whether it's a network problem or a credentials
problem. With targets configured it also shows which one it asked: target name,
address, label, Asterisk's config file, PBX UUID and the target's dialplan hint.

**`asterisk_channels`** - Every live channel: caller ID, state, bridge,
duration, and where it sits in the dialplan. Takes an optional filter, which is
a plain substring matched against every field. Filter by `1001` to see one
extension's calls, or by a bridge ID to see both legs of one conversation.
Each channel also shows its SIP Call-ID and the From, To and Diversion header
values (`n/a` when Asterisk will not say, for example a non-PJSIP channel or an
AMI user without the `call` write class). Only the first 20 channels are looked
up, within one extra `PBX_MCP_TIMEOUT_MS`. An AMI error such as `Permission
denied` is reported as an error, never as "No active channels".

**`asterisk_endpoints`** - PJSIP endpoints with device state and contact count.
If chan_pjsip isn't loaded it falls back to `chan_sip` peers automatically and
tells you which one it used. An AMI error is reported as an error; "PJSIP is
loaded, 0 endpoints configured" means exactly that. That fallback matters on older installs where
nothing is on PJSIP yet.

**`asterisk_dialplan`** - Dumps a context, or one extension inside a context.
Good for "where would a call to 5551234 actually go" before you place it.

**`asterisk_cli`** - Any CLI command. In read-only mode it accepts an allow
list of inspection prefixes: `core show`, `pjsip show`, `dialplan show`,
`queue show`, `database show`, and about twenty more. Prefix matching means
`core show channels verbose` passes under `core show`.

**`asterisk_trunk_create`, `asterisk_trunk_delete`, `asterisk_extension_create`,
`asterisk_extension_delete`** *(provisioning)* - Take a `target` argument that
must equal the selected target (required when more than one target exists), so
the environment you confirmed is the one that is written. Results start with
`Target: <name> (<host>:<port>)`. See the README.

**`asterisk_originate`** *(write mode)* - Places a call from a channel to an
extension. Async, so it returns as soon as the switch accepts it rather than
waiting for an answer.

**`asterisk_hangup`** *(write mode)* - Drops a channel by exact name. Get the
name from `asterisk_channels` first; a guessed name either fails or hangs up
the wrong call.

## FreeSWITCH

**`freeswitch_status`** - Version, uptime, current and maximum sessions. Same
role as the Asterisk one: your first check.

**`freeswitch_channels`** - Every live call leg from `show channels`. The
optional filter keeps the header row, so the columns still line up after
filtering.

**`freeswitch_registrations`** - Registered users on a Sofia profile, with
contact URI, user agent and expiry. Defaults to the `internal` profile, which
is where your desk phones live on a stock install. The user agent column is
handy for spotting one misbehaving phone model.

**`freeswitch_sofia_status`** - Every SIP profile and gateway, including
whether trunks are registered upstream. This is where to look when the switch
is healthy but outbound calls fail. Pass a profile name for the detailed view.

**`freeswitch_api`** - Any API command. Read-only mode allows an inspection
verb list: `status`, `show`, `sofia`, `version`, `uptime` and others.

**`freeswitch_originate`** *(write mode)* - Places a call from a dial string.
Optional caller ID number gets set as a channel variable.

**`freeswitch_hangup`** *(write mode)* - `uuid_kill` on a channel UUID, with an
optional SIP cause. Get UUIDs from `freeswitch_channels`.
