# Codex 云端开发准备

本配置用于开发、自动化测试和 dry-run 构建，不需要 Cloudflare 账号或部署凭据。

## 环境配置

在 Codex 的 Work in → Cloud → Select environment → Create environment 中选择
`qwasfun/immich-cf`，让环境准备过程使用本次改动同步后的分支。只保存在本机的未提交文件不会通过 GitHub 自动进入云端。

- Node.js：24.19.0（`.node-version`）；允许范围为 24.9.0～24.x。
- pnpm：11.25.0（`package.json` 的 `packageManager`）。
- 系统工具：Git、curl。curl 需要支持 `%{json}` 和 `--max-filesize`；Ubuntu 22.04 及更新发行版提供的版本可用，最终以 curl 回归测试通过为准。
- 网络：安装依赖需要访问 npm 包源；本地测试需要允许回环地址和子进程运行 workerd。无需为本次准备开放 Cloudflare API 或远程 Worker。
- Environment variables / Network secrets：不添加 Cloudflare、GitHub 私钥或远程账户凭据。

向环境准备会话说明上述运行时要求，必要时由其安装对应版本。项目安装入口会检查版本，版本不符时明确失败，不会悄悄使用其他版本。

Install script（在仓库根目录执行）：

```sh
node scripts/cloud-setup.mjs
```

脚本检查 Node.js、pnpm 和 curl，按 lockfile 安装依赖，应用纯本地 D1 迁移并生成类型。可重复运行；不清空现有本地开发数据。

Start skill 的启动说明：

```text
在 immich-cf 仓库根目录运行 pnpm cloud:db:migrate，确保本地迁移为最新。
在持续运行的终端启动 pnpm cloud:dev，等待 Wrangler 报告服务就绪。
请求 http://127.0.0.1:8787/healthz，确认 HTTP 200。
保持服务运行；运行 pnpm cloud:check 并报告检查结果。
仅使用本地 D1/R2，不运行 pnpm dev、远程迁移、部署或线上 probe。
```

这里提供的是可填入环境设置的启动说明，不声明仓库文档会自动配置云端 Start skill。

## 命令与数据边界

| 命令                    | 用途                                                  |
| ----------------------- | ----------------------------------------------------- |
| `pnpm cloud:setup`      | 与 Install script 相同，要求 pnpm 已安装              |
| `pnpm cloud:db:migrate` | 应用本地迁移，可重复运行                              |
| `pnpm cloud:dev`        | 在 127.0.0.1:8787 启动本地 Worker                     |
| `pnpm cloud:check`      | 格式、lint、类型、全部本地测试、云端配置 dry-run 构建 |
| `pnpm cloud:build`      | 输出 `dist/cloud`，不发布                             |

`wrangler.local.json` 使用占位 D1 ID、独立资源名称和 `remote: false`；开发数据库和媒体保存在 `.wrangler/cloud-state`。测试使用既有隔离状态，不复用开发数据库。迁移本身不会创建登录用户；需要手动登录时按 `docs/p1-local-poc.md` 创建测试用户，并把生成的 SQL 仅导入此本地配置。

`work/`、`.wrangler/`、`dist/`、`.dev.vars*`、`.env*` 和 `tests/private-fixtures/` 不纳入 Git。不要上传本机状态、真实照片、账户文件、密码或令牌。自动化测试使用合成数据，不需要真实账户。

Docker 官方参考对比不属于基础环境安装；需要时另行确认容器支持、镜像网络和资源。云端测试不能代替官方 App 真机验收。

## 迁移前现有改动

本次开始时的三个未提交文件组成一个独立的上传诊断变更：

- `scripts/mixed-queue-probe.mjs`：增加可选 `--curl` 上传、脱敏计时指标及进度报告；仍指向远程 dev，不在云端基础检查中执行。
- `scripts/lib/curl-request.mjs`：经标准输入传递 curl 配置，限制超时和响应大小，清理临时文件。
- `tests/curl-probe.test.mjs`：仅连接回环 HTTP 服务，验证上传字节、413、超时、响应截断、响应上限及配置注入拒绝。

上传诊断变更已独立提交为 `d63a3d1`，云端环境准备另行提交，便于审查和回滚。迁移使用 `codex/cloud-environment` 分支，包含当前项目版本和云端准备文件；该分支同时包含此前尚未推送的开发历史。远端 `dev` 分支保持原有状态。

## 云端发布验收

1. 选择包含本次准备文件及所需诊断改动的 Git 分支。
2. 配置运行时与 Install script，安装成功后按启动说明执行。
3. 确认 `/healthz` 为 200，`pnpm cloud:check` 成功，环境中未添加部署凭据。
4. 保存并 Publish 环境，等待 Environment published，再从该环境开始任务。

Windows 本地验证与云端 VM 验证应分别记录。云端安装或 workerd 启动失败时，保留日志并报告实际阻塞，不能将本地通过写成云端通过。

## 本次本地验证记录（2026-10-16）

- Windows、Node.js 24.19.0、pnpm 11.25.0。
- 安装入口成功执行，全部 10 个本地 D1 迁移成功；重复运行未重复应用迁移。
- 在独立空白 Wrangler 配置目录、未提供 Cloudflare API token 的条件下，`pnpm cloud:dev` 启动成功，`GET /healthz` 返回 200 和 `p1-small-images-poc`。
- `pnpm cloud:check` 成功：格式、lint、类型检查、69 项测试全部通过，`dist/cloud` dry-run 构建成功。
- 检查确认本地状态、构建结果、日志和私人素材路径均被 Git 忽略。原有上传诊断的 3 个文件内容保留，其 curl 回归测试包含在 69 项测试中；没有执行线上 probe。
- 受限本地沙箱首次验证时，Wrangler 无法写入用户配置目录；将进程的 `XDG_CONFIG_HOME` 设为仓库下的 `work/cloud-validation-config`、`WRANGLER_LOG_PATH` 设为 `work/wrangler-logs` 后通过。这些仅为本次本地验证设置，不修改系统环境或云端凭据。
- 此处记录的是仓库准备阶段的本地验证，不能代替云端 VM 安装或环境 Publish 的成功证据。云端仍需按前述流程验证。

官方流程：[Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)。
