# qlaude sandbox: the agent can only touch /work (your project, mounted at run
# time). The model stays on the Mac; the container reaches Ollama over HTTP.
FROM node:26-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@12.9.1 && pnpm install --frozen-lockfile --config.strict-dep-builds=false
COPY src ./src
COPY roles ./roles

ENV QLAUDE_SANDBOX=1 \
    OLLAMA_URL=http://host.docker.internal:11434/v1 \
    HOME=/tmp

WORKDIR /work
ENTRYPOINT ["/app/node_modules/.bin/tsx", "/app/src/main.ts"]
