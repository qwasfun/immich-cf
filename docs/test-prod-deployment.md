# 测试与生产环境首次发布

2026-11-10（Asia/Shanghai）。按用户本次部署要求，将已有 dev 功能依次晋升到 test、prod；两套环境分别初始化，不复制 dev 用户、密码、会话或媒体。

## 版本与独立资源

部署源码：`271f850b437d93a6ccc82f231287955f642dea1f`。使用项目的 `scripts/release.mjs`，分支依次快进为 dev → test → prod；后续发布记录的文档提交不改变运行代码。

| 环境 | 网页及官方 App 服务器根地址                 | Worker 版本                            | D1 ID                                  | 私有 R2 桶             |
| ---- | ------------------------------------------- | -------------------------------------- | -------------------------------------- | ---------------------- |
| test | https://immich-cf-api-test.fun.workers.dev/ | `7827c6bd-c60e-4266-8617-4f55dfd3abb8` | `a1140d40-c9c7-4155-8aaf-6273724caf03` | `immich-cf-media-test` |
| prod | https://immich-cf-api.fun.workers.dev/      | `b1ff3893-ebf5-4944-9554-ca05e1e57913` | `cc80e056-5b06-46ed-9a1f-2e6fd86a96ba` | `immich-cf-media`      |

两套 D1 均已应用 0001～0030 全部 30 项迁移。D1/R2 新资源位于 APAC，R2 的公开 r2.dev 入口关闭；当前部署均以 100% 流量使用上表版本。网页版 Assets、Images、Live Photo 和每 5 分钟 Cron 已配置，使用既有账号与套餐，没有升级服务。dev 既有数据与部署不受本次晋升影响。

## 验证与清理

- 最终本机 `pnpm check`：格式、代码规范、前后端类型、236 项测试和网页/Worker 构建全部通过；`pnpm contracts:verify` 的 279 个操作、53 个来源记录一致。
- 最终源码的 [dev CI](https://github.com/qwasfun/immich-cf/actions/runs/42811064127)、[test CI](https://github.com/qwasfun/immich-cf/actions/runs/42811076184) 和 [prod CI](https://github.com/qwasfun/immich-cf/actions/runs/42811884051) 均通过。
- test 公网检查 50 项，prod 56 项：网页与静态资源、管理员/普通账号登录及权限、具体字段错误、10,000 项限额、JPEG/PNG/HEIC 两种 JPEG 预览、原件 SHA-1、Live Photo 动态原件、官方同步流及 ACK、收藏、相册、回收与恢复。
- 环境隔离检查 12 项：各自 Bearer/Cookie 可读取本账号；另一环境的 Bearer/Cookie 均返回 401，结束后退出会话。
- 仅使用仓库公开图片夹具及已冻结 Git blob 的公开 HEIC/MOV 配对，没有上传私人照片。验收照片、相册及其已授权媒体删除任务全部清理完成，隔离账号停用、会话撤销；审计、退役记录和删除授权按既有规则保留。
- 最终控制面聚合：每环境 30 项迁移、1 个启用的初始管理员、1 个停用的验收账号；资产、相册、会话、上传/复制预约、未完成删除任务/对象均为 0。控制面同时核对资源绑定、活动 Worker 版本、私有桶和 Cron 配置。

首次回归发现 Wrangler 开发 HTTP 代理会在故意中断同步流或大文件边界请求后使后续请求返回 500。只调整测试入口的 HTTP 输入和预期 409 断流处理；超限拒绝、原件配对、无完成标记、ACK/reset 和恢复断言保留。两项定向复测及最终完整本机/CI 检查通过，应用业务代码没有因此改变。

结构化脱敏证据见 [部署与验证记录](contracts/test-prod-deployment.json)。

## 首次登录与后续发布

每环境独立生成初始管理员和随机密码，凭据仅保存在本机 Git 忽略目录 `work/test-prod-initial-access.txt`。网页“账号设置”可修改密码；“账号管理”可创建普通账号。不开放公开注册，不复用 dev 凭据。

后续继续在 dev 开发并验证，再快进 test、prod；显式使用 `pnpm deploy:test`、`pnpm deploy:prod`。本次使用本机已有 Cloudflare OAuth 进行 CLI 发布，没有新增 GitHub deployment secrets；GitHub 的手动发布工作流依赖各环境的 secret 配置。

本次是部署与服务端验收。真实 iPhone Safari、Live Photo 前后台备份/播放/系统相册恢复、真实规模与整库灾备仍按既有阶段要求独立验收，不据此将 P2～P6 所有退出关口改为完成。
