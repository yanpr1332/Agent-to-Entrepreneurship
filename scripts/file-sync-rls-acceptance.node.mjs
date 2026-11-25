import test from "node:test";
import assert from "node:assert/strict";
import {validateFileAcceptanceEnvironment,FILE_TEST_CONFIRM}
  from "./file-sync-rls-acceptance.mjs";

function valid(){
  return {ATE_FILE_CONFIRM_WRITES:FILE_TEST_CONFIRM,
    ATE_FILE_URL:"https://file-test.supabase.co",
    ATE_FILE_ANON_KEY:"sb_publishable_abcdefghijklmnopqrstuvwxyz123",
    ATE_FILE_A_EMAIL:"a@example.edu",ATE_FILE_A_PASSWORD:"strong-a-123",
    ATE_FILE_B_EMAIL:"b@example.edu",ATE_FILE_B_PASSWORD:"strong-b-123"};
}
test("real file RLS check is opt-in and never runs without explicit write token",()=>{
  const env=valid();delete env.ATE_FILE_CONFIRM_WRITES;
  assert.throws(()=>validateFileAcceptanceEnvironment(env),/confirmation missing/);
});
test("only public Supabase root URL and publishable/anon key are allowed",()=>{
  assert.equal(validateFileAcceptanceEnvironment(valid()).origin,"https://file-test.supabase.co");
  for(const url of ["http://file-test.supabase.co","https://localhost:54321",
    "https://file-test.supabase.co/rest/v1","https://user@file-test.supabase.co"]){
    const env=valid();env.ATE_FILE_URL=url;
    assert.throws(()=>validateFileAcceptanceEnvironment(env),/only HTTPS/);
  }
  const env=valid();env.ATE_FILE_ANON_KEY="sb_secret_must-not-be-used";
  assert.throws(()=>validateFileAcceptanceEnvironment(env),/never secret/);
});
test("requires two distinct normal password logins, no admin credentials",()=>{
  const env=valid();env.ATE_FILE_B_EMAIL=env.ATE_FILE_A_EMAIL;
  assert.throws(()=>validateFileAcceptanceEnvironment(env),/different logins/);
  const short=valid();short.ATE_FILE_A_PASSWORD="x";
  assert.throws(()=>validateFileAcceptanceEnvironment(short),/invalid test credential/);
});
