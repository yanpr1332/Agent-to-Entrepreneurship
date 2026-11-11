# W5 本地运行排障（Windows）

> 本文件只记录**真实遇到过并已定位**的启动故障。每条都写清症状、证据、根因和可复现的修复方式，
> 避免下一个人重复排查。验收状态见 [验收矩阵](00_ACCEPTANCE_MATRIX.md)。

## 0. 快速自查顺序

```powershell
node --version                                  # 需要 24.x
Test-Path node_modules\electron\dist\electron.exe   # 需要 True
npm run typecheck
npm run dev                                     # 默认（沙箱开启）
npm run dev:compat                              # 本机无法创建 Chromium 沙箱子进程时使用
```

---

## 1. `npm run dev` 后窗口不出现，终端直接回到提示符

**症状**：打印 `starting electron app...` 之后立刻回到提示符，没有窗口，也没有报错。

**证据**：

```text
[ERR] GPU process launch failed: error_code=18
[FATAL:content\browser\gpu_data_manager_impl_private.cc:389] GPU process isn't usable. Goodbye.
```

Windows 事件日志会留下 `electron.exe` 的 APPCRASH，异常代码 `0xc0000005`。

**根因（推断，待真实桌面环境复核）**：Chromium 无法创建其沙箱子进程。现有日志只能证明
**子进程启动失败**，不足以排除应用自身的配置问题；本机在 `--no-sandbox` 下可正常启动，
说明故障点在 Chromium 沙箱层，但确切原因（受管控终端、安全软件、系统策略或 AppContainer
被禁用）仍需在具备管理员权限的真实桌面环境中逐项确认。

**修复**：

```powershell
npm run dev:compat
```

内部等价于 `electron-vite dev --noSandbox`，由 electron-vite 把 `--no-sandbox` 透传给
Electron 命令行（见 `node_modules/electron-vite/dist/chunks/lib-*.js` 中 `NO_SANDBOX` 分支）。

**为什么不能写在代码里**：Chromium 的沙箱在 JS 执行前就已初始化，
`app.commandLine.appendSwitch("no-sandbox")` 无效。必须在命令行传入。

**已实测无效的替代参数**（2026-11-11，同一台机器逐组验证）：

| 参数 | 结果 |
| --- | --- |
| `--disable-gpu` | 仍退出 |
| `--disable-gpu-sandbox` | 仍退出 |
| `--in-process-gpu` | 仍退出 |
| `--use-angle=swiftshader` | 仍退出 |
| `--single-process` | 仍退出 |
| `--no-zygote` | 仍退出 |
| `--disable-features=RendererCodeIntegrity` | 仍退出 |
| `--disable-features=NetworkServiceSandbox` | 仍退出 |
| `--no-sandbox` | **可用** |

**安全影响（必须知情）**：`--no-sandbox` 关闭 Chromium 的 OS 级沙箱。本应用只加载本地
`file://` 内容、CSP 受限、`contextIsolation` 与 `nodeIntegration:false` 仍然生效，但
渲染进程的隔离强度下降。因此：

- `npm run dev` 保持默认（沙箱开启）；
- `dev:compat` 只用于受限的本机开发，**不得用于打包发布**；
- 主进程会在启动时打印一条警告，便于事后核对。

**根治方向**（需要管理员）：排查本机为何无法创建沙箱子进程（常见于 AppContainer/AppIDSvc
被禁用、终端管控策略、部分安全软件），恢复后即可去掉 `dev:compat`。

---

## 2. 弹出「本地数据无法打开」

**症状**：窗口出现后立刻弹出该对话框，应用随即退出。

**根因**：`%APPDATA%\<app name>` 对当前进程不可写，或该目录被**另一个权限上下文**的进程
创建过（例如以管理员运行过一次）。SQLite 无法创建或用 WAL 打开数据库。

**修复（按顺序）**：

1. 先备份，再删除并让应用重建：

   ```powershell
   $dir = "$env:APPDATA\agent-to-entrepreneurship"
   Copy-Item $dir "$env:USERPROFILE\Desktop\ate-backup-$(Get-Date -f yyyyMMdd-HHmm)" -Recurse
   Remove-Item $dir -Recurse -Force
   npm run dev:compat
   ```

2. 若该路径天生不可写（托管机器、只读漫游配置），改用可写目录，不必提权：

   ```powershell
   $env:ATE_USER_DATA_DIR = "$env:LOCALAPPDATA\ate-userdata"
   npm run dev:compat
   ```

   注意：换目录等于换一套本地数据，原任务/资料不会自动迁移。
   启动时会先递归创建缺少的目录，再交给 Electron 设置 `userData`；
   如果目录无法创建或设置失败，应用会停止启动并提示错误，**不会静默回退到默认目录**。
   首次运行可以指定一个尚不存在的子目录，不必手动预先创建。

**排障提示**：此前的版本把真实异常静默吞掉了，只会显示通用文案。现在主进程会向终端打印
`[ate] local database initialisation failed; userData = ...` 与具体错误，先看终端再动手。
对话框文案保持不变，不会显示路径或堆栈。

---

## 3. `Cannot read properties of undefined (reading 'whenReady')`

**根因**：环境里存在 `ELECTRON_RUN_AS_NODE=1`（常见于从其他 Electron 应用的集成终端启动），
Electron 会退化成纯 Node，`app` 为 `undefined`。

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE
npm run dev:compat
```

---

## 4. `npm ci` 之后没有 `node_modules\electron\dist`

**根因**：npm 11.19 的 `allowScripts` 策略默认不执行依赖的安装脚本，Electron 的二进制没下载。

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
node node_modules\electron\install.js
Test-Path node_modules\electron\dist\electron.exe   # 应为 True
```

GitHub Releases 域名在部分网络下会被重置，用上面的镜像即可；下载完成后可用官方
`SHASUMS256.txt` 校验 zip 的 SHA256（2026-11-11 实测一致）。

---

## 5. `npm test` 报 `Timeout terminating forks worker`

**根因**：Vitest 默认 `forks` 池需要子进程 IPC，在部分受限环境下会被拒绝。这不是断言失败。

```powershell
node node_modules\vitest\vitest.mjs run --pool=threads
```

CI 使用默认池，以 CI 结果为准。

---

## 6. 已知环境差异（2026-11-11 记录）

| 项 | 本机 | CI |
| --- | --- | --- |
| Node | v24.21.0 | 24.18.0（`.nvmrc`） |
| 沙箱子进程 | 无法创建 → 需 `dev:compat` | 正常 |
| `%APPDATA%` 写入 | 本仓库的受限执行环境会拒绝 | 不涉及 |
| GUI 验收 | 通过 CDP 自动化完成 11 项 | 不涉及 |
