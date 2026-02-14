FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server/dist ./server/dist

ARG BUILD_TIME
ENV NODE_ENV=production
ENV BUILD_TIME=${BUILD_TIME}

CMD ["node", "server/dist/index.js"]
