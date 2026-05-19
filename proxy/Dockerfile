# dial-usage-proxy
# Node + SSH-Client. ccusage wird NICHT hier ausgefuehrt, sondern per SSH
# remote auf dem Mac (dort liegen die ~/.claude-Logs).
FROM node:22-slim

# tini  -> sauberes Signal-Handling (ssh startet Subprozesse)
# openssh-client -> fuer die Remote-Ausfuehrung von ccusage auf dem Mac
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server.js ./

EXPOSE 8088

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
