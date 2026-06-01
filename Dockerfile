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
      "git+https://github.com/NousResearch/hermes-agent.git@25f43d38de86582f5bc2d5be6843f824eac21634" \
      "discord.py>=2.4,<3" \
      mcp \
    && printf '%s\n' \
      'name: discord' \
      'kind: platform' \
      'version: "1.0.0"' \
      'description: Discord gateway platform adapter' \
      'requires_env:' \
      '  - DISCORD_BOT_TOKEN' \
      > /usr/local/lib/python3.11/dist-packages/plugins/platforms/discord/plugin.yaml \
    && rm -rf /var/lib/apt/lists/*

COPY patches/hermes-agent/cron-error-deliver.py /tmp/cron-error-deliver.py
RUN python3 /tmp/cron-error-deliver.py && rm /tmp/cron-error-deliver.py

COPY docker-entrypoint.sh /usr/local/bin/nikechan-x-entrypoint
RUN chmod +x /usr/local/bin/nikechan-x-entrypoint

USER node
WORKDIR /profile

ENV HOME=/home/node
ENV HERMES_HOME=/profile

ENTRYPOINT ["nikechan-x-entrypoint"]
CMD ["python3", "-m", "hermes_cli.main", "gateway", "run", "--replace", "--accept-hooks"]
