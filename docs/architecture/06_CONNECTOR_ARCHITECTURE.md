# W3 Connector Engine 与外部接入
## 架构
统一 Connector Engine 负责账户授权、凭据句柄、调度、分页、限流/退避、错误状态、同步游标、来源 ID、去重、重连及撤销。独立 Adapter 转换第三方协议；M1/M2/M7 负责业务，不让每个模块直接依赖平台 SDK。首版内置适配器，不建设公开 Connector 市场。

| 平台 | 版本范围 | 真实验收重点 |
|---|---|---|
| 上海交大 Canvas | **P0** 课程、作业、日历只读 | 合法授权、分页、截止时间变更、远端提交与个人完成分离 |
| SJTU jAccount 教务 | **P0** 真实课表 | 开发者申请、lessons scope、周次/节次/地点 |
| 交大邮箱 | **P0** 真实收件和监督发送 | Mail API 或可验证 IMAP/SMTP、阅读/发送分权、超时核验 |
| Google Calendar | **P0** 只读及增量 | OAuth、重复事件/时区、撤权 |
| Outlook Calendar | **P0** Microsoft Graph 日历 | 个人/学校租户权限、管理员拒绝 |
| Notion | **P0** 指定页面/数据源读取 | OAuth、字段映射、限流及访问范围 |
| ICS、CSV、Markdown | **P0** 导入导出 | 映射预览、编码、去重、回滚 |
| Gmail / Graph 专用邮件 | **P1** | 单独 OAuth 敏感权限和公开验证 |
| 更多高校/插件市场 | P1/P2 | 待后续决策 |

**关键优先级约束**：通用 IMAP/SMTP 可作为交大邮箱的技术实现与后续扩展基础，但“所有邮箱服务商均 P0 可用”并未被批准。Gmail/Outlook 的 P0 是**日历**而非专用邮箱。

## Adapter 契约
```ts
interface ConnectorPort {
 capabilities(): ConnectorCapabilities;
 authorize(req:AuthRequest):Promise<AuthResult>;
 pullChanges(accountId:string,cursor?:string):Promise<ExternalPage>;
 disconnect(accountId:string):Promise<DisconnectResult>;
}
type ExternalPage = {
 items: Array<{provider:string;accountId:string;externalId:string;
 remoteVersion?:string;deleted?:boolean;sourceUrl?:string;payload:unknown}>;
 nextCursor?:string;hasMore:boolean;
};
```
错误码至少区分 AUTH_REQUIRED、ADMIN_DENIED、INVALID_SCOPE、RATE_LIMITED、OFFLINE、CURSOR_EXPIRED、REMOTE_UNKNOWN。按 provider+account+externalId 去重；外部来源时区/版本/URL 保留，用户自有备注单独储存。OAuth 使用服务商允许的桌面授权方式（常见为系统浏览器授权码+PKCE），机密 client secret 不打入 Electron 包；jAccount 密码不由软件收集。

## 真实接入四层门禁
接口文档存在 ≠ 适配器开发完成 ≠ 合法真实测试通过 ≠ 普通用户可正常授权发布。校方审批/组织管理员/公开 OAuth 验证可能是发布阻塞因素；必须在 W4 早期 Spike 记录证据。手动 ICS/CSV 导入可作为备份路径，但不能冒充真实 API P0 验收。

## 发信适配
收到 M7 已冻结的草稿版本、From/To/Cc/Bcc/回复对象/附件及用户该次确认后，才允许一次实际发送。SMTP/API 超时可能已送达，进入 unknown 状态，先核对远端，绝不自动盲重发。邮件内容不可信，连接器访问权限不自动赋予 AI 处理或云端外传权。
