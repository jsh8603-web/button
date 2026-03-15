#!/bin/bash
# Gracefully exit Claude in btn-* tmux sessions to deregister remote sessions

# Send Ctrl+C to interrupt any running command
for s in $(tmux list-sessions -F '#S' 2>/dev/null | grep '^btn-'); do
  tmux send-keys -t "$s" C-c C-c 2>/dev/null
done
sleep 1

# Send /exit to gracefully close Claude (deregisters remote session)
for s in $(tmux list-sessions -F '#S' 2>/dev/null | grep '^btn-'); do
  tmux send-keys -t "$s" '/exit' Enter 2>/dev/null
done
sleep 2

# Kill only btn-* sessions (not the entire tmux server)
for s in $(tmux list-sessions -F '#S' 2>/dev/null | grep '^btn-'); do
  tmux kill-session -t "$s" 2>/dev/null
done
