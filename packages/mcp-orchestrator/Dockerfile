FROM node:22-alpine AS deps
WORKDIR /app
COPY packages/shared-types ./packages/shared-types
COPY packages/mcp-orchestrator/package.json packages/mcp-orchestrator/package-lock.json* ./packages/mcp-orchestrator/
RUN cd packages/mcp-orchestrator && npm install

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/packages ./packages
COPY packages/mcp-orchestrator ./packages/mcp-orchestrator
RUN cd packages/mcp-orchestrator && npm run build

# ---------------------------------------------------------------------------
# Runner — Debian slim for glibc (Claude CLI is a native glibc binary)
# ---------------------------------------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOME=/home/node
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV SSL_CERT_DIR=/etc/ssl/certs
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Ensure home subdirectories exist for volume mounts
RUN mkdir -p /home/node/.claude \
             /home/node/.codex \
             /home/node/.gemini \
             /home/node/.local/share/claude \
             /home/node/.local/bin \
    && chown -R node:node /home/node

# CLI symlinks — point to mounted host binaries
# Claude: native binary mounted at /home/node/.local/share/claude/versions/<ver>
RUN printf '#!/bin/sh\nexec "$(find /home/node/.local/share/claude/versions -maxdepth 1 -type f | head -1)" "$@"\n' \
      > /usr/local/bin/claude \
    && chmod +x /usr/local/bin/claude

# Codex: npm package mounted at /usr/local/lib/node_modules/@openai/codex
RUN printf '#!/bin/sh\nexec node /usr/local/lib/node_modules/@openai/codex/bin/codex.js "$@"\n' \
      > /usr/local/bin/codex \
    && chmod +x /usr/local/bin/codex

# Gemini: npm package mounted at /usr/local/lib/node_modules/@google/gemini-cli
RUN printf '#!/bin/sh\nexec node /usr/local/lib/node_modules/@google/gemini-cli/dist/index.js "$@"\n' \
      > /usr/local/bin/gemini \
    && chmod +x /usr/local/bin/gemini

# Copy built application
COPY --from=build /app/packages/mcp-orchestrator/dist ./dist
COPY --from=build /app/packages/mcp-orchestrator/node_modules ./node_modules
COPY --from=build /app/packages/mcp-orchestrator/src/agents ./dist/mcp-orchestrator/src/agents
COPY --from=build /app/packages/mcp-orchestrator/src/agents ./src/agents
COPY packages/mcp-orchestrator/policy ./policy
COPY packages/mcp-orchestrator/package.json ./package.json

# Run as node user so $HOME resolves to /home/node
USER node

EXPOSE 5003
CMD ["node", "dist/mcp-orchestrator/src/index.js"]
