FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY server.mjs ./

ENV DATA_DIR=/data PORT=8787

# 数据目录（compose 里会被 ./data 卷挂载覆盖，此处保证裸 docker run 也可写）
RUN mkdir -p /data && chown node:node /data

EXPOSE 8787

USER node

CMD ["node", "server.mjs"]
