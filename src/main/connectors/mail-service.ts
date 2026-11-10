import { randomUUID } from "node:crypto";
import {
  parseCampusMailCredentials, parseMailDraft,
  type CampusMailCredentials, type MailDraft,
  type MailRecord, type MailSendPreview, type MailSyncState,
} from "../../shared/mail-model";
import { ImapInboxReader } from "./mail-imap";
import { SmtpSender } from "./mail-smtp";
import { CampusMailVault } from "./mail-vault";
import { CampusMailStore } from "./mail-store";

const POLL_MINUTES = 10;
const SEND_CONFIRM_WINDOW_MS = 2 * 60 * 1000;

/**
 * Mail authorization, periodic read-only synchronization and explicit send
 * confirmation are separate. SMTP is never called by a scheduled sync.
 */
export class CampusMailService {
  private pending: Promise<MailSyncState> | null = null;
  private sendIntent: {id:string;from:string;draft:MailDraft;expires:number}|null = null;
  private interval: ReturnType<typeof setInterval>|null = null;
  private generation = 0;
  private state: MailSyncState = {
    connected:false,email:null,running:false,lastAttempt:null,
    lastSuccess:null,lastError:null,messageCount:0,
  };

  constructor(
    private readonly vault: CampusMailVault,
    private readonly store: CampusMailStore,
    private readonly reader: Pick<ImapInboxReader,"readRecent"> = new ImapInboxReader(),
    private readonly sender: Pick<SmtpSender,"send"> = new SmtpSender(),
    private readonly notify: () => void = () => {},
  ) {}

  snapshot(): MailSyncState {
    return {...this.state,running:this.pending !== null};
  }

  async initialize(): Promise<void> {
    const saved = await this.vault.load();
    this.state = {...this.state,connected:saved!==null,email:saved?.email ?? null,
      messageCount:saved ? this.store.count(saved.email) : 0};
    this.notify();
  }

  start(isWindowOpen:()=>boolean): void {
    if (this.interval) return;
    this.interval=setInterval(() => {
      if (isWindowOpen() && this.state.connected) void this.sync();
    },POLL_MINUTES*60*1000);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval=null;
  }

  /** Cancel outstanding read-only sync writes and clear pending send approval. */
  cancel(): void {
    this.generation++;
    this.pending=null;
    this.sendIntent=null;
  }

  async connect(input: unknown): Promise<MailSyncState> {
    const credentials = parseCampusMailCredentials(input);
    // First verify real IMAP access; wrong credentials are never persisted.
    const remote = await this.reader.readRecent(credentials);
    await this.vault.save(credentials);
    this.store.merge(credentials.email,remote.uidValidity,remote.messages);
    this.generation++;
    this.sendIntent=null;
    this.state={connected:true,email:credentials.email,running:false,
      lastAttempt:new Date().toISOString(),lastSuccess:new Date().toISOString(),
      lastError:null,messageCount:this.store.count(credentials.email)};
    this.notify();
    return this.snapshot();
  }

  sync(): Promise<MailSyncState> {
    if (this.pending) return this.pending;
    const generation=this.generation;
    const work=this.execute(generation).finally(() => {
      if (this.pending===work) this.pending=null;
      this.notify();
    });
    this.pending=work;
    this.notify();
    return work;
  }

  private async execute(generation:number):Promise<MailSyncState>{
    const attempt=new Date().toISOString();
    this.state={...this.state,lastAttempt:attempt,running:true,lastError:null};
    try {
      const credentials=await this.vault.load();
      if (!credentials) {
        if (generation===this.generation) {
          this.state={connected:false,email:null,running:false,lastAttempt:attempt,
            lastSuccess:null,lastError:null,messageCount:0};
        }
        return this.snapshot();
      }
      const result=await this.reader.readRecent(credentials);
      if (generation!==this.generation) return this.snapshot();
      this.store.merge(credentials.email,result.uidValidity,result.messages);
      this.state={connected:true,email:credentials.email,running:false,
        lastAttempt:attempt,lastSuccess:new Date().toISOString(),
        lastError:null,messageCount:this.store.count(credentials.email)};
      return this.snapshot();
    } catch {
      if (generation===this.generation) {
        this.state={...this.state,running:false,lastAttempt:attempt,
          lastError:"邮箱同步失败。请检查连接、邮箱授权及密码。已有邮件列表保持不变。"};
      }
      return this.snapshot();
    }
  }

  async list(): Promise<MailRecord[]> {
    const saved=await this.vault.load();
    return saved ? this.store.list(saved.email) : [];
  }

  async disconnect():Promise<void> {
    const saved=await this.vault.load();
    this.generation++;
    this.pending=null;
    this.sendIntent=null;
    await this.vault.clear();
    if (saved) this.store.clear(saved.email);
    this.state={connected:false,email:null,running:false,
      lastAttempt:null,lastSuccess:null,lastError:null,messageCount:0};
    this.notify();
  }

  /** Preview is a required manual step before the confirmation nonce is valid. */
  async prepareSend(input:unknown):Promise<MailSendPreview>{
    const draft=parseMailDraft(input);
    const saved=await this.vault.load();
    if (!saved) throw new Error("Connect your campus email before composing mail");
    const id=randomUUID();
    const expires=Date.now()+SEND_CONFIRM_WINDOW_MS;
    this.sendIntent={id,from:saved.email,draft,expires};
    return {...draft,from:saved.email,confirmationId:id,
      expiresAt:new Date(expires).toISOString()};
  }

  async confirmSend(id:unknown):Promise<{accepted:true}>{
    if (typeof id!=="string" || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new Error("Invalid email send confirmation");
    }
    const intent=this.sendIntent;
    this.sendIntent=null; // one-time even on SMTP errors, prevents accidental retry.
    if (!intent || intent.id!==id || intent.expires<Date.now()) {
      throw new Error("Mail confirmation expired. Preview and confirm the draft again");
    }
    const credentials=await this.vault.load();
    if (!credentials || credentials.email!==intent.from) {
      throw new Error("Mailbox changed; compose the message again");
    }
    await this.sender.send(credentials,intent.draft);
    return {accepted:true};
  }
}
