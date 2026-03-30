import { Link } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { MessageCircle, ChevronRight, User } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";

export default function AdminMessages() {
  const conversations = useQuery(api.messages.listConversations) ?? [];
  const isLoading = conversations === undefined;

  const withMessages = conversations.filter((c) => c.messageCount > 0);
  const pending = withMessages.filter((c) => c.unreadCount > 0);
  const read = withMessages.filter((c) => c.unreadCount === 0);

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold text-primary">Messagerie</h1>
          <p className="text-muted-foreground mt-1">
            Toutes les conversations clients classées par activité récente.
          </p>
        </div>
        {pending.length > 0 && (
          <div className="flex items-center gap-2 bg-red-50 text-red-700 border border-red-200 px-4 py-2 rounded-xl text-sm font-semibold">
            <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
            {pending.length} conversation{pending.length > 1 ? "s" : ""} en attente de réponse
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="bg-white rounded-2xl border border-border shadow-sm p-12 text-center text-muted-foreground">
          Chargement...
        </div>
      ) : withMessages.length === 0 ? (
        <div className="bg-white rounded-2xl border border-border shadow-sm p-12 flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-4">
            <MessageCircle className="w-8 h-8 text-slate-300" />
          </div>
          <h3 className="text-lg font-medium text-primary mb-2">Aucune conversation</h3>
          <p className="text-muted-foreground max-w-sm mx-auto">
            Les échanges avec les clients apparaîtront ici, liés à leurs dossiers.
          </p>
        </div>
      ) : (
        <>
          {pending.length > 0 && (
            <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
              <div className="p-5 border-b border-border bg-red-50 flex items-center gap-2">
                <span className="w-2 h-2 bg-red-500 rounded-full" />
                <h2 className="text-base font-bold text-red-700">
                  Messages non lus ({pending.length})
                </h2>
              </div>
              <div className="divide-y divide-border">
                {pending.map((conv) => (
                  <ConversationRow key={conv._id} conv={conv} />
                ))}
              </div>
            </div>
          )}

          {read.length > 0 && (
            <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
              <div className="p-5 border-b border-border bg-slate-50">
                <h2 className="text-base font-bold text-primary">
                  Conversations lues ({read.length})
                </h2>
              </div>
              <div className="divide-y divide-border">
                {read.map((conv) => (
                  <ConversationRow key={conv._id} conv={conv} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ConversationRow({
  conv,
}: {
  conv: {
    _id: string;
    applicantName: string;
    destination: string;
    visaType: string;
    status: string;
    userFirstName?: string;
    userLastName?: string;
    userEmail?: string;
    unreadCount: number;
    messageCount: number;
    lastMessage: {
      content: string;
      senderName: string;
      isFromAdmin: boolean;
      _creationTime: number;
    } | null;
  };
}) {
  return (
    <Link href={`/admin/applications/${conv._id}`}>
      <div className="p-4 sm:p-5 hover:bg-slate-50 transition-colors cursor-pointer flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0 relative">
          <User className="w-5 h-5 text-primary" />
          {conv.unreadCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center">
              {conv.unreadCount > 9 ? "9+" : conv.unreadCount}
            </span>
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 mb-0.5">
            <h3 className={`font-bold text-sm truncate ${conv.unreadCount > 0 ? "text-primary" : "text-slate-600"}`}>
              {conv.userFirstName} {conv.userLastName}
              {conv.userEmail && (
                <span className="font-normal text-xs text-muted-foreground ml-1.5">
                  ({conv.userEmail})
                </span>
              )}
            </h3>
            <StatusBadge status={conv.status} />
          </div>
          <p className="text-xs text-muted-foreground mb-1">
            {conv.destination.toUpperCase()} — {conv.visaType} | {conv.applicantName}
          </p>
          {conv.lastMessage ? (
            <div className="flex items-center gap-2">
              <p className={`text-sm truncate flex-1 ${conv.unreadCount > 0 ? "font-semibold text-slate-800" : "text-slate-500"}`}>
                <span className="text-slate-400 font-normal">
                  {conv.lastMessage.isFromAdmin ? "Vous: " : `${conv.lastMessage.senderName}: `}
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
  );
}
