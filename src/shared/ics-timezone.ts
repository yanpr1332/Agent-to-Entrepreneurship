/** TZID conversion uses the host's IANA data, never executes calendar-provided VTIMEZONE code. */
function zonedParts(formatter:Intl.DateTimeFormat,date:Date):number[]{
  const map=new Map<string,string>();
  for(const part of formatter.formatToParts(date))map.set(part.type,part.value);
  return ["year","month","day","hour","minute","second"].map(name=>Number(map.get(name)));
}
export function resolveIanaTime(
  year:number,month:number,day:number,hour:number,minute:number,second:number,zone:string,
):Date{
  if(!/^[A-Za-z][A-Za-z0-9_+./-]{0,79}$/.test(zone))
    throw Error("Invalid ICS TZID");
  let formatter:Intl.DateTimeFormat;
  try{
    formatter=new Intl.DateTimeFormat("en-GB",{
      timeZone:zone,hourCycle:"h23",year:"numeric",month:"2-digit",
      day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",
    });
  }catch{throw Error("Unsupported IANA ICS TZID");}
  const wall=[year,month,day,hour,minute,second];
  const base=Date.UTC(year,month-1,day,hour,minute,second);
  const offsets=new Set<number>();
  for(const shift of [-36,-24,-12,0,12,24,36]){
    const sample=new Date(base+shift*3_600_000);
    const [y,m,d,h,mi,s]=zonedParts(formatter,sample);
    offsets.add(Date.UTC(y,m-1,d,h,mi,s)-sample.getTime());
  }
  const hits=[...offsets].map(offset=>new Date(base-offset)).filter(date=>{
    const p=zonedParts(formatter,date);
    return p.every((v,i)=>v===wall[i]);
  });
  if(hits.length!==1)
    throw Error("ICS TZID local time is missing or ambiguous at daylight saving transition");
  return hits[0];
}
