# 管理员状态与账号导出

## 权限与入口

运维管理员由operations_admins表显式授权，初始无授权；账号创建、登录、邮箱、请求参数均不能自动授予权限。通过已授权的Cloudflare控制面在正确环境执行参数化INSERT INTO operations_admins(user_id) VALUES(?)授权，DELETE FROM operations_admins WHERE user_id=?撤销。授权前核对账号ID与维护责任人；不开放HTTP提权接口。撤销、账号禁用与会话过期立即作用于后续请求，长读取在返回前重新检查。

官方Immich App的isAdmin保持原行为，此处是独立运维权限，不暴露尚未实现的官方管理员界面。使用已有登录返回的Bearer会话或同源Cookie；管理员接口只读，响应no-store。凭据只保存在本机忽略目录，不能放入URL、Git或命令参数。

| 接口                                                                       | 内容                                                                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET /api/immich-cf/admin/status                                            | 用户/资产/回收项/相册/未过期会话记录数、逻辑字节、上传与复制预约数、永久任务状态、迁移数量、支持范围及限制 |
| GET /api/immich-cf/admin/export?userId=UUID                                | 可下载JSON清单，包含该账号活动与回收资产、元数据、SHA-1、版本、相册、封面与关系                            |
| GET /api/immich-cf/admin/export/page?userId=UUID&cursor=后续游标           | 分批导出清单；首次不传 cursor，后续使用返回的游标，整次导出绑定账号/相册版本                               |
| GET /api/immich-cf/admin/export/original?userId=UUID&id=UUID&revision=序号 | 按清单版本下载原图；先完整核对字节数与SHA-1，再重验权限及资产版本                                          |

普通用户403，无效会话401。字段错误包含名称、原因和修正要求。管理员可选择其他账号导出，清单不包含密码哈希、会话、登录凭据、对象键或源键。状态只展示逻辑量，包含回收照片，明确不代表R2实际存储量或Cloudflare账单。

## 独立于App导出

将管理员登录获得的accessToken写入本机work/admin-session.json：JSON对象仅含accessToken字段。使用新目录导出，避免覆盖已有副本：

```powershell
node scripts/admin-export.mjs --base-url https://immich-cf-api-dev.fun.workers.dev --user-id <目标账号UUID> --credentials work/admin-session.json --out work/account-export-001 --proxy http://127.0.0.1:7890
```

工具使用现有 curl/TLS1.2、证书校验和可选本机代理；每个请求最多 3 次尝试、单次最多 120 秒。默认分页读取，单账号支持最多 10,000 个逻辑资产、20,000 份原件、100 相册和 1,000,000 条关系；照片最多 20,000,000 字节、配对 MOV 最多 64 MiB。按资产 UUID 命名，不将原文件名作为路径。每份原件独立核对字节与 SHA-1，结束再次核对版本；配对或相册关系不完整、鉴权失败、缺失、损坏、版本变化和网络失败均不会标为完成。工具也兼容旧版 v1/v2 小清单；[扩容细节](p2-asset-capacity.md)包含分页边界和安全检查。

输出manifest.json与UUID命名原图。只有最后原子生成COMPLETE.json才表示此次导出完整；失败保留INCOMPLETE和已取得文件，重试请选择新目录。请将成功导出的目录复制到独立受控存储，单纯保存在同一账号不构成独立备份。

## 范围与验收边界

读取清单的D1 batch捕获一致的账号元数据，原图下载按资产版本校验；下载期间图库变化会要求重导出，不宣称跨D1/R2长时间锁定快照。不会冻结用户写入、重置Sync或删除原图/预约。永久删除的资产没有可导出原图；历史验证副本与其源字节相同，导出当前可用原图，不复制内部重复源和预约。

本轮是可独立取回账号图片、元数据与关系的入口；不是整库灾备。它不导出密码/会话、预约/隔离任务、同步历史和全部R2对象；P5仍需完整备份与隔离恢复、登录/同步、RPO/RTO演练，不能将账号导出当成该关口已通过。导出文件包含私人照片和元数据，默认保持在Git忽略目录。
