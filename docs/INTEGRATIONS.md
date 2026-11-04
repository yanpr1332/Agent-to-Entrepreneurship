# 外部平台接入与权限

**范围基准**：[PRD V1.0](PRD.md)。首版 P0 要求交大 Canvas、教务与邮箱真实接入，并支持 Google Calendar、Microsoft Outlook 日历和 Notion 指定页面/数据库的合法授权读取与同步。Gmail/Outlook 专用邮件接入及复杂第三方双向写入为 P1。存在公开接口文档不表示已经获取开发者授权或完成实现。

## 上海交通大学 Canvas

- 目标：课程列表、作业及截止时间、日历事件、公告、可访问的课程文件。
- 学校 Canvas 公开了 REST API 文档及上述资源接口，但必须实际测试当前账号、组织授权、访问范围和同步稳定性。
- 建议只读获取后映射到 `Course`、`Task`、`Event`、`Resource`。
- 应记录外部 ID、原始页面链接、同步时间、内容变化；防止重复导入及错误覆盖。
- 部分外部教学工具/视频平台可能有额外登录或权限，不应假定通用 Canvas Token 可以访问。

官方参考：https://oc.sjtu.edu.cn/doc/api/index.html

## 上海交通大学官方开放 API

- 官方文档列有学生课表接口：`GET https://api.sjtu.edu.cn/v1/me/lessons[/{term}]`，要求 `lessons` 范围授权。
- 通过学校的 jAccount 接入申请和 OAuth2 授权流程获取必要访问权限。
- 用户只能通过正式授权登录；不得索取、上传或存储明文 jAccount 密码。
- 课程节次、起止时间、教室及学期范围需对照实际响应校验。
- 官方页面仍将部分考试/GPA 接口标为未实现，不能把它们列为已可用功能。

官方参考：https://developer.sjtu.edu.cn/api/education.html

申请与认证：https://developer.sjtu.edu.cn/api/overview.html

## Google Calendar 与 Microsoft Outlook 日历（P0）

- Google Calendar：使用 Google OAuth 授权与 Calendar API 读取、同步事件；按最小权限申请，考虑公开应用验证；不在首版直接修改外部日程。
- Microsoft Outlook Calendar：使用 Microsoft identity 和 Microsoft Graph 日历权限，以个人账号及实际获许可的学校/组织账号验证；组织管理员阻止授权时明确告知。
- 均须保留来源 ID、原始时区、重复规则、增量同步游标、变更与删除标记、错误及重试状态。
- ICS/CSV/Markdown 等开放格式支持预览、导入导出与去重；外部双向日历编辑列 P1。

官方参考：

- Google Calendar：https://developers.google.com/workspace/calendar/api/auth
- Microsoft Graph：https://learn.microsoft.com/en-us/graph/api/user-list-events?view=graph-rest-1.0

## Notion（P0）

- 采用公开 OAuth 集成，让用户选择可访问的页面和数据库/数据源；首版读取指定范围内的页面和任务信息、更新同步及权限撤销。
- Notion 页面、数据库字段不一定等同于本软件任务字段；需要用户可查看的字段映射、缺失字段提示和重复项规则。
- Notion Calendar 的桌面打开链接能力与 Notion 页面/数据库 API 不是同一种服务；不能据此承诺 Notion Calendar 全功能同步。
- 复杂的 Notion 写入和双向冲突策略列为 P1；注意 API 版本和请求限流。

官方参考：https://developers.notion.com/guides/authorization/overview

## 邮件连接器（邮件模块的底层适配）

- **职责边界**：本节只规定邮箱协议、授权、同步和发送适配。邮件列表、分类、事项提取、AI 拟写、草稿和监督发送的业务与界面属于独立的“邮件管理与 AI 通信”模块，不归属于个人工作台。
- **用户目标**：授权后从一个或多个邮箱获取邮件，将有行动价值的内容转成日历/待办建议；支持 AI 拟写及用户审核后的发送、回复和转发。
- **首版 P0 适配方向**：交大邮箱真实读/发、官方 Mail API 或经验证的 IMAP/SMTP（学校官方文档列有 mail.sjtu.edu.cn / IMAP 993 / SMTP 465）；合法授权及身份配置须实测，不能只凭文档假定用户已获访问权。
- **P1 方向**：Gmail API、Microsoft Graph Mail 的专用 OAuth 收发；注意这不影响 P0 的 Google/Outlook **日历**接入。
- **读取接口**：最小权限、用户选择的文件夹或过滤范围、增量同步、分页与限流、邮件 ID/线程 ID、发件人、日期、主题、正文、附件元数据及原文链接。
- **写入接口**：创建/修改草稿、回复/回复全部/转发、发送；只有在明确启用写入能力并获得独立授权后才能调用。
- **本地流程**：邮件 → 来源与线程关联 → 提取事项候选 → 冲突/重复检查 → 用户确认 → 任务或日历。草稿 → 用户修改 → 收件人/附件/正文确认 → 发送 → 结果核验。
- **安全性**：不要以明文保存邮箱密码；邮件正文不得作为系统操作指令；不自动发送或删除；同步失败、撤销授权、收件人变化及发送结果不确定时必须显示状态。
- **学生场景**：课程通知、教师沟通、小组会议、作业延期、项目合作等；私人邮件不默认共享给团队。

官方参考：

- Gmail 草稿与发送：https://developers.google.com/workspace/gmail/api/guides/drafts
- Gmail 授权范围：https://developers.google.com/workspace/gmail/api/auth/scopes
- Microsoft Graph 读取邮件：https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
- Microsoft Graph 发信：https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0
- 上海交大邮箱服务器：https://net.sjtu.edu.cn/info/1191/2699.htm
- 上海交大 Mail API：https://developer.sjtu.edu.cn/api/mail.html

详细功能和验收见 [邮件工作流](EMAIL_WORKFLOW.md)。

## Obsidian

- 优先采用用户自己可见的 Markdown 文件，不强制转换到封闭格式。
- 可选：URI 打开、官方 CLI、Obsidian 插件、用户允许的 vault 文件夹操作。
- 避免同时改写同一文件引发冲突；必须尊重笔记的文件系统权限。

官方参考：https://obsidian.md/help/uri

## 本地录音转写

- **首版 P0**：FFmpeg + Whisper/FunASR 等作为候选处理组件；提供只转写不上传的本地模式，以及经用户同意的云端处理模式。
- Windows 和 macOS 分别构建/测试；不能要求用户安装 WSL。
- 确认课堂录音、公开传播和第三方模型/云服务的权限与隐私风险。

## 接口验收前置条件

1. 获取合法授权，确认允许的 API 访问范围。
2. 用最小范围测试课表、作业、日期、附件访问等核心资源。
3. 记录错误码、限流、分页、失效令牌、断网及数据更新情况。
4. 提供用户可理解的授权撤销和手工导入后备路径。
5. 对邮件发送权限独立审查；执行发信前确认目标收件人、当前账号、附件以及草稿全文。
6. Google/Outlook 日历与 Notion 分别测试真实 OAuth 授权、范围撤销、同步去重和账号类型差异；文档有接口不能替代真实验收。
7. 所有连接器的数据读取权和 AI 外传权分别确认，不能把第三方授权当作云 AI 处理许可。
