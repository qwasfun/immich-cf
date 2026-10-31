# Live Photo 原件备份与免费预览

日期：2026-11-01（Asia/Shanghai）。本轮目标为现有官方 iOS 3.3.1，不修改 App；真实 iPhone 播放和恢复尚未验收，不能标为完整支持。

实现已部署 dev，完整检查与公网结果见[dev 验证记录](p2-live-photo-support-dev-deployment.md)。test/生产保持不变。

## 接口与存储

沿用 POST /api/assets。先上传 visibility=hidden 的 MOV，取得 id；再上传 JPEG/HEIC，livePhotoVideoId 填入该 id。两份文件独立保留原始字节和 R2 原生 SHA-1；按照片 MakerNote ContentIdentifier 与 MOV content.identifier 校验同一所有者内的配对，不接受替换配对、缺少动态原件或已删除视频。MOV 限 H.264/HEVC 与有效 Live Photo 元数据，不开放普通视频备份。

照片上限 20,000,000 字节；动态视频 64 MiB。图片继续限制 6400 万像素、单边 16384；容器检查有界，不等同于完整像素/视频解码。文件内元数据上限 4 MiB，单份 EXIF 上限 256 KiB。保守拒绝无法识别的私有元数据，不能通过剥离元数据绕过检查。

流式 multipart 接收时以 5 MiB 分片写入独立 staging 前缀，并增量计算摘要。完整 EOF、字段和容器校验通过后，复用持久上传预约，将暂存数据流写入带 R2 原生 SHA-1 的正式原件，再事务发布资产。失败保留正式预约；同一配对的每种组成部分最多一个预约，防止不同字节滥用同一逻辑名额。专用暂存对象在完成后或过期后安全清理，持久隔离阻止后续引用。每账户最多 4 个同时接收中的文件及 8 个未清理暂存任务，接收租约 1 小时。

20 个逻辑资产的名额包含待恢复上传与回收站；一组 Live Photo 只占一项。隐藏视频不得进入普通相册或封面。照片与视频一起回收、恢复或申请永久删除，预览加入已有授权清理任务。备份预检查验证两份原件，异常时允许重传；照片重传不能跳过坏视频。

GET/HEAD /api/assets/{videoId}/video/playback 与 original 返回私有 MOV，支持 Range/ETag；不转码。Asset DTO/Sync 返回真实 type、visibility、duration、livePhotoVideoId。隐藏视频的缩略图引用配套照片；尚未配对时明确不可用。

## Images 免费额度模式

Images 绑定直接读取私有 R2 原件，避免公开原图 URL。HEIC 生成 JPEG 两种固定尺寸（最长边 256/2048、保持比例），结果留在私有 R2，按原件摘要与处理版本复用。普通 JPEG/PNG 保持现有读取方式。

IMAGES_FREE_CONFIRMED 未确认时不调用转换。只使用转换功能，不调用 Images 托管存储、不购买套餐、不改变现有订阅。Cloudflare 当前提供每月 5,000 种免费转换，账户内项目共享；本项目额外以 UTC 自然月、原件摘要/尺寸/版本做 5,000 种的事务上限。该本机计数不是账户总用量或账单计量，其他项目用量仍需账户层核对。服务端 9422 会暂停新增转换至下月，其他故障按 5 分钟重试。免费绑定/额度不可用时不得自动升级付费服务。

两份原件完整即可确认备份，预览失败不撤销已保存原件。缺少预览时返回 preview 字段具体错误，不返回占位图；既有预览继续读取。持久任务由上传后、读取预览时及现有定时任务续跑；两种预览每次最多处理两项，有租约和并发保护。

依据：[官方价格](https://developers.cloudflare.com/images/pricing/)、[Images 绑定](https://developers.cloudflare.com/images/optimization/binding/)、[输入限制](https://developers.cloudflare.com/images/get-started/limits/)。Images 服务输入上限为 20 MB，其他服务侧解码限制仍可能导致某些原件暂时只有原件备份而没有预览。

## 运维与导出

前向迁移 0025–0028 保留历史图片、预约、拦截记录与 Sync 检查点，并在写入任何 multipart 分片前保存上传编号，供重启后主动中止过期分片。ENABLE_LIVE_PHOTO 只控制新增上传；关闭后已有 Live Photo 仍可读取和导出，不回退到不认识这些数据的旧 Worker。

管理员状态新增待配对、待预览、额度异常及有界原件健康观察；超过 40 个组件时标记为抽样，存储故障与确认异常分别计数。完整逐页原件检查仍使用既有只读存储对账入口。

导出清单 v2 包含照片和隐藏视频的类型、配对 ID、原文件名、字节数和 SHA-1。导出工具兼容 v1，按格式安全命名并核对两份原件；缺少动态部分、摘要不符、重复配对或下载期间图库改变时，只留下 INCOMPLETE，不能生成 COMPLETE.json。预览可重建，不代替原件或配对数据。该功能不等同于整库灾备。

## 验收

本机自动化覆盖合成 JPEG/HEIC/MOV 配对、20 MB/64 MiB 边界、坏表单/容器、越权、重复与并发名额、原件修复、Images 额度与故障恢复、双会话 Sync/ACK/reset、相册限制、整组回收和永久删除以及 v1/v2 导出。合成 HEIC/MOV 只证明协议和容器逻辑，不是实际编码播放证据。

另使用 Immich 官方公开 HEIC 样本 IMG_2682.heic（test-assets 提交 ec56cc6c1d76c45bc9615dc6ea232470a2b0a3a1，Git blob 85cdc07c925bbcd9b35001046d8f5a4c5c72870d）本机检查，并以临时远程 Images 绑定验证 4032×3024 识别及两种 JPEG 预览。该样本有动态标记但缺配对标识，直接上传会明确拒绝，不能把转换成功算作完整备份。

完整公开配对补充采用 [thun888/LivePhoto](https://github.com/thun888/LivePhoto/tree/d64b838b4ed31214ce450e6aeb19436d410c461c/images) 的 IMG_E1887 与 [Hiwoniu/live-photos](https://github.com/Hiwoniu/live-photos/tree/af905a3a62c81a925dbee3aef971379cb1f7a720/iOSSpike/LivePhotoSpike/Resources) 的 Control。用 Git blob 摘要冻结样本，覆盖 QuickTime 不含 FullBox 标志字的 meta 布局，同时保留 ISO 布局用例。样本与图片结果仅留在忽略目录 work，不上传个人照片或提交素材。这些公开样本的备份和转换结果也不能替代用户的 iPhone 播放、系统相册恢复验收。

上线后仍须用真实 iPhone 的 JPEG、HEIC Live Photo 验证前台和后台备份、第二设备同步、动态播放，以及下载保存到系统相册后仍可播放；记录 App build/iOS 版本和实际结果。通过后才能标记“Live Photo 完整支持”。
