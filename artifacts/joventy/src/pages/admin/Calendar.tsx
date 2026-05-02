import { useState, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight, CalendarDays, MapPin, Clock, User, List, Grid3X3 } from "lucide-react";

const DEST_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  usa:      { bg: "bg-blue-100",   text: "text-blue-800",   dot: "bg-blue-500" },
  schengen: { bg: "bg-indigo-100", text: "text-indigo-800", dot: "bg-indigo-500" },
  dubai:    { bg: "bg-amber-100",  text: "text-amber-800",  dot: "bg-amber-500" },
  turkey:   { bg: "bg-red-100",    text: "text-red-800",    dot: "bg-red-500" },
  india:    { bg: "bg-orange-100", text: "text-orange-800", dot: "bg-orange-500" },
};

const DEST_LABELS: Record<string, string> = {
  usa: "USA 🇺🇸", schengen: "Schengen 🇪🇺", dubai: "Dubaï 🇦🇪",
  turkey: "Turquie 🇹🇷", india: "Inde 🇮🇳",
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
  const today = new Date();
  const [viewDate, setViewDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState<string | null>(toISODateKey(today));
  const [view, setView] = useState<"month" | "list">("month");

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
      ) : (
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
      )}
    </div>
  );
}
