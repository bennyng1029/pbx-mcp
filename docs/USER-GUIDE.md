# pbx-mcp User Guide

How to get an AI assistant talking to your Asterisk or FreeSWITCH box, and what to do when it doesn't work.

By Tahir Almas, [ICT Innovations](https://ictinnovations.com).

---

## Contents

1. [What this actually does](#1-what-this-actually-does)
2. [Before you start](#2-before-you-start)
3. [Setting up Asterisk](#3-setting-up-asterisk)
4. [Setting up FreeSWITCH](#4-setting-up-freeswitch)
5. [Connecting your MCP client](#5-connecting-your-mcp-client)
6. [Your first questions](#6-your-first-questions)
7. [Turning on call control](#7-turning-on-call-control)
8. [The tools, one by one](#8-the-tools-one-by-one)
9. [Troubleshooting](#9-troubleshooting)
10. [Security notes](#10-security-notes)
11. [Getting help](#11-getting-help)

---

## 1. What this actually does

pbx-mcp is a small program that sits between your AI assistant and your phone system. The assistant asks it questions in plain language, it translates them into AMI or ESL commands, and it hands back the answer.

So instead of SSHing in and remembering whether it's `pjsip show endpoints` or `sofia status profile internal reg`, you ask:

> Which extensions are registered right now?

and you get a table.

The point isn't saving keystrokes. It's that the assistant can chain steps. Ask "why are outbound calls failing?" and it can check the switch is up, then check the trunk registration, then look at recent channels, and tell you which of those three is broken. You didn't have to know the order.

**What it is not.** This is not a monitoring system, it doesn't store history, and it doesn't run in the background. It answers questions when asked and holds no connection to your PBX in between.

---

## 2. Before you start

You need three things:

**Node.js 18 or newer.** Check with `node --version`. If that errors or shows something older, grab a current release from [nodejs.org](https://nodejs.org).

**An MCP client.** Claude Desktop is the common one. Anything that speaks MCP over stdio works.

**Network access from the machine running the client to the PBX.** This trips people up more than anything else. pbx-mcp runs on your laptop, not on the PBX. So your laptop needs to reach port 5038 (Asterisk) or 8021 (FreeSWITCH) on the phone system. On most installs those ports are bound to localhost only, so you'll need either a VPN, an SSH tunnel, or a config change on the PBX. See [Troubleshooting](#9-troubleshooting).

You do not need to install anything on the PBX itself.

---

## 3. Setting up Asterisk

### Create an AMI user

Open `/etc/asterisk/manager.conf` on the Asterisk box. Make sure the general section has the interface enabled:

```ini
[general]
enabled = yes
port = 5038
bindaddr = 0.0.0.0
```

`bindaddr = 0.0.0.0` listens on every interface. If your PBX is exposed to the internet, use the specific internal IP instead, or leave it on `127.0.0.1` and use an SSH tunnel.

Then add a user. Give it the least it needs:

```ini
[mcp]
secret = pick-something-long
deny = 0.0.0.0/0.0.0.0
permit = 192.168.1.0/255.255.255.0
read = system,call,command
write = command
```

Change the `permit` line to the subnet your laptop is on. The `deny` line first, then `permit`, means "block everything except this."

The permissions break down like this:

| Permission | Why it's needed |
|---|---|
| `read = system` | Server status, uptime, version |
| `read = call` | Live channel listings |
| `read = command` | Reading CLI output |
| `write = command` | Sending CLI commands at all |

If you plan to turn on call control later, add `originate` to both the read and write lists. Don't add it yet.

Reload and confirm:

```bash
asterisk -rx "manager reload"
asterisk -rx "manager show users"
```

### Test the connection from your machine

```bash
telnet your-pbx-ip 5038
```

You should see `Asterisk Call Manager/8.0.0` or similar. If you see nothing, the port is closed or blocked, and no amount of config on your laptop will fix that. Press Ctrl+] then type `quit` to exit.

---

## 4. Setting up FreeSWITCH

### Enable the event socket

Open `/etc/freeswitch/autoload_configs/event_socket.conf.xml`:

```xml
<configuration name="event_socket.conf" description="Socket Client">
  <settings>
    <param name="listen-ip" value="0.0.0.0"/>
    <param name="listen-port" value="8021"/>
    <param name="password" value="pick-something-long"/>
    <param name="apply-inbound-acl" value="lan"/>
  </settings>
</configuration>
```

**Change the password.** The default is `ClueCon` and every scanner on the internet knows it.

The `apply-inbound-acl` line restricts which IPs can connect. The `lan` list is defined in `autoload_configs/acl.conf.xml`. Point it at your subnet.

Reload:

```bash
fs_cli -x "reload mod_event_socket"
```

### Test the connection

```bash
telnet your-fs-ip 8021
```

You should get `Content-Type: auth/request`. That means it's listening. Ctrl+] then `quit`.

---

## 5. Connecting your MCP client

### Claude Desktop

Find your config file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Add a `pbx` entry. If the file is empty or doesn't exist, this whole block is the file:

```json
{
  "mcpServers": {
    "pbx": {
      "command": "npx",
      "args": ["-y", "pbx-mcp"],
      "env": {
        "ASTERISK_AMI_HOST": "192.168.1.10",
        "ASTERISK_AMI_USERNAME": "mcp",
        "ASTERISK_AMI_PASSWORD": "pick-something-long",
        "FREESWITCH_ESL_HOST": "192.168.1.11",
        "FREESWITCH_ESL_PASSWORD": "pick-something-long"
      }
    }
  }
}
```

Only running one of the two? Delete the other pair of lines. pbx-mcp registers tools for what you configured, so an Asterisk-only setup never shows FreeSWITCH tools and the assistant won't try to use them.

**Restart Claude Desktop completely.** Closing the window isn't enough on Windows; quit it from the system tray. On macOS use Cmd+Q.

You'll know it worked when the tools appear in the client's tool list.

### Other clients

Any MCP client that launches a stdio server works. The command is `npx -y pbx-mcp` and the configuration is entirely environment variables. There's a reference config at [`examples/claude_desktop_config.json`](../examples/claude_desktop_config.json).

### Running it by hand

Useful for checking your settings before you wire up a client:

```bash
export ASTERISK_AMI_HOST=192.168.1.10
export ASTERISK_AMI_USERNAME=mcp
export ASTERISK_AMI_PASSWORD=pick-something-long
npx -y pbx-mcp
```

It prints a one-line ready message to stderr and then waits for JSON-RPC on stdin. That's correct behaviour, not a hang. Ctrl+C to quit.

---

## 6. Your first questions

Start here, because if this fails nothing else will work:

> Is my PBX up?

That runs `asterisk_status` or `freeswitch_status` and comes back with version and uptime.

Then try the everyday ones:

> What calls are live right now?

> Is extension 1001 registered?

> Which of my SIP trunks are down?

> Show me the dialplan for from-internal

> Any channels that have been up longer than an hour?

The assistant picks tools from their descriptions, so plain language works better than command names. Ask "which phones are offline" rather than "run pjsip show endpoints."

### Where it gets useful

Chained questions are the real win:

> Outbound calls to the UK are failing. Can you work out why?

A decent assistant will check the switch is alive, look at gateway registration, list recent channels to see how far calls get, and pull the dialplan for the route. Four commands across two syntaxes, one sentence from you.

---

## 7. Turning on call control

By default pbx-mcp can look but not touch. To let it place and drop calls, set:

```
PBX_MCP_ALLOW_WRITE=true
```

Read this before you do.

**What it unlocks.** Four tools appear: `asterisk_originate`, `asterisk_hangup`, `freeswitch_originate`, `freeswitch_hangup`. It also drops the allow lists on the CLI and API passthroughs, so the assistant can run anything, including `core restart now` and `reload`.

**What that means in practice.** An originate on a live trunk is a real call with a real bill. A hangup drops a real conversation. A reload drops every registration on the profile. There is no undo and no confirmation step inside pbx-mcp.

**When it's reasonable.** A lab box. A development switch. A production system where you're actively working and watching what happens.

**When it isn't.** Production with nobody watching. Any switch where a mistake costs money or interrupts customers.

If you turn it on, tighten the AMI user at the same time. Add `originate` to the permissions, but don't hand out a `read = all, write = all` account just because it's quicker.

A safer middle ground: keep two entries in your MCP client config, `pbx` read-only and `pbx-write` with write enabled, and only add the second when you actually need it.

---

## 8. The tools, one by one

### Asterisk

**`asterisk_status`** - Version, uptime, active calls, calls processed. Run this first when something looks wrong. If it fails, everything else will too, and the error message tells you whether it's a network problem or a credentials problem.

**`asterisk_channels`** - Every live channel: caller ID, state, bridge, duration, and where it sits in the dialplan. Takes an optional filter, which is a plain substring matched against every field. Filter by `1001` to see one extension's calls, or by a bridge ID to see both legs of one conversation.

**`asterisk_endpoints`** - PJSIP endpoints with device state and contact count. If chan_pjsip isn't loaded it falls back to `chan_sip` peers automatically and tells you which one it used. That fallback matters on older installs where nothing is on PJSIP yet.

**`asterisk_dialplan`** - Dumps a context, or one extension inside a context. Good for "where would a call to 5551234 actually go" before you place it.

**`asterisk_cli`** - Any CLI command. In read-only mode it accepts an allow list of inspection prefixes: `core show`, `pjsip show`, `dialplan show`, `queue show`, `database show`, and about twenty more. Prefix matching means `core show channels verbose` passes under `core show`.

**`asterisk_originate`** *(write mode)* - Places a call from a channel to an extension. Async, so it returns as soon as the switch accepts it rather than waiting for an answer.

**`asterisk_hangup`** *(write mode)* - Drops a channel by exact name. Get the name from `asterisk_channels` first; a guessed name either fails or hangs up the wrong call.

### FreeSWITCH

**`freeswitch_status`** - Version, uptime, current and maximum sessions. Same role as the Asterisk one: your first check.

**`freeswitch_channels`** - Every live call leg from `show channels`. The optional filter keeps the header row, so the columns still line up after filtering.

**`freeswitch_registrations`** - Registered users on a Sofia profile, with contact URI, user agent and expiry. Defaults to the `internal` profile, which is where your desk phones live on a stock install. The user agent column is handy for spotting one misbehaving phone model.

**`freeswitch_sofia_status`** - Every SIP profile and gateway, including whether trunks are registered upstream. This is where to look when the switch is healthy but outbound calls fail. Pass a profile name for the detailed view.

**`freeswitch_api`** - Any API command. Read-only mode allows an inspection verb list: `status`, `show`, `sofia`, `version`, `uptime` and others.

**`freeswitch_originate`** *(write mode)* - Places a call from a dial string. Optional caller ID number gets set as a channel variable.

**`freeswitch_hangup`** *(write mode)* - `uuid_kill` on a channel UUID, with an optional SIP cause. Get UUIDs from `freeswitch_channels`.

---

## 9. Troubleshooting

### "No PBX configured"

pbx-mcp exited immediately because neither `ASTERISK_AMI_HOST` nor `FREESWITCH_ESL_HOST` was set.

If you set them in your MCP client config, the usual cause is that the client wasn't fully restarted, or the JSON has a syntax error and the client silently ignored the whole file. Paste the config into a JSON validator. A trailing comma is the classic one.

### "AMI connect failed: ECONNREFUSED"

Nothing is listening on that host and port. Either Asterisk is down, or AMI is disabled, or it's bound to `127.0.0.1` and you're connecting from elsewhere.

Check from the Asterisk box:

```bash
netstat -tlnp | grep 5038
```

`127.0.0.1:5038` means local only. Change `bindaddr` in `manager.conf`, or tunnel:

```bash
ssh -L 5038:localhost:5038 user@your-pbx
```

Then point pbx-mcp at `127.0.0.1`.

### "AMI connect failed: ETIMEDOUT"

Packets are going nowhere. A firewall is dropping them, or the host is wrong, or you're on a different network than you think. `ECONNREFUSED` means something answered "no"; `ETIMEDOUT` means nothing answered at all.

### "AMI login rejected"

Wrong username or secret, or your IP isn't in the `permit` range. Check `/var/log/asterisk/messages` on the PBX, which logs the actual reason. Also worth checking: did you reload after editing `manager.conf`? Editing the file changes nothing until you do.

### "ESL auth rejected"

Wrong ESL password. It's in `event_socket.conf.xml` on the FreeSWITCH box, not in any of the SIP configs. If you never changed it, it's `ClueCon`, and you should change it.

### "ESL connect failed"

Same shape as the Asterisk case. Check `listen-ip` in `event_socket.conf.xml` and check `apply-inbound-acl` isn't blocking your IP. The ACL rejection can look like a connection failure rather than an auth failure, which is confusing the first time.

### "Refused. X is not on the read-only allow list"

Working as intended. The command changes state, and write mode is off. Set `PBX_MCP_ALLOW_WRITE=true` if you meant it, after reading [section 7](#7-turning-on-call-control).

### "Command contains shell metacharacters"

Something in the command had `;`, `|`, `&`, a backtick, `$`, `>` or `<`. Those are blocked on both transports. If a legitimate command needs one, that's a bug worth reporting.

### The response got cut off

Output is clamped at 20,000 characters so one query can't flood the assistant's context. On a busy switch, `show channels` will hit that. Use the filter argument to narrow it.

### No endpoints found

Neither chan_pjsip nor chan_sip is loaded, or neither has anything configured. Check with `module show like chan_` on the Asterisk CLI.

### Tools don't appear in the client

Almost always the config file. In order of likelihood: the client wasn't fully quit and reopened, the JSON is malformed, or the file is in the wrong place. Run pbx-mcp by hand ([section 5](#running-it-by-hand)) to confirm the server itself starts, which splits the problem in half.

### The assistant picks the wrong tool

Be more specific about what you want to know rather than which command to run. "Is 1001 registered" beats "check the endpoints" because it maps onto exactly one tool.

---

## 10. Security notes

**Don't put AMI or ESL on the public internet.** These are administrative interfaces with, in AMI's case, plaintext auth by default. Anything that can reach the port can try passwords against it all day. Use a VPN or an SSH tunnel.

**Change the FreeSWITCH ESL password.** `ClueCon` is the documented default and it's in every scanner's list.

**Give the AMI user the narrowest permissions that answer your questions.** The set in [section 3](#3-setting-up-asterisk) is enough for every read-only tool here.

**Credentials in the MCP client config are stored in plain text** on your machine. That's how MCP clients work today. Treat that file the way you'd treat a `.pem`, and don't commit it.

**Read-only is a guard rail, not a sandbox.** The allow lists block state changes, but a read-only tool can still show you call records, caller IDs and dialplan logic. If that's sensitive in your environment, the access itself is what needs controlling, not just the write flag.

**Enable TLS if your Asterisk supports it.** Set `tlsenable=yes` in `manager.conf` and `ASTERISK_AMI_TLS=true` in your config. Note that pbx-mcp doesn't verify the certificate chain, which protects against passive sniffing but not an active attacker on the path. Inside a VPN that's a reasonable trade; across the internet it isn't enough on its own.

---

## 11. Getting help

**Bugs and feature requests:** [github.com/ictinnovations/pbx-mcp/issues](https://github.com/ictinnovations/pbx-mcp/issues). Include your Node version, which PBX and version, and the exact error. If it's a connection problem, say whether `telnet host port` works, because that answers half the question before anyone reads further.

**Contributions** are welcome. If you're adding a tool, write the description for someone who has never seen your dialplan. The model chooses tools from those descriptions, so a vague description is a broken tool.

**Commercial telephony products** from ICT Innovations, if the wider stack is useful to you:

- [ICTCore](https://github.com/ictinnovations/ictcore) - open source telephony framework
- [ICTPBX](https://ictpbx.com) - white label multi tenant IP PBX, free community edition on GitHub
- [ICTContact](https://ictcontact.com) - contact center and unified communications
- [ICTDialer](https://ictdialer.com) - auto and predictive dialer
- [ICTFax](https://ictfax.org) - open source fax server

Product questions go through the [ICT Innovations support portal](https://service.ictinnovations.com/contact.php). Questions about pbx-mcp itself belong in GitHub issues, where the next person with the same problem can find the answer.
