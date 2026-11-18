FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 MIXTOURING_HOST=0.0.0.0 MT_PUBLIC=1
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY AGENTS.md ./
COPY server/index.mjs ./server/
COPY server/lib ./server/lib
COPY mixtouring-hifi ./mixtouring-hifi
RUN mkdir -p server/.state server/logs && chown -R node:node server/.state server/logs
USER node
WORKDIR /app/server
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "index.mjs"]
