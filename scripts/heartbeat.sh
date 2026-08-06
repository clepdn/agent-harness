#!/bin/bash
CONF="${NANO_HEARTBEAT_CONF:-/home/regent/Developer/nano/home/heartbeat.conf}"
SERVER="${NANO_SERVER_URL:-http://localhost:3000}"
AGENT="${NANO_AGENT_ID:-nano}"
TRIGGER="${SERVER%/}/agents/${AGENT}/trigger/cron"

INTERVAL=$(cat "$CONF" 2>/dev/null | grep -oE '^[0-9]+$' | head -1)
INTERVAL=${INTERVAL:-15}

curl -sf -X POST "$TRIGGER" >/dev/null 2>&1

sleep "${INTERVAL}m"
