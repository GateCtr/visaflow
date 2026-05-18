/**
 * Countdown vers la prochaine session de scan du hunter.
 */
import { useState, useEffect } from "react";
import { Clock, Pause, RefreshCw } from "lucide-react";

interface Props {
  endedAt: string;
  urgencyTier: string;
  isActive: boolean;
}

const TIER_INTERVALS: Record<string, { min: number; max: number }> = {
  tres_urgent: { min: 3 * 60_000, max: 5 * 60_000 },
  urgent: { min: 15 * 60_000, max: 20 * 60_000 },
  prioritaire: { min: 25 * 60_000, max: 35 * 60_000 },
  standard: { min: 45 * 60_000, max: 60 * 60_000 },
};

export function NextSessionCountdown({ endedAt, urgencyTier, isActive }: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isActive]);

  if (!isActive) {
    return (
      <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-50 border border-slate-200/80">
        <Pause className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-xs text-slate-500 font-medium">Hunter en pause</span>
      </div>
    );
  }

  const interval = TIER_INTERVALS[urgencyTier] ?? TIER_INTERVALS.standard;
  const avgInterval = (interval.min + interval.max) / 2;
  const endedAtMs = new Date(endedAt).getTime();
  const nextSessionAt = endedAtMs + avgInterval;
  const remaining = nextSessionAt - now;

  if (remaining <= 0) {
    return (
      <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-200/80 animate-pulse">
        <RefreshCw className="w-3.5 h-3.5 text-blue-600 animate-spin" />
        <span className="text-xs text-blue-700 font-medium">Prochaine session imminente...</span>
      </div>
    );
  }

  const mins = Math.floor(remaining / 60_000);
  const secs = Math.floor((remaining % 60_000) / 1000);
  const display = mins > 0 ? `${mins}m ${secs.toString().padStart(2, "0")}s` : `${secs}s`;
  const progress = Math.max(0, Math.min(100, ((avgInterval - remaining) / avgInterval) * 100));

  return (
    <div className="mt-3 px-3 py-2.5 rounded-lg bg-indigo-50/80 border border-indigo-200/60">
      <div className="flex items-center gap-2">
        <Clock className="w-3.5 h-3.5 text-indigo-600" />
        <span className="text-xs text-indigo-700 font-semibold">Prochaine session dans {display}</span>
        <span className="text-[10px] text-indigo-400 ml-auto font-mono">{urgencyTier}</span>
      </div>
      <div className="mt-2 h-1.5 bg-indigo-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-indigo-400 to-indigo-600 rounded-full transition-all duration-1000"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
