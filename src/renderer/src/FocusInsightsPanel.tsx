import {useEffect,useState} from "react";
import type {FocusInsights} from "../../shared/local-model";

interface Props {active:boolean;refreshKey:number;}
/** Deliberately aggregates in Main, not from the truncated last-500 UI list.
 * No session title, private contents or raw local paths leave the machine. */
export default function FocusInsightsPanel({active,refreshKey}:Props){
  const [report,setReport]=useState<FocusInsights|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{
    if(!active)return;
    let alive=true;
    const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC";
    setBusy(true);
    void window.desktop.focus.insights(zone).then(next=>{
      if(alive){setReport(next);setError("");}
    }).catch(reason=>{
      if(alive)setError(reason instanceof Error?reason.message:"本机统计暂不可用");
    }).finally(()=>{if(alive)setBusy(false);});
    return ()=>{alive=false;};
  },[active,refreshKey]);
  const week=report?.days.slice(-7)??[];
  const max=Math.max(1,...week.map(x=>x.minutes));
  return <section className="panel focus-insights" aria-label="本地专注趋势">
    <div className="eyebrow">FOCUS INSIGHTS · ON DEVICE</div>
    <h2>近期专注趋势</h2>
    <p className="privacy-note">按这台设备当前时区、每段专注的结束日期统计；
      包含提前结束的有效分钟，但只有完整完成的场次计算连续完成天数。
      数据直接从本机 SQLite 汇总，不会上传。</p>
    {busy&&<p role="status">正在汇总本机记录…</p>}
    {error&&<p className="error-banner" role="alert">{error}</p>}
    {report&&<div>
      <div className="focus-summary">
        <div><strong>{report.last7.minutes}</strong><span>近 7 天分钟</span></div>
        <div><strong>{report.last7.completedSessions}</strong><span>近 7 天完成</span></div>
        <div><strong>{report.currentStreakDays}</strong><span>连续完成天数</span></div>
      </div>
      <p className="privacy-note">前 7 天：{report.previous7.minutes} 分钟；
        最近 30 天：{report.last30.minutes} 分钟、{report.last30.sessions} 次记录、
        {report.last30.points} 积分。30 天内最长连续完成 {report.bestStreakDays} 天。</p>
      <h3>最近 7 天</h3>
      <ul className="kb-review-list">
        {week.map(day=><li key={day.day}>
          <div className="button-row">
            <span>{day.day.slice(5)}</span>
            <progress value={day.minutes} max={max}
              aria-label={day.day+" 的有效专注分钟数"} />
            <strong>{day.minutes} 分钟</strong>
            <small>{day.completedSessions}/{day.sessions} 场完成</small>
          </div>
        </li>)}
      </ul>
      <details>
        <summary>查看完整 30 天明细</summary>
        <table>
          <thead><tr><th scope="col">日期</th><th scope="col">有效分钟</th>
            <th scope="col">场次/完成</th><th scope="col">积分</th></tr></thead>
          <tbody>{report.days.map(day=><tr key={day.day}>
            <th scope="row">{day.day}</th><td>{day.minutes}</td>
            <td>{day.sessions} / {day.completedSessions}</td><td>{day.points}</td>
          </tr>)}</tbody>
        </table>
      </details>
      {report.estimatedSessions>0&&
        <p className="privacy-note">其中 {report.estimatedSessions} 条为旧版估算起止时间的记录；
          它们可计入总量，但不能被当作真实测量的专注时段。</p>}
      <p className="privacy-note">时区：{report.timeZone}。跨午夜的专注全部归属结束当天；
        少于 1 分钟的场次先按秒累加再显示整数分钟。30 天最长连续天数仅表示此窗口内的纪录。</p>
    </div>}
  </section>;
}
