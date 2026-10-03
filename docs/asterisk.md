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
