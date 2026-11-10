import { connect as connectTls, type TLSSocket } from "node:tls";

const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const CONNECTION_TIMEOUT_MS = 20_000;

/** Serialized framing interface for a TLS IMAP/SMTP session. */
export interface MailWire {
  readLine(): Promise<string>;
  readBytes(size: number): Promise<Buffer>;
  write(value: string | Buffer): Promise<void>;
  close(): void;
}

export type MailWireFactory = (host: string, port: number) => Promise<MailWire>;

/**
 * Minimal TLS byte stream framing. TLS certificate and hostname validation
 * remain enabled; neither plaintext fallback nor STARTTLS downgrade is used.
 */
export class TlsMailWire implements MailWire {
  private bytes = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private failure: Error | null = null;

  private constructor(private readonly socket: TLSSocket) {
    socket.setTimeout(CONNECTION_TIMEOUT_MS, () => this.abort());
    socket.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      if (this.bytes.length + chunk.length > MAX_BUFFER) {
        this.abort();
        return;
      }
      this.bytes = Buffer.concat([this.bytes, chunk]);
      this.notify();
    });
    socket.on("error", () => this.abort());
    socket.on("close", () => this.abort());
  }

  static async connect(host: string, port: number): Promise<TlsMailWire> {
    if (!/^[a-z0-9.-]+$/i.test(host) || port < 1 || port > 65535) {
      throw new Error("Invalid mail server destination");
    }
    return new Promise<TlsMailWire>((resolve, reject) => {
      const socket = connectTls({
        host, port, servername: host, rejectUnauthorized: true,
        minVersion: "TLSv1.2", timeout: CONNECTION_TIMEOUT_MS,
      });
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error("Unable to establish a verified TLS mail connection"));
      };
      socket.once("error", fail);
      socket.once("timeout", fail);
      socket.once("secureConnect", () => {
        if (settled) return;
        if (!socket.authorized) { fail(); return; }
        settled = true;
        socket.off("error", fail);
        socket.off("timeout", fail);
        resolve(new TlsMailWire(socket));
      });
    });
  }

  private notify(): void {
    const wake = this.waiter;
    this.waiter = null;
    wake?.();
  }

  private abort(): void {
    if (this.failure) return;
    this.failure = new Error("Mail connection closed or exceeded safety limits");
    this.socket.destroy();
    this.notify();
  }

  private async more(): Promise<void> {
    if (this.failure) throw this.failure;
    await new Promise<void>(resolve => { this.waiter = resolve; });
    if (this.failure) throw this.failure;
  }

  async readLine(): Promise<string> {
    while (true) {
      const end = this.bytes.indexOf("\r\n");
      if (end >= 0) {
        if (end > MAX_LINE) { this.abort(); throw new Error("Mail protocol line too large"); }
        const line = this.bytes.subarray(0, end).toString("utf8");
        this.bytes = this.bytes.subarray(end + 2);
        return line;
      }
      if (this.bytes.length > MAX_LINE) {
        this.abort();
        throw new Error("Mail protocol line too large");
      }
      await this.more();
    }
  }

  async readBytes(size: number): Promise<Buffer> {
    if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024) {
      throw new Error("Mail header literal exceeds safe limit");
    }
    while (this.bytes.length < size) await this.more();
    const result = Buffer.from(this.bytes.subarray(0, size));
    this.bytes = this.bytes.subarray(size);
    return result;
  }

  async write(value: string | Buffer): Promise<void> {
    if (this.failure || this.socket.destroyed) throw new Error("Mail connection is unavailable");
    await new Promise<void>((resolve, reject) => {
      this.socket.write(value, error => error
        ? reject(new Error("Mail connection write failed")) : resolve());
    });
  }

  close(): void {
    this.abort();
  }
}

export const connectMailTls: MailWireFactory = (host, port) => TlsMailWire.connect(host, port);
