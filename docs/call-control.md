# Turning on call control

By default pbx-mcp can look but not touch. To let it place and drop calls, set:

```
PBX_MCP_ALLOW_WRITE=true
```

Read this before you do.

**What it unlocks.** Four tools appear: `asterisk_originate`,
`asterisk_hangup`, `freeswitch_originate`, `freeswitch_hangup`. It also drops
the allow lists on the CLI and API passthroughs, so the assistant can run
anything, including `core restart now` and `reload`.

**What that means in practice.** An originate on a live trunk is a real call
with a real bill. A hangup drops a real conversation. A reload drops every
registration on the profile. There is no undo and no confirmation step inside
pbx-mcp.

**When it's reasonable.** A lab box. A development switch. A production system
where you're actively working and watching what happens.

**When it isn't.** Production with nobody watching. Any switch where a mistake
costs money or interrupts customers.

If you turn it on, tighten the AMI user at the same time. Add `originate` to
the permissions, but don't hand out a `read = all, write = all` account just
because it's quicker.

A safer middle ground: keep two entries in your MCP client config, `pbx`
read-only and `pbx-write` with write enabled, and only add the second when you
actually need it.
