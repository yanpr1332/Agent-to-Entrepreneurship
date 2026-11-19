import test from "node:test";
import assert from "node:assert/strict";
import { runRlsAcceptance, validateAcceptanceEnvironment } from "./sync-rls-acceptance.mjs";

const uuid = {
  workspace: "c161db38-30d6-4e11-a1f9-c90c658ece87",
  task: "6ff00459-193c-4432-a9a7-d6d5a53c42cb",
  A: "eb49595f-9cbe-414d-91f8-d2361b874b31",
  B: "5f76222d-22a0-410b-a879-ed507556ece2",
  C: "5a2f0b7c-19cc-46f7-9cb6-10685ca9810e",
  D: "652c00c4-0a38-4cdd-b06f-6bbd3d8d45c9",
  E: "b8a94b5b-a38d-471c-90fc-81ae3a8c3698",
};

function environment() {
  const env = {
    ATE_POC_URL: "https://sandbox-study.supabase.co/",
    ATE_POC_ANON_KEY: "sb_publishable_abcdefghijklmnopqrstuvwx1234",
    ATE_POC_CONFIRM_WRITES: "CREATE_DISPOSABLE_TEST_WORKSPACE",
  };
  for (const who of ["A", "B", "C", "D", "E"]) {
    env["ATE_POC_" + who + "_EMAIL"] = who.toLowerCase() + "@test.example";
    env["ATE_POC_" + who + "_PASSWORD"] = "local-test-password";
  }
  return env;
}

function fakeService({ outsiderLeak = false, allowAuthorSpoof = false, sameAccount = false } = {}) {
  const joined = new Set();
  const messages = [];
  const tasks = [];
  let calls = 0;
  const userByEmail = Object.fromEntries(["A", "B", "C", "D", "E"].map(who =>
    [who.toLowerCase() + "@test.example", sameAccount ? uuid.A : uuid[who]]));
  const jwtFor = (who) => "hdr." + Buffer.from(JSON.stringify({
    sub: userByEmail[who.toLowerCase() + "@test.example"],
    role: "authenticated",
  })).toString("base64url") + ".signature";
  const whoFromToken = token => Object.entries(userByEmail).find(([email, id]) =>
    jwtFor(email[0].toUpperCase()) === token)?.[1] ?? null;
  const respond = (data, status = 200) => new Response(JSON.stringify(data), {status});
  async function fetcher(input, init) {
    calls++;
    const url = new URL(input);
    assert.equal(url.origin, "https://sandbox-study.supabase.co");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.apikey, environment().ATE_POC_ANON_KEY);
    const path = url.pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === "/auth/v1/token") {
      const who = body.email?.slice(0, 1).toUpperCase();
      assert.ok(["A", "B", "C", "D", "E"].includes(who));
      return respond({access_token: jwtFor(who)});
    }
    const auth = init.headers.Authorization.replace(/^Bearer /, "");
    assert.notEqual(auth, environment().ATE_POC_ANON_KEY);
    const uid = whoFromToken(auth);
    if (!uid) return respond({error: "unauthorized"}, 401);
    const isMember = joined.has(uid);
    if (path.endsWith("/rpc/ate_create_workspace")) {
      joined.add(uid);
      return respond(uuid.workspace);
    }
    if (path.endsWith("/rpc/ate_create_invite"))
      return isMember && uid === uuid.A ? respond("a".repeat(48)) : respond({error: "forbidden"}, 403);
    if (path.endsWith("/rpc/ate_join_workspace")) {
      joined.add(uid);
      return respond(uuid.workspace);
    }
    if (init.method === "GET") {
      const isVisible = isMember || outsiderLeak;
      if (path.endsWith("/ate_workspace_messages"))
        return respond(isVisible ? messages : []);
      if (path.endsWith("/ate_workspace_tasks"))
        return respond(isVisible ? tasks : []);
      if (path.endsWith("/ate_workspace_members"))
        return respond(isVisible ? [...joined].map(user_id => ({user_id})) : []);
      if (path.endsWith("/ate_workspaces"))
        return respond(isVisible ? [{id: uuid.workspace}] : []);
    }
    if (path.endsWith("/ate_workspace_messages") && init.method === "POST") {
      if (!isMember || (!allowAuthorSpoof && body.author_id !== uid))
        return respond({error: "forbidden"}, 403);
      const row = { id: "1", body: body.body };
      messages.push(row);
      return respond([row], 201);
    }
    if (path.endsWith("/ate_workspace_tasks") && init.method === "POST") {
      if (!isMember || (!allowAuthorSpoof && body.created_by !== uid) ||
          (body.assigned_to && !joined.has(body.assigned_to)))
        return respond({error: "forbidden"}, 403);
      const row = {id: uuid.task, title: body.title, completed: false};
      tasks.push(row);
      return respond([row], 201);
    }
    if (path.endsWith("/ate_workspace_tasks") && init.method === "PATCH") {
      if (!isMember) return respond([]);
      const task = tasks.find(row => row.id === uuid.task);
      if (!task) return respond([]);
      task.completed = body.completed;
      return respond([task]);
    }
    assert.fail("unanticipated endpoint or HTTP method: " + path);
  }
  return {fetcher, count: () => calls};
}

test("manual RLS script cannot run without explicit opt-in and five distinct accounts", () => {
  const env = environment();
  delete env.ATE_POC_CONFIRM_WRITES;
  assert.throws(() => validateAcceptanceEnvironment(env), /CONFIRM_WRITES/);
  env.ATE_POC_CONFIRM_WRITES = "CREATE_DISPOSABLE_TEST_WORKSPACE";
  assert.equal(validateAcceptanceEnvironment(env).origin, "https://sandbox-study.supabase.co");
  env.ATE_POC_A_EMAIL = env.ATE_POC_B_EMAIL;
  assert.throws(() => validateAcceptanceEnvironment(env), /different emails/);
});

test("disallows service-role keys, non-standard URLs and key-bearing URLs", () => {
  const env = environment();
  env.ATE_POC_ANON_KEY = "sb_secret_privileged";
  assert.throws(() => validateAcceptanceEnvironment(env), /public/);
  env.ATE_POC_ANON_KEY = environment().ATE_POC_ANON_KEY;
  env.ATE_POC_URL = "https://sandbox-study.supabase.co@attacker.example/";
  assert.throws(() => validateAcceptanceEnvironment(env), /Supabase/);
  env.ATE_POC_URL = "http://sandbox-study.supabase.co/";
  assert.throws(() => validateAcceptanceEnvironment(env), /Supabase/);
  env.ATE_POC_URL = "https://sandbox-study.supabase.co/?token=leak";
  assert.throws(() => validateAcceptanceEnvironment(env), /Supabase/);
});

test("five-account RLS flow succeeds on a mock without any live network", async () => {
  const service = fakeService();
  const result = await runRlsAcceptance(environment(), service.fetcher);
  assert.equal(result.verifiedAccounts, 5);
  assert.equal(result.workspaceId, uuid.workspace);
  assert.ok(service.count() >= 20);
});

test("rejects a server that leaks an outsider's workspace rows", async () => {
  await assert.rejects(
    runRlsAcceptance(environment(), fakeService({outsiderLeak: true}).fetcher),
    /leaked restricted records/
  );
});

test("rejects a server that allows members to spoof another message author", async () => {
  await assert.rejects(
    runRlsAcceptance(environment(), fakeService({allowAuthorSpoof: true}).fetcher),
    /member message author spoof/
  );
});

test("rejects five emails that actually log in to the same Supabase identity", async () => {
  await assert.rejects(
    runRlsAcceptance(environment(), fakeService({sameAccount: true}).fetcher),
    /five distinct user IDs/
  );
});
