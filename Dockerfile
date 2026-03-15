FROM localstack/localstack:latest AS localstack-cache

FROM docker:cli AS docker-cli

FROM node:24-slim

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx cdk synth --quiet

ENTRYPOINT ["bash", "run.sh"]
