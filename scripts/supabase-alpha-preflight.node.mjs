import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectMigrations, MIGRATIONS, validateDeploymentAcknowledgement } from "./supabase-alpha-preflight.mjs";

const root = resolve("supabase/migrations");
function withFixture(run) {
  const temp = mkdtempSync(join(tmpdir(), "study-anchor-sql-"));
  try {
    for (const filename of MIGRATIONS) cpSync(join(root, filename), join(temp, filename));
    return run(temp);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
test("all committed migrations pass read-only preflight", () => {
  const result = inspectMigrations(root);
  assert.deepEqual(result.issues, []);
  assert.equal(result.migrations.length, 7);
});
test("fail closed on missing SQL files", () => withFixture(dir => {
  unlinkSync(join(dir, MIGRATIONS[3]));
  assert.match(inspectMigrations(dir).issues.join(" "), /missing migration/);
}));
test("fail closed on unreviewed migration", () => withFixture(dir => {
  writeFileSync(join(dir, "20261126_unknown.sql"), "create table public.unknown (id uuid);");
  assert.match(inspectMigrations(dir).issues.join(" "), /unreviewed SQL/);
}));
test("detect disabled row level security or broad grants", () => withFixture(dir => {
  const path = join(dir, MIGRATIONS[0]);
  writeFileSync(path, readFileSync(path, "utf8") +
    "\nalter table public.ate_workspace_messages disable row level security;\n" +
    "grant all on table public.ate_workspace_messages to anon;\n");
  assert.match(inspectMigrations(dir).issues.join(" "), /disabled RLS/);
  assert.match(inspectMigrations(dir).issues.join(" "), /unrestricted table grant/);
}));
test("reject malformed PostgreSQL function dollar quotes before deployment", () => withFixture(dir => {
  const path = join(dir, MIGRATIONS[6]);
  const correct = readFileSync(path, "utf8");
  const broken = correct.replace("as $$\ndeclare v_token", "as $\ndeclare v_token")
    .replace("return v_token;\nend;\n$$;", "return v_token;\nend;\n$;");
  assert.notEqual(broken, correct);
  writeFileSync(path, broken);
  assert.match(inspectMigrations(dir).issues.join(" "), /malformed function dollar-quote/);
}));
test("manual deployment cannot be implied by local code checks", () => {
  assert.match(validateDeploymentAcknowledgement({}), /not acknowledged/);
  assert.match(validateDeploymentAcknowledgement({
    STUDY_ANCHOR_TEST_PROJECT_CONFIRMED: "ISOLATED_NON_PRODUCTION",
  }), /not yet independently reviewed/);
  assert.equal(validateDeploymentAcknowledgement({
    STUDY_ANCHOR_TEST_PROJECT_CONFIRMED: "ISOLATED_NON_PRODUCTION",
    STUDY_ANCHOR_MIGRATIONS_REVIEWED: "YES",
  }), null);
});
