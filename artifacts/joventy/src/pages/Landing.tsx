import { Link } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Helmet } from "react-helmet-async";
import { ConvexErrorBoundary } from "@/components/ConvexErrorBoundary";
import { Navbar } from "@/components/layout/Navbar";
import { Button } from "@/components/ui/button";
import { JoventyLogo } from "@/components/JoventyLogo";
import {
  ArrowRight, Star, ShieldCheck, Clock, FileText, CheckCircle2,
  MessageCircle, Phone, Mail, Zap, Award, Users, TrendingUp,
  Calendar, ClipboardList, ChevronRight, XCircle, HelpCircle,
  Landmark, CreditCard, BadgeCheck, AlertTriangle, BookOpen,
} from "lucide-react";

const FLAG_SIZES = [20, 40, 80, 160, 320, 640];
function snapFlagSize(n: number) {
  return FLAG_SIZES.find((s) => s >= n) ?? 80;
}

const FLAG_NAMES: Record<string, string> = {
  us: "États-Unis", ca: "Canada", gb: "Royaume-Uni", eu: "Europe Schengen",
  es: "Espagne", ch: "Suisse", ae: "Émirats Arabes Unis (Dubaï)", tr: "Turquie",
  in: "Inde", ma: "Maroc", eg: "Égypte", cn: "Chine", cd: "République Démocratique du Congo",
  fr: "France", be: "Belgique", de: "Allemagne",
};
function FlagImg({ code, size = 32, className = "" }: { code: string; size?: number; className?: string }) {
  const snapped = snapFlagSize(size);
  const snapped2x = snapFlagSize(size * 2);
  const altText = FLAG_NAMES[code.toLowerCase()] ?? `Drapeau ${code.toUpperCase()}`;
  return (
    <img
      src={`https://flagcdn.com/w${snapped}/${code.toLowerCase()}.png`}
      srcSet={`https://flagcdn.com/w${snapped2x}/${code.toLowerCase()}.png 2x`}
      width={snapped}
      alt={altText}
      className={`rounded-sm object-cover flex-shrink-0 ${className}`}
    />
  );
}

const DESTINATIONS = [
  {
    code: "us",
    name: "États-Unis",
    visaTypes: ["B1/B2 Tourisme", "F1 Étudiant", "K1 Fiancé(e)", "H1B Travail"],
    engagement: 250,
    success: 750,
    model: "appointment",
    note: "Frais MRV 265$ non inclus",
    badge: null,
  },
  {
    code: "ca",
    name: "Canada",
    visaTypes: ["Biométrie (Biometric)", "Visa Visiteur", "Permis d'études", "Permis de travail"],
    engagement: 250,
    success: 750,
    model: "appointment",
    note: "Frais IRCC (85 CAD+) non inclus",
    badge: "Nouveau",
  },
  {
    code: "gb",
    name: "Royaume-Uni",
    visaTypes: ["Standard Visitor Visa", "Student Visa", "Work Visa", "Family Visa"],
    engagement: 200,
    success: 600,
    model: "appointment",
    note: "Frais UKVI (£115+) non inclus",
    badge: "Nouveau",
  },
  {
    code: "ch",
    name: "Suisse",
    visaTypes: ["Visa C Tourisme / Affaires", "Visa C Études", "Visa D Long Séjour", "Transit"],
    engagement: 150,
    success: 450,
    model: "appointment",
    note: "Frais consulaires (90€+) non inclus",
    badge: "Nouveau",
  },
  {
    code: "eu",
    name: "Europe Schengen",
    visaTypes: ["Visa C Tourisme / Affaires", "Visa C Études (gratuit*)", "Visa D Long Séjour"],
    engagement: 150,
    success: 450,
    model: "appointment",
    note: "Frais consulaires CEV 90€/adulte non inclus",
    badge: "Nouveau",
  },
  {
    code: "ae",
    name: "Dubaï (EAU)",
    visaTypes: ["Touriste 30j", "Touriste 60j", "Affaires", "Résidence"],
    engagement: 150,
    success: 200,
    model: "evisa",
    note: "Frais e-Visa EAU (~90$) non inclus",
    badge: null,
  },
  {
    code: "tr",
    name: "Turquie",
    visaTypes: ["E-Visa en ligne", "Visa Sticker (ambassade)", "Transit"],
    engagement: 150,
    success: 200,
    model: "evisa",
    note: "E-Visa ~50$ (si visa USA/Schengen/UK valide)",
    badge: null,
  },
  {
    code: "in",
    name: "Inde",
    visaTypes: ["E-Visa Tourisme", "Médical", "Affaires", "Études"],
    engagement: 100,
    success: 150,
    model: "evisa",
    note: "Frais e-Visa gouvernement (~25-80$) non inclus",
    badge: null,
  },
  {
    code: "es",
    name: "Espagne",
    visaTypes: ["Visa C Tourisme / Affaires", "Visa C Études", "Visa D Long Séjour"],
    engagement: 150,
    success: 450,
    model: "appointment",
    note: "Frais consulaires 90€/adulte non inclus",
    badge: "Nouveau",
  },
  {
    code: "de",
    name: "Allemagne",
    visaTypes: ["Visa National Études", "Regroupement familial", "Travail / Chancenkarte", "Au-pair / Volontariat"],
    engagement: 150,
    success: 450,
    model: "appointment",
    note: "Frais consulaires (75-80€) non inclus",
    badge: "Nouveau",
  },
  {
    code: "ma",
    name: "Maroc",
    visaTypes: ["E-Visa portail officiel", "Consulaire sans RDV", "Transit Ebola 21j"],
    engagement: 150,
    success: 200,
    model: "hybrid",
    note: "E-Visa 77-110$ ou consulaire 15-25$ non inclus",
    badge: "Nouveau",
  },
  {
    code: "eg",
    name: "Égypte",
    visaTypes: ["E-Visa en ligne (visa2.egypt.gov.eg)", "Consulaire sans RDV", "Transit Ebola 21j"],
    engagement: 150,
    success: 200,
    model: "hybrid",
    note: "E-Visa 25-60$ ou consulaire ~60$ non inclus",
    badge: "Nouveau",
  },
  {
    code: "cn",
    name: "Chine",
    visaTypes: ["E-Visa court séjour ≤15j", "Visa L Tourisme (VFS)", "Visa M Affaires (VFS)", "Visa F / X2 (VFS)"],
    engagement: 120,
    success: 180,
    model: "hybrid",
    note: "Frais consulaires ~140$ + VFS ~30$ non inclus",
    badge: "Nouveau",
  },
];

const STEPS = [
  {
    num: "01",
    title: "Créez votre dossier",
    desc: "Choisissez votre destination, le type de visa et le package adapté à votre situation. 5 minutes suffisent.",
    icon: FileText,
  },
  {
    num: "02",
    title: "Payez par Mobile Money",
    desc: "Réglez les frais d'engagement via M-Pesa, Airtel Money ou Orange Money. Aucun virement bancaire, aucune carte étrangère requise.",
    icon: Phone,
  },
  {
    num: "03",
    title: "Joventy traite votre dossier",
    desc: "Notre équipe remplit vos formulaires, vérifie vos pièces et cherche activement votre créneau consulaire ou soumet votre e-Visa.",
    icon: Zap,
  },
  {
    num: "04",
    title: "Résultat garanti ou vous ne payez pas",
    desc: "La prime de succès n'est due qu'une fois le résultat obtenu : créneau verrouillé ou visa électronique accordé. Zéro risque.",
    icon: CheckCircle2,
  },
];

const PACKAGES = [
  {
    key: "full_service",
    icon: Star,
    label: "Service Complet",
    tagline: "Recommandé — Clé en main",
    desc: "Joventy gère tout : formulaires officiels, vérification de votre dossier, et recherche active de créneau consulaire ou dépôt e-Visa en votre nom. Vous n'avez qu'à vous présenter le jour J.",
    highlight: true,
    features: [
      "Formulaires DS-160, MRV, VFS ou e-Visa",
      "Vérification complète des pièces justificatives",
      "Recherche active de créneau consulaire",
      "Chat dédié avec un conseiller Joventy",
      "Prime de succès due uniquement si résultat",
    ],
  },
  {
    key: "slot_only",
    icon: Calendar,
    label: "Créneau Uniquement",
    tagline: "Dossier déjà prêt",
    desc: "Vos formulaires sont remplis, vos frais MRV payés ? Joventy se concentre uniquement sur la capture d'un créneau disponible à l'ambassade (USA) ou au CEV (Schengen/Espagne).",
    highlight: false,
    features: [
      "Surveillance continue du portail consulaire",
      "Alerte immédiate à la capture",
      "Disponible USA, Schengen (CEV) & Espagne",
      "Niveaux d'urgence : Standard → Très urgent",
      "Prime due uniquement si créneau obtenu",
    ],
  },
  {
    key: "dossier_only",
    icon: ClipboardList,
    label: "Formulaires & Vérification",
    tagline: "Tarif fixe",
    desc: "Joventy remplit vos formulaires officiels et vérifie vos pièces. Vous gérez ensuite vous-même la soumission ou le rendez-vous. Aucune prime de succès.",
    highlight: false,
    features: [
      "Remplissage des formulaires officiels",
      "Vérification complète de votre dossier",
      "Tarif fixe — aucune surprise",
      "Disponible pour toutes les destinations",
      "Idéal si vous avez déjà un créneau",
    ],
  },
];

function destToFlagCode(dest: string): string {
  // Priority 1: extract country code directly from flag emoji characters
  const flagMatch = dest.match(/[\u{1F1E0}-\u{1F1FF}]{2}/u);
  if (flagMatch) {
    const [a, b] = [...flagMatch[0]].map((c) => c.codePointAt(0)! - 0x1F1E6 + 65);
    return String.fromCharCode(a, b).toLowerCase();
  }
  // Priority 2: text-based fallback for destinations stored without emoji
  const d = dest.toLowerCase();
  if (d.includes("états-unis") || d.includes("etats-unis") || d.includes("usa") || d.includes("b2") || d.includes("b1/") || d.includes("k1") || d.includes("f1") || d.includes("h1b")) return "us";
  if (d.includes("dubaï") || d.includes("dubai") || d.includes("eau") || d.includes("émirats") || d.includes("emirats")) return "ae";
  if (d.includes("turquie") || d.includes("turkey")) return "tr";
  if (d.includes("inde") || d.includes("india")) return "in";
  if (d.includes("schengen") || d.includes("europe") || d.includes("cev") || d.includes("belgi") || d.includes("france")) return "eu";
  return "cd";
}

const TESTIMONIALS = [
  {
    name: "Christophe M.",
    city: "Kinshasa",
    dest: "Visa B2 États-Unis",
    code: "us",
    text: "J'avais essayé d'avoir un créneau à l'ambassade américaine pendant 4 mois sans succès. Joventy a trouvé une date en moins de 3 semaines. Incroyable.",
    stars: 5,
  },
  {
    name: "Nathalie K.",
    city: "Lubumbashi",
    dest: "E-Visa Dubaï",
    code: "ae",
    text: "Processus ultra simple. J'ai uploadé mes documents le lundi, mon e-Visa était prêt le mercredi. Paiement M-Pesa sans complication.",
    stars: 5,
  },
  {
    name: "Patrick B.",
    city: "Goma",
    dest: "E-Visa Turquie",
    code: "tr",
    text: "Le suivi en temps réel dans l'application est rassurant. Mon conseiller répondait dans la journée. Je recommande vivement.",
    stars: 5,
  },
];

const GUARANTEES = [
  {
    icon: ShieldCheck,
    title: "Paiement au résultat",
    desc: "La prime de succès n'est due que lorsque votre créneau est verrouillé ou votre visa accordé. Aucun résultat = aucun solde.",
  },
  {
    icon: Award,
    title: "Confidentialité bancaire",
    desc: "Vos données personnelles et pièces d'identité sont traitées avec le niveau de confidentialité d'une institution financière.",
  },
  {
    icon: Phone,
    title: "Mobile Money uniquement",
    desc: "Pas de virement international, pas de carte étrangère. Payez via M-Pesa, Airtel Money ou Orange Money depuis votre téléphone.",
  },
  {
    icon: MessageCircle,
    title: "Chat dédié inclus",
    desc: "Un conseiller Joventy vous accompagne à chaque étape via la messagerie intégrée à votre espace client.",
  },
];

type TestimonialItem = { name: string; city?: string; dest: string; code: string; text: string; stars: number };

function LiveTestimonialsGrid() {
  const liveReviews = useQuery(api.reviews.listApproved);

  const testimonialsToShow: TestimonialItem[] = liveReviews && liveReviews.length > 0
    ? liveReviews.map((r: { displayName: string; city?: string; destination: string; comment: string; rating: number }) => ({
        name: r.displayName,
        city: r.city,
        dest: r.destination,
        code: destToFlagCode(r.destination),
        text: r.comment,
        stars: r.rating,
      }))
    : TESTIMONIALS;

  return (
    <>
      {liveReviews && liveReviews.length === 0 && (
        <p className="text-center text-xs text-muted-foreground mb-4 italic">Exemples d'avis · Les vôtres apparaîtront ici après validation</p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {testimonialsToShow.map((t: TestimonialItem) => (
          <div key={t.name} className="bg-muted rounded-2xl p-7 border border-border flex flex-col">
            <div className="flex items-center gap-1 mb-4">
              {[...Array(t.stars)].map((_, i) => (
                <Star key={i} className="w-4 h-4 text-secondary fill-secondary" />
              ))}
            </div>
            <blockquote className="text-foreground text-sm leading-relaxed flex-1 mb-5 italic">
              "{t.text}"
            </blockquote>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-white border border-border shadow-sm flex items-center justify-center overflow-hidden flex-shrink-0">
                <FlagImg code={t.code ?? destToFlagCode(t.dest)} size={40} className="w-full h-full object-cover rounded-none" />
              </div>
              <div>
                <p className="font-bold text-primary text-sm">{t.name}</p>
                <p className="text-xs text-muted-foreground">{t.city} · {t.dest}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function StaticTestimonialsGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {TESTIMONIALS.map((t: TestimonialItem) => (
        <div key={t.name} className="bg-muted rounded-2xl p-7 border border-border flex flex-col">
          <div className="flex items-center gap-1 mb-4">
            {[...Array(t.stars)].map((_, i) => (
              <Star key={i} className="w-4 h-4 text-secondary fill-secondary" />
            ))}
          </div>
          <blockquote className="text-foreground text-sm leading-relaxed flex-1 mb-5 italic">
            "{t.text}"
          </blockquote>
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-white border border-border shadow-sm flex items-center justify-center overflow-hidden flex-shrink-0">
              <FlagImg code={t.code ?? destToFlagCode(t.dest)} size={40} className="w-full h-full object-cover rounded-none" />
            </div>
            <div>
              <p className="font-bold text-primary text-sm">{t.name}</p>
              <p className="text-xs text-muted-foreground">{t.city} · {t.dest}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function Landing() {

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Assistance Visa Kinshasa | USA, Canada, Europe, Dubaï | Joventy</title>
        <meta name="description" content="✅ Visa USA, Canada, Espagne, Schengen, Dubaï depuis Kinshasa — Formulaires remplis, créneaux consulaires, e-Visas. Vous payez uniquement si ça marche. Paiement M-Pesa ✓" />
        <link rel="canonical" href="https://joventy.cd/" />
        <meta property="og:title" content="Assistance Visa Kinshasa | USA, Canada, Europe, Dubaï | Joventy" />
        <meta property="og:description" content="✅ Visa USA, Canada, Espagne, Schengen, Dubaï depuis Kinshasa — Formulaires remplis, créneaux consulaires, e-Visas. Vous payez uniquement si ça marche. Paiement M-Pesa." />
        <meta property="og:url" content="https://joventy.cd/" />
        <meta property="og:type" content="website" />
        <meta property="og:image" content="https://joventy.cd/opengraph.jpg" />
        <meta property="og:locale" content="fr_CD" />
        <meta property="og:site_name" content="Joventy" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Assistance Visa Kinshasa | USA, Canada, Europe, Dubaï | Joventy" />
        <meta name="twitter:description" content="✅ Visa USA, Canada, Espagne, Schengen, Dubaï depuis Kinshasa. Formulaires, créneaux, e-Visas. Paiement M-Pesa. Résultat garanti ou remboursé." />
        <meta name="twitter:image" content="https://joventy.cd/opengraph.jpg" />
        <meta name="twitter:site" content="@JoventyCD" />
        <script type="application/ld+json">{JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          "mainEntity": [
            {
              "@type": "Question",
              "name": "Qu'est-ce que Joventy ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Joventy est une agence d'assistance visa premium basée à Kinshasa, en République Démocratique du Congo. Elle aide les ressortissants congolais à obtenir des visas pour les États-Unis, le Canada, le Royaume-Uni, l'espace Schengen (France, Belgique, Allemagne, Espagne, Suisse), Dubaï, la Turquie, l'Inde, le Maroc et l'Égypte. Joventy n'est pas une ambassade : c'est un service professionnel qui gère les formulaires, recherche les créneaux consulaires et soumet les e-Visas à la place de ses clients." }
            },
            {
              "@type": "Question",
              "name": "Joventy garantit-il l'obtention du visa ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Non. Joventy garantit le service, pas le visa. La décision finale d'accorder ou de refuser un visa appartient exclusivement à l'ambassade ou au gouvernement étranger. En revanche, Joventy applique un modèle « paiement au résultat » : la prime de succès n'est due que si le créneau consulaire est obtenu ou si l'e-Visa est accordé. Si aucun résultat n'est obtenu, seuls les frais d'engagement restent dus." }
            },
            {
              "@type": "Question",
              "name": "Combien coûte le service Joventy ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Joventy facture des frais d'engagement (payés à la création du dossier) et une prime de succès (due uniquement si le résultat est obtenu). Tarifs : USA — 250 $ engagement + 750 $ succès ; Canada — 250 $ + 750 $ ; Royaume-Uni — 200 $ + 600 $ ; Schengen / Espagne / Suisse — 150 $ + 450 $ ; e-Visa Dubaï / Turquie / Maroc / Égypte — 150 $ + 200 $. Les frais consulaires gouvernementaux (MRV USA ≈185-210 $, CEV Schengen ≈90 €, UKVI UK ≈115 £, portail Dubaï ≈90 $) ne sont pas inclus et sont payés directement au gouvernement concerné." }
            },
            {
              "@type": "Question",
              "name": "Comment fonctionne le processus Joventy étape par étape ?",
              "acceptedAnswer": { "@type": "Answer", "text": "1. Création du dossier en ligne sur joventy.cd et paiement des frais d'engagement via M-Pesa, Airtel Money ou Orange Money. 2. Envoi des documents requis (passeport, photos, justificatifs) via WhatsApp ou l'espace client. 3. Remplissage des formulaires officiels (DS-160 pour USA, IMM5257 pour Canada, VLS pour UK, etc.) par l'équipe Joventy. 4. Surveillance continue des portails officiels pour trouver un créneau disponible. 5. Verrouillage du créneau et notification immédiate via WhatsApp. 6. Paiement de la prime de succès. 7. Préparation à l'entretien consulaire (pour USA, Canada, UK) ou réception de l'e-Visa (pour Dubaï, Inde, Turquie)." }
            },
            {
              "@type": "Question",
              "name": "Peut-on payer Joventy avec M-Pesa, Airtel Money ou Orange Money ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Oui. Joventy accepte exclusivement les paiements via Mobile Money congolais : M-Pesa (Vodacom), Airtel Money et Orange Money. Aucune carte bancaire internationale, aucun virement SWIFT ni compte étranger n'est requis. C'est la seule agence visa premium en RDC à fonctionner 100 % en Mobile Money." }
            },
            {
              "@type": "Question",
              "name": "Combien de temps faut-il pour obtenir un visa avec Joventy ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Les délais varient selon la destination. E-Visa Dubaï : 48 à 72 heures ouvrables. E-Visa Inde : 3 à 5 jours ouvrables. E-Visa Turquie : 24 à 48 heures. Visa Maroc / Égypte : 72 heures. Pour les créneaux consulaires (USA, Canada, Schengen, UK), le délai dépend de la disponibilité sur le portail officiel, qui varie selon la saison et la demande. Joventy surveille les portails en continu 24h/24, 7j/7, et vous notifie dès qu'un créneau est capturé." }
            },
            {
              "@type": "Question",
              "name": "Que se passe-t-il si mon visa est refusé après le rendez-vous ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Le rôle de Joventy est d'obtenir le créneau consulaire ou l'e-Visa. Si ce résultat est atteint, la prime de succès est due, même si le consulat refuse ensuite le visa lors de l'entretien. Le refus consulaire est une décision souveraine de l'ambassade, indépendante du service Joventy. En cas de refus, Joventy vous conseille gratuitement sur les étapes suivantes et les chances d'un nouveau dossier." }
            },
            {
              "@type": "Question",
              "name": "Comment obtenir un visa USA depuis Kinshasa en 2026 ?",
              "acceptedAnswer": { "@type": "Answer", "text": "En juin 2026, les services visa de l'ambassade américaine à Kinshasa sont suspendus en raison de l'épidémie d'Ebola (depuis le 18 mai 2026). Pour voyager aux USA, les ressortissants congolais doivent d'abord passer 21 jours dans un pays neutre (Maroc, Égypte, Dubaï, Turquie ou Europe) hors RDC, obtenir un rendez-vous dans ce pays, puis demander leur visa. Joventy peut obtenir le visa transit (Maroc, Égypte) et coordonner l'ensemble de la procédure depuis Kinshasa." }
            },
            {
              "@type": "Question",
              "name": "Puis-je aller aux USA ou au Canada depuis Kinshasa malgré l'Ebola en 2026 ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Oui, mais avec une procédure spéciale. Les USA et le Canada interdisent l'entrée aux personnes ayant séjourné en RDC dans les 21 jours précédents (ordre CDC USA valide depuis mai 2026 ; Canada : suspension totale du 27 mai au 28 août 2026). La solution consiste à « purger » ces 21 jours dans un pays neutre (Maroc, Égypte, Dubaï, Turquie, Maurice ou Europe) avant d'entrer aux USA ou au Canada. Joventy prend en charge le visa pour le pays de transit en 24 à 72h." }
            },
            {
              "@type": "Question",
              "name": "Comment aller aux USA pour la Coupe du Monde 2026 depuis la RDC ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Les Léopards de la RDC sont qualifiés pour la Coupe du Monde 2026 aux USA. Pour les supporters congolais, la procédure nécessite : 1. Obtenir un visa USA (entretien dans un pays tiers, hors RDC). 2. Passer 21 jours dans un pays neutre (Maroc, Égypte, Dubaï) avant d'entrer aux USA. 3. Acheter les billets FIFA. Joventy accompagne tout le processus : visa pays de transit + coordination du dossier USA." }
            },
            {
              "@type": "Question",
              "name": "Comment obtenir un visa Schengen depuis Kinshasa ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Pour un visa Schengen depuis Kinshasa, le rendez-vous se prend via le système CEV (Centre d'Encodage des Visas) géré par l'ambassade belge. Les créneaux sont très limités et pris d'assaut. Joventy surveille le portail CEV en continu et verrouille un créneau dès qu'il est disponible. Frais Joventy : 150 $ engagement + 450 $ succès. Frais CEV (≈90 €) payés séparément. En 2026, le système EES (Entry/Exit System) biométrique est en vigueur dans toute la zone Schengen depuis le 10 avril 2026." }
            },
            {
              "@type": "Question",
              "name": "Comment obtenir un e-Visa Dubaï depuis Kinshasa ?",
              "acceptedAnswer": { "@type": "Answer", "text": "L'e-Visa Dubaï (Émirats Arabes Unis) se demande en ligne via le portail officiel ICP des EAU. Le résultat est généralement obtenu en 48 à 72 heures ouvrables. Joventy prend en charge toute la procédure de soumission. Frais Joventy : 150 $ engagement + 200 $ prime de succès. Les frais officiels du gouvernement des EAU (environ 90 $) sont payés séparément par le client." }
            },
            {
              "@type": "Question",
              "name": "Joventy peut-il aider pour un visa Canada depuis Kinshasa ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Oui. Joventy prend en charge les dossiers IRCC (Immigration, Réfugiés et Citoyenneté Canada) pour les visas visiteur, permis d'études et permis de travail. Attention : en 2026, le Canada a suspendu la délivrance de visas aux résidents de la RDC du 27 mai au 28 août 2026 suite à l'épidémie d'Ebola. Les demandes reprennent après cette période. Frais Joventy : 250 $ engagement + 750 $ succès. Frais IRCC (85 CAD+) non inclus." }
            },
            {
              "@type": "Question",
              "name": "Quels documents faut-il fournir pour un visa USA avec Joventy ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Pour un visa USA B1/B2 depuis Kinshasa avec Joventy, vous devrez fournir : passeport valide (minimum 6 mois de validité, 2 pages vierges), photo récente au format biométrique, justificatif de domicile en RDC, justificatifs financiers (relevés bancaires des 3 derniers mois), justificatif d'emploi ou d'activité, preuve de liens forts avec la RDC (famille, propriété, emploi). Joventy vous guide sur chaque document et remplit le formulaire DS-160 à votre place." }
            },
            {
              "@type": "Question",
              "name": "Les frais consulaires sont-ils inclus dans le prix Joventy ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Non. Les frais consulaires gouvernementaux ne sont jamais inclus dans les tarifs Joventy. Ils sont payés directement par le client auprès du gouvernement ou de l'organisme officiel : frais MRV USA (185-210 $, payés via une banque partenaire), frais CEV Schengen (90 €, payés au portail CEV), frais UKVI Royaume-Uni (à partir de 115 £), frais portail EAU pour Dubaï (environ 90 $), frais e-Visa Turquie (environ 50 $). Joventy vous indique précisément quoi payer et comment." }
            },
            {
              "@type": "Question",
              "name": "Joventy est-il une agence officielle ou une ambassade ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Joventy est une agence privée d'assistance visa, pas une ambassade ni un organisme gouvernemental. Joventy n'est affilié à aucune ambassade. Il s'agit d'un service professionnel qui aide les voyageurs congolais à naviguer les procédures administratives complexes : remplissage des formulaires officiels, surveillance des portails consulaires, soumission des e-Visas. La décision finale d'accorder un visa appartient toujours au gouvernement étranger concerné." }
            },
            {
              "@type": "Question",
              "name": "Mes données personnelles et documents sont-ils en sécurité chez Joventy ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Oui. Joventy (Akollad Groupe) stocke vos données de manière chiffrée. Vos informations personnelles et copies de documents ne sont jamais partagées avec des tiers et sont utilisées uniquement pour constituer votre dossier visa. Joventy traite vos données avec le même niveau de confidentialité qu'une institution financière agréée." }
            },
            {
              "@type": "Question",
              "name": "Est-il possible d'obtenir un visa pour visiter la RDC (Visa Volant, e-Visa DRC) ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Oui. Joventy propose également des services pour les voyageurs étrangers souhaitant visiter la République Démocratique du Congo : e-Visa DRC (demande en ligne, résultat en 3 à 5 jours), Visa Volant (visa d'urgence délivré à l'arrivée pour les cas d'affaires urgents), et suivi physique des dossiers bloqués à la DGM (Direction Générale des Migrations) à Kinshasa." }
            },
            {
              "@type": "Question",
              "name": "Joventy peut-il aider pour un visa Turquie depuis Kinshasa ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Oui. La Turquie délivre des e-Visas en ligne aux détenteurs de visa USA, Schengen ou UK valide. Le résultat est généralement obtenu en 24 à 48 heures. Pour les ressortissants congolais ne disposant pas d'un visa USA/Schengen/UK, Joventy aide à obtenir le visa turc via l'ambassade de Turquie. Frais Joventy : 150 $ engagement + 200 $ succès. La Turquie est également un pays de transit idéal pour « purger » les 21 jours Ebola avant d'entrer aux USA." }
            },
            {
              "@type": "Question",
              "name": "Qu'est-ce que le système EES Schengen 2026 et comment ça m'affecte ?",
              "acceptedAnswer": { "@type": "Answer", "text": "L'EES (Entry/Exit System) est un nouveau système biométrique européen opérationnel depuis le 10 avril 2026. Il remplace les tampons physiques dans les passeports. À chaque entrée dans l'espace Schengen, les voyageurs non-UE (dont les Congolais) enregistrent leurs empreintes digitales et une photo au poste-frontière. Ce système permet de vérifier automatiquement la durée de séjour (maximum 90 jours sur 180). Votre visa Schengen reste valide comme avant ; l'EES change uniquement la procédure de contrôle à la frontière." }
            },
            {
              "@type": "Question",
              "name": "Comment contacter Joventy pour commencer un dossier visa ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Vous pouvez contacter Joventy de plusieurs façons : via WhatsApp au +243 840 808 122 (réponse en moins de 2 heures, 7j/7), par email à contact@joventy.cd, ou directement en créant un dossier sur joventy.cd. L'équipe parle français et anglais, est disponible de 8h à 20h (heure de Kinshasa), et traite les urgences en dehors de ces horaires." }
            },
            {
              "@type": "Question",
              "name": "Joventy peut-il préparer mon dossier visa sans trouver le créneau ?",
              "acceptedAnswer": { "@type": "Answer", "text": "Oui. Joventy propose un service « Formulaires & Vérification » à tarif fixe pour les clients qui ont déjà un créneau consulaire ou un accès au portail et souhaitent uniquement que leurs formulaires (DS-160, IMM5257, etc.) soient remplis et vérifiés par un expert. Ce service est facturé séparément, sans frais de succès." }
            }
          ]
        })}</script>
        <script type="application/ld+json">{JSON.stringify({
          "@context": "https://schema.org",
          "@type": "HowTo",
          "name": "Comment obtenir un visa USA depuis Kinshasa avec Joventy",
          "description": "Guide étape par étape pour obtenir un créneau de rendez-vous visa USA (B1/B2) depuis Kinshasa, RDC, via le service d'assistance Joventy.",
          "estimatedCost": { "@type": "MonetaryAmount", "currency": "USD", "value": "250", "description": "Frais d'engagement Joventy (prime de succès 750 $ due uniquement si créneau obtenu)" },
          "totalTime": "P14D",
          "step": [
            { "@type": "HowToStep", "position": 1, "name": "Créer le dossier", "text": "Inscrivez-vous sur joventy.cd et créez votre dossier visa USA. Payez les frais d'engagement (250 $) via M-Pesa, Airtel Money ou Orange Money." },
            { "@type": "HowToStep", "position": 2, "name": "Envoyer les documents", "text": "Transmettez vos documents via WhatsApp ou l'espace client : passeport, photo biométrique, relevés bancaires (3 mois), justificatif d'emploi, justificatif de domicile en RDC." },
            { "@type": "HowToStep", "position": 3, "name": "Remplissage du formulaire DS-160", "text": "L'équipe Joventy remplit le formulaire DS-160 à votre place et vous soumet le brouillon pour vérification et signature électronique." },
            { "@type": "HowToStep", "position": 4, "name": "Surveillance du portail et capture du créneau", "text": "Joventy surveille le portail usvisaappt.com 24h/24. Dès qu'un créneau est disponible à Kinshasa (ou dans un pays tiers si nécessaire), il est verrouillé et vous êtes notifié immédiatement via WhatsApp." },
            { "@type": "HowToStep", "position": 5, "name": "Paiement de la prime de succès", "text": "Une fois le créneau confirmé, vous payez la prime de succès (750 $) via Mobile Money." },
            { "@type": "HowToStep", "position": 6, "name": "Préparation à l'entretien consulaire", "text": "Joventy vous fournit un guide de préparation personnalisé pour l'entretien B1/B2 : questions probables, documents à apporter, conseils de présentation." },
            { "@type": "HowToStep", "position": 7, "name": "Se rendre à l'entretien", "text": "Présentez-vous à l'ambassade américaine à la date et l'heure indiquées. Si le visa est accordé, vous le recevez dans votre passeport sous 3 à 5 jours ouvrables." }
          ]
        })}</script>
        <script type="application/ld+json">{JSON.stringify({
          "@context": "https://schema.org",
          "@type": "LocalBusiness",
          "name": "Joventy",
          "description": "Agence d'assistance visa premium à Kinshasa. Formulaires, créneaux consulaires, e-Visas pour USA, Canada, Schengen, UK, Dubaï, Turquie, Inde, Maroc et Égypte. Paiement M-Pesa. Prime de succès uniquement.",
          "url": "https://joventy.cd",
          "telephone": "+243840808122",
          "email": "contact@joventy.cd",
          "address": {
            "@type": "PostalAddress",
            "addressLocality": "Kinshasa",
            "addressCountry": "CD"
          },
          "areaServed": {
            "@type": "City",
            "name": "Kinshasa",
            "containedInPlace": { "@type": "Country", "name": "République Démocratique du Congo" }
          },
          "priceRange": "150$-1000$",
          "currenciesAccepted": "USD",
          "paymentAccepted": "M-Pesa, Airtel Money, Orange Money",
          "aggregateRating": {
            "@type": "AggregateRating",
            "ratingValue": "4.9",
            "bestRating": "5",
            "worstRating": "1",
            "reviewCount": "127"
          },
          "sameAs": [
            "https://twitter.com/JoventyCD"
          ]
        })}</script>
      </Helmet>

      <Navbar />

      {/* ═══ ALERTE EBOLA — BANNIÈRE URGENCE ═══ */}
      <div className="bg-red-600 text-white py-3 px-4 relative z-40">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 flex-shrink-0 animate-pulse" />
            <p className="text-sm font-medium">
              <span className="font-bold">ALERTE EBOLA :</span> USA, Canada et Mexique interdisent l'entrée aux personnes ayant été en RDC dans les 21 derniers jours. Services visa USA suspendus à Kinshasa.
            </p>
          </div>
          <Link href="/guides/purger-21-jours-ebola-pays-neutre-visa-usa-2026">
            <Button size="sm" className="bg-white text-red-700 hover:bg-red-50 font-bold text-xs whitespace-nowrap flex-shrink-0">
              Voir les solutions <ArrowRight className="ml-1 w-3 h-3" />
            </Button>
          </Link>
        </div>
      </div>
      {/* ═══ HERO ═══ */}
      <section className="relative pt-32 pb-24 lg:pt-48 lg:pb-36 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <img
            src={`${import.meta.env.BASE_URL}images/hero-bg.png`}
            alt="Skyline de Kinshasa, République Démocratique du Congo — Assistance visa premium Joventy"
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-primary/60 via-primary/75 to-background" />
        </div>

        <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-white text-sm font-semibold mb-8 shadow-lg">
            <Star className="w-4 h-4 text-secondary fill-secondary" />
            <span>Assistance visa premium · Kinshasa, RDC</span>
          </div>

          <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-serif font-semibold text-white tracking-tight leading-[1.05] mb-6 text-balance">
            Votre visa, géré par des experts.{" "}
            <span className="italic text-secondary drop-shadow-md">Vous payez si ça marche.</span>
          </h1>

          <p className="text-lg md:text-xl text-white/75 max-w-2xl mx-auto mb-10 leading-relaxed">
            Joventy remplit vos formulaires, cherche vos créneaux consulaires et soumet vos e-Visas pour l'USA, le Canada, le Royaume-Uni, la Suisse, l'Espagne, Dubaï et plus encore. Paiement via M-Pesa, Airtel Money ou Orange Money, résultat garanti.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-14">
            <Link href="/register">
              <Button size="lg" className="w-full sm:w-auto h-14 px-8 text-lg bg-secondary hover:bg-orange-500 text-primary font-bold shadow-xl shadow-secondary/30 rounded-xl transition-all hover:scale-105">
                Démarrer mon dossier
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </Link>
            <Link href="/login">
              <Button size="lg" variant="outline" className="w-full sm:w-auto h-14 px-8 text-lg border-white/30 text-white hover:bg-white/10 hover:text-white backdrop-blur-md rounded-xl">
                Espace Client
              </Button>
            </Link>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 max-w-lg mx-auto">
            {[
              { val: "150+", label: "Dossiers traités" },
              { val: "98%", label: "Satisfaction client" },
              { val: "72h", label: "Délai moyen e-Visa" },
            ].map((s) => (
              <div key={s.label} className="bg-white/10 backdrop-blur-md rounded-2xl px-3 py-4 border border-white/15">
                <div className="text-2xl sm:text-3xl font-bold text-secondary">{s.val}</div>
                <div className="text-[11px] sm:text-xs text-white/65 mt-0.5 leading-tight">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ TRUST BAR ═══ */}
      <div className="bg-white border-y border-border py-5">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-muted-foreground font-medium">
            {[
              { icon: ShieldCheck, label: "Paiement au résultat" },
              { icon: Phone, label: "M-Pesa, Airtel & Orange Money" },
              { icon: Clock, label: "Suivi en temps réel" },
              { icon: MessageCircle, label: "Chat conseiller inclus" },
              { icon: Award, label: "Données 100% confidentielles" },
            ].map((t) => (
              <div key={t.label} className="flex items-center gap-2">
                <t.icon className="w-4 h-4 text-secondary flex-shrink-0" />
                <span>{t.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ═══ CE QUE FAIT JOVENTY ═══ */}
      <section className="py-20 bg-white border-b border-border">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-secondary font-semibold text-sm uppercase tracking-widest mb-3">Transparence totale</p>
            <h2 className="text-3xl md:text-4xl font-bold text-primary mb-4">
              Joventy, c'est quoi exactement ?
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Nous sommes une <strong>agence d'assistance visa</strong> basée à Kinshasa — pas un consulat, pas une ambassade.
              Notre rôle est de vous accompagner dans votre démarche, pas de vous délivrer un visa.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-12">
            {/* Ce que Joventy fait */}
            <div className="bg-green-50 border border-green-200 rounded-2xl p-7">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-green-600 flex items-center justify-center flex-shrink-0">
                  <BadgeCheck className="w-5 h-5 text-white" />
                </div>
                <h3 className="text-lg font-bold text-green-900">Ce que Joventy fait pour vous</h3>
              </div>
              <ul className="space-y-3">
                {[
                  "Remplit vos formulaires officiels (DS-160, VFS, portails e-Visa)",
                  "Vérifie que vos pièces justificatives sont conformes aux exigences consulaires",
                  "Recherche activement un créneau de rendez-vous consulaire (USA, Schengen, Espagne)",
                  "Soumet votre dossier e-Visa auprès du gouvernement (Dubaï, Inde)",
                  "Vous accompagne par chat dédié à chaque étape du dossier",
                  "Vous transmet le résultat dès obtention (convocation ou e-Visa PDF)",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm text-green-800">
                    <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* Ce que Joventy ne fait pas */}
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-7">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-slate-600 flex items-center justify-center flex-shrink-0">
                  <Landmark className="w-5 h-5 text-white" />
                </div>
                <h3 className="text-lg font-bold text-slate-800">Ce que Joventy ne fait pas</h3>
              </div>
              <ul className="space-y-3">
                {[
                  { text: "Joventy n'est pas un consulat et ne délivre pas de visas", note: "La décision d'accord ou de refus appartient exclusivement à l'ambassade ou au gouvernement étranger." },
                  { text: "Joventy ne garantit pas l'approbation finale du visa", note: "Nous garantissons uniquement le service : si nous ne trouvons pas de créneau ou si l'e-Visa est refusé, vous ne payez pas la prime de succès." },
                  { text: "Les frais consulaires et annexes ne sont pas inclus dans nos tarifs", note: "MRV USA (185-210$), frais CEV Schengen (90€), e-Visa Turquie (~50$), e-Visa EAU (~90$), e-Visa Inde (~25-80$), assurance voyage, réservations d'hôtel et de billets d'avion restent à la charge du client et sont payés directement aux organismes concernés." },
                ].map((item) => (
                  <li key={item.text} className="flex items-start gap-3">
                    <XCircle className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-slate-700">{item.text}</p>
                      <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{item.note}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Modèle de frais */}
          <div className="bg-primary rounded-2xl p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-6">
              <CreditCard className="w-5 h-5 text-secondary" />
              <h3 className="text-lg font-bold text-white">Comment fonctionne le paiement ?</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                {
                  num: "1",
                  title: "Frais d'engagement",
                  desc: "Payés à la création du dossier. Couvrent l'analyse, la vérification de vos pièces et le démarrage du service.",
                  color: "bg-white/10 border-white/20",
                },
                {
                  num: "2",
                  title: "Prime de succès",
                  desc: "Due uniquement si Joventy obtient un résultat (créneau ou e-Visa). Si échec : vous ne payez rien de plus.",
                  color: "bg-secondary/20 border-secondary/30",
                  highlight: true,
                },
                {
                  num: "3",
                  title: "Frais consulaires",
                  desc: "Payés directement par vous au consulat/gouvernement étranger. Non collectés par Joventy. Montants variables selon la destination.",
                  color: "bg-white/10 border-white/20",
                },
              ].map((item) => (
                <div key={item.num} className={`rounded-xl border p-5 ${item.color}`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold mb-3 ${item.highlight ? "bg-secondary text-primary" : "bg-white/20 text-white"}`}>
                    {item.num}
                  </div>
                  <h4 className={`font-bold text-sm mb-2 ${item.highlight ? "text-secondary" : "text-white"}`}>{item.title}</h4>
                  <p className="text-xs text-white/65 leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══ COMMENT ÇA MARCHE ═══ */}
      <section className="py-24 bg-muted">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <p className="text-secondary font-semibold text-sm uppercase tracking-widest mb-3">Simple & transparent</p>
            <h2 className="text-3xl md:text-4xl font-bold text-primary mb-4">Comment ça marche</h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">Quatre étapes pour obtenir votre visa, sans vous déplacer en agence.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
            {STEPS.map((step, i) => {
              const Icon = step.icon;
              return (
                <div key={i} className="relative">
                  {i < STEPS.length - 1 && (
                    <div className="hidden lg:block absolute top-10 left-full w-8 z-10 -translate-x-4">
                      <ChevronRight className="w-5 h-5 text-border mx-auto" />
                    </div>
                  )}
                  <div className="bg-white rounded-2xl p-7 border border-border shadow-sm h-full flex flex-col">
                    <div className="flex items-start gap-4 mb-4">
                      <span className="text-4xl font-bold text-muted-foreground/30 leading-none select-none">{step.num}</span>
                      <div className="w-10 h-10 rounded-xl bg-secondary/10 flex items-center justify-center flex-shrink-0 mt-1">
                        <Icon className="w-5 h-5 text-secondary" />
                      </div>
                    </div>
                    <h3 className="text-lg font-bold text-primary mb-2">{step.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed flex-1">{step.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══ PACKAGES ═══ */}
      <section id="services" className="py-24 bg-primary text-white relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(255,152,0,0.08),transparent_60%)]" />
        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <p className="text-secondary font-semibold text-sm uppercase tracking-widest mb-3">Nos formules</p>
            <h2 className="text-3xl md:text-4xl font-serif font-bold text-white mb-4">Choisissez votre niveau de service</h2>
            <p className="text-white/70 text-lg max-w-xl mx-auto">Que vous ayez juste besoin d'un créneau ou d'un accompagnement complet, nous avons la formule adaptée.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
            {PACKAGES.map((pkg) => {
              const Icon = pkg.icon;
              return (
                <div
                  key={pkg.key}
                  className={`relative rounded-2xl p-7 flex flex-col ${
                    pkg.highlight
                      ? "bg-secondary text-primary ring-4 ring-secondary/30"
                      : "bg-white/5 border border-white/10 backdrop-blur-sm text-white"
                  }`}
                >
                  {pkg.highlight && (
                    <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-white text-primary text-xs font-bold px-3 py-1 rounded-full shadow-lg">
                      ⭐ Recommandé
                    </span>
                  )}
                  <div className="flex items-center gap-3 mb-4">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${pkg.highlight ? "bg-primary/10" : "bg-white/10"}`}>
                      <Icon className={`w-5 h-5 ${pkg.highlight ? "text-primary" : "text-secondary"}`} />
                    </div>
                    <div>
                      <p className={`text-xs font-semibold uppercase tracking-wide ${pkg.highlight ? "text-primary/60" : "text-white/55"}`}>{pkg.tagline}</p>
                      <h3 className={`font-bold text-lg ${pkg.highlight ? "text-primary" : "text-white"}`}>{pkg.label}</h3>
                    </div>
                  </div>

                  <p className={`text-sm mb-5 leading-relaxed ${pkg.highlight ? "text-primary/80" : "text-white/70"}`}>{pkg.desc}</p>

                  <ul className="space-y-2.5 flex-1 mb-6">
                    {pkg.features.map((f) => (
                      <li key={f} className={`flex items-start gap-2.5 text-sm ${pkg.highlight ? "text-primary" : "text-white/85"}`}>
                        <CheckCircle2 className={`w-4 h-4 flex-shrink-0 mt-0.5 ${pkg.highlight ? "text-primary" : "text-secondary"}`} />
                        {f}
                      </li>
                    ))}
                  </ul>

                  <Link href="/register">
                    <Button
                      className={`w-full font-bold ${
                        pkg.highlight
                          ? "bg-primary hover:bg-primary/90 text-white"
                          : "bg-secondary hover:bg-orange-500 text-primary"
                      }`}
                    >
                      Choisir cette formule <ArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══ DESTINATIONS ═══ */}
      <section id="destinations" className="py-24 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <p className="section-label justify-center">Tarifs transparents</p>
            <h2 className="section-title">Destinations & Tarifs</h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">Tout est affiché. Pas de frais cachés — vous connaissez exactement le coût avant de commencer.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {DESTINATIONS.map((dest) => (
              <div key={dest.name} className="bg-card border border-border rounded-2xl overflow-hidden shadow-premium hover-lift flex flex-col">
                <div className="bg-muted px-6 py-5 border-b border-border relative">
                  {dest.badge && (
                    <span className="absolute top-3 right-3 bg-secondary text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide">
                      {dest.badge}
                    </span>
                  )}
                  <div className="flex items-center gap-3 mb-3">
                    <FlagImg code={dest.code} size={40} className="shadow-sm" />
                    <h3 className="text-xl font-bold text-primary leading-tight">{dest.name}</h3>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {dest.visaTypes.slice(0, 3).map((v) => (
                      <span key={v} className="text-[10px] bg-primary/5 text-primary/70 px-2 py-0.5 rounded-full font-medium">{v}</span>
                    ))}
                    {dest.visaTypes.length > 3 && (
                      <span className="text-[10px] text-muted-foreground px-2 py-0.5">+{dest.visaTypes.length - 3}</span>
                    )}
                  </div>
                </div>

                <div className="px-6 py-5 flex-1 flex flex-col">
                  <div className="space-y-2.5 flex-1 mb-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Frais d'engagement</span>
                      <span className="font-bold text-primary">{dest.engagement} $</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Prime de succès</span>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-green-700 font-semibold">si résultat</span>
                        <span className="font-bold text-primary">{dest.success} $</span>
                      </div>
                    </div>
                    <div className="pt-2 border-t border-border flex items-center justify-between">
                      <span className="text-xs font-semibold text-muted-foreground">Total max</span>
                      <span className="font-bold text-lg text-primary">{dest.engagement + dest.success} $</span>
                    </div>
                  </div>

                  <div className="text-[10px] text-muted-foreground italic mb-4">{dest.note}</div>

                  <Link href="/register">
                    <Button size="sm" className="w-full bg-primary hover:bg-primary/90 text-white font-semibold gap-1">
                      Commencer <ArrowRight className="w-3.5 h-3.5" />
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ GARANTIES ═══ */}
      <section className="py-24 bg-muted">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <p className="section-label justify-center">Notre engagement</p>
            <h2 className="section-title">Pourquoi choisir Joventy</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {GUARANTEES.map((g) => {
              const Icon = g.icon;
              return (
                <div key={g.title} className="bg-card rounded-2xl p-7 border border-border shadow-premium hover-lift text-center flex flex-col items-center">
                  <div className="w-14 h-14 rounded-2xl bg-secondary/10 flex items-center justify-center mb-5">
                    <Icon className="w-7 h-7 text-secondary" />
                  </div>
                  <h3 className="font-bold text-primary text-base mb-2">{g.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{g.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══ TÉMOIGNAGES ═══ */}
      <section className="py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <p className="section-label justify-center">Ce qu'ils disent</p>
            <h2 className="section-title">Clients satisfaits</h2>
            <div className="flex items-center justify-center gap-1 mt-4">
              {[...Array(5)].map((_, i) => (
                <Star key={i} className="w-5 h-5 text-secondary fill-secondary" />
              ))}
              <span className="ml-2 text-sm text-muted-foreground font-medium">4.9/5 · 120+ avis</span>
            </div>
          </div>

          <ConvexErrorBoundary fallback={<StaticTestimonialsGrid />}>
            <LiveTestimonialsGrid />
          </ConvexErrorBoundary>
        </div>
      </section>

      {/* ═══ FAQ ═══ */}
      <section className="py-24 bg-muted">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 mb-3">
              <HelpCircle className="w-5 h-5 text-secondary" />
              <p className="text-secondary font-semibold text-sm uppercase tracking-widest">Questions fréquentes</p>
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-primary">Ce que vous devez savoir</h2>
          </div>

          <div className="space-y-4">
            {[
              {
                q: "Joventy garantit-il l'obtention du visa ?",
                a: "Non. Joventy garantit le service, pas le visa. La décision finale appartient exclusivement à l'ambassade ou au gouvernement étranger. En revanche, si nous n'obtenons pas de résultat (créneau de rendez-vous ou e-Visa), vous ne payez pas la prime de succès — seuls les frais d'engagement restent dus.",
              },
              {
                q: "Que se passe-t-il si mon visa est refusé après un rendez-vous ?",
                a: "Si vous avez obtenu un créneau de rendez-vous (USA, Schengen) ou votre e-Visa (Dubaï, Turquie, Inde), Joventy a rempli sa mission et la prime de succès est due. Le refus consulaire lors de l'entretien est une décision souveraine de l'ambassade, indépendante du service Joventy.",
              },
              {
                q: "Les frais consulaires, assurances et réservations sont-ils inclus dans vos tarifs ?",
                a: "Non. Les frais consulaires sont payés directement par vous au gouvernement ou à l'organisme concerné (banque pour le MRV USA, CEV pour le Schengen, portail officiel pour Dubaï, Turquie et l'Inde). De même, l'assurance voyage, les réservations d'hôtel et les billets d'avion — souvent exigés par le consulat comme pièces justificatives — sont entièrement à votre charge. Joventy vous indique ce qu'il faut préparer, mais ne règle pas ces frais à votre place.",
              },
              {
                q: "Mes documents et informations personnelles sont-ils en sécurité ?",
                a: "Oui. Vos données sont stockées de manière chiffrée et ne sont jamais partagées à des tiers. Elles sont utilisées uniquement pour constituer votre dossier de visa. Nous traitons vos informations avec le même niveau de confidentialité qu'une institution financière.",
              },
              {
                q: "Combien de temps prend le traitement d'un dossier ?",
                a: "Pour les e-Visas (Dubaï, Inde) : résultat en 48 à 72 heures ouvrables en général. Pour les créneaux consulaires (USA, Turquie) : le délai dépend de la disponibilité sur le portail, qui varie selon la période. Joventy surveille en continu et vous notifie dès qu'un créneau est capturé.",
              },
            ].map((item) => (
              <div key={item.q} className="bg-white rounded-2xl border border-border p-6 shadow-sm">
                <h3 className="font-bold text-primary mb-3 flex items-start gap-3">
                  <span className="w-6 h-6 rounded-full bg-secondary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-secondary text-xs font-bold">?</span>
                  </span>
                  {item.q}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed pl-9">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ GUIDES D'URGENCE — EBOLA 2026 ═══ */}
      <section className="py-16 bg-red-50 border-y border-red-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 bg-red-100 text-red-700 text-xs font-bold px-3 py-1.5 rounded-full mb-4">
              <AlertTriangle className="w-4 h-4" />
              URGENCE EBOLA — MAI 2026
            </div>
            <h2 className="text-2xl md:text-3xl font-bold text-primary mb-3">
              Guides d'urgence — Restrictions de voyage RDC
            </h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              Les USA, le Canada et le Mexique interdisent l'entrée aux personnes ayant séjourné en RDC dans les 21 derniers jours. Voici comment réagir.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {[
              {
                emoji: "🌍",
                title: "Purger 21 jours dans un pays neutre",
                desc: "Maroc, Égypte, Dubaï, Turquie, Maurice — où aller, quel visa, quel budget. Joventy vous obtient le visa en 24-72h.",
                href: "/guides/purger-21-jours-ebola-pays-neutre-visa-usa-2026",
                badge: "GUIDE #1",
              },
              {
                emoji: "🚨",
                title: "Suspension visa Canada RDC",
                desc: "Tous les visas suspendus du 27 mai au 28 août 2026. Alternatives et préparation pour la reprise.",
                href: "/guides/suspension-visa-canada-rdc-ebola-2026",
                badge: "ALERTE",
              },
              {
                emoji: "⚽",
                title: "Coupe du Monde 2026 — Visa USA",
                desc: "Les Léopards jouent aux USA ! Comment y assister malgré l'interdiction d'entrée et la règle des 21 jours.",
                href: "/guides/coupe-du-monde-2026-visa-usa-kinshasa",
                badge: "WORLD CUP",
              },
            ].map((guide) => (
              <Link key={guide.href} href={guide.href}>
                <div className="bg-white border border-red-200 rounded-2xl p-6 hover:shadow-lg hover:-translate-y-1 transition-all cursor-pointer h-full flex flex-col">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-3xl">{guide.emoji}</span>
                    <span className="text-[10px] font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{guide.badge}</span>
                  </div>
                  <h3 className="font-bold text-primary text-sm mb-2">{guide.title}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed flex-1">{guide.desc}</p>
                  <div className="flex items-center gap-1 text-red-600 text-xs font-semibold mt-4">
                    Lire le guide <ChevronRight className="w-3 h-3" />
                  </div>
                </div>
              </Link>
            ))}
          </div>

          <div className="text-center mt-8">
            <a href="https://wa.me/243840808122" target="_blank" rel="noopener noreferrer">
              <Button className="bg-[#25D366] hover:bg-[#1ebe5d] text-white font-bold">
                <MessageCircle className="mr-2 w-4 h-4" /> Besoin d'aide urgente ? WhatsApp Joventy
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* ═══ DRC E-VISA / VISA VOLANT — INTERNATIONAL CLIENTS ��══ */}
      <section className="py-24 bg-white border-b border-border">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 mb-3">
              <FlagImg code="cd" size={32} />
              <p className="text-secondary font-semibold text-sm uppercase tracking-widest">International Clients</p>
            </div>
            <h2 className="text-3xl md:text-4xl font-serif font-bold text-primary mb-4">
              DRC E-Visa &amp; Visa Volant Services
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto leading-relaxed">
              Planning to travel to the Democratic Republic of Congo? We handle the entire process for you — from e-Visa and Visa Volant applications to physical follow-up on pending cases right here in Kinshasa.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10">
            {/* E-Visa & Visa Volant */}
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-7">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center flex-shrink-0">
                  <FileText className="w-5 h-5 text-white" />
                </div>
                <h3 className="text-lg font-bold text-blue-900">E-Visa &amp; Visa Volant Applications</h3>
              </div>
              <p className="text-sm text-blue-800 leading-relaxed mb-4">
                Whether you need a standard DRC e-Visa or a Visa Volant (emergency/express visa), our team based in Kinshasa handles the full application process on your behalf. We prepare the paperwork, submit your request, and keep you informed at every step.
              </p>
              <ul className="space-y-2.5">
                {[
                  "Full application preparation and submission",
                  "DRC e-Visa (tourist, business, transit)",
                  "Visa Volant (emergency/express processing)",
                  "Document verification and compliance check",
                  "Real-time status updates via WhatsApp",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm text-blue-800">
                    <CheckCircle2 className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* Physical Follow-up */}
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-7">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-amber-600 flex items-center justify-center flex-shrink-0">
                  <Clock className="w-5 h-5 text-white" />
                </div>
                <h3 className="text-lg font-bold text-amber-900">Physical Follow-Up in Kinshasa</h3>
              </div>
              <p className="text-sm text-amber-800 leading-relaxed mb-4">
                Already submitted your DRC visa application but it's been taking too long? Our team physically follows up on your case at the immigration offices in Kinshasa. We track your file, check its status in person, and push to get you a resolution faster.
              </p>
              <ul className="space-y-2.5">
                {[
                  "In-person follow-up at DGM (Direction Générale de Migration)",
                  "Case status tracking and escalation",
                  "Direct liaison with immigration officers",
                  "Regular progress reports via WhatsApp",
                  "Available for all visa types (e-Visa, Visa Volant, extensions)",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm text-amber-800">
                    <CheckCircle2 className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* CTA for international clients */}
          <div className="bg-primary rounded-2xl p-6 sm:p-8 text-center">
            <h3 className="text-xl font-bold text-white mb-3">
              Need help with your DRC visa? Get in touch today.
            </h3>
            <p className="text-white/70 text-sm mb-6 max-w-lg mx-auto leading-relaxed">
              For all DRC e-Visa, Visa Volant applications, or physical follow-up on pending cases, contact us directly on WhatsApp. Our team in Kinshasa is ready to assist you.
            </p>
            <a
              href="https://wa.me/243840808122"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="lg" className="h-14 px-8 text-lg bg-green-500 hover:bg-green-600 text-white font-bold shadow-xl rounded-xl transition-all hover:scale-105">
                <MessageCircle className="mr-2 w-5 h-5" />
                Contact us on WhatsApp
              </Button>
            </a>
            <p className="text-white/50 text-xs mt-4">+243 840 808 122 · Response within 2 hours</p>
          </div>
        </div>
      </section>

      {/* ═══ CTA FINAL ═══ */}
      <section className="py-20 bg-primary relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,_rgba(255,152,0,0.12),transparent_55%)]" />
        <div className="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <div className="flex items-center justify-center gap-2 mb-6">
            <Users className="w-5 h-5 text-secondary" />
            <span className="text-white/70 text-sm font-medium">150+ Congolais ont déjà obtenu leur visa avec Joventy</span>
          </div>
          <h2 className="text-3xl md:text-5xl font-serif font-bold text-white mb-6 leading-tight">
            Prêt à voyager ?<br />
            <span className="text-secondary">Créez votre dossier en 5 minutes.</span>
          </h2>
          <p className="text-white/70 text-lg mb-10">
            Rejoignez les voyageurs congolais qui font confiance à Joventy. Paiement via M-Pesa, Airtel Money ou Orange Money, sans paperasse, résultat garanti.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/register">
              <Button size="lg" className="w-full sm:w-auto h-14 px-10 text-lg bg-secondary hover:bg-orange-500 text-primary font-bold shadow-2xl shadow-secondary/20 rounded-xl transition-all hover:scale-105">
                Démarrer mon dossier
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </Link>
            <Link href="/login">
              <Button size="lg" variant="outline" className="w-full sm:w-auto h-14 px-8 text-lg border-white/30 text-white hover:bg-white/10 hover:text-white rounded-xl">
                J'ai déjà un compte
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* ═══ CONTACT ═══ */}
      <section id="contact" className="py-24 bg-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14">
            <p className="text-secondary font-semibold text-sm uppercase tracking-widest mb-3">On est là</p>
            <h2 className="text-3xl md:text-4xl font-serif font-bold text-primary mb-4">Contactez-nous</h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">Une question avant de commencer ? Notre équipe vous répond rapidement.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {[
              {
                icon: MessageCircle,
                label: "WhatsApp",
                value: "+243 840 808 122",
                sub: "Réponse en moins de 2h",
                href: "https://wa.me/243840808122",
                cta: "Écrire sur WhatsApp",
                color: "bg-green-500",
              },
              {
                icon: Mail,
                label: "Email",
                value: "contact@joventy.cd",
                sub: "Réponse en 24h ouvrables",
                href: "mailto:contact@joventy.cd",
                cta: "Envoyer un email",
                color: "bg-primary",
              },
              {
                icon: TrendingUp,
                label: "Espace Client",
                value: "Chat intégré",
                sub: "Suivi de votre dossier en temps réel",
                href: "/login",
                cta: "Accéder à mon espace",
                color: "bg-secondary",
              },
            ].map((c) => {
              const Icon = c.icon;
              const isExternal = c.href.startsWith("http") || c.href.startsWith("mailto");
              const Inner = (
                <div className="bg-muted border border-border rounded-2xl p-7 flex flex-col items-center text-center h-full hover:shadow-md hover:-translate-y-1 transition-all duration-200">
                  <div className={`w-12 h-12 rounded-xl ${c.color} flex items-center justify-center mb-4`}>
                    <Icon className="w-6 h-6 text-white" />
                  </div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1">{c.label}</p>
                  <p className="font-bold text-primary text-sm mb-1">{c.value}</p>
                  <p className="text-xs text-muted-foreground mb-5">{c.sub}</p>
                  <span className="mt-auto text-sm font-semibold text-primary underline underline-offset-4">{c.cta} →</span>
                </div>
              );
              return isExternal ? (
                <a key={c.label} href={c.href} target="_blank" rel="noopener noreferrer" className="flex flex-col">
                  {Inner}
                </a>
              ) : (
                <Link key={c.label} href={c.href} className="flex flex-col">
                  {Inner}
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══ FOOTER ═══ */}
      <footer className="bg-primary text-white py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-10 mb-10">
            <div className="md:col-span-1">
              <JoventyLogo variant="dark" size="md" />
              <p className="mt-4 text-white/55 text-sm leading-relaxed max-w-xs">
                Assistance visa premium pour les voyageurs congolais. Formulaires, créneaux, e-Visas — nous gérons tout.
              </p>
              <div className="mt-5 flex flex-col gap-1.5 text-xs text-white/40">
                <a href="mailto:contact@joventy.cd" className="hover:text-white transition-colors">✉ contact@joventy.cd</a>
                <a href="https://wa.me/243840808122" className="hover:text-white transition-colors">📱 +243 840 808 122</a>
              </div>
            </div>

            <div>
              <h4 className="font-bold text-sm uppercase tracking-wider text-white/65 mb-4">Destinations</h4>
              <ul className="space-y-2 text-sm text-white/50">
                {([
                  { code: "us", label: "Visa États-Unis", href: "/visa-usa-kinshasa" },
                  { code: "ca", label: "Visa Canada", href: "/visa-canada-kinshasa" },
                  { code: "gb", label: "Visa Royaume-Uni", href: "/visa-royaume-uni-kinshasa" },
                  { code: "ch", label: "Visa Suisse", href: "/visa-suisse-kinshasa" },
                  { code: "eu", label: "Visa Schengen", href: "/visa-schengen-kinshasa" },
                  { code: "es", label: "Visa Espagne", href: "/visa-espagne-kinshasa" },
                  { code: "ae", label: "E-Visa Dubaï", href: "/e-visa-dubai-kinshasa" },
                  { code: "tr", label: "Visa Turquie", href: "/visa-turquie-kinshasa" },
                  { code: "in", label: "E-Visa Inde", href: "/e-visa-inde-kinshasa" },
                  { code: "ma", label: "Visa Maroc", href: "/visa-maroc-kinshasa" },
                  { code: "eg", label: "Visa Égypte", href: "/e-visa-egypte-kinshasa" },
                ] as { code: string; label: string; href: string }[]).map((d) => (
                  <li key={d.code}>
                    <Link href={d.href} className="hover:text-white transition-colors flex items-center gap-2">
                      <FlagImg code={d.code} size={20} className="opacity-90" />
                      {d.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="font-bold text-sm uppercase tracking-wider text-white/65 mb-4">Guides populaires</h4>
              <ul className="space-y-2 text-sm text-white/50">
                {[
                  { label: "🌍 Purger 21 jours (Ebola)", href: "/guides/purger-21-jours-ebola-pays-neutre-visa-usa-2026" },
                  { label: "🚨 Suspension Canada RDC", href: "/guides/suspension-visa-canada-rdc-ebola-2026" },
                  { label: "⚽ Coupe du Monde 2026", href: "/guides/coupe-du-monde-2026-visa-usa-kinshasa" },
                  { label: "Créneau visa USA", href: "/guides/comment-obtenir-creneau-visa-usa-kinshasa" },
                  { label: "Entretien B1/B2", href: "/guides/entretien-visa-usa-b1-b2-questions" },
                  { label: "Documents Schengen", href: "/guides/documents-visa-schengen-kinshasa" },
                  { label: "Tous les guides →", href: "/guides" },
                ].map((l) => (
                  <li key={l.label}><Link href={l.href} className="hover:text-white transition-colors">{l.label}</Link></li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="font-bold text-sm uppercase tracking-wider text-white/65 mb-4">Légal</h4>
              <ul className="space-y-2 text-sm text-white/50">
                {[
                  { label: "Mentions légales", href: "/mentions-legales" },
                  { label: "Politique de confidentialité", href: "/confidentialite" },
                  { label: "Conditions d'utilisation", href: "/conditions" },
                  { label: "Politique de remboursement", href: "/remboursement" },
                ].map((l) => (
                  <li key={l.label}><Link href={l.href} className="hover:text-white transition-colors">{l.label}</Link></li>
                ))}
              </ul>
            </div>
          </div>

          <div className="pt-8 border-t border-white/10 flex flex-col sm:flex-row justify-between items-center gap-4 text-xs text-white/35">
            <p>© {new Date().getFullYear()} Joventy · Un service <a href="https://akollad.com" target="_blank" rel="noreferrer" className="hover:text-white/60 underline underline-offset-2">Akollad Groupe</a> · Kinshasa, RDC</p>
            <p>Paiement via M-Pesa, Airtel Money & Orange Money 🇨🇩</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
