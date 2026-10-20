# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
# Insurance only: bcrypt ships a linux-x64 musl prebuild, so these are unused
# unless the prebuild is missing for the target platform.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=10000
WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

USER node
EXPOSE 10000

CMD ["node", "server.js"]
