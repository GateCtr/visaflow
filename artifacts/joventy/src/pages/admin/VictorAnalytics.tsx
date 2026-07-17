/**
 * VictorAnalytics — Tableau de bord admin pour l'agent Victor
 * Stats de conversion, conversations, utilisateurs convaincus
 */
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import {
  MessageCircle,
  TrendingUp,
  UserCheck,
  Zap,
  ChevronRight,
  BadgeCheck,
  Clock,
  Bot,
} from "lucide-react";
import { Link } from "wouter";

function fmtDate(ts: number) {
  return new Date(ts).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
}

function pageLabel(ctx: string) {
  const labels: Record<string, string> = {
    "/": "Accueil",
    "/prix": "Tarifs",
    "/audit-diagnostic": "Audit",
    "/dashboard/contrat": "Contrat",
    "/dashboard": "Dashboard",
  };
  return labels[ctx] ?? ctx;
}

function actionLabel(a: string) {
  return a
    .replace(/_/g, " ")
    .replace(/cta click /i, "CTA → ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  accent: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-border shadow-sm p-6 flex items-center gap-4">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${accent}`}>
        <Icon className="w-6 h-6 text-white" />
      </div>
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</p>
        <p className="text-2xl font-bold text-primary">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

export default function VictorAnalytics() {
  const data = useQuery(api.victor.getVictorStats);

  if (data === undefined) {
    return (
      <div className="p-8 text-center text-muted-foreground animate-pulse">
        Chargement des statistiques Victor…
      </div>
    );
  }

  const {
    totalConversations,
    totalMessages,
    convincedCount,
    conversionRate,
    topPages,
    topActions,
    recent,
    dailyTrend,
  } = data;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="rounded-2xl bg-primary p-6 sm:p-8 relative overflow-hidden">
        <div className="absolute inset-0 opacity-[0.08] pointer-events-none">
          <div className="absolute -top-10 -right-10 w-64 h-64 rounded-full border border-white/40" />
          <div className="absolute -bottom-20 right-20 w-72 h-72 rounded-full border border-white/30" />
        </div>
        <div className="relative z-10 flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-white/15 flex items-center justify-center flex-shrink-0">
            <Bot className="w-7 h-7 text-white" />
          </div>
          <div>
            <p className="text-slate-300 text-sm font-semibold uppercase tracking-widest mb-1">
              Agent IA
            </p>
            <h1 className="text-2xl sm:text-3xl font-serif font-bold text-white">
              Victor — Statistiques
            </h1>
            <p className="text-slate-300 mt-1 text-sm">
              Conversations, taux de conversion et utilisateurs convaincus.
            </p>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          label="Conversations totales"
          value={totalConversations}
          sub="sessions initiées"
          icon={MessageCircle}
          accent="bg-primary"
        />
        <KpiCard
          label="Messages échangés"
          value={totalMessages}
          sub="messages au total"
          icon={Zap}
          accent="bg-slate-500"
        />
        <KpiCard
          label="Utilisateurs convaincus"
          value={convincedCount}
          sub="ont pris une action"
          icon={UserCheck}
          accent="bg-green-500"
        />
        <KpiCard
          label="Taux de conversion"
          value={`${conversionRate} %`}
          sub="conversations → action"
          icon={TrendingUp}
          accent="bg-amber-500"
        />
      </div>

      {/* Graphique évolution */}
      {dailyTrend.length > 0 && (
        <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
          <h2 className="text-base font-bold text-primary mb-1">Évolution sur 30 jours</h2>
          <p className="text-xs text-muted-foreground mb-6">
            Conversations initiées et utilisateurs convaincus
          </p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dailyTrend} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradConvs" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#1E4FA3" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#1E4FA3" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradConvinced" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10B981" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis
                  dataKey="day"
                  tickFormatter={fmtDay}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "#64748b", fontSize: 11 }}
                />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ borderRadius: "12px", border: "none", boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)" }}
                  labelFormatter={fmtDay}
                  formatter={(v: number, name: string) => [
                    v,
                    name === "convs" ? "Conversations" : "Convaincus",
                  ]}
                />
                <Area type="monotone" dataKey="convs" stroke="#1E4FA3" strokeWidth={2} fill="url(#gradConvs)" />
                <Area type="monotone" dataKey="convinced" stroke="#10B981" strokeWidth={2} fill="url(#gradConvinced)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-4 mt-3">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="w-3 h-0.5 bg-primary inline-block rounded" /> Conversations
            </span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="w-3 h-0.5 bg-green-500 inline-block rounded" /> Convaincus
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Top pages */}
        <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
          <h2 className="text-base font-bold text-primary mb-4">Pages les plus actives</h2>
          {topPages.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune donnée</p>
          ) : (
            <div className="space-y-3">
              {topPages.map((p: { page: string; count: number }, i: number) => {
                const max = topPages[0]?.count ?? 1;
                const pct = Math.round((p.count / max) * 100);
                return (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-24 text-xs font-semibold text-primary truncate flex-shrink-0">
                      {pageLabel(p.page)}
                    </div>
                    <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-700"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs font-bold text-primary w-6 text-right">{p.count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Top actions */}
        <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
          <h2 className="text-base font-bold text-primary mb-4">Actions les plus cliquées</h2>
          {topActions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune action enregistrée</p>
          ) : (
            <div className="space-y-3">
              {topActions.map((a: { action: string; count: number }, i: number) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full bg-green-50 flex items-center justify-center flex-shrink-0">
                    <BadgeCheck className="w-3.5 h-3.5 text-green-600" />
                  </div>
                  <span className="flex-1 text-xs text-primary truncate">{actionLabel(a.action)}</span>
                  <span className="text-xs font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
                    ×{a.count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Conversations récentes */}
      <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
        <div className="p-5 border-b border-border bg-muted/50">
          <h2 className="text-sm font-bold text-primary">Conversations récentes</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Les 20 dernières sessions — les utilisateurs convaincus sont marqués.
          </p>
        </div>

        {recent.length === 0 ? (
          <div className="p-12 text-center">
            <MessageCircle className="w-10 h-10 text-slate-200 mx-auto mb-3" />
            <p className="font-semibold text-primary text-sm">Aucune conversation</p>
            <p className="text-xs text-muted-foreground mt-1">
              Les conversations apparaîtront dès que Victor sera actif.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {recent.map((c: {
              _id: string;
              sessionId: string;
              pageContext: string;
              isAuth: boolean;
              messageCount: number;
              convinced: boolean;
              convincedAt?: number;
              actionsTaken: string[];
              createdAt: number;
              updatedAt: number;
              preview: string;
            }) => (
              <div key={c._id} className="p-4 hover:bg-slate-50 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Badge convaincu */}
                    {c.convinced ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-50 text-green-700 text-[11px] font-bold rounded-full border border-green-200">
                        <BadgeCheck className="w-3 h-3" /> Convaincu
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-50 text-slate-500 text-[11px] rounded-full border border-border">
                        En cours
                      </span>
                    )}
                    <span className="text-[11px] text-muted-foreground bg-slate-50 px-2 py-0.5 rounded-full border border-border">
                      {pageLabel(c.pageContext)}
                    </span>
                    {c.isAuth && (
                      <span className="text-[11px] text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-100">
                        Connecté
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-[11px] text-muted-foreground flex-shrink-0">
                    <Clock className="w-3 h-3" />
                    {fmtDate(c.updatedAt)}
                  </div>
                </div>

                {c.preview && (
                  <p className="mt-1.5 text-xs text-muted-foreground truncate">
                    « {c.preview} »
                  </p>
                )}

                <div className="flex items-center justify-between mt-2">
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] text-muted-foreground">
                      {c.messageCount} message{c.messageCount > 1 ? "s" : ""}
                    </span>
                    {c.actionsTaken.length > 0 && (
                      <span className="text-[11px] text-green-600">
                        {c.actionsTaken.map(actionLabel).join(", ")}
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] text-slate-400 font-mono truncate max-w-[120px]">
                    {c.sessionId.slice(0, 8)}…
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Empty state global */}
      {totalConversations === 0 && (
        <div className="bg-white rounded-2xl border border-border shadow-sm p-16 text-center">
          <Bot className="w-12 h-12 text-slate-200 mx-auto mb-4" />
          <p className="font-semibold text-primary">Victor est prêt, mais n'a pas encore reçu de messages</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
            Les statistiques apparaîtront dès que des visiteurs interagiront avec Victor sur le site.
          </p>
        </div>
      )}
    </div>
  );
}
