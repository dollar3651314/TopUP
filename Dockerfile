# web 和 worker 共用一个镜像（启动命令不同）。页面在构建时生成：APP_ENV 决定是生产还是测试环境的页面。
# 构建：docker build --build-arg APP_ENV=staging --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t topup .
FROM node:26-bookworm-slim AS site
ARG APP_ENV=production
ARG SITE_URL=
WORKDIR /app
COPY package.json package-lock.json ./
COPY site/package.json site/package-lock.json ./site/
# 页面和服务器共用 server/pay/ 里的金额、匹配、签名核对代码，两边的依赖都要装
RUN npm ci --no-audit --no-fund && cd site && npm ci --no-audit --no-fund
COPY server ./server
COPY config ./config
COPY site ./site
RUN cd site && APP_ENV=$APP_ENV SITE_URL=$SITE_URL npm run build

FROM node:26-bookworm-slim
ARG APP_ENV=production
ARG GIT_COMMIT=
# 镜像默认按生产运行；NODE_ENV=production 时服务器拒绝以 APP_ENV=local 启动（本地模式有测试用的入口和开发用的主密钥）
ENV NODE_ENV=production APP_ENV=$APP_ENV GIT_COMMIT=$GIT_COMMIT HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server ./server
COPY config ./config
COPY --from=site /app/site/dist ./site/dist
RUN mkdir -p /data/blobs && chown node:node /data/blobs
USER node
EXPOSE 8080
CMD ["node", "server/web.js"]
