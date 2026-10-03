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

export class AmiClient {
  private socket?: net.Socket;
  private buffer = "";
  private actionSeq = 0;
  private connected = false;
  private closed = false;
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

    const timeout = this.opts.timeoutMs ?? 10000;
    const deadline = Date.now() + timeout;
    this.closed = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: AmiError) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      const onUp = () => {
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
      socket.once("error", (err: Error) => fail(new AmiError(`AMI connect failed: ${err.message}`)));
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => this.onData(chunk));
      socket.on("close", () => {
        this.connected = false;
        fail(new AmiError("AMI connection closed before the connection was established"));
      });
      this.socket = socket;
    });

    if (this.closed || !this.socket) throw new AmiError("AMI connection closed during connect");
    // Asterisk announces itself before accepting any action.
    this.socket.setTimeout(0);
    this.socket!.removeAllListeners("error");
    this.socket!.on("error", () => {
      this.connected = false;
    });

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
    this.connected = false;
    this.closed = true;
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
    if (this.buffer.length > MAX_AMI_BUFFER) {
      this.buffer = "";
      this.close();
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
      const waiter = (msg: AmiMessage): boolean => {
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
      };

      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        // Anything collected means a list started and its Complete event never came:
        // an incomplete list is an error, never a silently shortened answer.
        if (collected.length) {
          reject(new AmiError(`AMI action ${fields.Action} returned an incomplete list (no Complete event within ${timeout}ms)`));
        } else {
          reject(new AmiError(`AMI action ${fields.Action} timed out after ${timeout}ms`));
        }
      }, timeout);

      this.waiters.push(waiter);
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
