# 开发环境部署记录

最新更新（2026-10-14）：dev CPU 预算探针与调用日志配置已发布，Worker 版本 `66756bfb-184b-462f-886b-8556abbc2d94`，数据库保持 0008。实测显示当前密码校验超过 Free CPU 预算，详见 [预算证据与决策](p2-budget-probe.md)。下文保留历史记录。

2026-10-14 已通过 cloudflare-api 开启 P1 dev 入口；最新部署与验证见[三环境说明](environments.md)。下文为首次骨架部署的历史记录。

首次部署日期：2026-10-13（Asia/Shanghai）。

## 部署方式与范围

用户最初指定 cloudflare-api，但该 MCP 连接未加载到当前会话；经用户选择，改用 Wrangler 调用 Cloudflare API。OAuth 登录已恢复。仅创建和部署 dev 资源，生产、staging 和账户中其他项目未作更改。

当前部署为初始骨架：没有登录、上传或 Sync V2 实现，不能作为实际照片备份服务使用。

## 资源

| 类型           | 名称 / 标识                                         |
| -------------- | --------------------------------------------------- |
| Worker         | `immich-cf-api-dev`                                 |
| 访问地址       | <https://immich-cf-api-dev.fun.workers.dev>         |
| 健康检查       | <https://immich-cf-api-dev.fun.workers.dev/healthz> |
| Worker 版本 ID | `444c59f0-36ff-43af-a9a0-53e9d989dc7f`              |
| D1             | `immich-cf-db-dev`                                  |
| D1 ID          | `a8754a88-bb89-4d30-af2a-e19a793b253e`              |
| D1 创建区域    | APAC                                                |
| D1 Binding     | `IMMICH_CF_DB`                                      |
| R2             | `immich-cf-media-dev`，Standard                     |
| R2 Binding     | `IMMICH_CF_MEDIA`                                   |
| 环境变量       | `APP_ENV=development`、`APP_VERSION=0.1.0`          |

## 已验证结果

- `pnpm check`：格式、静态检查、类型检查、4 项本地运行时/存储测试、dry-run 构建均通过。
- 远程 D1 迁移 `0001_project_metadata.sql` 已应用；实际查询返回 `project_name=immich-cf`。
- Worker 发布成功，部署输出确认 D1/R2 绑定及环境变量。
- 公网 `GET /healthz` 返回 200，响应为 `{"service":"immich-cf","status":"ok","version":"0.1.0","stage":"scaffold"}`，缓存策略为 `no-store`。
- 公网 `POST /api/assets` 返回 501 和明确的未实现消息，不产生伪上传成功。
- R2 的 `r2.dev` 公开访问为 disabled。未上传任何真实照片。

本次没有进行远程 R2 对象读写测试，也没有进行官方 App、Free CPU 上限或完整 Sync 验收；本地测试通过不替代这些后续阶段验证。

## 再次发布

```sh
pnpm exec wrangler whoami
pnpm check
pnpm db:migrate:dev
pnpm deploy:dev
```

发布后复查 `/healthz`、迁移状态及新的版本 ID。所有命令均以配置中的 dev 资源为目标，不重复创建同名资源。登录失效时运行 `pnpm exec wrangler login` 并在官方页面完成授权；令牌留在 Wrangler 用户配置中，不提交到仓库。
