import { Link } from "wouter";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { MessageCircle, ChevronRight, Plane } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";

export default function ClientMessages() {
  const conversations = useQuery(api.messages.listConversations) ?? [];
  const isLoading = conversations === undefined;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-serif font-bold text-primary">Messagerie</h1>
        <p className="text-muted-foreground mt-1">
          Vos conversations avec les conseillers Joventy.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
        <div className="p-6 border-b border-border bg-slate-50">
          <h2 className="text-lg font-bold text-primary flex items-center gap-2">
            <MessageCircle className="w-5 h-5 text-secondary" />
            Conversations actives
          </h2>
        </div>

        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground">Chargement...</div>
        ) : conversations.length === 0 ? (
          <div className="p-12 flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-4">
              <MessageCircle className="w-8 h-8 text-slate-300" />
            </div>
            <h3 className="text-lg font-medium text-primary mb-2">Aucune conversation</h3>
            <p className="text-muted-foreground max-w-sm mx-auto">
              Vos échanges avec les conseillers Joventy apparaîtront ici, liés à chaque dossier.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {conversations.map((conv) => (
              <Link key={conv._id} href={`/dashboard/applications/${conv._id}`}>
                <div className="p-4 sm:p-5 hover:bg-slate-50 transition-colors cursor-pointer flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0 relative">
                    <Plane className="w-5 h-5 text-primary" />
                    {conv.unreadCount > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center">
                        {conv.unreadCount > 9 ? "9+" : conv.unreadCount}
                      </span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 mb-0.5">
                      <h3 className="font-bold text-primary text-sm truncate">
                        {conv.destination.toUpperCase()} — {conv.visaType}
                      </h3>
                      <StatusBadge status={conv.status} />
                    </div>
                    <p className="text-xs text-muted-foreground mb-1">
                      Pour {conv.applicantName}
                    </p>
                    {conv.lastMessage ? (
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-slate-600 truncate flex-1">
                          <span className="font-medium text-slate-500">
                            {conv.lastMessage.isFromAdmin ? "Joventy: " : "Vous: "}
                          </span>
                          {conv.lastMessage.content}
                        </p>
                        <span className="text-[10px] text-slate-400 flex-shrink-0">
                          {formatDate(conv.lastMessage._creationTime)}
                        </span>
                      </div>
                    ) : (
                      <p className="text-sm text-slate-400 italic">Aucun message</p>
                    )}
                  </div>

                  <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
