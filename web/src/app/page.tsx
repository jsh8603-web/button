"use client";

import { useState, useEffect, useRef, useCallback } from "react";

type PcStatus = "online" | "offline" | "waking" | "shutting-down";

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
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
        const res = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
        });
        if (res.ok) {
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

    // Auto-submit on 4th digit
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

// ─── Power Button ────────────────────────────────────────────

function PowerIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      className={className}
    >
      <path d="M12 3v8" />
      <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64" />
    </svg>
  );
}

// ─── Dashboard ───────────────────────────────────────────────

function Dashboard() {
  const [status, setStatus] = useState<PcStatus>("offline");
  const [lastChecked, setLastChecked] = useState<Date>(new Date());
  const [lastCheckedText, setLastCheckedText] = useState("just now");
  const [actionFeedback, setActionFeedback] = useState("");
  const [showProjInput, setShowProjInput] = useState(false);
  const [projName, setProjName] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [wakeLogs, setWakeLogs] = useState<Record<string, unknown>[]>([]);
  const projInputRef = useRef<HTMLInputElement>(null);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      const data = await res.json();
      setStatus((prev) => {
        // Don't override transitional states
        if (prev === "waking" || prev === "shutting-down") return prev;
        return data.status === "online" ? "online" : "offline";
      });
      setLastChecked(new Date());
    } catch {
      setStatus((prev) => {
        if (prev === "waking" || prev === "shutting-down") return prev;
        return "offline";
      });
    }
  }, []);

  // Initial check + polling
  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  // Update "time ago" text every second
  useEffect(() => {
    const interval = setInterval(() => {
      setLastCheckedText(timeAgo(lastChecked));
    }, 1000);
    return () => clearInterval(interval);
  }, [lastChecked]);

  // Clear transitional states after timeout
  useEffect(() => {
    if (status === "waking") {
      const timeout = setTimeout(() => {
        checkStatus();
        setStatus((prev) => (prev === "waking" ? "offline" : prev));
      }, 30000);
      return () => clearTimeout(timeout);
    }
    if (status === "shutting-down") {
      const timeout = setTimeout(() => {
        checkStatus();
        setStatus((prev) => (prev === "shutting-down" ? "online" : prev));
      }, 15000);
      return () => clearTimeout(timeout);
    }
  }, [status, checkStatus]);

  // Check more frequently during transitions
  useEffect(() => {
    if (status === "waking" || status === "shutting-down") {
      const interval = setInterval(checkStatus, 3000);
      return () => clearInterval(interval);
    }
  }, [status, checkStatus]);

  const saveWakeLog = (entry: Record<string, unknown>) => {
    try {
      // Flatten nested log object from API response into top-level
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
      // Wake
      setStatus("waking");
      try {
        const res = await fetch("/api/wake", { method: "POST" });
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
      // Shutdown — confirm first
      if (window.confirm("Shut down PC?")) {
        setStatus("shutting-down");
        try {
          await fetch("/api/shutdown", { method: "POST" });
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

  const handleQuickAction = async (action: string, name?: string) => {
    try {
      setActionFeedback(`Starting ${action}...`);
      const res = await fetch("/api/run", {
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

  const handleProjSubmit = async () => {
    const name = projName.trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      setActionFeedback("Invalid project name");
      setTimeout(() => setActionFeedback(""), 3000);
      return;
    }
    setShowProjInput(false);
    setProjName("");
    await handleQuickAction("proj", name);
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

  const statusText = {
    online: "PC is ON",
    offline: "PC is OFF",
    waking: "Waking up...",
    "shutting-down": "Shutting down...",
  }[status];

  const isTransitioning = status === "waking" || status === "shutting-down";

  return (
    <div className="flex flex-col items-center justify-center min-h-dvh px-6 select-none">
      {/* Power Button */}
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

      {/* Status Text */}
      <p className="mt-8 text-lg font-medium text-white/80 transition-all duration-300">
        {statusText}
      </p>

      {/* Last Checked */}
      <p className="mt-2 text-xs text-white/30">
        Checked {lastCheckedText}
      </p>

      {/* Action Feedback */}
      <div className="h-6 mt-3">
        {actionFeedback && (
          <p className="text-xs text-amber-400/80 animate-pulse">
            {actionFeedback}
          </p>
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
          onClick={() => handleQuickAction("antigravity")}
          className="w-12 h-12 rounded-xl bg-white/5 border border-white/10
            flex items-center justify-center
            hover:bg-white/10 hover:border-white/20
            active:scale-90 transition-all duration-200"
          title="Antigravity"
        >
          <span className="text-xl">🚀</span>
        </button>
        <button
          onClick={() => {
            setShowProjInput(!showProjInput);
            setTimeout(() => projInputRef.current?.focus(), 100);
          }}
          className="w-12 h-12 rounded-xl bg-white/5 border border-white/10
            flex items-center justify-center
            hover:bg-white/10 hover:border-white/20
            active:scale-90 transition-all duration-200"
          title="Open Project"
        >
          <span className="text-xl">📂</span>
        </button>
      </div>

      {/* Wake Logs */}
      <div className="fixed bottom-4 right-4">
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
                {log.errorName ? <div>type: {String(log.errorName)}</div> : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Project Name Input */}
      <div
        className={`
          mt-4 transition-all duration-300 overflow-hidden
          ${status === "online" && showProjInput ? "max-h-20 opacity-100" : "max-h-0 opacity-0"}
        `}
      >
        <form
          onSubmit={(e) => { e.preventDefault(); handleProjSubmit(); }}
          className="flex gap-2"
        >
          <input
            ref={projInputRef}
            type="text"
            value={projName}
            onChange={(e) => setProjName(e.target.value)}
            placeholder="project name"
            className="h-10 px-3 rounded-lg bg-white/5 border border-white/10
              text-sm text-white placeholder-white/30 outline-none
              focus:border-white/30 transition-colors w-40"
          />
          <button
            type="submit"
            className="h-10 px-4 rounded-lg bg-white/10 border border-white/10
              text-sm text-white/80 hover:bg-white/15 hover:border-white/20
              active:scale-95 transition-all"
          >
            Go
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────

export default function Home() {
  const [authenticated, setAuthenticated] = useState(false);
  const [checking, setChecking] = useState(true);

  // Check if already authenticated (cookie exists and is valid)
  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/status");
        if (res.status !== 401) {
          setAuthenticated(true);
        }
      } catch {
        // Not authenticated
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
