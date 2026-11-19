# OSMANX R4: Node 22 nonroot, separate API and integration worker.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# R37: optional operator-supplied build provenance hint. This is a self-
# assertion, not cryptographic supply-chain proof.
ARG OSMANX_SOURCE_SHA=""
LABEL org.opencontainers.image.revision="${OSMANX_SOURCE_SHA}" \
      io.osmanx.guest.writes-default="false"
COPY --chown=node:node package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY --chown=node:node src/ ./src/
COPY --chown=node:node shared/ ./shared/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node migrations/ ./migrations/
USER node
EXPOSE 3047
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3047/api/industry/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","src/server.mjs"]
