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
import {extractKnowledgeText,fuzzyCandidateExpression,fuzzySubstringMatch,normalizeFuzzy}
  from "../shared/knowledge-search-text";
import {
  encodeEmbedding,embeddingCosine,fuseKnowledgeHits,parseLocalEmbeddingModel,
  passageHash,sameEmbeddingModel,MAX_EMBED_BATCH,MAX_LOCAL_EMBEDDINGS,
  type LocalEmbeddingModel,type LocalEmbeddingProvider,
} from "./knowledge-embeddings";
import {parseGraphNode,parseGraphNodeEdit,parseGraphEdge,
  type KnowledgeGraphSnapshot,type GraphNode,type GraphEdge} from "../shared/knowledge-graph-model";

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const CHUNK_LENGTH = 1100;
const CHUNK_OVERLAP = 100;
const MAX_CHUNKS = 2500;

interface DocumentRow {
  id: string; title: string; format: "markdown"|"text"|"pdf";page_count:number|null;
  source_path:string;
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
    id:row.id,title:row.title,format:row.format==="text"?
      /.(?:html?|tex|latex)$/i.test(row.source_path)?
        /.html?$/i.test(row.source_path)?"html":"latex":"text":row.format,
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
    if(version>5)throw new Error("Knowledge database is from a newer application");
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
    if(version<=3){
      this.db.exec("BEGIN IMMEDIATE");
      try{
        this.db.exec(`
          CREATE TABLE knowledge_vector_config(
            key INTEGER PRIMARY KEY CHECK(key=1),
            model_id TEXT NOT NULL,model_revision TEXT NOT NULL,
            dimension INTEGER NOT NULL CHECK(dimension BETWEEN 2 AND 2048),
            format TEXT NOT NULL CHECK(format='float32-l2'),
            protocol TEXT NOT NULL CHECK(protocol='passage-query-v1')
          );
          CREATE TABLE knowledge_vectors(
            chunk_id INTEGER PRIMARY KEY REFERENCES knowledge_chunks(id)
              ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES knowledge_documents(id)
              ON DELETE CASCADE,
            document_revision INTEGER NOT NULL,
            passage_hash TEXT NOT NULL,
            model_id TEXT NOT NULL,model_revision TEXT NOT NULL,
            dimension INTEGER NOT NULL CHECK(dimension BETWEEN 2 AND 2048),
            vector BLOB NOT NULL CHECK(length(vector)=dimension*4)
          );
          CREATE INDEX knowledge_vectors_doc ON knowledge_vectors(document_id);
          PRAGMA user_version=4;
        `);
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
    }
    if(version<=4){
      this.db.exec("BEGIN IMMEDIATE");
      try{
        this.db.exec(`
          CREATE TABLE knowledge_vector_skips(
            chunk_id INTEGER PRIMARY KEY REFERENCES knowledge_chunks(id)
              ON DELETE CASCADE,
            document_id TEXT NOT NULL REFERENCES knowledge_documents(id)
              ON DELETE CASCADE,
            document_revision INTEGER NOT NULL,
            passage_hash TEXT NOT NULL,
            model_id TEXT NOT NULL,model_revision TEXT NOT NULL,
            reason TEXT NOT NULL CHECK(reason IN ('vocabulary_miss'))
          );
          CREATE INDEX knowledge_vector_skips_doc
            ON knowledge_vector_skips(document_id);
          PRAGMA user_version=5;
        `);
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
    }
  }

  close():void{this.db.close();}
  async backupTo(path:string):Promise<number>{return backup(this.db,path);}

  listDocuments():KnowledgeDocument[]{
    return (this.db.prepare(`SELECT d.id,d.title,d.source_path,
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
  importText(source:{sourcePath:string;title:string;format:"markdown"|"text"|"html"|"latex";text:string},now=new Date()):
    {document:KnowledgeDocument;changed:boolean}{
    if(typeof source.sourcePath!=="string" || !source.sourcePath ||
       typeof source.title!=="string" || !source.title.trim() ||
       source.title.length>255 || !["markdown","text","html","latex"].includes(source.format) ||
       typeof source.text!=="string" || !source.text.trim())throw Error("Invalid knowledge source");
    const length=Buffer.byteLength(source.text,"utf8");
    if(length>MAX_DOCUMENT_BYTES)throw Error("Document exceeds 2 MiB limit");
    const text=source.text.replace(/\r\n/g,"\n");
    const hash=createHash("sha256").update(text).digest("hex");
    const previous=this.db.prepare("SELECT id,content_hash FROM knowledge_documents WHERE source_path=?")
      .get(source.sourcePath) as {id:string;content_hash:string}|undefined;
    if(previous?.content_hash===hash)return {document:this.getDocument(previous.id),changed:false};
    const readable=extractKnowledgeText(source.format,text);
    if(!readable)throw Error("Source contains no indexable readable text");
    const id=previous?.id??randomUUID(),stamp=now.toISOString(),parts=chunks(readable);
    // The old SQLite CHECK allows markdown/text only. Preserve source_path and
    // original text, and infer HTML/TeX display format from the native-picked extension.
    const persistedFormat=source.format==="html"||source.format==="latex"?"text":source.format;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      if(previous){
        this.db.prepare(`UPDATE knowledge_documents SET title=?,format=?,content=?,
          content_hash=?,byte_length=?,chunk_count=?,revision=revision+1,updated_at=?
          WHERE id=?`).run(source.title,persistedFormat,text,hash,length,parts.length,stamp,id);
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
            id,source.sourcePath,source.title,persistedFormat,text,hash,length,parts.length,stamp,stamp);
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
    type Row={document_id:string;ordinal:number;body:string;title:string;
      revision:number;page_number:number|null};
    const fromMatches=(rows:Row[],mode:"exact"|"fuzzy"):KnowledgeSearchHit[]=>
      rows.map(row=>{
        const idx=row.body.toLowerCase().indexOf(query.toLowerCase());
        const start=idx<0?0:Math.max(0,idx-100);
        return {documentId:row.document_id,documentTitle:row.title,
          documentRevision:row.revision,ordinal:row.ordinal,
          pageNumber:row.page_number??null,
          excerpt:row.body.slice(start,start+500),matchType:mode};
      });
    const long=Array.from(query).length>=3;
    const exact=long ? this.db.prepare(`
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
    const exactRows=exact as Row[];
    const exactHits=fromMatches(exactRows,"exact");
    // Previously one exact result suppressed fuzzy matches in all other documents.
    if(exactHits.length>=40)return exactHits;
    const fuzzyExpression=fuzzyCandidateExpression(query);
    if(!fuzzyExpression)return exactHits;
    const seen=new Set(exactRows.map(row=>row.document_id+":"+row.ordinal));
    const candidates=this.db.prepare(`
        SELECT c.document_id,c.ordinal,c.body,d.title,d.revision,cp.page_number
        FROM knowledge_fts JOIN knowledge_chunks c ON c.id=knowledge_fts.rowid
        JOIN knowledge_documents d ON d.id=c.document_id
        LEFT JOIN knowledge_chunk_pages cp ON cp.document_id=c.document_id AND cp.ordinal=c.ordinal
        WHERE knowledge_fts MATCH ?
        ORDER BY bm25(knowledge_fts) LIMIT 200
      `).all(fuzzyExpression) as unknown as Row[];
    const length=Array.from(normalizeFuzzy(query)).length;
    const threshold=length<=5?1:2;
    const scored=candidates.filter(row=>!seen.has(row.document_id+":"+row.ordinal))
      .map(row=>({row,match:fuzzySubstringMatch(query,row.body,threshold)}))
      .filter((r):r is {row:Row;match:{distance:number;end:number}}=>r.match!==null)
      .sort((a,b)=>a.match.distance-b.match.distance||
        a.row.title.localeCompare(b.row.title)||a.row.ordinal-b.row.ordinal)
      .slice(0,40-exactHits.length);
    const fuzzyHits=scored.map(({row,match})=>{
      const rawStart=Math.max(0,match.end-length-100);
      return {documentId:row.document_id,documentTitle:row.title,
        documentRevision:row.revision,ordinal:row.ordinal,
        pageNumber:row.page_number??null,excerpt:row.body.slice(rawStart,rawStart+500),
        matchType:"fuzzy" as const};
    });
    return [...exactHits,...fuzzyHits];
  }

  /** Bounded, explicitly exported LOCAL evidence catalog for manual
   * relevance labelling. No source file paths, credentials, AI keys or cloud
   * objects. The excerpts are still private and must not be uploaded. */
  localEvidenceCatalog(limit=500,offset=0):{
    total:number;items:Array<{evidenceKey:string;title:string;pageNumber:number|null;
      excerpt:string}>
  }{
    if(!Number.isSafeInteger(limit)||limit<1||limit>500||
      !Number.isSafeInteger(offset)||offset<0||offset>100000)
      throw Error("Invalid local evidence catalog page");
    const total=(this.db.prepare("SELECT count(*) AS n FROM knowledge_chunks")
      .get() as {n:number}).n;
    const rows=this.db.prepare(`SELECT c.document_id,c.ordinal,c.body,
      d.title,d.revision,cp.page_number
      FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id
      LEFT JOIN knowledge_chunk_pages cp ON cp.document_id=c.document_id
        AND cp.ordinal=c.ordinal
      ORDER BY d.updated_at DESC,c.document_id,c.ordinal LIMIT ? OFFSET ?`)
      .all(limit,offset) as Array<{document_id:string;ordinal:number;body:string;
        title:string;revision:number;page_number:number|null}>;
    return {total,items:rows.map(r=>({
      evidenceKey:r.document_id+":"+r.revision+":"+r.ordinal,
      title:r.title,pageNumber:r.page_number??null,
      excerpt:r.body.slice(0,240),
    }))};
  }

  /** Local model metadata is registered by trusted Main code only, AFTER
   * explicit model-install consent in a future model runner. No IPC accepts
   * arbitrary vectors, paths or remote embedding API URLs. */
  embeddingModel():LocalEmbeddingModel|null{
    const row=this.db.prepare(`SELECT model_id,model_revision,dimension,format,protocol
      FROM knowledge_vector_config WHERE key=1`).get() as {
        model_id:string;model_revision:string;dimension:number;
        format:string;protocol:string;
      }|undefined;
    return row?parseLocalEmbeddingModel({id:row.model_id,revision:row.model_revision,
      dimension:row.dimension,format:row.format,protocol:row.protocol}):null;
  }
  embeddingStatus():{
    model:LocalEmbeddingModel|null;indexed:number;skipped:number;pending:number;total:number
  }{
    const model=this.embeddingModel();
    const n=(this.db.prepare(`SELECT count(*) AS n FROM knowledge_chunks`)
      .get() as {n:number}).n;
    const indexed=(this.db.prepare(`SELECT count(*) AS n FROM knowledge_vectors v
      JOIN knowledge_chunks c ON c.id=v.chunk_id
      JOIN knowledge_documents d ON d.id=c.document_id
      WHERE d.revision=v.document_revision AND v.document_id=d.id
        AND v.model_id=? AND v.model_revision=?
        AND v.dimension=?`)
      .get(model?.id??"",model?.revision??"",model?.dimension??-1) as {n:number}).n;
    const skipped=(this.db.prepare(`SELECT count(*) AS n FROM knowledge_vector_skips s
      JOIN knowledge_chunks c ON c.id=s.chunk_id
      JOIN knowledge_documents d ON d.id=c.document_id
      WHERE d.revision=s.document_revision AND s.document_id=d.id
        AND s.model_id=? AND s.model_revision=?
        AND s.passage_hash <> ''`)
      .get(model?.id??"",model?.revision??"") as {n:number}).n;
    return {model,indexed,skipped,pending:Math.max(0,n-indexed-skipped),total:n};
  }
  configureLocalEmbeddingModel(raw:unknown):void{
    const model=parseLocalEmbeddingModel(raw),old=this.embeddingModel();
    if(old&&sameEmbeddingModel(old,model))return;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare("DELETE FROM knowledge_vectors").run();
      this.db.prepare("DELETE FROM knowledge_vector_skips").run();
      this.db.prepare(`INSERT INTO knowledge_vector_config(
        key,model_id,model_revision,dimension,format,protocol
      ) VALUES(1,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
        model_id=excluded.model_id,model_revision=excluded.model_revision,
        dimension=excluded.dimension,format=excluded.format,protocol=excluded.protocol`)
        .run(model.id,model.revision,model.dimension,model.format,model.protocol);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  clearLocalEmbeddings():void{
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare("DELETE FROM knowledge_vectors").run();
      this.db.prepare("DELETE FROM knowledge_vector_skips").run();
      this.db.prepare("DELETE FROM knowledge_vector_config").run();
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  /** Incremental resume across restart: look up the first passage missing
   * an embedding for the ACTIVE pinned model. No disk-side progress cursor is
   * needed: each committed batch is already checkpointed via SQLite. */
  nextEmbeddingTarget():{documentId:string;revision:number;ordinal:number}|null{
    const model=this.embeddingModel();
    if(!model)return null;
    const row=this.db.prepare(`SELECT c.document_id,c.ordinal,d.revision
      FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id
      LEFT JOIN knowledge_vectors v ON v.chunk_id=c.id
        AND v.model_id=? AND v.model_revision=? AND v.dimension=?
        AND v.document_revision=d.revision
      LEFT JOIN knowledge_vector_skips sk ON sk.chunk_id=c.id
        AND sk.model_id=? AND sk.model_revision=?
        AND sk.document_revision=d.revision
      WHERE v.chunk_id IS NULL AND sk.chunk_id IS NULL
      ORDER BY c.document_id,c.ordinal LIMIT 1`)
      .get(model.id,model.revision,model.dimension,model.id,model.revision) as
        {document_id:string;ordinal:number;revision:number}|undefined;
    return row?{documentId:row.document_id,revision:row.revision,ordinal:row.ordinal}:null;
  }

  /** One bounded batch. The provider must already be a locally verified,
   * explicitly installed model; the app does not yet ship/download a runner.
   * Every source revision and passage hash is rechecked AFTER await before
   * committing all vectors atomically. Import/delete cascade deletes vectors. */
  async indexEmbeddingBatch(provider:LocalEmbeddingProvider,documentInput:unknown,
    revisionInput:unknown,startInput=0,isCanceled:()=>boolean=()=>false):
    Promise<{written:number;nextOrdinal:number|null}>{
    const documentId=requireKnowledgeId(documentInput);
    const model=parseLocalEmbeddingModel(provider.model),configured=this.embeddingModel();
    if(!configured||!sameEmbeddingModel(model,configured))
      throw Error("Local embedding model is not configured for this index");
    if(!Number.isSafeInteger(revisionInput)||(revisionInput as number)<1||
       !Number.isSafeInteger(startInput)||startInput<0||startInput>2500)
      throw Error("Invalid knowledge vector batch boundary");
    const revision=revisionInput as number;
    const doc=this.getDocument(documentId);
    if(doc.revision!==revision)throw Error("Knowledge source revision changed");
    const passages=this.db.prepare(`SELECT id,ordinal,body FROM knowledge_chunks
      WHERE document_id=? AND ordinal>=? ORDER BY ordinal LIMIT ?`)
      .all(documentId,startInput,MAX_EMBED_BATCH) as
        Array<{id:number;ordinal:number;body:string}>;
    if(!passages.length)return {written:0,nextOrdinal:null};
    // Providers that support explicit passage misses may skip unknown
    // vocabulary WITHOUT synthesizing random vectors. Other providers keep
    // strict all-or-nothing batch semantics.
    const vectors=provider.embedPassages
      ?await provider.embedPassages(passages.map(p=>p.body))
      :await provider.embed(passages.map(p=>p.body),"passage");
    if(!Array.isArray(vectors)||vectors.length!==passages.length)
      throw Error("Local model returned an incomplete embedding batch");
    if(isCanceled())throw Error("Local indexing was canceled");
    const encoded=vectors.map(v=>v===null?null:encodeEmbedding(v,model.dimension));
    this.db.exec("BEGIN IMMEDIATE");
    try{
      if(isCanceled())throw Error("Local indexing was canceled");
      const still=this.getDocument(documentId);
      const active=this.embeddingModel();
      if(still.revision!==revision||!active||!sameEmbeddingModel(active,model))
        throw Error("Knowledge source/model changed during local indexing");
      const available=(this.db.prepare(`SELECT count(*) AS n FROM knowledge_vectors`)
        .get() as {n:number}).n;
      const existing=this.db.prepare("SELECT 1 FROM knowledge_vectors WHERE chunk_id=?");
      let newRows=0;
      for(let i=0;i<passages.length;i++)
        if(encoded[i]!==null&&!existing.get(passages[i].id))newRows++;
      if(available+newRows>MAX_LOCAL_EMBEDDINGS)
        throw Error("Local vector index limit reached");
      const current=this.db.prepare(`SELECT id,body FROM knowledge_chunks
        WHERE document_id=? AND ordinal=?`);
      const put=this.db.prepare(`INSERT INTO knowledge_vectors(
        chunk_id,document_id,document_revision,passage_hash,
        model_id,model_revision,dimension,vector
      ) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(chunk_id) DO UPDATE SET
        document_revision=excluded.document_revision,passage_hash=excluded.passage_hash,
        model_id=excluded.model_id,model_revision=excluded.model_revision,
        dimension=excluded.dimension,vector=excluded.vector`);
      const skip=this.db.prepare(`INSERT INTO knowledge_vector_skips(
        chunk_id,document_id,document_revision,passage_hash,
        model_id,model_revision,reason
      ) VALUES(?,?,?,?,?,?,'vocabulary_miss')
      ON CONFLICT(chunk_id) DO UPDATE SET
        document_revision=excluded.document_revision,
        passage_hash=excluded.passage_hash,model_id=excluded.model_id,
        model_revision=excluded.model_revision,reason=excluded.reason`);
      const eraseSkip=this.db.prepare("DELETE FROM knowledge_vector_skips WHERE chunk_id=?");
      const eraseVector=this.db.prepare("DELETE FROM knowledge_vectors WHERE chunk_id=?");
      passages.forEach((part,i)=>{
        const check=current.get(documentId,part.ordinal) as {id:number;body:string}|undefined;
        if(!check||check.id!==part.id||check.body!==part.body)
          throw Error("Knowledge passage changed during embedding");
        const hash=passageHash(part.body);
        if(encoded[i]===null){
          eraseVector.run(part.id);
          skip.run(part.id,documentId,revision,hash,model.id,model.revision);
        }else{
          eraseSkip.run(part.id);
          put.run(part.id,documentId,revision,hash,
            model.id,model.revision,model.dimension,encoded[i]);
        }
      });
      if(isCanceled())throw Error("Local indexing was canceled");
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    return {written:encoded.filter(v=>v!==null).length,
      nextOrdinal:passages.length===MAX_EMBED_BATCH
        ?passages[passages.length-1].ordinal+1:null};
  }

  /** A search never accepts model vectors from the Renderer. If no trusted
   * local model is attached, or it fails, exact/fuzzy remains unchanged. */
  async searchWithEmbeddings(input:unknown,provider:LocalEmbeddingProvider|null):
    Promise<KnowledgeSearchHit[]>{
    const query=parseKnowledgeQuery(input),lexical=this.search(query);
    if(!provider)return lexical;
    let model:LocalEmbeddingModel;
    try{model=parseLocalEmbeddingModel(provider.model);}catch{return lexical;}
    const configured=this.embeddingModel();
    if(!configured||!sameEmbeddingModel(configured,model))return lexical;
    let queryVector:Buffer;
    try{
      const batch=await provider.embed([query],"query");
      if(!Array.isArray(batch)||batch.length!==1)return lexical;
      queryVector=encodeEmbedding(batch[0],model.dimension);
    }catch{return lexical;}
    const active=this.embeddingModel();
    if(!active||!sameEmbeddingModel(active,model))return lexical;
    type VectorRow={document_id:string;ordinal:number;body:string;title:string;
      revision:number;page_number:number|null;passage_hash:string;vector:Buffer};
    const records=this.db.prepare(`SELECT c.document_id,c.ordinal,c.body,d.title,
      d.revision,cp.page_number,v.passage_hash,v.vector
      FROM knowledge_vectors v JOIN knowledge_chunks c ON v.chunk_id=c.id
      JOIN knowledge_documents d ON c.document_id=d.id
      LEFT JOIN knowledge_chunk_pages cp ON cp.document_id=c.document_id
        AND cp.ordinal=c.ordinal
      WHERE d.revision=v.document_revision AND v.document_id=d.id
        AND v.model_id=? AND v.model_revision=? AND v.dimension=?
      ORDER BY c.document_id,c.ordinal LIMIT ?`)
      .all(model.id,model.revision,model.dimension,MAX_LOCAL_EMBEDDINGS) as VectorRow[];
    const semantic: Array<{hit:KnowledgeSearchHit;score:number}>=[];
    for(const row of records){
      if(passageHash(row.body)!==row.passage_hash)continue;
      let score:number;
      try{score=embeddingCosine(queryVector,row.vector);}catch{continue;}
      if(score<0.2)continue;
      semantic.push({score,hit:{
        documentId:row.document_id,documentTitle:row.title,
        documentRevision:row.revision,ordinal:row.ordinal,
        pageNumber:row.page_number??null,excerpt:row.body.slice(0,500),
        matchType:"semantic",
      }});
    }
    semantic.sort((a,b)=>b.score-a.score||
      a.hit.documentId.localeCompare(b.hit.documentId)||a.hit.ordinal-b.hit.ordinal);
    return fuseKnowledgeHits(lexical,semantic.slice(0,40).map(x=>x.hit));
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
