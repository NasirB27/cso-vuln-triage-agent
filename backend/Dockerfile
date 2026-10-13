# syntax=docker/dockerfile:1
#
# LangGraph backend (ingestion_graph + retrieval_graph) for ECS Fargate.
# Build context is the REPO ROOT (yarn workspaces + root lockfile):
#
#   docker build -f backend/Dockerfile -t cso-backend .
#
# The same image runs three ways; only the command differs:
#   serve    (default)            yarn langgraph:serve
#   migrate  (one-off task)       yarn migrate:pgvector
#   ingest   (scheduled task)     yarn ingest:run
#
# NOTE: "serve" is the LangGraph CLI *dev* server (in-memory state, no
# persistence across restarts). That is fine for a demo/portfolio deployment;
# see infra/README.md for what a production deployment would change.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json yarn.lock ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN yarn install --frozen-lockfile --ignore-scripts

# RDS global CA bundle so the Postgres connection can verify the server cert.
FROM node:20-bookworm-slim AS rds-ca
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL -o /rds-global-bundle.pem \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

FROM node:20-bookworm-slim AS run
WORKDIR /app
ENV PGSSLROOTCERT=/etc/ssl/rds-global-bundle.pem
COPY --from=rds-ca /rds-global-bundle.pem /etc/ssl/rds-global-bundle.pem
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/backend/node_modules ./backend/node_modules
COPY --chown=node:node package.json yarn.lock ./
COPY --chown=node:node backend ./backend

WORKDIR /app/backend
# The LangGraph CLI refuses to start unless the file named by langgraph.json
# ("env": ".env") exists. Real configuration comes from the container
# environment (ECS task definition), so an empty file is correct here.
RUN touch .env && chown node:node .env

USER node
EXPOSE 2024
# /info returns 200 once the server is up (this CLI version has no /ok route).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:2024/info').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["yarn", "langgraph:serve"]
