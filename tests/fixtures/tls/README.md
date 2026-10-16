# 本地 TLS 拒绝测试素材

localhost-cert.pem 与 localhost-key.pem 是专为回归生成、公开入库的自签证书和配套测试密钥，不对应任何部署、账户或真实服务。测试不会把证书导入信任库，预期 curl 拒绝该证书。

该素材用于验证显式 TLS 策略仍保留证书验证，以及 TLS1.2-only 不会连接仅 TLS1.3 的服务。生成工具为本机 Git OpenSSL，RSA 2048，SAN localhost / 127.0.0.1。运行测试不依赖 OpenSSL 命令，仅依赖 Node.js HTTPS 与 curl。
