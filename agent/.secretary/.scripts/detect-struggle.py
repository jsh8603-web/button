"""Detect struggle and error patterns from Claude Code JSONL transcript.

Usage: python detect-struggle.py <jsonl_path> [minutes=10]

Exit codes — Struggle (action: 2-stage nudge):
  1 = fix-fail loop: Edit(X) → [any tool] → Edit(X), 3+ cycles on same file
  2 = bash retry: same Bash command 3+ times without Edit in between

Exit codes — Error (action: existing error process):
  10 = bash failure: Bash exit code != 0
  11 = edit failure: Edit tool error (not unique / not found)
  12 = consecutive tool errors: 3+ tool errors in a row

  0 = nothing detected

stdout: JSON with details when detected
"""
import sys, json, os, time
from collections import defaultdict

path = sys.argv[1]
window_min = int(sys.argv[2]) if len(sys.argv) > 2 else 10

if not os.path.exists(path):
    sys.exit(0)

mtime = os.path.getmtime(path)
if time.time() - mtime > 600:  # JSONL not updated in 10min = session idle
    sys.exit(0)

with open(path, 'r', encoding='utf-8', errors='ignore') as f:
    lines = f.readlines()

max_lines = window_min * 50
if len(lines) > max_lines:
    lines = lines[-max_lines:]

# --- Parse tool calls and results ---

# Tool calls (from assistant messages)
tool_calls = []  # (line_idx, name, input, tool_id)
# Tool results (from tool messages)
tool_results = {}  # tool_use_id → (line_idx, is_error, text)

pending_tools = {}  # tool_id → (name, input)

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
                tool_calls.append((i, name, inp, tool_id))
                if tool_id:
                    pending_tools[tool_id] = (name, inp)

        elif msg_type == 'tool':
            tool_id = d.get('tool_use_id', '')
            is_error = d.get('is_error', False)
            text = ''
            for rc in d.get('content', []):
                if isinstance(rc, dict) and rc.get('type') == 'text':
                    text = rc.get('text', '')
                    break
                elif isinstance(rc, str):
                    text = rc
                    break
            tool_results[tool_id] = (i, is_error, text)

    except Exception:
        pass

# --- Helper: normalize file path ---
def norm_path(fp):
    return fp.replace('\\', '/').lower()

# --- Helper: check bash exit code from result text ---
def get_bash_exit_code(text):
    for marker in ['Exit code ', 'exit code ']:
        if marker in text:
            try:
                rest = text.split(marker)[1].strip()
                return int(rest.split()[0].strip(':').strip())
            except:
                pass
    return None

# === STRUGGLE DETECTION ===

# --- Struggle 1: Edit(X) → [any tool] → Edit(X), 3+ cycles ---
edit_sequence = []  # (line_idx, normalized_file_path)
for idx, name, inp, tid in tool_calls:
    if name == 'Edit' and 'file_path' in inp:
        edit_sequence.append((idx, norm_path(inp['file_path'])))

file_revisit = defaultdict(int)
seen_other_tool = {}  # file → has another tool between edits
last_edit_file = {}   # file → last edit line_idx

for idx, fp in edit_sequence:
    if fp in last_edit_file:
        # Check if there was any non-Edit tool call between the two edits
        prev_idx = last_edit_file[fp]
        has_gap = any(
            ci > prev_idx and ci < idx and cn != 'Edit'
            for ci, cn, _, _ in tool_calls
        )
        if has_gap:
            file_revisit[fp] += 1
    last_edit_file[fp] = idx

# Count includes the initial edit, so revisit count + 1 = total edits
best_struggle_file = None
best_struggle_count = 0
for fp, count in file_revisit.items():
    if count >= 3 and count > best_struggle_count:
        best_struggle_file = fp
        best_struggle_count = count

if best_struggle_file:
    print(json.dumps({
        "type": "fix_fail_loop",
        "file": best_struggle_file,
        "cycles": best_struggle_count
    }))
    sys.exit(1)

# --- Struggle 2: Same Bash command 3+ times without Edit in between ---
bash_commands = []  # (line_idx, command_normalized)
for idx, name, inp, tid in tool_calls:
    if name == 'Bash':
        cmd = inp.get('command', '').strip()
        bash_commands.append((idx, cmd))

consecutive_same = 1
prev_cmd = None
prev_bash_idx = None
best_retry_cmd = None
best_retry_count = 0

for idx, cmd in bash_commands:
    if prev_cmd is not None and cmd == prev_cmd:
        # Check no Edit between prev_bash_idx and idx
        has_edit = any(
            ci > prev_bash_idx and ci < idx and cn == 'Edit'
            for ci, cn, _, _ in tool_calls
        )
        if not has_edit:
            consecutive_same += 1
            if consecutive_same >= 3 and consecutive_same > best_retry_count:
                best_retry_cmd = cmd
                best_retry_count = consecutive_same
        else:
            consecutive_same = 1
    else:
        consecutive_same = 1
    prev_cmd = cmd
    prev_bash_idx = idx

if best_retry_cmd:
    print(json.dumps({
        "type": "bash_retry",
        "command": best_retry_cmd[:120],
        "count": best_retry_count
    }))
    sys.exit(2)

# === ERROR DETECTION ===

# --- Error 1: Bash failure (exit code != 0) ---
recent_bash_failures = []
for idx, name, inp, tid in tool_calls:
    if name == 'Bash' and tid in tool_results:
        res_idx, is_error, text = tool_results[tid]
        ec = get_bash_exit_code(text)
        if ec is not None and ec != 0:
            cmd = inp.get('command', '')[:120]
            recent_bash_failures.append({
                "command": cmd,
                "exit_code": ec,
                "error": text[:200]
            })

if recent_bash_failures:
    latest = recent_bash_failures[-1]
    print(json.dumps({
        "type": "bash_failure",
        "command": latest["command"],
        "exit_code": latest["exit_code"],
        "error": latest["error"]
    }))
    sys.exit(10)

# --- Error 2: Edit failure ---
recent_edit_failures = []
for idx, name, inp, tid in tool_calls:
    if name == 'Edit' and tid in tool_results:
        res_idx, is_error, text = tool_results[tid]
        if is_error or 'not unique' in text.lower() or 'not found' in text.lower():
            fp = inp.get('file_path', '?')
            recent_edit_failures.append({
                "file": fp,
                "error": text[:200]
            })

if recent_edit_failures:
    latest = recent_edit_failures[-1]
    print(json.dumps({
        "type": "edit_failure",
        "file": latest["file"],
        "error": latest["error"]
    }))
    sys.exit(11)

# --- Error 3: Consecutive tool errors (3+) ---
consecutive_errors = 0
max_consecutive = 0
last_error_text = ""
for idx, name, inp, tid in tool_calls:
    if tid in tool_results:
        res_idx, is_error, text = tool_results[tid]
        ec = get_bash_exit_code(text) if name == 'Bash' else None
        if is_error or (ec is not None and ec != 0):
            consecutive_errors += 1
            last_error_text = text[:200]
            if consecutive_errors > max_consecutive:
                max_consecutive = consecutive_errors
        else:
            consecutive_errors = 0

if max_consecutive >= 3:
    print(json.dumps({
        "type": "consecutive_errors",
        "count": max_consecutive,
        "last_error": last_error_text
    }))
    sys.exit(12)

sys.exit(0)
