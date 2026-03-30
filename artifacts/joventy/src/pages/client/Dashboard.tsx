import { Link } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useAuth } from "@/lib/auth";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";
import {
  FileText,
  Plus,
  Clock,
  CheckCircle2,
  Plane,
  ChevronRight,
  MessageCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ClientDashboard() {
  const { user } = useAuth();
  const applications = useQuery(api.applications.list, {}) ?? [];
  const conversations = useQuery(api.messages.listConversations) ?? [];
  const unreadTotal = useQuery(api.messages.getUnreadTotal) ?? 0;
  const isLoading = applications === undefined;

  const recent = [...applications].slice(0, 3);
  const activeConvs = conversations.filter((c) => c.messageCount > 0).slice(0, 3);
  const unreadConvs = conversations.filter((c) => c.unreadCount > 0);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="rounded-2xl bg-primary p-6 sm:p-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <p className="text-secondary text-sm font-semibold uppercase tracking-widest mb-1">
            Bienvenue
          </p>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-white">
            {user?.firstName} {user?.lastName}
          </h1>
          <p className="text-slate-300 mt-1 text-sm">
            Gérez vos dossiers et suivez leur évolution en temps réel.
          </p>
        </div>
        <Link href="/dashboard/applications/new">
          <Button className="gap-2 bg-secondary text-primary hover:bg-yellow-400 font-bold h-11 px-6">
            <Plus className="w-4 h-4" /> Nouveau Dossier
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
        <div className="bg-white p-6 rounded-2xl border border-border shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
            <FileText className="w-6 h-6 text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Dossiers Totaux</p>
            <h3 className="text-2xl font-bold text-primary">{applications.length}</h3>
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl border border-border shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
            <Clock className="w-6 h-6 text-amber-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">En Cours</p>
            <h3 className="text-2xl font-bold text-primary">
              {applications.filter((a) => ["documents_pending", "in_review", "slot_hunting", "slot_found_awaiting_success_fee", "submitted"].includes(a.status)).length}
            </h3>
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl border border-border shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-green-50 flex items-center justify-center flex-shrink-0">
            <CheckCircle2 className="w-6 h-6 text-green-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">Approuvés</p>
            <h3 className="text-2xl font-bold text-primary">
              {applications.filter((a) => a.status === "completed" || a.status === "approved").length}
            </h3>
          </div>
        </div>
      </div>

      {/* Unread messages alert */}
      {unreadConvs.length > 0 && (
        <Link href="/dashboard/messages">
          <div className="bg-secondary/10 border border-secondary/30 rounded-2xl p-4 sm:p-5 flex items-center justify-between gap-4 cursor-pointer hover:bg-secondary/15 transition-colors">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center flex-shrink-0">
                <MessageCircle className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="font-bold text-primary text-sm">
                  {unreadTotal} nouveau{unreadTotal > 1 ? "x" : ""} message{unreadTotal > 1 ? "s" : ""}
                </p>
                <p className="text-xs text-slate-600">
                  {unreadConvs.length} dossier{unreadConvs.length > 1 ? "s" : ""} avec des messages non lus
                </p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-primary/60 flex-shrink-0" />
          </div>
        </Link>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Recent applications */}
        <div className="lg:col-span-3 bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="p-5 sm:p-6 border-b border-border flex justify-between items-center">
            <h2 className="text-lg font-bold text-primary">Dossiers Récents</h2>
            <Link href="/dashboard/applications" className="text-sm font-medium text-secondary hover:underline">
              Voir tout
            </Link>
          </div>
          <div>
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Chargement...</div>
            ) : recent.length === 0 ? (
              <div className="p-10 flex flex-col items-center text-center">
                <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mb-4">
                  <FileText className="w-7 h-7 text-slate-300" />
                </div>
                <h3 className="text-base font-medium text-primary mb-2">Aucun dossier</h3>
                <p className="text-muted-foreground text-sm max-w-xs mb-5">
                  Vous n'avez pas encore de dossier de demande de visa.
                </p>
                <Link href="/dashboard/applications/new">
                  <Button size="sm">Créer mon premier dossier</Button>
                </Link>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {recent.map((app) => (
                  <Link key={app._id} href={`/dashboard/applications/${app._id}`}>
                    <div className="p-4 sm:p-5 hover:bg-slate-50 transition-colors flex items-center justify-between gap-4 cursor-pointer">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center border border-border flex-shrink-0">
                          <Plane className="w-4 h-4 text-slate-500" />
                        </div>
                        <div>
                          <h4 className="font-bold text-primary text-sm">
                            {app.destination.toUpperCase()} — {app.visaType}
                          </h4>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {app.applicantName} · {formatDate(app.updatedAt)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <StatusBadge status={app.status} />
                        <ChevronRight className="w-4 h-4 text-slate-300 hidden sm:block" />
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Conversations preview */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="p-5 sm:p-6 border-b border-border flex justify-between items-center">
            <h2 className="text-lg font-bold text-primary flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-secondary" />
              Conversations
            </h2>
            <Link href="/dashboard/messages" className="text-sm font-medium text-secondary hover:underline">
              Voir tout
            </Link>
          </div>
          <div>
            {activeConvs.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">
                Aucune conversation active.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {activeConvs.map((conv) => (
                  <Link key={conv._id} href={`/dashboard/applications/${conv._id}`}>
                    <div className="p-4 hover:bg-slate-50 transition-colors cursor-pointer flex items-start gap-3">
                      <div className="relative flex-shrink-0 mt-0.5">
                        <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                          <Plane className="w-4 h-4 text-primary" />
                        </div>
                        {conv.unreadCount > 0 && (
                          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
                            {conv.unreadCount > 9 ? "9+" : conv.unreadCount}
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-primary text-xs truncate">
                          {conv.destination.toUpperCase()} — {conv.visaType}
                        </p>
                        {conv.lastMessage && (
                          <p className={`text-xs truncate mt-0.5 ${conv.unreadCount > 0 ? "font-semibold text-slate-800" : "text-slate-500"}`}>
                            {conv.lastMessage.isFromAdmin ? "Joventy: " : "Vous: "}
                            {conv.lastMessage.content}
                          </p>
                        )}
                        {conv.lastMessage && (
                          <p className="text-[10px] text-slate-400 mt-0.5">
                            {formatDate(conv.lastMessage._creationTime)}
                          </p>
                        )}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
