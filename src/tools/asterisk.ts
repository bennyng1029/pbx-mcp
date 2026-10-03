/**
 * Asterisk tools exposed over MCP.
 *
 * Part of pbx-mcp by Tahir Almas, ICT Innovations (https://ictinnovations.com).
 * Built on the same AMI groundwork behind ICTContact and ICTDialer.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AmiClient, AmiError, listRows, type AmiMessage } from "../ami.js";
import { assertNoHeaderInjection, checkAsteriskCommand, type Config } from "../config.js";
import { asTable, text, toolError } from "./format.js";

/** What a tool needs to know about its target; a registry Snapshot satisfies it. */
export interface ToolTarget {
  readOnly: boolean;
  getClient: () => Promise<AmiClient>;
  name?: string;
  host?: string;
  port?: number;
}

/**
 * `getSnapshot` is read once at tool entry by every write and by status, so a target change
 * between the permission check and the AMI call cannot redirect a write. Omitted, it is the
 * single-target behaviour: writable, using `getClient`.
 */
export function registerAsteriskTools(
  server: McpServer,
  cfg: Config,
  getClient: () => Promise<AmiClient>,
  getSnapshot: () => ToolTarget = () => ({ readOnly: false, getClient })
) {
  const write = cfg.allowWrite;
  const refuseReadOnly = (t: ToolTarget) =>
    text(`Refused. Target "${t.name}" (${t.host}:${t.port}) is read-only; no write was sent.`, true);

  server.registerTool(
    "asterisk_status",
    {
      title: "Asterisk status",
      description:
        "Core status of the Asterisk server: version, uptime, active calls and calls processed. " +
        "Use this first to confirm the PBX is reachable before running other Asterisk tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const target = getSnapshot();
        const ami = await target.getClient();
        const [status, version] = await Promise.all([
          ami.command("core show uptime"),
          ami.command("core show version"),
        ]);
        const calls = await ami.command("core show calls");
        const header = target.name ? `Target: ${target.name} (${target.host}:${target.port})\n` : "";
        return text(header + ([version, status, calls].filter(Boolean).join("\n").trim() || "No output from Asterisk."));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "asterisk_channels",
    {
      title: "List active Asterisk channels",
      description:
        "Every channel currently up on the PBX, with caller ID, state, bridge, duration and " +
        "the dialplan location it is sitting in. This is the tool for 'what calls are live right now'.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe("Case-insensitive substring to match against any field, for example an extension or caller ID."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filter }) => {
      try {
        const ami = await getClient();
        const msgs = await ami.action({ Action: "CoreShowChannels" });
        let rows = listRows(msgs, "CoreShowChannel");

        if (filter) {
          const needle = filter.toLowerCase();
          rows = rows.filter((r) => Object.values(r).some((v) => v.toLowerCase().includes(needle)));
        }

        if (!rows.length) return text(filter ? `No active channels match "${filter}".` : "No active channels.");

        return text(
          asTable(rows, [
            ["Channel", "Channel"],
            ["State", "ChannelStateDesc"],
            ["CallerID", "CallerIDNum"],
            ["Connected", "ConnectedLineNum"],
            ["Context", "Context"],
            ["Exten", "Exten"],
            ["Duration", "Duration"],
            ["Bridge", "BridgeId"],
          ]) + `\n\n${rows.length} active channel(s).`
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "asterisk_endpoints",
    {
      title: "List PJSIP endpoints and registration state",
      description:
        "PJSIP endpoints with their device state and how many contacts are registered. " +
        "Use this to answer 'is extension 1001 registered' or 'which phones are offline'. " +
        "Falls back to chan_sip peers on older installations.",
      inputSchema: {
        filter: z.string().optional().describe("Case-insensitive substring to match against the endpoint name."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filter }) => {
      try {
        const ami = await getClient();
        let rows: AmiMessage[] = [];
        let source = "PJSIP";

        let pjsipLoaded = true;
        try {
          const msgs = await ami.action({ Action: "PJSIPShowEndpoints" });
          rows = listRows(msgs, "EndpointList");
        } catch (err) {
          // Only "the module is not there" falls back; permission errors and timeouts are real errors.
          if (!(err instanceof AmiError && /no such command|invalid\/unknown|not loaded|unknown action/i.test(err.message))) throw err;
          pjsipLoaded = false;
        }

        if (!pjsipLoaded) {
          // chan_pjsip is absent or unloaded, so try the legacy channel driver.
          const msgs = await ami.action({ Action: "SIPpeers" });
          rows = listRows(msgs, "PeerEntry");
          source = "chan_sip";
        } else if (!rows.length) {
          return text("PJSIP is loaded, 0 endpoints configured.");
        }

        if (filter) {
          const needle = filter.toLowerCase();
          rows = rows.filter((r) => Object.values(r).some((v) => v.toLowerCase().includes(needle)));
        }

        if (!rows.length) return text(filter ? `No endpoints match "${filter}".` : "No endpoints found. Check that chan_pjsip or chan_sip is loaded.");

        const table =
          source === "PJSIP"
            ? asTable(rows, [
                ["Endpoint", "ObjectName"],
                ["State", "DeviceState"],
                ["Contacts", "Contacts"],
                ["AOR", "Aor"],
                ["Transport", "Transport"],
              ])
            : asTable(rows, [
                ["Peer", "ObjectName"],
                ["Address", "IPaddress"],
                ["Port", "IPport"],
                ["Status", "Status"],
                ["Dynamic", "Dynamic"],
              ]);

        return text(`Source: ${source}\n\n${table}\n\n${rows.length} endpoint(s).`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "asterisk_dialplan",
    {
      title: "Show dialplan",
      description:
        "Dump the dialplan for a context, or for one extension within a context. " +
        "Useful for tracing where a call would go before placing it.",
      inputSchema: {
        context: z.string().describe("Dialplan context, for example 'from-internal' or 'default'."),
        extension: z.string().optional().describe("Optional single extension to narrow the output."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ context, extension }) => {
      try {
        assertNoHeaderInjection("context", context);
        if (extension) assertNoHeaderInjection("extension", extension);
        if (!/^[\w.\-]+$/.test(context)) return text("Context name may only contain letters, digits, dot, dash and underscore.");
        if (extension && !/^[\w.\-*#+]+$/.test(extension)) return text("Extension contains characters that are not valid in a dialplan lookup.");

        const ami = await getClient();
        const cli = extension ? `dialplan show ${extension}@${context}` : `dialplan show ${context}`;
        const out = await ami.command(cli);
        return text(out.trim() || `No dialplan found for ${extension ? `${extension}@` : ""}${context}.`);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "asterisk_cli",
    {
      title: "Run an Asterisk CLI command",
      description:
        "Run a command through the Asterisk CLI and return its raw output. " +
        "In the default read-only mode only inspection commands such as 'core show', 'pjsip show' " +
        "and 'queue show' are permitted. Set PBX_MCP_ALLOW_WRITE=true to lift that restriction.",
      inputSchema: {
        command: z.string().describe("The CLI command, for example 'pjsip show endpoints' or 'queue show support'."),
      },
      annotations: { readOnlyHint: !write, destructiveHint: write, openWorldHint: true },
    },
    async ({ command }) => {
      try {
        const target = getSnapshot();
        const policy = checkAsteriskCommand(command, write && !target.readOnly);
        if (!policy.allowed) return write && target.readOnly ? refuseReadOnly(target) : text(`Refused. ${policy.reason}`, true);

        const ami = await target.getClient();
        const out = await ami.command(command);
        return text(out.trim() || "(command produced no output)");
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "asterisk_hangup_preview",
    {
      title: "Preview what a hangup would drop",
      description:
        "Show which live channels a hangup would affect, without touching them. Takes the same " +
        "channel argument as asterisk_hangup and reports the exact match plus any near misses, " +
        "so you can see the blast radius before dropping a call. Always available, including in " +
        "read-only mode.",
      inputSchema: {
        channel: z.string().describe("Channel name, exact or partial, for example 'PJSIP/1001-0000000a' or just '1001'."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ channel }) => {
      try {
        assertNoHeaderInjection("channel", channel);

        const ami = await getClient();
        const rows = listRows(await ami.action({ Action: "CoreShowChannels" }), "CoreShowChannel");
        const needle = channel.toLowerCase();
        const exact = rows.filter((r) => (r.Channel ?? "").toLowerCase() === needle);
        const partial = rows.filter(
          (r) => (r.Channel ?? "").toLowerCase().includes(needle) && (r.Channel ?? "").toLowerCase() !== needle
        );

        if (!exact.length && !partial.length) {
          return text(
            `Nothing matches "${channel}". No channel would be dropped, and asterisk_hangup would ` +
              `report "No such channel".`
          );
        }

        const describe = (label: string, matched: typeof rows) =>
          `${label}\n` +
          asTable(matched, [
            ["Channel", "Channel"],
            ["State", "ChannelStateDesc"],
            ["CallerID", "CallerIDNum"],
            ["Connected", "ConnectedLineNum"],
            ["Duration", "Duration"],
            ["Bridge", "BridgeId"],
          ]);

        const out: string[] = [];
        if (exact.length) {
          out.push(describe(`Would be dropped by asterisk_hangup("${channel}"):`, exact));
          const bridged = exact.filter((r) => r.BridgeId);
          if (bridged.length) {
            out.push(
              "That channel is bridged, so the party on the other side gets hung up with it."
            );
          }
        } else {
          out.push(
            `No exact match, so asterisk_hangup("${channel}") would drop nothing. ` +
              `asterisk_hangup needs the full channel name.`
          );
        }
        if (partial.length) out.push(describe("Channels containing that string:", partial));

        return text(out.join("\n\n"));
      } catch (err) {
        return toolError(err);
      }
    }
  );

  if (!write) return;

  server.registerTool(
    "asterisk_originate",
    {
      title: "Place a call",
      description:
        "Originate a call from a channel to an extension in a context. This places a real call " +
        "and costs real money on a live trunk. Only available when PBX_MCP_ALLOW_WRITE=true.",
      inputSchema: {
        channel: z.string().describe("Originating channel, for example 'PJSIP/1001' or 'Local/1001@from-internal'."),
        extension: z.string().describe("Extension to connect the answered call to."),
        context: z.string().default("default").describe("Dialplan context for the extension."),
        callerId: z.string().optional().describe("Caller ID to present, for example 'Support <1000>'."),
        timeoutSeconds: z.number().int().min(1).max(300).default(30).describe("How long to ring before giving up."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ channel, extension, context, callerId, timeoutSeconds }) => {
      try {
        const target = getSnapshot();
        if (target.readOnly) return refuseReadOnly(target);
        for (const [label, value] of Object.entries({ channel, extension, context, callerId: callerId ?? "" })) {
          assertNoHeaderInjection(label, value);
        }

        const ami = await target.getClient();
        const fields: Record<string, string> = {
          Action: "Originate",
          Channel: channel,
          Exten: extension,
          Context: context,
          Priority: "1",
          Timeout: String(timeoutSeconds * 1000),
          Async: "true",
        };
        if (callerId) fields.CallerID = callerId;

        const res = await ami.action(fields, (timeoutSeconds + 5) * 1000);
        const first = res[0] ?? {};
        return text(
          `${first.Response ?? "Unknown"}: ${first.Message ?? "no message"}\n` +
            `Originated ${channel} towards ${extension}@${context}.`
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "asterisk_hangup",
    {
      title: "Hang up a channel",
      description:
        "Terminate an active channel by name. Get exact channel names from asterisk_channels first. " +
        "Only available when PBX_MCP_ALLOW_WRITE=true.",
      inputSchema: {
        channel: z.string().describe("Exact channel name as reported by asterisk_channels."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ channel }) => {
      try {
        const target = getSnapshot();
        if (target.readOnly) return refuseReadOnly(target);
        assertNoHeaderInjection("channel", channel);
        const ami = await target.getClient();
        const res = await ami.action({ Action: "Hangup", Channel: channel });
        const first = res[0] ?? {};
        return text(`${first.Response ?? "Unknown"}: ${first.Message ?? `Hangup requested for ${channel}.`}`);
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
