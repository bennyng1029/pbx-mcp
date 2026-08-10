# pbx-mcp

pbx-mcp is a small program that sits between your AI assistant and your phone
system. The assistant asks it questions in plain language, it translates them
into AMI or ESL commands, and it hands back the answer.

So instead of SSHing in and remembering whether it's `pjsip show endpoints` or
`sofia status profile internal reg`, you ask:

> Which extensions are registered right now?

and you get a table.

The point isn't saving keystrokes. It's that the assistant can chain steps. Ask
"why are outbound calls failing?" and it can check the switch is up, then check
the trunk registration, then look at recent channels, and tell you which of
those three is broken. You didn't have to know the order.

**What it is not.** This is not a monitoring system, it doesn't store history,
and it doesn't run in the background. It answers questions when asked and holds
no connection to your PBX in between.

## Install

You don't install anything on the PBX. pbx-mcp runs where your MCP client runs.

```bash
npx -y pbx-mcp
```

Point your client at it and set the connection details as environment
variables:

```json
{
  "mcpServers": {
    "pbx": {
      "command": "npx",
      "args": ["-y", "pbx-mcp"],
      "env": {
        "ASTERISK_AMI_HOST": "192.168.1.10",
        "ASTERISK_AMI_USERNAME": "mcp",
        "ASTERISK_AMI_PASSWORD": "pick-something-long"
      }
    }
  }
}
```

## Start here

Read these in order the first time.

1. [Before you start](before-you-start.md) is three prerequisites, and the
   third one catches most people out.
2. [Setting up Asterisk](asterisk.md) or [Setting up FreeSWITCH](freeswitch.md),
   depending on what you run. You can do both.
3. [Connecting your MCP client](mcp-client.md).
4. [Your first questions](first-questions.md).

Then keep [the tool reference](tools.md) and
[troubleshooting](troubleshooting.md) to hand.

!!! warning "It can look but not touch, by default"

    Call control is off until you set `PBX_MCP_ALLOW_WRITE=true`. That flag
    unlocks originate and hangup, and it drops the command allow lists. Read
    [Turning on call control](call-control.md) before you set it on anything
    that carries real calls.

## Getting help

**Bugs and feature requests:**
[github.com/ictinnovations/pbx-mcp/issues](https://github.com/ictinnovations/pbx-mcp/issues).
Include your Node version, which PBX and version, and the exact error. If it's
a connection problem, say whether `telnet host port` works, because that
answers half the question before anyone reads further.

**Contributions** are welcome. If you're adding a tool, write the description
for someone who has never seen your dialplan. The model chooses tools from
those descriptions, so a vague description is a broken tool.

**Commercial telephony products** from ICT Innovations, if the wider stack is
useful to you:

- [ICTCore](https://ictcore.readthedocs.io/) - open source telephony framework
- [ICTPBX](https://ictpbx.com) - white label multi tenant IP PBX, free community
  edition on GitHub
- [ICTContact](https://ictcontact.com) - contact center and unified
  communications
- [ICTDialer](https://ictdialer.com) - auto and predictive dialer
- [ICTFax](https://ictfax.readthedocs.io/) - open source fax server

Product questions go through the
[ICT Innovations support portal](https://service.ictinnovations.com/contact.php).
Questions about pbx-mcp itself belong in GitHub issues, where the next person
with the same problem can find the answer.
