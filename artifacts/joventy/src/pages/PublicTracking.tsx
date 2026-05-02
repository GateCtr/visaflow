import { useRoute } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { CheckCircle2, Clock, CreditCard, Search, Star, XCircle, Plane, MapPin, Calendar } from "lucide-react";

const DEST_LABELS: Record<string, string> = {
  usa: "États-Unis",
  schengen: "Espace Schengen",
  dubai: "Dubaï",
  turkey: "Turquie",
  india: "Inde",
};

const DEST_FLAG: Record<string, string> = {
  usa: "🇺🇸",
  schengen: "🇪🇺",
  dubai: "🇦🇪",
  turkey: "🇹🇷",
  india: "🇮🇳",
};

const DEST_COLOR: Record<string, string> = {
  usa: "from-blue-600 to-blue-800",
  schengen: "from-indigo-600 to-indigo-800",
  dubai: "from-amber-500 to-amber-700",
  turkey: "from-red-600 to-red-800",
  india: "from-orange-500 to-orange-700",
};

type StatusStep = {
  key: string[];
  label: string;
  description: string;
  icon: React.ElementType;
};

const STEPS: StatusStep[] = [
  {
    key: ["awaiting_engagement_payment"],
    label: "Paiement d'engagement",
    description: "En attente du règlement des frais d'engagement.",
    icon: CreditCard,
  },
  {
    key: ["documents_pending", "in_review", "slot_hunting"],
    label: "Traitement en cours",
    description: "L'équipe Joventy traite votre dossier et recherche un créneau.",
    icon: Search,
  },
  {
    key: ["slot_found_awaiting_success_fee", "submitted"],
    label: "Créneau / Soumission",
    description: "Un créneau a été trouvé ou le dossier a été soumis.",
    icon: Star,
  },
  {
    key: ["completed", "approved"],
    label: "Dossier complété",
    description: "Votre visa a été obtenu avec succès.",
    icon: CheckCircle2,
  },
];

function getStepIndex(status: string): number {
  for (let i = 0; i < STEPS.length; i++) {
    if (STEPS[i].key.includes(status)) return i;
  }
  return 0;
}

function getStatusLabel(status: string): string {
  const map: Record<string, string> = {
    awaiting_engagement_payment: "En attente de paiement",
    documents_pending: "Documents en cours de collecte",
    in_review: "Dossier en cours de vérification",
    slot_hunting: "Recherche active de créneau",
    slot_found_awaiting_success_fee: "Créneau trouvé — en attente de confirmation",
    submitted: "Dossier soumis à l'ambassade",
    completed: "Visa obtenu ✅",
    approved: "Dossier approuvé ✅",
    rejected: "Dossier refusé",
  };
  return map[status] ?? status;
}

function formatDateFr(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

export default function PublicTracking() {
  const [, params] = useRoute("/suivi/:token");
  const token = params?.token ?? "";

  const app = useQuery(api.applications.getByTrackingToken, token ? { token } : "skip");

  if (app === undefined) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-500 text-sm">Chargement du dossier…</p>
        </div>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-10 max-w-sm w-full text-center">
          <XCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h1 className="text-lg font-bold text-slate-800 mb-2">Lien invalide</h1>
          <p className="text-slate-500 text-sm">Ce lien de suivi est introuvable ou a expiré.</p>
          <a
            href="https://joventy.cd"
            className="mt-6 inline-block text-blue-600 text-sm font-medium hover:underline"
          >
            Retour à joventy.cd
          </a>
        </div>
      </div>
    );
  }

  const isRejected = app.status === "rejected";
  const isCompleted = app.status === "completed" || app.status === "approved";
  const currentStep = getStepIndex(app.status);
  const dest = app.destination;
  const gradientClass = DEST_COLOR[dest] ?? "from-blue-600 to-blue-800";
  const flag = DEST_FLAG[dest] ?? "🌍";
  const destLabel = DEST_LABELS[dest] ?? dest;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header gradient */}
      <div className={`bg-gradient-to-br ${gradientClass} text-white px-4 pt-10 pb-16`}>
        <div className="max-w-lg mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <a href="https://joventy.cd" className="flex items-center gap-2">
              <span className="font-serif font-bold text-xl tracking-tight">Joventy</span>
              <span className="text-xs bg-white/20 rounded-full px-2 py-0.5">Suivi dossier</span>
            </a>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-5xl">{flag}</span>
            <div>
              <h1 className="text-2xl font-bold">{app.applicantName}</h1>
              <p className="text-white/80 text-sm mt-0.5">
                {destLabel} · {app.visaType}
              </p>
              <p className="text-white/60 text-xs mt-1">
                Réf : JOV-{app._id.slice(-5).toUpperCase()}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 -mt-8 pb-16 space-y-4">

        {/* Status card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className={`px-5 py-4 border-b flex items-center gap-3 ${isRejected ? "bg-red-50 border-red-100" : isCompleted ? "bg-green-50 border-green-100" : "bg-blue-50 border-blue-100"}`}>
            {isRejected
              ? <XCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
              : isCompleted
                ? <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0" />
                : <Clock className="w-5 h-5 text-blue-600 flex-shrink-0" />
            }
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-0.5">Statut actuel</p>
              <p className={`font-bold text-sm ${isRejected ? "text-red-700" : isCompleted ? "text-green-700" : "text-blue-800"}`}>
                {getStatusLabel(app.status)}
              </p>
            </div>
          </div>
          <div className="px-5 py-3 text-xs text-slate-400 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            Mis à jour le {formatDateFr(new Date(app.updatedAt).toISOString().split("T")[0])}
          </div>
        </div>

        {/* Progress steps */}
        {!isRejected && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-5">Avancement</p>
            <div className="relative">
              {/* Vertical line */}
              <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-slate-100" />
              <div className="space-y-6">
                {STEPS.map((step, idx) => {
                  const Icon = step.icon;
                  const isDone = idx < currentStep;
                  const isCurrent = idx === currentStep;
                  const isFuture = idx > currentStep;
                  return (
                    <div key={idx} className="flex items-start gap-4 relative">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 z-10 border-2 transition-all ${
                        isDone
                          ? "bg-green-500 border-green-500 text-white"
                          : isCurrent
                            ? "bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-200"
                            : "bg-white border-slate-200 text-slate-300"
                      }`}>
                        {isDone
                          ? <CheckCircle2 className="w-4 h-4" />
                          : <Icon className="w-4 h-4" />
                        }
                      </div>
                      <div className="pt-1">
                        <p className={`text-sm font-semibold ${isFuture ? "text-slate-300" : isCurrent ? "text-blue-800" : "text-slate-700"}`}>
                          {step.label}
                        </p>
                        {isCurrent && (
                          <p className="text-xs text-slate-500 mt-0.5">{step.description}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Appointment info — only if completed and date available */}
        {isCompleted && app.appointmentDetails?.date && (
          <div className="bg-white rounded-2xl border border-green-200 shadow-sm p-5">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-3">Rendez-vous</p>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-slate-700">
                <Calendar className="w-4 h-4 text-green-600 flex-shrink-0" />
                <span>{formatDateFr(app.appointmentDetails.date)}{app.appointmentDetails.time ? ` à ${app.appointmentDetails.time}` : ""}</span>
              </div>
              {app.appointmentDetails.location && (
                <div className="flex items-center gap-2 text-slate-700">
                  <MapPin className="w-4 h-4 text-green-600 flex-shrink-0" />
                  <span>{app.appointmentDetails.location}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Trip info */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-3">Informations voyage</p>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2 text-slate-700">
              <Plane className="w-4 h-4 text-slate-400 flex-shrink-0" />
              <span>Départ prévu : <strong>{formatDateFr(app.travelDate)}</strong></span>
            </div>
            {app.returnDate && (
              <div className="flex items-center gap-2 text-slate-700">
                <Plane className="w-4 h-4 text-slate-400 flex-shrink-0 rotate-180" />
                <span>Retour : <strong>{formatDateFr(app.returnDate)}</strong></span>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="text-center pt-4">
          <p className="text-xs text-slate-400">
            Suivi fourni par{" "}
            <a href="https://joventy.cd" className="text-blue-600 font-medium hover:underline">
              Joventy.cd
            </a>{" "}
            · Akollad Groupe
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Questions ? WhatsApp : <a href="https://wa.me/243840808122" className="text-blue-600 hover:underline">+243 840 808 122</a>
          </p>
        </div>
      </div>
    </div>
  );
}
