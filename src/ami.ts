/**
 * Asterisk Manager Interface (AMI) client.
 *
 * Part of pbx-mcp by Tahir Almas, ICT Innovations (https://ictinnovations.com).
 * No third-party dependencies: AMI is a line protocol over plain TCP.
 */

import net from "node:net";
import tls from "node:tls";

export type AmiMessage = Record<string, string>;

export interface AmiOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  tls?: boolean;
  timeoutMs?: number;
}

/** AMI terminates every message with a blank line. */
const MSG_END = "\r\n\r\n";
/** Cap on unparsed incoming buffer to protect against unbounded buffering from a hostile/misbehaving peer. */
export const MAX_AMI_BUFFER = 1024 * 1024;

export class AmiError extends Error {}

export interface AmiActionOptions {
  maxMessages?: number;
  rowEvent?: string;
  maxRows?: number;
  signal?: AbortSignal;
}

export type AmiLifecycleReason = "socket_closed" | "socket_error" | "input_buffer_failure" | "explicit_close";
interface ActionWaiter {
  actionId: string;
  receive(msg: AmiMessage): void;
  reject(err: AmiError): void;
}

export class AmiClient {
  private socket?: net.Socket;
  private buffer = "";
  private actionSeq = 0;
  private connected = false;
  private closed = false;
  private greeting = "";

  /** Pending action collectors, routed exclusively by ActionID. */
  private waiters: ActionWaiter[] = [];
  private eventListeners = new Set<(msg: AmiMessage) => void>();
  private lifecycleListeners = new Set<(reason: AmiLifecycleReason) => void>();
  private lifecycleNotified = false;

  subscribeEvents(listener: (msg: AmiMessage) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  subscribeLifecycle(listener: (reason: AmiLifecycleReason) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => { this.lifecycleListeners.delete(listener); };
  }

  private disconnect(reason: AmiLifecycleReason): void {
    this.connected = false;
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    this.buffer = "";
    for (const waiter of [...this.waiters]) waiter.reject(new AmiError(`AMI connection closed: ${reason}`));
    socket?.destroy();
    if (!this.lifecycleNotified) {
      this.lifecycleNotified = true;
      for (const listener of [...this.lifecycleListeners]) listener(reason);
    }
  }

  constructor(private opts: AmiOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  get serverGreeting(): string {
    return this.greeting.trim();
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const timeout = this.opts.timeoutMs ?? 10000;
    const deadline = Date.now() + timeout;
    this.closed = false;
    this.lifecycleNotified = false;
    this.buffer = "";
    this.greeting = "";

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: AmiError) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      const onUp = () => {
        if (settled || this.closed) return;
        settled = true;
        resolve();
      };

      const socket = this.opts.tls
        ? tls.connect({ host: this.opts.host, port: this.opts.port, rejectUnauthorized: false }, onUp)
        : net.connect({ host: this.opts.host, port: this.opts.port }, onUp);

      socket.setTimeout(timeout, () => {
        socket.destroy();
        fail(new AmiError(`AMI connect timed out after ${timeout}ms`));
      });
      socket.on("error", (err: Error) => {
        fail(new AmiError(`AMI connect failed: ${err.message}`));
        if (this.socket === socket) this.disconnect("socket_error");
      });
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => { if (this.socket === socket) this.onData(chunk); });
      socket.on("close", () => {
        fail(new AmiError("AMI connection closed before the connection was established"));
        if (this.socket === socket) this.disconnect("socket_closed");
      });
      this.socket = socket;
    });

    if (this.closed || !this.socket) throw new AmiError("AMI connection closed during connect");
    // Asterisk announces itself before accepting any action.
    this.socket.setTimeout(0);

    try {
      // Connect and login share one budget of timeoutMs.
      const login = await this.action(
        {
          Action: "Login",
          Username: this.opts.username,
          Secret: this.opts.password,
          Events: "off", // we poll, we do not stream, so suppress the firehose
        },
        Math.max(1, deadline - Date.now())
      );

      if ((login[0]?.Response ?? "").toLowerCase() !== "success") {
        throw new AmiError(`AMI login rejected: ${login[0]?.Message ?? "unknown reason"}`);
      }
      if (this.closed) throw new AmiError("AMI connection closed during login");
    } catch (err) {
      this.close();
      throw err;
    }

    // Only a client that has logged in is ever reported as connected.
    this.connected = true;
  }

  close(): void {
    this.disconnect("explicit_close");
  }

  private onData(chunk: string): void {
    // The greeting arrives without a trailing blank line, so strip it once.
    if (!this.greeting && chunk.startsWith("Asterisk Call Manager")) {
      const nl = chunk.indexOf("\r\n");
      this.greeting = chunk.slice(0, nl);
      chunk = chunk.slice(nl + 2);
    }

    this.buffer += chunk;
    if (this.buffer.length > MAX_AMI_BUFFER) {
      this.buffer = "";
      this.disconnect("input_buffer_failure");
      return;
    }

    let idx: number;
    while ((idx = this.buffer.indexOf(MSG_END)) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + MSG_END.length);
      if (raw.trim()) this.dispatch(parseMessage(raw));
    }
  }

  private dispatch(msg: AmiMessage): void {
    const waiter = this.waiters.find((w) => w.actionId === msg.ActionID);
    if (waiter) {
      waiter.receive(msg);
      return;
    }
    // Action-tagged list rows (including late rows of a settled action) are not
    // unsolicited call events and must never enter an observer's event stream.
    if (msg.Event && !msg.ActionID) {
      for (const listener of [...this.eventListeners]) listener(msg);
    }
  }

  /**
   * Send an action and collect its reply.
   *
   * List-style actions (CoreShowChannels, PJSIPShowEndpoints and friends) answer
   * with a Response message, then one event per row, then a "...Complete" event.
   * Everything with a matching ActionID is returned, Complete event included.
   */
  async action(fields: AmiMessage, timeoutMs?: number, options: AmiActionOptions = {}): Promise<AmiMessage[]> {
    const socket = this.socket;
    if (!socket) throw new AmiError("AMI not connected");
    if (options.signal?.aborted) throw new AmiError(`AMI action ${fields.Action} cancelled`);

    const actionId = `pbxmcp-${++this.actionSeq}-${Date.now()}`;
    const timeout = timeoutMs ?? this.opts.timeoutMs ?? 10000;
    const collected: AmiMessage[] = [];
    let rows = 0;

    return new Promise<AmiMessage[]>((resolve, reject) => {
      let settled = false;
      const finish = (err?: AmiError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        if (err) reject(err); else resolve(collected);
      };
      const cancel = () => finish(new AmiError(`AMI action ${fields.Action} cancelled`));
      const waiter: ActionWaiter = {
        actionId,
        reject: finish,
        receive: (msg) => {
          if (options.maxMessages !== undefined && collected.length >= options.maxMessages) {
            finish(new AmiError(`AMI action ${fields.Action} exceeded maxMessages ${options.maxMessages}`));
            return;
          }
          if (options.rowEvent && (msg.Event ?? "").toLowerCase() === options.rowEvent.toLowerCase()) {
            rows++;
            if (options.maxRows !== undefined && rows > options.maxRows) {
              finish(new AmiError(`AMI action ${fields.Action} exceeded maxRows ${options.maxRows}`));
              return;
            }
          }
          collected.push(msg);
          const isError = (msg.Response ?? "").toLowerCase() === "error";
          const isFinalEvent = /complete$/i.test(msg.Event ?? "");
          const isLoneResponse = msg.Response !== undefined && (msg.EventList ?? "").toLowerCase() !== "start";
          if (isError || isFinalEvent || isLoneResponse) finish();
        },
      };
      const timer = setTimeout(() => finish(new AmiError(collected.length
        ? `AMI action ${fields.Action} returned an incomplete list (no Complete event within ${timeout}ms)`
        : `AMI action ${fields.Action} timed out after ${timeout}ms`)), timeout);
      this.waiters.push(waiter);
      options.signal?.addEventListener("abort", cancel, { once: true });
      const payload = Object.entries({ ...fields, ActionID: actionId })
        .map(([k, v]) => `${k}: ${v}`).join("\r\n") + MSG_END;
      try {
        socket.write(payload, (err?: Error | null) => {
          if (err) finish(new AmiError(`AMI action ${fields.Action} write failed: ${err.message}`));
        });
      } catch (err) {
        finish(new AmiError(`AMI action ${fields.Action} write failed: ${(err as Error).message}`));
      }
    });
  }

  /**
   * Run an Asterisk CLI command and return its raw text output.
   * The caller is responsible for deciding whether the command is allowed.
   */
  async command(cli: string, timeoutMs?: number): Promise<string> {
    const msgs = await this.action({ Action: "Command", Command: cli }, timeoutMs);
    const first = msgs[0] ?? {};
    if ((first.Response ?? "").toLowerCase() === "error") {
      const message = first.Message?.trim();
      const output = (first.Output ?? "").split("\n").filter((line) => line.trim()).join("\n");
      // "Command output follows" is an envelope label, not the diagnostic.
      const context = message && message.toLowerCase() !== "command output follows"
        ? message : `Asterisk rejected: ${cli}`;
      throw new AmiError(output ? `${context}\n${output}` : context);
    }
    // Asterisk 14+ returns the text in an "Output" key that repeats per line;
    // parseMessage folds repeats into one newline-joined value.
    return first.Output ?? "";
  }
}

/** Parse one AMI message. Repeated keys (notably Output) are joined with newlines. */
export function parseMessage(raw: string): AmiMessage {
  const msg: AmiMessage = {};
  for (const line of raw.split("\r\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    msg[key] = msg[key] === undefined ? value : `${msg[key]}\n${value}`;
  }
  return msg;
}

/**
 * Keep only the event rows of a list action, dropping the Response and Complete wrappers.
 * An Error reply (permission denied, unknown action) throws: it is never an empty list.
 */
export function listRows(msgs: AmiMessage[], eventName: string): AmiMessage[] {
  const first = msgs[0];
  if ((first?.Response ?? "").toLowerCase() === "error") {
    throw new AmiError(first.Message ?? "Asterisk returned an error");
  }
  return msgs.filter((m) => (m.Event ?? "").toLowerCase() === eventName.toLowerCase());
}
