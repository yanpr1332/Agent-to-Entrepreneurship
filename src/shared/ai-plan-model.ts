import { parsePlanningSettings,type PlanningSettings,type PlanProposal } from "./planning-model";

export interface AIPlanPrepareInput {
  taskIds:string[];
  settings:PlanningSettings;
}
export interface AIPlanSlot {
  taskId:string;
  day:string;
  startMinute:number;
}
export interface AIPlanAccepted {
  proposal:PlanProposal;
  providerModel:string;
  usage:{inputTokens:number|null;outputTokens:number|null};
}

export function parseAIPlanPrepare(raw:unknown):AIPlanPrepareInput {
  if(!raw || typeof raw!=="object" || Array.isArray(raw))throw Error("Invalid AI plan request");
  const x=raw as Record<string,unknown>;
  if(Object.keys(x).sort().join(",")!=="settings,taskIds" ||
      !Array.isArray(x.taskIds) || x.taskIds.length<1 || x.taskIds.length>5 ||
      !x.taskIds.every(id=>typeof id==="string" && /^[0-9a-f-]{36}$/i.test(id)) ||
      new Set(x.taskIds).size!==x.taskIds.length){
    throw Error("Choose one to five distinct personal tasks");
  }
  return {taskIds:x.taskIds as string[],settings:parsePlanningSettings(x.settings)};
}

/** Never trust the model's claimed task titles, dates, permissions or IDs. */
export function parseAIPlanSlots(text:unknown):AIPlanSlot[] {
  if(typeof text!=="string" || text.length>12_000)throw Error("AI plan response was invalid");
  let raw:unknown;
  try{raw=JSON.parse(text);}catch{throw Error("AI returned non-JSON planning data");}
  if(!raw || typeof raw!=="object" || Array.isArray(raw))throw Error("AI plan must be an object");
  const fields=raw as Record<string,unknown>;
  if(Object.keys(fields).join(",")!=="slots" ||
      !Array.isArray(fields.slots) || fields.slots.length<1 || fields.slots.length>5)
      throw Error("AI plan contained invalid slots");
  return fields.slots.map(item=>{
    if(!item || typeof item!=="object" || Array.isArray(item))throw Error("Invalid AI time slot");
    const x=item as Record<string,unknown>;
    if(Object.keys(x).sort().join(",")!=="day,startMinute,taskId" ||
       typeof x.taskId!=="string" || !/^[0-9a-f-]{36}$/i.test(x.taskId) ||
       typeof x.day!=="string" ||
       !Number.isSafeInteger(x.startMinute)){
      throw Error("AI returned an invalid time slot");
    }
    return {taskId:x.taskId,day:x.day,startMinute:x.startMinute as number};
  });
}
