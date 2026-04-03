#!/usr/bin/env bash
# TinyOffice start/stop script
# Usage: ./tinyoffice.sh start|stop|restart|status

PORT="${TINYOFFICE_PORT:-3000}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/.tinyoffice.pid"
LOGFILE="$DIR/.tinyoffice.log"

start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "TinyOffice already running (PID $(cat "$PIDFILE"))"
    return 1
  fi

  echo "Starting TinyOffice on 0.0.0.0:$PORT..."
  cd "$DIR"
  PORT=$PORT npx next start -H 0.0.0.0 -p "$PORT" > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  echo "TinyOffice started (PID $!, port $PORT)"
  echo "Log: $LOGFILE"
}

stop() {
  if [ ! -f "$PIDFILE" ]; then
    echo "No PID file found. Checking for stale processes..."
    pkill -f "next start.*$PORT" 2>/dev/null && echo "Killed stale process" || echo "Nothing running"
    return 0
  fi

  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping TinyOffice (PID $PID)..."
    kill "$PID"
    sleep 2
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
    echo "Stopped."
  else
    echo "Process $PID not running."
  fi
  rm -f "$PIDFILE"
}

status() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "TinyOffice running (PID $(cat "$PIDFILE"), port $PORT)"
  else
    echo "TinyOffice not running"
    rm -f "$PIDFILE" 2>/dev/null
  fi
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  *)       echo "Usage: $0 {start|stop|restart|status}" ;;
esac
