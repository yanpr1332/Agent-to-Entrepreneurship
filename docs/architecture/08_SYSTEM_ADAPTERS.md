# W3 Windows/macOS 原生适配与安全专注
## 能力接口
```ts
interface SystemCapabilityPort {
 capabilities():Promise<CapabilityReport>;
 getForegroundApp():Promise<ForegroundApp|null>;
 observeAppChanges(listener:AppChangeListener):Unsubscribe;
 requestPermission(kind:PermissionKind):Promise<PermissionResult>;
 startFocusPolicy(policy:FocusPolicy):Promise<FocusResult>;
 stopFocusPolicy(sessionId:string):Promise<FocusResult>;
 notify(message:AppNotification):Promise<NotifyResult>;
 setLoginItem(enabled:boolean):Promise<FocusResult>;
}
```
接口是目标契约，不代表两个 OS 已具备同样强度限制。Windows 使用合法的前台窗口/进程识别能力候选；macOS 使用 NSWorkspace 等应用活跃通知。监测浏览器进程不等于网站级阻断，网站限制需额外浏览器/系统能力并取得合法授权。

## 分级与安全
| 等级 | 功能 | 说明 |
|---|---|---|
| L1 普通 | 计时、活动应用观察、分心提醒 | P0 最基本真实运行 |
| L2 可逆增强 | 受控覆盖提示等温和干预 | 平台与权限允许时启用 |
| L3 更强约束 | 仅经合法能力及双平台真机验证的增强限制 | 不承诺绝对防绕过 |

P0 用户可在普通/增强模式间切换；启动前预览黑白名单、实际生效强度、必要 OS 权限、持续时间、安全退出。禁用强制杀死未保存资料应用、阻断紧急通信/系统安全/恢复功能、内核篡改或不可恢复的系统限制。权限拒绝应降级并告知，不可显示虚假“已阻断”。

## 状态机与恢复
inactive → preview → authorized → active → pausing/stopping → inactive；超时、崩溃、重启、撤权、错误配置强制走安全解除。保存 FocusSession 恢复标识，不得因应用关窗而让用户无法紧急退出。专注计时结束不等于 Task 完成，奖励由实际完成和去重事件产生。

## OS 与后台矩阵
| 能力 | Windows | macOS |
|---|---|---|
| 托盘/菜单栏 | 任务栏通知区域 | 系统状态菜单 |
| 全局搜索快捷键 | Ctrl+K | ⌘K |
| 文件授权 | 路径、选择器、真实路径校验 | 文件选择器、权限/书签候选 |
| 通知/开机启动 | 根据用户偏好 | 系统允许和用户偏好 |
| 专注 | Win 原生 Adapter 真机验收 | Mac 原生 Adapter 真机验收 |

本机路径权限不随同步到另一设备而继承；允许重新绑定。关闭窗口后驻留（默认允许）、仅必要后台服务与完全退出三种行为与 [总体架构](01_SYSTEM_OVERVIEW.md) 一致。最低 macOS、Intel/Apple Silicon 和 Windows ARM64 等支持范围仍待实际设备及依赖调查。

## 发布阻塞真机用例
强制结束进程、系统重启/注销、通知拒绝、权限撤销、超时、断网、异常关闭窗口、安全退出、不同全屏/多显示器环境；必须验证限制已解除，不能仅靠模拟原型。
