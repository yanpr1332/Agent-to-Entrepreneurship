import {describe,expect,it} from "vitest";
import {
  parseWorkspaceHistoryPage,parseWorkspaceHistoryMarker,workspaceCursor,
} from "./workspace-history-contract";

const W="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const OTHER="79c7ba8d-ad06-4c71-8172-672b78b0298d";
const ID="7c2cb69c-8b50-419c-8966-e8a55c397a11";
const AUTHOR="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const NOW="2026-11-24T10:00:00.000Z";
function change(cursor:string,kind:"message"|"task"="message"){
  return {cursor,kind,action:"upsert",entityId:ID,
    record:kind==="message"?
      {id:ID,workspace_id:W,author_id:AUTHOR,body:"Hello",created_at:NOW}:
      {id:ID,workspace_id:W,created_by:AUTHOR,title:"Task",due_date:null,assigned_to:null,
        completed:false,created_at:NOW,updated_at:NOW}};
}
const page={changes:[change("1"),change("2","task")],
  nextCursor:"2",serverCursor:"2",hasMore:false};

describe("ALPHA-SYNC-003B strict owner-scoped history parsing",()=>{
  it("accepts exactly ordered and bounded cursor pages and tombstones",()=>{
    expect(parseWorkspaceHistoryPage(page,W,"0").nextCursor).toBe("2");
    expect(parseWorkspaceHistoryPage({changes:[{cursor:"3",kind:"message",
      action:"delete",entityId:ID,record:null}],
      nextCursor:"3",serverCursor:"3",hasMore:false},W,"2")
    ).toMatchObject({changes:[{action:"delete",record:null}]});
    expect(parseWorkspaceHistoryPage({changes:[],nextCursor:"2",
      serverCursor:"2",hasMore:false},W,"2").changes).toEqual([]);
  });
  it.each([
    [{...page,nextCursor:"1"},"boundary"],
    [{...page,serverCursor:"1"},"ahead"],
    [{...page,changes:[change("1"),change("1","task")]},"gap"],
    [{...page,changes:[change("2")]},"gap"],
    [{...page,changes:[{...change("1"),record:{...change("1").record,workspace_id:OTHER}}]},"ownership"],
    [{...page,changes:[{...change("1"),entityId:OTHER}]},"ownership"],
    [{...page,changes:[{...change("1"),kind:"profile"}]},"entity"],
    [{...page,changes:[{...change("1"),action:"delete",record:change("1").record}]},"tombstone"],
    [{...page,changes:[{...change("1"),extra:"secret"}]},"property"],
    [{...page,changes:[{...change("1"),record:{...change("1").record,extra:"secret"}}]},"property"],
    [{...page,changes:[],nextCursor:"0",serverCursor:"1",hasMore:false},"boundary"],
    [{...page,changes:[],nextCursor:"0",serverCursor:"1",hasMore:true},"boundary"],
    [{...page,changes:[change("1")],nextCursor:"1",serverCursor:"1",hasMore:true},"boundary"],
    [{...page,changes:[change("1")],nextCursor:"1",serverCursor:"9223372036854775808"},"cursor"],
  ] as const)("rejects malformed/gapped/mismatched change pages: %s", (bad,pattern)=>{
    expect(()=>parseWorkspaceHistoryPage(bad,W,"0")).toThrow(pattern);
  });
  it("disallows noncanonical and oversized cursors and malformed markers",()=>{
    for(const value of ["-1","01","1.0","9223372036854775808",1,null," 1"])
      expect(()=>workspaceCursor(value)).toThrow("cursor");
    expect(workspaceCursor("9223372036854775807")).toBe("9223372036854775807");
    expect(parseWorkspaceHistoryMarker({createdAt:NOW,id:ID}))
      .toEqual({createdAt:NOW,id:ID});
    expect(()=>parseWorkspaceHistoryMarker({createdAt:NOW,id:ID,ownerId:AUTHOR})).toThrow();
  });
});
