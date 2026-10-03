#!/usr/bin/env node
/**
 * pbx-mcp: an MCP server for Asterisk and FreeSWITCH.
 *
 * Written by Tahir Almas at ICT Innovations (https://ictinnovations.com), the team
 * behind ICTCore, ICTContact, ICTDialer, ICTFax and ICTPBX. The AMI and ESL clients
 * here are the same protocol groundwork those products run on, packaged so an MCP
 * client can ask a PBX what it is doing.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AmiClient } from "./ami.js";
import { EslClient } from "./esl.js";
import { loadConfig } from "./config.js";
import { lazyClient } from "./lazy-client.js";
import { registerAsteriskTools } from "./tools/asterisk.js";
import { registerProvisioningTools } from "./tools/provision.js";
import { registerCallObservationTools } from "./tools/call-observation.js";
import { registerTargetTools } from "./tools/targets.js";
import { createRegistry } from "./targets.js";
import { registerFreeswitchTools } from "./tools/freeswitch.js";

const cfg = loadConfig();

let registry: ReturnType<typeof createRegistry> | undefined;
try {
  registry = createRegistry(cfg);
} catch (err) {
  console.error(`pbx-mcp: ${(err as Error).message}`);
  process.exit(1);
}

if (!registry.active && !cfg.freeswitch) {
  console.error(
    "pbx-mcp: no PBX configured.\n" +
      "Set ASTERISK_AMI_HOST (or PBX_MCP_TARGETS_FILE) for Asterisk, FREESWITCH_ESL_HOST for FreeSWITCH, or both.\n" +
      "See https://github.com/ictinnovations/pbx-mcp for the full variable list."
  );
  process.exit(1);
}

const server = new McpServer(
  { name: "pbx-mcp", version: "0.1.1" },
  {
    instructions:
      "Inspect and control Asterisk and FreeSWITCH telephony servers. " +
      "Start with asterisk_status or freeswitch_status to confirm the PBX is reachable, " +
      "then use the channel and endpoint tools to answer questions about live calls and " +
      "device registration. Tools are read-only unless PBX_MCP_ALLOW_WRITE=true. " +
      "By Tahir Almas, ICT Innovations (https://ictinnovations.com).",
  }
);

if (registry.active) {
  registerAsteriskTools(server, cfg, registry.getClient, () => registry.snapshot());
  registerCallObservationTools(server, cfg, () => registry.snapshot());
  if (cfg.allowProvision) registerProvisioningTools(server, cfg, registry.getClient, registry);
  if (cfg.targetsFile || cfg.hostAllow.length) registerTargetTools(server, registry);
}

const shutdownController = new AbortController();

if (cfg.freeswitch) {
  const esl = cfg.freeswitch;
  registerFreeswitchTools(
    server,
    cfg,
    lazyClient(
      () => new EslClient({ ...esl, timeoutMs: cfg.timeoutMs }),
      (c) => c.isConnected,
      shutdownController.signal
    )
  );
}

const transport = new StdioServerTransport();
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  registry.close();
  shutdownController.abort();
  await server.close();
};
server.server.onclose = () => { void shutdown(); };
// The stdio SDK does not forward input EOF to its onclose callback.
process.stdin.once("end", () => { void shutdown(); });
process.stdin.once("close", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
try { await server.connect(transport); }
catch (err) { await shutdown(); throw err; }

console.error(
  `pbx-mcp ready (${[registry.active && "Asterisk", cfg.freeswitch && "FreeSWITCH"].filter(Boolean).join(" + ")}, ` +
    `${cfg.allowWrite ? "write enabled" : "read-only"}). ICT Innovations, https://ictinnovations.com`
);
