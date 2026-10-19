#!/usr/bin/env bash
# PID 1 of the computer. Brings up the desktop in order (Xvfb, dbus + portals,
# fluxbox, control server, optional VNC) and forwards SIGTERM/SIGINT so
# `docker stop` returns in well under its 10 s grace period. The control server
# owns Chromium and ffmpeg and stops them itself (ffmpeg with SIGINT, so the
# recording is finalised).
set -uo pipefail

W="${SCREEN_WIDTH:-1920}"
H="${SCREEN_HEIGHT:-1080}"
LOGS=/tmp/computer-logs
mkdir -p "$LOGS"
PIDS=()
CONTROL_PID=""

shutdown() {
	trap - TERM INT
	if [ -n "$CONTROL_PID" ]; then
		kill -TERM "$CONTROL_PID" 2>/dev/null
		# Up to ~2.5 s for the control server to finalise a recording.
		for _ in $(seq 1 25); do kill -0 "$CONTROL_PID" 2>/dev/null || break; sleep 0.1; done
	fi
	for p in "${PIDS[@]}"; do kill -TERM "$p" 2>/dev/null; done
	sleep 0.2
	for p in "${PIDS[@]}" $CONTROL_PID; do kill -KILL "$p" 2>/dev/null; done
	exit 0
}
trap shutdown TERM INT

Xvfb :1 -screen 0 "${W}x${H}x24" -nolisten tcp -ac >"$LOGS/xvfb.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 100); do xdpyinfo -display :1 >/dev/null 2>&1 && break; sleep 0.05; done
xdpyinfo -display :1 >/dev/null 2>&1 || { echo "Xvfb did not start"; cat "$LOGS/xvfb.log"; exit 1; }

# A session bus and the desktop portals; without them Chromium file uploads do nothing.
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
PIDS+=("$DBUS_SESSION_BUS_PID")
/usr/libexec/xdg-desktop-portal >"$LOGS/portal.log" 2>&1 & PIDS+=($!)
/usr/libexec/xdg-desktop-portal-gtk >"$LOGS/portal-gtk.log" 2>&1 & PIDS+=($!)

fluxbox >"$LOGS/fluxbox.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 50); do wmctrl -m >/dev/null 2>&1 && break; sleep 0.05; done
fbsetroot -solid '#15171c' 2>/dev/null || true

node /opt/control/control.mjs >"$LOGS/control.log" 2>&1 & CONTROL_PID=$!

if [ "${ENABLE_VNC:-0}" = 1 ]; then
	x11vnc -display :1 -viewonly -shared -forever -nopw -localhost -rfbport 5900 -quiet >"$LOGS/vnc.log" 2>&1 & PIDS+=($!)
	websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >"$LOGS/novnc.log" 2>&1 & PIDS+=($!)
fi

echo "computer ready: display :1 ${W}x${H}, control on :${CONTROL_PORT:-7070}"
# `wait` returns early when a trapped signal arrives, then the trap runs.
while kill -0 "$CONTROL_PID" 2>/dev/null; do wait "$CONTROL_PID"; done
echo "control server exited"; tail -20 "$LOGS/control.log"
shutdown
