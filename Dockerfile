# ============================================
# comic-crawler Docker 镜像
# 构建: Node 依赖安装 + 前端编译
# 运行: 使用系统 Chromium 供 Puppeteer 调用
# ============================================

FROM node:22 AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    libcups2 libdbus-1-3 \
    libvips42 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

EXPOSE 8619

CMD ["node", "src/server.js"]
