import type { LocalStore } from "./local-store";
import type { FixedCalendarStore } from "./fixed-calendar-store";
import type {
  PersonalSyncLegacyAdoptionRequest, PersonalSyncLegacyItem, PersonalSyncLegacyReview,
} from "../shared/personal-sync-contract";

type LegacyTaskStore=Pick<LocalStore,"listLegacyPersonalSyncItems"|"adoptLegacyPersonalTaskSync">;
type LegacyCalendarStore=Pick<FixedCalendarStore,
  "listLegacyManualCalendarSyncItems"|"adoptLegacyManualEventSync">;
const REVIEW_LIMIT=100;

/** Ownerless rows stay offline in quarantine. Reads never enroll or upload. */
export function listLegacySyncReview(
  tasks:LegacyTaskStore,calendar:LegacyCalendarStore,
):PersonalSyncLegacyReview{
  const taskItems=tasks.listLegacyPersonalSyncItems(REVIEW_LIMIT+1);
  const calendarItems=calendar.listLegacyManualCalendarSyncItems(REVIEW_LIMIT+1);
  const items:PersonalSyncLegacyItem[]=[
    ...taskItems.slice(0,REVIEW_LIMIT).map(item=>({
      ...item,legacyStore:"task-database" as const,
    })),
    ...calendarItems.slice(0,REVIEW_LIMIT).map(item=>({
      ...item,legacyStore:"calendar-database" as const,
      entityType:"manual-calendar-event" as const,
    })),
  ];
  return {
    items,taskLimitReached:taskItems.length>REVIEW_LIMIT,
    calendarLimitReached:calendarItems.length>REVIEW_LIMIT,
  };
}

/**
 * Only a freshly reviewed, eligible row can be explicitly re-authorized to
 * Main's authenticated owner. Never reuse old ownerless snapshots/versions.
 * Old delete tombstones cannot be turned into remote delete operations.
 */
export function adoptReviewedLegacySync(
  tasks:LegacyTaskStore,calendar:LegacyCalendarStore,
  ownerId:string,input:PersonalSyncLegacyAdoptionRequest,
):void{
  const expectedStore=input.entityType==="personal-task"?"task-database":"calendar-database";
  const selected=listLegacySyncReview(tasks,calendar).items.find(item=>
    item.legacyStore===expectedStore&&item.entityType===input.entityType&&
    item.entityId===input.entityId);
  if(!selected||!selected.canReauthorize||
      selected.action!==input.expectedAction||
      selected.operationId!==input.expectedOperationId)
    throw Error("Legacy sync row changed or is not eligible; refresh before confirming");
  if(input.entityType==="personal-task")
    tasks.adoptLegacyPersonalTaskSync(ownerId,input.entityId,true);
  else
    calendar.adoptLegacyManualEventSync(ownerId,input.entityId,true);
}
