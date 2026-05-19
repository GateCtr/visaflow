/**
 * Panneau de messagerie client — colonne droite sticky.
 */
import { useState, useRef, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Doc, Id } from "@convex/_generated/dataModel";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, ShieldCheck } from "lucide-react";
import { formatDate } from "@/lib/format";

interface Props {
  appId: Id<"applications">;
  messages: Doc<"messages">[];
  firstName: string;
  lastName: string;
}

export function ChatPanel({ appId, messages, firstName, lastName }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [msgText, setMsgText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const { toast } = useToast();

  const sendMessage = useMutation(api.messages.send);
  const markAsRead = useMutation(api.messages.markAsRead);

  useEffect(() => {
    if (appId && messages.length > 0) {
      markAsRead({ applicationId: appId });
    }
  }, [appId, messages.length]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!msgText.trim() || !appId) return;
    setIsSending(true);
    try {
      await sendMessage({ applicationId: appId, content: msgText });
      setMsgText("");
    } catch (err: unknown) {
      toast({
        variant: "destructive",
        title: "Erreur d'envoi",
        description: err instanceof Error ? err.message : "Le message n'a pas pu être envoyé.",
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
          <ShieldCheck className="w-4 h-4 text-white" />
        </div>
        <div>
          <h3 className="font-semibold text-slate-800 text-sm">Messagerie</h3>
          <p className="text-xs text-slate-500">{firstName} {lastName}</p>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-slate-400 text-sm py-12">
            <p className="font-medium">Aucun message</p>
            <p className="text-xs mt-1">Initiez la conversation avec le client.</p>
          </div>
        )}
        {messages.map((msg: Doc<"messages">) => {
          const isAdmin = msg.isFromAdmin;
          return (
            <div key={msg._id} className={`flex flex-col ${isAdmin ? "items-end" : "items-start"}`}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] font-medium text-slate-400">{msg.senderName}</span>
                <span className="text-[10px] text-slate-300">{formatDate(msg._creationTime)}</span>
              </div>
              <div
                className={`px-4 py-2.5 rounded-2xl max-w-[85%] text-sm leading-relaxed ${
                  isAdmin
                    ? "bg-gradient-to-br from-blue-600 to-indigo-600 text-white rounded-br-md shadow-sm"
                    : "bg-slate-100 text-slate-800 rounded-bl-md border border-slate-200/60"
                }`}
              >
                {msg.content}
              </div>
            </div>
          );
        })}
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="px-4 py-3 border-t border-slate-100 bg-slate-50/50">
        <div className="relative">
          <Input
            value={msgText}
            onChange={(e) => setMsgText(e.target.value)}
            placeholder="Répondre au client..."
            className="pr-11 h-11 rounded-xl bg-white border-slate-200 focus:border-blue-300 focus:ring-blue-100 text-sm"
          />
          <Button
            type="submit"
            size="icon"
            disabled={isSending || !msgText.trim()}
            className="absolute right-1.5 top-1.5 h-8 w-8 rounded-lg bg-blue-600 hover:bg-blue-700 text-white shadow-sm"
          >
            <Send className="w-3.5 h-3.5" />
          </Button>
        </div>
      </form>
    </div>
  );
}
