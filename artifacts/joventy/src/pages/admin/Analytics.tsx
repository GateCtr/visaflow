import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
  LineChart,
  Line,
  CartesianGrid,
} from "recharts";
import {
  DollarSign,
  TrendingUp,
  Bot,
  Clock,
  FileText,
} from "lucide-react";

const DEST_COLORS: Record<string, string> = {
  USA: "#1E4FA3",
  SCHENGEN: "#1DA1D2",
  DUBAI: "#F59E0B",
  TURKEY: "#10B981",
  INDIA: "#8B5CF6",
};

const PIE_COLORS = [
  "#1E4FA3", "#1DA1D2", "#F59E0B", "#10B981",
  "#8B5CF6", "#EF4444", "#F97316", "#6B7280",
];

function fmtMoney(n: number) {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n}`;
}

function KpiCard({
  label, value, sub, icon: Icon, color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-border shadow-sm p-6 flex items-center gap-4">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`}>
        <Icon className="w-6 h-6 text-white" />
      </div>
      <div>
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold text-primary">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

const CustomTooltipRevenu = ({ active, payload, label }: { active?: boolean; payload?: { value: number; name: string }[]; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-border rounded-xl shadow-lg p-3 text-sm">
      <p className="font-bold text-primary mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.name === "revenu" ? "#1E4FA3" : "#1DA1D2" }}>
          {p.name === "revenu" ? `Revenu: $${p.value}` : `Dossiers: ${p.value}`}
        </p>
      ))}
    </div>
  );
};

export default function Analytics() {
  const data = useQuery(api.admin.getAnalytics);

  if (data === undefined) {
    return (
      <div className="p-8 text-center text-muted-foreground animate-pulse">
        Calcul des analytics en cours…
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Accès réservé à l'administrateur.
      </div>
    );
  }

  const { kpis, months, successByDest, statusDist, weeks, revenueByDest } = data;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="rounded-2xl bg-primary p-6 sm:p-8">
        <p className="text-secondary text-sm font-semibold uppercase tracking-widest mb-1">
          Administration
        </p>
        <h1 className="text-2xl sm:text-3xl font-serif font-bold text-white">
          Analytics
        </h1>
        <p className="text-slate-300 mt-1 text-sm">
          Revenus, taux de succès et activité de la plateforme.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          label="Revenu total encaissé"
          value={fmtMoney(kpis.totalRevenue)}
          sub="frais engagement + succès"
          icon={DollarSign}
          color="bg-primary"
        />
        <KpiCard
          label="Taux de succès global"
          value={`${kpis.globalSuccessRate}%`}
          sub={`sur ${kpis.totalDossiers} dossiers`}
          icon={TrendingUp}
          color="bg-green-500"
        />
        <KpiCard
          label="Bots actifs"
          value={kpis.activeBots}
          sub="en chasse de créneaux"
          icon={Bot}
          color="bg-[#1DA1D2]"
        />
        <KpiCard
          label="Délai moyen de traitement"
          value={kpis.avgProcessingDays > 0 ? `${kpis.avgProcessingDays}j` : "—"}
          sub="de la création à la complétion"
          icon={Clock}
          color="bg-amber-500"
        />
      </div>

      {/* Revenus mensuels + Activité hebdomadaire */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenus 6 mois */}
        <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
          <h2 className="text-base font-bold text-primary mb-1">Revenus mensuels</h2>
          <p className="text-xs text-muted-foreground mb-6">6 derniers mois</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={months} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gradRevenu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#1E4FA3" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#1E4FA3" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 11 }} dy={8} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip content={<CustomTooltipRevenu />} />
                <Area type="monotone" dataKey="revenu" stroke="#1E4FA3" strokeWidth={2.5} fill="url(#gradRevenu)" dot={{ r: 4, fill: "#1E4FA3", strokeWidth: 0 }} activeDot={{ r: 6 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Activité hebdomadaire */}
        <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
          <h2 className="text-base font-bold text-primary mb-1">Activité hebdomadaire</h2>
          <p className="text-xs text-muted-foreground mb-6">Dossiers créés vs résolus — 8 semaines</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={weeks} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 10 }} dy={8} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ borderRadius: "12px", border: "none", boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)" }}
                  formatter={(v: number, name: string) => [v, name === "créés" ? "Créés" : "Résolus"]}
                />
                <Legend formatter={(v) => v === "créés" ? "Créés" : "Résolus"} iconType="circle" />
                <Line type="monotone" dataKey="créés" stroke="#1E4FA3" strokeWidth={2.5} dot={{ r: 3, fill: "#1E4FA3" }} activeDot={{ r: 5 }} />
                <Line type="monotone" dataKey="résolus" stroke="#10B981" strokeWidth={2.5} dot={{ r: 3, fill: "#10B981" }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Taux de succès par destination + Répartition statuts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Taux de succès */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-border shadow-sm p-6">
          <h2 className="text-base font-bold text-primary mb-1">Taux de succès par destination</h2>
          <p className="text-xs text-muted-foreground mb-6">% de dossiers complétés ou créneaux trouvés</p>
          {successByDest.length === 0 ? (
            <div className="h-52 flex items-center justify-center text-muted-foreground text-sm">Aucune donnée</div>
          ) : (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={successByDest} layout="vertical" margin={{ top: 0, right: 12, left: 4, bottom: 0 }}>
                  <XAxis type="number" domain={[0, 100]} axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
                  <YAxis type="category" dataKey="dest" axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 12, fontWeight: 600 }} width={72} />
                  <Tooltip
                    contentStyle={{ borderRadius: "12px", border: "none", boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)" }}
                    formatter={(v: number, _name, entry) => [`${v}% (${entry.payload.success}/${entry.payload.total})`, "Succès"]}
                  />
                  <Bar dataKey="taux" radius={[0, 6, 6, 0]} barSize={22}>
                    {successByDest.map((entry) => (
                      <Cell
                        key={entry.dest}
                        fill={DEST_COLORS[entry.dest] ?? "#6B7280"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          {/* Légende détaillée */}
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
            {successByDest.map((d) => (
              <div key={d.dest} className="flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ background: DEST_COLORS[d.dest] ?? "#6B7280" }}
                />
                <span className="font-medium text-primary">{d.dest}</span>
                <span>{d.success}/{d.total}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Répartition statuts */}
        <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
          <h2 className="text-base font-bold text-primary mb-1">Statuts des dossiers</h2>
          <p className="text-xs text-muted-foreground mb-4">Répartition actuelle</p>
          {statusDist.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">Aucune donnée</div>
          ) : (
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusDist}
                    dataKey="value"
                    nameKey="label"
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={75}
                    paddingAngle={2}
                  >
                    {statusDist.map((_entry, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ borderRadius: "12px", border: "none", boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)" }}
                    formatter={(v: number, name: string) => [v, name]}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="mt-2 space-y-1.5">
            {statusDist.map((s, i) => (
              <div key={s.label} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                  <span className="text-muted-foreground">{s.label}</span>
                </div>
                <span className="font-bold text-primary">{s.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Revenu par destination */}
      {revenueByDest.some(d => d.revenu > 0) && (
        <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
          <h2 className="text-base font-bold text-primary mb-1">Revenu par destination</h2>
          <p className="text-xs text-muted-foreground mb-6">Total encaissé (engagement + succès)</p>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenueByDest} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                <XAxis dataKey="dest" axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 12, fontWeight: 600 }} dy={8} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{ borderRadius: "12px", border: "none", boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)" }}
                  formatter={(v: number) => [`$${v}`, "Revenu"]}
                />
                <Bar dataKey="revenu" radius={[6, 6, 0, 0]} barSize={40}>
                  {revenueByDest.map((entry) => (
                    <Cell key={entry.dest} fill={DEST_COLORS[entry.dest] ?? "#6B7280"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-3">
            {revenueByDest.map((d) => (
              <div key={d.dest} className="text-center p-3 bg-slate-50 rounded-xl">
                <p className="text-xs font-bold" style={{ color: DEST_COLORS[d.dest] ?? "#6B7280" }}>{d.dest}</p>
                <p className="text-lg font-bold text-primary mt-0.5">{fmtMoney(d.revenu)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {kpis.totalDossiers === 0 && (
        <div className="bg-white rounded-2xl border border-border shadow-sm p-16 text-center">
          <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <p className="font-semibold text-primary">Aucune donnée disponible</p>
          <p className="text-sm text-muted-foreground mt-1">Les analytics s'afficheront dès que des dossiers seront créés.</p>
        </div>
      )}
    </div>
  );
}
