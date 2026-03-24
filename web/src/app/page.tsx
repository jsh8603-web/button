"use client";

import { useState, useEffect, useRef, useCallback } from "react";

type PcStatus = "online" | "offline" | "waking" | "shutting-down";
type TabId = "home" | "schedule" | "monitor";
type Schedule = {
  id: string;
  type: string;
  action: string;
  cron: string;
  label: string;
  enabled: boolean;
};
type AlertInfo = { type: string; message: string; since: string };
type TaskInfo = {
  id: string;
  type?: "command" | "ai";
  name: string | null;
  command: string | null;
  instructions?: string | null;
  scheduledAt: string;
  repeat: string | null;
  onComplete: string | null;
  status: "pending" | "running" | "completed" | "failed";
  inputNeeded?: string | null;
  waitingForInput?: boolean;
  result?: string | null;
  log: string | null;
  completedAt: string | null;
};
type MetricsData = {
  cpu: number | null;
  memUsed: number | null;
  memTotal: number | null;
  disks: { drive: string; freeGB: number; totalGB: number }[];
  gpuTemp: number | null;
  uptime: number | null;
};

const POLL_INTERVAL = 10; // seconds
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "";

function nextRefresh(date: Date): string {
  const elapsed = Math.floor((Date.now() - date.getTime()) / 1000);
  const remaining = Math.max(0, POLL_INTERVAL - elapsed);
  return `${remaining}s`;
}

function getToken(): string | null {
  try { return localStorage.getItem("auth-token"); } catch { return null; }
}

function setToken(token: string) {
  try { localStorage.setItem("auth-token", token); } catch {}
}

function clearToken() {
  try { localStorage.removeItem("auth-token"); } catch {}
}

function api(path: string, options?: RequestInit) {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> || {}),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── PIN Entry ───────────────────────────────────────────────

function PinEntry({ onAuth }: { onAuth: () => void }) {
  const [digits, setDigits] = useState(["", "", "", ""]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const submitPin = useCallback(
    async (pin: string) => {
      setLoading(true);
      setError(false);
      try {
        const res = await api("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.token) setToken(data.token);
          onAuth();
        } else {
          setError(true);
          setDigits(["", "", "", ""]);
          setTimeout(() => inputRefs.current[0]?.focus(), 100);
        }
      } catch {
        setError(true);
        setDigits(["", "", "", ""]);
      } finally {
        setLoading(false);
      }
    },
    [onAuth]
  );

  const handleChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return;

    const newDigits = [...digits];
    newDigits[index] = value.slice(-1);
    setDigits(newDigits);
    setError(false);

    if (value && index < 3) {
      inputRefs.current[index + 1]?.focus();
    }

    if (value && index === 3) {
      const pin = newDigits.join("");
      if (pin.length === 4) {
        submitPin(pin);
      }
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-dvh px-6">
      <h1 className="text-3xl font-bold tracking-tight mb-12 text-white/90">
        Button
      </h1>

      <div className="flex gap-3 mb-6">
        {digits.map((digit, i) => (
          <input
            key={i}
            ref={(el) => {
              inputRefs.current[i] = el;
            }}
            type="tel"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            disabled={loading}
            className={`w-14 h-16 text-center text-2xl font-mono rounded-xl
              bg-white/5 border-2 outline-none transition-all duration-200
              ${
                error
                  ? "border-red-500/60 shake"
                  : "border-white/10 focus:border-white/30"
              }
              ${loading ? "opacity-50" : ""}
            `}
          />
        ))}
      </div>

      {error && (
        <p className="text-red-400 text-sm animate-pulse">Wrong PIN</p>
      )}
    </div>
  );
}

// ─── SVG Icons ──────────────────────────────────────────────

function PowerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.5} strokeLinecap="round" className={className}>
      <path d="M12 3v8" />
      <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64" />
    </svg>
  );
}

function ShieldIcon({ active, size = 18 }: { active: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={`transition-colors duration-300 ${active ? "text-green-400" : "text-white/30"}`}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
        stroke="currentColor" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.15 : 0} />
      {active && <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth={2.5} />}
    </svg>
  );
}

function SnowflakeIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <path d="M12 2v20M17 7l-5 5-5-5M7 17l5-5 5 5M2 12h20M7 7l-5 5 5 5M17 7l5 5-5 5" />
    </svg>
  );
}

function TerminalIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function FolderIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function MoonIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MonitorOffIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <line x1="7" y1="7" x2="17" y2="13" />
    </svg>
  );
}

function ClockIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function XIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2.5} strokeLinecap="round"
      className={className}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function PlusIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round"
      className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CalendarIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function ChartIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <path d="M18 20V10M12 20V4M6 20v-6" />
    </svg>
  );
}

function HomeIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function TrashIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
      className={className}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

// ─── Progress Bar ────────────────────────────────────────────

function ProgressBar({ value, max, label, detail, warning }: {
  value: number; max: number; label: string; detail: string; warning?: boolean;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="mb-3">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-white/60">{label}</span>
        <span className={warning ? "text-red-400" : "text-white/40"}>{detail}</span>
      </div>
      <div className="h-2 bg-white/5 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${warning ? "bg-red-500" : "bg-blue-500/70"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Monitor Tab ─────────────────────────────────────────────

function MonitorTab({ metrics, isOnline }: { metrics: MetricsData | null; isOnline: boolean }) {
  if (!isOnline) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-white/30">
        <ChartIcon size={40} className="mb-4 opacity-30" />
        <p>PC is offline</p>
      </div>
    );
  }
  if (!metrics) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm mx-auto px-4 py-6">
      {metrics.cpu !== null && (
        <ProgressBar
          value={metrics.cpu} max={100}
          label="CPU" detail={`${metrics.cpu}%`}
          warning={metrics.cpu > 95}
        />
      )}
      {metrics.memUsed !== null && metrics.memTotal !== null && (
        <ProgressBar
          value={metrics.memUsed} max={metrics.memTotal}
          label="RAM" detail={`${metrics.memUsed} / ${metrics.memTotal} GB`}
          warning={metrics.memUsed / metrics.memTotal > 0.9}
        />
      )}
      {metrics.disks.map((d) => {
        const usedGB = d.totalGB - d.freeGB;
        const pct = d.totalGB > 0 ? (usedGB / d.totalGB) * 100 : 0;
        return (
          <ProgressBar
            key={d.drive}
            value={usedGB} max={d.totalGB}
            label={d.drive} detail={`${d.freeGB} GB free`}
            warning={pct > 90}
          />
        );
      })}
      {metrics.gpuTemp !== null && (
        <div className="flex justify-between items-center py-2 border-t border-white/5 mt-2">
          <span className="text-xs text-white/60">GPU</span>
          <span className={`text-sm font-mono ${metrics.gpuTemp > 85 ? "text-red-400" : "text-white/70"}`}>
            {metrics.gpuTemp}°C
          </span>
        </div>
      )}
      {metrics.uptime !== null && (
        <div className="flex justify-between items-center py-2 border-t border-white/5">
          <span className="text-xs text-white/60">Uptime</span>
          <span className="text-sm font-mono text-white/70">{formatUptime(metrics.uptime)}</span>
        </div>
      )}
    </div>
  );
}

// ─── Schedule Tab ────────────────────────────────────────────

const DAYS_KR = ["일", "월", "화", "수", "목", "금", "토"];
const ACTION_OPTIONS = [
  { value: "wake", label: "Wake (WOL)" },
  { value: "sleep", label: "Sleep" },
  { value: "hibernate", label: "Hibernate" },
  { value: "shutdown", label: "Shutdown" },
];

function formatTaskTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  if (diff < 0) return time; // past
  if (diff < 60_000) return "soon";
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h`;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
}

function TaskStatusBadge({ status }: { status: string }) {
  const styles = {
    pending: "bg-amber-500/20 text-amber-300",
    running: "bg-blue-500/20 text-blue-300",
    completed: "bg-green-500/20 text-green-300",
    failed: "bg-red-500/20 text-red-300",
  }[status] || "bg-white/10 text-white/40";
  const labels = {
    pending: "Scheduled",
    running: "Running",
    completed: "Done",
    failed: "Failed",
  } as Record<string, string>;
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${styles}`}>
      {labels[status] || status}
    </span>
  );
}

function ScheduleTab() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formAction, setFormAction] = useState("wake");
  const [formHour, setFormHour] = useState("08");
  const [formMinute, setFormMinute] = useState("30");
  const [formDays, setFormDays] = useState<number[]>([1, 2, 3, 4, 5]); // Mon-Fri
  const [formLabel, setFormLabel] = useState("");
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

  const fetchSchedules = useCallback(async () => {
    try {
      const res = await api("/api/schedules");
      if (res.ok) setSchedules(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  const fetchTasks = useCallback(async () => {
    try {
      let agentTasks: TaskInfo[] = [];
      // Try status first (fast: returns cached tasks when offline)
      const statusRes = await api("/api/status");
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        if (statusData.tasks) {
          agentTasks = statusData.tasks;
        }
      }
      // Online: fetch full task list from Agent
      if (agentTasks.length === 0) {
        const res = await api("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "task-list" }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.tasks) agentTasks = data.tasks;
        }
      }
      // Fetch Pi deferred tasks (deliverAt pending)
      let deferredTasks: TaskInfo[] = [];
      try {
        const dRes = await api("/api/deferred");
        if (dRes.ok) {
          const deferred: { body: { action: string; params?: Record<string, unknown>; deliverAt?: string }; createdAt: string; deliverAt: string | null }[] = await dRes.json();
          deferredTasks = deferred.map((d, i) => ({
            id: `deferred-${i}`,
            type: (d.body.params?.type as TaskInfo["type"]) || undefined,
            name: (d.body.params?.name as string) || "Task",
            command: (d.body.params?.command as string) || null,
            instructions: (d.body.params?.instructions as string) || null,
            scheduledAt: (d.body.params?.scheduledAt as string) || d.deliverAt || d.createdAt,
            repeat: null,
            onComplete: (d.body.params?.onComplete as string) || null,
            status: "pending" as const,
            log: null,
            completedAt: null,
          }));
        }
      } catch { /* ignore */ }
      setTasks([...deferredTasks, ...agentTasks].reverse());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchSchedules(); fetchTasks(); }, [fetchSchedules, fetchTasks]);

  // Poll tasks every 15s
  useEffect(() => {
    const interval = setInterval(fetchTasks, 15_000);
    return () => clearInterval(interval);
  }, [fetchTasks]);

  const handleCancelTask = async (taskId: string) => {
    setTasks(prev => prev.filter(t => t.id !== taskId));
    try {
      await api("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "task-cancel", taskId }),
      });
    } catch { /* optimistic */ }
  };

  const handleAdd = async () => {
    const dow = formDays.length === 7 ? "*" : formDays.join(",");
    const cron = `${parseInt(formMinute)} ${parseInt(formHour)} * * ${dow}`;
    const dayStr = formDays.length === 7 ? "매일" :
      formDays.length === 5 && [1,2,3,4,5].every(d => formDays.includes(d)) ? "평일" :
      formDays.map(d => DAYS_KR[d]).join("");
    const label = formLabel.trim() || `${dayStr} ${formHour}:${formMinute} ${ACTION_OPTIONS.find(a => a.value === formAction)?.label || formAction}`;

    try {
      const res = await api("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: formAction, cron, label }),
      });
      if (res.ok) {
        const newSchedule = await res.json();
        setSchedules(prev => [...prev, newSchedule]);
        setShowForm(false);
        setFormLabel("");
      }
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: string) => {
    setSchedules(prev => prev.filter(s => s.id !== id));
    try {
      await api(`/api/schedules/${id}`, { method: "DELETE" });
    } catch { /* optimistic */ }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    setSchedules(prev => prev.map(s => s.id === id ? { ...s, enabled } : s));
    try {
      await api(`/api/schedules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
    } catch { /* optimistic */ }
  };

  const toggleDay = (d: number) => {
    setFormDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort());
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm mx-auto px-4 py-6">
      {/* Add button */}
      <button
        onClick={() => setShowForm(!showForm)}
        className="w-full mb-4 py-2.5 rounded-xl border border-dashed border-white/15
          text-sm text-white/50 hover:text-white/70 hover:border-white/25
          transition-colors flex items-center justify-center gap-2"
      >
        <PlusIcon size={16} />
        <span>New Schedule</span>
      </button>

      {/* Add form */}
      {showForm && (
        <div className="mb-4 p-4 bg-white/5 border border-white/10 rounded-xl space-y-3">
          {/* Action select */}
          <select
            value={formAction}
            onChange={e => setFormAction(e.target.value)}
            className="w-full h-10 px-3 bg-white/5 border border-white/10 rounded-lg
              text-sm text-white/80 outline-none"
          >
            {ACTION_OPTIONS.map(o => (
              <option key={o.value} value={o.value} className="bg-neutral-900">{o.label}</option>
            ))}
          </select>

          {/* Time */}
          <div className="flex gap-2 items-center">
            <select
              value={formHour}
              onChange={e => setFormHour(e.target.value)}
              className="w-20 h-10 px-2 text-center bg-white/5 border border-white/10 rounded-lg
                text-sm text-white/80 outline-none font-mono"
            >
              {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map(h => (
                <option key={h} value={h} className="bg-neutral-900">{h}</option>
              ))}
            </select>
            <span className="text-white/30">:</span>
            <select
              value={formMinute}
              onChange={e => setFormMinute(e.target.value)}
              className="w-20 h-10 px-2 text-center bg-white/5 border border-white/10 rounded-lg
                text-sm text-white/80 outline-none font-mono"
            >
              <option value="00" className="bg-neutral-900">00</option>
              <option value="30" className="bg-neutral-900">30</option>
            </select>
          </div>

          {/* Day select */}
          <div className="flex gap-1.5">
            {DAYS_KR.map((label, i) => (
              <button
                key={i}
                onClick={() => toggleDay(i)}
                className={`flex-1 h-8 rounded-lg text-xs font-medium transition-colors
                  ${formDays.includes(i)
                    ? "bg-blue-500/30 text-blue-300 border border-blue-500/40"
                    : "bg-white/5 text-white/30 border border-white/5"
                  }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Label */}
          <input
            type="text" placeholder="Label (optional)"
            value={formLabel} onChange={e => setFormLabel(e.target.value)}
            className="w-full h-10 px-3 bg-white/5 border border-white/10 rounded-lg
              text-sm text-white/80 placeholder-white/20 outline-none"
          />

          {/* Submit */}
          <button
            onClick={handleAdd}
            disabled={formDays.length === 0}
            className="w-full h-10 rounded-lg bg-blue-500/20 text-blue-300 text-sm font-medium
              hover:bg-blue-500/30 transition-colors disabled:opacity-30"
          >
            Add
          </button>
        </div>
      )}

      {/* Schedule list */}
      {schedules.length === 0 && !showForm && tasks.length === 0 && (
        <p className="text-center text-white/30 text-sm py-10">No schedules</p>
      )}
      {schedules.map(s => (
        <div
          key={s.id}
          className={`flex items-center gap-3 px-4 py-3 mb-2 rounded-xl border transition-colors
            ${s.enabled ? "bg-white/5 border-white/10" : "bg-white/[0.02] border-white/5 opacity-50"}`}
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white/80 truncate">{s.label}</p>
            <p className="text-[10px] text-white/30 font-mono mt-0.5">{s.cron}</p>
          </div>
          {/* Toggle */}
          <button
            onClick={() => handleToggle(s.id, !s.enabled)}
            className={`w-10 h-5 rounded-full transition-colors relative shrink-0
              ${s.enabled ? "bg-green-500/40" : "bg-white/10"}`}
          >
            <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all
              ${s.enabled ? "left-5.5" : "left-0.5"}`}
              style={{ left: s.enabled ? "22px" : "2px" }}
            />
          </button>
          {/* Delete */}
          <button
            onClick={() => handleDelete(s.id)}
            className="text-white/20 hover:text-red-400 transition-colors shrink-0"
          >
            <TrashIcon />
          </button>
        </div>
      ))}

      {/* ─── Tasks Section ─── */}
      {tasks.length > 0 && (
        <>
          <div className="mt-6 mb-3 flex items-center gap-2">
            <div className="h-px flex-1 bg-white/10" />
            <span className="text-[10px] text-white/30 uppercase tracking-wider">Tasks</span>
            <div className="h-px flex-1 bg-white/10" />
          </div>

          {tasks.map(t => {
            const label = t.name || (t.command && t.command.length > 40 ? t.command.slice(0, 40) + "..." : t.command) || "Task";
            const expanded = expandedTask === t.id;
            return (
              <div key={t.id} className="mb-2">
                <div
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors cursor-pointer
                    ${t.status === "running" ? "bg-blue-500/5 border-blue-500/20" :
                      t.status === "completed" ? "bg-green-500/5 border-green-500/10" :
                      t.status === "failed" ? "bg-red-500/5 border-red-500/20" :
                      "bg-white/[0.03] border-white/10"}`}
                  onClick={() => setExpandedTask(expanded ? null : t.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <TaskStatusBadge status={t.status} />
                      {t.type === "ai" && (
                        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-purple-500/20 text-purple-300">AI</span>
                      )}
                      {t.status === "running" && !t.waitingForInput && (
                        <div className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin" />
                      )}
                      {t.status === "running" && t.waitingForInput && (
                        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/20 text-amber-300 animate-pulse">Needs Input</span>
                      )}
                    </div>
                    <p className="text-sm text-white/80 truncate">{label}</p>
                    {t.inputNeeded && (t.status === "pending" || t.status === "running") && (
                      <p className="text-[10px] mt-0.5 truncate text-amber-400/80">
                        ⚠ {t.inputNeeded}
                      </p>
                    )}
                    {t.result && (
                      <p className={`text-[10px] mt-0.5 truncate ${t.status === "failed" ? "text-red-400/70" : "text-green-400/70"}`}>
                        {t.result}
                      </p>
                    )}
                    <p className="text-[10px] text-white/30 mt-0.5">
                      {t.status === "pending" && <>Scheduled: {formatTaskTime(t.scheduledAt)}</>}
                      {t.status === "running" && <>Started at {formatTaskTime(t.scheduledAt)}</>}
                      {(t.status === "completed" || t.status === "failed") && t.completedAt && <>Finished {formatTaskTime(t.completedAt)}</>}
                      {t.onComplete && <span className="ml-2 text-amber-400/50">then {t.onComplete}</span>}
                    </p>
                  </div>
                  {t.status === "pending" && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleCancelTask(t.id); }}
                      className="text-white/20 hover:text-red-400 transition-colors shrink-0"
                      title="Cancel"
                    >
                      <XIcon />
                    </button>
                  )}
                </div>
                {/* Expanded log */}
                {expanded && t.log && (
                  <div className="mx-2 mt-1 p-3 bg-black/40 border border-white/5 rounded-lg
                    text-[10px] text-white/40 font-mono max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
                    {t.log}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// ─── Dashboard ───────────────────────────────────────────────

type SessionInfo = { name: string; protected: boolean };

function Dashboard() {
  const [status, setStatus] = useState<PcStatus>("offline");
  const [lastChecked, setLastChecked] = useState<Date>(new Date());
  const [lastCheckedText, setLastCheckedText] = useState(`${POLL_INTERVAL}s`);
  const [actionFeedback, setActionFeedback] = useState("");
  const [showProjDropdown, setShowProjDropdown] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [newProjName, setNewProjName] = useState("");
  const [showNewProjInput, setShowNewProjInput] = useState(false);
  const [lastProject, setLastProject] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [wakeLogs, setWakeLogs] = useState<Record<string, unknown>[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [showSessionDropdown, setShowSessionDropdown] = useState(false);
  const [showPowerMenu, setShowPowerMenu] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [lastPowerAction, setLastPowerAction] = useState<string | null>(null);
  const [scheduledAction, setScheduledAction] = useState<{ type: string; label: string } | null>(null);
  const [currentTab, setCurrentTab] = useState<TabId>("home");
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [alerts, setAlerts] = useState<AlertInfo[]>([]);
  const [showAlertPopup, setShowAlertPopup] = useState(false);
  const newProjInputRef = useRef<HTMLInputElement>(null);
  const sessionActionTime = useRef(0);
  const actionFeedbackRef = useRef(actionFeedback);
  actionFeedbackRef.current = actionFeedback;

  useEffect(() => {
    try { setLastProject(localStorage.getItem("last-project") || ""); } catch {}
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const res = await api("/api/status");
      if (res.status === 401) return; // not authenticated
      const data = await res.json();
      const isOnline = data.status === "online";
      if (isOnline && Date.now() - sessionActionTime.current > 35_000) {
        setSessions(data.sessions || []);
      }
      if (data.metrics) setMetrics(data.metrics);
      if (data.alerts) setAlerts(data.alerts);
      setLastPowerAction(isOnline ? null : data.lastAction || null);
      setStatus((prev) => {
        if (prev === "waking") return isOnline ? "online" : prev;
        if (prev === "shutting-down") return !isOnline ? "offline" : prev;
        return isOnline ? "online" : "offline";
      });
      setLastChecked(new Date());
    } catch {
      setStatus((prev) => {
        if (prev === "shutting-down") return "offline";
        if (prev === "waking") return prev;
        return "offline";
      });
    }
  }, []);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, POLL_INTERVAL * 1000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  useEffect(() => {
    const interval = setInterval(() => {
      setLastCheckedText(nextRefresh(lastChecked));
    }, 1000);
    return () => clearInterval(interval);
  }, [lastChecked]);

  useEffect(() => {
    if (status === "waking" || status === "shutting-down") {
      const fallback = status === "waking" ? "offline" : "online";
      const timeout = setTimeout(() => {
        setStatus((prev) => (prev === status ? fallback : prev));
      }, 60000);
      return () => clearTimeout(timeout);
    }
  }, [status]);

  useEffect(() => {
    if (status === "waking" || status === "shutting-down") {
      const interval = setInterval(checkStatus, 3000);
      return () => clearInterval(interval);
    }
  }, [status, checkStatus]);

  const saveWakeLog = (entry: Record<string, unknown>) => {
    try {
      const { log: serverLog, ...rest } = entry;
      const flat = { timestamp: new Date().toISOString(), ...rest, ...(serverLog && typeof serverLog === "object" ? serverLog as Record<string, unknown> : {}) };
      const logs = JSON.parse(localStorage.getItem("wake-logs") || "[]");
      logs.unshift(flat);
      if (logs.length > 10) logs.length = 10;
      localStorage.setItem("wake-logs", JSON.stringify(logs));
    } catch { /* localStorage unavailable */ }
  };

  const handlePowerPress = async () => {
    if (status === "waking" || status === "shutting-down") return;

    if (status === "offline") {
      setStatus("waking");
      try {
        const res = await api("/api/wake", { method: "POST" });
        const data = await res.json();
        saveWakeLog({ status: res.status, ...data });
        if (res.ok) {
          setActionFeedback("Magic packet sent");
        } else {
          setStatus("offline");
          setActionFeedback(data.detail || data.error || "Failed to send");
        }
        setTimeout(() => setActionFeedback(""), 5000);
      } catch (err) {
        setStatus("offline");
        const msg = err instanceof Error ? err.message : "Network error";
        saveWakeLog({ status: 0, error: msg });
        setActionFeedback(`Failed: ${msg}`);
        setTimeout(() => setActionFeedback(""), 5000);
      }
    } else {
      if (window.confirm("Shut down PC?")) {
        setStatus("shutting-down");
        try {
          await api("/api/shutdown", { method: "POST" });
          setActionFeedback("Shutdown signal sent");
          setTimeout(() => setActionFeedback(""), 3000);
        } catch {
          setStatus("online");
          setActionFeedback("Failed to reach PC");
          setTimeout(() => setActionFeedback(""), 3000);
        }
      }
    }
  };

  const handlePowerAction = async (action: string, label: string, params?: Record<string, string>) => {
    setShowPowerMenu(false);
    const delay = params?.delay ? parseInt(params.delay, 10) : 0;
    try {
      setActionFeedback(`${label}...`);
      await api("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(params ? { params } : {}) }),
      });
      if (delay > 0) {
        const hours = Math.round(delay / 3600);
        const typeLabel = action === "sleep" ? "Sleep" : "Hibernate";
        setScheduledAction({ type: action, label: `${typeLabel} ${hours}h` });
        setActionFeedback(`${typeLabel} in ${hours}h scheduled`);
      } else {
        setScheduledAction(null);
        setActionFeedback(`${label} signal sent`);
      }
    } catch {
      setActionFeedback("Failed to reach PC");
    }
    setTimeout(() => setActionFeedback(""), 5000);
  };

  const handleCancelScheduled = async () => {
    setShowPowerMenu(false);
    setScheduledAction(null);
    try {
      await api("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "hibernate-cancel" }),
      });
      setActionFeedback("Schedule cancelled");
    } catch {
      setActionFeedback("Failed to reach PC");
    }
    setTimeout(() => setActionFeedback(""), 3000);
  };

  const fetchProjects = useCallback(async () => {
    try {
      const res = await api("/api/projects");
      const data = await res.json();
      if (data.projects) setProjects(data.projects);
    } catch { /* ignore */ }
  }, []);

  const handleQuickAction = async (action: string, name?: string) => {
    try {
      setActionFeedback(`Starting ${action}...`);
      const res = await api("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(name ? { name } : {}) }),
      });
      const data = await res.json();
      if (data.error) {
        setActionFeedback(data.error);
      } else {
        setActionFeedback(`${action} started`);
      }
    } catch {
      setActionFeedback("Failed to reach PC");
    }
    setTimeout(() => setActionFeedback(""), 3000);
  };

  const handleOpenProject = async (name: string) => {
    setShowProjDropdown(false);
    setShowNewProjInput(false);
    setNewProjName("");
    setLastProject(name);
    try { localStorage.setItem("last-project", name); } catch {}
    await handleQuickAction("proj", name);
  };

  const handleSessionAction = async (action: string, name: string) => {
    sessionActionTime.current = Date.now();
    if (action === "protect-session") {
      setSessions(prev => prev.map(s => s.name === name ? { ...s, protected: true } : s));
    } else if (action === "unprotect-session") {
      setSessions(prev => prev.map(s => s.name === name ? { ...s, protected: false } : s));
    } else if (action === "kill-session") {
      setSessions(prev => prev.filter(s => s.name !== name));
    }
    try {
      await api("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, name }),
      });
    } catch { /* optimistic UI already updated */ }
  };

  const handleNewProjSubmit = async () => {
    const name = newProjName.trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      setActionFeedback("Invalid project name");
      setTimeout(() => setActionFeedback(""), 3000);
      return;
    }
    await handleOpenProject(name);
  };

  const closeAllDropdowns = () => {
    setShowPowerMenu(false);
    setShowSessionDropdown(false);
    setShowProjDropdown(false);
    setShowAlertPopup(false);
  };

  const glowClass = {
    online: "animate-pulse-green",
    offline: "animate-pulse-red",
    waking: "animate-pulse-amber",
    "shutting-down": "animate-pulse-amber",
  }[status];

  const borderColor = {
    online: "border-green-500/50",
    offline: "border-red-500/50",
    waking: "border-amber-500/50",
    "shutting-down": "border-amber-500/50",
  }[status];

  const iconColor = {
    online: "text-green-400",
    offline: "text-red-400",
    waking: "text-amber-400",
    "shutting-down": "text-amber-400",
  }[status];

  const offlineLabel = lastPowerAction
    ? { hibernate: "Hibernating", shutdown: "Shut Down", sleep: "Sleeping" }[lastPowerAction] || "PC is OFF"
    : "PC is OFF";
  const statusText = {
    online: "PC is ON",
    offline: offlineLabel,
    waking: "Waking up...",
    "shutting-down": "Shutting down...",
  }[status];

  const isTransitioning = status === "waking" || status === "shutting-down";

  return (
    <div className="flex flex-col items-center min-h-dvh px-6 select-none pb-16">
      {/* ─── Tab Content ─── */}
      {currentTab === "home" && (
        <div className="flex flex-col items-center justify-center flex-1 w-full">
          {/* Power Button */}
          <div className="relative">
            <button
              onClick={handlePowerPress}
              disabled={isTransitioning}
              className={`
                w-[120px] h-[120px] rounded-full border-2
                flex items-center justify-center
                transition-all duration-500 ease-out
                ${borderColor} ${glowClass}
                ${isTransitioning ? "cursor-wait" : "cursor-pointer"}
                active:scale-95 hover:scale-105
                bg-white/[0.03]
              `}
            >
              <PowerIcon className={`w-12 h-12 ${iconColor} transition-colors duration-500`} />
            </button>

            {/* Alert Badge */}
            {alerts.length > 0 && (
              <button
                onClick={() => setShowAlertPopup(!showAlertPopup)}
                className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500
                  text-[10px] text-white font-bold flex items-center justify-center
                  animate-pulse"
              >
                {alerts.length}
              </button>
            )}

            {/* Alert Popup */}
            {showAlertPopup && alerts.length > 0 && (
              <div className="absolute top-full mt-2 right-0 w-52 bg-black/95 border border-red-500/30
                rounded-xl p-3 text-xs space-y-1.5 z-10">
                {alerts.map((a, i) => (
                  <div key={i} className="flex items-center gap-2 text-red-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                    <span>{a.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Status Text */}
          <p className="mt-8 text-lg font-medium text-white/80 transition-all duration-300">
            {statusText}
          </p>

          {/* Last Project */}
          {lastProject && (
            <p className="mt-2 text-xs text-white/40">
              Last: {lastProject}
            </p>
          )}

          {/* Last Checked */}
          <p className="mt-2 text-xs text-white/30">
            Refresh in {lastCheckedText}
          </p>

          {/* Action Feedback */}
          <div className="h-6 mt-3">
            {actionFeedback && (
              <p className="text-xs text-amber-400/80 animate-pulse">{actionFeedback}</p>
            )}
          </div>

          {/* Quick Actions — only visible when PC is ON */}
          <div
            className={`
              flex gap-4 mt-10 transition-all duration-500
              ${status === "online" ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}
            `}
          >
            <button
              onClick={() => { closeAllDropdowns(); setShowPowerMenu(v => !v); }}
              className={`w-12 h-12 rounded-xl bg-white/5 border flex items-center justify-center
                active:scale-90 transition-all duration-200
                ${showPowerMenu ? "border-blue-500/50 bg-blue-500/10" : "border-white/10 hover:bg-white/10 hover:border-white/20"}`}
              title="Hibernate"
            >
              <SnowflakeIcon size={22} className="text-blue-400" />
            </button>
            <button
              onClick={() => { closeAllDropdowns(); setShowSessionDropdown(v => !v); }}
              className={`relative w-12 h-12 rounded-xl bg-white/5 border flex items-center justify-center
                active:scale-90 transition-all duration-200
                ${showSessionDropdown ? "border-blue-500/50 bg-blue-500/10" : "border-white/10 hover:bg-white/10 hover:border-white/20"}`}
              title="Sessions"
            >
              <TerminalIcon size={22} className="text-blue-400" />
              {sessions.length > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-blue-500 text-[10px] text-white flex items-center justify-center font-bold">
                  {sessions.length}
                </span>
              )}
            </button>
            <button
              onClick={() => { closeAllDropdowns(); setShowProjDropdown(v => !v); if (!showProjDropdown) fetchProjects(); }}
              className={`w-12 h-12 rounded-xl bg-white/5 border flex items-center justify-center
                active:scale-90 transition-all duration-200
                ${showProjDropdown ? "border-amber-500/50 bg-amber-500/10" : "border-white/10 hover:bg-white/10 hover:border-white/20"}`}
              title="Open Project"
            >
              <FolderIcon size={22} className="text-amber-400" />
            </button>
          </div>

          {/* Power Menu Dropdown */}
          <div
            className={`
              mt-4 w-56 transition-all duration-300 overflow-hidden
              ${status === "online" && showPowerMenu ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"}
            `}
          >
            <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
              {/* Monitor Off */}
              <button
                onClick={() => handlePowerAction("display_off", "Monitor Off")}
                className="w-full px-4 py-3 text-left text-sm text-white/70
                  hover:bg-white/10 hover:text-white transition-colors flex items-center gap-3
                  border-b border-white/5"
              >
                <MonitorOffIcon size={18} className="text-slate-400" />
                <span>Monitor Off</span>
              </button>

              {/* Sleep section */}
              <div className="border-b border-white/10">
                <button
                  onClick={() => {
                    if (!window.confirm("Sleep now?")) return;
                    handlePowerAction("sleep", "Sleep");
                  }}
                  className="w-full px-4 py-3 text-left text-sm text-white/70
                    hover:bg-white/10 hover:text-white transition-colors flex items-center gap-3
                    border-b border-white/5"
                >
                  <MoonIcon size={18} className="text-purple-400" />
                  <span>Sleep</span>
                </button>
                {[
                  { label: "Sleep 1h", delay: "3600" },
                  { label: "Sleep 2h", delay: "7200" },
                ].map((opt) => (
                  <button
                    key={`sleep-${opt.delay}`}
                    onClick={() => handlePowerAction("sleep", opt.label, { delay: opt.delay })}
                    className="w-full px-4 py-3 text-left text-sm text-white/70
                      hover:bg-white/10 hover:text-white transition-colors flex items-center gap-3
                      border-b border-white/5 last:border-b-0"
                  >
                    <ClockIcon size={16} className="text-purple-400/60" />
                    <span>{opt.label}</span>
                  </button>
                ))}
              </div>

              {/* Hibernate section */}
              <button
                onClick={() => {
                  if (!window.confirm("Hibernate now?")) return;
                  handlePowerAction("hibernate", "Hibernate");
                }}
                className="w-full px-4 py-3 text-left text-sm text-white/70
                  hover:bg-white/10 hover:text-white transition-colors flex items-center gap-3
                  border-b border-white/5"
              >
                <SnowflakeIcon size={18} className="text-blue-400" />
                <span>Hibernate</span>
              </button>
              {[
                { label: "Hibernate 1h", delay: "3600" },
                { label: "Hibernate 2h", delay: "7200" },
              ].map((opt) => (
                <button
                  key={`hib-${opt.delay}`}
                  onClick={() => handlePowerAction("hibernate", opt.label, { delay: opt.delay })}
                  className="w-full px-4 py-3 text-left text-sm text-white/70
                    hover:bg-white/10 hover:text-white transition-colors flex items-center gap-3
                    border-b border-white/5 last:border-b-0"
                >
                  <ClockIcon size={16} className="text-blue-400/60" />
                  <span>{opt.label}</span>
                </button>
              ))}

              {/* Cancel scheduled action */}
              {scheduledAction && (
                <button
                  onClick={handleCancelScheduled}
                  className="w-full px-4 py-3 text-left text-sm text-red-400/80
                    hover:bg-red-500/10 hover:text-red-400 transition-colors flex items-center gap-3
                    border-t border-white/10"
                >
                  <XIcon size={14} className="text-red-400" />
                  <span>Cancel ({scheduledAction.label})</span>
                </button>
              )}
            </div>
          </div>

          {/* Session Dropdown */}
          <div
            className={`
              mt-4 w-64 transition-all duration-300 overflow-hidden
              ${status === "online" && showSessionDropdown ? "max-h-80 opacity-100" : "max-h-0 opacity-0"}
            `}
          >
            <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
              {sessions.length === 0 ? (
                <p className="px-4 py-3 text-xs text-white/30">No active sessions</p>
              ) : (
                sessions.map((s) => (
                  <div
                    key={s.name}
                    className="flex items-center px-4 py-2.5 hover:bg-white/5 transition-colors"
                  >
                    <span className="flex-1 text-sm text-white/70 truncate">{s.name}</span>
                    <button
                      onClick={() => handleSessionAction(
                        s.protected ? "unprotect-session" : "protect-session",
                        s.name
                      )}
                      className="ml-2 hover:scale-110 transition-transform"
                      title={s.protected ? "Remove protection" : "Protect session"}
                    >
                      <ShieldIcon active={s.protected} />
                    </button>
                    {!s.protected && (
                      <button
                        onClick={() => {
                          if (window.confirm(`Close ${s.name}?`)) {
                            handleSessionAction("kill-session", s.name);
                          }
                        }}
                        className="ml-2 text-white/30 hover:text-red-400 transition-colors"
                        title="Kill session"
                      >
                        <XIcon />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Project Dropdown */}
          <div
            className={`
              mt-4 w-56 transition-all duration-300 overflow-hidden
              ${status === "online" && showProjDropdown ? "max-h-80 opacity-100" : "max-h-0 opacity-0"}
            `}
          >
            <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
              {/* New Repo */}
              {!showNewProjInput ? (
                <button
                  onClick={() => {
                    setShowNewProjInput(true);
                    setTimeout(() => newProjInputRef.current?.focus(), 100);
                  }}
                  className="w-full px-4 py-3 text-left text-sm text-amber-400/80
                    hover:bg-white/10 transition-colors border-b border-white/10"
                >
                  + New Repo
                </button>
              ) : (
                <form
                  onSubmit={(e) => { e.preventDefault(); handleNewProjSubmit(); }}
                  className="flex border-b border-white/10"
                >
                  <input
                    ref={newProjInputRef}
                    type="text"
                    value={newProjName}
                    onChange={(e) => setNewProjName(e.target.value)}
                    placeholder="repo name"
                    className="min-w-0 flex-1 h-10 px-3 bg-transparent text-sm text-white
                      placeholder-white/30 outline-none"
                  />
                  <button
                    type="submit"
                    className="shrink-0 px-3 text-sm text-amber-400/80 hover:text-amber-400 transition-colors"
                  >
                    Go
                  </button>
                </form>
              )}

              {/* Project List */}
              <div className="max-h-52 overflow-y-auto">
                {projects.map((proj) => {
                  const activeSession = sessions.find(s => s.name === proj);
                  return (
                    <button
                      key={proj}
                      onClick={() => handleOpenProject(proj)}
                      className="w-full px-4 py-2.5 text-left text-sm text-white/70
                        hover:bg-white/10 hover:text-white transition-colors flex items-center"
                    >
                      <span className="flex-1 truncate">{proj}</span>
                      {activeSession?.protected && <span className="ml-2"><ShieldIcon active size={14} /></span>}
                    </button>
                  );
                })}
                {projects.length === 0 && (
                  <p className="px-4 py-3 text-xs text-white/30">Loading...</p>
                )}
              </div>
            </div>
          </div>

          {/* Bottom: Help + Logs */}
          <div className="fixed bottom-16 left-4 right-4 flex justify-between items-end">
            {/* Help Index */}
            <div>
              <button
                onClick={() => setShowHelp(!showHelp)}
                className="w-8 h-8 rounded-full bg-white/5 border border-white/10
                  text-[10px] text-white/30 hover:text-white/60 transition-colors"
              >
                ?
              </button>
              {showHelp && (
                <div className="absolute bottom-10 left-0 w-72
                  bg-black/95 border border-white/10 rounded-xl p-4 text-[11px] text-white/50 space-y-3">
                  <div className="text-white/70 font-medium text-xs mb-2">Controls</div>

                  <div className="flex items-start gap-2">
                    <PowerIcon className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                    <div><span className="text-white/70">Power</span> — OFF: Wake (WOL), ON: Shut down</div>
                  </div>

                  <div className="border-t border-white/10 pt-2 text-white/40 text-[10px]">Quick Actions (online only)</div>

                  <div className="flex items-start gap-2">
                    <MonitorOffIcon size={14} className="text-slate-400 shrink-0 mt-0.5" />
                    <div><span className="text-white/70">Monitor Off</span> — Turn off display</div>
                  </div>
                  <div className="flex items-start gap-2">
                    <MoonIcon size={14} className="text-purple-400 shrink-0 mt-0.5" />
                    <div><span className="text-white/70">Sleep</span> — Now or scheduled (1-2h)</div>
                  </div>
                  <div className="flex items-start gap-2">
                    <SnowflakeIcon size={14} className="text-blue-400 shrink-0 mt-0.5" />
                    <div><span className="text-white/70">Hibernate</span> — Now or scheduled (1-2h)</div>
                  </div>
                  <div className="flex items-start gap-2">
                    <TerminalIcon size={14} className="text-blue-400 shrink-0 mt-0.5" />
                    <div><span className="text-white/70">Sessions</span> — Manage active tmux sessions</div>
                  </div>
                  <div className="flex items-start gap-2 pl-5">
                    <ShieldIcon active size={12} />
                    <div><span className="text-green-400">Protected</span> — Survives project open. Tap to unprotect</div>
                  </div>
                  <div className="flex items-start gap-2 pl-5">
                    <ShieldIcon active={false} size={12} />
                    <div><span className="text-white/50">Unprotected</span> — Tap to protect</div>
                  </div>
                  <div className="flex items-start gap-2 pl-5">
                    <XIcon size={10} className="text-red-400 shrink-0 mt-1" />
                    <div><span className="text-red-400">Kill</span> — Close session (tmux + Claude + VS Code)</div>
                  </div>
                  <div className="flex items-start gap-2">
                    <FolderIcon size={14} className="text-amber-400 shrink-0 mt-0.5" />
                    <div><span className="text-white/70">Projects</span> — Open project. <span className="text-red-400/70">Kills unprotected sessions</span></div>
                  </div>

                </div>
              )}
            </div>

            {/* Wake Logs */}
            <div>
              <button
                onClick={() => {
                  try {
                    setWakeLogs(JSON.parse(localStorage.getItem("wake-logs") || "[]"));
                  } catch { setWakeLogs([]); }
                  setShowLogs(!showLogs);
                }}
                className="w-8 h-8 rounded-full bg-white/5 border border-white/10
                  text-[10px] text-white/30 hover:text-white/60 transition-colors"
              >
                log
              </button>
              {showLogs && wakeLogs.length > 0 && (
                <div className="absolute bottom-10 right-0 w-72 max-h-60 overflow-y-auto
                  bg-black/90 border border-white/10 rounded-lg p-3 text-[10px] text-white/60 font-mono">
                  {wakeLogs.map((log, i) => (
                    <div key={i} className="mb-2 border-b border-white/5 pb-2">
                      <div className="text-white/40">{String(log.timestamp).slice(5, 19)}</div>
                      <div className={log.result === "success" ? "text-green-400" : "text-red-400"}>
                        {log.result === "success" ? "OK" : `ERR: ${log.error || log.detail || "unknown"}`}
                      </div>
                      {log.step ? <div>step: {String(log.step)}</div> : null}
                      {log.udp ? <div>udp: {String(log.udp)}</div> : null}
                      {log.piWol ? <div>pi: {typeof log.piWol === "object" ? JSON.stringify(log.piWol) : String(log.piWol)}</div> : null}
                      {log.errorName ? <div>type: {String(log.errorName)}</div> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {currentTab === "monitor" && (
        <div className="flex-1 w-full pt-4">
          <MonitorTab metrics={metrics} isOnline={status === "online"} />
        </div>
      )}

      {currentTab === "schedule" && (
        <div className="flex-1 w-full pt-4">
          <ScheduleTab />
        </div>
      )}

      {/* ─── Bottom Tab Bar ─── */}
      <div className="fixed bottom-0 left-0 right-0 h-14 bg-black/80 backdrop-blur-lg
        border-t border-white/10 flex items-center justify-around px-6 z-20">
        {([
          { id: "home" as TabId, icon: HomeIcon, label: "Home" },
          { id: "schedule" as TabId, icon: CalendarIcon, label: "Schedule" },
          { id: "monitor" as TabId, icon: ChartIcon, label: "Monitor" },
        ]).map(tab => {
          const active = currentTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => { setCurrentTab(tab.id); closeAllDropdowns(); }}
              className={`flex flex-col items-center gap-0.5 px-4 py-1 rounded-lg transition-colors
                ${active ? "text-blue-400" : "text-white/30 hover:text-white/50"}`}
            >
              <div className="relative">
                <Icon size={20} />
                {tab.id === "home" && alerts.length > 0 && !active && (
                  <span className="absolute -top-1 -right-1.5 w-2 h-2 rounded-full bg-red-500" />
                )}
              </div>
              <span className="text-[10px]">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────

export default function Home() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      const token = getToken();
      if (!token) { setChecking(false); return; }
      try {
        const res = await api("/api/status");
        if (res.status === 401) {
          clearToken();
        } else {
          setAuthenticated(true);
        }
      } catch {
        // Network error — keep token, assume offline Pi
        setAuthenticated(true);
      } finally {
        setChecking(false);
      }
    }
    checkAuth();
  }, []);

  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-dvh">
        <div className="w-6 h-6 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
      </div>
    );
  }

  if (!authenticated) {
    return <PinEntry onAuth={() => setAuthenticated(true)} />;
  }

  return <Dashboard />;
}
