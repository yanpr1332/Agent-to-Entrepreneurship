#!/usr/bin/env node
/**
 * Read-only migration preflight. No network, database access or credentials.
 * This does NOT establish that any migration is deployed or that RLS works.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

export const MIGRATIONS = Object.freeze([
  "20261110_ate_workspace_poc.sql",
  "20261124_ate_personal_sync.sql",
  "20261124_ate_personal_sync_recovery_inspect.sql",
  "20261124_ate_workspace_realtime_hints.sql",
  "20261124_ate_workspace_durable_history.sql",
  "20261124_ate_workspace_checkpoint_recovery.sql",
  "20261125_ate_workspace_member_revoke.sql",
]);
const DANGEROUS = [
  [/\bdrop\s+schema\s+public\b/i, "DROP SCHEMA public"],
  [/\btruncate\s+(?:table\s+)?public\./i, "TRUNCATE public table"],
  [/\balter\s+table\s+public\.[\w]+\s+disable\s+row\s+level\s+security/i, "disabled RLS"],
  [/\bgrant\s+all\s+on\s+(?:all\s+tables|table\s+public\.)/i, "unrestricted table grant"],
  [/\bgrant\s+[^;]+\s+to\s+(?:anon|public)\s*;/i, "grant to anon/public"],
];
function withoutComments(sql) {
  // This conservative preflight strips SQL comments, not string literals. It is
  // intentionally NOT a full SQL parser and never claims a proof of safety.
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
export function inspectMigrations(directory) {
  const issues = [];
  let filenames;
  try { filenames = readdirSync(directory); }
  catch { return { ok: false, issues: ["migration directory unavailable"], migrations: [] }; }
  const unexpected = filenames.filter(name => name.endsWith(".sql") && !MIGRATIONS.includes(name));
  if (unexpected.length) issues.push("unreviewed SQL migrations: " + unexpected.sort().join(", "));
  const migrations = [];
  for (const name of MIGRATIONS) {
    if (!filenames.includes(name)) { issues.push("missing migration: " + name); continue; }
    let sql;
    try { sql = readFileSync(join(directory, name), "utf8"); }
    catch { issues.push("unreadable migration: " + name); continue; }
    if (sql.length < 100 || sql.length > 150000) issues.push("unexpected SQL size: " + name);
    const active = withoutComments(sql);
    // Catch a previously malformed single-dollar PL/pgSQL function delimiter.
    // This is a targeted syntax guard, not a general-purpose SQL parser.
    if (/\bas\s+\$(?!\$|[A-Za-z_][A-Za-z0-9_]*\$)/i.test(active) ||
        /(?:^|\n)\s*\$\s*;/m.test(active))
      issues.push(name + ": malformed function dollar-quote delimiter");
    for (const [pattern, label] of DANGEROUS) {
      if (pattern.test(active)) issues.push(name + ": potentially unsafe " + label);
    }
    if (!/\b(?:create|alter|drop|grant|revoke)\b/i.test(active))
      issues.push(name + ": no recognized DDL");
    migrations.push({ name, bytes: Buffer.byteLength(sql, "utf8") });
  }
  const workspace = readText(directory, MIGRATIONS[0]);
  if (workspace && !/alter\s+table\s+public\.ate_workspace_messages\s+enable\s+row\s+level\s+security/i.test(workspace))
    issues.push("workspace messages RLS enablement missing");
  if (workspace && !/alter\s+table\s+public\.ate_workspace_tasks\s+enable\s+row\s+level\s+security/i.test(workspace))
    issues.push("workspace tasks RLS enablement missing");
  const personal = readText(directory, MIGRATIONS[1]);
  if (personal && !/row\s+level\s+security/i.test(personal))
    issues.push("personal sync RLS declaration missing");
  const history = readText(directory, MIGRATIONS[4]);
  const checkpoint = readText(directory, MIGRATIONS[5]);
  if (history && !/cursor/i.test(history)) issues.push("history cursor protocol missing");
  if (checkpoint && !/checkpoint/i.test(checkpoint)) issues.push("workspace checkpoint protocol missing");
  const revoke = readText(directory, MIGRATIONS[6]);
  if (revoke && (
    !/ate_revoke_workspace_member\s*\(/i.test(revoke) ||
    !/role\s*=\s*'owner'/i.test(revoke) ||
    !/delete\s+from\s+public\.ate_workspace_invites/i.test(revoke) ||
    !/update\s+public\.ate_workspace_tasks\s+set\s+assigned_to\s*=\s*null/i.test(revoke)
  )) issues.push("workspace member revocation authorization, assignment or invite rotation missing");
  return { ok: issues.length === 0, issues, migrations };
}
function readText(directory, name) {
  try { return readFileSync(join(directory, name), "utf8"); } catch { return null; }
}
export function validateDeploymentAcknowledgement(env) {
  // Manual operator checklist: never uses or reads passwords/API keys.
  if (env.STUDY_ANCHOR_TEST_PROJECT_CONFIRMED !== "ISOLATED_NON_PRODUCTION")
    return "isolated non-production Supabase project not acknowledged";
  if (env.STUDY_ANCHOR_MIGRATIONS_REVIEWED !== "YES")
    return "SQL migrations not yet independently reviewed";
  return null;
}
const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
  const result = inspectMigrations(directory);
  for (const item of result.migrations) console.log("FOUND", item.name, item.bytes + " bytes");
  for (const issue of result.issues) console.error("BLOCKED", issue);
  if (!result.ok) process.exitCode = 1;
  else {
    console.log("PASS: local SQL preflight only; no database or RLS was tested.");
    const pending = validateDeploymentAcknowledgement(process.env);
    if (pending) console.log("LIVE DEPLOYMENT BLOCKED:", pending);
    else console.log("Manual isolated-project review acknowledged; deployment still requires a human.");
  }
}
