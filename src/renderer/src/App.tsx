import { useEffect, useState } from "react";

type RuntimeStatus = "checking" | "connected" | "unavailable";
const modules = [
  ["01", "日历与任务", "课程、截止时间与每日安排", "基础框架"],
  ["02", "个人知识库", "资料、知识关联与复习", "待开发"],
  ["03", "专注与自律", "专注计时与执行反馈", "待开发"],
  ["04", "小组协作", "团队任务、验收与共享", "待开发"],
  ["05", "AI 辅助规划", "项目授权与计划建议", "待开发"],
  ["06", "数据接入", "Canvas 与外部日历", "待开发"],
  ["07", "邮件管理", "收件、草稿与确认发送", "待开发"],
  ["08", "个人工作台", "个性化布局与快捷入口", "基础框架"],
];

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeStatus>("checking");
  const [version, setVersion] = useState("—");
  useEffect(() => {
    let active = true;
    Promise.all([window.desktop.ping(), window.desktop.getVersion()])
      .then(([, appVersion]) => {
        if (!active) return;
        setVersion(appVersion);
        setRuntime("connected");
      }).catch(() => { if (active) setRuntime("unavailable"); });
    return () => { active = false; };
  }, []);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">A</div><div><strong>AtE Workspace</strong><span>个人学习与协作空间</span></div></div>
      <div className="workspace-switch"><span className="workspace-dot" />个人工作空间 <span className="chevron">⌄</span></div>
      <div className="nav-label">工作空间</div>
      <nav>
        <a className="nav-item active" href="#overview">◫　总览</a>
        <a className="nav-item" href="#calendar">▦　日历与任务</a>
        <a className="nav-item" href="#knowledge">◇　个人知识库</a>
        <a className="nav-item" href="#focus">◷　专注与自律</a>
        <a className="nav-item" href="#team">⌘　小组协作</a>
      </nav>
      <div className="nav-label">智能与连接</div>
      <nav>
        <a className="nav-item" href="#ai">✳　AI 辅助规划</a>
        <a className="nav-item" href="#connectors">⇄　数据接入</a>
        <a className="nav-item" href="#mail">✉　邮件管理</a>
      </nav>
      <div className="sidebar-bottom"><div className="avatar">U</div><div><strong>本地用户</strong><span>数据优先保存在本机</span></div><span className="settings">⚙</span></div>
    </aside>
    <main className="main-area">
      <header className="topbar"><div className="breadcrumb">个人工作空间 <span>/</span> 总览</div><div className="top-actions"><div className="search-button">⌕　搜索工作空间　<kbd>⌘ K</kbd></div><div className="avatar small">U</div></div></header>
      <section className="content" id="overview">
        <div className="welcome-row"><div><div className="eyebrow">YOUR WORKSPACE</div><h1>把重要的事情，<em>一步步做好。</em></h1><p>这是你的个人学习与协作空间。先从清晰地安排今天开始。</p></div><div className="date-card"><span>当前版本</span><strong>{version}</strong><small>桌面工程基础版</small></div></div>
        <div className="status-banner"><div className="status-icon">✦</div><div className="status-copy"><strong>工程底座已启动</strong><span>当前是早期开发原型。模块入口用于展示产品结构，尚未接入真实业务数据。</span></div><div className="runtime-status"><i className={runtime === "connected" ? "online" : runtime === "unavailable" ? "offline" : ""} />{runtime === "connected" ? "桌面主进程已连接" : runtime === "checking" ? "正在检查运行环境" : "运行环境不可用"}</div></div>
        <div className="section-heading"><div><div className="eyebrow">YOUR TOOLKIT</div><h2>工作空间</h2></div><button className="text-button">自定义工作台 ↗</button></div>
        <div className="module-grid">{modules.map(([number,name,description,status]) => <article className="module-card" key={number}><div className="module-top"><span className="module-number">{number}</span><span className="module-status">{status}</span></div><h3>{name}</h3><p>{description}</p><div className="module-arrow">↗</div></article>)}</div>
        <div className="bottom-grid">
          <section className="panel"><div className="eyebrow">GETTING STARTED</div><h2>接下来</h2>
            <div className="step-row"><span className="step-check">✓</span><div><strong>建立跨平台桌面工程</strong><p>Electron、React 与 TypeScript 基础结构</p></div><span className="step-state done">已完成</span></div>
            <div className="step-row"><span className="step-number">2</span><div><strong>建立本地数据与迁移层</strong><p>SQLite、数据模型与备份恢复</p></div><span className="step-state">规划中</span></div>
            <div className="step-row"><span className="step-number">3</span><div><strong>接入真实外部服务</strong><p>Canvas 授权与交大邮箱验证</p></div><span className="step-state">等待授权</span></div>
          </section>
          <section className="panel runtime-panel"><div className="eyebrow">SYSTEM STATUS</div><h2>运行状态</h2>
            <div className="runtime-line"><span>Electron 主进程</span><strong>{runtime === "connected" ? "正常" : runtime === "checking" ? "检查中" : "异常"}</strong></div>
            <div className="runtime-line"><span>本地数据存储</span><strong className="not-ready">尚未初始化</strong></div>
            <div className="runtime-line"><span>云端协作</span><strong className="not-ready">尚未连接</strong></div>
            <div className="runtime-line"><span>AI Runtime</span><strong className="not-ready">尚未配置</strong></div>
            <p className="privacy-note">◈ 连接器、AI 外传与团队同步均需独立授权。</p>
          </section>
        </div>
        <footer>Agent-to-Entrepreneurship　·　Local-first by design　·　内部开发原型</footer>
      </section>
    </main>
  </div>;
}
