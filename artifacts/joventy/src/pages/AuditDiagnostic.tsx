import { Link } from "wouter";
import { Helmet } from "react-helmet-async";
import {
  ArrowRight, CheckCircle2, MessageCircle, ChevronRight, AlertTriangle,
  ShieldCheck, FileSearch, Mic, Landmark, ClipboardList, Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { WhatsAppAuditCTA } from "@/components/WhatsAppAuditCTA";
import { PublicLayout } from "@/components/layout/PublicLayout";

const RISKS = [
  {
    icon: Landmark,
    title: "Dépôts d'argent suspects",
    desc: "Un versement massif ou de dernière minute sur votre compte bancaire est le motif de refus le plus fréquent — l'agent consulaire y voit une preuve fabriquée de ressources.",
  },
  {
    icon: ClipboardList,
    title: "Pièces manquantes ou incohérentes",
    desc: "Fiches de paie qui ne concordent pas, dates de voyage en décalage avec vos réservations, documents obligatoires oubliés.",
  },
  {
    icon: FileSearch,
    title: "Formulaire mal rempli ou incohérent",
    desc: "DS-160, formulaire Schengen, IMM Canada : nom mal orthographié, historique de voyage incomplet, dates ou emploi qui ne correspondent pas aux pièces jointes — la première chose que vérifie l'agent consulaire.",
  },
  {
    icon: AlertTriangle,
    title: "Risque de non-retour perçu",
    desc: "Attaches insuffisantes en RDC (emploi, famille, biens) : le motif numéro un des refus Schengen et Canada.",
  },
];

const CHECKLIST_INCLUDES = [
  "Vérification visuelle de toutes les pièces obligatoires exigées par le consulat, le CEV ou l'ambassade",
  "Contrôle des validités techniques : dates du passeport, conformité des photos, validité de l'assurance voyage Schengen",
  "Vérification de la concordance des dates logistiques (vol et hôtel)",
  "Relecture du formulaire (DS-160, Schengen, IMM) pour repérer les erreurs de saisie évidentes avant soumission",
  "Livrable : validation ou alerte rapide envoyée par texte sur WhatsApp",
];

const PROFILAGE_INCLUDES = [
  "L'intégralité de la formule Check-list",
  "Audit de fond des documents financiers : dépôts massifs ou suspects de dernière minute",
  "Évaluation du risque de refus lié à vos attaches en RDC (travail, famille, biens)",
  "Contrôle approfondi de la cohérence du formulaire avec l'ensemble du dossier : identité, historique de voyage, emploi, dates",
  "Aide à l'optimisation et à la cohérence de votre lettre explicative ou de motivation",
  "Livrable : débriefing complet et personnalisé sous 48h par note vocale WhatsApp, avec échanges pour répondre à vos questions",
];

export default function AuditDiagnostic() {
  const serviceSchema = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "Audit & Diagnostic de dossier de visa — Joventy",
    description:
      "Analyse et diagnostic de dossier de visa (Schengen, Canada, Dubaï...) depuis Kinshasa avant votre rendez-vous consulaire. Vérification des pièces, du formulaire, audit des flux financiers, cohérence des attaches en RDC.",
    provider: { "@type": "Organization", name: "Joventy" },
    areaServed: "CD",
    offers: [
      {
        "@type": "Offer",
        name: "Formule Check-list",
        price: "25",
        priceCurrency: "USD",
      },
      {
        "@type": "Offer",
        name: "Formule Profilage & Cohérence",
        price: "70",
        priceCurrency: "USD",
      },
    ],
  };

  return (
    <PublicLayout solidNav>
      <Helmet>
        <title>Audit & Diagnostic de Dossier Visa — Sécurisez votre demande | Joventy</title>
        <meta
          name="description"
          content="Faites analyser votre dossier de visa (Schengen, Canada, Dubaï...) par un expert avant votre rendez-vous au CEV. Diagnostic par WhatsApp sous 48h, à partir de 25$."
        />
        <link rel="canonical" href="https://joventy.cd/audit-diagnostic" />
        <meta property="og:title" content="Audit & Diagnostic de Dossier Visa — Joventy" />
        <meta
          property="og:description"
          content="Sécurisez votre demande de visa : diagnostic expert de votre dossier avant dépôt, par WhatsApp, à partir de 25$."
        />
        <meta property="og:url" content="https://joventy.cd/audit-diagnostic" />
        <meta property="og:type" content="website" />
        <meta property="og:image" content="https://joventy.cd/opengraph.jpg" />
        <meta property="og:locale" content="fr_CD" />
        <meta property="og:site_name" content="Joventy" />
        <meta name="twitter:card" content="summary_large_image" />
        <script type="application/ld+json">{JSON.stringify(serviceSchema)}</script>
      </Helmet>

      {/* HERO */}
      <section className="bg-gradient-to-b from-red-50 to-white py-16 px-4">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-red-100 border border-red-200 text-red-800 text-xs font-semibold px-4 py-1.5 rounded-full mb-5">
            <AlertTriangle className="w-3.5 h-3.5" />
            Les frais consulaires ne sont jamais remboursés en cas de refus
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-primary mb-4">
            Audit & Diagnostic de votre dossier de visa
          </h1>
          <p className="text-muted-foreground text-lg leading-relaxed max-w-2xl mx-auto mb-8">
            Avant de déposer votre demande (Schengen, Canada, Dubaï...), faites analyser votre profil et vos documents par un expert. Verdict clair sous 48h, directement sur WhatsApp.
          </p>
          <div className="flex flex-col sm:flex-row justify-center gap-3">
            <WhatsAppAuditCTA size="lg" />
            <a href="#tarifs">
              <Button size="lg" variant="outline" className="border-primary/20 text-primary font-semibold">
                Voir les tarifs
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* RISQUES */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 py-14">
        <h2 className="text-2xl font-bold text-primary text-center mb-3">
          Ce qui fait basculer un dossier vers le refus
        </h2>
        <p className="text-muted-foreground text-center max-w-2xl mx-auto mb-10">
          Les demandeurs de visa depuis Kinshasa subissent des taux de refus massifs — souvent pour des erreurs évitables.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {RISKS.map((r) => (
            <div key={r.title} className="bg-red-50 border border-red-200 rounded-2xl p-6">
              <r.icon className="w-8 h-8 text-red-600 mb-4" />
              <h3 className="font-bold text-red-900 mb-2">{r.title}</h3>
              <p className="text-sm text-red-800/80 leading-relaxed">{r.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* COMMENT CA MARCHE */}
      <section className="bg-muted py-14 px-4">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold text-primary text-center mb-10">Comment ça marche</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {[
              { icon: FileSearch, step: "1", title: "Profilage & diagnostic", desc: "Nous analysons votre situation globale (âge, profession, attaches en RDC) pour identifier ce qui va faire tiquer l'agent consulaire." },
              { icon: ShieldCheck, step: "2", title: "Audit approfondi des pièces", desc: "Nous passons au crible vos documents administratifs et financiers pour traquer les erreurs fatales." },
              { icon: Mic, step: "3", title: "Feuille de route corrective", desc: "Vous recevez sous 48h un verdict clair, par note vocale WhatsApp, avec les corrections exactes à apporter." },
            ].map((s) => (
              <div key={s.step} className="bg-white border border-border rounded-2xl p-6 text-center">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                  <s.icon className="w-6 h-6 text-primary" />
                </div>
                <p className="text-xs font-bold text-secondary mb-1">Étape {s.step}</p>
                <h3 className="font-bold text-primary mb-2">{s.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* TARIFS */}
      <section id="tarifs" className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        <h2 className="text-2xl font-bold text-primary text-center mb-3">Deux formules, un objectif : sécuriser votre dossier</h2>
        <p className="text-muted-foreground text-center max-w-2xl mx-auto mb-10">
          Paiement via M-Pesa, Airtel Money ou Orange Money. Résultat envoyé directement sur WhatsApp.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* CHECK-LIST */}
          <div className="bg-white border-2 border-border rounded-2xl p-7 flex flex-col">
            <h3 className="font-bold text-primary text-lg mb-1">Formule Check-list</h3>
            <p className="text-sm text-muted-foreground mb-4">La vérification administrative</p>
            <p className="text-4xl font-bold text-primary mb-5">
              25 $ <span className="text-sm font-normal text-muted-foreground">/ dossier</span>
            </p>
            <ul className="space-y-3 mb-6 flex-1">
              {CHECKLIST_INCLUDES.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-slate-700">
                  <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <WhatsAppAuditCTA
              variant="outline"
              label="Commander la Check-list — 25 $"
              message="Bonjour Joventy, je souhaite commander la formule Check-list (25$) pour vérifier mon dossier de visa avant dépôt."
              className="w-full"
            />
          </div>

          {/* PROFILAGE */}
          <div className="relative bg-primary text-white rounded-2xl p-7 flex flex-col shadow-xl shadow-primary/20">
            <div className="absolute -top-3 right-6 bg-secondary text-primary text-xs font-bold px-3 py-1 rounded-full">
              Le plus complet
            </div>
            <h3 className="font-bold text-lg mb-1">Formule Profilage & Cohérence</h3>
            <p className="text-sm text-white/70 mb-4">L'analyse stratégique complète</p>
            <p className="text-4xl font-bold mb-5">
              70 $ <span className="text-sm font-normal text-white/70">/ dossier</span>
            </p>
            <ul className="space-y-3 mb-6 flex-1">
              {PROFILAGE_INCLUDES.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-white/90">
                  <CheckCircle2 className="w-4 h-4 text-secondary flex-shrink-0 mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <WhatsAppAuditCTA
              label="Commander le Profilage & Cohérence — 70 $"
              message="Bonjour Joventy, je souhaite commander la formule Profilage & Cohérence (70$) pour l'analyse complète de mon dossier de visa."
              className="w-full"
            />
          </div>
        </div>
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground mt-8">
          <Clock className="w-3.5 h-3.5" />
          Résultat livré sous 48h, généralement par note vocale WhatsApp.
        </div>
      </section>

      {/* GUIDES LIÉS — maillage interne */}
      <section className="bg-muted py-14 px-4">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-xl font-bold text-primary text-center mb-2">Pour aller plus loin</h2>
          <p className="text-muted-foreground text-center text-sm mb-8">
            Les erreurs les plus fréquentes, expliquées en détail dans nos guides.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { slug: "motifs-refus-visa-schengen-kinshasa", label: "Les 5 motifs de refus visa Schengen" },
              { slug: "erreurs-releves-bancaires-depot-suspect-visa", label: "Dépôt suspect sur relevé bancaire" },
              { slug: "formulaire-visa-mal-rempli-erreurs-refus", label: "Formulaire mal rempli : erreurs fréquentes" },
              { slug: "justifier-attaches-rdc-consulat-visa", label: "Justifier ses attaches en RDC" },
              { slug: "que-faire-apres-refus-visa-kinshasa-recours", label: "Que faire après un refus de visa" },
              { slug: "erreurs-fatales-portail-ircc-refus-congo", label: "Erreurs fatales sur le portail IRCC" },
              { slug: "lettre-motivation-visa-schengen-kinshasa-refus", label: "Bien rédiger sa lettre de motivation" },
            ].map((g) => (
              <Link key={g.slug} href={`/guides/${g.slug}`} className="group block">
                <div className="bg-white border border-border rounded-xl p-4 hover:shadow-md hover:border-primary/20 transition-all h-full flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-700 group-hover:text-primary transition-colors">{g.label}</span>
                  <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* CTA FINAL */}
      <section className="bg-primary py-14 px-4">
        <div className="max-w-2xl mx-auto text-center text-white">
          <h2 className="text-2xl font-bold mb-3">Ne perdez pas vos frais consulaires</h2>
          <p className="text-white/70 mb-8">
            Un dossier mal préparé coûte cher : frais non remboursés, mois perdus. Faites-le vérifier avant de déposer.
          </p>
          <div className="flex flex-col sm:flex-row justify-center gap-4">
            <WhatsAppAuditCTA size="lg" />
            <a href="https://wa.me/243840808122" target="_blank" rel="noopener noreferrer">
              <Button size="lg" variant="outline" className="border-white/30 text-white hover:bg-white/10 font-semibold">
                <MessageCircle className="mr-2 w-4 h-4" /> Une question ?
              </Button>
            </a>
          </div>
        </div>
      </section>

    </PublicLayout>
  );
}
