/**
 * VictorWidget — Agent commercial Joventy
 * Page-aware, toujours en français, mobile-first
 * v2 : mémoire conversationnelle, animation bulle, notification au survol
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { useAuth } from "@/lib/auth";
import { X, Send, MessageCircle, ChevronRight, Loader2 } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  role: "user" | "victor";
  content: string;
  ts: number;
  ctaButtons?: { label: string; href: string }[];
}

interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

// ─── Son de notification (Web Audio API — sans dépendance) ────────────────────

function playNotificationChime() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.55);
    setTimeout(() => ctx.close(), 700);
  } catch { /* AudioContext non disponible */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSessionId(): string {
  try {
    let id = localStorage.getItem("victor_session_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("victor_session_id", id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function getConvexSiteUrl(): string {
  const cloudUrl = import.meta.env.VITE_CONVEX_URL as string;
  return cloudUrl?.replace(".convex.cloud", ".convex.site") ?? "";
}

/** Extrait les boutons CTA du texte Victor et retourne le texte nettoyé + boutons */
function parseCTAs(text: string): { clean: string; buttons: { label: string; href: string }[] } {
  const buttons: { label: string; href: string }[] = [];
  const clean = text.replace(/\[CTA:([^\]|:]+):([^\]]+)\]/g, (_match, label, href) => {
    buttons.push({ label: label.trim(), href: href.trim() });
    return "";
  }).trim();
  return { clean, buttons };
}

/** Message d'ouverture contextualisé par page */
function getOpeningMessage(page: string, isAuth: boolean): string {
  if (page === "/" || page === "") {
    return "Bonjour ! Je suis Victor, conseiller Joventy. En 30 secondes, dites-moi : pour quel pays souhaitez-vous obtenir un visa ?";
  }
  if (page === "/prix") {
    return "Je vois que vous comparez nos formules. Ce qui fait vraiment la différence ici, c'est notre taux d'acceptation à 94 %. Quelle destination vous intéresse ?";
  }
  if (page === "/audit-diagnostic") {
    return "Vous souhaitez faire le point sur votre dossier ? Dites-moi votre destination et votre situation actuelle — je vous donne une évaluation précise en 2 minutes.";
  }
  if (page === "/dashboard/contrat") {
    return "Votre contrat n'est pas encore signé. C'est la seule chose qui bloque le démarrage de votre dossier. Voulez-vous que je vous guide en 2 minutes ?";
  }
  if (isAuth) {
    return "Bienvenue ! Votre compte est prêt. Il ne manque plus que votre dossier pour commencer. Par où souhaitez-vous partir ?";
  }
  if (page.startsWith("/guides")) {
    return "Ce guide vous intéresse ? Je peux vous donner les informations spécifiques à votre situation. Quel est votre pays de destination ?";
  }
  if (page.startsWith("/ambassade") || page.startsWith("/destinations")) {
    return "Vous vous renseignez sur cette destination ? Dites-moi votre nationalité et le type de visa — je vous donne les vraies informations en direct.";
  }
  return "Bonjour ! Je suis Victor, conseiller Joventy. Comment puis-je vous aider aujourd'hui ?";
}

/** Délai avant ouverture automatique selon la page */
function getAutoOpenDelay(page: string): number | null {
  if (page === "/dashboard/contrat") return 0;
  if (page === "/prix") return 8_000;
  if (page === "/" || page === "") return 15_000;
  return null;
}

/** Extrait l'historique conversationnel depuis les messages (exclut le message d'accueil) */
function buildHistory(messages: Message[]): HistoryTurn[] {
  // Exclure le premier message (greeting Victor) et garder max 12 tours
  const relevant = messages.slice(1);
  return relevant.slice(-12).map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
  }));
}

// ─── Composant principal ──────────────────────────────────────────────────────

export function VictorWidget() {
  const [location, navigate] = useLocation();
  const { user } = useAuth();
  const markConvinced = useMutation(api.victor.markConvinced);

  const [isOpen, setIsOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId] = useState(getSessionId);
  const [showBubblePulse, setShowBubblePulse] = useState(false);
  const [showHoverTooltip, setShowHoverTooltip] = useState(false);
  const [hoverSoundPlayed, setHoverSoundPlayed] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hoverTooltipTimer = useRef<ReturnType<typeof setTimeout>>();
  const siteUrl = getConvexSiteUrl();

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  // Focus input when open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen]);

  // Auto-ouverture selon la page
  useEffect(() => {
    const delay = getAutoOpenDelay(location);
    if (delay === null) {
      // Pulse la bulle après 20s pour attirer l'attention
      const pulseTimer = setTimeout(() => setShowBubblePulse(true), 20_000);
      return () => clearTimeout(pulseTimer);
    }

    const timer = setTimeout(() => {
      if (!hasOpened) {
        openWithGreeting();
      }
    }, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  const openWithGreeting = useCallback(() => {
    if (hasOpened && messages.length > 0) {
      setIsOpen(true);
      return;
    }
    setHasOpened(true);
    setIsOpen(true);
    setShowBubblePulse(false);
    setShowHoverTooltip(false);
    const greeting = getOpeningMessage(location, !!user);
    const { clean, buttons } = parseCTAs(greeting);
    setMessages([{ role: "victor", content: clean, ts: Date.now(), ctaButtons: buttons }]);
  }, [hasOpened, messages.length, location, user]);

  // Survol de la bulle : notification + son
  const handleBubbleMouseEnter = useCallback(() => {
    if (isOpen) return;
    // Son une seule fois par session
    if (!hoverSoundPlayed) {
      playNotificationChime();
      setHoverSoundPlayed(true);
    }
    clearTimeout(hoverTooltipTimer.current);
    setShowHoverTooltip(true);
  }, [isOpen, hoverSoundPlayed]);

  const handleBubbleMouseLeave = useCallback(() => {
    hoverTooltipTimer.current = setTimeout(() => setShowHoverTooltip(false), 300);
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isTyping) return;
    setInput("");

    const userMsg: Message = { role: "user", content: text, ts: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setIsTyping(true);

    try {
      // Construire l'historique conversationnel (sans le msg courant)
      const history = buildHistory([...messages]);

      const res = await fetch(`${siteUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId,
          pageContext: location,
          isAuth: !!user,
          history, // mémoire conversationnelle
        }),
      });

      const data = await res.json() as { text?: string };
      const raw = data.text ?? "Je suis momentanément indisponible. Veuillez réessayer.";
      const { clean, buttons } = parseCTAs(raw);

      setMessages((prev) => [
        ...prev,
        { role: "victor", content: clean, ts: Date.now(), ctaButtons: buttons },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "victor",
          content: "Une erreur est survenue. Veuillez réessayer dans un instant.",
          ts: Date.now(),
        },
      ]);
    } finally {
      setIsTyping(false);
    }
  }, [isTyping, siteUrl, sessionId, location, user, messages]);

  const handleCTA = useCallback(
    async (label: string, href: string) => {
      try {
        await markConvinced({
          sessionId,
          action: `cta_click_${label.toLowerCase().replace(/\s+/g, "_")}`,
        });
      } catch { /* non bloquant */ }
      navigate(href);
      setIsOpen(false);
    },
    [markConvinced, navigate, sessionId]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Bulle flottante ── */}
      {!isOpen && (
        <div className="fixed bottom-5 right-5 z-50">
          {/* Tooltip de survol */}
          {showHoverTooltip && (
            <div
              className="
                absolute bottom-16 right-0 mb-1
                bg-white border border-border shadow-xl rounded-xl
                px-3.5 py-2.5 text-sm text-primary font-medium
                whitespace-nowrap pointer-events-none
                animate-in fade-in slide-in-from-bottom-2 duration-200
              "
            >
              <span className="text-base mr-1.5">👋</span>
              Besoin d'aide pour votre visa ?
              {/* Flèche */}
              <span className="absolute -bottom-1.5 right-5 w-3 h-3 bg-white border-r border-b border-border rotate-45 block" />
            </div>
          )}

          {/* Anneaux d'animation */}
          {showBubblePulse && (
            <>
              <span className="absolute inset-0 rounded-full bg-primary/20 animate-ping" style={{ animationDuration: "1.5s" }} />
              <span className="absolute -inset-1 rounded-full border-2 border-primary/30 animate-pulse" />
            </>
          )}
          {/* Anneau permanent subtil */}
          <span className="absolute -inset-1 rounded-full border border-primary/20 animate-pulse" style={{ animationDuration: "3s" }} />

          <button
            onClick={openWithGreeting}
            onMouseEnter={handleBubbleMouseEnter}
            onMouseLeave={handleBubbleMouseLeave}
            aria-label="Parler à Victor, conseiller Joventy"
            className="
              relative w-14 h-14 rounded-full bg-primary shadow-xl
              flex items-center justify-center
              transition-all duration-300
              hover:scale-110 hover:shadow-primary/30 hover:shadow-2xl
              active:scale-95
            "
          >
            <MessageCircle className="w-6 h-6 text-white" />
            {showBubblePulse && (
              <span className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-red-500 rounded-full border-2 border-white animate-bounce" />
            )}
          </button>
        </div>
      )}

      {/* ── Panneau chat ── */}
      {isOpen && (
        <div
          className={`
            fixed z-50 bg-white shadow-2xl flex flex-col
            bottom-0 left-0 right-0 h-[85dvh] rounded-t-2xl
            sm:bottom-5 sm:right-5 sm:left-auto sm:w-[380px] sm:h-[560px] sm:rounded-2xl
            border border-border
            animate-in slide-in-from-bottom-4 duration-300
          `}
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-primary rounded-t-2xl flex-shrink-0">
            <div className="relative">
              <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center">
                <span className="text-white font-bold text-sm">V</span>
              </div>
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-400 rounded-full border-2 border-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold text-sm leading-tight">Victor</p>
              <p className="text-slate-300 text-xs truncate">Conseiller Joventy · En ligne</p>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/10 transition-colors"
              aria-label="Fermer"
            >
              <X className="w-4 h-4 text-white" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 scroll-smooth">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} gap-2`}>
                {msg.role === "victor" && (
                  <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-primary font-bold text-xs">V</span>
                  </div>
                )}
                <div className={`max-w-[80%] flex flex-col gap-1.5 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                  <div
                    className={`
                      px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed
                      ${msg.role === "user"
                        ? "bg-primary text-white rounded-br-sm"
                        : "bg-slate-100 text-primary rounded-bl-sm"
                      }
                    `}
                  >
                    {msg.content}
                  </div>
                  {msg.ctaButtons && msg.ctaButtons.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {msg.ctaButtons.map((btn, bi) => (
                        <button
                          key={bi}
                          onClick={() => handleCTA(btn.label, btn.href)}
                          className="
                            inline-flex items-center gap-1 px-3 py-1.5 rounded-full
                            bg-primary text-white text-xs font-semibold
                            hover:bg-primary/90 active:scale-95 transition-all duration-150
                          "
                        >
                          {btn.label}
                          <ChevronRight className="w-3 h-3" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Indicateur de frappe */}
            {isTyping && (
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <span className="text-primary font-bold text-xs">V</span>
                </div>
                <div className="bg-slate-100 px-3.5 py-3 rounded-2xl rounded-bl-sm flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-3 border-t border-border flex-shrink-0">
            <div className="flex items-center gap-2 bg-slate-50 rounded-xl px-3 py-2 border border-border focus-within:border-primary/50 transition-colors">
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Écrivez votre message…"
                disabled={isTyping}
                className="flex-1 bg-transparent text-sm text-primary placeholder:text-slate-400 outline-none disabled:opacity-50"
                maxLength={500}
              />
              <button
                onClick={() => sendMessage(input)}
                disabled={!input.trim() || isTyping}
                className="
                  w-8 h-8 rounded-lg bg-primary flex items-center justify-center flex-shrink-0
                  hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed
                  transition-all duration-150 active:scale-95
                "
                aria-label="Envoyer"
              >
                {isTyping
                  ? <Loader2 className="w-4 h-4 text-white animate-spin" />
                  : <Send className="w-4 h-4 text-white" />
                }
              </button>
            </div>
            <p className="text-center text-[10px] text-slate-400 mt-2">
              Conseiller Joventy · Réponse en quelques secondes
            </p>
          </div>
        </div>
      )}
    </>
  );
}
