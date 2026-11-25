# V0.1：在 Windows 上手动进行 Supabase 五账号 RLS 验收

本教程仅针对用户自己管理的**新建、可删除、无真实用户数据的非生产 Supabase 项目**。此测试会产生数据库写入、消息、任务，并在测试小组内撤销一个成员。不得使用生产项目、service_role、sb_secret 密钥、真实学生数据或共享的个人 Canvas Token。

## 1. 创建独立 Supabase 项目

访问 https://supabase.com/dashboard ，新建独立的 Study Anchor Alpha 测试项目，记录项目 URL（必须为 https://YOUR_PROJECT_REF.supabase.co 的根地址）及 Settings → API Keys 中的 Publishable key（前缀 sb_publishable_），或旧 anon JWT。不要将它们与项目数据库密码、Dashboard API token、service_role/secret key 混淆。项目管理员只需一个 Dashboard 登录账号。

## 2. 更新代码并做纯本地预检

在 PowerShell：

~~~powershell
cd D:\Electives\AgentToEntrepreneurship\study-anchor
git switch main
git pull --ff-only origin main
npm ci
npm run preflight:supabase
npm run test:sync-rls
~~~

确认 main 已合并修正第七个迁移 dollar quote 语法的 PR #67；在合并之前禁止部署旧版的第七份 SQL。预检只做本地文本分析，**不访问云端或证明 RLS 安全**。

## 3. 部署七份 SQL（仅管理员手动逐份审查执行）

打开新项目 Dashboard → SQL Editor → New query，按以下顺序逐份打开本地完整 SQL 文件、审查后粘贴并点击 Run。任何一步报错都**停下来**，不可盲目跳过或重复部署。

1. supabase/migrations/20261110_ate_workspace_poc.sql
2. supabase/migrations/20261124_ate_personal_sync.sql
3. supabase/migrations/20261124_ate_personal_sync_recovery_inspect.sql
4. supabase/migrations/20261124_ate_workspace_realtime_hints.sql
5. supabase/migrations/20261124_ate_workspace_durable_history.sql
6. supabase/migrations/20261124_ate_workspace_checkpoint_recovery.sql
7. supabase/migrations/20261125_ate_workspace_member_revoke.sql（必须使用 PR #67 修正版）

部署后在 SQL Editor 可用下面的只读语句查看 RLS 和函数是否存在：

~~~sql
select tablename, rowsecurity from pg_tables
where schemaname='public' and tablename like 'ate_%' order by tablename;

select tablename, policyname, cmd from pg_policies
where schemaname='public' and tablename like 'ate_%'
order by tablename, policyname;

select proname from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
('ate_create_workspace','ate_create_invite','ate_join_workspace',
 'ate_revoke_workspace_member') order by proname;
~~~

SQL Editor 的管理员角色可绕过 RLS；这只是结构检查，绝不能用它代替 Auth JWT 反向验收。

## 4. 创建五个独立 Supabase Auth 用户

在项目 Dashboard → Authentication → Users → Add user → Create new user 创建 A、B、C、D、E 五个测试用户。每个邮箱不同，分别设置 8 字符以上密码。在专门的隔离测试项目中如无需真实确认信，可选择 Auto Confirm User；不要在生产项目里关闭邮箱确认。若采用 Send invitation 流程，必须让邀请人完成验证并设置密码，否则 password grant 会失败。

五个账号是应用的 Auth 用户，**不是五个 Supabase Dashboard 管理员**，也不需要手工往 workspace 表里添加成员。脚本按 A owner、B/D/E 先加入、C 外部人后加入来运行。

## 5. PowerShell 中输入账号环境变量

使用相同的 PowerShell 窗口，运行：

~~~powershell
$env:ATE_POC_URL = 'https://YOUR_PROJECT_REF.supabase.co'
$env:ATE_POC_ANON_KEY = Read-Host 'Public publishable/legacy anon key'
foreach ($who in @('A','B','C','D','E')) {
  $email = Read-Host "Account $who email"
  $secret = Read-Host "Account $who password" -AsSecureString
  Set-Item ("Env:ATE_POC_{0}_EMAIL" -f $who) -Value $email
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try {
    Set-Item ("Env:ATE_POC_{0}_PASSWORD" -f $who) -Value (
      [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    )
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}
~~~

将 YOUR_PROJECT_REF 改成你自己的值。不要把密码写在命令历史、公开 .env、GitHub、截图或聊天中。环境变量在本机进程中仍是明文，请只在可信测试机中使用。

确认测试项目确实可丢弃、已部署全部审查通过的 SQL，然后**明确开启真实写入**：

~~~powershell
$env:ATE_POC_CONFIRM_WRITES = 'CREATE_DISPOSABLE_TEST_WORKSPACE'
node scripts/sync-rls-acceptance.mjs
~~~

## 6. 实际验收行为

脚本使用五个账号密码登录，验证不同 JWT subject；A 创建测试工作空间及邀请码，B/D/E 加入；C 先作为无权外部成员接受读写拒绝测试；B 被测试是否能冒充 A；A 创建消息及指派给 B 的任务，B 应能读写；C 加入成为第五成员。随后测试 B 不能撤销 D、A 不能撤销自己、A 撤销 B 后 B 使用**原来的旧 JWT**不能再读写消息/任务/成员、旧邀请码不能被重放，B 的任务改为未分配。通过后输出 PASS 和 workspace UUID。

运行会真实写入数据库。它**不会**自动清理，也不会测试真实 Electron GUI、网络中断、Realtime 延迟、设备缓存或历史分页恢复。失败时可能已经留下部分测试资源，再运行会创建新的测试空间。

测试结束后清理 shell 中的环境变量：

~~~powershell
Get-ChildItem Env: | Where-Object Name -like 'ATE_POC_*' |
  ForEach-Object { Remove-Item ("Env:" + $_.Name) }
~~~

在 Dashboard 中核对该次新建的 workspace、关联历史/任务/消息后由管理员**仅清理本次验收数据**。切勿清理其他测试人员记录。

## 7. 失败处理

- 测试地址或 key 无效：检查根域名与公开 publishable/anon key；secret/service_role 会被拒绝。
- sign-in X (HTTP 400/401)：检查五个不同、已确认且拥有密码的 Auth 账号。
- workspace creation (HTTP 404)、RPC not found：核对第 1 份 SQL 是否成功、PostgREST schema cache。
- owner revokes member B 失败：核对第 7 份修正版迁移部署。
- outsider/revoked member leaked restricted records：**严重授权问题，立即停止**，审查数据库 RLS/grants，不可继续当作可用版本。
- network interrupted：检查项目是否被暂停、本机代理/网络/请求超时。
- 第七份 SQL near $ 语法错误：仍在使用错误版本，更新审查修复后的文件。

请只发送错误类型、HTTP 状态和步骤的脱敏摘要，不要分享任何邮箱密码、用户 JWT、邀请码或 service key。

官方资料：https://supabase.com/docs/guides/getting-started/api-keys 及 https://supabase.com/docs/guides/auth/users
