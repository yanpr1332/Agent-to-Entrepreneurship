# W3 需求/接口/验收追踪矩阵
> 基于 [PRD V1.0](../PRD.md) 与 [W2 UX 24 项](../ui-ux/05_W2_ACCEPTANCE.md)，仅映射架构设计，不宣称已执行测试。

## 八大 P0 模块
| PRD 编号 | 归属 | W3 实现区域 | 核心保证 |
|---|---|---|---|
| CAL-01～08 | M1 任务/日历 | [数据](03_DATA_MODEL.md)、[接口](04_MODULE_INTERFACES.md)、[同步](09_SYNC_AND_COLLABORATION.md) | 课程/任务、提醒、AI 候选、锁定时间、离线 |
| KB-01～09 | M2 知识 | [AI/知识](07_AI_AND_KNOWLEDGE.md) | PDF/OCR/ASR、图谱、跨文档、复习和证据 |
| FOC-01～07 | M3 专注 | [OS](08_SYSTEM_ADAPTERS.md) | 安全限制、恢复、积分和自定义现实奖励 |
| COL-01～08 | M4 团队 | [同步](09_SYNC_AND_COLLABORATION.md) | 聊天、文件、共享、认领、单人验收 |
| AI-01～08 | M5 AI | [AI](07_AI_AND_KNOWLEDGE.md)、[权限](05_SECURITY_AND_PERMISSIONS.md) | 日/周/长期规划、Project、云外传授权 |
| INT-01～08 | M6 连接器 | [接入](06_CONNECTOR_ARCHITECTURE.md) | 真实 Canvas/教务/邮箱、日历、Notion、开放格式 |
| MAIL-01～09 | M7 邮件 | [接口](04_MODULE_INTERFACES.md)、[接入](06_CONNECTOR_ARCHITECTURE.md) | 独立邮件中心、监督发信及 unknown |
| DASH-01～08 | M8 工作台 | [系统](01_SYSTEM_OVERVIEW.md) | 模块聚合、搜索、主题、组件、通知/托盘 |

## PRD E2E-01～15 追踪
| E2E | 技术组件 | 必须证明 |
|---|---|---|
| 01 | Connector+Course | 真 SJTU Canvas/课表授权 |
| 02 | ExternalBinding+Task | 校方修改不覆盖个人备注 |
| 03 | MailActionProposal+TaskPort | AI 会议候选经批准才创建 |
| 04 | MailDraft+SendAttempt | 用户确认后真实发送和远端证据 |
| 05 | Resource+ASR+Graph | 真 PDF/音频、跨文档及来源定位 |
| 06 | ReviewAttempt+Scheduler | 用户最终掌握度驱动下次安排 |
| 07 | AI PlanProposal+TimeBlock | 三周计划、锁定日程、选择性采纳 |
| 08 | SystemAdapter+FocusSession | Windows/macOS 强制结束后安全恢复 |
| 09 | RewardLedger | 积分与现实奖励不重复 |
| 10 | Membership+TaskReview | 团队认领、单审核、服务端 RBAC |
| 11 | SharedResource+PermissionGateway | 私人知识选择性共享、撤权 |
| 12 | AIProject+FileGrant | 子目录/软链接越权及撤权拒绝 |
| 13 | Outbox+SyncConflict | Win 离线、Mac 同步、冲突可恢复 |
| 14 | ResourceSyncPolicy | PDF A 上传、录音 B 不上传 |
| 15 | ConnectorAccount | 授权撤销/断网不损本地原件 |

## W2 UX-01～24 追踪
| UX | W3 对应 |
|---|---|
| 01–03 首启、空状态、学校连接 | User/Workspace/ConnectorAccount；[接入](06_CONNECTOR_ARCHITECTURE.md) |
| 04 邮件待确认 | CandidateAction；[接口](04_MODULE_INTERFACES.md) |
| 05 AI 时间块 | PlanProposal/TimeBlock；[数据](03_DATA_MODEL.md) |
| 06–08 导入、问答、图谱 | Resource/Chunk/Evidence/KnowledgeEdge；[AI/知识](07_AI_AND_KNOWLEDGE.md) |
| 09 复习评价 | ReviewAttempt.finalUserRating；[AI/知识](07_AI_AND_KNOWLEDGE.md) |
| 10 AI 项目 | PermissionGrant/处理位置；[安全](05_SECURITY_AND_PERMISSIONS.md) |
| 11 专注 | FocusSession/SystemAdapter；[OS](08_SYSTEM_ADAPTERS.md) |
| 12 奖励 | RewardLedger/CustomReward；[数据](03_DATA_MODEL.md) |
| 13–14 审核/P1 扩展 | TaskReview/ApprovalDecision；[接口](04_MODULE_INTERFACES.md) |
| 15 选择性知识共享 | SharedResource/权限；[安全](05_SECURITY_AND_PERMISSIONS.md) |
| 16 邮件 AI 范围 | ConnectorAccount/AIProject；[接入](06_CONNECTOR_ARCHITECTURE.md) |
| 17–18 发信审核/未知 | MailSendAttempt；[接口](04_MODULE_INTERFACES.md) |
| 19 逐文件同步 | ResourceSyncPolicy；[同步](09_SYNC_AND_COLLABORATION.md) |
| 20 离线冲突 | SyncConflict；[同步](09_SYNC_AND_COLLABORATION.md) |
| 21 主题组件 | DashboardLayout/ThemePreference；[数据](03_DATA_MODEL.md) |
| 22 搜索托盘 | SearchProjection/SystemAdapter；[OS](08_SYSTEM_ADAPTERS.md) |
| 23 角色撤权 | PermissionRevoked/Server RBAC；[安全](05_SECURITY_AND_PERMISSIONS.md) |
| 24 双平台 | Windows/macOS capability matrix；[OS](08_SYSTEM_ADAPTERS.md) |

W4 应为每项指定对应测试、真实账号/真机条件、责任人与证据链接；W3 只是可追踪的设计基线。任何 P0 未达到不得擅自降级。
