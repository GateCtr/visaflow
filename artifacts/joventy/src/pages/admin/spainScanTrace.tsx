/**
 * spainScanTrace.tsx — Composants et helpers partagés pour l'affichage des traces
 * de scan Espagne. Lifté depuis BotLogs.tsx pour être réutilisé par SpainWatcherTab
 * (BotLogs.tsx) et SpainDossierCycles.tsx (détail dossier) SANS dupliquer les
 * définitions d'interfaces ni le markup.
 *
 * SpainScanTraceData doit rester field-compatible avec WorkerSpainTrace
 * (artifacts/slot-hunter/src/spain-dossier-worker.ts).
 */
import { useState, type ReactNode } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import { groupSpainScansByCycle, type SpainScanRow } from "./spainScanGrouping";

// ─── Statuts de scan (dot/badge/icon) ────────────────────────────────────────

export const SCAN_META = {
  found:     { label: "Creneau trouve", dot: "bg-green-500", badge: "bg-green-50 text-green-700 border-green-200",  icon: <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> },
  not_found: { label: "Aucun creneau", dot: "bg-slate-300",  badge: "bg-slate-50 text-slate-600 border-slate-200",  icon: <XCircle className="w-3.5 h-3.5 text-slate-400" /> },
  error:     { label: "Erreur",         dot: "bg-red-500",   badge: "bg-red-50 text-red-700 border-red-200",         icon: <AlertTriangle className="w-3.5 h-3.5 text-red-500" /> },
};

// ─── Helpers date ─────────────────────────────────────────────────────────────

export function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function formatTsFull(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "il y a " + Math.floor(diff / 1000) + "s";
  if (diff < 3_600_000) return "il y a " + Math.floor(diff / 60_000) + " min";
  if (diff < 86_400_000) return "il y a " + Math.floor(diff / 3_600_000) + "h";
  return formatTsFull(ts);
}

// ─── Page capture types ───────────────────────────────────────────────────────

export interface SpainPageCapture {
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  cookies?: string[];
  responseBody?: string;
  responseType?: string;
  timing?: { start: number; end: number; duration: number };
  error?: string;
}

// Component to display a single captured request
export function SpainCaptureItem({ capture, index }: { capture: SpainPageCapture; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const [activeSection, setActiveSection] = useState<"headers" | "response" | "cookies">("headers");

  const statusColor = !capture.status ? "text-slate-400"
    : capture.status < 300 ? "text-green-600"
    : capture.status < 400 ? "text-amber-600"
    : "text-red-600";

  const methodColor = capture.method === "GET" ? "bg-blue-100 text-blue-700"
    : capture.method === "POST" ? "bg-green-100 text-green-700"
    : capture.method === "PUT" ? "bg-amber-100 text-amber-700"
    : capture.method === "DELETE" ? "bg-red-100 text-red-700"
    : "bg-slate-100 text-slate-700";

  // Parse URL to show path only
  let urlPath = capture.url;
  try {
    const u = new URL(capture.url);
    urlPath = u.pathname + u.search;
  } catch { /* keep full */ }

  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      {/* Request summary row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-50 transition-colors text-left"
      >
        {expanded ? <ChevronDown className="w-3 h-3 text-slate-400 shrink-0" /> : <ChevronRight className="w-3 h-3 text-slate-400 shrink-0" />}
        <span className="text-[9px] text-slate-300 font-mono w-4">{index + 1}</span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${methodColor}`}>{capture.method}</span>
        <span className={`text-[10px] font-mono font-semibold ${statusColor}`}>{capture.status ?? "---"}</span>
        <span className="text-[10px] font-mono text-slate-600 truncate flex-1" title={capture.url}>{urlPath}</span>
        {capture.timing && (
          <span className="text-[9px] text-slate-400 font-mono shrink-0">{capture.timing.duration}ms</span>
        )}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-slate-100">
          {/* Section tabs */}
          <div className="flex gap-0.5 bg-slate-50 px-2 py-1 border-b border-slate-100">
            {(["headers", "response", "cookies"] as const).map(section => (
              <button
                key={section}
                onClick={() => setActiveSection(section)}
                className={`px-2.5 py-1 text-[10px] font-medium rounded transition-colors ${
                  activeSection === section ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {section === "headers" ? "Headers" : section === "response" ? "Response" : "Cookies"}
                {section === "cookies" && capture.cookies && capture.cookies.length > 0 && (
                  <span className="ml-1 text-[8px] bg-amber-100 text-amber-700 px-1 rounded-full">{capture.cookies.length}</span>
                )}
              </button>
            ))}
          </div>

          <div className="px-3 py-2 max-h-72 overflow-auto">
            {/* Headers section */}
            {activeSection === "headers" && (
              <div className="space-y-3">
                {/* Full URL */}
                <div>
                  <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider mb-1">URL</p>
                  <p className="text-[10px] font-mono text-purple-600 break-all">{capture.url}</p>
                </div>

                {/* Request Headers */}
                {capture.requestHeaders && Object.keys(capture.requestHeaders).length > 0 && (
                  <div>
                    <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Request Headers</p>
                    <div className="bg-slate-50 rounded border border-slate-100 divide-y divide-slate-100">
                      {Object.entries(capture.requestHeaders).map(([k, v]) => (
                        <div key={k} className="flex gap-2 px-2 py-1">
                          <span className="text-[10px] font-mono font-semibold text-slate-600 shrink-0">{k}:</span>
                          <span className="text-[10px] font-mono text-slate-500 break-all">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Response Headers */}
                {capture.responseHeaders && Object.keys(capture.responseHeaders).length > 0 && (
                  <div>
                    <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Response Headers</p>
                    <div className="bg-slate-50 rounded border border-slate-100 divide-y divide-slate-100">
                      {Object.entries(capture.responseHeaders).map(([k, v]) => (
                        <div key={k} className="flex gap-2 px-2 py-1">
                          <span className="text-[10px] font-mono font-semibold text-teal-700 shrink-0">{k}:</span>
                          <span className="text-[10px] font-mono text-slate-500 break-all">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Response section */}
            {activeSection === "response" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-xs font-bold ${statusColor}`}>{capture.status} {capture.statusText}</span>
                  {capture.responseType && (
                    <span className="text-[9px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{capture.responseType}</span>
                  )}
                </div>
                {capture.responseBody ? (
                  <pre className="text-[10px] font-mono text-slate-600 bg-slate-900/5 rounded-lg px-3 py-2 border border-slate-200 break-all whitespace-pre-wrap max-h-60 overflow-auto leading-relaxed">
                    {(() => {
                      try {
                        return JSON.stringify(JSON.parse(capture.responseBody), null, 2);
                      } catch {
                        return capture.responseBody;
                      }
                    })()}
                  </pre>
                ) : (
                  <p className="text-[10px] text-slate-400 italic">Pas de contenu de réponse capturé</p>
                )}
                {capture.error && (
                  <div className="bg-red-50 border border-red-200 rounded px-2 py-1.5">
                    <p className="text-[10px] font-mono text-red-600">{capture.error}</p>
                  </div>
                )}
              </div>
            )}

            {/* Cookies section */}
            {activeSection === "cookies" && (
              <div>
                {capture.cookies && capture.cookies.length > 0 ? (
                  <div className="bg-slate-50 rounded border border-slate-100 divide-y divide-slate-100">
                    {capture.cookies.map((cookie, i) => (
                      <div key={i} className="px-2 py-1.5">
                        <p className="text-[10px] font-mono text-amber-700 break-all">{cookie}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-slate-400 italic">Aucun cookie capturé</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Scan trace (main/initConfig/service/agenda/datetime/bookings) ────────────

// Component to display Spain scan trace
export interface SpainScanTraceData {
  ipRotations?: number;
  /** Solve CF : reused=true → clearance pris du cache Redis, false → nouveau CapSolver */
  solver?: { reused: boolean; ms: number };
  /** IP Decodo utilisée pour ce cycle */
  ip?: { index: number; total: number; proxy: string };
  main?: {
    bytes: number;
    ok: boolean;
    serviceContainer: boolean;
    dialogConfirm: boolean;
    isSpa?: boolean;
    idSvcText?: boolean;
    fromCache?: boolean;
    cfRay?: string;
  };
  initConfig?: { bytes: number; ok: boolean };
  service?: {
    bytes: number;
    ok: boolean;
    allowAppointment: boolean | null;
    serviceContainer: boolean;
    dialogConfirm: boolean;
    count: number;
    names?: string;
  };
  agendas: Array<{ serviceId: string; serviceName: string; bytes: number; ok: boolean; agendaId?: string; agendaConfirmed?: boolean }>;
  datetimes: Array<{ serviceId: string; serviceName: string; month: string; bytes: number; slots: number; ok: boolean }>;
  bookings: Array<{ applicant: string; status: string; detail?: string; ms?: number; gsfBytes?: number; signinBytes?: number; bktToken?: string; locator?: string }>;
  /** Durée réelle du cycle de scan (ms) */
  scanMs?: number;
}

export function boolBadge(value: boolean | null | undefined, label?: string): ReactNode {
  const v = value === true;
  const nullish = value === null || value === undefined;
  const text = nullish ? "n/a" : v ? "true" : "false";
  const cls = nullish
    ? "bg-slate-50 text-slate-500 border-slate-200"
    : v
      ? "bg-green-50 text-green-700 border-green-200"
      : "bg-red-50 text-red-700 border-red-200";
  return (
    <span className={`inline-flex items-center gap-0.5 text-[9px] font-mono px-1 py-0.5 rounded border ${cls}`}>
      {label ? `${label}=` : ""}{text}
    </span>
  );
}

export function parseSpainScanTrace(raw: string | undefined): SpainScanTraceData | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as SpainScanTraceData; } catch { return null; }
}

/**
 * Pipeline compact — visible SANS dépliage, pour TOUS les scans (found / not_found / error).
 * Chaque étape affiche son état (ok/fail/n/a) + les métriques clés.
 */
export function SpainCycleSteps({ trace }: { trace: SpainScanTraceData }) {
  type StepBadge = { k: string; v: boolean | null | undefined };
  type Step = {
    label: string;
    ok: boolean | null;
    meta?: string;
    sub?: string;
    badges?: StepBadge[];
    color?: "amber" | "blue";
  };

  const steps: Step[] = [];

  // ── Solver CF ──
  if (trace.solver !== undefined) {
    steps.push({
      label: trace.solver.reused ? "cf↩" : "cf✨",
      ok: true,
      meta: `${(trace.solver.ms / 1000).toFixed(1)}s`,
      color: trace.solver.reused ? "blue" : undefined,
    });
  }

  // ── IP Decodo ──
  if (trace.ip !== undefined) {
    steps.push({
      label: "ip",
      ok: null,
      meta: trace.ip.proxy,
      color: "blue",
    });
  }

  // ── /main/ ──
  if (trace.main) {
    steps.push({
      label: "main",
      ok: trace.main.ok,
      meta: trace.main.bytes >= 1024
        ? `${(trace.main.bytes / 1024).toFixed(0)}kB`
        : `${trace.main.bytes}B`,
      badges: [
        { k: "sc", v: trace.main.serviceContainer },
        { k: "dc", v: trace.main.dialogConfirm },
        ...(trace.main.isSpa !== undefined ? [{ k: "spa", v: trace.main.isSpa }] : []),
      ],
    });
  }

  // ── initConfig ──
  if (trace.initConfig) {
    steps.push({
      label: "cfg",
      ok: trace.initConfig.ok,
      meta: trace.initConfig.bytes > 0 ? `${trace.initConfig.bytes}B` : undefined,
    });
  }

  // ── getservices/ ──
  if (trace.service) {
    steps.push({
      label: "svc",
      ok: trace.service.ok,
      meta: `×${trace.service.count}`,
      badges: [
        { k: "aa", v: trace.service.allowAppointment },
      ],
    });
  }

  // ── agenda ──
  if (trace.agendas.length > 0) {
    const okCount = trace.agendas.filter(a => a.ok).length;
    steps.push({
      label: "agenda",
      ok: okCount > 0,
      meta: `×${trace.agendas.length}`,
    });
  }

  // ── datetime ──
  if (trace.datetimes.length > 0) {
    const totalSlots = trace.datetimes.reduce((n, d) => n + d.slots, 0);
    steps.push({
      label: "datetime",
      ok: totalSlots > 0,
      meta: `${totalSlots} crén.`,
      sub: `×${trace.datetimes.length} mois`,
    });
  }

  // ── booking ──
  if (trace.bookings.length > 0) {
    const bookedCount = trace.bookings.filter(b => b.status === "booked").length;
    steps.push({
      label: "booking",
      ok: bookedCount > 0,
      meta: `×${trace.bookings.length}`,
      color: bookedCount === 0 ? "amber" : undefined,
    });
  }

  // ── rotations IP ──
  if ((trace.ipRotations ?? 0) > 0) {
    steps.push({
      label: "rot",
      ok: null,
      meta: `×${trace.ipRotations}`,
      color: "blue",
    });
  }

  // ── Durée totale du cycle ──
  if (trace.scanMs !== undefined) {
    steps.push({
      label: "⏱",
      ok: null,
      meta: trace.scanMs >= 1000 ? `${(trace.scanMs / 1000).toFixed(1)}s` : `${trace.scanMs}ms`,
      color: "blue",
    });
  }

  if (steps.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-0.5">
      {steps.map((step, i) => {
        const base = step.color === "amber"
          ? "bg-amber-50 text-amber-700 border-amber-200"
          : step.color === "blue"
            ? "bg-blue-50 text-blue-600 border-blue-100"
            : step.ok === true
              ? "bg-green-50 text-green-700 border-green-100"
              : step.ok === false
                ? "bg-red-50 text-red-600 border-red-100"
                : "bg-slate-50 text-slate-500 border-slate-200";

        return (
          <span key={i} className="inline-flex items-center gap-0.5">
            {i > 0 && <span className="text-slate-300 text-[8px] mx-0.5">→</span>}
            <span className={`inline-flex items-center gap-0.5 text-[9px] font-mono px-1 py-0.5 rounded border ${base}`}>
              <span className="font-semibold">{step.label}</span>
              {step.meta && <span className="opacity-75">{step.meta}</span>}
              {step.sub && <span className="opacity-50 text-[8px]">{step.sub}</span>}
              {step.badges?.map((b, j) => (
                <span
                  key={j}
                  className={`text-[8px] ml-0.5 ${
                    b.v === true ? "text-green-600" : b.v === false ? "text-red-500" : "text-slate-400"
                  }`}
                >
                  {b.k}={b.v === true ? "✓" : b.v === false ? "✗" : "?"}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export function SpainScanTraceBlock({ scanTrace }: { scanTrace: string }) {
  const [expanded, setExpanded] = useState(false);
  const trace = parseSpainScanTrace(scanTrace);
  if (!trace) return null;

  const hasContent = trace.main || trace.initConfig || trace.service
    || trace.agendas.length > 0 || trace.datetimes.length > 0 || trace.bookings.length > 0
    || (trace.ipRotations ?? 0) > 0;
  if (!hasContent) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-[10px] font-medium text-violet-600 hover:text-violet-800 transition-colors"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span>Trace scan</span>
        {trace.main && (
          <span className={`text-[9px] px-1 py-0.5 rounded-full ${trace.main.ok ? "bg-green-50 text-green-600" : "bg-red-50 text-red-600"}`}>
            main {trace.main.bytes}B
          </span>
        )}
        {trace.bookings.length > 0 && (
          <span className="text-[9px] px-1 py-0.5 rounded-full bg-amber-50 text-amber-700">
            {trace.bookings.length} booking
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 text-[10px] font-mono">
          {(trace.ipRotations ?? 0) > 0 && (
            <p className="text-slate-500">ipRotations={trace.ipRotations}</p>
          )}

          {/* Solver CF + IP */}
          {(trace.solver !== undefined || trace.ip !== undefined) && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-2">
              <p className="font-semibold text-slate-700 mb-1">Session init</p>
              <div className="flex flex-wrap gap-1">
                {trace.solver !== undefined && (
                  <>
                    {boolBadge(trace.solver.reused, "cfCached")}
                    <span className="text-slate-500">{(trace.solver.ms / 1000).toFixed(1)}s</span>
                  </>
                )}
                {trace.ip !== undefined && (
                  <span className="text-slate-500 break-all">ip={trace.ip.proxy}</span>
                )}
              </div>
            </div>
          )}

          {trace.main && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-2">
              <p className="font-semibold text-slate-700 mb-1">/main/</p>
              <div className="flex flex-wrap gap-1">
                <span className="text-slate-600">{trace.main.bytes}B</span>
                {boolBadge(trace.main.ok, "ok")}
                {boolBadge(trace.main.serviceContainer, "serviceContainer")}
                {boolBadge(trace.main.dialogConfirm, "dialogConfirm")}
                {trace.main.isSpa !== undefined && boolBadge(trace.main.isSpa, "isSpa")}
                {trace.main.fromCache !== undefined && boolBadge(trace.main.fromCache, "fromCache")}
                {trace.main.cfRay && <span className="text-slate-400">cfRay={trace.main.cfRay}</span>}
              </div>
            </div>
          )}

          {trace.initConfig && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-2">
              <p className="font-semibold text-slate-700 mb-1">initConfig</p>
              <div className="flex flex-wrap gap-1">
                <span className="text-slate-600">{trace.initConfig.bytes}B</span>
                {boolBadge(trace.initConfig.ok, "ok")}
              </div>
            </div>
          )}

          {trace.service && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-2">
              <p className="font-semibold text-slate-700 mb-1">getservices/</p>
              <div className="flex flex-wrap gap-1 mb-1">
                <span className="text-slate-600">{trace.service.bytes}B · {trace.service.count} svc</span>
                {boolBadge(trace.service.ok, "ok")}
                {boolBadge(trace.service.allowAppointment, "allowAppointment")}
                {boolBadge(trace.service.serviceContainer, "serviceContainer")}
                {boolBadge(trace.service.dialogConfirm, "dialogConfirm")}
              </div>
              {trace.service.names && (
                <p className="text-[9px] text-slate-500 break-all">{trace.service.names}</p>
              )}
            </div>
          )}

          {trace.agendas.length > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-2">
              <p className="font-semibold text-slate-700 mb-1">agenda ({trace.agendas.length})</p>
              <div className="space-y-0.5">
                {trace.agendas.map((a, i) => (
                  <p key={i} className={`text-[9px] ${a.ok ? "text-slate-600" : "text-red-500"}`}>
                    {a.serviceName} #{a.serviceId} — {a.bytes}B{a.agendaId ? ` · ${a.agendaId}` : ""}
                    {a.agendaId && a.agendaConfirmed === false && (
                      <span className="ml-1 text-amber-600 font-semibold">(fallback)</span>
                    )}
                    {a.agendaId && a.agendaConfirmed === true && (
                      <span className="ml-1 text-emerald-600">(rendu)</span>
                    )}
                  </p>
                ))}
              </div>
            </div>
          )}

          {trace.datetimes.length > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-2">
              <p className="font-semibold text-slate-700 mb-1">datetime ({trace.datetimes.length})</p>
              <div className="space-y-0.5 max-h-32 overflow-y-auto">
                {trace.datetimes.map((d, i) => (
                  <p key={i} className={`text-[9px] ${d.ok ? "text-slate-600" : "text-red-500"}`}>
                    {d.serviceName} · {d.month} — {d.bytes}B · {d.slots} créneau(x)
                  </p>
                ))}
              </div>
            </div>
          )}

          {trace.bookings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2">
              <p className="font-semibold text-amber-800 mb-1">bookings ({trace.bookings.length})</p>
              <div className="space-y-0.5">
                {trace.bookings.map((b, i) => (
                  <div key={i} className={`text-[9px] ${b.status === "booked" ? "text-green-700" : "text-red-600"}`}>
                    <p>
                      {b.applicant}: {b.status}{b.ms ? ` (${b.ms}ms)` : ""}{b.detail ? ` — ${b.detail}` : ""}
                    </p>
                    {(b.gsfBytes !== undefined || b.signinBytes !== undefined || b.bktToken || b.locator) && (
                      <p className="text-[8px] text-slate-500 ml-2">
                        {b.gsfBytes !== undefined && `gsf=${b.gsfBytes}B `}
                        {b.signinBytes !== undefined && `signin=${b.signinBytes}B `}
                        {b.bktToken && `token=${b.bktToken} `}
                        {b.locator && <span className="text-green-600 font-bold">locator={b.locator}</span>}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Component to display all page captures for a scan
export function SpainPageCapturesBlock({ pageCaptures }: { pageCaptures: string }) {
  const [showCaptures, setShowCaptures] = useState(false);
  const [filterMethod, setFilterMethod] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");

  let captures: SpainPageCapture[] = [];
  try { captures = JSON.parse(pageCaptures) as SpainPageCapture[]; } catch { /* noop */ }

  if (!captures.length) return null;

  const filtered = captures.filter(c => {
    if (filterMethod && c.method !== filterMethod) return false;
    if (filterStatus === "2xx" && (!c.status || c.status >= 300)) return false;
    if (filterStatus === "3xx" && (!c.status || c.status < 300 || c.status >= 400)) return false;
    if (filterStatus === "4xx" && (!c.status || c.status < 400 || c.status >= 500)) return false;
    if (filterStatus === "5xx" && (!c.status || c.status < 500)) return false;
    if (filterStatus === "error" && !c.error) return false;
    return true;
  });

  // Stats
  const methods = [...new Set(captures.map(c => c.method))];
  const successCount = captures.filter(c => c.status && c.status < 300).length;
  const errorCount = captures.filter(c => c.error || (c.status && c.status >= 400)).length;

  return (
    <div className="mt-2">
      <button
        onClick={() => setShowCaptures(!showCaptures)}
        className="flex items-center gap-2 text-[10px] font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
      >
        {showCaptures ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span className="flex items-center gap-1.5">
          Réseau & Requêtes
          <span className="bg-indigo-50 text-indigo-600 px-1.5 py-0.5 rounded-full text-[9px] font-bold">{captures.length}</span>
          {successCount > 0 && <span className="bg-green-50 text-green-600 px-1 py-0.5 rounded-full text-[9px]">{successCount} ok</span>}
          {errorCount > 0 && <span className="bg-red-50 text-red-600 px-1 py-0.5 rounded-full text-[9px]">{errorCount} err</span>}
        </span>
      </button>

      {showCaptures && (
        <div className="mt-2 space-y-2">
          {/* Filters */}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={filterMethod}
              onChange={e => setFilterMethod(e.target.value)}
              className="text-[10px] border border-slate-200 rounded px-1.5 py-1 bg-white text-slate-600"
            >
              <option value="">Toutes méthodes</option>
              {methods.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="text-[10px] border border-slate-200 rounded px-1.5 py-1 bg-white text-slate-600"
            >
              <option value="">Tous statuts</option>
              <option value="2xx">2xx (OK)</option>
              <option value="3xx">3xx (Redirect)</option>
              <option value="4xx">4xx (Client err)</option>
              <option value="5xx">5xx (Server err)</option>
              <option value="error">Erreurs</option>
            </select>
            <span className="text-[9px] text-slate-400">{filtered.length}/{captures.length} requêtes</span>
          </div>

          {/* Request list */}
          <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
            {filtered.map((capture, i) => (
              <SpainCaptureItem key={i} capture={capture} index={i} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Corps d'une ligne de scan ────────────────────────────────────────────────

/**
 * Rend le contenu d'une ligne de scan Espagne : badge statut + dossier + horodatage,
 * screenshot, pipeline SpainCycleSteps, services/créneaux détectés, message d'erreur
 * (avec dépliage), bloc trace scan et captures réseau.
 *
 * Partagé entre SpainWatcherTab (BotLogs.tsx) et SpainDossierCycles.tsx pour éviter
 * toute divergence de markup.
 */
export function SpainScanRowBody({ scan }: { scan: SpainScanRow }) {
  const [isErrorExpanded, setIsErrorExpanded] = useState(false);
  const meta = SCAN_META[scan.status as keyof typeof SCAN_META] ?? SCAN_META.error;

  return (
    <div className={`py-3 ${scan.status === "found" ? "border-l-4 border-l-green-400 pl-3" : ""}`}>
      <div className="flex items-start gap-3">
        <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${meta.dot}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded border ${meta.badge}`}>
              {meta.icon} {meta.label}
            </span>
            {scan.dossierName && (
              <span className="text-[10px] font-semibold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                {scan.dossierName}
              </span>
            )}
            <span className="text-[10px] text-slate-400 tabular-nums">{relativeTime(scan.ts)}</span>
            <span className="text-[10px] text-slate-300 tabular-nums hidden sm:inline">{formatTsFull(scan.ts)}</span>
            {scan.screenshotUrl && (
              <a href={scan.screenshotUrl} target="_blank" rel="noopener noreferrer"
                className="ml-auto text-[10px] text-red-600 hover:text-red-800 flex items-center gap-1 font-medium">
                <ExternalLink className="w-3 h-3" /> Screenshot
              </a>
            )}
          </div>
          {/* Pipeline étapes — visible pour TOUS les scans (found / not_found / error) */}
          {scan.scanTrace && (() => {
            const t = parseSpainScanTrace(scan.scanTrace);
            return t ? <SpainCycleSteps trace={t} /> : null;
          })()}

          {/* Detected services for "found" */}
          {scan.status === "found" && scan.detectedServices && (() => {
            try {
              const services = JSON.parse(scan.detectedServices) as Array<{serviceId: string; serviceName: string}>;
              if (services.length > 0) {
                return (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {services.map((svc, i) => (
                      <span key={i} className="inline-flex items-center gap-1 text-[10px] bg-green-100 text-green-800 px-1.5 py-0.5 rounded border border-green-200">
                        🎯 {svc.serviceName} <span className="text-green-500">#{svc.serviceId}</span>
                      </span>
                    ))}
                  </div>
                );
              }
              return null;
            } catch { return null; }
          })()}

          {scan.status === "found" && !scan.detectedServices && (
            <p className="text-[10px] text-amber-600 mt-1">⚠️ Aucun service extrait — possible faux positif</p>
          )}

          {/* Detected slots — dates/heures exactes + distinction placeholder vs confirmé */}
          {scan.status === "found" && scan.detectedSlots && (() => {
            try {
              const svcSlots = JSON.parse(scan.detectedSlots) as Array<{id: string; name: string; slots: Array<{d: string; t: string; n: number}>}>;
              if (svcSlots.length === 0) return null;
              return (
                <div className="mt-2 space-y-2">
                  {svcSlots.map((svc, i) => (
                    <div key={i} className="bg-green-50/50 border border-green-100 rounded-lg p-2">
                      <p className="text-[10px] font-semibold text-green-800 mb-1">📋 {svc.name} <span className="text-green-500 font-normal">#{svc.id}</span></p>
                      {svc.slots.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {svc.slots.slice(0, 15).map((slot, j) => {
                            // Distinguer heure confirmée vs placeholder "09:00"
                            const isPlaceholder = slot.t === "09:00";
                            const hasPlaces = slot.n > 0;
                            return (
                              <span
                                key={j}
                                title={isPlaceholder ? "Heure non confirmée par le serveur (placeholder)" : `Heure confirmée${hasPlaces ? ` · ${slot.n} place(s) libre(s)` : ""}`}
                                className={`inline-flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded border font-mono ${
                                  isPlaceholder
                                    ? "bg-amber-50 text-amber-800 border-amber-200"
                                    : "bg-white text-green-900 border-green-200"
                                }`}
                              >
                                <span className="text-[8px] opacity-60">{slot.d}</span>
                                <span className={isPlaceholder ? "text-amber-600 italic" : "text-green-600 font-semibold"}>
                                  {isPlaceholder ? `~${slot.t}` : slot.t}
                                </span>
                                <span className={`ml-0.5 ${hasPlaces ? "text-green-500" : "text-slate-400"}`}>
                                  ({hasPlaces ? `${slot.n}p` : "?p"})
                                </span>
                              </span>
                            );
                          })}
                          {svc.slots.length > 15 && (
                            <span className="text-[9px] text-green-500 self-center">+{svc.slots.length - 15} autres</span>
                          )}
                        </div>
                      ) : (
                        <p className="text-[9px] text-green-600 italic">Aucun créneau datetime trouvé</p>
                      )}
                    </div>
                  ))}
                </div>
              );
            } catch { return null; }
          })()}

          {/* Error message with expand toggle */}
          {scan.errorMessage && (
            <div className="mt-1">
              {scan.errorMessage.length > 120 && !isErrorExpanded ? (
                <div className="flex items-start gap-1">
                  <p className="text-[10px] font-mono text-red-500 truncate flex-1">{scan.errorMessage}</p>
                  <button onClick={() => setIsErrorExpanded(true)} className="text-[9px] text-red-400 hover:text-red-600 shrink-0 underline">
                    voir +
                  </button>
                </div>
              ) : scan.errorMessage.length > 120 ? (
                <div>
                  <p className="text-[10px] font-mono text-red-500 whitespace-pre-wrap break-all">{scan.errorMessage}</p>
                  <button onClick={() => setIsErrorExpanded(false)} className="text-[9px] text-red-400 hover:text-red-600 underline mt-0.5">
                    réduire
                  </button>
                </div>
              ) : (
                <p className="text-[10px] font-mono text-red-500">{scan.errorMessage}</p>
              )}
            </div>
          )}

          {/* Scan trace — main/initConfig/service/agenda/datetime/bookings */}
          {scan.scanTrace && <SpainScanTraceBlock scanTrace={scan.scanTrace} />}

          {/* Page captures - network requests, headers, responses, cookies */}
          {scan.pageCaptures && <SpainPageCapturesBlock pageCaptures={scan.pageCaptures} />}
        </div>
      </div>
    </div>
  );
}

// ─── Vue groupée par fenêtre / cycle ──────────────────────────────────────────

/** Statut représentatif d'un cycle (found > error > not_found) pour le point d'état. */
function cycleStatus(scans: SpainScanRow[]): keyof typeof SCAN_META {
  if (scans.some(s => s.status === "found")) return "found";
  if (scans.some(s => s.status === "error")) return "error";
  return "not_found";
}

/**
 * Rend une liste de scans groupée par fenêtre (en-tête « Fenêtre HH:MM — N cycles »)
 * puis par cycle (badge « Cycle N » ou « Hors cycle » + point de statut), chaque
 * cycle affichant le corps SpainScanRowBody de ses scans.
 *
 * Partagé entre SpainWatcherTab (BotLogs.tsx) et SpainDossierCycles.tsx.
 */
export function SpainCycleGroupedList({ scans }: { scans: SpainScanRow[] }) {
  const windows = groupSpainScansByCycle(scans);

  return (
    <div className="space-y-4">
      {windows.map((win) => (
        <div key={win.windowId ?? "hors-cycle"} className="rounded-xl border border-slate-200 overflow-hidden">
          {/* En-tête de fenêtre */}
          <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200">
            <span className="text-xs font-semibold text-slate-700">
              {win.windowId === null ? "Hors cycle" : `Fenêtre ${win.windowLabel}`}
            </span>
            {win.windowId !== null && (
              <span className="text-[10px] text-slate-500 bg-white px-1.5 py-0.5 rounded-full border border-slate-200">
                {win.cycleCount} {win.cycleCount > 1 ? "cycles" : "cycle"}
              </span>
            )}
          </div>

          {/* Cycles */}
          <div className="divide-y divide-slate-100">
            {win.cycles.map((cycle) => {
              const meta = SCAN_META[cycleStatus(cycle.scans)];
              return (
                <div key={cycle.cycleNumber ?? "hors-cycle"} className="px-3 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} />
                    <span className="text-[11px] font-semibold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                      {cycle.cycleNumber === null ? "Hors cycle" : `Cycle ${cycle.cycleNumber}`}
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {cycle.scans.length} {cycle.scans.length > 1 ? "lignes" : "ligne"}
                    </span>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {cycle.scans.map((scan) => (
                      <SpainScanRowBody key={scan._id} scan={scan} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
