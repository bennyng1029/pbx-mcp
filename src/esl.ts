/**
 * FreeSWITCH Event Socket Layer (ESL) client, inbound mode.
 *
 * Part of pbx-mcp by Tahir Almas, ICT Innovations (https://ictinnovations.com).
 * No third-party dependencies: ESL is a header block plus an optional body over TCP.
 */

import net from "node:net";

export interface EslOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

interface EslFrame {
  headers: Record<string, string>;
  body: string;
}

export class EslError extends Error {}

export class EslClient {
  private socket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private connected = false;
  private frameQueue: EslFrame[] = [];
  private frameWaiters: Array<(frame: EslFrame) => void> = [];

  constructor(private opts: EslOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const timeout = this.opts.timeoutMs ?? 10000;

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host: this.opts.host, port: this.opts.port }, resolve);
      socket.setTimeout(timeout, () => {
        socket.destroy();
        reject(new EslError(`ESL connect timed out after ${timeout}ms`));
      });
      socket.once("error", (err) => reject(new EslError(`ESL connect failed: ${err.message}`)));
      socket.on("data", (chunk: Buffer) => this.onData(chunk));
      socket.on("close", () => {
        this.connected = false;
      });
      this.socket = socket;
    });

    this.socket!.setTimeout(0);
    this.socket!.removeAllListeners("error");
    this.socket!.on("error", () => {
      this.connected = false;
    });
    this.connected = true;

    // FreeSWITCH opens with auth/request and will not accept anything until authed.
    const challenge = await this.nextFrame(timeout);
    if (challenge.headers["Content-Type"] !== "auth/request") {
      this.close();
      throw new EslError(`Unexpected ESL greeting: ${challenge.headers["Content-Type"]}`);
    }

    this.socket!.write(`auth ${this.opts.password}\n\n`);
    const reply = await this.nextFrame(timeout);
    if (!(reply.headers["Reply-Text"] ?? "").startsWith("+OK")) {
      this.close();
      throw new EslError(`ESL auth rejected: ${reply.headers["Reply-Text"] ?? "no reply"}`);
    }
  }

  close(): void {
    this.connected = false;
    this.socket?.destroy();
    this.socket = undefined;
    this.frameQueue = [];
    this.frameWaiters = [];
  }

  /**
   * Run a FreeSWITCH API command synchronously and return its raw output.
   * The caller decides whether the command is allowed.
   */
  async api(command: string, timeoutMs?: number): Promise<string> {
    if (!this.socket) throw new EslError("ESL not connected");
    this.socket.write(`api ${command}\n\n`);
    const frame = await this.nextFrame(timeoutMs ?? this.opts.timeoutMs ?? 10000);
    const body = frame.body.trim();
    if (body.startsWith("-ERR")) throw new EslError(body);
    return body;
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const split = this.buffer.indexOf("\n\n");
      if (split === -1) return;

      const headers = parseHeaders(this.buffer.subarray(0, split).toString("utf8"));
      const bodyStart = split + 2;
      const declared = Number(headers["Content-Length"] ?? 0);

      // Wait for the whole body before emitting, otherwise long `show channels`
      // output arrives truncated across TCP segments.
      if (declared > 0 && this.buffer.length < bodyStart + declared) return;

      const body = declared > 0 ? this.buffer.subarray(bodyStart, bodyStart + declared).toString("utf8") : "";
      this.buffer = this.buffer.subarray(bodyStart + declared);
      this.emitFrame({ headers, body });
    }
  }

  private emitFrame(frame: EslFrame): void {
    const waiter = this.frameWaiters.shift();
    if (waiter) waiter(frame);
    else this.frameQueue.push(frame);
  }

  private nextFrame(timeoutMs: number): Promise<EslFrame> {
    const queued = this.frameQueue.shift();
    if (queued) return Promise.resolve(queued);

    return new Promise<EslFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.frameWaiters.indexOf(onFrame);
        if (idx !== -1) this.frameWaiters.splice(idx, 1);
        reject(new EslError(`ESL response timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onFrame = (frame: EslFrame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.frameWaiters.push(onFrame);
    });
  }
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    headers[line.slice(0, sep).trim()] = decodeURIComponent(line.slice(sep + 1).trim());
  }
  return headers;
}
