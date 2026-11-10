import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import {
  dueDay, nextReviewInterval, parseKnowledgeQuery, parseReviewCardInput,
  parseReviewRating, requireKnowledgeId, utcDay,
  type KnowledgeDocument, type KnowledgeSnapshot, type KnowledgeSearchHit,
  type KnowledgeReviewCard, type ReviewProgress, type ReviewRating, type KnowledgePassage,
} from "../shared/knowledge-model";
import {parseGraphNode,parseGraphNodeEdit,parseGraphEdge,
  type KnowledgeGraphSnapshot,type GraphNode,type GraphEdge} from "../shared/knowledge-graph-model";

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const CHUNK_LENGTH = 1100;
const CHUNK_OVERLAP = 100;
const MAX_CHUNKS = 2500;

interface DocumentRow {
  id: string; title: string; format: "markdown"|"text"|"pdf";page_count:number|null;
  content_hash: string; byte_length: number; chunk_count: number;
  imported_at: string; updated_at: string; revision: number;
}
interface CardRow {
  id:string; document_id:string; title:string; source_ordinal:number;
  evidence:string; source_hash:string; source_page:number|null; needs_review:number;
  question:string;answer:string;interval_days:number;review_count:number;
  next_due:string;created_at:string;updated_at:string;
}
function fromDocument(row: DocumentRow):KnowledgeDocument {
  return {
    id:row.id,title:row.title,format:row.format,
    contentHash:row.content_hash,byteLength:row.byte_length,chunkCount:row.chunk_count,
    importedAt:row.imported_at,updatedAt:row.updated_at,revision:row.revision,
    pageCount:row.page_count??null,
  };
}
function fromCard(row:CardRow):KnowledgeReviewCard {
  return {
    id:row.id,documentId:row.document_id,documentTitle:row.title,
    sourceOrdinal:row.source_ordinal,evidence:row.evidence,
    sourceHash:row.source_hash,sourcePage:row.source_page??null,
    needsReview:row.needs_review===1,
    question:row.question,answer:row.answer,
    intervalDays:row.interval_days,reviewCount:row.review_count,
    nextDue:row.next_due,createdAt:row.created_at,updatedAt:row.updated_at,
  };
}
function chunks(text:string):string[] {
  const units=Array.from(text);
  const out:string[]=[];
  const step=CHUNK_LENGTH-CHUNK_OVERLAP;
  for(let pos=0;pos<units.length;pos+=step) {
    out.push(units.slice(pos,pos+CHUNK_LENGTH).join(""));
    if(out.length>MAX_CHUNKS)throw new Error("Document exceeds knowledge index chunk limit");
    if(pos+CHUNK_LENGTH>=units.length)break;
  }
  return out;
}

export class KnowledgeStore {
  private readonly db:DatabaseSync;
  constructor(path:string) {
    if(path!==":memory:")mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
    if(path!==":memory:")this.db.exec("PRAGMA journal_mode=WAL");
    this.migrate();
  }
  private migrate():void{
    const version=(this.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version;
    if(version>3)throw new Error("Knowledge database is from a newer application");
    if(version===0){this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.exec(`
        CREATE TABLE knowledge_documents(
          id TEXT PRIMARY KEY, source_path TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('markdown','text')),
          content TEXT NOT NULL, content_hash TEXT NOT NULL,
          byte_length INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          imported_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE knowledge_chunks(
          id INTEGER PRIMARY KEY, document_id TEXT NOT NULL
            REFERENCES knowledge_documents(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL, body TEXT NOT NULL,
          UNIQUE(document_id,ordinal)
        );
        CREATE INDEX knowledge_chunks_document ON knowledge_chunks(document_id,ordinal);
        CREATE VIRTUAL TABLE knowledge_fts USING fts5(
          body, content='knowledge_chunks', content_rowid='id', tokenize='trigram'
        );
        CREATE TRIGGER knowledge_chunk_insert AFTER INSERT ON knowledge_chunks BEGIN
          INSERT INTO knowledge_fts(rowid,body) VALUES (new.id,new.body);
        END;
        CREATE TRIGGER knowledge_chunk_delete AFTER DELETE ON knowledge_chunks BEGIN
          INSERT INTO knowledge_fts(knowledge_fts,rowid,body)
          VALUES('delete',old.id,old.body);
        END;
        CREATE TRIGGER knowledge_chunk_update AFTER UPDATE OF body ON knowledge_chunks BEGIN
          INSERT INTO knowledge_fts(knowledge_fts,rowid,body)
          VALUES('delete',old.id,old.body);
          INSERT INTO knowledge_fts(rowid,body) VALUES(new.id,new.body);
        END;
        CREATE TABLE knowledge_cards(
          id TEXT PRIMARY KEY, document_id TEXT NOT NULL
            REFERENCES knowledge_documents(id) ON DELETE CASCADE,
          source_ordinal INTEGER NOT NULL, evidence TEXT NOT NULL,
          source_hash TEXT NOT NULL, needs_review INTEGER NOT NULL DEFAULT 0,
          question TEXT NOT NULL, answer TEXT NOT NULL,
          interval_days INTEGER NOT NULL DEFAULT 0, review_count INTEGER NOT NULL DEFAULT 0,
          next_due TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(document_id,question)
        );
        CREATE INDEX knowledge_cards_due ON knowledge_cards(next_due);
        CREATE TABLE knowledge_review_attempts(
          card_id TEXT NOT NULL REFERENCES knowledge_cards(id) ON DELETE CASCADE,
          review_day TEXT NOT NULL, rating TEXT NOT NULL
            CHECK(rating IN ('again','hard','good','easy')),
          interval_days INTEGER NOT NULL, reviewed_at TEXT NOT NULL,
          PRIMARY KEY(card_id,review_day)
        );
        PRAGMA user_version=1;
      `);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    }
    if(version<=1){
      this.db.exec("BEGIN IMMEDIATE");
      try{
        this.db.exec(`
          CREATE TABLE knowledge_pdf_sources(
            document_id TEXT PRIMARY KEY REFERENCES knowledge_documents(id) ON DELETE CASCADE,
            file_hash TEXT NOT NULL,
            page_count INTEGER NOT NULL CHECK(page_count BETWEEN 1 AND 120)
          );
          CREATE TABLE knowledge_chunk_pages(
            document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            page_number INTEGER NOT NULL CHECK(page_number BETWEEN 1 AND 120),
            PRIMARY KEY(document_id,ordinal)
          );
          ALTER TABLE knowledge_cards ADD COLUMN source_page INTEGER;
          PRAGMA user_version=2;
        `);
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
    }
    if(version<=2){
      this.db.exec("BEGIN IMMEDIATE");
      try{
        this.db.exec(`
          CREATE TABLE knowledge_graph_nodes(
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
            source_ordinal INTEGER NOT NULL,
            source_revision INTEGER NOT NULL,
            source_page INTEGER,
            source_hash TEXT NOT NULL,
            evidence TEXT NOT NULL,
            title TEXT NOT NULL,
            note TEXT NOT NULL,
            needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(document_id,source_ordinal,title)
          );
          CREATE INDEX knowledge_graph_nodes_doc ON knowledge_graph_nodes(document_id);
          CREATE TABLE knowledge_graph_edges(
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL REFERENCES knowledge_graph_nodes(id) ON DELETE CASCADE,
            target_id TEXT NOT NULL REFERENCES knowledge_graph_nodes(id) ON DELETE CASCADE,
            relation TEXT NOT NULL CHECK(relation IN ('related','supports','contrasts')),
            note TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending','confirmed')),
            created_at TEXT NOT NULL,
            CHECK(source_id<>target_id),
            UNIQUE(source_id,target_id,relation)
          );
          CREATE INDEX knowledge_graph_edges_target ON knowledge_graph_edges(target_id);
          PRAGMA user_version=3;
        `);
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
    }
  }

  close():void{this.db.close();}
  async backupTo(path:string):Promise<number>{return backup(this.db,path);}

  listDocuments():KnowledgeDocument[]{
    return (this.db.prepare(`SELECT d.id,d.title,
      CASE WHEN pdf.document_id IS NULL THEN d.format ELSE 'pdf' END AS format,
      d.content_hash,d.byte_length,d.chunk_count,d.imported_at,d.updated_at,d.revision,
      pdf.page_count
      FROM knowledge_documents d LEFT JOIN knowledge_pdf_sources pdf ON pdf.document_id=d.id
      ORDER BY d.updated_at DESC
    `).all() as unknown as DocumentRow[]).map(fromDocument);
  }
  getDocument(input:unknown):KnowledgeSnapshot{
    const id=requireKnowledgeId(input);
    const row=this.db.prepare(`SELECT d.id,d.title,
      CASE WHEN pdf.document_id IS NULL THEN d.format ELSE 'pdf' END AS format,
      d.content_hash,d.byte_length,d.chunk_count,d.imported_at,d.updated_at,d.revision,
      d.source_path,d.content,pdf.page_count
      FROM knowledge_documents d LEFT JOIN knowledge_pdf_sources pdf ON pdf.document_id=d.id
      WHERE d.id=?`).get(id) as
      (DocumentRow & {source_path:string;content:string})|undefined;
    if(!row)throw new Error("Knowledge document was not found");
    return {...fromDocument(row),text:row.content,sourcePath:row.source_path};
  }

  getPassage(input:unknown,ordinalInput:unknown):KnowledgePassage{
    const id=requireKnowledgeId(input);
    if(!Number.isSafeInteger(ordinalInput) || (ordinalInput as number)<0 ||
       (ordinalInput as number)>2500)throw Error("Invalid document passage");
    const row=this.db.prepare(`
      SELECT c.document_id,c.ordinal,c.body,cp.page_number,d.title,d.revision
      FROM knowledge_chunks c
      JOIN knowledge_documents d ON d.id=c.document_id
      LEFT JOIN knowledge_chunk_pages cp
        ON cp.document_id=c.document_id AND cp.ordinal=c.ordinal
      WHERE c.document_id=? AND c.ordinal=?
    `).get(id,ordinalInput as number) as {
      document_id:string;ordinal:number;body:string;page_number:number|null;
      title:string;revision:number;
    }|undefined;
    if(!row)throw Error("Document passage was not found");
    return {documentId:row.document_id,documentTitle:row.title,
      revision:row.revision,ordinal:row.ordinal,pageNumber:row.page_number??null,
      body:row.body};
  }

  /** Called only after Electron's native file-picker grants access to a path. */
  importText(source:{sourcePath:string;title:string;format:"markdown"|"text";text:string},now=new Date()):
    {document:KnowledgeDocument;changed:boolean}{
    if(typeof source.sourcePath!=="string" || !source.sourcePath ||
       typeof source.title!=="string" || !source.title.trim() ||
       source.title.length>255 || (source.format!=="markdown"&&source.format!=="text") ||
       typeof source.text!=="string" || !source.text.trim())throw Error("Invalid knowledge source");
    const length=Buffer.byteLength(source.text,"utf8");
    if(length>MAX_DOCUMENT_BYTES)throw Error("Document exceeds 2 MiB limit");
    const text=source.text.replace(/\r\n/g,"\n");
    const hash=createHash("sha256").update(text).digest("hex");
    const previous=this.db.prepare("SELECT id,content_hash FROM knowledge_documents WHERE source_path=?")
      .get(source.sourcePath) as {id:string;content_hash:string}|undefined;
    if(previous?.content_hash===hash)return {document:this.getDocument(previous.id),changed:false};
    const id=previous?.id??randomUUID(),stamp=now.toISOString(),parts=chunks(text);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      if(previous){
        this.db.prepare(`UPDATE knowledge_documents SET title=?,format=?,content=?,
          content_hash=?,byte_length=?,chunk_count=?,revision=revision+1,updated_at=?
          WHERE id=?`).run(source.title,source.format,text,hash,length,parts.length,stamp,id);
        this.db.prepare("UPDATE knowledge_cards SET needs_review=1 WHERE document_id=?").run(id);
        this.db.prepare("UPDATE knowledge_graph_nodes SET needs_review=1 WHERE document_id=?").run(id);
        this.db.prepare("DELETE FROM knowledge_chunk_pages WHERE document_id=?").run(id);
        this.db.prepare("DELETE FROM knowledge_pdf_sources WHERE document_id=?").run(id);
        this.db.prepare("DELETE FROM knowledge_chunks WHERE document_id=?").run(id);
      }else{
        this.db.prepare(`INSERT INTO knowledge_documents
          (id,source_path,title,format,content,content_hash,byte_length,chunk_count,
           revision,imported_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,1,?,?)`).run(
            id,source.sourcePath,source.title,source.format,text,hash,length,parts.length,stamp,stamp);
      }
      const insert=this.db.prepare("INSERT INTO knowledge_chunks(document_id,ordinal,body) VALUES(?,?,?)");
      parts.forEach((part,index)=>insert.run(id,index,part));
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    return {document:this.getDocument(id),changed:true};
  }

  /** Stores PDF text snapshots with stable source page citations, never PDF binary. */
  importPdf(source:{
    sourcePath:string;title:string;format:"pdf";pages:string[];
    fileHash:string;byteLength:number;
  },now=new Date()):{document:KnowledgeDocument;changed:boolean}{
    if(!source || source.format!=="pdf" || typeof source.sourcePath!=="string" ||
       !source.sourcePath || typeof source.title!=="string" || !source.title.trim() ||
       source.title.length>255 || !/^[a-f0-9]{64}$/.test(source.fileHash) ||
       !Number.isSafeInteger(source.byteLength) || source.byteLength<1 ||
       source.byteLength>12*1024*1024 || !Array.isArray(source.pages) ||
       source.pages.length<1 || source.pages.length>120 ||
       !source.pages.every(p=>typeof p==="string" && !p.includes("\0")))
      throw Error("Invalid local PDF import");
    const indexed:{body:string;pageNumber:number}[]=[];
    let textBytes=0;
    for(let index=0;index<source.pages.length;index++){
      const page=source.pages[index].replace(/\r\n/g,"\n");
      textBytes+=Buffer.byteLength(page,"utf8");
      if(textBytes>MAX_DOCUMENT_BYTES)throw Error("PDF extracted text exceeds 2 MiB");
      for(const body of chunks(page))indexed.push({body,pageNumber:index+1});
    }
    if(!indexed.length || indexed.length>MAX_CHUNKS)
      throw Error("PDF has no selectable text or exceeds index limits");
    const text=source.pages.map((p,index)=>"[Page "+(index+1)+"]\n"+p).join("\n\n");
    const previous=this.db.prepare(`SELECT d.id,d.content_hash,pdf.file_hash
      FROM knowledge_documents d LEFT JOIN knowledge_pdf_sources pdf ON d.id=pdf.document_id
      WHERE d.source_path=?`).get(source.sourcePath) as
      {id:string;content_hash:string;file_hash:string|null}|undefined;
    if(previous?.file_hash===source.fileHash)
      return {document:this.getDocument(previous.id),changed:false};
    const id=previous?.id??randomUUID(),stamp=now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try{
      if(previous){
        this.db.prepare(`UPDATE knowledge_documents SET title=?,format='text',content=?,
          content_hash=?,byte_length=?,chunk_count=?,revision=revision+1,updated_at=?
          WHERE id=?`).run(source.title,text,source.fileHash,source.byteLength,indexed.length,stamp,id);
        this.db.prepare("UPDATE knowledge_cards SET needs_review=1 WHERE document_id=?").run(id);
        this.db.prepare("UPDATE knowledge_graph_nodes SET needs_review=1 WHERE document_id=?").run(id);
        this.db.prepare("DELETE FROM knowledge_chunk_pages WHERE document_id=?").run(id);
        this.db.prepare("DELETE FROM knowledge_chunks WHERE document_id=?").run(id);
      }else{
        this.db.prepare(`INSERT INTO knowledge_documents(
          id,source_path,title,format,content,content_hash,byte_length,chunk_count,
          revision,imported_at,updated_at
        ) VALUES(?,?,?,'text',?,?,?,?,1,?,?)`).run(
          id,source.sourcePath,source.title,text,source.fileHash,
          source.byteLength,indexed.length,stamp,stamp);
      }
      this.db.prepare(`INSERT INTO knowledge_pdf_sources(document_id,file_hash,page_count)
        VALUES(?,?,?) ON CONFLICT(document_id) DO UPDATE SET
        file_hash=excluded.file_hash,page_count=excluded.page_count`)
        .run(id,source.fileHash,source.pages.length);
      const insertChunk=this.db.prepare(
        "INSERT INTO knowledge_chunks(document_id,ordinal,body) VALUES(?,?,?)");
      const insertPage=this.db.prepare(
        "INSERT INTO knowledge_chunk_pages(document_id,ordinal,page_number) VALUES(?,?,?)");
      indexed.forEach((part,index)=>{
        insertChunk.run(id,index,part.body);
        insertPage.run(id,index,part.pageNumber);
      });
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    return {document:this.getDocument(id),changed:true};
  }

  deleteDocument(input:unknown):boolean{
    const id=requireKnowledgeId(input);
    return Number(this.db.prepare("DELETE FROM knowledge_documents WHERE id=?").run(id).changes)===1;
  }

  search(value:unknown):KnowledgeSearchHit[]{
    const query=parseKnowledgeQuery(value);
    const long=Array.from(query).length>=3;
    const rows=long ?
      this.db.prepare(`
        SELECT c.document_id,c.ordinal,c.body,d.title,d.revision,cp.page_number
        FROM knowledge_fts JOIN knowledge_chunks c ON c.id=knowledge_fts.rowid
        JOIN knowledge_documents d ON d.id=c.document_id
        LEFT JOIN knowledge_chunk_pages cp ON cp.document_id=c.document_id AND cp.ordinal=c.ordinal
        WHERE knowledge_fts MATCH ?
        ORDER BY bm25(knowledge_fts) LIMIT 40
      `).all('"' + query.replace(/"/g,'""') + '"') :
      this.db.prepare(`
        SELECT c.document_id,c.ordinal,c.body,d.title,d.revision,cp.page_number
        FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id
        LEFT JOIN knowledge_chunk_pages cp ON cp.document_id=c.document_id AND cp.ordinal=c.ordinal
        WHERE instr(lower(c.body),lower(?))>0 OR instr(lower(d.title),lower(?))>0
        ORDER BY d.updated_at DESC,c.ordinal LIMIT 40
      `).all(query,query);
    return (rows as unknown as {
      document_id:string;ordinal:number;body:string;title:string;revision:number;page_number:number|null
    }[]).map(row=>{
      const idx=row.body.toLowerCase().indexOf(query.toLowerCase());
      const start=idx<0?0:Math.max(0,idx-100);
      return {
        documentId:row.document_id,documentTitle:row.title,
        documentRevision:row.revision,ordinal:row.ordinal,pageNumber:row.page_number??null,
        excerpt:row.body.slice(start,start+500),
      };
    });
  }

  /** All graph records are local. Evidence is copied from the current trusted FTS passage. */
  graph():KnowledgeGraphSnapshot{
    const nodes=(this.db.prepare(`SELECT n.*,d.title AS document_title
      FROM knowledge_graph_nodes n JOIN knowledge_documents d ON d.id=n.document_id
      ORDER BY n.created_at,n.id`).all() as unknown as Array<{
        id:string;document_id:string;document_title:string;source_ordinal:number;
        source_revision:number;source_page:number|null;source_hash:string;
        evidence:string;title:string;note:string;needs_review:number;
        created_at:string;updated_at:string;
      }>).map(n=>({
        id:n.id,documentId:n.document_id,documentTitle:n.document_title,
        sourceOrdinal:n.source_ordinal,sourceRevision:n.source_revision,
        sourcePage:n.source_page??null,sourceHash:n.source_hash,
        evidence:n.evidence,title:n.title,note:n.note,needsReview:n.needs_review===1,
        createdAt:n.created_at,updatedAt:n.updated_at,
      } satisfies GraphNode));
    const edges=(this.db.prepare(`SELECT * FROM knowledge_graph_edges ORDER BY created_at,id`)
      .all() as unknown as Array<{
        id:string;source_id:string;target_id:string;relation:GraphEdge["relation"];
        note:string;status:GraphEdge["status"];created_at:string;
      }>).map(e=>({
        id:e.id,sourceId:e.source_id,targetId:e.target_id,
        relation:e.relation,note:e.note,status:e.status,createdAt:e.created_at,
      } satisfies GraphEdge));
    return {nodes,edges};
  }
  createGraphNode(raw:unknown,now=new Date()):GraphNode{
    const input=parseGraphNode(raw);
    const source=this.getDocument(input.documentId);
    if(source.revision!==input.expectedRevision)
      throw Error("The source changed since preview; review the current passage again");
    const passage=this.getPassage(input.documentId,input.sourceOrdinal);
    const existing=this.db.prepare(`SELECT id FROM knowledge_graph_nodes
      WHERE document_id=? AND source_ordinal=? AND title=?`)
      .get(source.id,input.sourceOrdinal,input.title) as {id:string}|undefined;
    if(existing){
      const node=this.graph().nodes.find(n=>n.id===existing.id);
      if(!node)throw Error("Graph node was not found");
      return node;
    }
    const count=this.db.prepare("SELECT count(*) AS n FROM knowledge_graph_nodes").get() as {n:number};
    if(count.n>=200)throw Error("Graph node limit (200) reached");
    const id=randomUUID(),stamp=now.toISOString();
    this.db.prepare(`INSERT INTO knowledge_graph_nodes(
      id,document_id,source_ordinal,source_revision,source_page,source_hash,
      evidence,title,note,needs_review,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,0,?,?)`).run(
      id,source.id,input.sourceOrdinal,source.revision,passage.pageNumber,
      source.contentHash,passage.body.slice(0,600),input.title,input.note,stamp,stamp);
    return this.graph().nodes.find(n=>n.id===id)!;
  }
  editGraphNode(raw:unknown,now=new Date()):GraphNode{
    const input=parseGraphNodeEdit(raw);
    const changed=this.db.prepare(`UPDATE knowledge_graph_nodes SET title=?,note=?,updated_at=?
      WHERE id=?`).run(input.title,input.note,now.toISOString(),input.id);
    if(Number(changed.changes)!==1)throw Error("Graph node was not found");
    return this.graph().nodes.find(n=>n.id===input.id)!;
  }
  deleteGraphNode(id:unknown):boolean{
    return Number(this.db.prepare("DELETE FROM knowledge_graph_nodes WHERE id=?")
      .run(requireKnowledgeId(id)).changes)===1;
  }
  createGraphEdge(raw:unknown,now=new Date()):GraphEdge{
    const input=parseGraphEdge(raw);
    const allowed=this.db.prepare(`SELECT id,needs_review FROM knowledge_graph_nodes
      WHERE id IN (?,?)`).all(input.sourceId,input.targetId) as
      unknown as Array<{id:string;needs_review:number}>;
    if(allowed.length!==2)throw Error("Graph relation requires two existing nodes");
    if(allowed.some(n=>n.needs_review===1))
      throw Error("Review stale source nodes before creating new relations");
    const existing=this.db.prepare(`SELECT id FROM knowledge_graph_edges
      WHERE source_id=? AND target_id=? AND relation=?`)
      .get(input.sourceId,input.targetId,input.relation) as {id:string}|undefined;
    if(existing)return this.graph().edges.find(e=>e.id===existing.id)!;
    const count=this.db.prepare("SELECT count(*) AS n FROM knowledge_graph_edges").get() as {n:number};
    if(count.n>=400)throw Error("Graph relation limit (400) reached");
    const id=randomUUID();
    this.db.prepare(`INSERT INTO knowledge_graph_edges(
      id,source_id,target_id,relation,note,status,created_at
    ) VALUES(?,?,?,?,?,'confirmed',?)`)
      .run(id,input.sourceId,input.targetId,input.relation,input.note,now.toISOString());
    return this.graph().edges.find(e=>e.id===id)!;
  }
  deleteGraphEdge(id:unknown):boolean{
    return Number(this.db.prepare("DELETE FROM knowledge_graph_edges WHERE id=?")
      .run(requireKnowledgeId(id)).changes)===1;
  }

  private readonly cardSelect=`SELECT c.*,d.title FROM knowledge_cards c
    JOIN knowledge_documents d ON d.id=c.document_id`;
  listCards():KnowledgeReviewCard[]{
    return (this.db.prepare(this.cardSelect+" ORDER BY c.next_due,c.created_at")
      .all() as unknown as CardRow[]).map(fromCard);
  }
  private card(id:string):KnowledgeReviewCard|null{
    const row=this.db.prepare(this.cardSelect+" WHERE c.id=?")
      .get(id) as unknown as CardRow|undefined;
    return row?fromCard(row):null;
  }

  createCard(input:unknown,now=new Date()):KnowledgeReviewCard{
    const data=parseReviewCardInput(input);
    const doc=this.getDocument(data.documentId);
    const part=this.db.prepare(`SELECT c.body,cp.page_number FROM knowledge_chunks c
      LEFT JOIN knowledge_chunk_pages cp ON cp.document_id=c.document_id AND cp.ordinal=c.ordinal
      WHERE c.document_id=? AND c.ordinal=?`)
      .get(data.documentId,data.sourceOrdinal) as {body:string;page_number:number|null}|undefined;
    if(!part)throw Error("The cited document passage is no longer indexed");
    const existing=this.db.prepare("SELECT id FROM knowledge_cards WHERE document_id=? AND question=?")
      .get(data.documentId,data.question) as {id:string}|undefined;
    if(existing)return this.card(existing.id)!;
    const id=randomUUID(),stamp=now.toISOString();
    this.db.prepare(`INSERT INTO knowledge_cards(
      id,document_id,source_ordinal,evidence,source_hash,source_page,needs_review,question,answer,
      interval_days,review_count,next_due,created_at,updated_at)
      VALUES(?,?,?,?,?,?,0,?,?,0,0,?,?,?)`).run(
        id,data.documentId,data.sourceOrdinal,part.body.slice(0,500),
        doc.contentHash,part.page_number??null,data.question,data.answer,utcDay(now),stamp,stamp);
    return this.card(id)!;
  }
  removeCard(value:unknown):boolean{
    return Number(this.db.prepare("DELETE FROM knowledge_cards WHERE id=?")
      .run(requireKnowledgeId(value)).changes)===1;
  }
  reviewCard(input:unknown,ratingValue:unknown,now=new Date()):KnowledgeReviewCard{
    const id=requireKnowledgeId(input),rating=parseReviewRating(ratingValue);
    const existing=this.card(id);
    if(!existing)throw Error("Review card was not found");
    const today=utcDay(now);
    const previous=this.db.prepare(`SELECT rating FROM knowledge_review_attempts
      WHERE card_id=? AND review_day=?`).get(id,today);
    if(previous)return this.card(id)!; // one review/card/day; retries are idempotent.
    if(existing.nextDue>today)throw Error("This card is not due yet");
    const next=nextReviewInterval(existing.intervalDays,rating);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare(`INSERT INTO knowledge_review_attempts(
        card_id,review_day,rating,interval_days,reviewed_at
      ) VALUES(?,?,?,?,?)`).run(id,today,rating,next,now.toISOString());
      this.db.prepare(`UPDATE knowledge_cards SET interval_days=?,
        review_count=review_count+1,next_due=?,updated_at=? WHERE id=?`)
        .run(next,dueDay(now,next),now.toISOString(),id);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    return this.card(id)!;
  }
  progress(now=new Date()):ReviewProgress{
    const today=utcDay(now);
    const row=this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM knowledge_cards WHERE next_due<=?) AS due,
      (SELECT COUNT(*) FROM knowledge_cards) AS total,
      (SELECT COUNT(*) FROM knowledge_review_attempts WHERE review_day=?) AS reviewed
    `).get(today,today) as {due:number;total:number;reviewed:number};
    return {due:Number(row.due),total:Number(row.total),reviewedToday:Number(row.reviewed)};
  }
}
