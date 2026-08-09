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

export class AmiError extends Error {}

export class AmiClient {
  private socket?: net.Socket;
  private buffer = "";
  private actionSeq = 0;
  private connected = false;
  private greeting = "";

  /** Resolvers waiting on a message, checked in order against each parsed message. */
  private waiters: Array<(msg: AmiMessage) => boolean> = [];

  constructor(private opts: AmiOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  get serverGreeting(): string {
    return this.greeting.trim();
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    await new Promise<void>((resolve, reject) => {
      const timeout = this.opts.timeoutMs ?? 10000;
      const onError = (err: Error) => reject(new AmiError(`AMI connect failed: ${err.message}`));

      const socket = this.opts.tls
        ? tls.connect({ host: this.opts.host, port: this.opts.port, rejectUnauthorized: false }, resolve)
        : net.connect({ host: this.opts.host, port: this.opts.port }, resolve);

      socket.setTimeout(timeout, () => {
        socket.destroy();
        reject(new AmiError(`AMI connect timed out after ${timeout}ms`));
      });
      socket.once("error", onError);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => this.onData(chunk));
      socket.on("close", () => {
        this.connected = false;
      });
      this.socket = socket;
    });

    // Asterisk announces itself before accepting any action.
    this.socket!.setTimeout(0);
    this.socket!.removeAllListeners("error");
    this.socket!.on("error", () => {
      this.connected = false;
    });
    this.connected = true;

    const login = await this.action({
      Action: "Login",
      Username: this.opts.username,
      Secret: this.opts.password,
      Events: "off", // we poll, we do not stream, so suppress the firehose
    });

    if ((login[0]?.Response ?? "").toLowerCase() !== "success") {
      const reason = login[0]?.Message ?? "unknown reason";
      this.close();
      throw new AmiError(`AMI login rejected: ${reason}`);
    }
  }

  close(): void {
    this.connected = false;
    this.socket?.destroy();
    this.socket = undefined;
    this.waiters = [];
  }

  private onData(chunk: string): void {
    // The greeting arrives without a trailing blank line, so strip it once.
    if (!this.greeting && chunk.startsWith("Asterisk Call Manager")) {
      const nl = chunk.indexOf("\r\n");
      this.greeting = chunk.slice(0, nl);
      chunk = chunk.slice(nl + 2);
    }

    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf(MSG_END)) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + MSG_END.length);
      if (raw.trim()) this.dispatch(parseMessage(raw));
    }
  }

  private dispatch(msg: AmiMessage): void {
    for (let i = 0; i < this.waiters.length; i++) {
      // A waiter returns true once it has everything it needs.
      if (this.waiters[i](msg)) {
        this.waiters.splice(i, 1);
        return;
      }
    }
  }

  /**
   * Send an action and collect its reply.
   *
   * List-style actions (CoreShowChannels, PJSIPShowEndpoints and friends) answer
   * with a Response message, then one event per row, then a "...Complete" event.
   * Everything with a matching ActionID is returned, Complete event included.
   */
  async action(fields: AmiMessage, timeoutMs?: number): Promise<AmiMessage[]> {
    if (!this.socket) throw new AmiError("AMI not connected");

    const actionId = `pbxmcp-${++this.actionSeq}-${Date.now()}`;
    const timeout = timeoutMs ?? this.opts.timeoutMs ?? 10000;
    const collected: AmiMessage[] = [];

    const result = new Promise<AmiMessage[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timeout after some rows arrived is usually a missing Complete event,
        // so hand back what we have rather than losing it.
        if (collected.length) resolve(collected);
        else reject(new AmiError(`AMI action ${fields.Action} timed out after ${timeout}ms`));
      }, timeout);

      this.waiters.push((msg) => {
        if (msg.ActionID !== actionId) return false;
        collected.push(msg);

        const isError = (msg.Response ?? "").toLowerCase() === "error";
        const isFinalEvent = /complete$/i.test(msg.Event ?? "");
        // A Response with no EventList header is a single-shot reply.
        const isLoneResponse =
          msg.Response !== undefined && (msg.EventList ?? "").toLowerCase() !== "start";

        if (isError || isFinalEvent || isLoneResponse) {
          clearTimeout(timer);
          resolve(collected);
          return true;
        }
        return false;
      });
    });

    const payload =
      Object.entries({ ...fields, ActionID: actionId })
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n") + MSG_END;

    this.socket.write(payload);
    return result;
  }

  /**
   * Run an Asterisk CLI command and return its raw text output.
   * The caller is responsible for deciding whether the command is allowed.
   */
  async command(cli: string, timeoutMs?: number): Promise<string> {
    const msgs = await this.action({ Action: "Command", Command: cli }, timeoutMs);
    const first = msgs[0] ?? {};
    if ((first.Response ?? "").toLowerCase() === "error") {
      throw new AmiError(first.Message ?? `Asterisk rejected: ${cli}`);
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

/** Keep only the event rows of a list action, dropping the Response and Complete wrappers. */
export function listRows(msgs: AmiMessage[], eventName: string): AmiMessage[] {
  return msgs.filter((m) => (m.Event ?? "").toLowerCase() === eventName.toLowerCase());
}
