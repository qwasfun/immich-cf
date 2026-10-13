# 开发与环境说明

当前环境策略以[三环境开发与发布](environments.md)为准：dev 已开启，test/prod 逐级晋升。

## 目录

```text
src/index.ts                    Worker 入口与基础路由
src/http/                       HTTP 响应工具；未来协议适配层在此扩展
migrations/                     D1 迁移（使用 Wrangler 管理应用历史）
tests/                          本地运行时和存储集成检查
docs/                           开发说明与阶段清单
outputs/immich-cf-完整需求文档.md  已交付需求基线
wrangler.json                   生产、dev、test 配置
```

核心业务表要在 P0 API/Sync 契约冻结后引入。初始迁移只保存项目名称，避免提前固化未经验证的用户/资产/游标设计。

## 常用命令

| 命令                    | 用途                                       |
| ----------------------- | ------------------------------------------ |
| `pnpm dev`              | 本地运行代码，连接远程 dev 绑定            |
| `pnpm db:migrate:local` | 将迁移应用到 dev 本地数据库                |
| `pnpm types`            | 由 Wrangler 配置生成运行时与 Env 类型      |
| `pnpm format`           | 格式化代码和开发文档；保留需求文档现有排版 |
| `pnpm check`            | 执行完整基础检查                           |
| `pnpm build`            | dry-run 打包到 dist，不部署                |

远程开发环境命令：`pnpm db:migrate:dev` 应用开发库迁移；`pnpm deploy:dev` 发布开发 Worker。两条命令均显式指定 dev，执行前需要有效的 Wrangler 登录。

`pnpm check` 中的 TypeScript 类型检查会自动生成 `worker-configuration.d.ts`。该文件随工具链重新生成，不提交。pnpm 仅允许 esbuild/workerd 的安装构建脚本，依赖版本及 lockfile 均固定。

本地运行时检查不代表 Cloudflare Free CPU/请求预算已通过，也不代表官方 App 已兼容。完整质量矩阵以需求文档为准。

## 远程资源配置

`wrangler.json` 顶层是生产；dev/test 显式声明各自绑定与变量，避免误用生产存储。dev 已配置真实账户和 D1 ID；生产与 test 的 D1 ID 仍为末尾 000、002 的占位值，远程部署前必须替换。R2 桶保持私有。`pnpm dev` 使用 dev 远程资源；`pnpm dev:local` 才通过 `--local` 使用模拟资源；ID 变更后请重新执行本地迁移。

正式进入远程 PoC 时，按选定环境逐项创建 D1/R2、记录真实资源 ID、替换配置，再应用该环境迁移并部署。开发用 `--env dev`，验收用 `--env test`；生产使用顶层配置（`--env` 的值为空字符串）。不要在未指定环境时进行试验性远程操作。

开发环境已于 2026-10-13 首次部署，详见[部署记录](deployment-dev.md)。生产和 test 尚未部署。Cloudflare 免费用量与同账户其他项目共享，R2 超额可能计费；上线条件见需求文档第 4、13 节。

## 配置与秘密

当前骨架不需要密钥。后续本地秘密使用 `.dev.vars.dev`；远程秘密使用 Cloudflare secret 管理。`.dev.vars*`、`.env*`、本地数据库、日志、私人测试素材均被 Git 忽略。

提交前运行检查并审查 Git diff。接口字段校验必须返回字段名、原因和修正要求，禁止回显密码、令牌或私密联系方式。尚未实现官方错误适配前，不将项目基础错误格式声称为 Immich 契约。

## 官方参考

- [Wrangler 环境与不可继承配置](https://developers.cloudflare.com/workers/wrangler/environments/)
- [本地开发与绑定](https://developers.cloudflare.com/workers/local-development/)
- [Wrangler 测试 API](https://developers.cloudflare.com/workers/wrangler/api/)

初始化核实日期：2026-10-13。项目使用固定 Wrangler/TypeScript 版本；升级时重新检查类型生成、运行时测试及构建。
