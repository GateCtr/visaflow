import { Link, useLocation } from "wouter";
import { Helmet } from "react-helmet-async";
import {
  ArrowRight, CheckCircle2, Clock, FileText, HelpCircle,
  MessageCircle, Star, ChevronRight, BadgeCheck, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { JoventyLogo } from "@/components/JoventyLogo";
import { getDestinationBySlug, DESTINATIONS_SEO } from "@/data/destinations-seo";

const FLAG_SIZES = [20, 40, 80, 160, 320, 640];
function snapFlagSize(n: number) {
  return FLAG_SIZES.find((s) => s >= n) ?? 80;
}
const FLAG_NAMES: Record<string, string> = {
  us: "États-Unis", ca: "Canada", gb: "Royaume-Uni", eu: "Europe Schengen",
  es: "Espagne", ch: "Suisse", ae: "Émirats Arabes Unis (Dubaï)", tr: "Turquie",
  in: "Inde", ma: "Maroc", eg: "Égypte", cn: "Chine", cd: "République Démocratique du Congo",
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

export default function DestinationPage() {
  const [location] = useLocation();
  const slug = location.replace(/^\//, "").split("?")[0];
  const dest = getDestinationBySlug(slug);

  if (!dest) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 gap-6 px-4">
        <Helmet>
          <title>Destination introuvable — Joventy</title>
          <meta name="robots" content="noindex" />
        </Helmet>
        <JoventyLogo variant="light" size="md" href="/" />
        <p className="text-xl font-bold text-primary">Destination introuvable</p>
        <Link href="/">
          <Button>Retour à l'accueil</Button>
        </Link>
      </div>
    );
  }

  const relatedDests = DESTINATIONS_SEO.filter((d) => dest.relatedSlugs.includes(d.slug));

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: dest.faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: { "@type": "Answer", text: faq.a },
    })),
  };

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Accueil", item: "https://joventy.cd/" },
      { "@type": "ListItem", position: 2, name: dest.name, item: `https://joventy.cd/${dest.slug}` },
    ],
  };

  const serviceSchema = {
    "@context": "https://schema.org",
    "@type": "Service",
    "name": `Assistance Visa ${dest.name} depuis Kinshasa`,
    "description": dest.metaDescription,
    "@id": `https://joventy.cd/${dest.slug}`,
    "provider": {
      "@type": "Organization",
      "name": "Joventy",
      "url": "https://joventy.cd",
      "telephone": "+243 840 808 122",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "Kinshasa",
        "addressCountry": "CD",
      },
    },
    "areaServed": {
      "@type": "Place",
      "name": "Kinshasa, République Démocratique du Congo",
    },
    "serviceType": "Assistance visa",
    "offers": {
      "@type": "Offer",
      "priceCurrency": "USD",
      "price": dest.engagement,
      "description": `Frais d'engagement (prime de succès ${dest.success} USD due uniquement en cas de résultat)`,
    },
    "aggregateRating": {
      "@type": "AggregateRating",
      "ratingValue": "4.9",
      "bestRating": "5",
      "worstRating": "1",
      "reviewCount": "127",
    },
  };

  return (
    <div className="min-h-screen bg-white font-sans">
      <Helmet>
        <title>{dest.title}</title>
        <meta name="description" content={dest.metaDescription} />
        <link rel="canonical" href={`https://joventy.cd/${dest.slug}`} />
        <meta property="og:title" content={dest.title} />
        <meta property="og:description" content={dest.metaDescription} />
        <meta property="og:url" content={`https://joventy.cd/${dest.slug}`} />
        <meta property="og:type" content="website" />
        <meta property="og:image" content="https://joventy.cd/opengraph.jpg" />
        <meta property="og:locale" content="fr_CD" />
        <meta property="og:site_name" content="Joventy" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={dest.title} />
        <meta name="twitter:description" content={dest.metaDescription} />
        <meta name="twitter:site" content="@JoventyCD" />
        <script type="application/ld+json">{JSON.stringify(faqSchema)}</script>
        <script type="application/ld+json">{JSON.stringify(breadcrumbSchema)}</script>
        <script type="application/ld+json">{JSON.stringify(serviceSchema)}</script>
      </Helmet>

      {/* ── NAV ── */}
      <header className="bg-white border-b border-border sticky top-0 z-50 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <Link href="/">
            <JoventyLogo variant="light" size="sm" />
          </Link>
          <nav className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
            <Link href="/" className="hover:text-primary transition-colors">Accueil</Link>
            <ChevronRight className="w-3 h-3" />
            <span className="text-primary font-semibold">Visa {dest.nameShort}</span>
          </nav>
          <Link href="/register">
            <Button size="sm" className="bg-secondary hover:bg-secondary/90 text-white font-semibold">
              Commencer <ArrowRight className="ml-1.5 w-3.5 h-3.5" />
            </Button>
          </Link>
        </div>
      </header>

      {/* ── HERO ── */}
      <section className="bg-gradient-to-br from-primary via-primary/95 to-primary/80 text-white py-16 sm:py-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="flex items-center gap-3 mb-6">
            <FlagImg code={dest.flagCode} size={48} className="shadow-md rounded" />
            <div>
              <p className="text-white/60 text-xs font-semibold uppercase tracking-widest">Assistance Visa · Kinshasa, RDC</p>
              <p className="text-secondary font-bold text-sm">{dest.name}</p>
            </div>
          </div>

          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold leading-tight mb-4 max-w-3xl text-white">
            {dest.h1}
          </h1>

          <div className="flex flex-wrap gap-2 mb-6">
            <span className="inline-flex items-center gap-1.5 bg-white/15 border border-white/20 text-white text-xs font-semibold px-3 py-1.5 rounded-full">
              <span className="w-1.5 h-1.5 bg-secondary rounded-full flex-shrink-0" />
              100% en ligne — aucun bureau à visiter
            </span>
            <span className="inline-flex items-center gap-1.5 bg-white/15 border border-white/20 text-white text-xs font-semibold px-3 py-1.5 rounded-full">
              <span className="w-1.5 h-1.5 bg-green-400 rounded-full flex-shrink-0" />
              M-Pesa · Airtel · Orange Money
            </span>
            <span className="inline-flex items-center gap-1.5 bg-white/15 border border-white/20 text-white text-xs font-semibold px-3 py-1.5 rounded-full">
              <span className="w-1.5 h-1.5 bg-amber-400 rounded-full flex-shrink-0" />
              Paiement au résultat uniquement
            </span>
          </div>

          <p className="text-white/75 text-lg max-w-2xl leading-relaxed mb-8">{dest.intro}</p>

          <div className="flex flex-wrap gap-4">
            <Link href="/register">
              <Button size="lg" className="h-12 px-7 bg-secondary hover:bg-secondary/90 text-white font-bold shadow-xl rounded-xl">
                Créer mon dossier <ArrowRight className="ml-2 w-4 h-4" />
              </Button>
            </Link>
            <a href="https://wa.me/243840808122" target="_blank" rel="noopener noreferrer">
              <Button size="lg" variant="outline" className="h-12 px-7 border-white/30 text-white hover:bg-white/10 font-semibold rounded-xl">
                <MessageCircle className="mr-2 w-4 h-4" /> WhatsApp
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* ── PRICING BANNER ── */}
      <section className="bg-amber-50 border-b border-amber-200 py-5">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap gap-6">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center flex-shrink-0">
                <FileText className="w-4 h-4 text-white" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Frais d'engagement</p>
                <p className="font-bold text-primary text-sm">{dest.engagement} USD</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-secondary rounded-lg flex items-center justify-center flex-shrink-0">
                <BadgeCheck className="w-4 h-4 text-white" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Prime de succès</p>
                <p className="font-bold text-secondary text-sm">{dest.success} USD</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center flex-shrink-0">
                <Clock className="w-4 h-4 text-white" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Délai moyen</p>
                <p className="font-bold text-green-700 text-sm">{dest.processingTime}</p>
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground max-w-xs">{dest.externalFees}</p>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 space-y-20">

        {/* ── VISA TYPES ── */}
        <section>
          <h2 className="text-2xl md:text-3xl font-bold text-primary mb-2">
            Types de visa {dest.nameShort} disponibles
          </h2>
          <p className="text-muted-foreground mb-8">Joventy gère tous les types de visa pour {dest.name} depuis Kinshasa.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {dest.visaTypes.map((vt) => (
              <div key={vt.name} className="bg-muted border border-border rounded-2xl p-5 flex gap-4">
                <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
                  <FileText className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <p className="font-bold text-primary text-sm mb-1">{vt.name}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{vt.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── HOW IT WORKS ── */}
        <section>
          <h2 className="text-2xl md:text-3xl font-bold text-primary mb-2">
            Comment obtenir votre visa {dest.nameShort} avec Joventy
          </h2>
          <p className="text-muted-foreground mb-8">Un processus simple en {dest.steps.length} étapes, 100% Mobile Money.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {dest.steps.map((step, i) => (
              <div key={step.title} className="flex gap-4 bg-white border border-border rounded-2xl p-5 shadow-sm">
                <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center flex-shrink-0 font-bold text-white text-sm">
                  {i + 1}
                </div>
                <div>
                  <p className="font-bold text-primary mb-1">{step.title}</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── REQUIREMENTS ── */}
        <section className="bg-muted rounded-3xl p-8 sm:p-10">
          <h2 className="text-2xl md:text-3xl font-bold text-primary mb-2">
            Documents requis — Visa {dest.nameShort}
          </h2>
          <p className="text-muted-foreground mb-7">Joventy vérifie chaque pièce et vous signale les documents manquants avant soumission.</p>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {dest.requirements.map((req) => (
              <li key={req} className="flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                <span className="text-sm text-slate-700 leading-relaxed">{req}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* ── WHY JOVENTY ── */}
        <section>
          <h2 className="text-2xl md:text-3xl font-bold text-primary mb-2">
            Pourquoi choisir Joventy pour votre visa {dest.nameShort} ?
          </h2>
          <p className="text-muted-foreground mb-8">Les avantages qui font la différence depuis Kinshasa.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {[
              { icon: Zap, title: "Surveillance 24h/24", desc: "Nos systèmes capturent les créneaux ou soumettent les e-Visas dès que possible, sans que vous ayez à surveiller manuellement." },
              { icon: BadgeCheck, title: "Paiement au résultat", desc: "La prime de succès n'est due qu'une fois le résultat obtenu. Aucun résultat = aucun solde. Zéro risque pour vous." },
              { icon: Star, title: "Mobile Money uniquement", desc: "Payez via M-Pesa, Airtel Money ou Orange Money. Aucun virement international, aucune carte étrangère requise." },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.title} className="bg-white border border-border rounded-2xl p-6 shadow-sm">
                  <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center mb-4">
                    <Icon className="w-5 h-5 text-primary" />
                  </div>
                  <p className="font-bold text-primary mb-2">{item.title}</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="bg-primary rounded-3xl p-8 sm:p-12 text-center text-white">
          <FlagImg code={dest.flagCode} size={64} className="mx-auto mb-5 shadow-lg rounded-xl" />
          <h2 className="text-2xl sm:text-3xl font-bold mb-3">
            Prêt pour votre visa {dest.nameShort} ?
          </h2>
          <p className="text-white/70 text-base mb-8 max-w-lg mx-auto leading-relaxed">
            Créez votre dossier en 5 minutes et payez via M-Pesa. Joventy s'occupe du reste. Vous ne payez la prime de succès que si ça marche.
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link href="/register">
              <Button size="lg" className="h-13 px-8 text-base bg-secondary hover:bg-secondary/90 text-white font-bold shadow-xl rounded-xl">
                Créer mon dossier — {dest.engagement} USD <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </Link>
            <a href="https://wa.me/243840808122" target="_blank" rel="noopener noreferrer">
              <Button size="lg" variant="outline" className="h-13 px-8 text-base border-white/30 text-white hover:bg-white/10 font-bold rounded-xl">
                <MessageCircle className="mr-2 w-5 h-5" /> Question ? WhatsApp
              </Button>
            </a>
          </div>
        </section>

        {/* ── FAQ ── */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <HelpCircle className="w-5 h-5 text-secondary" />
            <p className="text-secondary font-semibold text-sm uppercase tracking-widest">FAQ</p>
          </div>
          <h2 className="text-2xl md:text-3xl font-bold text-primary mb-8">
            Questions fréquentes — Visa {dest.nameShort} depuis Kinshasa
          </h2>
          <div className="space-y-4">
            {dest.faqs.map((faq) => (
              <div key={faq.q} className="bg-muted border border-border rounded-2xl p-6">
                <h3 className="font-bold text-primary mb-3 flex items-start gap-3">
                  <span className="w-6 h-6 rounded-full bg-secondary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-secondary text-xs font-bold">?</span>
                  </span>
                  {faq.q}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed pl-9">{faq.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── RELATED DESTINATIONS ── */}
        {relatedDests.length > 0 && (
          <section>
            <h2 className="text-2xl font-bold text-primary mb-6">
              Autres destinations depuis Kinshasa
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {relatedDests.map((rd) => (
                <Link key={rd.slug} href={`/${rd.slug}`}>
                  <div className="bg-muted border border-border rounded-2xl p-5 hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer flex items-center gap-4">
                    <FlagImg code={rd.flagCode} size={40} />
                    <div>
                      <p className="font-bold text-primary text-sm">{rd.name}</p>
                      <p className="text-xs text-muted-foreground">À partir de {rd.engagement} USD</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted-foreground ml-auto" />
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* ── FOOTER ── */}
      <footer className="bg-primary text-white py-10 mt-8">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row justify-between items-center gap-4 text-sm">
          <Link href="/">
            <JoventyLogo variant="dark" size="sm" />
          </Link>
          <p className="text-white/40 text-xs text-center">
            © {new Date().getFullYear()} Joventy · Assistance visa premium · Kinshasa, RDC
          </p>
          <div className="flex gap-4 text-white/40 text-xs">
            <Link href="/mentions-legales" className="hover:text-white transition-colors">Mentions légales</Link>
            <Link href="/conditions" className="hover:text-white transition-colors">CGU</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
