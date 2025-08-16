# syntax=docker/dockerfile:1
FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /usr/src/app

# Không tải Chromium lúc npm ci vì image đã có sẵn
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    TZ=Asia/Bangkok

# Cài deps trước để tối ưu cache
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source
COPY . .

# Thư mục output / logs có quyền cho user không root
RUN mkdir -p downloads logs

# Chạy dưới user pptruser (an toàn hơn root)

# App của bạn đang dùng 8080 (đổi nếu khác)
EXPOSE 3000

# Start
CMD ["node", "app.js"]
