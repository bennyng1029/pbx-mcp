# Troubleshooting

## "No PBX configured"

pbx-mcp exited immediately because none of `ASTERISK_AMI_HOST`,
`PBX_MCP_TARGETS_FILE` (or `PBX_MCP_HOST_ALLOW`) and `FREESWITCH_ESL_HOST` was set.

If you set them in your MCP client config, the usual cause is that the client
wasn't fully restarted, or the JSON has a syntax error and the client silently
ignored the whole file. Paste the config into a JSON validator. A trailing
comma is the classic one.

## "AMI connect failed: ECONNREFUSED"

Nothing is listening on that host and port. Either Asterisk is down, or AMI is
disabled, or it's bound to `127.0.0.1` and you're connecting from elsewhere.

Check from the Asterisk box:

```bash
netstat -tlnp | grep 5038
```

`127.0.0.1:5038` means local only. Change `bindaddr` in `manager.conf`, or
tunnel:

```bash
ssh -L 5038:localhost:5038 user@your-pbx
```

Then point pbx-mcp at `127.0.0.1`.

## "AMI connect failed: ETIMEDOUT"

Packets are going nowhere. A firewall is dropping them, or the host is wrong,
or you're on a different network than you think. `ECONNREFUSED` means something
answered "no"; `ETIMEDOUT` means nothing answered at all.

## "AMI login rejected"

Wrong username or secret, or your IP isn't in the `permit` range. Check
`/var/log/asterisk/messages` on the PBX, which logs the actual reason. Also
worth checking: did you reload after editing `manager.conf`? Editing the file
changes nothing until you do.

## "ESL auth rejected"

Wrong ESL password. It's in `event_socket.conf.xml` on the FreeSWITCH box, not
in any of the SIP configs. If you never changed it, it's `ClueCon`, and you
should change it.

## "ESL connect failed"

Same shape as the Asterisk case. Check `listen-ip` in `event_socket.conf.xml`
and check `apply-inbound-acl` isn't blocking your IP. The ACL rejection can
look like a connection failure rather than an auth failure, which is confusing
the first time.

## "Refused. X is not on the read-only allow list"

Working as intended. The command changes state, and write mode is off. Set
`PBX_MCP_ALLOW_WRITE=true` if you meant it, after reading
[Turning on call control](call-control.md).

## "Command contains shell metacharacters"

Something in the command had `;`, `|`, `&`, a backtick, `$`, `>` or `<`. Those
are blocked on both transports. If a legitimate command needs one, that's a bug
worth reporting.

## The response got cut off

Output is clamped at 20,000 characters so one query can't flood the assistant's
context. On a busy switch, `show channels` will hit that. Use the filter
argument to narrow it.

## No endpoints found

Neither chan_pjsip nor chan_sip is loaded, or neither has anything configured.
Check with `module show like chan_` on the Asterisk CLI.

## Tools don't appear in the client

Almost always the config file. In order of likelihood: the client wasn't fully
quit and reopened, the JSON is malformed, or the file is in the wrong place.
Run pbx-mcp [by hand](mcp-client.md#running-it-by-hand) to confirm the server
itself starts, which splits the problem in half.

## The assistant picks the wrong tool

Be more specific about what you want to know rather than which command to run.
"Is 1001 registered" beats "check the endpoints" because it maps onto exactly
one tool.

## "no_target_selected"

More than one Asterisk target is configured (or only `PBX_MCP_HOST_ALLOW` is
set) and none has been chosen. Call `pbx_list_targets`, then `pbx_select_target`
with a `name`. Nothing was sent to any Asterisk.

## "Permission denied"

The AMI user's `write` list lacks a class the tool needs: `system,reporting`
for channels and endpoints, `call` for hangup and the Call-ID columns. Add them
in `manager.conf` and run `manager reload`. This is reported as an error on
purpose; earlier versions showed an empty list.

## "timed out" or "incomplete list"

An answer did not finish within `PBX_MCP_TIMEOUT_MS` (default 10000). The
connect, the login and each command each have this limit, so a dead or very
slow Asterisk returns an error rather than hanging. "Incomplete list" means the
list started but Asterisk never sent its end marker.

## "target ... is read-only" or "Provisioning is not enabled for target"

Ad hoc targets and targets marked `readOnly` refuse every write. A file target
has `provision: false` until its entry says otherwise, and the global
`PBX_MCP_TRUNK_ALLOW`/`PBX_MCP_CONTEXT_ALLOW` apply only to the `default` target.
