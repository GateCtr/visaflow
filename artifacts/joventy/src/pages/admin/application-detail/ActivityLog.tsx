/**
 * ActivityLog — Journal d'activité du dossier.
 */
import { formatDate } from "@/lib/format";
import { Clock } from "lucide-react";

interface LogEntry {
  msg: string;
  time: number;
  author?: string;
}

interface Props {
  logs: LogEntry[];
}

export function ActivityLog({ logs }: Props) {
  if (!logs || logs.length === 0) return null;

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-slate-400 to-slate-500 flex items-center justify-center">
          <Clock className="w-4 h-4 text-white" />
        </div>
        <h2 className="font-semibold text-slate-800 text-sm">Activité</h2>
        <span className="text-[11px] text-slate-400 ml-auto">{logs.length} entrée{logs.length > 1 ? "s" : ""}</span>
      </div>
      <div className="p-6">
        <div className="relative border-l-2 border-slate-100 ml-3 space-y-4">
          {[...logs].reverse().slice(0, 20).map((log, idx) => {
            const m = log.msg.toLowerCase();
            let dotColor = "bg-slate-400";
            if (m.includes("créé") || m.includes("nouveau")) dotColor = "bg-blue-500";
            else if (m.includes("validé") || m.includes("paiement")) dotColor = "bg-emerald-500";
            else if (m.includes("créneau") || m.includes("rendez-vous")) dotColor = "bg-amber-500";
            else if (m.includes("refusé") || m.includes("rejeté")) dotColor = "bg-red-500";
            else if (m.includes("reçu") || m.includes("uploadé")) dotColor = "bg-violet-500";

            return (
              <div key={idx} className="relative pl-5">
                <div className={`absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full ${dotColor} ring-2 ring-white`} />
                <p className="text-sm text-slate-700 leading-relaxed">{log.msg}</p>
                <p className="text-[11px] text-slate-400 mt-0.5">{formatDate(log.time)} · {log.author ?? "système"}</p>
              </div>
            );
          })}
        </div>
        {logs.length > 20 && (
          <p className="text-xs text-slate-400 text-center mt-4">+ {logs.length - 20} entrées plus anciennes</p>
        )}
      </div>
    </div>
  );
}
