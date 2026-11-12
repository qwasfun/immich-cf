# 生产自定义域名

2026-11-12（Asia/Shanghai）。生产增加 **https://immich.185036.xyz**，网页和官方 App 的服务器根地址均可使用此地址，不需要加 `/api`。新域名使用原生产账号与图库，浏览器首次访问需重新登录；Cookie 按主机隔离。原 `https://immich-cf-api.fun.workers.dev` 继续可用。

## 绑定与维护

通过 Cloudflare Workers Custom Domain 将 `immich.185036.xyz` 绑定到现有生产 Worker `immich-cf-api`，覆盖该主机的所有路径。绑定前核对域名区域处于 active，目标主机没有 DNS 或其他 Worker 绑定冲突；绑定后确认 Cloudflare 生成代理 AAAA 记录、独立 Advanced 证书处于 active，实际 HTTPS 证书校验通过。[DNS 和证书由 Cloudflare 自动管理](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

`wrangler.json` 仅在 `env.prod.routes` 添加 `{pattern:"immich.185036.xyz",custom_domain:true}`，以便后续生产发布保留绑定。配置先在 dev 维护，再快进同步到 test/prod；dev/test 的 Worker 不接收此域名流量。现有 `workers_dev: true` 保留原生产地址。

本次通过域名 API 绑定现有 Worker，没有重新发布运行代码或应用数据库迁移。生产仍以 100% 流量使用 Worker 版本 `5359af04-c4e8-455e-9f0e-4dc762c97e96`，38 项迁移保持。账号、媒体及资源绑定继续使用原生产环境。

## 验证

- 既有环境隔离测试 1 项通过，契约校验 279 个操作、53 项来源一致，生产配置 dry-run 通过；差异核对确认仅增加生产域名路由。
- 35 项公网检查通过：新域名健康/发现/版本接口、登录页和照片/相册/地图/回忆/分享深链接、指纹资源，与原地址的页面和静态资源 SHA-256 一致。
- 原生产账号可在新域名登录，Cookie 会话和原地址 Bearer 读取返回同一账号及相同用量；当前 Origin 的表单请求到达具体字段校验，外部 Origin 返回 403。匿名私有接口及 dev/test 上的生产凭据均返回 401。
- 临时验收会话已退出，两地址均拒绝已退出的会话；未上传、修改或删除照片、相册及原账号密码。真实手机和官方 App 真机未重新验收。

脱敏证据见[域名验证记录](contracts/prod-custom-domain-2026-11-12.json)。本次配置和记录保留在本地 Git，未推送 GitHub。
