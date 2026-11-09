import { useEffect, useState, type FormEvent } from "react";
import type {
  CanvasAssignment, CanvasConnectionStatus, CanvasCourse,
} from "../../shared/canvas-model";

const disconnected: CanvasConnectionStatus = {
  connected: false, baseUrl: null, mode: null,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "连接失败，请检查网络和 Canvas 权限";
}

/**
 * Dedicated connector view. No token is persisted in React storage or sent
 * anywhere except the narrow connect IPC call to the Electron main process.
 */
export default function CanvasConnector() {
  const [status, setStatus] = useState<CanvasConnectionStatus>(disconnected);
  const [baseUrl, setBaseUrl] = useState("https://oc.sjtu.edu.cn");
  const [token, setToken] = useState("");
  const [courses, setCourses] = useState<CanvasCourse[]>([]);
  const [courseId, setCourseId] = useState<number | null>(null);
  const [assignments, setAssignments] = useState<CanvasAssignment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void window.desktop.canvas.status().then((result) => {
      if (!active) return;
      setStatus(result);
      if (result.baseUrl) setBaseUrl(result.baseUrl);
      if (result.connected) {
        void window.desktop.canvas.courses().then((data) => {
          if (active) setCourses(data);
        }).catch((reason: unknown) => {
          if (active) setError(errorText(reason));
        });
      }
    }).catch((reason: unknown) => {
      if (active) setError(errorText(reason));
    });
    return () => { active = false; };
  }, []);

  async function connect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (loading || !token.trim()) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const result = await window.desktop.canvas.connect({ baseUrl, token });
      setStatus(result.status);
      setCourses(result.courses);
      setToken("");
      setCourseId(null);
      setAssignments([]);
      setNotice("课程读取成功。开发者个人 Token 仅加密保存在本机。");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  async function refreshCourses(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      setCourses(await window.desktop.canvas.courses());
      setCourseId(null);
      setAssignments([]);
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
      setAssignments(await window.desktop.canvas.assignments(id));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  async function disconnect(): Promise<void> {
    if (!window.confirm("断开 Canvas 并删除本机保存的个人 Token？")) return;
    setLoading(true);
    setError("");
    try {
      await window.desktop.canvas.disconnect();
      setStatus(disconnected);
      setToken("");
      setCourses([]);
      setAssignments([]);
      setCourseId(null);
      setNotice("已断开 Canvas，本机加密 Token 文件已删除。");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="connector-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">EXTERNAL CONNECTORS</div>
          <h1>数据接入</h1>
          <p>Canvas 真实只读连接：课程、作业与截止时间</p>
        </div>
        <span className="count-chip">{status.connected ? "Canvas 已连接" : "Canvas 未连接"}</span>
      </div>

      <div className="connector-warning" role="note">
        <strong>个人 Token 仅用于开发者本人的本地验证。</strong>
        多用户正式接入仍需学校批准 Developer Key 并采用 OAuth。请勿输入其他人的 Token，
        也不要将你的 Token 分享给其他团队成员。
      </div>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}
      {notice && <div className="connector-notice" role="status">{notice}</div>}

      <div className="connector-layout">
        <section className="panel">
          <div className="eyebrow">CANVAS CONNECTION</div>
          <h2>连接配置</h2>
          {status.connected ? (
            <>
              <p className="help-text">连接方式：开发者个人 Token（本机加密保存）</p>
              <p className="connector-host">{status.baseUrl}</p>
              <div className="button-row">
                <button className="secondary-button" disabled={loading} onClick={() => void refreshCourses()}>
                  {loading ? "读取中…" : "刷新课程"}
                </button>
                <button className="secondary-button" disabled={loading} onClick={() => void disconnect()}>断开并删除 Token</button>
              </div>
            </>
          ) : (
            <form className="connector-form" onSubmit={(event) => void connect(event)}>
              <label>Canvas 实例地址
                <input type="url" value={baseUrl} maxLength={2048} required
                  placeholder="https://oc.sjtu.edu.cn"
                  onChange={(event) => setBaseUrl(event.target.value)} />
              </label>
              <label>个人 API Token（仅开发者本人）
                <input type="password" value={token} required maxLength={4096}
                  autoComplete="off" placeholder="请输入本人用于本地验证的 Token"
                  onChange={(event) => setToken(event.target.value)} />
              </label>
              <button className="primary-button full-width" disabled={loading || !token.trim()}>
                {loading ? "正在验证 Canvas…" : "验证并保存本地连接"}
              </button>
              <p className="privacy-note">
                仅通过主进程向你选择的 HTTPS Canvas 实例发送 Token。
                若系统安全加密不可用，将拒绝保存。
              </p>
            </form>
          )}
        </section>

        <section className="panel">
          <div className="eyebrow">YOUR COURSES</div>
          <h2>真实课程列表</h2>
          {!status.connected ? <p className="empty-state">连接 Canvas 后显示你的授权课程。</p> :
            courses.length === 0 ? <p className="empty-state">{loading ? "正在读取…" : "当前没有读取到活跃课程。"}</p> :
            <ul className="connector-list">
              {courses.map((course) => (
                <li key={course.id}>
                  <div><strong>{course.name}</strong><small>{course.courseCode || `课程 ID ${course.id}`}</small></div>
                  <button className="text-button" disabled={loading} onClick={() => void showAssignments(course.id)}>查看作业</button>
                </li>
              ))}
            </ul>}
        </section>
      </div>

      {status.connected && courseId !== null && (
        <section className="panel connector-assignments">
          <div className="eyebrow">COURSE ASSIGNMENTS</div>
          <h2>{courses.find((course) => course.id === courseId)?.name ?? "课程"} · 作业</h2>
          {loading ? <p className="empty-state">正在读取作业…</p> :
            assignments.length === 0 ? <p className="empty-state">当前没有读取到作业。</p> :
            <ul className="connector-list">
              {assignments.map((assignment) => (
                <li key={assignment.id}>
                  <div>
                    <strong>{assignment.name}</strong>
                    <small>
                      {assignment.dueAt
                        ? `截止：${new Date(assignment.dueAt).toLocaleString("zh-CN")}`
                        : "未设截止时间"}
                      {assignment.pointsPossible === null ? "" : ` · ${assignment.pointsPossible} 分`}
                    </small>
                  </div>
                  <span className="muted-tag">Canvas #{assignment.id}</span>
                </li>
              ))}
            </ul>}
          <p className="privacy-note">
            当前提供真实只读浏览。作业导入任务、增量去重与 OAuth 将作为独立开发任务实现。
          </p>
        </section>
      )}
    </section>
  );
}
