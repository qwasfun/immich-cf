# 固定版本参考环境

本环境仅供 immich-cf 协议对比，Compose 项目名 `immich-cf-reference`。服务器只监听 `127.0.0.1:22830`；数据库、Redis 不开放宿主机端口。服务器及依赖镜像均固定摘要，来源为冻结 v3.3.1 的官方 Compose 与项目 compatibility-manifest。

启动前先启动本机 Docker Linux 引擎：

```sh
pnpm reference:up
pnpm reference:compare
pnpm reference:down
```

首次 up 在忽略目录 `work/reference.env` 生成随机数据库密码，不覆盖现有文件。镜像首次下载可能较慢；up 会等待容器健康（启动阶段最多 180 秒）再返回；下载时间不计入此等待窗口。down 仅停止并移除本项目容器和网络，保留数据库与媒体卷以便复现，不影响其它 Docker 项目。数据库卷存在时应保留 reference.env 和 reference-admin.json；不要仅删除凭据文件。

对比脚本固定访问本机参考地址，不接受公网目标。必须返回 3.3.1 才继续；在独立参考库创建合成普通用户（初次创建合成管理员），在全新本地 D1/R2 状态中创建对应用户。全部凭据随机产生且不进入报告。新会话在正常或测试失败退出路径注销，本地 Worker 停止。合成用户记录保留在参考数据库；每次运行生成新用户，避免复用前次检查点。

输出：`work/reference-comparison.json`。字段结构对比将敏感值与动态值替换成类型，只对版本、能力、默认偏好和 onboarding 等白名单项目保留原值。`equal` 表示本用例所选投影相等，不等于整个 API 契约相等；该脚本不自动把差异改成兼容行为，也不以差异为零作为退出条件。登录、版本、首轮 Sync/ACK 等基础断言失败会失败退出。

参考环境未运行 machine-learning 服务；本轮只覆盖空图库身份与同步，不测试识别、上传转码、视频或媒体显示。它不连接 Cloudflare dev 资源。源代码许可见 `docs/contracts/upstream/LICENSE.immich`，官方镜像地址和配置来源须保留。
