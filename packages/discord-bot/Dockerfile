FROM node:22-alpine AS deps
WORKDIR /app/packages/discord-bot
COPY packages/shared-types/package.json /app/packages/shared-types/package.json
COPY packages/shared-types/src /app/packages/shared-types/src
COPY packages/shared-types/tsconfig.json /app/packages/shared-types/tsconfig.json
COPY packages/discord-bot/package.json ./
COPY packages/discord-bot/package-lock.json* ./
RUN npm install

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app /app
COPY packages/discord-bot/ /app/packages/discord-bot/
# Build shared-types first using tsc from discord-bot's node_modules
RUN ./packages/discord-bot/node_modules/.bin/tsc -p packages/shared-types/tsconfig.json
RUN cd packages/discord-bot && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/packages/discord-bot/dist ./dist
COPY --from=build /app/packages/discord-bot/node_modules ./node_modules
COPY packages/discord-bot/package.json ./package.json
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
