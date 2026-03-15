#!/bin/bash
# Gracefully exit Claude in a specific btn-* tmux session to deregister remote
# Usage: kill-sessions.sh [session-name]
#   If session-name given: kill only that session
#   If no argument: kill ALL btn-* sessions (backward compat)

if [ -n "$1" ]; then
  sessions="$1"
else
  sessions=$(tmux list-sessions -F '#S' 2>/dev/null | grep '^btn-')
fi
[ -z "$sessions" ] && exit 0

# Send Ctrl+C to interrupt any running command
for s in $sessions; do
  tmux send-keys -t "$s" C-c C-c 2>/dev/null
done
sleep 1

# Send /exit to gracefully close Claude (deregisters remote session)
for s in $sessions; do
  tmux send-keys -t "$s" '/exit' Enter 2>/dev/null
done
sleep 2

# Kill the session(s)
for s in $sessions; do
  tmux kill-session -t "$s" 2>/dev/null
done
