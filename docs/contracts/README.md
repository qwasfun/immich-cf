# 上游契约证据

当前调查对象为 Immich `v3.4.1`，固定提交 `22b95194c80a2f2e6201093916b6c8c3d6d271dd`（2026-11-13 更新）。这些文件用于兼容性研究，不代表 immich-cf 已提供这些接口。升级范围及验证见 [3.4.1 对齐记录](../upstream-v3.4.1.md)。

- `upstream/immich-v3.4.1.openapi.json`：当前官方 OpenAPI 原始字节归档，不格式化、不改写。
- `upstream/immich-v3.3.1.openapi.json`、`history/v3.3.1.manifest.json`、`history/v3.3.1.source-inventory.json`：旧版本历史证据，原有参考测试报告仍只证明 3.3.1。
- `upstream/LICENSE.immich`：上游随附许可证原文；归档属于上游材料，不据此替整个项目重新声明许可证。
- `source-inventory.json`：64 项官方源码路径、固定提交 URL 与 SHA-256。源码正文留在忽略目录 `work/upstream-v3.4.1`；以后可按 URL 重取并校验，不依赖该临时目录。
- `v3.4.1-source-review.json`：与 3.3.1 的 OpenAPI 差异和适配决策，属于静态源码证据。
- `operations.json`：由归档 OpenAPI 提取的全部 operation、路径、参数、鉴权、请求及响应引用。所有 `$ref` 均指向归档 OpenAPI 的 components。
- `../../scripts/verify-contracts.mjs`：离线校验归档摘要、287 个操作、运行时协议版本/同步枚举和冻结清单的一致性。它不执行 Immich、Dart 或 iOS，也不验证 Cloudflare 运行时。

没有真实抓包夹具。不要将上游单元测试、示例或手工构造的 JSON 标为实机抓包。后续采集的夹具需记录客户端 build、服务端摘要、步骤、预期与实际，并在提交前移除 Cookie、令牌、邮箱、设备标识、地理位置和私密媒体。

在仓库根目录运行 `pnpm contracts:verify` 可离线复核。摘要校验独立于 `pnpm check`；上游原件被排除在自动格式化之外，并通过 Git 属性保留原始字节。

更新协议版本必须作为独立变更重新审计移动端调用、服务端序列化、版本能力判断及 iOS 原生网络层，同时更新 manifest、摘要和差分验收结果；禁止使用 `latest` 替代固定引用。
