import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import {
  X,
  FileText,
  Search,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  Sparkles,
} from "lucide-react";
import { useAuth } from "@/lib/auth";

const STORAGE_KEY_PREFIX = "joventy_onboarded_";

const STEPS = [
  {
    icon: Sparkles,
    color: "bg-secondary",
    iconColor: "text-primary",
    tag: "Bienvenue",
    title: "Votre visa simplifié,\nde A à Z.",
    description:
      "Joventy s'occupe de tout : dossier, créneau ambassade, suivi en temps réel. Vous n'avez qu'à suivre les étapes.",
    visual: (
      <div className="flex items-center justify-center gap-3 mt-6">
        {["USA", "Espagne", "Dubaï", "Turquie", "Inde"].map((dest) => (
          <span
            key={dest}
            className="px-3 py-1.5 rounded-full bg-white/20 text-white text-xs font-semibold border border-white/30"
          >
            {dest}
          </span>
        ))}
      </div>
    ),
  },
  {
    icon: FileText,
    color: "bg-blue-600",
    iconColor: "text-white",
    tag: "Étape 1 sur 3",
    title: "Créez votre dossier\net réglez les arrhes.",
    description:
      "Remplissez votre demande en ligne en quelques minutes. Des arrhes sont demandées pour réserver votre place et lancer le traitement.",
    visual: (
      <div className="mt-6 bg-white/10 rounded-2xl p-4 border border-white/20">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
            <FileText className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1">
            <div className="h-2 bg-white/30 rounded-full w-3/4 mb-1.5" />
            <div className="h-2 bg-white/20 rounded-full w-1/2" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {["Destination", "Visa type", "Date"].map((f) => (
            <div key={f} className="bg-white/10 rounded-lg p-2 text-center">
              <p className="text-[10px] text-white/60 mb-1">{f}</p>
              <div className="h-1.5 bg-white/30 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    icon: Search,
    color: "bg-indigo-600",
    iconColor: "text-white",
    tag: "Étape 2 sur 3",
    title: "Envoyez vos documents.\nLe bot chasse votre créneau.",
    description:
      "Notre équipe analyse votre dossier et notre bot surveille en continu les portails officiels pour saisir un rendez-vous dès qu'il est disponible.",
    visual: (
      <div className="mt-6 bg-white/10 rounded-2xl p-4 border border-white/20">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-white/70 font-medium">Bot actif</span>
          <span className="flex items-center gap-1.5 text-[10px] text-green-300 font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            En ligne
          </span>
        </div>
        {["10:42 — Portail USA vérifié", "10:56 — Portail USA vérifié", "11:10 — Créneau détecté !"].map(
          (line, i) => (
            <div
              key={i}
              className={`text-[11px] py-1.5 border-b border-white/10 last:border-0 ${
                i === 2 ? "text-green-300 font-semibold" : "text-white/60"
              }`}
            >
              {line}
            </div>
          )
        )}
      </div>
    ),
  },
  {
    icon: CheckCircle2,
    color: "bg-emerald-600",
    iconColor: "text-white",
    tag: "Étape 3 sur 3",
    title: "Créneau trouvé.\nVotre visa arrive.",
    description:
      "Dès qu'un créneau est réservé, vous êtes notifié en urgence. Après confirmation de votre rendez-vous, réglez les honoraires et recevez votre visa.",
    visual: (
      <div className="mt-6 bg-white/10 rounded-2xl p-4 border border-white/20 space-y-2">
        {[
          { icon: "🎯", label: "Créneau réservé", done: true },
          { icon: "📧", label: "Vous recevez une alerte", done: true },
          { icon: "💳", label: "Règlement honoraires", done: true },
          { icon: "✈️", label: "Visa obtenu — bon voyage !", done: true },
        ].map(({ icon, label, done }) => (
          <div key={label} className="flex items-center gap-2.5">
            <span className="text-base">{icon}</span>
            <span className={`text-xs flex-1 ${done ? "text-white font-medium" : "text-white/50"}`}>
              {label}
            </span>
            {done && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300 flex-shrink-0" />}
          </div>
        ))}
      </div>
    ),
  },
];

export function OnboardingModal() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const [animating, setAnimating] = useState(false);

  const storageKey = user ? `${STORAGE_KEY_PREFIX}${user.id}` : null;

  useEffect(() => {
    if (!storageKey) return;
    const done = localStorage.getItem(storageKey);
    if (!done) setVisible(true);
  }, [storageKey]);

  const dismiss = () => {
    if (storageKey) localStorage.setItem(storageKey, "1");
    setVisible(false);
  };

  const finish = () => {
    dismiss();
    setLocation("/dashboard/applications/new");
  };

  const goTo = (next: number) => {
    if (animating) return;
    setAnimating(true);
    setTimeout(() => {
      setStep(next);
      setAnimating(false);
    }, 150);
  };

  if (!visible) return null;

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;
  const isFirst = step === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div
        className={`relative w-full max-w-sm bg-gradient-to-br from-[#1e3a5f] to-[#2563eb] rounded-3xl shadow-2xl overflow-hidden transition-all duration-300 ${
          animating ? "opacity-0 scale-95" : "opacity-100 scale-100"
        }`}
      >
        {/* Close */}
        <button
          onClick={dismiss}
          className="absolute top-4 right-4 z-10 w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
        >
          <X className="w-4 h-4 text-white/70" />
        </button>

        {/* Content */}
        <div className="p-7 pt-6">
          {/* Tag */}
          <span className="inline-block text-[11px] font-semibold text-white/60 uppercase tracking-widest mb-4">
            {current.tag}
          </span>

          {/* Icon */}
          <div className={`w-12 h-12 rounded-2xl ${current.color} flex items-center justify-center mb-4 shadow-lg`}>
            <Icon className={`w-6 h-6 ${current.iconColor}`} />
          </div>

          {/* Title */}
          <h2 className="text-2xl font-serif font-bold text-white leading-tight whitespace-pre-line">
            {current.title}
          </h2>

          {/* Description */}
          <p className="mt-3 text-white/70 text-sm leading-relaxed">
            {current.description}
          </p>

          {/* Visual */}
          {current.visual}
        </div>

        {/* Footer */}
        <div className="px-7 pb-7 pt-2">
          {/* Dots */}
          <div className="flex items-center justify-center gap-2 mb-5">
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={`rounded-full transition-all duration-300 ${
                  i === step ? "w-6 h-2 bg-secondary" : "w-2 h-2 bg-white/25 hover:bg-white/40"
                }`}
              />
            ))}
          </div>

          {/* Buttons */}
          <div className="flex gap-3">
            {!isFirst && (
              <button
                onClick={() => goTo(step - 1)}
                className="flex items-center justify-center gap-1.5 h-11 px-4 rounded-xl border border-white/20 text-white/80 hover:bg-white/10 text-sm font-medium transition-all"
              >
                <ArrowLeft className="w-4 h-4" />
                Retour
              </button>
            )}
            {isLast ? (
              <button
                onClick={finish}
                className="flex-1 h-11 rounded-xl bg-secondary hover:bg-yellow-400 text-primary font-bold text-sm flex items-center justify-center gap-2 transition-all shadow-lg"
              >
                Créer mon dossier
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={() => goTo(step + 1)}
                className="flex-1 h-11 rounded-xl bg-white/15 hover:bg-white/25 text-white font-semibold text-sm flex items-center justify-center gap-2 transition-all"
              >
                Suivant
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>

          {isFirst && (
            <button
              onClick={dismiss}
              className="w-full text-center text-xs text-white/40 hover:text-white/60 mt-3 transition-colors"
            >
              Passer l'introduction
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
