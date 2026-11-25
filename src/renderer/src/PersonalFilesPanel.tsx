import {useEffect,useState} from "react";
import type {PersonalFilesOverview,RemotePersonalFile,StagedPersonalFile}
  from "../../shared/personal-file-sync";

const empty:PersonalFilesOverview={pending:[],remote:[]};
function msg(error:unknown):string{
  return error instanceof Error?error.message:"个人文件同步未完成";
}
export default function PersonalFilesPanel(){
  const [data,setData]=useState<PersonalFilesOverview>(empty);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [ready,setReady]=useState(false);
  async function refresh(){
    const list=await window.desktop.cloud.filesOverview();
    setData(list);setReady(true);
  }
  useEffect(()=>{
    let active=true;
    void window.desktop.cloud.filesOverview().then(value=>{
      if(active){setData(value);setReady(true);}
    }).catch(reason=>{if(active)setError(msg(reason));});
    return()=>{active=false;};
  },[]);
  async function run(action:()=>Promise<string>){
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{setNotice(await action());await refresh();}
    catch(reason){setError(msg(reason));}
    finally{setBusy(false);}
  }
  function chooseReplacement(file:RemotePersonalFile){
    if(!window.confirm("从本机选择一个新文件，准备替换云端「"+file.filename+
      "」的 v"+file.version+" 版本？这一步仅在本机暂存，不会上传。"))return;
    void run(async()=>{
      const item=await window.desktop.cloud.stageFile({
        fileId:file.fileId,version:file.version,
      });
      return item?"已暂存替换版本；需要另行确认上传。":"已取消选择文件";
    });
  }
  function upload(item:StagedPersonalFile){
    // Electron Main displays a native OS confirmation BEFORE network writes.
    void run(async()=>{
      const result=await window.desktop.cloud.uploadFile(item.fileId);
      if(result.status==="cancelled")return "已取消上传；本机暂存仍保留";
      return result.status==="conflict"
        ?"云端版本已变化（当前版本 "+(result.version??"不可用")+
          "），本机暂存未覆盖云端。请先下载核对，再取消旧暂存并选择新版本。"
        :"文件已上传；云端版本 "+result.version;
    });
  }
  function stop(item:StagedPersonalFile){
    if(!window.confirm("丢弃「"+item.filename+"」的本机待上传副本？"+
      "不会删除云端已经存在的文件，也不会删除原始文件。"))return;
    void run(async()=>{
      await window.desktop.cloud.stopLocalFile(item.fileId);
      return "已丢弃本机待上传副本；云端与原始文件未改变。";
    });
  }
  function download(item:RemotePersonalFile){
    void run(async()=>{
      const saved=await window.desktop.cloud.downloadFile(item.fileId,item.version);
      return "已核验 SHA-256 并保存 "+saved.bytes+" 字节到本机："+saved.path;
    });
  }
  function remove(item:RemotePersonalFile){
    // Native confirmation is enforced in Main, not only in Renderer JS.
    void run(async()=>{
      const result=await window.desktop.cloud.deleteRemoteFile(item.fileId,item.version);
      if(result.status==="cancelled")return "已取消云端删除；文件未改变";
      return result.status==="conflict"
        ?"云端版本已变化（"+(result.version??"不可用")+"）；删除未执行，请刷新核对。"
        :"云端文件内容已从当前记录删除；其他设备的本地副本不会自动擦除。";
    });
  }
  return <section className="panel cloud-personal-files" aria-label="个人文件选择性跨设备同步">
    <div className="panel-heading">
      <div><div className="eyebrow">V0.2 · EXPLICIT PERSONAL FILES</div>
        <h2>个人文件 · 逐份授权同步</h2></div>
      <button type="button" className="secondary-button" disabled={busy}
        onClick={()=>void run(async()=>{await refresh();return "云端目录已重新核对";})}>刷新文件列表</button>
    </div>
    <p className="privacy-note">
      仅同步你在系统文件选择器里明确挑选的单个文件（PDF / MD / TXT / HTML /
      LaTeX / CSV / JSON / ICS）；单文件最多 1 MiB，每账号最多 20 个有效文件。
      暂存只复制到本机，上传需要再次确认，不会扫描文件夹，也不会自动上传知识库、
      Canvas、邮件或其他隐私数据。内容在此版本<strong>没有端到端加密</strong>，
      仅适用于你信任其管理员的独立 Supabase 测试项目。
    </p>
    <div className="button-row">
      <button type="button" className="primary-button" disabled={busy}
        onClick={()=>void run(async()=>{
          const result=await window.desktop.cloud.stageFile();
          return result?"文件已暂存到本机；仍需人工确认上传":"未选择文件，未发生更改";
        })}>选择一个本机文件（仅暂存）</button>
      <span className="muted-tag">本地待上传 {data.pending.length} · 云端 {data.remote.length}/20</span>
    </div>
    {error&&<div className="error-banner" role="alert">{error}</div>}
    {notice&&<div className="connector-notice" role="status">{notice}</div>}
    {!ready&&<p className="privacy-note">云端文件服务尚未连接或未部署对应的 V0.2 SQL；请先核对独立测试项目的迁移。</p>}
    {data.pending.length>0&&<>
      <h3>仅本机暂存 · 不会后台发送</h3>
      <ul className="cloud-task-list">
        {data.pending.map(item=><li key={item.fileId}>
          <div>
            <strong>{item.filename}</strong>
            <small>{item.byteLength} 字节 · 基线版本 {item.baseVersion||"新文件"} ·
              SHA-256 {item.sha256.slice(0,12)}…</small>
          </div>
          <div className="button-row">
            <button className="primary-button" type="button" disabled={busy}
              onClick={()=>upload(item)}>确认上传</button>
            <button className="secondary-button" type="button" disabled={busy}
              onClick={()=>stop(item)}>丢弃本机暂存</button>
          </div>
        </li>)}
      </ul>
    </>}
    <h3>当前账号的云端文件</h3>
    {data.remote.length===0?<p className="empty-state">暂无已上传文件。另一个设备登录同一账号后，手动刷新才会列出已授权文件。</p>:
      <ul className="cloud-task-list">
        {data.remote.map(item=><li key={item.fileId}>
          <div><strong>{item.filename}</strong>
            <small>v{item.version} · {item.byteLength} 字节 ·
              SHA-256 {item.sha256.slice(0,12)}…</small>
          </div>
          <div className="button-row">
            <button className="secondary-button" type="button" disabled={busy}
              onClick={()=>download(item)}>核验并下载到本机</button>
            <button className="secondary-button" type="button" disabled={busy}
              onClick={()=>chooseReplacement(item)}>选择新版替换</button>
            <button className="text-button" type="button" disabled={busy}
              onClick={()=>remove(item)}>删除云端内容</button>
          </div>
        </li>)}
      </ul>}
    <p className="privacy-note">删除云端记录不等于删除其他电脑已下载的文件或 Supabase 数据库备份。
      本机暂存和下载文件保存在独立数据目录，不属于当前五库恢复包；
      重启后同一云端账号的待上传暂存仍可恢复。</p>
  </section>;
}
