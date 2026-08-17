# Phorma Agent Studio - AWS host container image.
#
# The build context is the REPOSITORY ROOT, not cloud-aws/, because the image needs both
# cloud-aws/ and engine/: the engine is consumed as source through the tsconfig path alias
# and is never installed as a published package. That is what the esbuild
# --alias:@phorma/engine flag resolves.
#
# Requirements: 4.3, 13.4

FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY cloud-aws/package.json cloud-aws/package-lock.json cloud-aws/tsconfig.json ./cloud-aws/
COPY engine ./engine
RUN cd cloud-aws && npm ci
COPY cloud-aws/src ./cloud-aws/src
RUN cd cloud-aws && npx esbuild src/server/index.ts \
      --bundle --platform=node --target=node22 --format=esm \
      --alias:@phorma/engine=../engine/src/index.ts \
      --outfile=/build/dist/server.mjs

FROM node:22-bookworm-slim AS runtime
# curl is the binary the Fargate container health check invokes:
# curl -f http://localhost:8080/health || exit 1
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /build/dist/server.mjs ./server.mjs
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
