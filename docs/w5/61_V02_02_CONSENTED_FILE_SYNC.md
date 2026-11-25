# V0.2-02：个人小文件选择性跨设备同步（Beta）

> 2026-11-25 · Alpha 之后第二轮集中开发。代码及模拟测试通过不代表真实 Supabase RLS、双电脑和云端备份验收通过。只允许在你自己管理的隔离非生产 Supabase 项目测试。

## 本轮真正实现

1. 在「云端小组协作 → 个人文件」使用操作系统原生文件选择器挑选单个文件，单次仅暂存在应用用户目录，不联网自动上传。仅接受 PDF、Markdown、TXT、HTML、TeX、LaTeX、CSV、JSON、ICS，按扩展名允许，不执行文件内容。每份最多 **1 MiB**，每个 Supabase Auth 账号最多 **20 份有效文件**。
2. 只有再次点击「确认上传」并审阅提示后才会把选中文件原始字节发送到当前测试项目。不会扫描目录、监视文件修改、自动上传知识库、Canvas、邮箱或 AI 数据。
3. 本机 SQLite 保存独立账号的待上传版本、文件 SHA256、基线云端版本，私有 staging 目录保存快照字节。断网或重启后待上传副本保持原样，不会默认重发。原文件所在绝对路径不经 IPC、不传入 Renderer 或 Supabase。
4. 云端 PostgreSQL 新建私有 ate_personal_files 表与 ate_file_list / ate_file_get / ate_file_apply 三个 SECURITY DEFINER RPC。客户端只用 Publishable/Anon Key 加登录用户 JWT；SQL 从 auth.uid() 取得真实 owner ID，不授予任何桌面端直接的原始内容表权限。
5. 服务端使用逐文件事务锁 + version CAS + pgcrypto SHA256 复核，原子替换内容和版本；版本失配直接返回 conflict，不覆盖另一设备的新版本。成功返回 accepted，重复同字节同名返回 duplicate，便于不确定 HTTP 回执后的人工重试。失配时本机暂存不会删除。
6. 另一台电脑使用 **相同的 Auth 个人账号**登录测试项目，点击刷新，再明确选择一个文件「核验并下载」。验证云端元数据、版本、大小、SHA256；保存到独立下载目录，不覆盖已有但哈希不同的文件。
7. 丢弃本机暂存不会影响远端或原文件。单独确认「删除云端内容」才提交 CAS 墓碑，数据库事务会将活跃内容 bytea 清成 NULL。其他设备刷新将看不到删除的文件，但已经下载的设备副本、数据库备份、旧 WAL/磁盘块不可能承诺彻底远程物理擦除。

## 必须明确告知用户的安全边界

**目前不是端到端加密。** 文件通过 HTTPS 发往用户选择的 Supabase 项目，项目管理员和云服务可能访问原始内容。切勿将真实个人隐私、机密或不获授权的课程资料放入公用项目。当前是小文件 Beta RPC 方案，不是无限容量 Storage；需在真实隔离项目评估 PostgreSQL 存储及使用费用。

新 SQLite 与 staging/下载区不属于现有五数据库备份，且不在退出登录时自动物理擦除。个人文件与团队共享任务互不相通；默认既不自动同步也不向任何团队成员分享。后续大文件、分块传输、端到端加密和自动磁盘文件监控属于独立方案，不能用本轮结果冒充完成。

## SQL 部署（项目管理员明确审批后）

旧 7 个迁移如果已经在全新隔离测试项目部署完毕，管理员审查第 8 个文件后，在 Supabase SQL Editor 中单独执行：

    supabase/migrations/20261125_ate_personal_file_sync.sql

新项目则先审核、顺序运行旧 7 个，再运行这个新文件。不要在生产数据库盲目重放旧 SQL，也不要通过 CI 自动部署。

首先在仓库根目录只读预检：

    npm run preflight:supabase
    node --test scripts/supabase-alpha-preflight.node.mjs

现在预检要求总共 **8 份** SQL，并拒绝意外未审查文件；这是启发式检查，不是 PostgreSQL 解析或真实授权证明。SQL Editor 的管理员角色可能绕过 RLS，必须另外用两个普通 Auth 用户 JWT 在隔离项目确认 A 无法读取、覆写和删除 B 的文件。

以下是结构只读查看语句：

~~~sql
select tablename,rowsecurity from pg_tables
where schemaname='public' and tablename='ate_personal_files';
select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and proname in ('ate_file_list','ate_file_get','ate_file_apply');
~~~

## 双设备操作验收

1. 两台电脑 checkout 相同提交，运行 npm ci 和 npm run dev，用两个不同的本机 userData 目录。在云端小组协作页配置同一隔离 Supabase 项目。**个人文件跨设备共享要求两端登录同一个 Auth 用户**；切换不同用户是隔离性负向测试，不是团队共享。
2. A 选择合成 intro.md，只暂存后立即检查云端没有记录；退出程序再启动并登录原账号，确认待上传快照仍存在。
3. A 单独确认上传；B 刷新远端文件列表，下载并核对内容、SHA256、版本。要区分自动断网恢复与手动文件下载：当前没有后台自动文件上传或下载。
4. A 与 B 同时以云端 v1 为基线，各自选择不同内容替换相同 fileId。B 先确认上传得到 v2；A 后确认应收到 conflict、保留本机待上传副本，不能覆盖 B。
5. 断开 B 网络，尝试上传另外一个已暂存文件，确认失败但本机内容不丢。恢复网络后重试；模拟服务器已提交但客户端失去响应时，同内容再次操作应当是 duplicate 而不是重复建文件。
6. 分别测试「丢弃本机暂存」和「删除云端内容」——前者不改变云端；后者需单独确认且只能以正确版本删除，其他设备刷新后记录消失，但旧下载副本仍在。
7. 切换不同登录用户，确认看不到上个用户的云端文件和本机待上传清单。生产部署前还必须独立审查系统权限和测试真实 Supabase Auth JWT 下的 RLS。

## 回归与交付

    npm run typecheck
    npx vitest run src/main/personal-file-sync.test.ts src/shared/personal-file-sync.test.ts
    npm run preflight:supabase
    npm test
    npm run build

自动化测试使用真实本地 Node SQLite 与模拟云 RPC，不对真实 Supabase 做任何修改。完整 Windows/macOS CI 通过后，仅能称代码候选；真实账号、安全隔离、安装包和双设备验收仍然 Blocked。

下一轮 V0.2-03 优先推进可打包的真正本地神经 Embedding 及质量评测。
