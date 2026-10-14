# P2 私有图片 HTTP 读取

日期：2026-10-14。对应需求 P2-03、T15 的媒体读取子项。CPU 超预算按用户要求暂缓；G1 仍未通过。本轮不扩大 JPEG/PNG、2 MiB、400 万像素及每账户 20 张限制，不改变官方 App、bcrypt cost 12 或 reset/ACK 状态机。

## 功能

- 原图、thumbnail/preview 现有读取路径支持单段 `Range: bytes=start-end`、开放结尾与后缀范围，返回 206、准确 Content-Range/Content-Length 和对应字节。
- 越界或空范围返回 416 和 `Content-Range: bytes */总长度`。多段、未知单位及无法安全解析的范围忽略 Range，返回完整 200；不宣称支持 multipart/byteranges。
- HEAD 返回完整表示的头部，不读取 R2 对象正文。HEAD 忽略 Range。
- If-None-Match 支持当前 ETag、弱比较、列表和 `*`；匹配返回无正文 304。If-Range 仅匹配强 ETag 才应用 Range，日期或不匹配值回退完整 200。不新增日期条件请求能力。
- 所有条件判断发生在会话认证、资产归属验证后，保留 `Cache-Control: no-store`，不开放公开对象链接。退出后的旧令牌不能取得 304 或媒体字节。
- 先 R2 head，再按需 get；get 通过 ETag 条件保护对象替换竞态。对象缺失或变化返回 503，不返回错误字节。普通 GET 多一次元数据读取，未宣称这一变更降低 R2 调用成本。

依据：[Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) 的 head、range、onlyIf 和 httpEtag。官方 App 的原请求路径与参数保持不变。

## 验证与边界

真实本地 Worker/R2 回归覆盖完整字节、四类范围、越界、无效/多段范围回退、If-Range 强弱匹配、If-None-Match、HEAD、跨用户 404 与撤销后 401。既有上传、非空同步和 reset/ACK 并发测试全部继续运行。

公网脚本 `scripts/media-probe.ps1` 使用临时会话和现有 dev 图片，不新增或删除图片；检查完整读取、范围字节一致、HEAD、304、416、退出后 401，输出脱敏报告。

仍未完成：真实 iOS 本轮操作验收、JPEG EXIF 方向样本、100 张混合样本、HEIC/视频/Live Photo、混合大小备份队列及 Android 验收。原图继续充当有界小图片预览，不声称已生成缩略图。相册、收藏、回收站等后续阶段功能不计为完成。
