/**
 * FreeSWITCH tools exposed over MCP.
 *
 * Part of pbx-mcp by Tahir Almas, ICT Innovations (https://ictinnovations.com).
 * Built on the same ESL groundwork behind ICTFax, ICTPBX and ICTCore.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EslClient } from "../esl.js";
import { checkFreeswitchCommand, type Config } from "../config.js";
import { clamp, text, toolError } from "./format.js";

export function registerFreeswitchTools(server: McpServer, cfg: Config, getClient: () => Promise<EslClient>) {
  const write = cfg.allowWrite;

  server.registerTool(
    "freeswitch_status",
    {
      title: "FreeSWITCH status",
      description:
        "Core status of the FreeSWITCH server: version, uptime, current and maximum sessions. " +
        "Use this first to confirm the switch is reachable before running other FreeSWITCH tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const esl = await getClient();
        return text(clamp(await esl.api("status")) || "No output from FreeSWITCH.");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "freeswitch_channels",
    {
      title: "List active FreeSWITCH channels",
      description:
        "Every call leg currently up on the switch, as returned by 'show channels'. " +
        "This is the tool for 'what calls are live right now' on FreeSWITCH.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe("Case-insensitive substring to match against the row, for example a number or a UUID."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filter }) => {
      try {
        const esl = await getClient();
        const out = await esl.api("show channels");
        if (!filter) return text(clamp(out) || "No active channels.");

        const needle = filter.toLowerCase();
        const lines = out.split("\n");
        // Keep the header row so the columns still make sense after filtering.
        const kept = [lines[0], ...lines.slice(1).filter((l) => l.toLowerCase().includes(needle))];
        return text(clamp(kept.join("\n")) || `No channels match "${filter}".`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "freeswitch_registrations",
    {
      title: "List SIP registrations",
      description:
        "Registered SIP users on a Sofia profile, with contact URI, user agent and expiry. " +
        "Use this to answer 'is this extension registered' or 'which devices dropped off'.",
      inputSchema: {
        profile: z.string().default("internal").describe("Sofia profile name, usually 'internal' or 'external'."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ profile }) => {
      try {
        if (!/^[\w.\-]+$/.test(profile)) return text("Profile name may only contain letters, digits, dot, dash and underscore.");
        const esl = await getClient();
        const out = await esl.api(`sofia status profile ${profile} reg`);
        return text(clamp(out) || `No registrations on profile "${profile}".`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "freeswitch_sofia_status",
    {
      title: "Sofia SIP profile and gateway status",
      description:
        "State of every Sofia SIP profile and gateway, including whether trunks are registered upstream. " +
        "This is where to look when outbound calls fail but the switch itself is healthy.",
      inputSchema: {
        profile: z.string().optional().describe("Optional profile name for a detailed view instead of the summary."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ profile }) => {
      try {
        if (profile && !/^[\w.\-]+$/.test(profile)) return text("Profile name may only contain letters, digits, dot, dash and underscore.");
        const esl = await getClient();
        const out = await esl.api(profile ? `sofia status profile ${profile}` : "sofia status");
        return text(clamp(out) || "No Sofia output.");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "freeswitch_api",
    {
      title: "Run a FreeSWITCH API command",
      description:
        "Run a command through the FreeSWITCH event socket and return its raw output. " +
        "In the default read-only mode only inspection commands such as 'status', 'show' and " +
        "'sofia status' are permitted. Set PBX_MCP_ALLOW_WRITE=true to lift that restriction.",
      inputSchema: {
        command: z.string().describe("The API command, for example 'show calls' or 'sofia status gateway mytrunk'."),
      },
      annotations: { readOnlyHint: !write, destructiveHint: write, openWorldHint: true },
    },
    async ({ command }) => {
      try {
        const policy = checkFreeswitchCommand(command, write);
        if (!policy.allowed) return text(`Refused. ${policy.reason}`, true);

        const esl = await getClient();
        const out = await esl.api(command);
        return text(clamp(out) || "(command produced no output)");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  if (!write) return;

  server.registerTool(
    "freeswitch_originate",
    {
      title: "Place a call",
      description:
        "Originate a call from a dial string to an extension. This places a real call and costs " +
        "real money on a live trunk. Only available when PBX_MCP_ALLOW_WRITE=true.",
      inputSchema: {
        dialString: z.string().describe("Endpoint dial string, for example 'user/1001' or 'sofia/gateway/mytrunk/441234567890'."),
        destination: z.string().describe("Extension to connect the answered call to."),
        dialplan: z.string().default("XML").describe("Dialplan to use for the destination."),
        context: z.string().default("default").describe("Dialplan context."),
        callerIdNumber: z.string().optional().describe("Caller ID number to present."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ dialString, destination, dialplan, context, callerIdNumber }) => {
      try {
        const parts = [dialString, destination, dialplan, context];
        if (parts.some((p) => /[\n\r]/.test(p))) return text("Arguments may not contain newlines.", true);

        const esl = await getClient();
        const prefix = callerIdNumber ? `{origination_caller_id_number=${callerIdNumber}}` : "";
        const out = await esl.api(`originate ${prefix}${dialString} ${destination} ${dialplan} ${context}`);
        return text(out || "Originate issued, no output returned.");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "freeswitch_hangup",
    {
      title: "Hang up a call by UUID",
      description:
        "Terminate an active call leg by its UUID. Get exact UUIDs from freeswitch_channels first. " +
        "Only available when PBX_MCP_ALLOW_WRITE=true.",
      inputSchema: {
        uuid: z.string().describe("Channel UUID as reported by freeswitch_channels."),
        cause: z.string().default("NORMAL_CLEARING").describe("SIP hangup cause to report."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ uuid, cause }) => {
      try {
        if (!/^[0-9a-f-]{16,64}$/i.test(uuid)) return text("That does not look like a channel UUID.", true);
        if (!/^[A-Z_]+$/.test(cause)) return text("Hangup cause must be an uppercase FreeSWITCH cause name.", true);

        const esl = await getClient();
        const out = await esl.api(`uuid_kill ${uuid} ${cause}`);
        return text(out || `Hangup requested for ${uuid}.`);
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
