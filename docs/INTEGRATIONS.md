# 外部平台接入与权限

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

## 通用日历

- 先支持 ICS 导入/订阅及手工维护。
- 后续根据真实需求评估第三方日历的 OAuth 双向同步。
- 保留原始时区与重复规则，处理学期周次和例外日期。

## Obsidian

- 优先采用用户自己可见的 Markdown 文件，不强制转换到封闭格式。
- 可选：URI 打开、官方 CLI、Obsidian 插件、用户允许的 vault 文件夹操作。
- 避免同时改写同一文件引发冲突；必须尊重笔记的文件系统权限。

官方参考：https://obsidian.md/help/uri

## 本地录音转写

- FFmpeg + Whisper/FunASR 等作为候选处理组件；提供只转写不上传的本地模式，以及经用户同意的云端处理模式。
- Windows 和 macOS 分别构建/测试；不能要求用户安装 WSL。
- 确认课堂录音、公开传播和第三方模型/云服务的权限与隐私风险。

## 接口验收前置条件

1. 获取合法授权，确认允许的 API 访问范围。
2. 用最小范围测试课表、作业、日期、附件访问等核心资源。
3. 记录错误码、限流、分页、失效令牌、断网及数据更新情况。
4. 提供用户可理解的授权撤销和手工导入后备路径。
