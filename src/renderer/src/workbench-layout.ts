/** Alpha workbench layout: device-local preferences, not cloud/team data.
 * Unknown/corrupted settings fail to safe defaults without throwing in render. */
export const WORKBENCH_STORAGE_KEY="study-anchor.workbench.layout.v1";
export const WORKBENCH_WIDGETS=[
  "tasks","schedule","focus","knowledge","team","canvas","mail","ai",
] as const;
export type WorkbenchWidget=(typeof WORKBENCH_WIDGETS)[number];
export type WorkbenchPreset="balanced"|"study"|"collaboration";
export type WorkbenchLayout={
  version:1;preset:WorkbenchPreset|"custom";
  order:WorkbenchWidget[];hidden:WorkbenchWidget[];
};
export const WORKBENCH_PRESETS:Record<WorkbenchPreset,readonly WorkbenchWidget[]>={
  balanced:["tasks","schedule","focus","knowledge","team","canvas","mail","ai"],
  study:["schedule","tasks","knowledge","focus","canvas","ai","mail","team"],
  collaboration:["team","mail","tasks","canvas","schedule","ai","knowledge","focus"],
};
const keys=new Set<string>(WORKBENCH_WIDGETS);
function widget(value:unknown):value is WorkbenchWidget{
  return typeof value==="string"&&keys.has(value);
}
export function presetLayout(preset:WorkbenchPreset="balanced"):WorkbenchLayout{
  return {version:1,preset,order:[...WORKBENCH_PRESETS[preset]],hidden:[]};
}
export function parseWorkbenchLayout(value:unknown):WorkbenchLayout{
  if(!value||typeof value!=="object"||Array.isArray(value))
    throw Error("Invalid workbench layout");
  const o=value as Record<string,unknown>;
  if(Object.keys(o).sort().join(",")!=="hidden,order,preset,version"||
     o.version!==1||!Array.isArray(o.order)||!Array.isArray(o.hidden))
    throw Error("Invalid workbench layout schema");
  if(o.preset!=="balanced"&&o.preset!=="study"&&
     o.preset!=="collaboration"&&o.preset!=="custom")
    throw Error("Unknown workbench layout preset");
  if(o.order.length!==WORKBENCH_WIDGETS.length||
    !o.order.every(widget)||new Set(o.order).size!==WORKBENCH_WIDGETS.length)
    throw Error("Missing or duplicate workbench module");
  if(o.hidden.length>WORKBENCH_WIDGETS.length||
    !o.hidden.every(widget)||new Set(o.hidden).size!==o.hidden.length)
    throw Error("Invalid hidden workbench module");
  const order=o.order as WorkbenchWidget[],hidden=o.hidden as WorkbenchWidget[];
  if(o.preset!=="custom"&&
    (hidden.length>0||order.some((w,i)=>w!==WORKBENCH_PRESETS[o.preset as WorkbenchPreset][i])))
    throw Error("Preset layout has unexpected edits");
  return {version:1,preset:o.preset,order:[...order],hidden:[...hidden]};
}
export function loadWorkbenchLayout(raw:string|null):WorkbenchLayout{
  if(raw===null||raw.length>2048)return presetLayout();
  try{return parseWorkbenchLayout(JSON.parse(raw));}
  catch{return presetLayout();}
}
export function visibleWorkbenchWidgets(layout:WorkbenchLayout):WorkbenchWidget[]{
  return layout.order.filter(w=>!layout.hidden.includes(w));
}
export function setWidgetVisible(layout:WorkbenchLayout,key:WorkbenchWidget,
  show:boolean):WorkbenchLayout{
  if(!keys.has(key))throw Error("Invalid workbench module");
  return {...layout,preset:"custom",order:[...layout.order],
    hidden:show?layout.hidden.filter(w=>w!==key):
      layout.hidden.includes(key)?[...layout.hidden]:[...layout.hidden,key]};
}
export function moveWorkbenchWidget(layout:WorkbenchLayout,
  key:WorkbenchWidget,delta:-1|1):WorkbenchLayout{
  if(!keys.has(key))throw Error("Invalid workbench module");
  const index=layout.order.indexOf(key),target=index+delta;
  if(index<0||target<0||target>=layout.order.length)return layout;
  const order=[...layout.order];
  [order[index],order[target]]=[order[target],order[index]];
  return {...layout,preset:"custom",order,hidden:[...layout.hidden]};
}
export function saveWorkbenchLayout(layout:WorkbenchLayout):string{
  return JSON.stringify(parseWorkbenchLayout(layout));
}
