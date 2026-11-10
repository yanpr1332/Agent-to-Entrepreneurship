import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { FocusSession, FocusSummary, LocalTask, TaskPriority } from "../../shared/local-model";
import { formatDueDate, localDateKey, monthCells } from "./calendar";
import CanvasConnector from "./CanvasConnector";
import CloudWorkspace from "./CloudWorkspace";
import CampusMail from "./CampusMail";
import KnowledgeBase from "./KnowledgeBase";

type Page = "overview" | "calendar" | "knowledge" | "focus" | "team" | "ai" | "connectors" | "mail";
type TaskFilter = "day" | "all" | "undated";
type RuntimeStatus = "checking" | "connected" | "unavailable";

const menu: { page: Page; icon: string; label: string; ready: boolean }[] = [
  { page: "overview", icon: "◫", label: "个人工作台", ready: true },
  { page: "calendar", icon: "▦", label: "日历与任务", ready: true },
  { page: "knowledge", icon: "◇", label: "个人知识库", ready: true },
  { page: "focus", icon: "◷", label: "专注与自律", ready: true },
  { page: "team", icon: "⌘", label: "小组协作", ready: true },
  { page: "ai", icon: "✳", label: "AI 辅助规划", ready: false },
  { page: "connectors", icon: "⇄", label: "数据接入", ready: true },
  { page: "mail", icon: "✉", label: "邮件管理", ready: true },
];

const emptySummary: FocusSummary = {
  sessions: 0, completedSessions: 0, totalMinutes: 0, points: 0,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后再试";
}

function FocusTimer({ onSaved }: { onSaved: () => Promise<void> }) {
  const [plannedMinutes, setPlannedMinutes] = useState(25);
  const [remaining, setRemaining] = useState(25 * 60);
  const [phase, setPhase] = useState<"idle" | "running" | "paused" | "finished">("idle");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const deadline = useRef(0);
  const sessionId = useRef<string | null>(null);

  useEffect(() => {
    if (phase !== "running") return;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0) setPhase("finished");
    };
    tick();
    const handle = setInterval(tick, 500);
    return () => clearInterval(handle);
  }, [phase]);

  function reset(): void {
    setPhase("idle");
    setRemaining(plannedMinutes * 60);
    sessionId.current = null;
  }

  function begin(): void {
    setError("");
    if (phase === "idle") {
      sessionId.current = crypto.randomUUID();
      setRemaining(plannedMinutes * 60);
      deadline.current = Date.now() + plannedMinutes * 60_000;
    } else if (phase === "paused") {
      deadline.current = Date.now() + remaining * 1000;
    }
    setPhase("running");
  }

  function pause(): void {
    setRemaining(Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000)));
    setPhase("paused");
  }

  async function finish(): Promise<void> {
    if (!sessionId.current || saving) return;
    const left = phase === "running"
      ? Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000))
      : remaining;
    setSaving(true);
    setError("");
    try {
      await window.desktop.focus.finish({
        sessionId: sessionId.current,
        plannedMinutes,
        elapsedSeconds: plannedMinutes * 60 - left,
      });
      await onSaved();
      reset();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");

  return (
    <section className="panel timer-panel">
      <div className="eyebrow">FOCUS SESSION</div>
      <h2>开始一段专注时间</h2>
      <p className="help-text">完成预定时长后可获得同等分钟数的积分，提前结束不奖励积分。</p>
      <div className="timer-display" role="timer" aria-live="off">{mm}:{ss}</div>
      <div className="timer-presets">
        {[1, 15, 25, 50].map((minutes) => (
          <button
            className={minutes === plannedMinutes ? "chip selected" : "chip"}
            key={minutes}
            disabled={phase !== "idle" || saving}
            onClick={() => { setPlannedMinutes(minutes); setRemaining(minutes * 60); }}
          >{minutes} 分钟</button>
        ))}
      </div>
      <div className="button-row centered">
        {phase === "idle" && <button className="primary-button" onClick={begin}>开始专注</button>}
        {phase === "running" && <button className="secondary-button" onClick={pause}>暂停</button>}
        {phase === "paused" && <button className="primary-button" onClick={begin}>继续计时</button>}
        {phase === "finished" && <span className="success-text">计时完成，可以保存并领取积分</span>}
        {phase !== "idle" && (
          <button className={phase === "finished" ? "primary-button" : "secondary-button"} disabled={saving} onClick={() => void finish()}>
            {saving ? "保存中…" : phase === "finished" ? "记录完成" : "结束并记录"}
          </button>
        )}
        {phase !== "idle" && <button className="ghost-button" disabled={saving} onClick={reset}>取消本次</button>}
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      <p className="privacy-note">计时和积分保存在本机。当前不限制其他应用或网站。</p>
    </section>
  );
}

function TaskRow({
  task, onToggle, onEdit, onRemove, onRestore, busy,
}: {
  task: LocalTask;
  onToggle: (task: LocalTask) => void;
  onEdit: (task: LocalTask) => void;
  onRemove: (task: LocalTask) => void;
  onRestore: (task: LocalTask) => void;
  busy: boolean;
}) {
  return (
    <li className={task.completed ? "task-item completed" : "task-item"}>
      <input
        type="checkbox" aria-label={`完成任务：${task.title}`} checked={task.completed}
        disabled={busy || !task.visible} onChange={() => onToggle(task)}
      />
      <div className="task-copy">
        <strong>{task.title}</strong>
        <div className="task-meta">
          <span>{formatDueDate(task.dueDate)}</span>
          <span className={`priority ${task.priority}`}>{task.priority === "high" ? "高优先级" : task.priority === "normal" ? "普通" : "低优先级"}</span>
        </div>
        {task.source && <p className="source-mark">Canvas 来源：${task.source.instanceUrl} · 课程 ${task.source.courseId} · 作业 ${task.source.assignmentId}</p>}
        {task.description && <p>{task.description}</p>}
        {!task.visible && <p className="hidden-expiry">已隐藏 · 本机保留至 {task.retentionExpiresAt ? new Date(task.retentionExpiresAt).toLocaleDateString("zh-CN") : "尚未设置"}</p>}
      </div>
      <div className="task-actions">
        {task.visible ? <>
          <button disabled={busy} onClick={() => onEdit(task)} aria-label={`编辑${task.title}`}>编辑</button>
          <button disabled={busy} onClick={() => onRemove(task)} aria-label={`${task.source ? "隐藏" : "删除"}${task.title}`}>{task.source ? "隐藏" : "删除"}</button>
        </> : <button disabled={busy} onClick={() => onRestore(task)} aria-label={`恢复显示${task.title}`}>恢复显示</button>}
      </div>
    </li>
  );
}

export default function App() {
  const today = localDateKey(new Date());
  const [page, setPage] = useState<Page>("overview");
  const [runtime, setRuntime] = useState<RuntimeStatus>("checking");
  const [version, setVersion] = useState("—");
  const [tasks, setTasks] = useState<LocalTask[]>([]);
  const [sessions, setSessions] = useState<FocusSession[]>([]);
  const [summary, setSummary] = useState<FocusSummary>(emptySummary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState(today);
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [selectedDate, setSelectedDate] = useState(today);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [filter, setFilter] = useState<TaskFilter>("day");
  const [showHidden, setShowHidden] = useState(false);
  const [retentionNotice, setRetentionNotice] = useState("");
  const [dark, setDark] = useState(() => window.localStorage.getItem("ate.theme") === "dark");

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    window.localStorage.setItem("ate.theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    let active = true;
    Promise.all([
      window.desktop.ping(), window.desktop.getVersion(),
      window.desktop.tasks.list(), window.desktop.focus.list(), window.desktop.focus.summary(),
    ]).then(([, appVersion, localTasks, localSessions, localSummary]) => {
      if (!active) return;
      setVersion(appVersion);
      setTasks(localTasks);
      setSessions(localSessions);
      setSummary(localSummary);
      setRuntime("connected");
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(errorMessage(reason));
      setRuntime("unavailable");
    });
    return () => { active = false; };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const [localTasks, localSessions, localSummary] = await Promise.all([
      window.desktop.tasks.list(), window.desktop.focus.list(), window.desktop.focus.summary(),
    ]);
    setTasks(localTasks);
    setSessions(localSessions);
    setSummary(localSummary);
  }, []);

  // Main-process scheduled syncs must refresh the workbench even if the
  // connection settings page is not currently open.
  useEffect(() => window.desktop.canvas.onSyncUpdated(() => {
    void refresh().catch(() => {});
  }), [refresh]);

  // Accepted mail candidates create ordinary personal tasks in the same local
  // SQLite authority and must refresh the calendar immediately.
  useEffect(() => window.desktop.mail.onSyncUpdated(() => {
    void refresh().catch(() => {});
  }), [refresh]);

  function resetTaskForm(): void {
    setEditingId(null);
    setTitle("");
    setDescription("");
    setDueDate(selectedDate);
    setPriority("normal");
  }

  function editTask(task: LocalTask): void {
    setPage("calendar");
    setEditingId(task.id);
    setTitle(task.title);
    setDescription(task.description);
    setDueDate(task.dueDate ?? "");
    setPriority(task.priority);
  }

  async function saveTask(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      if (editingId) {
        await window.desktop.tasks.update({
          id: editingId, title, description, dueDate: dueDate || null, priority,
        });
      } else {
        await window.desktop.tasks.create({
          title, description, dueDate: dueDate || null, priority,
        });
      }
      await refresh();
      resetTaskForm();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function toggleTask(task: LocalTask): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await window.desktop.tasks.update({ id: task.id, completed: !task.completed });
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removeTask(task: LocalTask): Promise<void> {
    const prompt = task.source
      ? `隐藏「${task.title}」？该任务将在本机保留六个月后自动清理，期间可从「隐藏任务」中恢复。Canvas 原始作业不会被删除。`
      : `确定永久删除「${task.title}」？删除后无法撤销。`;
    if (!window.confirm(prompt)) return;
    setBusy(true);
    setError("");
    try {
      await window.desktop.tasks.remove(task.id);
      await refresh();
      if (task.source) setRetentionNotice("已隐藏 Canvas 任务。它将在本机保留六个月，可随时从「隐藏任务」恢复；到期前 30 天会提醒。");
      if (editingId === task.id) resetTaskForm();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function restoreCanvasTask(task: LocalTask): Promise<void> {
    if (!task.source) return;
    setBusy(true);
    setError("");
    try {
      await window.desktop.tasks.visibility(task.id, true);
      await refresh();
      setRetentionNotice("该 Canvas 任务已恢复显示。");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const shownTasks = tasks.filter((task) => task.visible);
  const hiddenTasks = tasks.filter((task) => !task.visible && task.source);
  const expiringSoon = hiddenTasks.filter((task) => task.retentionExpiresAt &&
    Date.parse(task.retentionExpiresAt) - Date.now() <= 30 * 86400000).length;
  const pendingTasks = shownTasks.filter((task) => !task.completed);
  const todayTasks = pendingTasks.filter((task) => task.dueDate === today);
  const visibleTasks = showHidden ? hiddenTasks : shownTasks.filter((task) =>
    filter === "all" || (filter === "day" && task.dueDate === selectedDate) ||
    (filter === "undated" && task.dueDate === null),
  );
  const calendar = monthCells(month.getFullYear(), month.getMonth());
  const nextTasks = pendingTasks.slice(0, 5);
  const selectedModule = menu.find((item) => item.page === page)!;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">A</div><div><strong>AtE Workspace</strong><span>个人学习与协作空间</span></div></div>
        <div className="workspace-switch"><span className="workspace-dot" />个人工作空间 <span className="chevron">⌄</span></div>
        <div className="nav-label">工作空间</div>
        <nav aria-label="应用导航">
          {menu.map((item) => (
            <button
              key={item.page}
              className={page === item.page ? "nav-item active" : "nav-item"}
              onClick={() => setPage(item.page)}
              aria-current={page === item.page ? "page" : undefined}
            ><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{!item.ready && <span className="nav-pending">·</span>}</button>
          ))}
        </nav>
        <div className="sidebar-bottom"><div className="avatar">U</div><div><strong>本地用户</strong><span>个人数据只保存在本机</span></div>
          <button className="icon-button" title="切换主题" aria-label="切换浅色或深色主题" onClick={() => setDark(!dark)}>{dark ? "☀" : "☾"}</button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">个人工作空间 <span>/</span> {selectedModule.label}</div>
          <div className="top-actions"><span className="local-label">◈ 本地优先</span><div className="avatar small">U</div></div>
        </header>
        <div className="content">
          {error && <div className="error-banner" role="alert"><strong>操作未完成：</strong> {error}<button onClick={() => setError("")}>关闭</button></div>}

          {page === "overview" && (
            <>
              <div className="welcome-row"><div><div className="eyebrow">YOUR WORKSPACE</div><h1>把重要的事情，<em>一步步做好。</em></h1><p>日程、任务与专注记录已接入本地数据库，重启后可以恢复。</p></div><div className="date-card"><span>当前版本</span><strong>{version}</strong><small>内部开发原型</small></div></div>
              <div className="status-banner"><div className="status-icon">✦</div><div className="status-copy"><strong>{runtime === "connected" ? "本地工作空间已连接" : "正在检查本地工作空间"}</strong><span>个人任务与专注记录仅存储在本机。Canvas 和邮箱为开发验证版；云端协作 PoC 需配置测试项目并完成真实权限验收。</span></div>
                <div className="runtime-status"><i className={runtime === "connected" ? "online" : runtime === "unavailable" ? "offline" : ""} />{runtime === "connected" ? "SQLite 已连接" : runtime === "checking" ? "检查中" : "不可用"}</div>
              </div>
              <div className="metric-grid">
                <div className="metric-card"><span>今日待办</span><strong>{todayTasks.length}</strong><small>今天截止且未完成</small></div>
                <div className="metric-card"><span>全部待办</span><strong>{pendingTasks.length}</strong><small>未完成的个人任务</small></div>
                <div className="metric-card"><span>专注分钟</span><strong>{summary.totalMinutes}</strong><small>累计专注记录</small></div>
                <div className="metric-card"><span>专注积分</span><strong>{summary.points}</strong><small>已完成专注获得</small></div>
              </div>
              <div className="section-heading"><div><div className="eyebrow">READY TO USE</div><h2>马上开始</h2></div></div>
              <div className="quick-grid"><button className="quick-card" onClick={() => setPage("calendar")}><span>▦</span><strong>管理我的任务</strong><small>创建、编辑、完成和查看日历</small></button><button className="quick-card" onClick={() => setPage("focus")}><span>◷</span><strong>开始专注</strong><small>计时、历史和积分</small></button></div>
              <div className="bottom-grid">
                <section className="panel"><div className="panel-heading"><div><div className="eyebrow">UP NEXT</div><h2>接下来的任务</h2></div><button className="text-button" onClick={() => { setPage("calendar"); setFilter("all"); }}>查看全部 →</button></div>
                  {nextTasks.length ? <ul className="compact-task-list">{nextTasks.map((task) => <li key={task.id}><span className="task-dot" /><div><strong>{task.title}</strong><small>{formatDueDate(task.dueDate)}</small></div><button onClick={() => editTask(task)}>编辑</button></li>)}</ul> : <p className="empty-state">暂无待办。创建第一条任务，开始整理今天。</p>}
                </section>
                <section className="panel runtime-panel"><div className="eyebrow">SYSTEM STATUS</div><h2>运行状态</h2>
                  <div className="runtime-line"><span>Electron / 本地 SQLite</span><strong>{runtime === "connected" ? "可用" : runtime === "checking" ? "检查中" : "异常"}</strong></div>
                  <div className="runtime-line"><span>个人任务与日历</span><strong>{runtime === "connected" ? "可用" : "未连接"}</strong></div>
                  <div className="runtime-line"><span>云端协作</span><strong className="not-ready">候选 PoC，需配置测试云</strong></div>
                  <div className="runtime-line"><span>Canvas 与邮箱</span><strong>开发验证版</strong></div>
                  <p className="privacy-note">个人任务与专注数据不会自动上传云端。</p>
                </section>
              </div>
            </>
          )}

          {page === "calendar" && (
            <>
              <div className="page-heading"><div><div className="eyebrow">PERSONAL CALENDAR</div><h1>日历与任务</h1><p>创建和安排个人任务，所有变更保存在本机 SQLite。</p></div><span className="count-chip">{shownTasks.length} 条展示中的任务</span></div>
              <div className="calendar-layout">
                <div className="calendar-column">
                  <section className="panel calendar-panel">
                    <div className="calendar-header"><h2>{month.getFullYear()} 年 {month.getMonth() + 1} 月</h2><div className="button-row"><button className="icon-button" aria-label="上个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>‹</button><button className="small-button" onClick={() => { setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); setSelectedDate(today); setFilter("day"); }}>今天</button><button className="icon-button" aria-label="下个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>›</button></div></div>
                    <div className="weekday-row">{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>{day}</span>)}</div>
                    <div className="calendar-grid">{calendar.map((day) => {
                      const hasTasks = shownTasks.some((task) => task.dueDate === day.key);
                      return <button key={day.key} className={["calendar-day", day.currentMonth ? "" : "muted-day", day.key === selectedDate ? "selected-day" : "", day.key === today ? "today-day" : ""].join(" ")}
                        onClick={() => { setSelectedDate(day.key); setFilter("day"); setShowHidden(false); if (!day.currentMonth) { const [y, m] = day.key.split("-").map(Number); setMonth(new Date(y, m - 1, 1)); } }} aria-label={day.key}>
                        <span>{day.day}</span>{hasTasks && <i className="day-dot" />}
                      </button>;
                    })}</div>
                  </section>
                  <section className="panel task-list-panel"><div className="panel-heading"><div><div className="eyebrow">MY TASKS</div><h2>{showHidden ? "隐藏的 Canvas 任务" : filter === "day" ? formatDueDate(selectedDate) : filter === "undated" ? "未安排日期" : "全部任务"}</h2></div><span className="muted-tag">{visibleTasks.length} 条</span></div>
                    <div className="filter-tabs">
                      <button className={!showHidden && filter === "day" ? "chip selected" : "chip"} onClick={() => { setShowHidden(false); setFilter("day"); }}>选中日期</button>
                      <button className={!showHidden && filter === "all" ? "chip selected" : "chip"} onClick={() => { setShowHidden(false); setFilter("all"); }}>全部</button>
                      <button className={!showHidden && filter === "undated" ? "chip selected" : "chip"} onClick={() => { setShowHidden(false); setFilter("undated"); }}>无日期</button>
                      <button className={showHidden ? "chip selected" : "chip"} onClick={() => setShowHidden(true)}>隐藏任务 ({hiddenTasks.length})</button>
                    </div>
                    {retentionNotice && <p className="retention-banner" role="status">{retentionNotice}</p>}
                    {expiringSoon > 0 && <p className="retention-warning" role="status">有 {expiringSoon} 条隐藏的 Canvas 任务将在 30 天内到期清理。可在「隐藏任务」中恢复。</p>}
                    {showHidden && <p className="privacy-note">隐藏的 Canvas 任务在本机数据库保留六个月，到期后自动清理。显示每条任务的预计清理日期；隐藏不会删除 Canvas 原始作业。</p>}
                    {visibleTasks.length ? <ul className="task-list">{visibleTasks.map((task) => <TaskRow key={task.id} task={task} busy={busy} onToggle={(t) => void toggleTask(t)} onEdit={editTask} onRemove={(t) => void removeTask(t)} onRestore={(t) => void restoreCanvasTask(t)} />)}</ul> : <p className="empty-state">{showHidden ? "没有隐藏的 Canvas 任务。" : "这里还没有任务。可以在右侧创建一条。"}</p>}
                  </section>
                </div>
                <section className="panel task-editor"><div className="eyebrow">TASK EDITOR</div><h2>{editingId ? "编辑任务" : "新建任务"}</h2>
                  <form onSubmit={(event) => void saveTask(event)}>
                    <label>任务名称<input required maxLength={120} autoComplete="off" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：完成项目报告" /></label>
                    <label>备注<textarea rows={4} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="补充信息（可选）" /></label>
                    <label>截止日期<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
                    <label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}><option value="low">低</option><option value="normal">普通</option><option value="high">高</option></select></label>
                    <button className="primary-button full-width" disabled={busy || runtime !== "connected"} type="submit">{busy ? "保存中…" : editingId ? "保存修改" : "创建任务"}</button>
                    {editingId && <button className="secondary-button full-width" type="button" onClick={resetTaskForm}>取消编辑</button>}
                  </form>
                  <p className="privacy-note">任务仅保存在此设备。团队共享将在独立授权后接入。</p>
                </section>
              </div>
            </>
          )}

          {page === "focus" && (
            <>
              <div className="page-heading"><div><div className="eyebrow">FOCUS & REWARD</div><h1>专注与自律</h1><p>按自己的节奏执行计划，每次专注均留下本地记录。</p></div><span className="count-chip">{summary.points} 积分</span></div>
              <div className="focus-layout"><FocusTimer onSaved={refresh} />
                <div className="focus-side"><section className="panel"><div className="eyebrow">YOUR PROGRESS</div><h2>累计成绩</h2>
                  <div className="focus-summary"><div><strong>{summary.completedSessions}</strong><span>完成场次</span></div><div><strong>{summary.totalMinutes}</strong><span>专注分钟</span></div><div><strong>{summary.points}</strong><span>已获积分</span></div></div>
                </section>
                <section className="panel"><div className="eyebrow">HISTORY</div><h2>最近记录</h2>
                  {sessions.length ? <ul className="history-list">{sessions.slice(0, 8).map((session) => <li key={session.id}><div><strong>{session.completed ? "已完成" : "提前结束"} · {Math.floor(session.elapsedSeconds / 60)} 分钟</strong><small>{new Date(session.endedAt).toLocaleString("zh-CN")}</small></div><span>+{session.points}</span></li>)}</ul> : <p className="empty-state">暂无专注记录。</p>}
                </section></div>
              </div>
            </>
          )}

          {page === "knowledge" && <KnowledgeBase />}
          {page === "connectors" && <CanvasConnector onTasksChanged={refresh} />}
          {page === "team" && <CloudWorkspace />}
          {page === "mail" && <CampusMail />}

          {!selectedModule.ready && (
            <div className="placeholder-panel"><span className="placeholder-icon">{selectedModule.icon}</span><div className="eyebrow">NEXT DEVELOPMENT SLICE</div><h1>{selectedModule.label}</h1><p>该模块属于 V0.1 开发范围，但本次工程切片尚未实现真实功能。这里不会使用模拟数据冒充已接入。</p><div className="placeholder-actions"><button className="primary-button" onClick={() => setPage("overview")}>返回工作台</button><button className="secondary-button" onClick={() => setPage("calendar")}>使用任务管理</button></div></div>
          )}
          <footer>Agent-to-Entrepreneurship · Local-first by design · 内部开发原型</footer>
        </div>
      </main>
    </div>
  );
}
