import {
  parseTaskId,type FocusRewardCreateInput,type FocusRewardEditInput,
  type FocusRewardRedeemInput,
} from "../shared/local-model";

function record(input:unknown,keys:string[]):Record<string,unknown>{
  if(!input||typeof input!=="object"||Array.isArray(input))
    throw Error("Invalid virtual reward request");
  const obj=input as Record<string,unknown>;
  if(Object.keys(obj).sort().join(",")!==keys.slice().sort().join(","))
    throw Error("Invalid virtual reward fields");
  return obj;
}
function title(value:unknown):string{
  if(typeof value!=="string"||value.trim().length<1||value.trim().length>100)
    throw Error("Reward title must contain 1–100 characters");
  return value.trim();
}
function description(value:unknown):string{
  if(typeof value!=="string"||value.length>500)
    throw Error("Reward description must not exceed 500 characters");
  return value.trim();
}
function cost(value:unknown):number{
  if(typeof value!=="number"||!Number.isSafeInteger(value)||value<1||value>1000000)
    throw Error("Reward points must be an integer between 1 and 1000000");
  return value;
}
export function parseRewardCreate(value:unknown):FocusRewardCreateInput{
  const r=record(value,["title","description","cost"]);
  return {title:title(r.title),description:description(r.description),cost:cost(r.cost)};
}
export function parseRewardEdit(value:unknown):FocusRewardEditInput{
  const r=record(value,["id","title","description","cost","active","expectedUpdatedAt"]);
  if(typeof r.active!=="boolean"||typeof r.expectedUpdatedAt!=="string"||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.expectedUpdatedAt)||
    Number.isNaN(Date.parse(r.expectedUpdatedAt)))
    throw Error("Invalid reward edit revision");
  return {id:parseTaskId(r.id),title:title(r.title),description:description(r.description),
    cost:cost(r.cost),active:r.active,expectedUpdatedAt:r.expectedUpdatedAt};
}
export function parseRewardRedeem(value:unknown):FocusRewardRedeemInput{
  const r=record(value,["redemptionId","rewardId"]);
  return {redemptionId:parseTaskId(r.redemptionId),rewardId:parseTaskId(r.rewardId)};
}
/** Consistent, bounded cosmetic levels based on earned (not current) points. */
export function virtualFocusLevel(earned:number):{level:number;badge:string}{
  if(!Number.isSafeInteger(earned)||earned<0)throw Error("Invalid earned focus points");
  if(earned>=1500)return {level:4,badge:"持之以恒"};
  if(earned>=500)return {level:3,badge:"专注达人"};
  if(earned>=100)return {level:2,badge:"稳定前行"};
  return {level:1,badge:"刚刚启航"};
}
