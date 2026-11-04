# qlaude sandbox: the agent can only touch /work (your project, mounted at run
# time). The model stays on the Mac; the container reaches Ollama over HTTP.
FROM node:26-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep curl make ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Go toolchain, for Go projects.
ARG GO_VERSION=1.27.3
RUN curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-$(dpkg --print-architecture).tar.gz" | tar -C /usr/local -xz

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@12.9.1 && pnpm install --frozen-lockfile --config.strict-dep-builds=false
COPY src ./src
COPY roles ./roles

ENV PATH=/usr/local/go/bin:$PATH \
    QLAUDE_SANDBOX=1 \
    OLLAMA_URL=http://host.docker.internal:11434/v1 \
    HOME=/tmp

WORKDIR /work
ENTRYPOINT ["/app/node_modules/.bin/tsx", "/app/src/main.ts"]
