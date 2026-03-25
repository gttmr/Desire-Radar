FROM node:22-slim AS node-runtime

FROM python:3.11-slim AS runner
WORKDIR /app

ENV PYTHONUNBUFFERED=1
ENV HOME=/home/collector

RUN apt-get update && apt-get install -y --no-install-recommends bash findutils && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/include/node /usr/local/include/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules

RUN mkdir -p /home/collector/.claude \
             /home/collector/.codex \
             /home/collector/.gemini \
             /home/collector/.local/share/claude \
             /usr/local/lib/node_modules/@openai \
             /usr/local/lib/node_modules/@google

RUN printf '#!/bin/sh\nexec "$(find /home/collector/.local/share/claude/versions -maxdepth 1 -type f | head -1)" "$@"\n' \
      > /usr/local/bin/claude \
    && chmod +x /usr/local/bin/claude

RUN printf '#!/bin/sh\nexec node /usr/local/lib/node_modules/@openai/codex/bin/codex.js "$@"\n' \
      > /usr/local/bin/codex \
    && chmod +x /usr/local/bin/codex

RUN printf '#!/bin/sh\nexec node /usr/local/lib/node_modules/@google/gemini-cli/dist/index.js "$@"\n' \
      > /usr/local/bin/gemini \
    && chmod +x /usr/local/bin/gemini

COPY pyproject.toml ./
COPY src/ ./src/
RUN pip install --no-cache-dir .

EXPOSE 5002
CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "5002"]
