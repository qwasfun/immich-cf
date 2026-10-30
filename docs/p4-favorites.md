# P4 本机原型：收藏

## 契约范围

沿用冻结官方 v3.3.1 OpenAPI 的 updateAsset / updateAssets：

- PUT /api/assets/{id}，请求 {"isFavorite":true|false}，200 返回 AssetResponseDto。
- PUT /api/assets，请求 {"ids":["uuid"],"isFavorite":true|false}，204 无正文。

批量最多 1000 个输入 ID，并去重；现有账号 20 个逻辑项配额不变。任一缺失或他人资产使整批不修改并返回具体 ids 错误。仅支持收藏，description、拍摄日期、rating、定位、livePhotoVideoId、visibility 等其他编辑字段明确拒绝，无部分成功或假成功。原图/预览路径仍只读。

写入的 D1 batch 在提交时检查全部所有权、会话有效期、禁用状态与数据库时钟。AFTER 触发器与同步版本原子推进；重复设置相同值不推进版本或更新时间。成功响应丢失后，重试同一收藏值保持幂等。响应读取发生于更新触发器之后。

0020 增加 assets.updated_at，并从 created_at 前向补齐；业务字段实际变化才更新。created_at、file_created_at、file_modified_at 不被收藏修改，不改写拍摄日期、R2 原图、摘要、预约或私有读取策略。现有详情和收藏响应共享 DTO，符合冻结 schema；资产事件以原 AssetV2.isFavorite 同步，未扩展协议枚举。

## 本机验证

覆盖单张收藏/取消、批量和重复 ID、完整响应 schema、初次/增量与幂等重放、已有图片字节、缺失/跨账号资产整批拒绝、字段明确提示且不回显提交值、事务时会话撤销/过期/禁用、提交后响应丢失重试。非空前向迁移验证旧列与同步时钟不变，新增更新时间正确补齐。

这只是 P4-02 的收藏子项本机原型，未完成个人相册、回收站、两设备真机或完整 P4 验收；G1、P3 实际图库与预算关口未通过，不因原型存在就宣告阶段 Go。开发与故障注入先使用本机迁移至 0020 的 dev:local；用户授权完整检查后部署 dev，并执行公网收藏与同步验证，结果另记。

完整本机检查：161 项通过、0 失败、0 跳过，格式/lint/类型与 dry-run 通过；构建 212.11 KiB / gzip 51.98 KiB。冻结契约 279 操作 / 53 来源保持一致。
