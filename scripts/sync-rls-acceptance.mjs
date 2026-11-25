#!/usr/bin/env node
/**
 * ALPHA-SYNC-001: opt-in, state-changing RLS acceptance on an ISOLATED
 * Supabase test project. NO service_role, remote cleanup, or automatic CI run.
 * Accounts: A owner; B, D, E members; C outsider until final fifth join.
 * Five distinct identities test both isolation, five-person membership and
 * owner-only revocation. Revocation requires 20261125 migration in test project.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WHO = ["A", "B", "C", "D", "E"];
const CONFIRM = "CREATE_DISPOSABLE_TEST_WORKSPACE";
const TEST_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 256000;

function fail(what) { throw Error("RLS acceptance failed: " + what); }

export function validateAcceptanceEnvironment(env) {
  if (env.ATE_POC_CONFIRM_WRITES !== CONFIRM)
    fail("set ATE_POC_CONFIRM_WRITES=" + CONFIRM + " only for an authorized disposable project");
  const rawUrl = env.ATE_POC_URL;
  if (typeof rawUrl !== "string" || rawUrl.length > 500) fail("test project URL missing");
  let url;
  try { url = new URL(rawUrl); } catch { fail("invalid test project URL"); }
  if (url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) ||
      url.username || url.password || url.port || url.pathname !== "/" ||
      url.hash || url.search)
    fail("only public HTTPS Supabase project roots are allowed");

  const key = env.ATE_POC_ANON_KEY;
  if (typeof key !== "string" || key.length > 4096 || key.startsWith("sb_secret_"))
    fail("a public publishable/legacy anon key is required");
  if (!/^sb_publishable_[A-Za-z0-9_-]{12,}$/.test(key)) {
    const parts = key.split(".");
    try {
      if (parts.length !== 3 ||
          JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role !== "anon")
        fail("service keys are prohibited");
    } catch { fail("only public anon JWT keys are accepted"); }
  }
  const accounts = {};
  const emails = new Set();
  for (const who of WHO) {
    const email = env["ATE_POC_" + who + "_EMAIL"];
    const password = env["ATE_POC_" + who + "_PASSWORD"];
    if (typeof email !== "string" || email.length > 254 ||
        !/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,63}$/i.test(email) ||
        typeof password !== "string" || password.length < 8 || password.length > 256)
      fail("test account " + who + " must have a valid email and password");
    if (emails.has(email.toLowerCase())) fail("test accounts must have different emails");
    emails.add(email.toLowerCase());
    accounts[who] = { email, password };
  }
  return { origin: url.origin, key, accounts };
}

function jwtSubject(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) fail("invalid user JWT");
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(claims.sub) ||
        claims.role !== "authenticated")
      fail("test account does not have an authenticated user JWT");
    return claims.sub;
  } catch { fail("test account session claims invalid"); }
}

function expectUuid(value, context) {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value))
    fail(context + " did not return a workspace or entity identifier");
  return value;
}
function requireAllowed(result, label) {
  if (!result.ok) fail(label + " (HTTP " + result.status + ")");
  return result.value;
}
function requireDenied(result, label) {
  if (result.ok) fail(label + " unexpectedly succeeded");
}
function requireInvisible(result, label) {
  const rows = requireAllowed(result, label);
  if (!Array.isArray(rows) || rows.length !== 0)
    fail(label + " leaked restricted records");
}

/** Inject fetcher in tests; returned output never contains JWTs or passwords. */
export async function runRlsAcceptance(env, fetcher = fetch) {
  const { origin, key, accounts } = validateAcceptanceEnvironment(env);
  async function request(path, method, token, body) {
    let response;
    try {
      response = await fetcher(origin + "/" + path, {
        method,
        headers: {
          apikey: key,
          Authorization: "Bearer " + token,
          Accept: "application/json",
          Prefer: "return=representation",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
    } catch {
      fail("network connection interrupted; no automatic write retry");
    }
    let bodyText;
    try { bodyText = await response.text(); } catch { fail("response unreadable"); }
    if (bodyText.length > MAX_RESPONSE_BYTES) fail("response safety limit exceeded");
    let value = null;
    if (response.ok && bodyText) {
      try { value = JSON.parse(bodyText); } catch { fail("unexpected successful JSON response"); }
    }
    // Never propagate raw Supabase errors: they may contain private details.
    return { ok: response.ok, status: response.status, value };
  }
  async function login(who) {
    const value = requireAllowed(await request(
      "auth/v1/token?grant_type=password", "POST", key, accounts[who]
    ), "sign-in " + who);
    if (!value || typeof value.access_token !== "string") fail("missing session " + who);
    return { token: value.access_token, id: jwtSubject(value.access_token) };
  }
  const users = {};
  for (const who of WHO) users[who] = await login(who);
  if (new Set(WHO.map(who => users[who].id)).size !== WHO.length)
    fail("the five test logins must resolve to five distinct user IDs");

  const workspace = expectUuid(requireAllowed(await request(
    "rest/v1/rpc/ate_create_workspace", "POST", users.A.token, {
      p_name: "ATE sync RLS " + new Date().toISOString(),
      p_display_name: "Owner A",
    }), "workspace creation"), "workspace creation");

  const invite = requireAllowed(await request(
    "rest/v1/rpc/ate_create_invite", "POST", users.A.token, { p_workspace: workspace }
  ), "owner invite");
  if (typeof invite !== "string" || !/^[a-f0-9]{48}$/.test(invite))
    fail("invite format invalid");

  async function join(who) {
    const id = requireAllowed(await request(
      "rest/v1/rpc/ate_join_workspace", "POST", users[who].token,
      { p_token: invite, p_display_name: "Member " + who }
    ), "join " + who);
    if (id !== workspace) fail("join returned a different workspace");
  }
  // Reserve account C as an unaffiliated outsider until after negative tests.
  await join("B");
  await join("D");
  await join("E");

  const messagesPath = "rest/v1/ate_workspace_messages?workspace_id=eq." +
    workspace + "&select=id,body";
  const tasksPath = "rest/v1/ate_workspace_tasks?workspace_id=eq." +
    workspace + "&select=id,title,completed,assigned_to";
  const membersPath = "rest/v1/ate_workspace_members?workspace_id=eq." +
    workspace + "&select=user_id";
  const workspacesPath = "rest/v1/ate_workspaces?id=eq." +
    workspace + "&select=id";

  const createdMessage = requireAllowed(await request(
    "rest/v1/ate_workspace_messages", "POST", users.A.token,
    { workspace_id: workspace, author_id: users.A.id, body: "ATE RLS test message" }
  ), "owner message insert");
  if (!Array.isArray(createdMessage) || createdMessage.length !== 1)
    fail("owner message not confirmed");

  const bMessages = requireAllowed(await request(messagesPath, "GET", users.B.token),
    "member message read");
  if (!Array.isArray(bMessages) ||
      !bMessages.some(row => row.body === "ATE RLS test message"))
    fail("authorized member cannot read a message");

  for (const [path, label] of [
    [messagesPath, "messages"], [tasksPath, "tasks"],
    [membersPath, "membership"], [workspacesPath, "workspace"],
  ]) {
    requireInvisible(await request(path, "GET", users.C.token),
      "outsider " + label + " read");
  }
  requireDenied(await request("rest/v1/ate_workspace_messages", "POST", users.C.token,
    {workspace_id: workspace, author_id: users.C.id, body: "must be rejected"}),
    "outsider message write");
  requireDenied(await request("rest/v1/ate_workspace_tasks", "POST", users.C.token,
    {workspace_id: workspace, created_by: users.C.id,
      title: "must be rejected", completed: false}),
    "outsider task write");
  requireDenied(await request("rest/v1/ate_workspace_messages", "POST", users.B.token,
    {workspace_id: workspace, author_id: users.A.id, body: "spoofed author"}),
    "member message author spoof");
  requireDenied(await request("rest/v1/ate_workspace_tasks", "POST", users.B.token,
    {workspace_id: workspace, created_by: users.A.id,
      title: "spoofed owner", completed: false}),
    "member task author spoof");
  requireDenied(await request("rest/v1/rpc/ate_create_invite", "POST", users.B.token,
    {p_workspace: workspace}), "non-owner invitation");
  requireDenied(await request("rest/v1/ate_workspace_tasks", "POST", users.A.token,
    {workspace_id: workspace, created_by: users.A.id,
      title: "nonmember assignee", assigned_to: users.C.id, completed: false}),
    "nonmember task assignment");

  const createdTask = requireAllowed(await request(
    "rest/v1/ate_workspace_tasks", "POST", users.A.token, {
      workspace_id: workspace, created_by: users.A.id, title: "ATE test assignment",
      assigned_to: users.B.id, completed: false,
    }), "member task insert");
  if (!Array.isArray(createdTask) || createdTask.length !== 1)
    fail("task insert not confirmed");
  const taskId = expectUuid(createdTask[0].id, "task insert");
  const patched = requireAllowed(await request(
    "rest/v1/ate_workspace_tasks?id=eq." + taskId + "&workspace_id=eq." + workspace,
    "PATCH", users.B.token, {completed: true}), "member task update");
  if (!Array.isArray(patched) || patched.length !== 1 || patched[0].completed !== true)
    fail("authorized task update not confirmed");

  const outsiderPatch = await request(
    "rest/v1/ate_workspace_tasks?id=eq." + taskId + "&workspace_id=eq." + workspace,
    "PATCH", users.C.token, {completed: false});
  // PostgREST may return 200 [] when RLS filters all rows, or a 4xx denial.
  if (outsiderPatch.ok &&
      (!Array.isArray(outsiderPatch.value) || outsiderPatch.value.length !== 0))
    fail("outsider modified a task");

  await join("C"); // A + B + D + E + C = five unique members.
  const members = requireAllowed(await request(membersPath, "GET", users.C.token),
    "fifth member list");
  if (!Array.isArray(members) || members.length !== 5 ||
      new Set(members.map(row => row.user_id)).size !== 5)
    fail("the workspace did not reach five distinct authorized users");
  const fifthRead = requireAllowed(await request(tasksPath, "GET", users.C.token),
    "fifth member task read");
  if (!Array.isArray(fifthRead) || !fifthRead.some(row => row.id === taskId))
    fail("fifth member cannot read shared work");

  // Revocation occurs only after reaching the 5-account state. This requires
  // the separately reviewed 20261125 SQL migration in the isolated project.
  const unspentInvite = requireAllowed(await request(
    "rest/v1/rpc/ate_create_invite", "POST", users.A.token,
    {p_workspace:workspace}), "fresh owner invite before revocation");
  if(typeof unspentInvite!=="string" || !/^[a-f0-9]{48}$/.test(unspentInvite))
    fail("fresh owner invite format invalid");
  const revokePath = "rest/v1/rpc/ate_revoke_workspace_member";
  requireDenied(await request(revokePath,"POST",users.B.token,
    {p_workspace:workspace,p_user:users.D.id}),"non-owner revocation");
  requireDenied(await request(revokePath,"POST",users.A.token,
    {p_workspace:workspace,p_user:users.A.id}),"owner self revocation");
  const revoked=requireAllowed(await request(revokePath,"POST",users.A.token,
    {p_workspace:workspace,p_user:users.B.id}),"owner revokes member B");
  if(revoked!==true) fail("revocation not confirmed by server");
  for(const [path,label] of [
    [messagesPath,"messages"],[tasksPath,"tasks"],
    [membersPath,"members"],[workspacesPath,"workspace"],
  ]) requireInvisible(await request(path,"GET",users.B.token),
    "revoked member "+label+" read");
  requireDenied(await request("rest/v1/ate_workspace_messages","POST",users.B.token,{
    workspace_id:workspace,author_id:users.B.id,body:"revoked member must not post",
  }),"revoked member message write");
  const stalePatch=await request(
    "rest/v1/ate_workspace_tasks?id=eq."+taskId+"&workspace_id=eq."+workspace,
    "PATCH",users.B.token,{completed:false});
  if(stalePatch.ok && (!Array.isArray(stalePatch.value)||stalePatch.value.length!==0))
    fail("revoked member modified a task with an old JWT");
  requireDenied(await request("rest/v1/rpc/ate_join_workspace","POST",users.B.token,{
    p_token:unspentInvite,p_display_name:"Replay B",
  }),"revoked member stale invitation replay");
  const afterRevoke=requireAllowed(await request(membersPath,"GET",users.A.token),
    "owner membership after revocation");
  if(!Array.isArray(afterRevoke)||afterRevoke.length!==4||
      afterRevoke.some(row=>row.user_id===users.B.id))
    fail("revoked member still appears as authorized");
  const ownerTasks=requireAllowed(await request(tasksPath,"GET",users.A.token),
    "owner task list after revocation");
  if(!Array.isArray(ownerTasks)||!ownerTasks.some(row=>row.id===taskId&&row.assigned_to===null))
    fail("revoked member task assignment not cleared");

  return {
    workspaceId: workspace,
    verifiedAccounts: 5,
    revokedAccounts: 1,
    tested: ["member read/write", "outsider read/write isolation",
      "spoofed author denial", "nonmember assignment denial",
      "owner-only invitations", "five-account membership",
      "owner-only revocation", "stale-JWT RLS isolation",
      "stale invitation invalidation", "task unassignment"],
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runRlsAcceptance(process.env);
    console.log("PASS: five-account Supabase RLS acceptance on an isolated test project.");
    console.log("Workspace ID:", result.workspaceId);
    console.log("PASS: owner revoked one account; subsequent old-JWT reads/writes and old invites denied.");
    console.log("Test workspace and records remain; remove manually using test-project administration.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "RLS acceptance failed");
    process.exitCode = 1;
  }
}
