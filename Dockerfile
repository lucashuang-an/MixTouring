# Dockerfile · 通用部署镜像（Zeabur / Fly.io / 港服 VPS / 任何容器平台）
# 构建：docker build -t mixtouring .
# 运行：docker run -p 3000:3000 -e LLM_API_KEY=... mixtouring
# 数据：pipeline/data/（plans.json + wishlist.json）打进镜像；持久化用 -v 挂载该目录
FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用层缓存）
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

# 服务 + 数据管道 + 前端静态页（index.mjs 以 /app 为根找 mixtouring-hifi 与 pipeline/data）
COPY server ./server
COPY pipeline ./pipeline
COPY mixtouring-hifi ./mixtouring-hifi

WORKDIR /app/server
ENV PORT=3000
EXPOSE 3000
CMD ["node", "index.mjs"]
