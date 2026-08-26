FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        libgtk-3-0 \
        libnotify4 \
        libnss3 \
        libsecret-1-0 \
        libxss1 \
        libxtst6 \
        python3-gi \
        tmux \
        xdotool \
        xterm \
    && rm -rf /var/lib/apt/lists/*
