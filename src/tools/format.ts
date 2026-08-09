/**
 * Output helpers. MCP tool results are text, so tables are rendered as plain
 * aligned columns that read well in a model context window.
 *
 * Part of pbx-mcp by Tahir Almas, ICT Innovations (https://ictinnovations.com).
 */

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function text(body: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

export function toolError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return text(`Error: ${message}`, true);
}

/**
 * Render rows as an aligned text table.
 * Columns are [heading, sourceKey] pairs; missing values render as a dash.
 */
export function asTable(rows: Array<Record<string, string>>, columns: Array<[string, string]>): string {
  const header = columns.map(([label]) => label);
  const body = rows.map((row) => columns.map(([, key]) => (row[key] ?? "").trim() || "-"));

  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();

  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

/** Truncate very long PBX output so a single tool call cannot flood the context. */
export function clamp(body: string, maxChars = 20000): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n\n[truncated ${body.length - maxChars} more characters]`;
}
