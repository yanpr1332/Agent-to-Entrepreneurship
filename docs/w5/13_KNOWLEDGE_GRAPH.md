# W6 Knowledge Graph: Local source-backed node and manual relation Alpha

## Scope / requirements
Tracks W4 KB-003 (knowledge nodes and evidence), KB-004 (cross-document relations), and the minimal manual part of KB-005 (visual graph). This remains a local-only prototype; there is no model-generated graph or automatic PDF understanding. The UI distinguishes confirmed human edges from the future pending-AI state, but never invents unreviewed AI edges.

## Flow
1. Explicitly import user-selected Markdown/TXT/PDF in the existing knowledge base. All text remains on the user's device.
2. Open **知识图谱**. Select an existing document and actual indexed passage, click **读取并核对来源** to see its current original excerpt and, for PDF, physical page number.
3. Give the node a short concept name and optional human annotation. Main revalidates the document/passage against the exact user-previewed revision (rejects stale previews) and persists a fixed excerpt (maximum 600 characters), full content hash, document revision, passage ordinal and physical PDF page. Renderer cannot supply a fake snippet, file path, hash, or revision.
4. Connect any two existing non-stale nodes with a manually confirmed relation: related / supports / contrasts. Cross-document edges work. Only Main inserts status=confirmed. The Graph's pending status is reserved for later explicit AI suggestion-review workflows.
5. Browse the SVG overview and full accessible lists. Select a node to inspect its original provenance, edit its *human* title/note (never origin evidence), follow the current source, or delete it and cascade connected edges. Delete individual relations. Deleting a document deletes its nodes/edges, but **never** the original file.
6. When the document content hash changes, the old node and incident relations are visually marked for human review. Old evidence is preserved unmodified; adding fresh relations to stale nodes is blocked. To correct a stale claim, compare the new passage, delete old node, create a new source-backed node, and recreate verified edges.

## Storage/migration
- SQLite `ate-knowledge.sqlite` schema v3 with foreign keys, unique node/edge identity constraints, bounded 200 nodes / 400 edges, default confirmed on user-created edges. No network, raw filesystem, eval or arbitrary SQL is exposed in IPC.
- `backupBeforeMigration(...,3)` ensures a verified WAL-aware snapshot before upgrading existing v1/v2 databases; all old documents, PDF physical pages, citations, flashcards and FTS are retained.
- Local SQLite backups include the graph; they remain unencrypted, so avoid publishing them.

## Verification
Vitest tests cover exact field whitelist, forged file/authority claims, missing passages, duplicate idempotency, cross-document linking, reimport staleness, deletion cascade, migration v2 -> v3 including preserved review cards. Run `npm run typecheck`, `npm test`, `npm run build` on Windows/macOS GitHub Actions.

## Limitations / acceptance remaining
- Graph layout is a simple static SVG showing up to 24 most recent nodes; all nodes/edges remain accessible in text lists. No force-directed interaction or semantic ranking yet.
- There is **no** OCR, automatic graph extraction, multi-document AI reasoning, automatic verification or user-authorized cloud collaboration in this slice.
- Migration backups are not encrypted and source excerpts may contain sensitive course content; user must deliberately select data to import.
- Actual Windows/macOS UI interaction, signed installers and sensitive real-account/school content remain outside automated test evidence. This alone does not close the entire M2 Alpha milestone.
