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

**Ad hoc targets send your default AMI credentials in plaintext** to any IP in
`PBX_MCP_HOST_ALLOW`. AMI is plaintext on 5038 and pbx-mcp does not verify TLS
certificates, so use ad hoc only on trusted lab networks and keep the CIDR list
as narrow as the labs you actually use. Ad hoc targets are always read-only,
and hostnames are not accepted (use a named target).

**Targets file.** Prefer `passwordEnv` to a literal password, and keep the file
`chmod 600` (pbx-mcp warns if a file with literal passwords is readable by
group or others, or if the file is writable by group/other). File targets default
to read-only (`readOnly: true`); explicit `readOnly: false` is required to allow
writes or provisioning on a named file target. The provisioning gates (`provision`,
`trunkAllow`, `contextAllow`, `pjsipFile`) can only come from the operator's file or
environment, never from a tool argument, and file targets start with
provisioning off.

**Name the environment before writing or provisioning.** Write tools (`asterisk_originate`,
`asterisk_hangup`, `asterisk_cli`) and provisioning mutators validate an explicit `target`
argument against the selected target (with strict schemas that reject unknown keys).
Confirm which environment is meant before approving a write; the `target` argument
and the `Target:` line in every result exist so a lab approval is not mistaken for a production one.

**Input sanitization and buffer caps.** Incoming AMI traffic is subject to a 1 MB buffer cap
to protect against memory exhaustion from uncooperative peers. SIP header fields retrieved
in `asterisk_channels` (Call-ID, From, To, Diversion) are capped to 128 characters and stripped
of newlines/control characters to mitigate prompt injection risks.
