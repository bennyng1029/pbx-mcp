# pbx-mcp

[![pbx-mcp MCP server](https://glama.ai/mcp/servers/ictinnovations/pbx-mcp/badges/score.svg)](https://glama.ai/mcp/servers/ictinnovations/pbx-mcp)

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant inspect and control **Asterisk** and **FreeSWITCH**.

Ask "which extensions are offline right now?" or "why is my SIP trunk not registering?" and get a real answer from the live switch, not a guess.

Developed by **Tahir Almas** at [ICT Innovations](https://ictinnovations.com), the team behind [ICTCore](https://github.com/ictinnovations/ictcore), ICTContact, ICTDialer, ICTFax and ICTPBX. The AMI and ESL clients in this repo are the same protocol groundwork those products run on.

## Why

Debugging a PBX means memorising two very different command sets. Asterisk speaks AMI and a CLI with hundreds of verbs. FreeSWITCH speaks ESL with its own vocabulary. If you run both, you're context switching all day.

pbx-mcp puts a single, well described tool surface in front of both, so your assistant can go from "calls are failing" to `sofia status gateway` without you spelling out each step.

**New here?** The [User Guide](docs/USER-GUIDE.md) walks through PBX setup, client config, worked examples and troubleshooting. This README is the quick reference.

## Install

```bash
npm install -g pbx-mcp
```

Or run it straight from npx, which is what most MCP client configs do:

```bash
npx -y pbx-mcp
```

You need Node 18 or newer.

## Docker

There's a prebuilt image if you'd rather not put Node on the machine that talks to your PBX.

```bash
docker run -i --rm \
  -e ASTERISK_AMI_HOST=10.0.0.10 \
  -e ASTERISK_AMI_USERNAME=mcp \
  -e ASTERISK_AMI_PASSWORD=change-me \
  ghcr.io/ictinnovations/pbx-mcp
```

The same image is on Docker Hub as [`ictinnovations/pbx-mcp`](https://hub.docker.com/r/ictinnovations/pbx-mcp) if that registry is an easier pull for you.

Three things to know:

- `-i` is not optional. The server speaks MCP over stdio, so without stdin attached the container starts and then sits there saying nothing, which looks exactly like a broken server.
- There is no port to publish. Nothing listens.
- Your PBX has to be reachable from inside the container. If Asterisk runs on the Docker host itself, swap the IP above for `host.docker.internal` on Mac and Windows, or add `--network host` on Linux.

The image runs as a non-root user and, like every other way of running this, starts read only.

## Configure

Everything comes from environment variables. Set the Asterisk block, the FreeSWITCH block, or both. The server only registers tools for what you've actually configured, so an Asterisk-only shop never sees a FreeSWITCH tool.

### Asterisk

| Variable | Default | Notes |
|---|---|---|
| `ASTERISK_AMI_HOST` | *(required to enable)* | Hostname or IP of the Asterisk box |
| `ASTERISK_AMI_PORT` | `5038` | AMI port from `manager.conf` |
| `ASTERISK_AMI_USERNAME` | | AMI user |
| `ASTERISK_AMI_PASSWORD` | | AMI secret |
| `ASTERISK_AMI_TLS` | `false` | Set `true` if `tlsenable=yes` |

Your `manager.conf` user needs at least `read = system,call,command` and `write = command`. Add `originate` only if you plan to turn on write mode.

```ini
[mcp]
secret = change-me
read = system,call,command
write = command
```

### FreeSWITCH

| Variable | Default | Notes |
|---|---|---|
| `FREESWITCH_ESL_HOST` | *(required to enable)* | Hostname or IP of the switch |
| `FREESWITCH_ESL_PORT` | `8021` | Inbound ESL port |
| `FREESWITCH_ESL_PASSWORD` | `ClueCon` | From `event_socket.conf.xml` |

### Shared

| Variable | Default | Notes |
|---|---|---|
| `PBX_MCP_ALLOW_WRITE` | `false` | Unlocks call control. Read the safety section first |
| `PBX_MCP_TIMEOUT_MS` | `10000` | Per command timeout |

## Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pbx": {
      "command": "npx",
      "args": ["-y", "pbx-mcp"],
      "env": {
        "ASTERISK_AMI_HOST": "10.0.0.10",
        "ASTERISK_AMI_USERNAME": "mcp",
        "ASTERISK_AMI_PASSWORD": "change-me",
        "FREESWITCH_ESL_HOST": "10.0.0.11",
        "FREESWITCH_ESL_PASSWORD": "ClueCon"
      }
    }
  }
}
```

The same shape works for any MCP client that speaks stdio. There's a copy in [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json).

To run the container instead of npx, keep the `env` block and point `command` at Docker:

```json
{
  "mcpServers": {
    "pbx": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "ASTERISK_AMI_HOST",
        "-e", "ASTERISK_AMI_USERNAME",
        "-e", "ASTERISK_AMI_PASSWORD",
        "ghcr.io/ictinnovations/pbx-mcp"
      ],
      "env": {
        "ASTERISK_AMI_HOST": "10.0.0.10",
        "ASTERISK_AMI_USERNAME": "mcp",
        "ASTERISK_AMI_PASSWORD": "change-me"
      }
    }
  }
}
```

Each `-e NAME` with no value forwards that variable from `env` into the container, which keeps the secrets out of the argument list.

## Tools

### Asterisk

| Tool | What it does |
|---|---|
| `asterisk_status` | Version, uptime, active calls and calls processed |
| `asterisk_channels` | Every live channel with caller ID, state, bridge, duration and dialplan position. Optional substring filter |
| `asterisk_endpoints` | PJSIP endpoints with device state and contact count. Falls back to `chan_sip` peers on older installs |
| `asterisk_dialplan` | Dumps a context, or one extension inside a context |
| `asterisk_cli` | Any CLI command, subject to the safety policy below |
| `asterisk_originate` | Places a call. Write mode only |
| `asterisk_hangup` | Kills a channel by name. Write mode only |

### FreeSWITCH

| Tool | What it does |
|---|---|
| `freeswitch_status` | Version, uptime, current and maximum sessions |
| `freeswitch_channels` | Every live call leg from `show channels`. Optional substring filter that keeps the header row |
| `freeswitch_registrations` | Registered users on a Sofia profile, with contact URI, user agent and expiry |
| `freeswitch_sofia_status` | Every SIP profile and gateway, including whether trunks are registered upstream |
| `freeswitch_api` | Any API command, subject to the safety policy below |
| `freeswitch_originate` | Places a call. Write mode only |
| `freeswitch_hangup` | `uuid_kill` on a channel UUID. Write mode only |

## Safety

A PBX is not a scratch pad. Reloading a profile drops registrations, and an originate spends real money on a live trunk. So the default posture is read-only and the guards are layered:

**Read-only by default.** `asterisk_cli` accepts an allow list of inspection prefixes (`core show`, `pjsip show`, `dialplan show`, `queue show` and friends). `freeswitch_api` accepts an allow list of inspection verbs (`status`, `show`, `sofia`, `version` and friends).

**Word level scanning on FreeSWITCH.** `sofia` is allow listed, but `sofia profile internal restart` is not a read. Every word in the command is checked against a list of state changing verbs, so the destructive tail gets caught even when the leading verb looks harmless.

**Write tools aren't registered at all in read-only mode.** `asterisk_originate` and the other three never appear in `tools/list` unless you set `PBX_MCP_ALLOW_WRITE=true`. A model can't call a tool it can't see.

**Shell metacharacters are rejected** on both transports before a command is sent.

**AMI header injection is blocked.** Every field that lands in an AMI action is checked for carriage returns and newlines, so a caller ID string can't smuggle in an extra header.

**Output is clamped** to 20,000 characters. One `show channels` on a busy switch won't flood the context window.

Even with all that, give the AMI user the narrowest permission set that answers your questions, and put the PBX behind a firewall rather than on the public internet.

## Build from source

```bash
git clone https://github.com/ictinnovations/pbx-mcp.git
cd pbx-mcp
npm install
npm run build
npm start
```

The AMI and ESL clients have no third party dependencies. Both protocols are just framed text over TCP, and hand rolling them keeps the install small and the behaviour predictable. The only runtime dependencies are the MCP SDK and Zod.

## The protocol clients, on their own

If you want to talk to a PBX from your own Node code and don't need MCP at all, the two clients underneath this server are published separately. Same protocol work, no MCP SDK, no Zod, nothing:

- **[asterisk-ami-node](https://github.com/ictinnovations/asterisk-ami-node)** - Asterisk Manager Interface client. `npm install asterisk-ami-node`
- **[freeswitch-esl-node](https://github.com/ictinnovations/freeswitch-esl-node)** - FreeSWITCH Event Socket client, inbound mode. `npm install freeswitch-esl-node`

Both are zero dependency, TypeScript, ESM and CommonJS, Node 18 or newer, and tested against mock switches so you can run the suite without a PBX.

## Layout

```
src/
  index.ts          entry point, config to transport wiring
  ami.ts            Asterisk Manager Interface client
  esl.ts            FreeSWITCH Event Socket Layer client
  config.ts         environment config and the command safety policy
  tools/
    asterisk.ts     Asterisk tool definitions
    freeswitch.ts   FreeSWITCH tool definitions
    format.ts       text table and truncation helpers
```

## Contributing

Issues and pull requests are welcome. If you're adding a tool, describe it the way you'd describe it to a colleague who has never seen your dialplan. The model picks tools from those descriptions, so a vague one is a broken one.

## About

Built and maintained by **Tahir Almas**, founder of [ICT Innovations](https://ictinnovations.com).

ICT Innovations has shipped open source and commercial telephony since 2005. If pbx-mcp is useful to you, the wider stack behind it might be too:

- **[ICTCore](https://github.com/ictinnovations/ictcore)** - open source telephony framework, the base for the products below
- **[ICTPBX](https://ictpbx.com)** - white label multi tenant IP PBX, with a free community edition on GitHub
- **[ICTContact](https://ictcontact.com)** - contact center and unified communications
- **[ICTDialer](https://ictdialer.com)** - auto and predictive dialer
- **[ICTFax](https://ictfax.org)** - open source fax server
- **[asterisk-ami-node](https://github.com/ictinnovations/asterisk-ami-node)** and **[freeswitch-esl-node](https://github.com/ictinnovations/freeswitch-esl-node)** - the protocol clients from this repo, published on their own

Questions about the commercial products go through [the ICT Innovations support portal](https://service.ictinnovations.com/contact.php). Questions about pbx-mcp itself belong in GitHub issues, where everyone can read the answer.

## License

MIT. See [LICENSE](LICENSE).
