/**
 * VictorWidget — Agent commercial Joventy
 * Page-aware, toujours en français, mobile-first
 * v3 : streaming progressif, rendu naturel des messages, tracking auth funnel
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
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

// ─── Rendu des messages Victor ────────────────────────────────────────────────
// Transforme le texte brut en JSX : sauts de ligne, gras, italique.
// Pas de librairie externe — implémentation légère ciblée sur ce que Victor produit.

function renderInline(text: string): React.ReactNode {
  if (!text) return null;
  const re = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined)
      parts.push(<strong key={k++} className="font-semibold">{m[1]}</strong>);
    else if (m[2] !== undefined)
      parts.push(<em key={k++}>{m[2]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 0 ? null : parts.length === 1 ? parts[0] : <React.Fragment>{parts}</React.Fragment>;
}

function MessageContent({ text }: { text: string }) {
  // Séparer par double saut de ligne (paragraphes)
  const paragraphs = text.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((para, pi) => {
        const lines = para.split("\n");
        return (
          <p key={pi} className={pi > 0 ? "mt-2" : undefined}>
            {lines.map((line, li) => (
              <React.Fragment key={li}>
                {li > 0 && <br />}
                {renderInline(line)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

// ─── Son de notification ──────────────────────────────────────────────────────

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

/**
 * Extrait les boutons CTA du texte et retourne le texte nettoyé + boutons.
 * Supporte : [CTA:Label:/chemin]  et  [Label:/chemin]
 */
function parseCTAs(text: string): { clean: string; buttons: { label: string; href: string }[] } {
  const buttons: { label: string; href: string }[] = [];

  // Regex robuste :
  //   [CTA:Label:/path]        format strict
  //   [CTA:Label : /path]      avec espaces autour du séparateur (Claude en produit parfois)
  //   [Label:/path]            sans préfixe CTA:
  // Le quantifier lazy +? + \s* gère les espaces avant le séparateur (:)
  // Le \s* après le séparateur absorbe les espaces avant le path (/ ...)
  const regex = /\[(?:CTA:)?([^\]|:\n]+?)\s*:\s*(\/[^\]\n]+?)\s*\]/g;

  const found: { match: string; label: string; href: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const label = m[1].trim();
    const href = m[2].trim();
    // Ignorer si le href ne ressemble pas à un chemin valide
    if (!href.startsWith("/")) continue;
    found.push({ match: m[0], label, href, index: m.index });
  }

  let clean = text;
  for (let i = found.length - 1; i >= 0; i--) {
    const cta = found[i];
    const afterCTA = text.slice(cta.index + cta.match.length).trim();
    const isAtEnd = /^[.!?…\s]*$/.test(afterCTA) || afterCTA === "";
    const replacement = isAtEnd ? "" : cta.label;
    clean = clean.slice(0, cta.index) + replacement + clean.slice(cta.index + cta.match.length);
    if (!buttons.find((b) => b.href === cta.href)) {
      buttons.unshift({ label: cta.label, href: cta.href });
    }
  }

  // Cleanup : préserver les sauts de ligne (\n) pour le rendu par paragraphes
  // Ne collapsons QUE les espaces horizontaux — pas les \n
  clean = clean
    .replace(/[^\S\n]{2,}/g, " ")        // espaces multiples → un seul (sans toucher \n)
    .replace(/\n{3,}/g, "\n\n")           // max 2 sauts de ligne consécutifs
    .replace(/[^\S\n]+([.,!?])/g, "$1")  // supprimer espaces avant ponctuation
    .trim();

  return { clean, buttons };
}

/** Message d'ouverture contextualisé par page. */
function getOpeningMessage(page: string, isAuth: boolean): string {
  if (page === "/" || page === "") {
    return "Bonjour ! Je suis Victor, conseiller Joventy. Vous cherchez un visa pour quelle destination ?";
  }
  if (page === "/prix") {
    return "Vous comparez nos formules ? Notre taux d'acceptation est à 94 %. Dites-moi la destination qui vous intéresse, je vous donne le tarif exact.";
  }
  if (page === "/audit-diagnostic") {
    return "Vous voulez faire le point sur votre situation ? Dites-moi la destination et où vous en êtes — je vous donne une évaluation précise.";
  }
  if (page === "/dashboard/contrat") {
    return "Votre contrat n'est pas encore signé — c'est le seul blocage avant le démarrage. Je vous guide en 2 minutes ?";
  }
  if (page === "/dashboard/applications/new") {
    return "Vous ouvrez un nouveau dossier. Quelle destination ? Je vous explique ce qu'il faut préparer.";
  }
  if (page.startsWith("/guides")) {
    const slug = page.replace("/guides/", "").toLowerCase();
    if (slug.includes("espagne") || slug.includes("spain") || slug.includes("cev"))
      return "Vous cherchez à obtenir un RDV pour l'Espagne ? La première étape c'est l'email à l'ambassade. Vous l'avez déjà envoyé ?";
    if (slug.includes("usa") || slug.includes("etats-unis") || slug.includes("amerique"))
      return "Attention — les créneaux USA sont suspendus à Kinshasa (alerte Ebola en cours). Je peux vous proposer des alternatives si vous le souhaitez.";
    if (slug.includes("canada"))
      return "Les services Canada sont suspendus jusqu'au 28 août 2026 (restrictions IRCC). On peut regarder des alternatives en attendant ?";
    if (slug.includes("schengen") || slug.includes("france") || slug.includes("belgique") || slug.includes("allemagne"))
      return "Vous vous renseignez sur le visa Schengen ? C'est notre spécialité — 94 % d'acceptation. Quel pays Schengen vous intéresse ?";
    if (slug.includes("dubai") || slug.includes("eau") || slug.includes("emirats"))
      return "L'e-Visa Dubaï c'est rapide — 48 à 72h. Vous en êtes où dans votre démarche ?";
    if (slug.includes("rendezvous") || slug.includes("rendez-vous") || slug.includes("creneau") || slug.includes("créneau"))
      return "Vous cherchez un créneau consulaire ? Dites-moi pour quelle ambassade, je vous explique comment ça marche.";
    return "Ce guide vous intéresse ? Dites-moi votre situation concrète, je vous oriente directement.";
  }
  if (page.startsWith("/ambassade") || page.startsWith("/destinations"))
    return "Vous vous renseignez sur cette destination ? Dites-moi votre type de visa et je vous donne les vraies informations.";
  if (page.startsWith("/dashboard") && isAuth)
    return "Besoin d'aide sur votre dossier ? Je suis là.";
  return "Bonjour, je suis Victor. Comment puis-je vous aider ?";
}

/** Délai avant ouverture automatique selon la page */
function getAutoOpenDelay(page: string): number | null {
  if (page === "/dashboard/contrat") return 0;
  if (page === "/prix") return 8_000;
  if (page === "/" || page === "") return 15_000;
  return null;
}

/** Extrait l'historique conversationnel (sans le greeting) */
function buildHistory(messages: Message[]): HistoryTurn[] {
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

  const [isOpen, setIsOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sessionId] = useState(getSessionId);
  const [showBubblePulse, setShowBubblePulse] = useState(false);
  const [showHoverTooltip, setShowHoverTooltip] = useState(false);
  const [hoverSoundPlayed, setHoverSoundPlayed] = useState(false);

  // Streaming : révélation progressive du texte de Victor
  const [streamingMsg, setStreamingMsg] = useState<{
    full: string;
    shown: string;
    buttons: { label: string; href: string }[];
  } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hoverTooltipTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const siteUrl = getConvexSiteUrl();

  const recordCTAClick = useMutation(api.victor.recordCTAClick);

  // ── Scroll automatique ────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping, streamingMsg?.shown]);

  // ── Focus à l'ouverture ────────────────────────────────────────────────────
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen]);

  // ── Ouverture automatique selon la page ───────────────────────────────────
  useEffect(() => {
    const delay = getAutoOpenDelay(location);
    if (delay === null) return;
    if (delay === 0) {
      if (!hasOpened) openWithGreeting();
      return;
    }
    const timer = setTimeout(() => {
      if (!hasOpened) openWithGreeting();
    }, delay);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  // ── Streaming progressif ──────────────────────────────────────────────────
  // Révèle le texte de Victor caractère par caractère avec des pauses naturelles
  // après la ponctuation, simulant une frappe humaine.
  useEffect(() => {
    if (!streamingMsg) return;

    if (streamingMsg.shown.length >= streamingMsg.full.length) {
      // Streaming terminé — enregistre le message dans la liste
      setMessages((prev) => [
        ...prev,
        {
          role: "victor",
          content: streamingMsg.full,
          ts: Date.now(),
          ctaButtons: streamingMsg.buttons,
        },
      ]);
      setStreamingMsg(null);
      return;
    }

    const pos = streamingMsg.shown.length;
    const ch = streamingMsg.full[pos];

    // Pauses naturelles selon le caractère courant
    const isPause = ".!?\n".includes(ch);      // pause longue après ponctuation forte
    const isBrief = ",;:".includes(ch);         // pause courte après virgule/deux-points

    // Nombre de caractères révélés en une fois (plus rapide sur texte courant)
    const reveal = isPause || isBrief ? 1 : Math.floor(Math.random() * 4) + 3;
    // Délai en ms (varie légèrement pour le naturel)
    const delay = isPause ? 115 : isBrief ? 52 : 18 + Math.random() * 14;

    const t = setTimeout(() => {
      setStreamingMsg((prev) => {
        if (!prev) return null;
        const newLen = Math.min(prev.shown.length + reveal, prev.full.length);
        return { ...prev, shown: prev.full.slice(0, newLen) };
      });
    }, delay);

    return () => clearTimeout(t);
  }, [streamingMsg]);

  // ── Ouverture avec message d'accueil ──────────────────────────────────────
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

  // ── Survol de la bulle ────────────────────────────────────────────────────
  const handleBubbleMouseEnter = useCallback(() => {
    if (isOpen) return;
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

  // ── Envoi de message ──────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || isTyping) return;

      // Si un streaming est en cours, on le complète immédiatement avant d'envoyer
      if (streamingMsg) {
        setMessages((prev) => [
          ...prev,
          { role: "victor", content: streamingMsg.full, ts: Date.now(), ctaButtons: streamingMsg.buttons },
        ]);
        setStreamingMsg(null);
      }

      setInput("");
      const userMsg: Message = { role: "user", content: text, ts: Date.now() };
      setMessages((prev) => [...prev, userMsg]);
      setIsTyping(true);

      try {
        const history = buildHistory([...messages]);
        const res = await fetch(`${siteUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            sessionId,
            pageContext: location,
            isAuth: !!user,
            history,
          }),
        });

        const data = (await res.json()) as { text?: string };
        const raw = data.text ?? "Je suis momentanément indisponible. Veuillez réessayer.";
        const { clean, buttons } = parseCTAs(raw);

        // Arrêter l'indicateur de frappe et démarrer le streaming progressif
        setIsTyping(false);
        setStreamingMsg({ full: clean, shown: "", buttons });
      } catch {
        setIsTyping(false);
        setMessages((prev) => [
          ...prev,
          {
            role: "victor",
            content: "Une erreur est survenue. Veuillez réessayer dans un instant.",
            ts: Date.now(),
          },
        ]);
      }
    },
    [isTyping, streamingMsg, siteUrl, sessionId, location, user, messages]
  );

  // ── CTA click ─────────────────────────────────────────────────────────────
  const handleCTA = useCallback(
    async (label: string, href: string) => {
      const ctaKey = `cta_click_${label.toLowerCase().replace(/\s+/g, "_")}`;
      try {
        await recordCTAClick({ sessionId, cta: ctaKey });
      } catch { /* non bloquant */ }

      // Suivi funnel auth : stocke la session pour tracker la complétion dans le dashboard
      if (href === "/login" || href === "/register") {
        try {
          localStorage.setItem(
            "victor_auth_pending",
            JSON.stringify({
              sessionId,
              action: href === "/register" ? "register" : "login",
              ts: Date.now(),
            })
          );
        } catch { /* non bloquant */ }
      }

      navigate(href);
      setIsOpen(false);
    },
    [recordCTAClick, navigate, sessionId]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Bulle flottante ── */}
      {!isOpen && (
        <div className="fixed bottom-5 right-5 z-50">
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
              <span className="absolute -bottom-1.5 right-5 w-3 h-3 bg-white border-r border-b border-border rotate-45 block" />
            </div>
          )}

          {showBubblePulse && (
            <>
              <span className="absolute inset-0 rounded-full bg-primary/20 animate-ping" style={{ animationDuration: "1.5s" }} />
              <span className="absolute -inset-1 rounded-full border-2 border-primary/30 animate-pulse" />
            </>
          )}
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
            {/* Messages définitifs */}
            {messages.map((msg, i) => (
              <MessageBubble
                key={i}
                msg={msg}
                onCTA={handleCTA}
              />
            ))}

            {/* Message en cours de streaming (révélation progressive) */}
            {streamingMsg && (
              <div className="flex justify-start gap-2">
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <span className="text-primary font-bold text-xs">V</span>
                </div>
                <div className="max-w-[80%]">
                  <div className="px-3.5 py-2.5 rounded-2xl rounded-bl-sm text-sm leading-relaxed bg-slate-100 text-primary">
                    <MessageContent text={streamingMsg.shown} />
                    {/* Curseur clignotant pendant le streaming */}
                    {streamingMsg.shown.length < streamingMsg.full.length && (
                      <span className="inline-block w-0.5 h-3.5 bg-primary/60 ml-0.5 align-middle animate-pulse" />
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Indicateur de frappe (pendant le fetch API) */}
            {isTyping && !streamingMsg && (
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
                onClick={() => void sendMessage(input)}
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

// ─── Bulle de message individuelle ────────────────────────────────────────────

function MessageBubble({
  msg,
  onCTA,
}: {
  msg: Message;
  onCTA: (label: string, href: string) => void;
}) {
  return (
    <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} gap-2`}>
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
          {msg.role === "victor" ? (
            <MessageContent text={msg.content} />
          ) : (
            msg.content
          )}
        </div>
        {msg.ctaButtons && msg.ctaButtons.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1">
            {msg.ctaButtons.map((btn, bi) => (
              <button
                key={bi}
                onClick={() => onCTA(btn.label, btn.href)}
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
  );
}
