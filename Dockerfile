FROM node:22-slim

USER root
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
    && python3 -m pip install --break-system-packages --no-cache-dir \
      "git+https://github.com/NousResearch/hermes-agent.git@519657aa98d4969ec9e23c70c074d1982ef3ccf1" \
      "discord.py>=2.4,<3" \
      mcp \
    && rm -rf /var/lib/apt/lists/*

COPY docker-entrypoint.sh /usr/local/bin/nikechan-x-entrypoint
RUN chmod +x /usr/local/bin/nikechan-x-entrypoint

USER node
WORKDIR /profile

ENV HOME=/home/node
ENV HERMES_HOME=/profile

ENTRYPOINT ["nikechan-x-entrypoint"]
CMD ["python3", "-m", "hermes_cli.main", "gateway", "run", "--replace", "--accept-hooks"]
