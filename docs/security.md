# Security notes

**Don't put AMI or ESL on the public internet.** These are administrative
interfaces with, in AMI's case, plaintext auth by default. Anything that can
reach the port can try passwords against it all day. Use a VPN or an SSH
tunnel.

**Change the FreeSWITCH ESL password.** `ClueCon` is the documented default and
it's in every scanner's list.

**Give the AMI user the narrowest permissions that answer your questions.** The
set in [Setting up Asterisk](asterisk.md) is enough for every read-only tool
here.

**Credentials in the MCP client config are stored in plain text** on your
machine. That's how MCP clients work today. Treat that file the way you'd treat
a `.pem`, and don't commit it.

**Read-only is a guard rail, not a sandbox.** The allow lists block state
changes, but a read-only tool can still show you call records, caller IDs and
dialplan logic. If that's sensitive in your environment, the access itself is
what needs controlling, not just the write flag.

**Enable TLS if your Asterisk supports it.** Set `tlsenable=yes` in
`manager.conf` and `ASTERISK_AMI_TLS=true` in your config. Note that pbx-mcp
doesn't verify the certificate chain, which protects against passive sniffing
but not an active attacker on the path. Inside a VPN that's a reasonable trade;
across the internet it isn't enough on its own.
