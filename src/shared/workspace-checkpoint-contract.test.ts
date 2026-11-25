import {describe,expect,it} from "vitest";
import {parseWorkspaceHistoryPull,parseWorkspaceCheckpointPage} from "./workspace-history-contract";

const W="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const OTHER="79c7ba8d-ad06-4c71-8172-672b78b0298d";
const ID="7c2cb69c-8b50-419c-8966-e8a55c397a11";
const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const message={id:ID,workspace_id:W,author_id:OWNER,body:"retained",created_at:"2026-11-24T12:00:00.000Z"};
const expired={status:"expired",checkpointCursor:"100",serverCursor:"105",totalItems:"2"};
function page(items:unknown[],after:string="0",total="2"){
  return {checkpointCursor:"100",totalItems:total,items,
    nextOrdinal:String(BigInt(after)+BigInt(items.length)),
    hasMore:BigInt(after)+BigInt(items.length)<BigInt(total)};
}
const first={ordinal:"1",kind:"message",entityId:ID,record:message};
const second={ordinal:"2",kind:"task",entityId:"00000000-0000-4000-8000-000000000002",record:{
  id:"00000000-0000-4000-8000-000000000002",workspace_id:W,created_by:OWNER,
  title:"Archived task",due_date:null,assigned_to:null,completed:false,
  created_at:message.created_at,updated_at:message.created_at,
}};

describe("ALPHA-SYNC-003C strict checkpoint/rebase protocol",()=>{
  it("accepts an explicit expiry bound to a newer server checkpoint",()=>{
    expect(parseWorkspaceHistoryPull(expired,W,"55")).toEqual(expired);
    const normal={changes:[],nextCursor:"105",serverCursor:"105",hasMore:false};
    expect(parseWorkspaceHistoryPull(normal,W,"105")).toEqual(normal);
  });

  it.each([
    [{...expired,status:"reset"}],
    [{...expired,checkpointCursor:"55"}],
    [{...expired,checkpointCursor:"54"}],
    [{...expired,serverCursor:"99"}],
    [{...expired,totalItems:"-1"}],
    [{...expired,totalItems:2}],
    [{...expired,debug:"credential"}],
    [{...expired,checkpointCursor:"9223372036854775808"}],
  ])("rejects unknown, stale or malformed server expiry %s",(input)=>{
    expect(()=>parseWorkspaceHistoryPull(input,W,"55")).toThrow();
  });

  it("accepts pinned baseline pages, including a truly empty baseline",()=>{
    expect(parseWorkspaceCheckpointPage(page([first]),W,"100","0","2")).toMatchObject({
      checkpointCursor:"100",nextOrdinal:"1",hasMore:true,items:[{kind:"message"}],
    });
    expect(parseWorkspaceCheckpointPage(page([second],"1"),W,"100","1","2"))
      .toMatchObject({nextOrdinal:"2",hasMore:false});
    expect(parseWorkspaceCheckpointPage(page([],"0","0"),W,"100","0","0"))
      .toMatchObject({items:[],nextOrdinal:"0",hasMore:false});
  });

  it.each([
    [{...page([first]),checkpointCursor:"101"},"generation"],
    [{...page([first]),totalItems:"3"},"total"],
    [{...page([first]),nextOrdinal:"2"},"boundary"],
    [{...page([first]),hasMore:false},"boundary"],
    [{...page([first]),items:[{...first,ordinal:"2"}]},"gap"],
    [{...page([first]),items:[{...first,record:{...message,workspace_id:OTHER}}]},"ownership"],
    [{...page([first]),items:[{...first,entityId:OTHER}]},"ownership"],
    [{...page([first]),items:[{...first,record:null}]},"object"],
    [{...page([first]),items:[{...first,action:"delete"}]},"property"],
    [{...page([first]),items:[{...first,record:{...message,token:"leak"}}]},"property"],
    [{...page([first]),items:[{...first,kind:"unknown"}]},"entity"],
    [{...page([first]),unexpected:"data"},"property"],
  ] as const)("rejects malformed/foreign/tampered snapshot page %s",(input,pattern)=>{
    expect(()=>parseWorkspaceCheckpointPage(input,W,"100","0","2")).toThrow(pattern);
  });

  it("rejects a page with more than 100 items before touching disk",()=>{
    const oversized=page(Array.from({length:101},(_,i)=>({...first,ordinal:String(i+1)})),"0","101");
    expect(()=>parseWorkspaceCheckpointPage(oversized,W,"100","0","101"))
      .toThrow("Malformed workspace checkpoint page");
  });
});
