# syntax=docker/dockerfile:1
#
# Next.js frontend for ECS Fargate (standalone server).
# Build context is the REPO ROOT (yarn workspaces + root lockfile):
#
#   docker build -f frontend/Dockerfile -t cso-frontend \
#     --build-arg NEXT_PUBLIC_LANGGRAPH_API_URL=http://backend.cso.internal:2024 .
#
# NEXT_PUBLIC_* values are inlined at BUILD time, so the backend URL is a build
# arg. It must match the private DNS name the backend gets in the VPC
# (Cloud Map namespace "cso.internal", service "backend" -- see infra/terraform).

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json yarn.lock ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN yarn install --frozen-lockfile --ignore-scripts

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
COPY package.json yarn.lock ./
COPY frontend ./frontend

ARG NEXT_PUBLIC_LANGGRAPH_API_URL=http://backend.cso.internal:2024
ENV NEXT_PUBLIC_LANGGRAPH_API_URL=$NEXT_PUBLIC_LANGGRAPH_API_URL \
    NEXT_TELEMETRY_DISABLED=1

# The server-side LangGraph client throws at import time if LANGCHAIN_API_KEY is
# unset, which would fail "Collecting page data". This placeholder exists for
# the build step only; the real key is injected at runtime and, not being
# NEXT_PUBLIC_, is never inlined into the bundle.
RUN LANGCHAIN_API_KEY=build-placeholder yarn --cwd frontend build

FROM node:20-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Layout matches `next build` with outputFileTracingRoot at the repo root:
# the server lives at frontend/server.js inside the standalone folder.
COPY --from=build --chown=node:node /app/frontend/.next/standalone ./
COPY --from=build --chown=node:node /app/frontend/.next/static ./frontend/.next/static
COPY --from=build --chown=node:node /app/frontend/public ./frontend/public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "frontend/server.js"]
