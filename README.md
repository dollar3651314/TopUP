# TopUP

稳定币收付款服务（开发中）：商户收款、自动入账和回调、提币、开放 API。

## 本地运行
需要 Node 26。

```bash
npm ci
cd site && npm ci && npm run build && cd ..
npm run dev            # http://127.0.0.1:8080 （本地模式：不需要数据库、Redis 和链上节点）
```

用 Docker 起 Postgres 和 Redis：先 `export POSTGRES_PASSWORD=<自己定的口令>`，再 `docker compose up -d postgres redis`。环境变量见 `.env.example`。

## 测试
```bash
npm test                                   # 单元测试
cd e2e && npm ci && npx playwright test    # 端到端测试（先构建页面）
```

代码结构见 [项目地图](项目地图.md)。
