import { AmiClient, type AmiMessage } from "./ami.js";

/** Channel columns that need one Getvar each (PJSIP channels only); Asterisk answers with the SIP header or id. */
export const CHANNEL_VARS: Array<[string, string]> = [
  ["Call-ID", "CHANNEL(pjsip,call-id)"],
  ["From", "PJSIP_HEADER(read,From)"],
  ["To", "PJSIP_HEADER(read,To)"],
  ["Diversion", "PJSIP_HEADER(read,Diversion)"],
];
export const ENRICH_CHANNELS = 20;
const ENRICH_CONCURRENCY = 8;

const MAX_CELL_LEN = 128;
function sanitizeCell(val: string): string {
  const clean = val.replace(/[\r\n\x00-\x1f\x7f]/g, " ").trim();
  return clean.length > MAX_CELL_LEN ? `${clean.slice(0, MAX_CELL_LEN - 3)}...` : clean;
}

/**
 * Fill Call-ID/From/To/Diversion on the first channels. Every failure (Getvar refused, no such
 * header, not a PJSIP channel, budget spent) leaves that cell unset, so it renders as n/a; this
 * never fails the tool. One extra timeoutMs budget is shared by all lookups.
 */
export async function enrichChannels(ami: AmiClient, rows: AmiMessage[], budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let spent = false;
  const jobs: Array<() => Promise<void>> = [];
  for (const row of rows.slice(0, ENRICH_CHANNELS)) {
    if (!(row.Channel ?? "").startsWith("PJSIP/") || /[\r\n]/.test(row.Channel)) continue;
    for (const [column, variable] of CHANNEL_VARS) {
      jobs.push(async () => {
        const left = deadline - Date.now();
        if (left <= 0) {
          spent = true;
          return;
        }
        try {
          const res = (await ami.action({ Action: "Getvar", Channel: row.Channel, Variable: variable }, left))[0] ?? {};
          if ((res.Response ?? "").toLowerCase() === "success" && res.Value?.trim()) {
            row[column] = sanitizeCell(res.Value);
          }
        } catch {
          // Rendered as n/a; a lookup cut short by the shared budget is reported in a note.
          if (Date.now() >= deadline - 5) spent = true;
        }
      });
    }
  }
  const queue = [...jobs];
  await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await job();
  }));
  return spent;
}

export type MetadataReason = "not_observed" | "unsupported" | "refused" | "truncated" | "timed_out" | "channel_gone" | "cancelled" | "observation_gap";
export interface FieldCoverage {
  availability: "available" | "unavailable" | "partial";
  reason: MetadataReason | null;
}
export interface SipMetadata {
  from: string | null;
  to: string | null;
  historyInfo: string[];
  diversion: string[];
  fields: Record<"fullCallId" | "from" | "to" | "historyInfo" | "diversion", FieldCoverage>;
}
export interface ChannelMetadata {
  fullCallId: string | null;
  sipMetadata: SipMetadata;
  ownershipConfirmed: boolean;
}
export interface ChannelIdentity {
  generation: number;
  uniqueid: string;
  channel: string;
  /** Observer verifies generation and retained original-leg ownership after every await. */
  isCurrent?: () => boolean;
}
/** The observer owns its eight-slot queue; it must recheck deadline/signal when dispatching. */
export type RunGetvar = (variable: string, deadline: number, signal: AbortSignal) => Promise<AmiMessage[]>;
const available = (): FieldCoverage => ({ availability: "available", reason: null });
const unavailable = (reason: MetadataReason): FieldCoverage => ({ availability: "unavailable", reason });

export function unavailableChannelMetadata(reason: MetadataReason): ChannelMetadata {
  return {
    fullCallId: null, ownershipConfirmed: false,
    sipMetadata: { from: null, to: null, historyInfo: [], diversion: [], fields: {
      fullCallId: unavailable(reason), from: unavailable(reason), to: unavailable(reason),
      historyInfo: unavailable(reason), diversion: unavailable(reason),
    } },
  };
}
function failureReason(error: unknown): MetadataReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancel|abort/i.test(message)) return "cancelled";
  if (/timed?\s*out|timeout/i.test(message)) return "timed_out";
  if (/permission|denied|refused|not authorized/i.test(message)) return "refused";
  if (/no such channel|channel.*not (found|exist)|connection.*closed|not connected/i.test(message)) return "channel_gone";
  if (/unknown|unsupported|not loaded|function.*not (found|registered)/i.test(message)) return "unsupported";
  return "not_observed";
}

/** Monotonic deadline and raw values: display sanitization is confined to enrichChannels. */
export async function collectChannelMetadata(
  ami: AmiClient, identity: ChannelIdentity, deadline: number, signal: AbortSignal,
  runGetvar: RunGetvar = (variable, end, cancellation) => ami.action(
    { Action: "Getvar", Channel: identity.channel, Variable: variable },
    Math.max(1, end - performance.now()), { signal: cancellation, maxMessages: 1 },
  ),
): Promise<ChannelMetadata> {
  if (/[\r\n]/.test(identity.channel) || /[\r\n]/.test(identity.uniqueid)) throw new Error("Channel identity must not contain CR/LF newlines");
  if (!identity.channel.startsWith("PJSIP/")) return unavailableChannelMetadata("unsupported");
  const stateReason = (): MetadataReason | null => signal.aborted ? "cancelled"
    : identity.isCurrent && !identity.isCurrent() ? "observation_gap"
    : performance.now() >= deadline ? "timed_out" : null;
  type Value = { value: string | null; coverage: FieldCoverage; absent?: boolean };
  const read = async (variable: string, bounded = true): Promise<Value> => {
    const before = stateReason();
    if (before) return { value: null, coverage: unavailable(before) };
    try {
      const first = (await runGetvar(variable, deadline, signal))[0] ?? {};
      const after = stateReason();
      if (after) return { value: null, coverage: unavailable(after) };
      if ((first.Response ?? "").toLowerCase() !== "success") return { value: null, coverage: unavailable(failureReason(first.Message ?? "No response")), absent: /^No such variable$/i.test(first.Message ?? "") };
      const value = first.Value;
      if (value === undefined || value === "") return { value: null, coverage: unavailable("not_observed"), absent: true };
      if (bounded && Buffer.byteLength(value, "utf8") > 4096) return { value: null, coverage: unavailable("truncated") };
      return { value, coverage: available() };
    } catch (error) {
      return { value: null, coverage: unavailable(stateReason() ?? failureReason(error)) };
    }
  };
  // Verify the original leg before issuing metadata lookups. Never recover by querying history.
  const firstOwner = await read("CHANNEL(uniqueid)", false);
  if (firstOwner.value !== identity.uniqueid) return unavailableChannelMetadata(firstOwner.coverage.reason ?? "channel_gone");
  const result = unavailableChannelMetadata("not_observed");
  const callId = await read("CHANNEL(pjsip,call-id)");
  result.fullCallId = callId.value;
  result.sipMetadata.fields.fullCallId = callId.coverage;
  for (const [field, variable] of [["from", "PJSIP_HEADER(read,From)"], ["to", "PJSIP_HEADER(read,To)"]] as const) {
    const value = await read(variable);
    result.sipMetadata[field] = value.value;
    result.sipMetadata.fields[field] = value.coverage;
  }
  for (const [field, header] of [["historyInfo", "History-Info"], ["diversion", "Diversion"]] as const) {
    for (let occurrence = 1; occurrence <= 16; occurrence++) {
      const value = await read(`PJSIP_HEADER(read,${header},${occurrence})`);
      if (value.value === null) {
        // A confirmed empty value establishes the end of this ordered list.
        result.sipMetadata.fields[field] = value.absent ? available()
          : { availability: result.sipMetadata[field].length ? "partial" : "unavailable", reason: value.coverage.reason };
        break;
      }
      result.sipMetadata[field].push(value.value);
      result.sipMetadata.fields[field] = occurrence === 16 ? { availability: "partial", reason: "truncated" } : available();
    }
  }
  // A missing final proof, a changed generation, or channel reuse invalidates this whole batch.
  const finalOwner = await read("CHANNEL(uniqueid)", false);
  if (finalOwner.value !== identity.uniqueid) return unavailableChannelMetadata(finalOwner.coverage.reason ?? "channel_gone");
  result.ownershipConfirmed = true;
  return result;
}
