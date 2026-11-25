/** Read-only recovery preview: never sends database contents to Renderer. */
export interface RecoveryDatabase {
  name: "tasks"|"mail"|"knowledge"|"planning"|"calendar";
  bytes:number;
  userVersion:number;
  sha256Verified:boolean;
}
export interface RecoveryPreview {
  reviewId:string;
  expiresAt:string;
  createdAt:string;
  databases:RecoveryDatabase[];
  legacyManifest:boolean;
  /** Honest list of missing DBs and intentionally excluded data. */
  missing:string[];
}
export interface RecoveryResult {
  directory:string;
  databases:string[];
  /** Restored into an entirely new, not-yet-opened profile, never live userData. */
  isolated:true;
}
export interface RecoveryConfirmation {
  reviewId:string;
  confirmation:"RESTORE_TO_NEW_PROFILE";
}
export function parseRecoveryConfirmation(value:unknown):RecoveryConfirmation {
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid recovery request");
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join(",")!=="confirmation,reviewId"||
    v.confirmation!=="RESTORE_TO_NEW_PROFILE"||
    typeof v.reviewId!=="string"||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.reviewId))
      throw Error("Recovery requires a valid one-time approval");
  return {reviewId:v.reviewId,confirmation:v.confirmation};
}
