import { useEffect, useState, type FormEvent } from "react";
import type {
  CanvasAssignment, CanvasAutoSyncSummary, CanvasConnectionStatus,
  CanvasCourse, CanvasCourseSetting,
} from "../../shared/canvas-model";

const disconnected: CanvasConnectionStatus = {
  connected: false, baseUrl: null, mode: null,
};
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请检查网络和 Canvas 授权";
}
function dateText(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "尚无记录";
}

/** The UI never stores a Canvas token outside the current password input. */
export default function CanvasConnector({ onTasksChanged }: { onTasksChanged: () => Promise<void> }) {
  const [status, setStatus] = useState<CanvasConnectionStatus>(disconnected);
  const [baseUrl, setBaseUrl] = useState("https://oc.sjtu.edu.cn");
  const [token, setToken] = useState("");
  const [courses, setCourses] = useState<CanvasCourse[]>([]);
  const [courseSettings, setCourseSettings] = useState<CanvasCourseSetting[]>([]);
  const [courseId, setCourseId] = useState<number | null>(null);
  const [assignments, setAssignments] = useState<CanvasAssignment[]>([]);
  const [syncStatus, setSyncStatus] = useState<CanvasAutoSyncSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    const unsubscribe = window.desktop.canvas.onSyncUpdated(() => {
      if (!active) return;
      void window.desktop.canvas.syncStatus().then((report) => {
        if (active) setSyncStatus(report);
      }).catch(() => {});
      void onTasksChanged().catch(() => {});
    });
    void Promise.all([
      window.desktop.canvas.status(),
      window.desktop.canvas.syncStatus(),
    ]).then(async ([connection, report]) => {
      if (!active) return;
      setStatus(connection);
      setSyncStatus(report);
      if (connection.baseUrl) setBaseUrl(connection.baseUrl);
      if (!connection.connected) return;
      const [remoteCourses, settings] = await Promise.all([
        window.desktop.canvas.courses(), window.desktop.canvas.courseSettings(),
      ]);
      if (!active) return;
      setCourses(remoteCourses);
      setCourseSettings(settings);
    }).catch((reason: unknown) => { if (active) setError(errorText(reason)); });
    return () => { active = false; unsubscribe(); };
  }, [onTasksChanged]);

  async function connect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading || !token.trim()) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const connected = await window.desktop.canvas.connect({ baseUrl, token });
      setStatus(connected.status);
      setCourses(connected.courses);
      setToken("");
      setCourseSettings(await window.desktop.canvas.courseSettings());
      setAssignments([]);
      setCourseId(null);
      setNotice("已验证个人 Canvas 连接，正在自动同步未屏蔽课程的作业和日历事项。");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  async function syncNow(): Promise<void> {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const report = await window.desktop.canvas.syncNow();
      setSyncStatus(report);
      await onTasksChanged();
      setNotice(report.lastError
        ? `同步部分完成：${report.lastError}`
        : `同步完成：检查 ${report.coursesChecked} 门课程，新增 ${report.created} 条作业任务，新增 ${report.calendarCreated??0} 条日历事项，更新 ${report.calendarChanged??0} 条日历事项。`);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  async function toggleCourse(courseId: number, enabled: boolean): Promise<void> {
    setLoading(true);
    setError("");
    try {
      await window.desktop.canvas.setCourseEnabled(courseId, enabled);
      setCourseSettings((previous) => [...previous.filter((item) => item.courseId !== courseId), { courseId, enabled }]);
      if (enabled) await syncNow();
      else setNotice("已暂停这门课程的自动同步；已有任务不会被删除，可在日历中单独隐藏。");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  async function showAssignments(id: number): Promise<void> {
    setLoading(true);
    setError("");
    setCourseId(id);
    setAssignments([]);
    try {
      const remote = await window.desktop.canvas.assignments(id);
      setAssignments(remote);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  async function disconnect(): Promise<void> {
    if (!window.confirm("断开 Canvas 并删除本机加密保存的个人 Token？已同步的本地任务和日历缓存将保留，但断开后不显示其他账号的日历。")) return;
    setLoading(true);
    setError("");
    try {
      await window.desktop.canvas.disconnect();
      setStatus(disconnected);
      setCourseSettings([]);
      setCourses([]);
      setAssignments([]);
      setToken("");
      setCourseId(null);
      setNotice("Canvas 已断开，本机加密 Token 已删除。本地已同步任务仍在。");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  function isCourseEnabled(id: number): boolean {
    return courseSettings.find((item) => item.courseId === id)?.enabled !== false;
  }

  return (
    <section className="connector-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">EXTERNAL CONNECTORS</div>
          <h1>Canvas 自动同步</h1>
          <p>连接后默认同步当前课程作业和近期日历事项，个人任务及 Canvas 日历项可单独显示或隐藏。</p>
        </div>
        <span className="count-chip">{status.connected ? "Canvas 已连接" : "尚未连接"}</span>
      </div>
      <div className="connector-warning" role="note">
        <strong>个人 API Token 仅供开发者本人在本机验证。</strong>
        多用户正式接入仍需学校授权 Developer Key + OAuth。请勿向团队成员分享 Token。
        连接后默认自动收集当前可访问课程的作业及近期日历事项（过去 14 天、未来 180 天）；你可以暂停单门课程同步，
        也可以在日历中隐藏单条任务或日历事项。隐藏的 Canvas 记录会保留六个月。
      </div>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}
      {notice && <div className="connector-notice" role="status">{notice}</div>}
      <div className="connector-layout">
        <section className="panel">
          <div className="eyebrow">CONNECTION</div>
          <h2>连接设置</h2>
          {status.connected ? (
            <>
              <p className="help-text">连接方式：开发者个人 Token（系统加密保存）</p>
              <p className="connector-host">{status.baseUrl}</p>
              <p className="help-text">运行中每 30 分钟检查同步一次；关闭应用后不保证继续同步。</p>
              <div className="button-row">
                <button className="secondary-button" disabled={loading} onClick={() => void syncNow()}>
                  {loading || syncStatus?.running ? "同步中…" : "立即同步所有课程"}
                </button>
                <button className="secondary-button" disabled={loading} onClick={() => void disconnect()}>
                  断开并删除 Token
                </button>
              </div>
              <div className="runtime-line"><span>上次成功同步</span><strong>{dateText(syncStatus?.lastSuccess ?? null)}</strong></div>
              {syncStatus?.lastError && <p className="error-message" role="status">{syncStatus.lastError}</p>}
            </>
          ) : (
            <form className="connector-form" onSubmit={(event) => void connect(event)}>
              <label>Canvas 实例地址
                <input type="url" required maxLength={2048} value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)} />
              </label>
              <label>开发者本人 API Token
                <input type="password" autoComplete="off" required maxLength={4096} value={token}
                  onChange={(event) => setToken(event.target.value)} />
              </label>
              <button className="primary-button full-width" disabled={loading || !token.trim()}>
                {loading ? "正在连接…" : "连接并自动同步作业"}
              </button>
            </form>
          )}
        </section>
        <section className="panel">
          <div className="eyebrow">COURSE SCOPE</div>
          <h2>当前课程同步范围</h2>
          {!status.connected ? <p className="empty-state">连接 Canvas 后将显示授权课程。</p> :
            courses.length === 0 ? <p className="empty-state">暂无活跃课程。</p> :
            <ul className="connector-list">
              {courses.map((course) => (
                <li key={course.id}>
                  <div>
                    <strong>{course.name}</strong>
                    <small>{course.courseCode || `课程 #${course.id}`}</small>
                    <label className="course-switch">
                      <input type="checkbox" checked={isCourseEnabled(course.id)} disabled={loading}
                        onChange={(event) => void toggleCourse(course.id, event.target.checked)} />
                      {isCourseEnabled(course.id) ? "自动同步中" : "已暂停同步"}
                    </label>
                  </div>
                  <button className="text-button" disabled={loading} onClick={() => void showAssignments(course.id)}>浏览作业</button>
                </li>
              ))}
            </ul>}
        </section>
      </div>
      {status.connected && courseId !== null && (
        <section className="panel connector-assignments">
          <div className="eyebrow">COURSE ASSIGNMENTS</div>
          <h2>{courses.find((course) => course.id === courseId)?.name ?? "课程"} · 作业</h2>
          {loading ? <p className="empty-state">正在读取…</p> :
            assignments.length === 0 ? <p className="empty-state">没有可见作业。</p> :
            <ul className="connector-list">
              {assignments.map((assignment) => (
                <li key={assignment.id}>
                  <div><strong>{assignment.name}</strong>
                    <small>{assignment.dueAt ? `截止：${new Date(assignment.dueAt).toLocaleString("zh-CN")}` : "未设截止时间"}</small>
                  </div>
                  <span className="muted-tag">{isCourseEnabled(courseId) ? "自动同步" : "课程同步已暂停"}</span>
                </li>
              ))}
            </ul>}
          <p className="privacy-note">作业任务会根据课程同步范围自动更新；不向 Canvas 写回你的本地修改。</p>
        </section>
      )}
    </section>
  );
}
