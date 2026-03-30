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
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

export default function AdminDashboard() {
  const stats = useQuery(api.admin.getStats);
  const conversations = useQuery(api.messages.listConversations) ?? [];
  const unreadTotal = useQuery(api.messages.getUnreadTotal) ?? 0;
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

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="rounded-2xl bg-primary p-6 sm:p-8">
        <p className="text-secondary text-sm font-semibold uppercase tracking-widest mb-1">
          Administration
        </p>
        <h1 className="text-2xl sm:text-3xl font-serif font-bold text-white">
          Vue d'ensemble
        </h1>
        <p className="text-slate-300 mt-1 text-sm">
          Contrôlez les opérations et les dossiers en temps réel.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        {[
          {
            label: "Total Dossiers",
            value: stats.totalApplications,
            icon: FileText,
            bg: "bg-blue-50",
            color: "text-blue-600",
          },
          {
            label: "En Révision",
            value: stats.pendingReview,
            icon: Clock,
            bg: "bg-amber-50",
            color: "text-amber-600",
          },
          {
            label: "Approuvés (Mois)",
            value: stats.approvedThisMonth,
            icon: CheckCircle2,
            bg: "bg-green-50",
            color: "text-green-600",
          },
          {
            label: "Clients Actifs",
            value: stats.totalClients,
            icon: Users,
            bg: "bg-purple-50",
            color: "text-purple-600",
          },
        ].map((stat, i) => (
          <div
            key={i}
            className="bg-white p-6 rounded-2xl border border-border shadow-sm flex items-center gap-4"
          >
            <div
              className={`w-12 h-12 rounded-xl flex items-center justify-center ${stat.bg} flex-shrink-0`}
            >
              <stat.icon className={`w-6 h-6 ${stat.color}`} />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">{stat.label}</p>
              <h3 className="text-2xl font-bold text-primary">{stat.value}</h3>
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Chart */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-border shadow-sm p-6">
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
                      fill={index % 2 === 0 ? "#0A192F" : "#D4AF37"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Recent activity + pending messages */}
        <div className="space-y-6">
          {/* Pending messages section */}
          {pendingConversations.length > 0 && (
            <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
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

          {/* Recent applications */}
          <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden flex flex-col">
            <div className="p-5 border-b border-border bg-slate-50">
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
