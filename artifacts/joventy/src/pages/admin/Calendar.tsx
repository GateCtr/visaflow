import { useState, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight, CalendarDays, MapPin, Clock, User, List, Grid3X3, BarChart3, Eye, EyeOff, TrendingUp, Download } from "lucide-react";

const DEST_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  usa:      { bg: "bg-blue-100",   text: "text-blue-800",   dot: "bg-blue-500" },
  schengen: { bg: "bg-indigo-100", text: "text-indigo-800", dot: "bg-indigo-500" },
  spain:    { bg: "bg-red-100",    text: "text-red-800",    dot: "bg-red-500" },
  dubai:    { bg: "bg-amber-100",  text: "text-amber-800",  dot: "bg-amber-500" },
  turkey:   { bg: "bg-rose-100",   text: "text-rose-800",   dot: "bg-rose-500" },
  india:    { bg: "bg-orange-100", text: "text-orange-800", dot: "bg-orange-500" },
  germany:  { bg: "bg-yellow-100", text: "text-yellow-800", dot: "bg-yellow-500" },
};

const DEST_LABELS: Record<string, string> = {
  usa: "USA 🇺🇸", schengen: "Schengen 🇪🇺", spain: "Espagne 🇪🇸", dubai: "Dubaï 🇦🇪",
  turkey: "Turquie 🇹🇷", india: "Inde 🇮🇳", germany: "Allemagne 🇩🇪",
};

const MONTHS = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
const DAYS_SHORT = ["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"];

type Appointment = {
  _id: string;
  applicantName: string;
  destination: string;
  visaType: string;
  status: string;
  date: string;
  time?: string;
  location?: string;
  confirmationCode?: string;
  userEmail?: string;
};

function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!isNaN(y) && !isNaN(m) && !isNaN(d)) return new Date(y, m - 1, d);
  const parsed = new Date(dateStr);
  return isNaN(parsed.getTime()) ? new Date() : parsed;
}

function toISODateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function AppointmentCard({ app, compact = false }: { app: Appointment; compact?: boolean }) {
  const colors = DEST_COLORS[app.destination] ?? { bg: "bg-slate-100", text: "text-slate-700", dot: "bg-slate-400" };
  const isCompleted = app.status === "completed";

  return (
    <Link href={`/admin/applications/${app._id}`}>
      <div className={`rounded-xl border p-3 hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer ${isCompleted ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}>
        <div className="flex items-start gap-2">
          <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${colors.bg} ${colors.text} flex-shrink-0`}>
            <span className={`w-1.5 h-1.5 rounded-full ${colors.dot} inline-block`} />
            {DEST_LABELS[app.destination] ?? app.destination.toUpperCase()}
          </span>
          <span className={`ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0 ${isCompleted ? "bg-green-200 text-green-800" : "bg-amber-200 text-amber-800"}`}>
            {isCompleted ? "Complété" : "Prime en attente"}
          </span>
        </div>
        <p className="text-sm font-bold text-primary mt-2 leading-tight">{app.applicantName}</p>
        {!compact && <p className="text-xs text-muted-foreground mt-0.5">{app.visaType}</p>}
        <div className="mt-2 space-y-1">
          {app.time && (
            <p className="text-xs text-slate-600 flex items-center gap-1">
              <Clock className="w-3 h-3" /> {app.time}
            </p>
          )}
          {app.location && (
            <p className="text-xs text-slate-600 flex items-center gap-1 leading-tight">
              <MapPin className="w-3 h-3 flex-shrink-0" /> <span className="truncate">{app.location}</span>
            </p>
          )}
        </div>
        {app.confirmationCode && (
          <p className="text-[10px] text-slate-400 mt-1.5 font-mono">#{app.confirmationCode}</p>
        )}
      </div>
    </Link>
  );
}

export default function AdminCalendar() {
  const data = useQuery(api.admin.getCalendarData);
  const [modeFilter, setModeFilter] = useState<"schedule" | "reschedule" | undefined>(undefined);
  const [destFilter, setDestFilter] = useState<string | undefined>(undefined);
  const discoverySince = useMemo(() => Date.now() - 7 * 24 * 60 * 60 * 1000, []);
  const discoveryStats = useQuery(api.slotDiscoveries.getStats, {
    since: discoverySince,
    ...(modeFilter ? { mode: modeFilter } : {}),
    ...(destFilter ? { destination: destFilter } : {}),
  });
  const today = new Date();
  const [viewDate, setViewDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState<string | null>(toISODateKey(today));
  const [view, setView] = useState<"month" | "list" | "discoveries">("month");

  const appointments = useMemo<Appointment[]>(() => data ?? [], [data]);

  const byDate = useMemo(() => {
    const map: Record<string, Appointment[]> = {};
    for (const a of appointments) {
      const key = toISODateKey(parseLocalDate(a.date));
      if (!map[key]) map[key] = [];
      map[key].push(a);
    }
    return map;
  }, [appointments]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);

  const startDow = (firstDay.getDay() + 6) % 7;
  const cells: (Date | null)[] = [
    ...Array(startDow).fill(null),
    ...Array.from({ length: lastDay.getDate() }, (_, i) => new Date(year, month, i + 1)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));

  const selectedApps = selectedDay ? (byDate[selectedDay] ?? []) : [];

  const upcoming = useMemo(() => {
    const todayKey = toISODateKey(today);
    return appointments
      .filter((a) => toISODateKey(parseLocalDate(a.date)) >= todayKey)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [appointments, today]);

  const past = useMemo(() => {
    const todayKey = toISODateKey(today);
    return appointments
      .filter((a) => toISODateKey(parseLocalDate(a.date)) < todayKey)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [appointments, today]);

  if (data === undefined) {
    return <div className="p-12 text-center text-muted-foreground">Chargement du calendrier…</div>;
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
            <CalendarDays className="w-6 h-6 text-secondary" /> Calendrier des RDV
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {appointments.length} rendez-vous confirmés au total
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView("month")}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${view === "month" ? "bg-primary text-white shadow" : "bg-white border border-border text-slate-600 hover:bg-slate-50"}`}
          >
            <Grid3X3 className="w-4 h-4" /> Mois
          </button>
          <button
            onClick={() => setView("list")}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${view === "list" ? "bg-primary text-white shadow" : "bg-white border border-border text-slate-600 hover:bg-slate-50"}`}
          >
            <List className="w-4 h-4" /> Liste
          </button>
          <button
            onClick={() => setView("discoveries")}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${view === "discoveries" ? "bg-primary text-white shadow" : "bg-white border border-border text-slate-600 hover:bg-slate-50"}`}
          >
            <BarChart3 className="w-4 h-4" /> Découvertes
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-xs">
        {Object.entries(DEST_LABELS).map(([key, label]) => {
          const c = DEST_COLORS[key];
          return (
            <span key={key} className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full ${c.bg} ${c.text} font-semibold`}>
              <span className={`w-2 h-2 rounded-full ${c.dot}`} />
              {label}
            </span>
          );
        })}
      </div>

      {view === "month" ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Calendar grid */}
          <div className="lg:col-span-2 bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
            {/* Nav */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <button onClick={prevMonth} className="w-9 h-9 rounded-xl hover:bg-slate-100 flex items-center justify-center transition-colors">
                <ChevronLeft className="w-5 h-5 text-slate-500" />
              </button>
              <h2 className="text-lg font-bold text-primary">{MONTHS[month]} {year}</h2>
              <button onClick={nextMonth} className="w-9 h-9 rounded-xl hover:bg-slate-100 flex items-center justify-center transition-colors">
                <ChevronRight className="w-5 h-5 text-slate-500" />
              </button>
            </div>

            {/* Day headers */}
            <div className="grid grid-cols-7 border-b border-border">
              {DAYS_SHORT.map((d) => (
                <div key={d} className="py-2 text-center text-xs font-bold text-muted-foreground uppercase tracking-wider">
                  {d}
                </div>
              ))}
            </div>

            {/* Cells */}
            <div className="grid grid-cols-7">
              {cells.map((date, idx) => {
                if (!date) return <div key={idx} className="h-16 sm:h-20 border-b border-r border-border/50 bg-slate-50/50" />;

                const key = toISODateKey(date);
                const dayApps = byDate[key] ?? [];
                const isToday = toISODateKey(date) === toISODateKey(today);
                const isSelected = key === selectedDay;
                const isCurrentMonth = date.getMonth() === month;

                return (
                  <div
                    key={idx}
                    onClick={() => setSelectedDay(isSelected ? null : key)}
                    className={`h-16 sm:h-20 border-b border-r border-border/50 p-1 cursor-pointer transition-all flex flex-col
                      ${isSelected ? "bg-primary/5 ring-2 ring-inset ring-primary/30" : "hover:bg-slate-50"}
                      ${!isCurrentMonth ? "opacity-30" : ""}`}
                  >
                    <span className={`text-xs font-bold self-start w-6 h-6 flex items-center justify-center rounded-full mb-1
                      ${isToday ? "bg-primary text-white" : isSelected ? "text-primary" : "text-slate-600"}`}>
                      {date.getDate()}
                    </span>
                    <div className="flex flex-wrap gap-0.5">
                      {dayApps.slice(0, 3).map((a, i) => {
                        const c = DEST_COLORS[a.destination] ?? { dot: "bg-slate-400" };
                        return <span key={i} className={`w-2 h-2 rounded-full ${c.dot}`} />;
                      })}
                      {dayApps.length > 3 && (
                        <span className="text-[9px] text-muted-foreground font-bold">+{dayApps.length - 3}</span>
                      )}
                    </div>
                    {dayApps.length > 0 && (
                      <span className="text-[9px] text-slate-500 mt-auto hidden sm:block">
                        {dayApps.length} RDV
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Day detail panel */}
          <div className="space-y-4">
            {selectedDay ? (
              <>
                <div className="bg-white rounded-2xl border border-border shadow-sm p-4">
                  <h3 className="text-sm font-bold text-primary mb-1">
                    {parseLocalDate(selectedDay).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                  </h3>
                  <p className="text-xs text-muted-foreground">{selectedApps.length} rendez-vous</p>
                </div>
                {selectedApps.length > 0 ? (
                  <div className="space-y-3">
                    {selectedApps.map((a) => <AppointmentCard key={a._id} app={a} />)}
                  </div>
                ) : (
                  <div className="bg-white rounded-2xl border border-border p-8 text-center text-muted-foreground text-sm">
                    <CalendarDays className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                    Aucun rendez-vous ce jour
                  </div>
                )}
              </>
            ) : (
              <div className="bg-white rounded-2xl border border-border p-8 text-center text-muted-foreground text-sm">
                <CalendarDays className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                Cliquez sur un jour pour voir les rendez-vous
              </div>
            )}
          </div>
        </div>
      ) : view === "list" ? (
        /* List view */
        <div className="space-y-8">
          {upcoming.length > 0 && (
            <div>
              <h2 className="text-base font-bold text-primary mb-4 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                À venir ({upcoming.length})
              </h2>
              <div className="space-y-3">
                {upcoming.map((a) => {
                  const colors = DEST_COLORS[a.destination] ?? { bg: "bg-slate-100", text: "text-slate-700", dot: "bg-slate-400" };
                  return (
                    <Link href={`/admin/applications/${a._id}`} key={a._id}>
                      <div className="bg-white rounded-2xl border border-border shadow-sm p-4 hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer flex items-center gap-4">
                        <div className="text-center min-w-[56px] bg-primary/5 rounded-xl p-2">
                          <p className="text-[10px] text-muted-foreground uppercase font-bold">{MONTHS[parseLocalDate(a.date).getMonth()].slice(0, 3)}</p>
                          <p className="text-2xl font-bold text-primary leading-none">{parseLocalDate(a.date).getDate()}</p>
                          <p className="text-[10px] text-muted-foreground">{parseLocalDate(a.date).getFullYear()}</p>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${colors.bg} ${colors.text}`}>
                              {DEST_LABELS[a.destination] ?? a.destination.toUpperCase()}
                            </span>
                            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${a.status === "completed" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                              {a.status === "completed" ? "Complété" : "Prime en attente"}
                            </span>
                          </div>
                          <p className="font-bold text-primary truncate">{a.applicantName}</p>
                          <p className="text-xs text-muted-foreground truncate">{a.visaType}</p>
                        </div>
                        <div className="text-right hidden sm:block flex-shrink-0">
                          {a.time && <p className="text-sm font-bold text-primary">{a.time}</p>}
                          {a.location && <p className="text-xs text-muted-foreground max-w-[160px] text-right">{a.location}</p>}
                        </div>
                        <div className="flex items-center">
                          <User className="w-4 h-4 text-slate-300" />
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          {past.length > 0 && (
            <div>
              <h2 className="text-base font-bold text-muted-foreground mb-4 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-slate-400 inline-block" />
                Passés ({past.length})
              </h2>
              <div className="space-y-3 opacity-60">
                {past.map((a) => {
                  const colors = DEST_COLORS[a.destination] ?? { bg: "bg-slate-100", text: "text-slate-700", dot: "bg-slate-400" };
                  return (
                    <Link href={`/admin/applications/${a._id}`} key={a._id}>
                      <div className="bg-white rounded-2xl border border-border p-4 hover:opacity-100 transition-all cursor-pointer flex items-center gap-4">
                        <div className="text-center min-w-[56px] bg-slate-100 rounded-xl p-2">
                          <p className="text-[10px] text-muted-foreground uppercase font-bold">{MONTHS[parseLocalDate(a.date).getMonth()].slice(0, 3)}</p>
                          <p className="text-2xl font-bold text-slate-500 leading-none">{parseLocalDate(a.date).getDate()}</p>
                          <p className="text-[10px] text-muted-foreground">{parseLocalDate(a.date).getFullYear()}</p>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${colors.bg} ${colors.text}`}>
                              {DEST_LABELS[a.destination] ?? a.destination.toUpperCase()}
                            </span>
                          </div>
                          <p className="font-bold text-slate-600 truncate">{a.applicantName}</p>
                          <p className="text-xs text-muted-foreground truncate">{a.visaType}</p>
                        </div>
                        <div className="text-right hidden sm:block flex-shrink-0">
                          {a.time && <p className="text-sm font-semibold text-slate-500">{a.time}</p>}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          {appointments.length === 0 && (
            <div className="bg-white rounded-2xl border border-border p-16 text-center">
              <CalendarDays className="w-12 h-12 mx-auto mb-4 text-slate-200" />
              <p className="text-muted-foreground font-medium">Aucun rendez-vous confirmé pour l'instant</p>
              <p className="text-sm text-muted-foreground mt-1">Les créneaux capturés par le bot apparaîtront ici.</p>
            </div>
          )}
        </div>
      ) : (
        /* Discoveries view — stats de dates captées/ignorées par le bot */
        <DiscoveriesPanel stats={discoveryStats} modeFilter={modeFilter} setModeFilter={setModeFilter} destFilter={destFilter} setDestFilter={setDestFilter} />
      )}
    </div>
  );
}

// ─── Composant Découvertes (heatmap, stats, feed) ────────────────────────────

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const DAY_NAMES = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
const REASON_LABELS: Record<string, string> = {
  after_deadline: "Après deadline",
  before_from_date: "Avant date min",
  no_time_slots: "Pas d'horaires",
  out_of_window: "Hors fenêtre",
  booking_failed_otp_timeout: "OTP timeout",
  booking_failed_turnstile_failed: "Turnstile échoué",
  booking_failed_signin_failed: "Connexion échouée",
  booking_failed_booking_failed: "Booking échoué",
  booking_failed_no_slots: "Plus de créneaux",
};

type DiscoveryStats = {
  totalCaptured: number;
  totalIgnored: number;
  totalDiscoveries: number;
  byDateFound: Record<string, { captured: number; ignored: number; reasons: Record<string, number> }>;
  byHour: Record<number, { captured: number; ignored: number }>;
  byDayOfWeek: Record<number, { captured: number; ignored: number }>;
  byReason: Record<string, number>;
  byMode: Record<string, number>;
  byOffice: Record<string, { captured: number; ignored: number; total: number }>;
  recent: Array<{
    _id: string;
    destination: string;
    office: string;
    dateFound: string;
    timeFound?: string;
    outcome: "captured" | "ignored";
    reason?: string;
    mode?: "schedule" | "reschedule";
    discoveredAt: number;
  }>;
};

function DiscoveriesPanel({ stats, modeFilter, setModeFilter, destFilter, setDestFilter }: { stats: DiscoveryStats | null | undefined; modeFilter: "schedule" | "reschedule" | undefined; setModeFilter: (m: "schedule" | "reschedule" | undefined) => void; destFilter: string | undefined; setDestFilter: (d: string | undefined) => void }) {
  if (stats === undefined) {
    return <div className="p-12 text-center text-muted-foreground">Chargement des statistiques de découverte...</div>;
  }
  if (!stats || stats.totalDiscoveries === 0) {
    return (
      <div className="bg-white rounded-2xl border border-border p-16 text-center">
        <BarChart3 className="w-12 h-12 mx-auto mb-4 text-slate-200" />
        <p className="text-muted-foreground font-medium">Aucune découverte de date enregistrée</p>
        <p className="text-sm text-muted-foreground mt-1">
          Les dates trouvées (captées ou ignorées) par le bot apparaîtront ici dès le prochain scan.
        </p>
      </div>
    );
  }

  const maxHourVal = Math.max(...HOURS.map(h => (stats.byHour[h]?.captured ?? 0) + (stats.byHour[h]?.ignored ?? 0)), 1);

  return (
    <div className="space-y-6">
      {/* Destination filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-muted-foreground">Destination :</span>
        <button
          onClick={() => setDestFilter(undefined)}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${!destFilter ? "bg-primary text-white shadow" : "bg-white border border-border text-slate-600 hover:bg-slate-50"}`}
        >
          Toutes
        </button>
        {Object.entries(DEST_LABELS).map(([key, label]) => {
          const c = DEST_COLORS[key];
          return (
            <button
              key={key}
              onClick={() => setDestFilter(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${destFilter === key ? `${c.bg} ${c.text} shadow` : "bg-white border border-border text-slate-600 hover:bg-slate-50"}`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Mode filter */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Mode :</span>
        <button
          onClick={() => setModeFilter(undefined)}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${!modeFilter ? "bg-primary text-white shadow" : "bg-white border border-border text-slate-600 hover:bg-slate-50"}`}
        >
          Tous
        </button>
        <button
          onClick={() => setModeFilter("schedule")}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${modeFilter === "schedule" ? "bg-blue-600 text-white shadow" : "bg-white border border-border text-slate-600 hover:bg-slate-50"}`}
        >
          Schedule
        </button>
        <button
          onClick={() => setModeFilter("reschedule")}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${modeFilter === "reschedule" ? "bg-purple-600 text-white shadow" : "bg-white border border-border text-slate-600 hover:bg-slate-50"}`}
        >
          Reschedule
        </button>
      </div>

      {/* Export CSV buttons */}
      <ExportCsvButtons modeFilter={modeFilter} />

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-border shadow-sm p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-primary">{stats.totalDiscoveries}</p>
              <p className="text-xs text-muted-foreground">Dates découvertes (30j)</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-green-200 shadow-sm p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-green-100 flex items-center justify-center">
              <Eye className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-green-700">{stats.totalCaptured}</p>
              <p className="text-xs text-muted-foreground">Retenues (booking tenté)</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-amber-200 shadow-sm p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
              <EyeOff className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-amber-700">{stats.totalIgnored}</p>
              <p className="text-xs text-muted-foreground">Ignorées (hors fenêtre)</p>
            </div>
          </div>
        </div>
        {/* Mode breakdown card */}
        <div className="bg-white rounded-2xl border border-border shadow-sm p-5">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
              <CalendarDays className="w-5 h-5 text-purple-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-blue-700">{stats.byMode?.schedule ?? 0}</span>
                <span className="text-[10px] text-muted-foreground">sched.</span>
                <span className="text-sm font-bold text-purple-700">{stats.byMode?.reschedule ?? 0}</span>
                <span className="text-[10px] text-muted-foreground">resched.</span>
              </div>
              <p className="text-xs text-muted-foreground">Par mode</p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Hourly heatmap — quand l'ambassade libère des créneaux */}
        <div className="bg-white rounded-2xl border border-border shadow-sm p-5">
          <h3 className="text-sm font-bold text-primary mb-1 flex items-center gap-2">
            <Clock className="w-4 h-4 text-secondary" />
            Heures de disponibilité (UTC)
          </h3>
          <p className="text-xs text-muted-foreground mb-4">
            Quand le portail rend des créneaux disponibles
          </p>
          <div className="grid grid-cols-12 gap-1">
            {HOURS.map((h) => {
              const data = stats.byHour[h] ?? { captured: 0, ignored: 0 };
              const total = data.captured + data.ignored;
              const intensity = total / maxHourVal;
              const bgColor = total === 0
                ? "bg-slate-100"
                : intensity > 0.7
                  ? "bg-green-500"
                  : intensity > 0.4
                    ? "bg-green-300"
                    : intensity > 0.1
                      ? "bg-green-200"
                      : "bg-green-100";
              return (
                <div key={h} className="flex flex-col items-center gap-0.5" title={`${h}h UTC: ${total} découverte(s) (${data.captured} retenues, ${data.ignored} ignorées)`}>
                  <div className={`w-full aspect-square rounded-sm ${bgColor} transition-colors`} />
                  {h % 3 === 0 && <span className="text-[8px] text-muted-foreground">{h}h</span>}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3 mt-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-slate-100 inline-block" /> 0</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-200 inline-block" /> Peu</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-300 inline-block" /> Moyen</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-500 inline-block" /> Beaucoup</span>
          </div>
        </div>

        {/* Day of week distribution */}
        <div className="bg-white rounded-2xl border border-border shadow-sm p-5">
          <h3 className="text-sm font-bold text-primary mb-1 flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-secondary" />
            Jours de la semaine
          </h3>
          <p className="text-xs text-muted-foreground mb-4">
            Jours où des créneaux sont détectés
          </p>
          <div className="space-y-2">
            {DAY_NAMES.map((name, dow) => {
              const data = stats.byDayOfWeek[dow] ?? { captured: 0, ignored: 0 };
              const total = data.captured + data.ignored;
              const maxDow = Math.max(...Object.values(stats.byDayOfWeek).map(d => d.captured + d.ignored), 1);
              const pct = (total / maxDow) * 100;
              return (
                <div key={dow} className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-600 w-8">{name}</span>
                  <div className="flex-1 h-5 bg-slate-100 rounded-full overflow-hidden relative">
                    {data.captured > 0 && (
                      <div
                        className="absolute left-0 top-0 h-full bg-green-400 rounded-full"
                        style={{ width: `${(data.captured / maxDow) * 100}%` }}
                      />
                    )}
                    {data.ignored > 0 && (
                      <div
                        className="absolute top-0 h-full bg-amber-300 rounded-full"
                        style={{ left: `${(data.captured / maxDow) * 100}%`, width: `${(data.ignored / maxDow) * 100}%` }}
                      />
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground w-8 text-right">{total}</span>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-4 mt-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-400 inline-block" /> Retenues</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-amber-300 inline-block" /> Ignorées</span>
          </div>
        </div>
      </div>

      {/* By Office/Service breakdown */}
      {stats.byOffice && Object.keys(stats.byOffice).length > 0 && (
        <div className="bg-white rounded-2xl border border-border shadow-sm p-5">
          <h3 className="text-sm font-bold text-primary mb-3 flex items-center gap-2">
            <MapPin className="w-4 h-4 text-secondary" />
            {destFilter === "spain" ? "Par service" : "Par bureau"}
          </h3>
          <div className="space-y-2">
            {Object.entries(stats.byOffice)
              .sort(([, a], [, b]) => b.total - a.total)
              .slice(0, 10)
              .map(([office, data]) => {
                const maxOfficeVal = Math.max(...Object.values(stats.byOffice).map(o => o.total), 1);
                const pct = (data.total / maxOfficeVal) * 100;
                return (
                  <div key={office} className="flex items-center gap-2">
                    <span className="text-xs font-medium text-slate-700 w-40 truncate" title={office}>{office}</span>
                    <div className="flex-1 h-5 bg-slate-100 rounded-full overflow-hidden relative">
                      {data.captured > 0 && (
                        <div
                          className="absolute left-0 top-0 h-full bg-green-400 rounded-full"
                          style={{ width: `${(data.captured / maxOfficeVal) * 100}%` }}
                        />
                      )}
                      {data.ignored > 0 && (
                        <div
                          className="absolute top-0 h-full bg-amber-300 rounded-full"
                          style={{ left: `${(data.captured / maxOfficeVal) * 100}%`, width: `${(data.ignored / maxOfficeVal) * 100}%` }}
                        />
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground w-12 text-right">{data.captured}/{data.total}</span>
                  </div>
                );
              })}
          </div>
          <div className="flex items-center gap-4 mt-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-green-400 inline-block" /> Retenues</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-amber-300 inline-block" /> Ignorées</span>
          </div>
        </div>
      )}

      {/* Reasons breakdown */}
      {Object.keys(stats.byReason).length > 0 && (
        <div className="bg-white rounded-2xl border border-border shadow-sm p-5">
          <h3 className="text-sm font-bold text-primary mb-3 flex items-center gap-2">
            <EyeOff className="w-4 h-4 text-amber-500" />
            Raisons d'ignorement
          </h3>
          <div className="flex flex-wrap gap-3">
            {Object.entries(stats.byReason).sort(([, a], [, b]) => b - a).map(([reason, count]) => (
              <div key={reason} className="flex items-center gap-2 px-3 py-2 bg-amber-50 rounded-xl border border-amber-200">
                <span className="text-sm font-bold text-amber-700">{count}</span>
                <span className="text-xs text-amber-600">{REASON_LABELS[reason] ?? reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent discoveries feed */}
      <div className="bg-white rounded-2xl border border-border shadow-sm p-5">
        <h3 className="text-sm font-bold text-primary mb-3 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-secondary" />
          Dernières découvertes
        </h3>
        {stats.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune découverte récente.</p>
        ) : (
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            {stats.recent.map((d) => (
              <div key={d._id} className={`flex items-center gap-3 px-3 py-2 rounded-xl border ${d.outcome === "captured" ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}>
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${d.outcome === "captured" ? "bg-green-500" : "bg-amber-500"}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-primary">{d.dateFound}</span>
                    {d.timeFound && <span className="text-[10px] text-slate-500">{d.timeFound}</span>}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${d.outcome === "captured" ? "bg-green-200 text-green-800" : "bg-amber-200 text-amber-800"}`}>
                      {d.outcome === "captured" ? "Retenue" : "Ignorée"}
                    </span>
                    {d.reason && (
                      <span className="text-[10px] text-muted-foreground">({REASON_LABELS[d.reason] ?? d.reason})</span>
                    )}
                    {d.mode && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${d.mode === "reschedule" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}>
                        {d.mode === "reschedule" ? "♻️ resched." : "📅 sched."}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{d.office} — {DEST_LABELS[d.destination] ?? d.destination}</p>
                </div>
                <span className="text-[10px] text-muted-foreground flex-shrink-0">
                  {new Date(d.discoveredAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


// ── Export CSV Component ─────────────────────────────────────────────────────
type ExportPeriod = "1m" | "3m" | "6m" | "1y";
const EXPORT_PERIODS: { key: ExportPeriod; label: string; days: number }[] = [
  { key: "1m", label: "1 mois", days: 30 },
  { key: "3m", label: "3 mois", days: 90 },
  { key: "6m", label: "6 mois", days: 180 },
  { key: "1y", label: "1 an", days: 365 },
];

function ExportCsvButtons({ modeFilter }: { modeFilter?: "schedule" | "reschedule" }) {
  const [exportPeriod, setExportPeriod] = useState<ExportPeriod | null>(null);

  // Query data only when export is requested (by setting exportPeriod)
  const since = exportPeriod
    ? Date.now() - EXPORT_PERIODS.find(p => p.key === exportPeriod)!.days * 24 * 60 * 60 * 1000
    : undefined;

  const exportData = useQuery(
    api.slotDiscoveries.exportForPeriod,
    since !== undefined ? { since, ...(modeFilter ? { mode: modeFilter } : {}) } : "skip"
  );

  // Trigger download when data arrives
  useMemo(() => {
    if (!exportData || !exportPeriod) return;
    if (exportData.length === 0) {
      alert("Aucune donnée à exporter pour cette période.");
      setExportPeriod(null);
      return;
    }

    // Generate CSV with BOM for Excel compatibility
    const headers = ["Date trouvée", "Heure", "Bureau", "Destination", "Résultat", "Raison", "Mode", "Découvert le", "Nb observations"];
    const csvLines = [
      headers.join(";"),
      ...exportData.map(r => [
        r.dateFound,
        r.timeFound,
        r.office,
        r.destination,
        r.outcome === "captured" ? "Retenue" : "Ignorée",
        r.reason,
        r.mode === "reschedule" ? "Reschedule" : r.mode === "schedule" ? "Schedule" : "",
        r.discoveredAt,
        r.seenCount.toString(),
      ].join(";")),
    ];
    const csv = csvLines.join("\n");

    // Download file
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `decouvertes_${exportPeriod}_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setExportPeriod(null);
  }, [exportData, exportPeriod]);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-muted-foreground font-medium flex items-center gap-1">
        <Download className="w-3.5 h-3.5" />
        Export CSV :
      </span>
      {EXPORT_PERIODS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => setExportPeriod(key)}
          disabled={exportPeriod !== null}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
            exportPeriod === key
              ? "bg-slate-200 text-slate-500 border-slate-300 cursor-wait animate-pulse"
              : "bg-white border-border text-slate-600 hover:bg-slate-50 hover:border-slate-300"
          }`}
        >
          {exportPeriod === key ? "Export..." : label}
        </button>
      ))}
    </div>
  );
}
