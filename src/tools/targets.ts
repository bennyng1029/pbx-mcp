/**
 * Target selection tools. Credentials and gates are never tool arguments:
 * the schema is strict, so a stray `password` or `trunkAllow` is rejected.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Identity, TargetRegistry } from "../targets.js";
import { NO_TARGET } from "../targets.js";
import { asTable, text, toolError } from "./format.js";

const show = (i: Identity) => `${i.name} (${i.host}:${i.port})${i.readOnly ? " read-only" : ""}`;

export function registerTargetTools(server: McpServer, registry: TargetRegistry) {
  server.registerTool(
    "pbx_list_targets",
    {
      title: "List Asterisk targets",
      description: "List the configured Asterisk targets and which one is selected. Never shows credentials.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const rows = registry.list().map((t) => ({
        selected: t.selected ? "*" : "",
        name: t.name,
        label: t.label,
        address: `${t.host}:${t.port}`,
        readOnly: t.readOnly ? "yes" : "no",
        provision: t.provision ? "yes" : "no",
      }));
      if (!rows.length) return text("No named targets. Ad hoc selection (pbx_select_target with host) may be enabled.");
      return text(
        asTable(rows, [["Sel", "selected"], ["Name", "name"], ["Label", "label"], ["Address", "address"], ["ReadOnly", "readOnly"], ["Provision", "provision"]])
      );
    }
  );

  server.registerTool(
    "pbx_get_target",
    {
      title: "Show the selected target",
      description: "Show which Asterisk target tools are talking to now, or that none is selected.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return text(`Selected: ${show(registry.identity())}`);
      } catch (err) {
        return (err as Error).message === NO_TARGET ? text(`${NO_TARGET}: select one with pbx_select_target.`) : toolError(err);
      }
    }
  );

  server.registerTool(
    "pbx_select_target",
    {
      title: "Select the Asterisk target",
      description:
        "Choose the Asterisk every other tool talks to: a named target (name) or an ad hoc read-only IP (host, optional port/tls). " +
        "Ad hoc targets must be an IP inside PBX_MCP_HOST_ALLOW and are always read-only.",
      inputSchema: z
        .object({ name: z.string().optional(), host: z.string().optional(), port: z.number().int().min(1).max(65535).optional(), tls: z.boolean().optional() })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const { name, host, port, tls } = args;
        if ((name === undefined) === (host === undefined)) return text("Error: give either name or host, not both and not neither.", true);
        if (name !== undefined && (port !== undefined || tls !== undefined)) return text("Error: port and tls apply to host selection only.", true);
        const id = name !== undefined ? registry.select({ name }) : registry.select({ host: host!, port, tls });
        return text(`Selected: ${show(id)}`);
      } catch (err) {
        return toolError(err);
      }
    }
  );
}
