import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
  Flag,
  Filter,
  Mail,
  Phone,
  Calendar,
  Users,
  TrendingUp,
  Eye,
  BarChart2,
} from "lucide-react";

type Status = "all" | "pending" | "confirmed" | "rejected";

const STATUS_LABELS: Record<string, { label: string; color: string; icon: React.ComponentType<{ className?: string }> }> = {
  pending: { label: "En attente", color: "bg-amber-100 text-amber-700 border-amber-200", icon: Clock },
  confirmed: { label: "Confirmé", color: "bg-green-100 text-green-700 border-green-200", icon: CheckCircle2 },
  rejected: { label: "Rejeté", color: "bg-red-100 text-red-700 border-red-200", icon: XCircle },
};

function StatCard({ icon: Icon, label, value, sub, color = "text-primary" }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-border shadow-sm p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{label}</p>
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
          <Icon className="w-4 h-4 text-primary" />
        </div>
      </div>
      <p className={`text-3xl font-black ${color}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

export default function SpainAlerts() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<Status>("all");
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const orders = useQuery(
    api.spainAlert.listOrders,
    statusFilter === "all" ? {} : { status: statusFilter as "pending" | "confirmed" | "rejected" }
  );
  const stats = useQuery(api.spainAlert.getStats, {});

  const confirmOrder = useMutation(api.spainAlert.confirmOrder);
  const rejectOrder = useMutation(api.spainAlert.rejectOrder);

  const handleConfirm = async (orderId: Id<"spainAlertOrders">) => {
    setConfirmingId(orderId);
    try {
      await confirmOrder({ orderId });
      toast({ title: "Commande confirmée ✅", description: "Le lien du groupe a été envoyé par email au client." });
    } catch (e: unknown) {
      toast({ variant: "destructive", title: "Erreur", description: e instanceof Error ? e.message : "Erreur inconnue" });
    } finally {
      setConfirmingId(null);
    }
  };

  const handleReject = async (orderId: Id<"spainAlertOrders">) => {
    try {
      await rejectOrder({ orderId, reason: rejectReason || undefined });
      toast({ title: "Commande rejetée" });
      setRejectingId(null);
      setRejectReason("");
    } catch (e: unknown) {
      toast({ variant: "destructive", title: "Erreur", description: e instanceof Error ? e.message : "Erreur inconnue" });
    }
  };

  const formatDate = (ts: number) =>
    new Date(ts).toLocaleDateString("fr-FR", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Flag className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-primary">Alertes Espagne 🇪🇸</h1>
            <p className="text-muted-foreground text-sm">Groupe WhatsApp · 10 USD / accès à vie</p>
          </div>
        </div>
        <a href="/alerte-espagne" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-primary hover:underline font-medium">
          <ExternalLink className="w-3.5 h-3.5" /> Voir la page
        </a>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          <StatCard icon={Eye} label="Visites page" value={stats.pageViews} sub={`${stats.uniqueSessions} sessions uniques`} />
          <StatCard icon={Users} label="Commandes totales" value={stats.total} sub={`+${stats.recent7d} ces 7 derniers jours`} />
          <StatCard icon={Clock} label="En attente" value={stats.pending} color={stats.pending > 0 ? "text-amber-600" : "text-primary"} sub="À confirmer" />
          <StatCard icon={TrendingUp} label="Taux de conversion" value={`${stats.conversionRate}%`} sub={`${stats.confirmed} confirmés / ${stats.rejected} rejetés`} />
        </div>
      )}

      {/* Revenue estimate */}
      {stats && stats.confirmed > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-2xl p-4 mb-6 flex items-center gap-4">
          <BarChart2 className="w-5 h-5 text-green-600 flex-shrink-0" />
          <div>
            <p className="font-bold text-green-800">Revenus estimés : {stats.confirmed * 10} USD</p>
            <p className="text-xs text-green-600">{stats.confirmed} accès confirmés × 10 USD · {stats.pending} paiement(s) en attente de validation</p>
          </div>
        </div>
      )}

      {/* Filter */}
      <div className="flex items-center gap-2 mb-6">
        <Filter className="w-4 h-4 text-muted-foreground" />
        {(["all", "pending", "confirmed", "rejected"] as Status[]).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all border ${
              statusFilter === s
                ? "bg-primary text-white border-primary shadow-sm"
                : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary"
            }`}
          >
            {s === "all" ? "Toutes" : STATUS_LABELS[s].label}
            {s === "pending" && stats && stats.pending > 0 && (
              <span className="ml-1.5 bg-amber-500 text-white text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full inline-flex items-center justify-center">
                {stats.pending}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* List */}
      {orders === undefined ? (
        <div className="text-center py-20 text-muted-foreground">Chargement...</div>
      ) : orders.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-2xl border border-border">
          <Flag className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-muted-foreground font-medium">Aucune commande{statusFilter !== "all" ? ` "${STATUS_LABELS[statusFilter]?.label}"` : ""}.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => {
            const s = STATUS_LABELS[order.status];
            const StatusIcon = s.icon;
            return (
              <div key={order._id} className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
                <div className="p-6">
                  <div className="flex items-start justify-between gap-4">
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-3">
                        <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center font-bold text-primary text-lg">
                          {order.name[0]?.toUpperCase()}
                        </div>
                        <div>
                          <p className="font-bold text-primary">{order.name}</p>
                          <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${s.color}`}>
                            <StatusIcon className="w-3 h-3" />
                            {s.label}
                          </div>
                        </div>
                      </div>
                      <div className="grid sm:grid-cols-2 gap-2 text-sm text-muted-foreground">
                        <div className="flex items-center gap-2">
                          <Mail className="w-3.5 h-3.5" />
                          <a href={`mailto:${order.email}`} className="hover:text-primary transition-colors truncate">{order.email}</a>
                        </div>
                        {order.phone && (
                          <div className="flex items-center gap-2">
                            <Phone className="w-3.5 h-3.5" />
                            <span>{order.phone}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <Calendar className="w-3.5 h-3.5" />
                          <span>{formatDate(order.createdAt)}</span>
                        </div>
                        {order.confirmedAt && (
                          <div className="flex items-center gap-2 text-green-600">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Confirmé le {formatDate(order.confirmedAt)}</span>
                          </div>
                        )}
                        {order.adminNote && (
                          <div className="flex items-center gap-2 text-red-600 sm:col-span-2">
                            <XCircle className="w-3.5 h-3.5" />
                            <span>Motif : {order.adminNote}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Proof */}
                    <div className="flex-shrink-0">
                      {order.proofUrl ? (
                        <a href={order.proofUrl} target="_blank" rel="noreferrer"
                          className="block w-20 h-20 rounded-xl overflow-hidden border border-border hover:border-primary transition-colors group relative"
                        >
                          <img src={order.proofUrl} alt="Preuve" className="w-full h-full object-cover"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                          />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <ExternalLink className="w-5 h-5 text-white" />
                          </div>
                        </a>
                      ) : (
                        <div className="w-20 h-20 rounded-xl border border-dashed border-border flex items-center justify-center">
                          <ExternalLink className="w-6 h-6 text-muted-foreground" />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  {order.status === "pending" && (
                    <div className="mt-4 pt-4 border-t border-border flex flex-col sm:flex-row gap-3">
                      {rejectingId === order._id ? (
                        <div className="flex-1 flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                            placeholder="Motif de rejet (optionnel)"
                            className="flex-1 border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
                          />
                          <Button variant="destructive" size="sm" onClick={() => handleReject(order._id as Id<"spainAlertOrders">)}>
                            Confirmer le rejet
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => { setRejectingId(null); setRejectReason(""); }}>
                            Annuler
                          </Button>
                        </div>
                      ) : (
                        <>
                          <Button
                            onClick={() => handleConfirm(order._id as Id<"spainAlertOrders">)}
                            disabled={confirmingId === order._id}
                            className="flex-1 bg-green-600 hover:bg-green-700 text-white gap-2"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            {confirmingId === order._id ? "Envoi en cours..." : "Confirmer & envoyer le lien"}
                          </Button>
                          <Button variant="outline" onClick={() => setRejectingId(order._id)}
                            className="border-red-200 text-red-600 hover:bg-red-50 gap-2"
                          >
                            <XCircle className="w-4 h-4" /> Rejeter
                          </Button>
                          {order.proofUrl && (
                            <a href={order.proofUrl} target="_blank" rel="noreferrer">
                              <Button variant="outline" className="gap-2">
                                <ExternalLink className="w-4 h-4" /> Voir preuve
                              </Button>
                            </a>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
