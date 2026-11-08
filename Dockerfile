FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    LDR_HOST=0.0.0.0 \
    LDR_NO_OPEN=1 \
    LDR_DATA_DIR=/data \
    XDG_DATA_HOME=/sauvegardes

VOLUME ["/data", "/sauvegardes"]
EXPOSE 3000

CMD ["node", "server.js"]
