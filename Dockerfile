FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/ ./dist/
COPY README.md LICENSE ./

# Read-only by default. Write tools are not registered with the assistant at
# all unless PBX_MCP_ALLOW_WRITE is explicitly set to true.
USER node

# The server speaks MCP over stdio, so there is no port to expose.
ENTRYPOINT ["node", "dist/index.js"]
