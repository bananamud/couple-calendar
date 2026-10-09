FROM node:22-alpine

WORKDIR /app

# 零依赖：只需要源码，不需要 npm install
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY tools ./tools
COPY data/raw ./data/raw

ENV PORT=5178
ENV DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 5178

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:5178/api/health || exit 1

CMD ["node", "server.js"]
