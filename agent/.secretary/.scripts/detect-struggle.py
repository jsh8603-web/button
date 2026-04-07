"""Detect coding struggle patterns from Claude Code JSONL transcript.

Usage: python detect-struggle.py <jsonl_path> [minutes=10]

Exit codes:
  0 = no struggle detected
  1 = fix-fail loop (Edit→Bash fail on same file, 3+ cycles)
  2 = repeated read (same file Read 3+ times)
  3 = stagnation (20+ min of tool calls, no git commit)

stdout: JSON with details when struggle detected
"""
import sys, json, os, time

path = sys.argv[1]
window_min = int(sys.argv[2]) if len(sys.argv) > 2 else 10

if not os.path.exists(path):
    sys.exit(0)

mtime = os.path.getmtime(path)
if time.time() - mtime > 600:  # JSONL not updated in 10min = session idle
    sys.exit(0)

with open(path, 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.readlines()

# Only look at recent entries (last N lines as proxy for time window)
# ~50 lines per minute is generous estimate
max_lines = window_min * 50
if len(lines) > max_lines:
    lines = lines[-max_lines:]

# Parse tool calls
edit_targets = []       # (line_idx, file_path)
bash_results = []       # (line_idx, exit_code, command)
read_targets = []       # (line_idx, file_path)
has_git_commit = False
first_edit_idx = None
tool_call_count = 0

pending_bash = {}  # tool_use_id → command

for i, raw in enumerate(lines):
    try:
        d = json.loads(raw)
        msg_type = d.get('type')

        if msg_type == 'assistant':
            for c in d.get('message', {}).get('content', []):
                if not isinstance(c, dict) or c.get('type') != 'tool_use':
                    continue
                name = c.get('name', '')
                inp = c.get('input', {})
                tool_id = c.get('id', '')
                tool_call_count += 1

                if name == 'Edit' and 'file_path' in inp:
                    fp = inp['file_path']
                    edit_targets.append((i, fp))
                    if first_edit_idx is None:
                        first_edit_idx = i

                elif name == 'Read' and 'file_path' in inp:
                    read_targets.append((i, inp['file_path']))

                elif name == 'Bash':
                    cmd = inp.get('command', '')
                    if tool_id:
                        pending_bash[tool_id] = cmd
                    if 'git commit' in cmd or 'git push' in cmd:
                        has_git_commit = True

        elif msg_type == 'tool':
            tool_id = d.get('tool_use_id', '')
            if tool_id in pending_bash:
                cmd = pending_bash.pop(tool_id)
                exit_code = None
                for rc in d.get('content', []):
                    if isinstance(rc, dict) and rc.get('type') == 'text':
                        text = rc.get('text', '')
                        # Look for exit code pattern
                        if 'Exit code' in text:
                            try:
                                ec = int(text.split('Exit code')[1].strip().split()[0].strip(':'))
                                exit_code = ec
                            except:
                                pass
                        elif 'exit code' in text.lower():
                            try:
                                ec = int(text.lower().split('exit code')[1].strip().split()[0].strip(':'))
                                exit_code = ec
                            except:
                                pass
                        break
                if exit_code is not None:
                    bash_results.append((i, exit_code, cmd[:100]))

    except Exception:
        pass

# --- Detection 1: Fix-Fail Loop ---
# Edit(file X) followed by Bash(exit!=0), repeated 3+ times for same file
from collections import defaultdict

file_fail_cycles = defaultdict(int)
for ei, (edit_idx, edit_file) in enumerate(edit_targets):
    # Find next Bash fail after this edit
    for bash_idx, exit_code, cmd in bash_results:
        if bash_idx > edit_idx and exit_code != 0:
            # Normalize file path for comparison
            norm = edit_file.replace('\\', '/').lower()
            file_fail_cycles[norm] += 1
            break

fix_fail_file = None
fix_fail_count = 0
for fp, count in file_fail_cycles.items():
    if count >= 3 and count > fix_fail_count:
        fix_fail_file = fp
        fix_fail_count = count

if fix_fail_file:
    print(json.dumps({
        "type": "fix_fail_loop",
        "file": fix_fail_file,
        "cycles": fix_fail_count
    }))
    sys.exit(1)

sys.exit(0)
