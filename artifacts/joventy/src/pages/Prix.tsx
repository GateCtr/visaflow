import { Link } from "wouter";
import { Helmet } from "react-helmet-async";
import { ArrowRight, CheckCircle2, MessageCircle, ChevronRight, AlertTriangle, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PublicLayout } from "@/components/layout/PublicLayout";

const FLAG_SIZES = [20, 40, 80, 160, 320, 640];
function snapFlagSize(n: number) { return FLAG_SIZES.find((s) => s >= n) ?? 80; }
const FLAG_NAMES: Record<string, string> = {
  us: "États-Unis", ca: "Canada", gb: "Royaume-Uni", eu: "Europe Schengen",
  es: "Espagne", ch: "Suisse", ae: "Émirats Arabes Unis (Dubaï)", tr: "Turquie",
  in: "Inde", ma: "Maroc", eg: "Égypte", cn: "Chine", cd: "République Démocratique du Congo", br: "Brésil",
};
function FlagImg({ code, size = 32, className = "" }: { code: string; size?: number; className?: string }) {
  const snapped = snapFlagSize(size);
  const altText = FLAG_NAMES[code.toLowerCase()] ?? `Drapeau ${code.toUpperCase()}`;
  return <img src={`https://flagcdn.com/w${snapped}/${code.toLowerCase()}.png`} width={snapped} alt={altText} className={`rounded-sm object-cover flex-shrink-0 ${className}`} />;
}

const DESTINATIONS = [
  { code: "us", name: "Visa USA", types: "B1/B2, F1, K1, H1B", delay: "Variable (créneaux)", href: "/visa-usa-kinshasa", alert: "⚠️ Services suspendus à Kinshasa (Ebola)", note: null },
  { code: "ca", name: "Visa Canada", types: "Visiteur, Études, Travail", delay: "2-8 semaines", href: "/visa-canada-kinshasa", alert: "⚠️ Suspendus pour RDC (27 mai — 28 août 2026)", note: null },
  { code: "eu", name: "Visa Schengen", types: "Tourisme, Études, Long séjour, Visa D", delay: "15-30 jours ouvrables", href: "/visa-schengen-kinshasa", alert: null, note: null },
  { code: "gb", name: "Visa Royaume-Uni", types: "Standard Visitor, Student, Work", delay: "3-6 semaines", href: "/visa-royaume-uni-kinshasa", alert: null, note: null },
  { code: "es", name: "Visa Espagne", types: "Tourisme, Études, Long séjour", delay: "15-30 jours ouvrables", href: "/visa-espagne-kinshasa", alert: null, note: null },
  { code: "ch", name: "Visa Suisse", types: "Tourisme, Études, Long séjour", delay: "15-30 jours ouvrables", href: "/visa-suisse-kinshasa", alert: null, note: null },
  { code: "de", name: "Visa Allemagne", types: "National Études / Travail, Regroupement familial, Chancenkarte", delay: "Variable (RK-Termin)", href: "/visa-schengen-kinshasa", alert: null, note: null },
  { code: "ae", name: "Visa Dubaï (EAU)", types: "Touriste 30j/60j, Affaires, Résidence", delay: "48-72h", href: "/e-visa-dubai-kinshasa", alert: null, note: null },
  { code: "tr", name: "Visa Turquie", types: "E-Visa en ligne, Visa Sticker (ambassade), Transit", delay: "24-48h (e-Visa)", href: "/visa-turquie-kinshasa", alert: null, note: null },
  { code: "al", name: "Visa Albanie", types: "E-Visa en ligne, Visa touristique", delay: "2-5 jours ouvrables", href: "/visa-albanie-kinshasa", alert: null, note: "ℹ️ E-Visa disponible en ligne. Titulaires d'un visa Schengen/USA/UK valide peuvent entrer sans visa." },
  { code: "ma", name: "Visa Maroc", types: "E-Visa portail officiel, Consulaire, Transit 21j", delay: "24-72h (e-Visa) / 3-5j (consulaire)", href: "/visa-maroc-kinshasa", alert: null, note: "ℹ️ Idéal pour transit 21j (Ebola). E-Visa 100 % en ligne ou visa consulaire sans RDV à Kinshasa." },
  { code: "eg", name: "Visa Égypte", types: "E-Visa en ligne, Consulaire, Transit 21j", delay: "24-72h (e-Visa) / 3-5j (consulaire)", href: "/e-visa-egypte-kinshasa", alert: null, note: "ℹ️ Idéal pour transit 21j (Ebola). E-Visa sur visa2egypt.gov.eg ou visa consulaire sans RDV à Kinshasa." },
  { code: "cn", name: "Visa Chine", types: "E-Visa court séjour, Visa L/M/F/X2 via VFS (sans RDV)", delay: "4-7 jours ouvrables", href: "/visa-chine-kinshasa", alert: null, note: "ℹ️ Dépôt via VFS Global à Kinshasa (sans RDV). E-Visa pour courts séjours tourisme/transit." },
  { code: "in", name: "Visa Inde", types: "E-Visa Tourisme, Médical, Affaires", delay: "72-96h", href: "/e-visa-inde-kinshasa", alert: null, note: null },
  { code: "br", name: "Visa Brésil", types: "Tourisme (VITUR), Affaires (VITEM II), Études (VITEM IV)", delay: "Variable (RDV consulaire)", href: "/visa-bresil-kinshasa", alert: null, note: "ℹ️ RDV consulaire obligatoire à l'ambassade du Brésil à Kinshasa." },
];

const INCLUDES = [
  "Remplissage complet des formulaires officiels (DS-160, IRCC, Schengen, etc.)",
  "Vérification, profilage et préparation de votre dossier complet",
  "Recherche et capture de créneaux consulaires (USA, Schengen, Canada, Allemagne, Espagne…)",
  "Soumission sur les portails officiels pour les visas en ligne",
  "Suivi en temps réel via votre espace client + notifications WhatsApp",
  "Assistance pour la préparation à l'entretien consulaire",
  "Support WhatsApp réactif (réponse en moins de 2h)",
];

const NOT_INCLUDES = [
  "Assurance voyage (obligatoire pour Schengen, environ 20-50 USD/semaine)",
  "Réservations d'hôtel et billets d'avion (requis comme pièces justificatives)",
  "Frais de traduction certifiée (si documents en langues autres que français/anglais)",
  "Photos d'identité aux normes (réalisées chez un photographe agréé)",
];

export default function Prix() {
  const pricingSchema = {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Assistance Visa Joventy — Kinshasa, RDC",
    "description": "Service d'assistance visa premium depuis Kinshasa. Formulaires, créneaux consulaires, e-Visas. Paiement au résultat via M-Pesa.",
    "brand": { "@type": "Brand", "name": "Joventy" },
    "offers": {
      "@type": "AggregateOffer",
      "priceCurrency": "USD",
      "lowPrice": "350",
      "highPrice": "1500",
      "offerCount": DESTINATIONS.length.toString(),
    },
    "aggregateRating": {
      "@type": "AggregateRating",
      "ratingValue": "4.9",
      "bestRating": "5",
      "worstRating": "1",
      "reviewCount": "127",
    },
    "review": [
      {
        "@type": "Review",
        "reviewRating": { "@type": "Rating", "ratingValue": "5", "bestRating": "5" },
        "author": { "@type": "Person", "name": "Christophe M." },
        "reviewBody": "J'avais essayé d'avoir un créneau à l'ambassade américaine pendant 4 mois sans succès. Joventy a trouvé une date en moins de 3 semaines. Incroyable.",
        "datePublished": "2025-11-15",
      },
      {
        "@type": "Review",
        "reviewRating": { "@type": "Rating", "ratingValue": "5", "bestRating": "5" },
        "author": { "@type": "Person", "name": "Nathalie K." },
        "reviewBody": "Processus ultra simple. J'ai uploadé mes documents le lundi, mon e-Visa était prêt le mercredi. Paiement M-Pesa sans complication.",
        "datePublished": "2025-12-03",
      },
      {
        "@type": "Review",
        "reviewRating": { "@type": "Rating", "ratingValue": "5", "bestRating": "5" },
        "author": { "@type": "Person", "name": "Patrick B." },
        "reviewBody": "Le suivi en temps réel dans l'application est rassurant. Mon conseiller répondait dans la journée. Je recommande vivement.",
        "datePublished": "2026-01-22",
      },
    ],
  };

  return (
    <PublicLayout solidNav>
      <Helmet>
        <title>Tarifs Visa Joventy 2026 — Prix Assistance Visa Kinshasa | Joventy</title>
        <meta name="description" content="Tarifs Joventy 2026 depuis Kinshasa : créneau consulaire 350$ (après résultat), accompagnement complet 1 500$ (500+1 000$), accompagnement partiel 600$ (200+400$). Toutes destinations. Paiement M-Pesa." />
        <link rel="canonical" href="https://joventy.cd/prix" />
        <meta property="og:title" content="Tarifs Visa Joventy 2026 — Prix Assistance Visa Kinshasa" />
        <meta property="og:description" content="Créneau 350$ (après résultat) · Accompagnement Complet 1 500$ · Accompagnement Partiel 600$ (200+400$). Toutes destinations. Paiement M-Pesa." />
        <meta property="og:url" content="https://joventy.cd/prix" />
        <meta property="og:type" content="website" />
        <meta property="og:image" content="https://joventy.cd/opengraph.jpg" />
        <meta property="og:locale" content="fr_CD" />
        <meta property="og:site_name" content="Joventy" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Tarifs Visa Joventy 2026 — Prix Assistance Visa Kinshasa" />
        <meta name="twitter:description" content="Créneau 350$ (après résultat) · Accompagnement Complet 1 500$ · Accompagnement Partiel 600$ (200+400$). Toutes destinations. Paiement M-Pesa." />
        <meta name="twitter:image" content="https://joventy.cd/opengraph.jpg" />
        <meta name="twitter:site" content="@JoventyCD" />
        <script type="application/ld+json">{JSON.stringify(pricingSchema)}</script>
      </Helmet>

      {/* HERO */}
      <section className="bg-gradient-to-b from-primary/5 to-white py-16 px-4">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-3xl md:text-4xl font-bold text-primary mb-4">
            Tarifs Joventy — Assistance Visa depuis Kinshasa
          </h1>
          <p className="text-muted-foreground text-lg leading-relaxed max-w-2xl mx-auto mb-6">
            Trois formules claires, toutes destinations. <strong>Pas de résultat = pas de prime de succès.</strong> Paiement exclusivement via M-Pesa, Airtel Money ou Orange Money.
          </p>
          <div className="inline-flex items-center gap-2 bg-green-50 border border-green-200 text-green-800 text-sm font-medium px-4 py-2 rounded-full">
            <CheckCircle2 className="w-4 h-4" />
            Paiement uniquement après résultat obtenu
          </div>
        </div>
      </section>

      {/* 3 FORMULES */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <h2 className="text-2xl font-bold text-primary text-center mb-8">Nos formules — toutes destinations</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Créneau */}
          <div className="bg-white border-2 border-secondary rounded-2xl p-6 shadow-sm flex flex-col">
            <div className="inline-flex items-center gap-1.5 bg-secondary/10 text-secondary text-xs font-bold px-3 py-1 rounded-full mb-4 self-start">
              <CheckCircle2 className="w-3.5 h-3.5" /> Créneau uniquement
            </div>
            <p className="text-4xl font-extrabold text-primary mb-1">350 $</p>
            <p className="text-sm text-green-700 font-semibold mb-4">Payé APRÈS obtention du créneau</p>
            <p className="text-sm text-muted-foreground mb-4">Votre dossier est déjà prêt ? Joventy surveille 24h/24 et verrouille votre créneau consulaire dès qu'une place se libère.</p>
            <ul className="space-y-1.5 text-xs text-slate-600 mb-6 flex-1">
              <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" /> Aucun acompte à l'avance</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" /> Paiement uniquement après créneau obtenu</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" /> USA, Schengen, Canada, UK, Espagne, Allemagne…</li>
            </ul>
            <Link href="/register">
              <Button className="w-full bg-secondary text-primary hover:bg-orange-500 font-bold">Demander un créneau</Button>
            </Link>
          </div>

          {/* Service complet */}
          <div className="bg-primary rounded-2xl p-6 shadow-lg flex flex-col text-white relative overflow-hidden">
            <div className="absolute top-3 right-3 bg-secondary text-primary text-[10px] font-extrabold px-2.5 py-1 rounded-full">RECOMMANDÉ</div>
            <div className="inline-flex items-center gap-1.5 bg-white/10 text-white text-xs font-bold px-3 py-1 rounded-full mb-4 self-start">
              Service complet
            </div>
            <p className="text-4xl font-extrabold mb-1">1 500 $</p>
            <p className="text-sm text-white/80 mb-4">500 $ à l'ouverture · 1 000 $ à l'obtention</p>
            <p className="text-sm text-white/80 mb-4">Joventy prend en charge l'intégralité du processus : formulaires officiels, constitution et vérification du dossier, profilage, créneau consulaire ou visa en ligne. Vous n'avez qu'à vous présenter le jour J.</p>
            <ul className="space-y-1.5 text-xs text-white/80 mb-6 flex-1">
              <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-secondary flex-shrink-0" /> Remplissage DS-160, formulaires Schengen, UKVI…</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-secondary flex-shrink-0" /> Préparation et vérification du dossier complet</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-secondary flex-shrink-0" /> Toutes destinations</li>
            </ul>
            <Link href="/register">
              <Button className="w-full bg-secondary text-primary hover:bg-orange-400 font-bold">Démarrer mon dossier</Button>
            </Link>
          </div>

          {/* Service partiel */}
          <div className="bg-white border-2 border-slate-200 rounded-2xl p-6 shadow-sm flex flex-col">
            <div className="inline-flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs font-bold px-3 py-1 rounded-full mb-4 self-start">
              Accompagnement partiel
            </div>
            <p className="text-4xl font-extrabold text-primary mb-1">200 $</p>
            <p className="text-sm text-muted-foreground mb-4">200 $ engagement · 400 $ prime de succès payée uniquement à l'obtention du visa · Total 600 $</p>
            <p className="text-sm text-muted-foreground mb-4">Vous fournissez vos documents ou la majorité. Joventy complète les pièces manquantes, constitue le profil et capture le créneau. Pour les visas consulaires, vous déposez vous-même à l'ambassade.</p>
            <ul className="space-y-1.5 text-xs text-slate-600 mb-6 flex-1">
              <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" /> Vous fournissez vos pièces, Joventy complète les manquantes</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" /> Profil consulaire et capture du créneau inclus</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" /> Toutes destinations — prime due uniquement à l'obtention</li>
            </ul>
            <Link href="/register">
              <Button variant="outline" className="w-full font-bold">Démarrer — Accompagnement partiel</Button>
            </Link>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-6 text-center italic">* Tous les prix sont en USD. Paiement exclusivement via M-Pesa, Airtel Money ou Orange Money.</p>
      </section>

      {/* CRÉNEAUX PAR DESTINATION */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 pb-4">
        <div className="bg-green-50 border border-green-200 rounded-2xl p-6">
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle2 className="w-5 h-5 text-green-600" />
            <h2 className="text-lg font-bold text-primary">Créneau consulaire — pages dédiées par destination</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Votre dossier est prêt et vous cherchez uniquement un rendez-vous ? Sélectionnez votre destination :
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { href: "/creneaux-visa-espagne-kinshasa", flag: "es", label: "Créneau Visa Espagne", sub: "Visa Schengen via ambassade d'Espagne" },
              { href: "/creneaux-visa-schengen-belgique-kinshasa", flag: "be", label: "Créneau Schengen — CEV Belgique", sub: "France, Belgique, Pays-Bas, Italie…" },
              { href: "/creneaux-visa-usa-kinshasa", flag: "us", label: "Créneau Visa USA", sub: "B1/B2 Tourisme · F1 Études" },
              { href: "/creneaux-visa-allemagne-kinshasa", flag: "de", label: "Créneau Long Séjour Allemagne", sub: "Études, travail, regroupement familial" },
            ].map((item) => (
              <Link key={item.href} href={item.href}>
                <div className="group flex items-center gap-3 bg-white border border-green-200 hover:border-secondary rounded-xl px-4 py-3 transition-all hover:shadow-sm cursor-pointer">
                  <img src={`https://flagcdn.com/w40/${item.flag}.png`} width={24} alt="" className="rounded-sm flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-primary text-sm group-hover:text-secondary transition-colors">{item.label}</p>
                    <p className="text-xs text-muted-foreground">{item.sub}</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-secondary flex-shrink-0 transition-colors" />
                </div>
              </Link>
            ))}
          </div>
          <p className="text-xs text-green-700 font-medium mt-4 text-center">
            Toutes ces pages · 350 $ payés uniquement après obtention du créneau · 0 $ d'acompte
          </p>
        </div>
      </section>

      {/* TABLE DES DESTINATIONS */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6 pb-12">
        <h2 className="text-xl font-bold text-primary mb-4">Destinations couvertes</h2>
        <p className="text-sm text-muted-foreground mb-6">Les tarifs Joventy sont identiques pour toutes les destinations. Les frais gouvernementaux ou consulaires restent à votre charge et sont payés directement aux organismes concernés.</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-muted border-b-2 border-primary/20">
                <th className="text-left px-4 py-3 font-bold text-primary">Destination</th>
                <th className="text-left px-4 py-3 font-bold text-primary hidden sm:table-cell">Types de visa</th>
                <th className="text-center px-4 py-3 font-bold text-primary hidden lg:table-cell">Délai estimé</th>
              </tr>
            </thead>
            <tbody>
              {DESTINATIONS.map((p) => (
                <tr key={p.code} className="border-b border-border hover:bg-muted/50 transition-colors">
                  <td className="px-4 py-4">
                    <Link href={p.href} className="flex items-center gap-2 hover:text-primary transition-colors">
                      <FlagImg code={p.code} size={24} />
                      <span className="font-semibold text-slate-800">{p.name}</span>
                    </Link>
                    {p.alert && <p className="text-[10px] text-red-600 font-medium mt-1">{p.alert}</p>}
                    {p.note && <p className="text-[10px] text-blue-700 mt-1 leading-relaxed">{p.note}</p>}
                  </td>
                  <td className="px-4 py-4 text-xs text-muted-foreground hidden sm:table-cell">{p.types}</td>
                  <td className="px-4 py-4 text-xs text-center text-muted-foreground hidden lg:table-cell">{p.delay}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* TRANSIT EBOLA */}
      <section className="bg-red-50 border-y border-red-200 py-10 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-3 mb-4">
            <AlertTriangle className="w-6 h-6 text-red-600" />
            <h2 className="text-xl font-bold text-primary">Transit 21 jours (Ebola 2026) — Visa urgent</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-5">
            Pour les personnes devant purger 21 jours dans un pays neutre avant d'entrer aux USA, au Canada ou au Mexique. Joventy obtient votre visa de transit en 24-72h.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { flag: "ma", name: "Maroc", delay: "24-72h" },
              { flag: "eg", name: "Égypte", delay: "24-72h" },
              { flag: "ae", name: "Dubaï (EAU)", delay: "48-72h" },
            ].map((t) => (
              <div key={t.flag} className="bg-white border border-red-200 rounded-xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <FlagImg code={t.flag} size={24} />
                  <span className="font-bold text-primary">{t.name}</span>
                </div>
                <p className="text-xs text-muted-foreground">Joventy : <span className="font-bold text-primary">voir formules ci-dessus</span></p>
                <p className="text-xs text-muted-foreground">Délai : {t.delay}</p>
              </div>
            ))}
          </div>
          <div className="mt-5">
            <Link href="/guides/purger-21-jours-ebola-pays-neutre-visa-usa-2026">
              <Button variant="outline" size="sm" className="border-red-300 text-red-700 hover:bg-red-100 font-semibold">
                Lire le guide complet — Purger 21 jours <ChevronRight className="ml-1 w-3 h-3" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* CE QUI EST INCLUS / NON INCLUS */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        <h2 className="text-2xl font-bold text-primary text-center mb-10">Ce qui est inclus dans les tarifs Joventy</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="bg-green-50 border border-green-200 rounded-2xl p-6">
            <h3 className="font-bold text-green-800 mb-4 flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5" /> Inclus dans les frais Joventy
            </h3>
            <ul className="space-y-2.5">
              {INCLUDES.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-green-900">
                  <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6">
            <h3 className="font-bold text-slate-700 mb-4 flex items-center gap-2">
              <HelpCircle className="w-5 h-5" /> Non inclus (à votre charge)
            </h3>
            <ul className="space-y-2.5">
              {NOT_INCLUDES.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-slate-600">
                  <span className="w-4 h-4 flex items-center justify-center flex-shrink-0 mt-0.5 text-slate-400">—</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* PAIEMENT */}
      <section className="bg-muted py-12 px-4">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-2xl font-bold text-primary mb-4">Moyens de paiement acceptés</h2>
          <p className="text-muted-foreground mb-6">Joventy accepte exclusivement les paiements Mobile Money. Aucune carte bancaire internationale requise.</p>
          <div className="flex flex-wrap justify-center gap-4">
            {["M-Pesa (Vodacom)", "Airtel Money", "Orange Money"].map((m) => (
              <div key={m} className="bg-white border border-border rounded-xl px-5 py-3 text-sm font-semibold text-primary shadow-sm">{m}</div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-primary py-14 px-4">
        <div className="max-w-2xl mx-auto text-center text-white">
          <h2 className="text-2xl font-bold mb-3">Prêt à démarrer ?</h2>
          <p className="text-white/70 mb-8">Créez votre dossier en 5 minutes ou contactez-nous sur WhatsApp pour une question sur les tarifs.</p>
          <div className="flex flex-col sm:flex-row justify-center gap-4">
            <Link href="/register">
              <Button size="lg" className="bg-secondary hover:bg-secondary/90 text-white font-bold">
                Créer mon dossier <ArrowRight className="ml-2 w-4 h-4" />
              </Button>
            </Link>
            <a href="https://wa.me/243840808122" target="_blank" rel="noopener noreferrer">
              <Button size="lg" variant="outline" className="border-white/30 text-white hover:bg-white/10 font-semibold">
                <MessageCircle className="mr-2 w-4 h-4" /> WhatsApp
              </Button>
            </a>
          </div>
        </div>
      </section>

    </PublicLayout>
  );
}
