import {useEffect,useRef,useState,type FormEvent} from "react";
import type {FocusReward,FocusRewardOverview} from "../../shared/local-model";
interface Props {active:boolean;refreshKey:number;}
function message(reason:unknown):string{
  return reason instanceof Error?reason.message:"本机奖励操作未完成";
}
function validCost(raw:string):number|null{
  if(!/^[1-9]\d{0,6}$/.test(raw))return null;
  const n=Number(raw);
  return Number.isSafeInteger(n)&&n<=1000000?n:null;
}
/** A promise to yourself, never an actual purchased reward.
 * In Main the earned balance comes only from the completed-session ledger. */
export default function FocusRewardsPanel({active,refreshKey}:Props){
  const [data,setData]=useState<FocusRewardOverview|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [title,setTitle]=useState("");
  const [description,setDescription]=useState("");
  const [cost,setCost]=useState("30");
  const [editId,setEditId]=useState<string|null>(null);
  const [editorOpen,setEditorOpen]=useState(false);
  const [activeReward,setActiveReward]=useState(true);
  const [editRevision,setEditRevision]=useState("");
  // If the IPC promise fails after Main committed, retrying must reuse the
  // same ID so a transient transport failure cannot double-spend points.
  const pendingReceipts=useRef(new Map<string,string>());
  async function reload():Promise<void>{
    setData(await window.desktop.focus.rewards());
  }
  useEffect(()=>{
    if(!active)return;
    let alive=true;
    setBusy(true);
    void window.desktop.focus.rewards().then(value=>{
      if(alive){setData(value);setError("");}
    }).catch(e=>{if(alive)setError(message(e));})
      .finally(()=>{if(alive)setBusy(false);});
    return ()=>{alive=false;};
  },[active,refreshKey]);

  function clearEditor():void{
    setTitle("");setDescription("");setCost("30");
    setEditId(null);setEditRevision("");setActiveReward(true);
    setEditorOpen(false);
  }
  function beginEdit(reward:FocusReward):void{
    setEditId(reward.id);setEditorOpen(true);
    setTitle(reward.title);setDescription(reward.description);
    setCost(String(reward.cost));setEditRevision(reward.updatedAt);
    setActiveReward(reward.active);setError("");setNotice("");
  }
  async function saveReward(event:FormEvent<HTMLFormElement>):Promise<void>{
    event.preventDefault();
    const price=validCost(cost);
    if(price===null){setError("兑换所需积分必须是 1–1,000,000 的整数");return;}
    setBusy(true);setError("");setNotice("");
    try{
      if(editId){
        await window.desktop.focus.editReward({
          id:editId,title,description,cost:price,active:activeReward,
          expectedUpdatedAt:editRevision,
        });
        setNotice("奖励设置已保存。已兑换记录保留当时的名称和积分。");
      }else{
        await window.desktop.focus.createReward({title,description,cost:price});
        setNotice("本机自定义奖励已创建。");
      }
      clearEditor();await reload();
    }catch(e){setError(message(e));}
    finally{setBusy(false);}
  }
  async function redeem(reward:FocusReward):Promise<void>{
    if(busy||!data||data.available<reward.cost||!reward.active)return;
    const id=pendingReceipts.current.get(reward.id)??crypto.randomUUID();
    if(!window.confirm("确认花费 "+reward.cost+" 个虚拟专注积分兑换「"+
      reward.title+"」？这只记录你的个人奖励计划，软件不会购买或实际发放任何东西。"+
      "提交成功后不能撤销该笔积分消费。"))return;
    pendingReceipts.current.set(reward.id,id);
    setBusy(true);setError("");setNotice("");
    try{
      const receipt=await window.desktop.focus.redeemReward({
        rewardId:reward.id,redemptionId:id,
      });
      pendingReceipts.current.delete(reward.id);
      setNotice("兑换已记录："+receipt.rewardTitle+"（消耗 "+receipt.cost+
        " 积分），请自行安排现实奖励。");
      await reload();
    }catch(e){
      setError(message(e)+"。若上次请求状态未知，重新点击同一奖励会使用相同兑换编号。");
      try{await reload();}catch{/* Keep initial useful error and retry id. */}
    }finally{setBusy(false);}
  }
  return <section className="panel focus-rewards" aria-label="本机自定义奖励">
    <div className="eyebrow">LOCAL VIRTUAL REWARDS</div>
    <h2>我的虚拟奖励</h2>
    <p className="privacy-note">奖励由你自己设定并履行，不涉及真实支付、自动购买或软件发放。
      兑换仅写入本机 SQLite 账本。未完成的专注不赚积分。</p>
    {error&&<p role="alert" className="error-banner">{error}</p>}
    {notice&&<p role="status" className="connector-notice">{notice}</p>}
    {data&&<>
      <div className="focus-summary">
        <div><strong>{data.available}</strong><span>可用积分</span></div>
        <div><strong>{data.earned}</strong><span>累计赚取</span></div>
        <div><strong>{data.spent}</strong><span>累计兑换</span></div>
      </div>
      <p className="privacy-note">等级 {data.level} · {data.badge}（按累计赚取计，
        不会因兑换而降低）。账户积分不是现金、优惠券或现实奖励承诺。</p>
    </>}
    <button type="button" className="secondary-button" disabled={busy}
      onClick={()=>{if(editorOpen)clearEditor();else setEditorOpen(true);}}>
      {editorOpen?"收起奖励编辑器":"创建新奖励"}
    </button>
    {editorOpen&&<form onSubmit={event=>void saveReward(event)}>
        <label>奖励名称
          <input required maxLength={100} value={title} disabled={busy}
            placeholder="例如：看一部电影" onChange={e=>setTitle(e.target.value)}/></label>
        <label>奖励说明（可选）
          <textarea rows={2} maxLength={500} value={description} disabled={busy}
            onChange={e=>setDescription(e.target.value)}/></label>
        <label>兑换积分（1–1,000,000）
          <input required type="number" min={1} max={1000000} step={1}
            value={cost} disabled={busy} onChange={e=>setCost(e.target.value)}/></label>
        {editId&&<label><input type="checkbox" checked={activeReward}
          disabled={busy} onChange={e=>setActiveReward(e.target.checked)}/>
          允许继续兑换（取消勾选即停用，不删除历史）</label>}
        <div className="button-row">
          <button type="submit" className="primary-button"
            disabled={busy||validCost(cost)===null||!title.trim()}>
            {editId?"保存奖励设置":"创建奖励"}</button>
          {editId&&<button type="button" className="secondary-button"
            disabled={busy} onClick={clearEditor}>取消编辑</button>}
        </div>
      </form>}
    <h3>我的奖励目录</h3>
    {data?.rewards.length?<ul className="kb-review-list">
      {data.rewards.map(item=><li key={item.id}>
        <strong>{item.title}</strong>
        <p>{item.cost} 积分 · {item.active?"可兑换":"已停用"}</p>
        {item.description&&<p>{item.description}</p>}
        <div className="button-row">
          <button type="button" className="secondary-button" disabled={busy}
            onClick={()=>beginEdit(item)}>编辑/停用</button>
          <button type="button" className="primary-button"
            disabled={busy||!item.active||data.available<item.cost}
            onClick={()=>void redeem(item)}>确认兑换</button>
        </div>
      </li>)}
    </ul>:<p className="empty-state">还没有自定义奖励。你可以先设定一个小目标。</p>}
    <details>
      <summary>最近的兑换记录（最多 100 条展示）</summary>
      {data?.recentRedemptions.length?<ul className="kb-review-list">
        {data.recentRedemptions.map(r=><li key={r.id}>
          <strong>{r.rewardTitle}</strong>
          <small>消耗 {r.cost} 积分 · {new Date(r.redeemedAt).toLocaleString("zh-CN")}</small>
        </li>)}
      </ul>:<p>暂无兑换记录。</p>}
      <p className="privacy-note">账本余额计算包含全部历史兑换，而不仅是页面显示的最近 100 条。
        修改奖励名称或所需积分不会改变旧兑换凭据。</p>
    </details>
  </section>;
}
