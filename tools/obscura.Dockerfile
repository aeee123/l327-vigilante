FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --silent --show-error --location https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.6/obscura-x86_64-linux.tar.gz -o /tmp/obscura.tar.gz \
    && echo "eed986e478c5ec5439f531f2d7fb6b0e36a356f1df7a6c44a8e8fd4f2486bd76  /tmp/obscura.tar.gz" | sha256sum -c - \
    && mkdir /opt/obscura \
    && tar -xzf /tmp/obscura.tar.gz -C /opt/obscura \
    && install -m 755 "$(find /opt/obscura -type f -name obscura -print -quit)" /usr/local/bin/obscura \
    && obscura --version \
    && rm -rf /tmp/obscura.tar.gz /opt/obscura /var/lib/apt/lists/*
WORKDIR /app
COPY tools/obscura-render.mjs .
USER node
CMD ["node", "obscura-render.mjs"]
