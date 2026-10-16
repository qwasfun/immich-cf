# P2 Live Photo 部分备份防护

2026-10-16 更新：普通静态 XMP 改为严格字段白名单，详见 [样本误拦截修复](p2-static-xmp.md)。下文“一律拒绝 XMP”为历史策略，未知/压缩/动态关联 XMP 仍拒绝。

日期：2026-10-15。官方 App 3.3.1 build 23 不修改，密码参数和 reset/ACK 协议不变，CPU 超预算继续暂缓。

## 评估与选择

冻结源码 `mobile/lib/services/foreground_upload.service.dart` 的前台路径先上传 hidden 动态部分，只有成功才向静态请求添加 livePhotoVideoId；两部分共享 deviceId/deviceAssetId。动态部分失败或无法取得动态文件后，静态部分仍可能上传。后台路径单独调度，不据此推断真实 iOS 所有路径。

本轮增加持久负面记录：已完整解析的 hidden 或带 livePhotoVideoId 请求，若有两个设备标识，先记录该用户下的标识组合，再按现有策略拒绝。随后相同组合的静态请求在去重、R2 和资产发布前被拒绝。记录跨会话、重试和 Worker 重启保留，不自动过期，不改写或删除历史图库。

组合使用 SHA-256 摘要，按用户隔离；不保存原始设备资产标识。每用户最多 256 个组合，超出时增加一条账户级阻止记录，暂停该用户全部上传，绝不自动淘汰旧记录放行。没有自动解封接口；如需处理饱和，应先停止该账户备份并人工评估，不能以清表作为常规重试步骤。重复已有组合不会触发饱和。数据库不可用时当前请求返回字段明确的 503。

## 确切边界与 Go/No-Go

这是已识别请求的风险缓解，**不是完整解决 Live Photo 部分备份**：

- 动态请求未到服务器、客户端取不到动态文件、请求超过整个 multipart 的 4 MiB + 64 KiB 限制、截断或解析失败时，可能无法登记。标记登记失败后的另一请求也不能保证有历史证据。
- 缺失或变化的设备标识、静态请求先于动态标记处理，以及其他客户端路径，不能依赖此关联机制。已发布或客户端此前按校验和跳过上传的资产不会被追溯撤回。
- hidden 并非 Live Photo 唯一语义，保守阻止可能影响同标识的其他隐藏图片；当前实验入口本就不支持隐藏图片。
- 未进行 Apple MakerNote 全面识别或真实媒体内容解码，不能证明普通 JPEG/PNG 一定是独立静态图。

Go：仅静态测试相册继续 dev 验证。No-Go：Live Photo 完整备份、安全删除手机原件或 P2/G1 整体通过。仍须保留原件并从常规备份测试相册排除 Live Photo。要彻底闭合，需要可证明的完整配对支持或可可靠区分所有静态部分的契约；不能用伪成功、修改官方 App 或弱化认证绕过。

## 回归与操作

新增真实 Worker/D1/R2 用例：动态拒绝后静态并发重试、重新登录、相同校验和去重绕过、跨用户/设备隔离、无资产/上传意图/R2 孤儿、无 Sync 资产、数据库失败、标识校验、可解析但单文件超限的动态请求以及 256 条饱和边界。旧测试将独立静态图和 hidden 图改为不同设备资产标识，另断言原 hidden 标识始终被拒绝。

迁移 `0010_live_photo_blocks.sql` 必须先于新 Worker。不要回滚到不检查此表的旧 Worker，否则会绕过已记录的阻止。在线脚本 `node scripts/live-photo-probe.mjs` 仅对 dev 使用固定合成标识，检查跨登录静态拒绝及独立图片 Sync/ACK，保留一条合成拦截记录；不代表真实 Live Photo 或官方 App 调度通过。

## 验证与部署结果

- `pnpm check`：57 项回归全部通过，格式、静态检查、类型检查及构建通过。`pnpm contracts:verify`：279 个操作、53 份源码记录通过。
- 源码提交 `96799db5ace56aca7c4eb386258083a1d3542779`；dev Worker `baf599d6-6144-43b9-b2f3-333a64faf018`；D1 已应用 0010；test/生产未变更。
- 刚发布后的首次公网检查失败：静态重试返回 200，随即查询拦截表为零。确认发布版本为 100% 后，同一脚本连续两次通过，表中一条记录。现象与发布传播窗口一致，但没有逐请求版本证据，原因未完全证明。发布期间应暂停 Live Photo 测试，不能仅依据部署命令成功认定新防护已生效。
- 最终[脱敏公网记录](contracts/p2-live-photo-probe.json)：hidden 拒绝、重新登录后重复静态拒绝、独立图片去重成功及 Sync/ACK 通过。合成图片本就存在，首次失败没有新增逻辑图片。记录明确标记官方 App 未验证。

## 第二层防护：文件内元数据（2026-10-15）

不依赖动态请求先到达，也不要求 deviceId/deviceAssetId：JPEG APP1 EXIF 和 PNG eXIf 中，有限遍历 IFD0 → ExifIFD → Apple v1 MakerNote。发现 Apple ContentIdentifier（0x11）或 LivePhotoVideoIndex（0x17）标签即拒绝，包括空/非法标签值，不读取或回显标识内容。识别检查发生在校验和去重、上传意图和 R2 写入之前。支持 TIFF 与 MakerNote 各自独立的 II/MM 字节序；不跟随任意递归或 MakerNote 链。

检查依据（2026-10-15 核实）：[Apple 的 pairedVideo 定义](https://developer.apple.com/documentation/photos/phassetresourcetype/pairedvideo)说明 Live Photo 存在独立视频资源；[ExifTool Apple.pm](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/Apple.pm)定义上述标签，[MakerNotes.pm](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/MakerNotes.pm)定义 Apple iOS 头和目录起点。Apple 私有二进制格式依据 ExifTool 的实现观察，**不是 Apple 对所有系统/导出路径的兼容保证**。

安全限制：每个普通 IFD 最多 512 项，Apple 目录最多 256 项。未知 MakerNote、未知版本/字节序、截断、越界、重复私有块或异常 ExifIFD 指针会返回明确的 assetData 错误。JPEG 非 EXIF APP1（含标准/扩展 XMP）保守拒绝；PNG 使用 XML:com.adobe.xmp 关键字的 iTXt/tEXt/zTXt 在解压前拒绝，不执行 XML 或压缩数据解析。

兼容性代价：普通相机照片的非 Apple 私有信息、不支持版本的 Apple 元数据、带 XMP 的静态照片也可能被拒绝。支持的 Apple 私有块没有配对标签时仍可上传；这不是“已证明源照片不是 Live Photo”。不得建议清理元数据来绕过检查，否则会丢失判断依据。历史尺寸修复复用同一图片检查器，因此这些历史资产的尺寸修复也会被拒绝，但不会删除资产、修改原图或撤销既有同步。

本轮合成回归覆盖：JPEG/PNG、外层/内层两种字节序的组合、两种配对标签、无设备字段且从未请求动态部分、无资产/上传意图/R2 写入、无 Sync 资产、异常指针/类型/长度/版本、未知私有头、XMP 各容器、拒绝后普通图片成功。此前持久拦截与 reset/ACK 回归继续执行。

仍未解决：元数据已被剥离、转码、迁移到未识别容器/目录、或客户端依据既有资产校验和直接跳过上传时，服务端不能推断动态资源。若两个静态请求的字节和字段完全相同，而一个来自普通照片、另一个来自丢失动态部分的 Live Photo，服务端无法区分；要绝对拒绝后一种就必须也拒绝前一种。当前不采取全面停止静态上传的策略，也不宣称风险完全消除。未使用真实 Apple Live Photo 样本或官方 iOS 真机验证，P2/G1 仍 No-Go。

在线脚本 `node scripts/live-photo-metadata-probe.mjs` 仅对 dev 发送五份带标签/损坏/XMP 的合成图片，不发送动态先行请求或设备标识；验证拒绝及普通图片 Sync/ACK。拒绝样本不应保存，普通图沿用已知小 PNG 去重。本轮无新增数据库迁移。

### 第二层验证结果

- `pnpm check`：59 项回归、格式、静态检查、类型检查及构建全部通过；冻结契约校验通过（279 个操作、53 份来源）。
- 运行代码提交 `054d8641068a06fe36d0247f46f369f56d1cfa40`，dev Worker `7f9388f1-543e-481c-bff4-6e46dd24752c`；D1 保持 0010；test/生产未变更。
- 北京时间 2026-10-15 02:24，[公网结果](contracts/p2-live-photo-metadata-probe.json)：五份合成样本全部 400，assetData 错误字段符合预期；普通 PNG 去重 200、Sync/ACK 通过。脚本先用错误校验和的 XMP 请求确认新防护响应，避免就绪检查被旧 Worker 当作有效上传。
- 新防护没有真实 Live Photo 样本或官方 App 实机通过证据；两项未验证状态明确保留在报告中。CPU 问题继续暂缓，密码与 reset/ACK 隔离未改动。
- 同一 dev 版本再次运行 `scripts/live-photo-probe.mjs` 通过：原有已登记标识的跨登录静态重试仍拒绝，独立图片仍能 Sync/ACK。
