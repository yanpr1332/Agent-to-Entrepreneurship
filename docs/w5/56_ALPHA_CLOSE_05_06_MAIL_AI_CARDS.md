# ALPHA-CLOSE-05/06：校内邮箱完整人工工作流与来源复习卡

> 2026-11-25 集中功能开发。此页描述代码边界，**不代表真实交大邮箱或 AI Provider 已成功验收**。所有发信、外传、账户与系统凭据都需要用户自行授权。

## 交大邮箱：按需正文、回复与加密草稿

- 本地 IMAP 自动同步仅同步最近收件**邮件头**。用户逐封主动点击并确认后，Main 使用已有的 `EXAMINE INBOX + UID FETCH BODY.PEEK[]` 只读机制按 UID/UIDVALIDITY 校验选中邮件，再把最多 2400 字纯文本正文送到当前渲染页面展示。不会因为邮件列表刷新就下载正文；**不缓存正文、不提取附件、不改变服务器未读状态**。切换组件/断开连接丢弃当前 UI 的正文。
- 回复按钮只从单个合法 `From` 地址生成收件人，主题以 `Re:` 标记，原文不自动附入回复或发送。原邮件具合法 Message-ID 时，预览/SMTP 带 `In-Reply-To` 和 `References`，所有头部字段严格校验，防止 CRLF 注入。必须先核对所有地址、完整内容和回复标识，再二次确认发送。
- 可以保存**不完整草稿**并按需修改/删除，最多 20 份。草稿保存在独立 `study-anchor-mail-drafts.enc` 文件，使用 Electron `safeStorage`；缺少 OS 密钥时失败关闭，不退回明文。加密快照用临时文件加原子替换并按账户隔离，跨重启能恢复；旧/其他账户草稿不可在当前账户中读取或覆盖。断开邮箱时会尝试清除此机的凭据、邮件头和草稿。软件不承诺物理介质安全擦除，旧备份/文件系统快照仍可能留存密文。
- 草稿不会上传到 Supabase，不在五库 SQLite 备份中，不在 SMTP 成功前被自动删除。成功 SMTP 后尝试清理对应草稿；**即使草稿删除失败，也不能把已确认接受的 SMTP 邮件误报为发送失败**。网络错误在 DATA 后可能投递不确定，绝不自动重试。
- 原有 AI 邮件提取需先预览用户指定邮件头/正文和可能计费请求，模型不能代替用户发信、建任务或写入草稿。仍不支持 HTML、附件、群发、自动回复、抄送等。

## AI 复习卡：来源证据与三次动作

- 在知识库**单个已选原文片段**的页面新增「AI 复习卡候选」。先预览完整模型 prompt 和来源片段，再明确同意可能付费的模型请求（复用个人可选 Provider Key）。
- 模型必须返回严格 JSON `{question,answer,evidenceQuote}`；`evidenceQuote` 要是当前实际上传片段里的连续原文，缺失、字段多余、格式错误、越界、模型幻觉引文都会直接拒绝，不会自动写库。
- 用户必须在原文和证据并排时自行编辑问答、勾选“我已核对”，再次点击保存。写库前再次确认当前本机来源版本和正文没有变化，再调用现有知识卡创建 IPC。已保存的卡仍适用既有的人工编辑、来源更新复核和复习调度。模型不能自己解释事实正确与否，**引用存在也不证明答案真实准确**。
- 个人 AI 调用是否成功、费用/模型内容、真实质量仍依赖用户提供合法 API Key 并在真实 GUI 中走查。OpenAI/DeepSeek/Anthropic/Gemini/兼容 API 配置仍按现有安全政策。

## 自动化与人工验证

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/connectors/mail-drafts.test.ts src/main/connectors/mail-service.test.ts src/main/connectors/mail-smtp.test.ts src/shared/mail-model.test.ts src/shared/knowledge-ai-card.test.ts src/shared/ipc-channels.test.ts
npm test
npm run build
```

**未授予真正凭据也可以运行上述全部测试；模拟加密适配器不是 DPAPI/Keychain 的真实验收。**

真实 Windows/macOS 验收顺序（使用隔离的 `STUDY_ANCHOR_USER_DATA_DIR`，保留脱敏截图）：

1. 合法交大账户 IMAP 连接/同步，确认列表中只有邮件头，未自动下载正文。
2. 逐封点“授权读取本封正文”、再收起/切页/断连；比较网页版未读标记，确认附件不落本地。
3. 回复含显示姓名的有效发件人；不合法/多发件地址不能自动指定收件人；发送预览必须展示 Re: 主题和引用标识。
4. 保存空主题/未完成草稿，重启检查仍在；更新、删除、20 份上限、跨账户隔离、断连清除。系统安全存储不可用时不得产生明文草稿。
5. 使用用户本人合法测试邮箱相互发送**一封**纯文本测试回复，确认收到并核对 Sent；在网络丢失时不重复点击发送，先检查可能已投递记录。
6. 用自选个人 AI Key 对非敏感本机文档的一段内容预览请求并确认一次模型调用；修正候选、核对引用再保存，评分后重启验证。
7. 试验错误模型 JSON、伪造证据、修改原文版本、撤销授权、错误凭据，验证不会悄悄建卡、发信或保存密码。
8. 以上必须在 Windows/macOS GUI 和各自 OS 安全凭据环境各自记录结果，CI 全绿不代表真实邮件投递或模型质量。

## V0.1 阻塞状态

这轮完成的是可部署/可人工验收的代码，并非外部资源已验证：**真实 Supabase 五人 RLS + Realtime、五账号断网重连、Canvas Personal Token / 学校 OAuth 审批、交大邮件 IMAP/SMTP、任意 AI Provider 自选合法 API Key、Windows/macOS 真实安装与恢复**仍须真实账号、授权和独立验收。保持 Blocked 或待验收，不得合并为“全部完成”。
