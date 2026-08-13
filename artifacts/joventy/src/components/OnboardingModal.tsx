import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { X, CalendarClock, FileText, ArrowRight } from "lucide-react";
import { useAuth } from "@/lib/auth";

const STORAGE_KEY_PREFIX = "joventy_onboarded_";

export function OnboardingModal() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [visible, setVisible] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const completeOnboarding = useMutation(api.users.completeOnboarding);

  const storageKey = user ? `${STORAGE_KEY_PREFIX}${user.id}` : null;

  useEffect(() => {
    if (!storageKey) return;
    const done = localStorage.getItem(storageKey);
    if (!done) setVisible(true);
  }, [storageKey]);

  const markDone = async () => {
    if (storageKey) localStorage.setItem(storageKey, "1");
    try {
      await completeOnboarding();
    } catch (err) {
      console.error("Erreur onboarding:", err);
    }
  };

  const dismiss = async () => {
    setIsPending(true);
    await markDone();
    setVisible(false);
    setIsPending(false);
  };

  const goTo = async (path: string) => {
    setIsPending(true);
    await markDone();
    setVisible(false);
    setLocation(path);
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-md bg-gradient-to-br from-[#0B111E] to-[#1e2d4d] rounded-3xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-300">

        {/* Bouton fermer */}
        <button
          onClick={dismiss}
          disabled={isPending}
          className="absolute top-4 right-4 z-10 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
        >
          <X className="w-4 h-4 text-white/70" />
        </button>

        {/* En-tête */}
        <div className="px-7 pt-8 pb-6 text-center">
          <div className="inline-flex items-center gap-2 bg-secondary/20 border border-secondary/30 rounded-full px-3 py-1 mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-secondary" />
            <span className="text-secondary text-[11px] font-bold tracking-widest uppercase">Bienvenue sur Joventy</span>
          </div>
          <h2 className="text-2xl sm:text-3xl font-bold text-white leading-tight mb-3">
            Que voulez-vous faire<br />
            <span className="text-secondary">aujourd'hui ?</span>
          </h2>
          <p className="text-white/50 text-sm leading-relaxed">
            Choisissez votre objectif — nous nous occupons du reste.
          </p>
        </div>

        {/* Boutons de choix */}
        <div className="px-6 pb-4 space-y-3">

          {/* Créneaux consulaires */}
          <button
            onClick={() => goTo("/dashboard/applications/new/creneau")}
            disabled={isPending}
            className="group w-full flex items-center gap-4 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-secondary/40 rounded-2xl px-5 py-4 text-left transition-all duration-200 disabled:opacity-50"
          >
            <div className="w-11 h-11 rounded-xl bg-secondary/20 flex items-center justify-center flex-shrink-0 group-hover:bg-secondary/30 transition-colors">
              <CalendarClock className="w-5 h-5 text-secondary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-sm">Prendre un créneau consulaire</p>
              <p className="text-white/40 text-xs mt-0.5">Rendez-vous ambassade : USA, Espagne, Schengen…</p>
            </div>
            <ArrowRight className="w-4 h-4 text-white/30 group-hover:text-secondary group-hover:translate-x-0.5 transition-all flex-shrink-0" />
          </button>

          {/* Demande de visa */}
          <button
            onClick={() => goTo("/dashboard/applications/new")}
            disabled={isPending}
            className="group w-full flex items-center gap-4 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-blue-400/40 rounded-2xl px-5 py-4 text-left transition-all duration-200 disabled:opacity-50"
          >
            <div className="w-11 h-11 rounded-xl bg-blue-500/20 flex items-center justify-center flex-shrink-0 group-hover:bg-blue-500/30 transition-colors">
              <FileText className="w-5 h-5 text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-sm">Faire une demande de visa</p>
              <p className="text-white/40 text-xs mt-0.5">Dossier complet : e-Visa, Dubaï, Canada, UK…</p>
            </div>
            <ArrowRight className="w-4 h-4 text-white/30 group-hover:text-blue-400 group-hover:translate-x-0.5 transition-all flex-shrink-0" />
          </button>
        </div>

        {/* Passer */}
        <div className="px-6 pb-7 pt-1 text-center">
          <button
            onClick={dismiss}
            disabled={isPending}
            className="text-xs text-white/30 hover:text-white/60 transition-colors disabled:opacity-50"
          >
            Passer pour l'instant
          </button>
        </div>
      </div>
    </div>
  );
}
