import { getVisaDocGroups, type DocCategory } from "@convex/visaDocuments";
import { CheckCircle2, Upload, ShieldCheck, Landmark, AlertCircle, CreditCard } from "lucide-react";

interface DocumentChecklistProps {
  destination: string;
  visaType: string;
}

const CATEGORY_CONFIG: Record<DocCategory, {
  icon: React.ReactNode;
  bg: string;
  border: string;
  badge: string;
  badgeText: string;
  textColor: string;
  iconBg: string;
  checkColor: string;
  dot: string;
}> = {
  upload: {
    icon: <Upload className="w-5 h-5 text-blue-600" />,
    bg: "bg-blue-50",
    border: "border-blue-200",
    badge: "bg-blue-100 text-blue-700",
    badgeText: "📤 Documents à uploader",
    textColor: "text-blue-900",
    iconBg: "bg-blue-100",
    checkColor: "text-blue-500",
    dot: "bg-blue-400",
  },
  joventy: {
    icon: <ShieldCheck className="w-5 h-5 text-green-600" />,
    bg: "bg-green-50",
    border: "border-green-200",
    badge: "bg-green-100 text-green-700",
    badgeText: "✅ Pris en charge par Joventy",
    textColor: "text-green-900",
    iconBg: "bg-green-100",
    checkColor: "text-green-500",
    dot: "bg-green-400",
  },
  direct: {
    icon: <CreditCard className="w-5 h-5 text-orange-600" />,
    bg: "bg-orange-50",
    border: "border-orange-200",
    badge: "bg-orange-100 text-orange-700",
    badgeText: "💳 À régler directement par vous",
    textColor: "text-orange-900",
    iconBg: "bg-orange-100",
    checkColor: "text-orange-400",
    dot: "bg-orange-400",
  },
  embassy: {
    icon: <Landmark className="w-5 h-5 text-purple-600" />,
    bg: "bg-purple-50",
    border: "border-purple-200",
    badge: "bg-purple-100 text-purple-700",
    badgeText: "🏛️ À présenter sur place",
    textColor: "text-purple-900",
    iconBg: "bg-purple-100",
    checkColor: "text-purple-400",
    dot: "bg-purple-400",
  },
};

export function DocumentChecklist({ destination, visaType }: DocumentChecklistProps) {
  const groups = getVisaDocGroups(destination.toLowerCase(), visaType);

  if (groups.length === 0) {
    return (
      <div className="bg-muted rounded-2xl border border-border p-6 text-center text-muted-foreground text-sm">
        <AlertCircle className="w-6 h-6 mx-auto mb-2 text-border" />
        Liste de documents non disponible pour ce type de visa.
        <br />Contactez votre conseiller Joventy via le chat.
      </div>
    );
  }

  const totalDocs = groups.reduce((acc, g) => acc + g.docs.length, 0);
  const requiredCount = groups.reduce((acc, g) => acc + g.docs.filter(d => d.required).length, 0);

  return (
    <div className="space-y-4">
      {/* Résumé */}
      <div className="flex flex-wrap gap-3 text-xs">
        <span className="inline-flex items-center gap-1.5 bg-muted border border-border rounded-full px-3 py-1.5 font-medium text-muted-foreground">
          <span className="w-2 h-2 rounded-full bg-primary inline-block" />
          {totalDocs} éléments au total
        </span>
        <span className="inline-flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-full px-3 py-1.5 font-semibold text-red-700">
          <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
          {requiredCount} obligatoires
        </span>
        <span className="inline-flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-full px-3 py-1.5 font-medium text-slate-500">
          {totalDocs - requiredCount} recommandés
        </span>
      </div>

      {/* Groupes */}
      {groups.map((group) => {
        const cfg = CATEGORY_CONFIG[group.category];
        return (
          <div key={group.category} className={`rounded-2xl border ${cfg.border} ${cfg.bg} overflow-hidden`}>
            {/* En-tête du groupe */}
            <div className={`flex items-center gap-3 px-5 py-3.5 border-b ${cfg.border}`}>
              <div className={`w-8 h-8 rounded-lg ${cfg.iconBg} flex items-center justify-center flex-shrink-0`}>
                {cfg.icon}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className={`font-bold text-sm ${cfg.textColor}`}>{cfg.badgeText}</h4>
                <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${cfg.badge}`}>
                  {group.docs.length} élément{group.docs.length > 1 ? "s" : ""}
                </span>
              </div>
            </div>

            {/* Liste des documents */}
            <ul className="divide-y divide-white/50">
              {group.docs.map((doc, i) => (
                <li key={i} className="px-5 py-3.5 flex items-start gap-3">
                  <div className="flex-shrink-0 mt-0.5">
                    {doc.required ? (
                      <CheckCircle2 className={`w-4 h-4 ${cfg.checkColor}`} />
                    ) : (
                      <div className={`w-4 h-4 rounded-full border-2 border-current ${cfg.checkColor} flex items-center justify-center`}>
                        <div className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm leading-snug ${cfg.textColor} ${doc.required ? "font-medium" : "font-normal opacity-80"}`}>
                      {doc.label}
                      {!doc.required && (
                        <span className="ml-1.5 text-xs font-normal opacity-60 italic">(recommandé)</span>
                      )}
                    </p>
                    {doc.notes && (
                      <p className={`text-xs mt-1 leading-relaxed opacity-70 ${cfg.textColor}`}>
                        ℹ️ {doc.notes}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {/* Avertissement légal */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
        <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-800 leading-relaxed">
          <strong>Liste indicative.</strong> Les exigences consulaires peuvent évoluer. Votre conseiller Joventy vérifie la conformité exacte de votre dossier selon votre profil et la date de votre demande.
        </p>
      </div>
    </div>
  );
}
