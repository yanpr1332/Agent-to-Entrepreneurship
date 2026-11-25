import type {FocusInsights,FocusInsightsDay,FocusInsightsTotals}
  from "../shared/local-model";

export interface FocusInsightRow {
  ended_at:string;elapsed_seconds:number;completed:number;
  points:number;time_source:string;
}
const DAY_MS=86_400_000;
const TIME_ZONE=/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/;
export function requireFocusTimeZone(value:unknown):string{
  if(typeof value!=="string"||!TIME_ZONE.test(value))
    throw Error("Invalid focus statistics timezone");
  try{
    return new Intl.DateTimeFormat("en-US",{timeZone:value})
      .resolvedOptions().timeZone;
  }catch{
    throw Error("Unsupported focus statistics timezone");
  }
}
function dayOffset(ymd:string,offset:number):string{
  const [year,month,day]=ymd.split("-").map(Number);
  return new Date(Date.UTC(year,month-1,day+offset)).toISOString().slice(0,10);
}
function dateKey(date:Date,fmt:Intl.DateTimeFormat):string{
  const parts=fmt.formatToParts(date);
  const value=(name:string)=>parts.find(p=>p.type===name)?.value;
  return value("year")+"-"+value("month")+"-"+value("day");
}
function totals(days:readonly FocusInsightsDay[],seconds:Map<string,number>):FocusInsightsTotals{
  const t={sessions:0,completedSessions:0,minutes:0,points:0};
  let sum=0;
  for(const day of days){
    t.sessions+=day.sessions;
    t.completedSessions+=day.completedSessions;
    t.points+=day.points;
    sum+=seconds.get(day.day)??0;
  }
  t.minutes=Math.floor(sum/60);
  return t;
}
/** Deterministic reporting from the full 30-day SQLite window rather than the
 * recent-500 UI history. Calendar arithmetic survives DST and leap dates. */
export function buildFocusInsights(
  rows:readonly FocusInsightRow[],timeZoneInput:unknown,now=new Date(),
):FocusInsights{
  const timeZone=requireFocusTimeZone(timeZoneInput);
  if(!Number.isFinite(now.getTime()))throw Error("Invalid statistics clock");
  const fmt=new Intl.DateTimeFormat("en-US",{
    timeZone,year:"numeric",month:"2-digit",day:"2-digit",
  });
  const today=dateKey(now,fmt);
  const days:FocusInsightsDay[]=Array.from({length:30},(_,i)=>({
    day:dayOffset(today,i-29),sessions:0,completedSessions:0,
    minutes:0,points:0,recordedSessions:0,estimatedSessions:0,
  }));
  const byDay=new Map(days.map(day=>[day.day,day]));
  const seconds=new Map<string,number>();
  for(const row of rows){
    const instant=Date.parse(row.ended_at);
    if(!Number.isFinite(instant)||instant>now.getTime()||
      !Number.isSafeInteger(row.elapsed_seconds)||row.elapsed_seconds<0||
      !Number.isSafeInteger(row.points)||row.points<0||
      (row.completed!==0&&row.completed!==1)||
      (row.time_source!=="recorded"&&row.time_source!=="estimated"))
      throw Error("Invalid stored focus statistics row");
    const key=dateKey(new Date(instant),fmt),day=byDay.get(key);
    if(!day)continue;
    day.sessions++;
    day.completedSessions+=row.completed;
    day.points+=row.points;
    seconds.set(key,(seconds.get(key)??0)+row.elapsed_seconds);
    day.minutes=Math.floor(seconds.get(key)!/60);
    if(row.time_source==="recorded")day.recordedSessions++;
    else day.estimatedSessions++;
  }
  const last7=totals(days.slice(-7),seconds);
  const previous7=totals(days.slice(-14,-7),seconds);
  const last30=totals(days,seconds);
  let pos=days.length-1;
  // Today is still in progress: a run ending yesterday is not yet broken.
  if(days[pos].completedSessions===0)pos--;
  let currentStreakDays=0;
  while(pos>=0&&days[pos].completedSessions>0){currentStreakDays++;pos--;}
  let bestStreakDays=0,consecutive=0;
  for(const day of days){
    consecutive=day.completedSessions?consecutive+1:0;
    bestStreakDays=Math.max(bestStreakDays,consecutive);
  }
  return {timeZone,asOf:now.toISOString(),days,
    last7,previous7,last30,currentStreakDays,bestStreakDays,
    estimatedSessions:days.reduce((sum,day)=>sum+day.estimatedSessions,0)};
}
