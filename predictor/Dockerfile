FROM python:3.11-slim

WORKDIR /app
COPY server.py /app/server.py
COPY agents/ /app/agents/
COPY store/ /app/store/
COPY llm/ /app/llm/

RUN mkdir -p /app/data/signals

EXPOSE 5001
CMD ["python", "/app/server.py"]
