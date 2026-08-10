# Before you start

You need three things:

**Node.js 18 or newer.** Check with `node --version`. If that errors or shows
something older, grab a current release from [nodejs.org](https://nodejs.org).

**An MCP client.** Claude Desktop is the common one. Anything that speaks MCP
over stdio works.

**Network access from the machine running the client to the PBX.** This trips
people up more than anything else. pbx-mcp runs on your laptop, not on the PBX.
So your laptop needs to reach port 5038 (Asterisk) or 8021 (FreeSWITCH) on the
phone system. On most installs those ports are bound to localhost only, so
you'll need either a VPN, an SSH tunnel, or a config change on the PBX. See
[Troubleshooting](troubleshooting.md).

You do not need to install anything on the PBX itself.
