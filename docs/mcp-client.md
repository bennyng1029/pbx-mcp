# Connecting your MCP client

## Claude Desktop

Find your config file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

Add a `pbx` entry. If the file is empty or doesn't exist, this whole block is
the file:

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

Only running one of the two? Delete the other pair of lines. pbx-mcp registers
tools for what you configured, so an Asterisk-only setup never shows FreeSWITCH
tools and the assistant won't try to use them.

**Restart Claude Desktop completely.** Closing the window isn't enough on
Windows; quit it from the system tray. On macOS use Cmd+Q.

You'll know it worked when the tools appear in the client's tool list.

## Other clients

Any MCP client that launches a stdio server works. The command is
`npx -y pbx-mcp` and the configuration is entirely environment variables.
There's a reference config at
[`examples/claude_desktop_config.json`](https://github.com/ictinnovations/pbx-mcp/blob/main/examples/claude_desktop_config.json).

## Running it by hand

Useful for checking your settings before you wire up a client:

```bash
export ASTERISK_AMI_HOST=192.168.1.10
export ASTERISK_AMI_USERNAME=mcp
export ASTERISK_AMI_PASSWORD=pick-something-long
npx -y pbx-mcp
```

It prints a one-line ready message to stderr and then waits for JSON-RPC on
stdin. That's correct behaviour, not a hang. Ctrl+C to quit.
