import {useState} from "react";
import type {RecoveryPreview,RecoveryResult} from "../../shared/recovery-model";

function message(error:unknown):string{
  return error instanceof Error?error.message:"备份恢复操作未完成";
}
const names={tasks:"个人任务 / 专注 / 同步记录",mail:"邮箱头缓存",
  knowledge:"知识资料与复习",planning:"学习规划",calendar:"固定课程与日历"} as const;
/** Secure UI coordinator: native folder chooser and target chooser are both
 * Electron Main only. No arbitrary filesystem paths supplied by Renderer. */
export default function RecoveryCenter(){
  const [expanded,setExpanded]=useState(false);
  const [review,setReview]=useState<RecoveryPreview|null>(null);
  const [completed,setCompleted]=useState<RecoveryResult|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  async function inspect(){
    if(busy)return;
    setBusy(true);setError("");setNotice("");setCompleted(null);setReview(null);
    try{
      const next=await window.desktop.backup.inspect();
      if(next)setReview(next);
    }catch(e){setError(message(e));}
    finally{setBusy(false);}
  }
  async function restore(){
    if(!review||busy)return;
    if(!window.confirm(
      "这是恢复到独立配置目录，不是覆盖当前 Study Anchor 数据。"+
      "数据库备份未单独加密；原应用数据和备份保持不变。"+
      "不会复制邮箱/Canvas/AI Key、团队历史、原始资料、模型文件或界面偏好。"+
      "下一步请为恢复配置选择一个不存在的新目录；完成后须退出应用并"+
      "使用 STUDY_ANCHOR_USER_DATA_DIR 指向该目录才能打开恢复副本。继续？"
    ))return;
    setBusy(true);setError("");setNotice("");
    try{
      const result=await window.desktop.backup.restore({
        reviewId:review.reviewId,confirmation:"RESTORE_TO_NEW_PROFILE",
      });
      setReview(null);
      if(result){setCompleted(result);setNotice("已创建隔离恢复配置。当前运行中的数据库没有被更改。");}
      else setNotice("已取消选择新目录，没有修改现有数据。");
    }catch(e){setReview(null);setError(message(e));}
    finally{setBusy(false);}
  }
  async function cancel(){
    if(busy)return;
    setBusy(true);
    try{await window.desktop.backup.cancel();}
    catch(e){setError(message(e));}
    finally{setReview(null);setBusy(false);}
  }
  return <section className="panel" aria-label="本机备份核验与安全恢复">
    <div className="panel-heading">
      <div><div className="eyebrow">SAFE DATA RECOVERY · LOCAL ONLY</div>
        <h3>备份核验与独立恢复</h3></div>
      <button type="button" className="secondary-button" aria-expanded={expanded}
        onClick={()=>setExpanded(v=>!v)}>
        {expanded?"收起":"检查或恢复已有备份"}
      </button>
    </div>
    {expanded&&<>
      <p className="privacy-note">
        本工具只读取你主动选择的含 manifest.json 的本机备份目录，
        验证 SQLite quick_check、数据库版本和 SHA-256（旧版备份无校验和时会明确提示）。
        恢复只创建全新独立配置目录，绝不覆盖当前账号、当前数据库或原始备份。
      </p>
      <p className="privacy-note">
        这些备份<strong>未经额外加密</strong>，可能包含个人任务、邮件主题与课程资料；
        请勿上传到公共网络或分享。它不包含系统加密凭据、AI 用量账本、团队历史、
        原始磁盘资料、离线模型或工作台布局。恢复后要重新授权外部服务。
      </p>
      {error&&<p role="alert" className="error-banner">{error}</p>}
      {notice&&<p role="status" className="connector-notice">{notice}</p>}
      <div className="button-row">
        <button type="button" className="secondary-button" disabled={busy}
          onClick={()=>void inspect()}>从磁盘选择备份并验证</button>
        {review&&<button type="button" className="text-button" disabled={busy}
          onClick={()=>void cancel()}>取消本次恢复</button>}
      </div>
      {review&&<div className="connector-warning" role="region"
        aria-label="恢复前完整核对">
        <strong>已经检查备份 · 仅此预览授权有效至 {new Date(review.expiresAt).toLocaleString("zh-CN")}</strong>
        <p>备份时间：{new Date(review.createdAt).toLocaleString("zh-CN")}</p>
        <ul>{review.databases.map(db=><li key={db.name}>
          {names[db.name]} · {(db.bytes/1024/1024).toFixed(2)} MiB
          · SQLite v{db.userVersion} · {db.sha256Verified?"SHA-256 已核对":"旧版没有保存 SHA-256（已通过 SQLite 检查）"}
        </li>)}</ul>
        {review.missing.length>0&&<p role="note">
          此备份未包含以下数据库：{review.missing.join("、")}；
          恢复后这些数据不会出现。请确认是否接受不完整恢复。
        </p>}
        {review.legacyManifest&&<p role="note">
          旧版备份没有原始哈希记录，只能检查 SQLite 结构与当前文件哈希，
          无法证明文件从创建备份后未被修改。
        </p>}
        <button type="button" className="primary-button" disabled={busy}
          onClick={()=>void restore()}>我已核对范围，选择全新恢复目录</button>
      </div>}
      {completed&&<div className="connector-notice" role="status">
        <strong>隔离恢复副本创建完成</strong>
        <p>路径：<code>{completed.directory}</code></p>
        <p>先完全退出 Study Anchor，在重新启动前将
          <code>STUDY_ANCHOR_USER_DATA_DIR</code> 设置为上述目录，
          再启动应用检查数据。Windows/macOS 的操作方法见仓库
          ALPHA-CLOSE-03 验收文档。不要使用当前正在运行的配置目录做恢复目标。</p>
        <p>恢复副本将使用独立的本地用户配置，外部账号/密钥必须由本人重新授权，
          不等于原设备已自动切换或线上同步成功。</p>
      </div>}
    </>}
  </section>;
}
