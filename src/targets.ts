/**
 * Asterisk targets: named entries from an operator JSON file (plus the env-only
 * `default`), or one ad hoc read-only IP:port chosen at run time.
 *
 * This is the one place target settings are resolved. Tools receive a Snapshot,
 * never raw credentials, and nothing a tool caller sends can set a credential or a gate.
 */

import fs from "node:fs";
import net from "node:net";
import { z } from "zod";
import { AmiClient } from "./ami.js";
import type { Config } from "./config.js";
import { lazyClient } from "./lazy-client.js";
import { assertPjsipFile, Provisioner } from "./provision.js";

export const NO_TARGET = "no_target_selected";
const DEFAULT = "default";

/** A resolved named target. Secrets and gates live here and nowhere a tool can reach. */
export interface TargetEntry {
  name: string;
  label: string;
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  readOnly: boolean;
  provision: boolean;
  pjsipFile: string;
  trunkAllow: string[];
  contextAllow: string[];
  dialplanHint?: string;
}

/** What a tool may know about its target, bound at tool entry. */
export interface Identity {
  name: string;
  label: string;
  host: string;
  port: number;
  dialplanHint?: string;
  readOnly: boolean;
}
export interface Snapshot extends Identity {
  getClient: () => Promise<AmiClient>;
}

const entrySchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(5038),
    tls: z.boolean().default(false),
    username: z.string().min(1),
    password: z.string().min(1).optional(),
    passwordEnv: z.string().min(1).optional(),
    label: z.string().optional(),
    readOnly: z.boolean().default(false),
    provision: z.boolean().default(false),
    pjsipFile: z.string().optional(),
    trunkAllow: z.array(z.string()).default([]),
    contextAllow: z.array(z.string()).default([]),
    dialplanHint: z.string().optional(),
  })
  .strict();
const fileSchema = z.object({ targets: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, "target names must match ^[A-Za-z0-9_-]{1,32}$"), entrySchema) }).strict();

/**
 * Load the named targets: the env-only `default` (when ASTERISK_AMI_HOST is set) plus
 * the file's targets. Errors never echo a password or an environment value.
 */
export function loadTargets(
  cfg: Config,
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = (m) => console.error(m)
): TargetEntry[] {
  const out: TargetEntry[] = [];
  if (cfg.asterisk) {
    out.push({
      name: DEFAULT,
      label: DEFAULT,
      host: cfg.asterisk.host,
      port: cfg.asterisk.port,
      tls: cfg.asterisk.tls,
      username: cfg.asterisk.username,
      password: cfg.asterisk.password,
      readOnly: false,
      provision: cfg.allowProvision,
      pjsipFile: cfg.pjsipFile,
      trunkAllow: cfg.trunkAllow,
      contextAllow: cfg.contextAllow,
    });
  }
  if (!cfg.targetsFile) return out;

  const file = cfg.targetsFile;
  let raw: unknown;
  try {
    const mode = fs.statSync(file).mode;
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (mode & 0o077 && JSON.stringify(raw).includes('"password"')) {
      warn(`pbx-mcp: ${file} holds literal passwords and is readable by group/other; chmod 600 it or use passwordEnv.`);
    }
  } catch (err) {
    // JSON.parse messages quote file content, so never pass them on.
    const why = err instanceof SyntaxError ? "is not valid JSON" : `cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})`;
    throw new Error(`PBX_MCP_TARGETS_FILE ${file} ${why}.`);
  }

  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ");
    throw new Error(`PBX_MCP_TARGETS_FILE ${file} is invalid: ${issues}`);
  }

  for (const [name, t] of Object.entries(parsed.data.targets)) {
    if (name === DEFAULT) throw new Error(`PBX_MCP_TARGETS_FILE: a target may not be named "${DEFAULT}" (that name is the environment target).`);
    if ((t.password === undefined) === (t.passwordEnv === undefined)) {
      throw new Error(`Target "${name}": set exactly one of password or passwordEnv.`);
    }
    let password = t.password;
    if (t.passwordEnv !== undefined) {
      password = env[t.passwordEnv];
      if (!password) throw new Error(`Target "${name}": environment variable ${t.passwordEnv} is not set.`);
    }
    const pjsipFile = t.pjsipFile ?? cfg.pjsipFile;
    if (t.provision) {
      try {
        assertPjsipFile(pjsipFile);
      } catch (err) {
        throw new Error(`Target "${name}": ${(err as Error).message}`);
      }
    }
    out.push({
      name,
      label: t.label ?? name,
      host: t.host,
      port: t.port,
      tls: t.tls,
      username: t.username,
      password: password!,
      readOnly: t.readOnly,
      provision: t.provision,
      pjsipFile,
      trunkAllow: t.trunkAllow,
      contextAllow: t.contextAllow,
      dialplanHint: t.dialplanHint,
    });
  }
  return out;
}

/** Normalise an IP literal for the allow check; undefined when it is not an acceptable IP literal. */
function ipLiteral(host: string): string | undefined {
  if (host.includes("%") || !net.isIP(host)) return undefined;
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (dotted && net.isIPv4(dotted[1])) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return host;
}

function hostAllowList(entries: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const entry of entries) {
    const [base, bits, ...extra] = entry.split("/");
    const family = net.isIPv4(base) ? "ipv4" : net.isIPv6(base) ? "ipv6" : undefined;
    const max = family === "ipv4" ? 32 : 128;
    if (!family || extra.length || (bits !== undefined && !(/^\d{1,3}$/.test(bits) && Number(bits) <= max))) {
      throw new Error(`PBX_MCP_HOST_ALLOW entry "${entry}" is not a valid CIDR.`);
    }
    if (bits === undefined) list.addAddress(base, family);
    else list.addSubnet(base, Number(bits), family);
  }
  return list;
}

export type SelectArgs = { name: string } | { host: string; port?: number; tls?: boolean };

interface Held {
  entry: TargetEntry;
  get: () => Promise<AmiClient>;
  clients: AmiClient[];
  adhoc: boolean;
  evicted: boolean;
}

export class TargetRegistry {
  private named = new Map<string, Held>();
  private adhoc?: Held;
  private selected?: Held;
  private allow: net.BlockList;
  /** One Provisioner per provisioning-enabled named target, keeping that target's write queue. */
  private provisioners = new Map<string, Provisioner>();

  constructor(
    entries: TargetEntry[],
    private opts: { hostAllow: string[]; adhocPorts: number[]; adhocBase?: TargetEntry; timeoutMs: number }
  ) {
    if (opts.adhocPorts.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
      throw new Error("PBX_MCP_ADHOC_PORTS must be a comma-separated list of ports (1-65535).");
    }
    this.allow = hostAllowList(opts.hostAllow);
    for (const e of entries) {
      const held = this.hold(e, false);
      this.named.set(e.name, held);
      // Bound to this target's own client and gates, whatever is selected later.
      if (e.provision && !e.readOnly) {
        this.provisioners.set(e.name, new Provisioner(held.get, { file: e.pjsipFile, trunkAllow: e.trunkAllow, contextAllow: e.contextAllow }));
      }
    }
    // A single named target needs no selection.
    if (this.named.size === 1) this.selected = [...this.named.values()][0];
  }

  private hold(entry: TargetEntry, adhoc: boolean): Held {
    const held: Held = { entry, adhoc, evicted: false, clients: [], get: undefined as never };
    held.get = lazyClient(
      () => {
        const c = new AmiClient({ host: entry.host, port: entry.port, username: entry.username, password: entry.password, tls: entry.tls, timeoutMs: this.opts.timeoutMs });
        held.clients.push(c);
        return c;
      },
      (c) => c.isConnected
    );
    return held;
  }

  /** True when any Asterisk target exists or ad hoc selection is configured. */
  get active(): boolean {
    return this.named.size > 0 || this.opts.hostAllow.length > 0;
  }

  get namedCount(): number {
    return this.named.size;
  }

  list(): Array<Identity & { selected: boolean; provision: boolean }> {
    return [...this.named.values()].map((h) => ({ ...this.identityOf(h), selected: this.selected === h, provision: this.provisioners.has(h.entry.name) }));
  }

  /** The provisioner for a named target; undefined for ad hoc, readOnly and provision:false targets. */
  provisionerFor(name: string): Provisioner | undefined {
    return this.provisioners.get(name);
  }

  /** Synchronous: the selection is assigned before the caller can interleave. */
  select(args: SelectArgs): Identity {
    if ("name" in args) {
      const held = this.named.get(args.name);
      if (!held) throw new Error(`Unknown target "${args.name}". Known: ${[...this.named.keys()].join(", ") || "none"}.`);
      this.selected = held;
      this.dropAdhoc();
      return this.identityOf(held);
    }

    const host = ipLiteral(args.host);
    if (!host) throw new Error("Ad hoc targets must be an IP literal (hostnames need a named target).");
    if (!this.opts.hostAllow.length) throw new Error("Ad hoc targets are disabled: PBX_MCP_HOST_ALLOW is not set.");
    if (!this.allow.check(host, net.isIPv4(host) ? "ipv4" : "ipv6")) throw new Error(`Host ${host} is not inside PBX_MCP_HOST_ALLOW.`);
    const port = args.port ?? 5038;
    if (!this.opts.adhocPorts.includes(port)) throw new Error(`Port ${port} is not on PBX_MCP_ADHOC_PORTS.`);
    const base = this.opts.adhocBase;
    if (!base) throw new Error("Ad hoc targets need the default credentials (ASTERISK_AMI_USERNAME/PASSWORD) in the environment.");

    const tls = args.tls ?? base.tls;
    const cur = this.adhoc;
    if (cur && cur.entry.host === host && cur.entry.port === port && cur.entry.tls === tls) {
      this.selected = cur;
      return this.identityOf(cur);
    }
    this.dropAdhoc();
    const label = `ad hoc ${host}:${port}`;
    this.adhoc = this.hold(
      { ...base, name: label, label, host, port, tls, readOnly: true, provision: false, trunkAllow: [], contextAllow: [], dialplanHint: undefined },
      true
    );
    this.selected = this.adhoc;
    return this.identityOf(this.adhoc);
  }

  /** Close the one live ad hoc client; its snapshots can no longer reconnect. */
  private dropAdhoc(): void {
    const h = this.adhoc;
    if (!h) return;
    h.evicted = true;
    h.clients.forEach((c) => c.close());
    this.adhoc = undefined;
    if (this.selected === h) this.selected = undefined;
  }

  private identityOf(h: Held): Identity {
    const e = h.entry;
    return { name: e.name, label: e.label, host: e.host, port: e.port, dialplanHint: e.dialplanHint, readOnly: e.readOnly };
  }

  private current(): Held {
    if (!this.selected) throw new Error(NO_TARGET);
    return this.selected;
  }

  /** Secret-free identity of the selected target; throws no_target_selected. */
  identity(): Identity {
    return this.identityOf(this.current());
  }

  /** The selected target, fixed at the moment of the call. */
  snapshot(): Snapshot {
    const h = this.current();
    return {
      ...this.identityOf(h),
      getClient: async () => {
        if (h.evicted) throw new Error("target no longer selected");
        let client: AmiClient;
        try {
          client = await h.get();
        } catch (err) {
          throw h.evicted ? new Error("target no longer selected") : err;
        }
        // Eviction can land while the holder was connecting or retrying: never hand out (or leave open) a client of an evicted target.
        if (h.evicted) {
          h.clients.forEach((c) => c.close());
          throw new Error("target no longer selected");
        }
        return client;
      },
    };
  }

  /** Client for whatever is selected now, read synchronously before the first await. */
  getClient = (): Promise<AmiClient> => {
    try {
      return this.snapshot().getClient();
    } catch (err) {
      return Promise.reject(err);
    }
  };
}

/** Build the registry for this process from the already-loaded Config. */
export function createRegistry(cfg: Config, env: NodeJS.ProcessEnv = process.env, warn?: (m: string) => void): TargetRegistry {
  const entries = loadTargets(cfg, env, warn);
  // Ad hoc targets reuse the default env credentials, whether or not a default host is set.
  const username = env.ASTERISK_AMI_USERNAME ?? "";
  const password = env.ASTERISK_AMI_PASSWORD ?? "";
  const adhocBase: TargetEntry | undefined =
    username && password
      ? {
          name: DEFAULT, label: DEFAULT, host: "", port: 5038, tls: /^(1|true|yes)$/i.test(env.ASTERISK_AMI_TLS ?? ""),
          username, password, readOnly: true, provision: false, pjsipFile: cfg.pjsipFile, trunkAllow: [], contextAllow: [],
        }
      : undefined;
  return new TargetRegistry(entries, { hostAllow: cfg.hostAllow, adhocPorts: cfg.adhocPorts, adhocBase, timeoutMs: cfg.timeoutMs });
}
