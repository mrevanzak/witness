# The "computer": one throwaway Linux desktop per verification run.
# Xvfb :1 -> fluxbox -> Chromium (CDP on 127.0.0.1:9222), recorded with ffmpeg,
# driven through the control server on :7070.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
	DISPLAY=:1 \
	SCREEN_WIDTH=1920 \
	SCREEN_HEIGHT=1080 \
	COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
	PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN apt-get update && apt-get install -y --no-install-recommends \
		xvfb fluxbox chromium xdotool wmctrl x11-utils imagemagick ffmpeg \
		x11vnc novnc websockify dbus-x11 xdg-desktop-portal xdg-desktop-portal-gtk \
		git curl jq ca-certificates procps python3 python3-venv \
		fonts-liberation fonts-noto-color-emoji fonts-dejavu-core \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.8.0 /uv /uvx /usr/local/bin/

# The base image's uid 1000 user becomes `qa`.
RUN groupmod -n qa node && usermod -l qa -d /home/qa -m node \
	&& mkdir -p /artifacts /home/qa/app && chown -R qa:qa /artifacts /home/qa \
	&& corepack enable

COPY control/package.json control/package-lock.json /opt/control/
RUN cd /opt/control && npm ci --omit=dev && npm cache clean --force
COPY control/ /opt/control/
COPY start.sh /usr/local/bin/start.sh
COPY fluxbox/ /home/qa/.fluxbox/
# Scripts may be checked out with CRLF on Windows hosts; shebangs need LF.
RUN sed -i 's/\r$//' /usr/local/bin/start.sh /opt/control/*.mjs /home/qa/.fluxbox/* \
	&& chmod +x /usr/local/bin/start.sh && chown -R qa:qa /home/qa/.fluxbox

USER qa
WORKDIR /home/qa
EXPOSE 7070
ENTRYPOINT ["/usr/local/bin/start.sh"]
