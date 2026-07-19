import { Link } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";
import {
  Users,
  FileText,
  CheckCircle2,
  Clock,
  ChevronRight,
  MessageCircle,
  Eye,
  Radio,
  Globe,
  FileBarChart,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  LineChart,
  Line,
  CartesianGrid,
} from "recharts";

const MONTH_LABELS: Record<string, string> = {
  "01": "Jan", "02": "Fév", "03": "Mar", "04": "Avr",
  "05": "Mai", "06": "Juin", "07": "Juil", "08": "Août",
  "09": "Sep", "10": "Oct", "11": "Nov", "12": "Déc",
};

function monthLabel(key: string) {
  const [, m] = key.split("-");
  return MONTH_LABELS[m] ?? key;
}

export default function AdminDashboard() {
  const stats = useQuery(api.admin.getStats);
  const conversations = useQuery(api.messages.listConversations) ?? [];
  const unreadTotal = useQuery(api.messages.getUnreadTotal) ?? 0;
  const liveVisitors = useQuery(api.traffic.getLiveVisitors);
  const monthlyStats = useQuery(api.traffic.getMonthlyStats);
  const topPages = useQuery(api.traffic.getTopPages);
  const trafficSources = useQuery(api.traffic.getTrafficSources);
  const isLoading = stats === undefined;

  if (isLoading)
    return (
      <div className="p-8 text-center text-muted-foreground">
        Chargement des statistiques...
      </div>
    );
  if (!stats)
    return (
      <div className="p-8 text-center text-muted-foreground">
        Accès réservé à l'administrateur.
      </div>
    );

  const chartData = Object.entries(stats.byDestination).map(([key, value]) => ({
    name: key.toUpperCase(),
    valeur: value,
  }));

  const pendingConversations = conversations
    .filter((c) => c.unreadCount > 0)
    .slice(0, 5);

  const trafficData = (monthlyStats ?? []).map((m) => ({
    name: monthLabel(m.month),
    vues: m.views,
    visiteurs: m.visitors,
  }));

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="relative overflow-hidden rounded-3xl bg-brand-gradient p-6 sm:p-8 shadow-premium-lg">
        <div className="absolute inset-0 opacity-[0.07] pointer-events-none">
          <div className="absolute -top-16 -right-10 w-72 h-72 rounded-full border border-white/40" />
          <div className="absolute -bottom-24 right-24 w-80 h-80 rounded-full border border-white/30" />
        </div>
        <div className="relative z-10">
          <p className="text-secondary text-xs font-semibold uppercase tracking-[0.18em] mb-2">
            Administration
          </p>
          <h1 className="text-2xl sm:text-3xl font-serif font-semibold text-white">
            Vue d'ensemble
          </h1>
          <p className="text-slate-300 mt-1 text-sm">
            Contrôlez les opérations et les dossiers en temps réel.
          </p>
        </div>
      </div>

      {/* KPI Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        {[
          {
            label: "Total Dossiers",
            value: stats.totalApplications,
            icon: FileText,
            bg: "bg-primary/10",
            color: "text-primary",
          },
          {
            label: "En Révision",
            value: stats.pendingReview,
            icon: Clock,
            bg: "bg-secondary/10",
            color: "text-secondary",
          },
          {
            label: "Approuvés (Mois)",
            value: stats.approvedThisMonth,
            icon: CheckCircle2,
            bg: "bg-emerald-50",
            color: "text-emerald-600",
          },
          {
            label: "Clients Actifs",
            value: stats.totalClients,
            icon: Users,
            bg: "bg-accent/15",
            color: "text-accent-foreground",
          },
        ].map((stat, i) => (
          <div
            key={i}
            className="bg-card p-6 rounded-2xl border border-border shadow-premium hover-lift flex items-center gap-4"
          >
            <div
              className={`w-12 h-12 rounded-xl flex items-center justify-center ${stat.bg} flex-shrink-0`}
            >
              <stat.icon className={`w-6 h-6 ${stat.color}`} />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">{stat.label}</p>
              <h3 className="text-3xl font-bold text-primary">{stat.value}</h3>
            </div>
          </div>
        ))}
      </div>

      {/* Pending messages alert */}
      {unreadTotal > 0 && (
        <Link href="/admin/messages">
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 sm:p-5 flex items-center justify-between gap-4 cursor-pointer hover:bg-red-100/50 transition-colors">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-500 flex items-center justify-center flex-shrink-0">
                <MessageCircle className="w-5 h-5 text-white" />
              </div>
              <div>
                <p className="font-bold text-red-700 text-sm">
                  {unreadTotal} message{unreadTotal > 1 ? "s" : ""} client{unreadTotal > 1 ? "s" : ""} en attente
                </p>
                <p className="text-xs text-red-600">
                  {pendingConversations.length} dossier{pendingConversations.length > 1 ? "s" : ""} nécessitent votre réponse
                </p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-red-400 flex-shrink-0" />
          </div>
        </Link>
      )}

      {/* ─── Trafic ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Trafic en direct */}
        <div className="bg-card rounded-2xl border border-border shadow-premium p-6 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
            </span>
            <h2 className="text-sm font-bold text-primary">En direct</h2>
            <Radio className="w-4 h-4 text-emerald-500 ml-auto" />
          </div>

          <div className="text-center py-4">
            <p className="text-6xl font-bold text-primary tabular-nums">
              {liveVisitors?.total ?? "—"}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              visiteur{(liveVisitors?.total ?? 0) > 1 ? "s" : ""} actif{(liveVisitors?.total ?? 0) > 1 ? "s" : ""}
            </p>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">dans les 2 dernières minutes</p>
          </div>

          {liveVisitors && liveVisitors.byPath.length > 0 && (
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Pages actives</p>
              {liveVisitors.byPath.map(({ path, count }) => (
                <div key={path} className="flex items-center justify-between gap-2">
                  <p className="text-xs text-primary truncate font-medium">{path === "/" ? "Accueil" : path}</p>
                  <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full flex-shrink-0">
                    {count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Trafic mensuel */}
        <div className="lg:col-span-2 bg-card rounded-2xl border border-border shadow-premium p-6">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-bold text-primary">Trafic mensuel</h2>
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-primary rounded inline-block" />
                Vues
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 bg-secondary rounded inline-block" />
                Visiteurs
              </span>
            </div>
          </div>

          {trafficData.length > 0 ? (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trafficData} margin={{ left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "#64748b", fontSize: 11 }}
                    dy={8}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "#64748b", fontSize: 11 }}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: "12px",
                      border: "none",
                      boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)",
                      fontSize: 12,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="vues"
                    stroke="#1E4FA3"
                    strokeWidth={2.5}
                    dot={{ fill: "#1E4FA3", r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="visiteurs"
                    stroke="#1DA1D2"
                    strokeWidth={2.5}
                    strokeDasharray="5 3"
                    dot={{ fill: "#1DA1D2", r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-52 flex items-center justify-center text-sm text-muted-foreground">
              Les données s'accumulent au fil des visites…
            </div>
          )}

          {trafficData.length > 0 && (
            <div className="grid grid-cols-2 gap-4 mt-4 pt-4 border-t border-border">
              <div className="text-center">
                <p className="text-2xl font-bold text-primary">
                  {trafficData.reduce((s, m) => s + m.vues, 0).toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Pages vues (6 mois)</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-secondary">
                  {trafficData[trafficData.length - 1]?.visiteurs ?? 0}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Visiteurs uniques ce mois</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── Pages visitées + Sources de trafic ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Pages les plus visitées */}
        <div className="bg-card rounded-2xl border border-border shadow-premium p-6">
          <div className="flex items-center gap-2 mb-1">
            <FileBarChart className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-bold text-primary">Pages les plus visitées</h2>
          </div>
          <p className="text-xs text-muted-foreground mb-5">30 derniers jours</p>

          {topPages === undefined ? (
            <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
              Chargement…
            </div>
          ) : topPages && topPages.length > 0 ? (
            <div className="divide-y divide-border">
              {topPages.map((p, i) => (
                <div key={p.path} className="flex items-center gap-3 py-2.5">
                  <span className="text-xs font-bold text-muted-foreground/50 w-4 flex-shrink-0">
                    {i + 1}
                  </span>
                  <span className="text-sm text-primary font-medium truncate flex-1">
                    {p.path === "/" ? "Accueil" : p.path}
                  </span>
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    {p.visitors} visiteur{p.visitors > 1 ? "s" : ""}
                  </span>
                  <span className="text-xs font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-full flex-shrink-0 tabular-nums">
                    {p.views}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
              Les données s'accumulent au fil des visites…
            </div>
          )}
        </div>

        {/* Sources de trafic */}
        <div className="bg-card rounded-2xl border border-border shadow-premium p-6">
          <div className="flex items-center gap-2 mb-1">
            <Globe className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-bold text-primary">Sources de trafic</h2>
          </div>
          <p className="text-xs text-muted-foreground mb-5">D'où viennent vos visiteurs — 30 derniers jours</p>

          {trafficSources === undefined ? (
            <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
              Chargement…
            </div>
          ) : trafficSources && trafficSources.length > 0 ? (
            <div className="space-y-3">
              {trafficSources.map((s) => (
                <div key={s.source}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-primary">{s.source}</span>
                    <span className="text-xs text-muted-foreground">
                      {s.visitors} · {s.pct}%
                    </span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-secondary rounded-full"
                      style={{ width: `${s.pct}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
              Les données s'accumulent au fil des visites…
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Dossiers par destination */}
        <div className="lg:col-span-2 bg-card rounded-2xl border border-border shadow-premium p-6">
          <h2 className="text-lg font-bold text-primary mb-6">
            Demandes par destination
          </h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <XAxis
                  dataKey="name"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#64748b", fontSize: 12 }}
                  dy={10}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#64748b", fontSize: 12 }}
                />
                <Tooltip
                  cursor={{ fill: "#f1f5f9" }}
                  contentStyle={{
                    borderRadius: "12px",
                    border: "none",
                    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)",
                  }}
                />
                <Bar dataKey="valeur" radius={[6, 6, 0, 0]}>
                  {chartData.map((_, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={index % 2 === 0 ? "#1E4FA3" : "#1DA1D2"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Recent activity + pending messages */}
        <div className="space-y-6">
          {pendingConversations.length > 0 && (
            <div className="bg-card rounded-2xl border border-border shadow-premium overflow-hidden">
              <div className="p-5 border-b border-border flex justify-between items-center bg-red-50">
                <h2 className="text-sm font-bold text-red-700 flex items-center gap-2">
                  <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  Messages en attente
                </h2>
                <Link
                  href="/admin/messages"
                  className="text-xs font-medium text-red-600 hover:underline"
                >
                  Tout voir
                </Link>
              </div>
              <div className="divide-y divide-border">
                {pendingConversations.map((conv) => (
                  <Link key={conv._id} href={`/admin/applications/${conv._id}`}>
                    <div className="p-3.5 hover:bg-slate-50 transition-colors cursor-pointer flex items-center gap-3">
                      <div className="relative flex-shrink-0">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                          <MessageCircle className="w-4 h-4 text-primary" />
                        </div>
                        <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                          {conv.unreadCount}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-primary text-xs truncate">
                          {conv.userFirstName} {conv.userLastName}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {conv.destination.toUpperCase()} — {conv.visaType}
                        </p>
                        {conv.lastMessage && (
                          <p className="text-xs text-slate-600 truncate font-medium">
                            {conv.lastMessage.content}
                          </p>
                        )}
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 text-slate-300 flex-shrink-0" />
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          <div className="bg-card rounded-2xl border border-border shadow-premium overflow-hidden flex flex-col">
            <div className="p-5 border-b border-border bg-muted/50">
              <h2 className="text-sm font-bold text-primary">Activités récentes</h2>
            </div>
            <div className="flex-1 overflow-y-auto divide-y divide-border">
              {stats.recentApplications.map((app) => (
                <Link key={app._id} href={`/admin/applications/${app._id}`}>
                  <div className="p-4 hover:bg-slate-50 transition-colors cursor-pointer">
                    <div className="flex justify-between items-start mb-1.5">
                      <p className="font-semibold text-primary text-xs truncate pr-2">
                        {app.applicantName}
                      </p>
                      <StatusBadge status={app.status} />
                    </div>
                    <div className="flex justify-between items-center text-[11px] text-muted-foreground">
                      <span>
                        {app.destination.toUpperCase()} — {app.visaType}
                      </span>
                      <span className="flex items-center gap-1">
                        {formatDate(app.updatedAt)}{" "}
                        <ChevronRight className="w-3 h-3" />
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
              {stats.recentApplications.length === 0 && (
                <div className="p-8 text-center text-muted-foreground text-sm">
                  Aucune activité
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
