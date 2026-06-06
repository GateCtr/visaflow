import { useState } from "react";
import { Link } from "wouter";
import { FileText, Search, CheckCircle2, ArrowRight, X } from "lucide-react";
import { useAuth } from "@/lib/auth";

const BANNER_DISMISSED_PREFIX = "joventy_banner_dismissed_";

const STEPS = [
  {
    icon: FileText,
    color: "bg-blue-100 text-blue-600",
    number: "01",
    title: "Créez votre dossier",
    desc: "Remplissez votre demande et réglez les arrhes pour démarrer.",
  },
  {
    icon: Search,
    color: "bg-violet-100 text-violet-600",
    number: "02",
    title: "Le service chasse",
    desc: "Notre service surveille les portails officiels 24h/24 pour vous.",
  },
  {
    icon: CheckCircle2,
    color: "bg-emerald-100 text-emerald-600",
    number: "03",
    title: "Visa obtenu",
    desc: "Créneau trouvé → rendez-vous confirmé → votre visa arrive.",
  },
];

export function OnboardingBanner() {
  const { user } = useAuth();
  const bannerKey = user ? `${BANNER_DISMISSED_PREFIX}${user.id}` : null;
  const [dismissed, setDismissed] = useState(() => {
    if (!bannerKey) return false;
    return !!localStorage.getItem(bannerKey);
  });

  const dismiss = () => {
    if (bannerKey) localStorage.setItem(bannerKey, "1");
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <div className="relative bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
      {/* Top accent bar */}
      <div className="h-1 bg-gradient-to-r from-[#1e3a5f] via-[#2563eb] to-secondary" />

      {/* Dismiss */}
      <button
        onClick={dismiss}
        className="absolute top-4 right-4 w-7 h-7 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors z-10"
        aria-label="Fermer"
      >
        <X className="w-3.5 h-3.5 text-slate-500" />
      </button>

      <div className="p-6 sm:p-8 pr-12">
        {/* Header */}
        <div className="mb-6">
          <p className="text-xs font-semibold text-secondary uppercase tracking-widest mb-1">
            Comment ça marche ?
          </p>
          <h3 className="text-xl font-serif font-bold text-primary">
            3 étapes pour obtenir votre visa
          </h3>
        </div>

        {/* Steps */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          {STEPS.map(({ icon: Icon, color, number, title, desc }, i) => (
            <div key={number} className="relative flex sm:flex-col gap-4 sm:gap-3">
              {/* Connector line (desktop) */}
              {i < STEPS.length - 1 && (
                <div className="hidden sm:block absolute top-5 left-[calc(50%+20px)] right-0 h-px border-t-2 border-dashed border-slate-200" />
              )}

              <div className="flex-shrink-0">
                <div className={`w-10 h-10 rounded-xl ${color} flex items-center justify-center`}>
                  <Icon className="w-5 h-5" />
                </div>
              </div>

              <div className="flex-1 sm:flex-none">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-bold text-slate-400 tracking-widest">
                    ÉTAPE {number}
                  </span>
                </div>
                <h4 className="font-bold text-primary text-sm mb-1">{title}</h4>
                <p className="text-xs text-slate-500 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          <Link href="/dashboard/applications/new">
            <button className="inline-flex items-center gap-2 h-10 px-5 rounded-xl bg-primary hover:bg-primary/90 text-white text-sm font-semibold transition-all shadow-sm">
              Créer mon premier dossier
              <ArrowRight className="w-4 h-4" />
            </button>
          </Link>
          <button
            onClick={dismiss}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            Je comprends, masquer ce guide
          </button>
        </div>
      </div>
    </div>
  );
}
