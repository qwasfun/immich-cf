# iOS 截图 XMP 修改时间与方向误拦截修复

2026-11-16（Asia/Shanghai）。

## 原因与变更

生产官方 App 上传 `IMG_9093.PNG` 返回 `assetData` 400。用户提供的原件为 1,963,968 字节、1170×2532 PNG，未压缩 iTXt 中包含 `exif:UserComment`、`photoshop:DateCreated`、`xmp:ModifyDate`、`tiff:Orientation` 四个简单文本字段。旧实现仅允许前两个字段及其命名空间，因此拒绝了这个静态元数据布局。使用原件和结构等价的合成 JPEG/PNG 均在修改前复现 400；不根据文件名或图片内容判断是否含动态关联。

仅增加标准命名空间 `http://ns.adobe.com/xap/1.0/` 下的 `ModifyDate` 和 `http://ns.adobe.com/tiff/1.0/` 下的 `Orientation`。两个字段允许简单元素或 Description 属性形式，按命名空间 URI 与局部名称识别，支持前缀别名。字段含义分别见 [Adobe XMP Basic](https://developer.adobe.com/xmp/docs/xmp-namespaces/xmp/) 与 [Adobe TIFF](https://developer.adobe.com/xmp/docs/xmp-namespaces/tiff/)。

保留单个 Description、简单文本、32 KiB、32 元素限制；未知命名空间、未知字段、重复字段或块、嵌套复杂结构、DTD/实体声明、处理指令、非法 XML/UTF-8 和压缩 XMP 仍拒绝。不增加动态照片 XMP 配对协议；既有 EXIF/MOV 配对和关闭 Live Photo 时的防护继续执行。新增字段仅用于兼容性校验，不修改方向、图库日期或元数据提取逻辑；EXIF 仍按既有规则处理。上传及下载均保留原图字节，不剥离元数据。

XMP 错误继续通过 `errors[].path: ["assetData"]` 定位字段，区分大小、命名空间、字段、重复、XML、DTD、压缩及容器头原因。校验捕获不再覆盖已经明确的错误；错误只含固定描述，不回显元数据值、命名空间内容或解析器原文。修正建议改为保留原件并联系管理员检查兼容性，不再要求把可能兼容的原件移出备份相册。

## 验证

本机私有原件仅保存在 Git 忽略的 `tests/private-fixtures/xmp/`；仓库中只增加中性日期、无私人标识的合成字段布局。私有样本不可用时明确 skip，不计作真样本通过。

回归覆盖两种上传模式（Live Photo 开启和关闭）的真实原件上传、重复去重、原件逐字节一致、1170×2532 同步尺寸及 ACK；合成 JPEG/PNG 额外覆盖别名前缀和属性形式。拒绝用例覆盖新增命名空间中的未知关联字段、命名空间欺骗、字段重复、嵌套及原有 XML/资源边界；具体错误测试确认不泄露提交值。

本机定向 9 项全部通过，完整 `pnpm check` 的 332 项测试全部通过、0 失败、0 跳过，格式、规范、前后端类型和网页/Worker 构建通过；`pnpm contracts:verify` 的 287 个操作、64 项来源记录一致。

## 发布与线上验收

发布提交 `d287a9aa1d0f0283d0f82915f4f1a794e269e0fb` 按 dev → test → prod 顺序逐级发布、验收。三环境均确认新版本承接 100% 流量，38 项既有迁移均无待应用项；无需新迁移或用户数据修复，网页构建资源未变化。

| 环境 | Worker 版本                            | 线上检查 |
| ---- | -------------------------------------- | -------- |
| dev  | `ee85635d-e912-447b-b903-62bf906f4722` | 40 项    |
| test | `6be253d4-c008-444f-a92d-8284d37894dc` | 42 项    |
| prod | `a17ea4ac-1b5a-4966-9c4d-a8a6ad591871` | 42 项    |

共 124 项线上检查通过：元素与属性形式的 JPEG/PNG 上传、重复去重、原图逐字节一致、同步、ACK 后空增量，以及未知关联字段、命名空间、重复字段、DTD 和非法实体的具体脱敏错误。拒绝项无新增资产。仅在隔离验收账号中上传仓库公开夹具生成的合成图片；本次测试资产及物理对象已全部清理，验收账号停用，临时会话退出。

真实用户原件仅在本机验证，没有上传到任何远程环境。线上结果来自结构等价的合成样本，不代表官方 App 真机验收；用户可在生产重新开启备份、重试原件。

同一发布提交的 [test CI](https://github.com/qwasfun/immich-cf/actions/runs/43787423812) 与 [prod CI](https://github.com/qwasfun/immich-cf/actions/runs/43787716342) 均通过。dev 首轮 CI 的既有网页标签清理用例遇到本机 SQLite `SQLITE_BUSY_SNAPSHOT`，并非 XMP 校验失败；本机完整回归与另外两分支同源 CI 均通过，已发起 [dev 失败任务重跑](https://github.com/qwasfun/immich-cf/actions/runs/43787185807)。

脱敏结构化证据见 [截图 XMP 验证记录](contracts/p2-screenshot-xmp-2026-11-16.json)。
