import { useState } from "react";
import { Link } from "wouter";
import { Helmet } from "react-helmet-async";
import { Navbar } from "@/components/layout/Navbar";
import { PublicFooter } from "@/components/layout/PublicFooter";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  ChevronRight,
  ArrowRight,
  AlertTriangle,
  MessageCircle,
  Zap,
  Shield,
  Clock,
} from "lucide-react";
import type { CreneauxSEO } from "@/data/creneaux-seo";

interface Props {
  data: CreneauxSEO;
}

const SITE = "https://joventy.cd";

function buildSchemas(data: CreneauxSEO) {
  const url = `${SITE}/${data.slug}`;
  const service = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: `Créneau Visa ${data.name} depuis Kinshasa`,
    description: data.metaDescription,
    url,
    provider: {
      "@type": "LocalBusiness",
      name: "Joventy",
      url: SITE,
      telephone: "+243840808122",
      address: { "@type": "PostalAddress", addressLocality: "Kinshasa", addressCountry: "CD" },
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: "4.9",
        bestRating: "5",
        worstRating: "1",
        reviewCount: "127",
      },
    },
    areaServed: { "@type": "Place", name: "Kinshasa, République Démocratique du Congo" },
    offers: {
      "@type": "Offer",
      priceCurrency: "USD",
      price: "350",
      priceSpecification: {
        "@type": "PriceSpecification",
        description: "Payé uniquement après obtention du créneau — aucun acompte",
      },
    },
  };
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: data.faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Accueil", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Tarifs", item: `${SITE}/prix` },
      { "@type": "ListItem", position: 3, name: `Créneau ${data.name}`, item: url },
    ],
  };
  return [service, faqSchema, breadcrumb].map((s) => JSON.stringify(s));
}

function FlagImg({ code, size = 32, className = "" }: { code: string; size?: number; className?: string }) {
  const sizes = [20, 40, 80, 160];
  const snapped = sizes.find((s) => s >= size) ?? 80;
  return (
    <img
      src={`https://flagcdn.com/w${snapped}/${code.toLowerCase()}.png`}
      width={snapped}
      alt={`Drapeau ${code.toUpperCase()}`}
      className={`rounded-sm object-cover flex-shrink-0 ${className}`}
    />
  );
}

export function CreneauxLanding({ data }: Props) {
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const url = `${SITE}/${data.slug}`;
  const schemas = buildSchemas(data);

  return (
    <div className="min-h-screen bg-white">
      <Helmet>
        <title>{data.title}</title>
        <meta name="description" content={data.metaDescription} />
        <link rel="canonical" href={url} />
        <meta property="og:title" content={data.title} />
        <meta property="og:description" content={data.metaDescription} />
        <meta property="og:url" content={url} />
        <meta property="og:type" content="website" />
        <meta property="og:image" content={`${SITE}/opengraph.jpg`} />
        <meta property="og:locale" content="fr_CD" />
        <meta property="og:site_name" content="Joventy" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={data.title} />
        <meta name="twitter:description" content={data.metaDescription} />
        <meta name="twitter:image" content={`${SITE}/opengraph.jpg`} />
        <meta name="twitter:site" content="@JoventyCD" />
        {schemas.map((s, i) => (
          <script key={i} type="application/ld+json">{s}</script>
        ))}
      </Helmet>

      <Navbar />

      {/* ═══════════════════════════════════ HERO ═══ */}
      <section className="relative bg-gradient-to-br from-[#0a1f44] via-[#1d3a6b] to-[#0f2d5c] pt-36 pb-24 px-4 overflow-hidden">
        <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "radial-gradient(circle at 25% 25%, white 1px, transparent 1px), radial-gradient(circle at 75% 75%, white 1px, transparent 1px)", backgroundSize: "48px 48px" }} />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-secondary/20 rounded-full blur-3xl" />

        <div className="relative max-w-4xl mx-auto">
          {/* Badge destination */}
          <div className="flex justify-center mb-6">
            <div className="inline-flex items-center gap-3 bg-white/10 border border-white/20 text-white text-sm font-semibold px-5 py-2.5 rounded-full">
              <FlagImg code={data.flagCode} size={20} className="h-4 w-auto" />
              Créneau {data.name} · Kinshasa, RDC
            </div>
          </div>

          <h1 className="text-3xl md:text-4xl lg:text-5xl font-black text-white leading-[1.1] tracking-tight mb-6 text-center">
            {data.h1}
          </h1>

          <p className="text-lg text-blue-200 leading-relaxed mb-8 max-w-2xl mx-auto text-center">
            {data.accroche}
          </p>

          {/* Price hero card */}
          <div className="max-w-xl mx-auto bg-white/10 border border-white/20 backdrop-blur-sm rounded-2xl p-6 mb-8">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-5xl font-black text-white">350 <span className="text-3xl">$</span></p>
                <p className="text-green-300 font-bold text-sm mt-1">Payés UNIQUEMENT après obtention du créneau</p>
              </div>
              <div className="text-right">
                <p className="text-white/60 text-sm">Acompte</p>
                <p className="text-3xl font-black text-white">0 $</p>
                <p className="text-white/60 text-xs">aucun paiement à l'avance</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-5">
              {[
                "Aucun acompte requis",
                "Paiement M-Pesa accepté",
                "Surveillance active 24h/24, 7j/7",
                "Notification WhatsApp immédiate",
              ].map((item) => (
                <div key={item} className="flex items-center gap-2 text-white/80 text-xs">
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  {item}
                </div>
              ))}
            </div>
            <Link href="/dashboard/applications/new/creneau">
              <button className="w-full inline-flex items-center justify-center gap-3 bg-secondary hover:bg-secondary/90 text-white font-black text-lg px-8 py-4 rounded-xl shadow-2xl shadow-secondary/30 transition-all hover:scale-105 active:scale-100">
                Obtenir mon créneau
                <ChevronRight className="w-5 h-5" />
              </button>
            </Link>
            <p className="text-white/40 text-xs text-center mt-3">M-Pesa · Airtel Money · Orange Money</p>
          </div>

          {/* Urgency */}
          <div className="max-w-xl mx-auto flex items-center gap-2 justify-center">
            <div className="inline-flex items-center gap-2 bg-amber-500/15 border border-amber-400/30 text-amber-200 text-xs px-4 py-2 rounded-full">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              {data.urgency}
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════ STATS STRIP ═══ */}
      <section className="bg-slate-900 py-5 px-4 border-b border-white/10">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-center gap-6 sm:gap-12">
          {data.stats.map((s) => (
            <div key={s.n} className="text-center">
              <p className="text-secondary font-black text-2xl">{s.n}</p>
              <p className="text-white/40 text-xs mt-0.5 max-w-[140px]">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ═══════════════════════════ HOW IT WORKS ═══ */}
      <section className="py-20 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-secondary font-bold text-xs uppercase tracking-widest mb-2">Service sans acompte</p>
            <h2 className="text-3xl sm:text-4xl font-black text-primary leading-snug">
              Comment ça marche — en 3 étapes
            </h2>
            <p className="text-muted-foreground mt-3 max-w-xl mx-auto">
              Votre dossier est prêt. Joventy s'occupe du reste. Vous payez uniquement quand c'est fait.
            </p>
          </div>
          <div className="grid sm:grid-cols-3 gap-6">
            {data.steps.map((step, i) => (
              <div key={i} className="relative bg-white rounded-2xl border border-border p-7 shadow-sm">
                <div className="w-10 h-10 rounded-xl bg-primary text-white font-black text-lg flex items-center justify-center mb-4 shadow-lg shadow-primary/30">
                  {i + 1}
                </div>
                <div className="text-2xl mb-3">{step.icon}</div>
                <h3 className="font-black text-primary text-base leading-snug mb-3">{step.title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{step.desc}</p>
                {i < data.steps.length - 1 && (
                  <div className="hidden sm:block absolute -right-3 top-1/2 -translate-y-1/2 z-10">
                    <ArrowRight className="w-5 h-5 text-muted-foreground" />
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Link href="/dashboard/applications/new/creneau">
              <Button size="lg" className="bg-secondary text-white hover:bg-secondary/90 font-bold shadow-lg shadow-secondary/25">
                Démarrer — 0 $ d'acompte <ChevronRight className="ml-1 w-4 h-4" />
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ SOCIAL PROOF — GUARANTEE ═══ */}
      <section className="py-16 px-4 bg-gradient-to-br from-slate-50 to-white">
        <div className="max-w-4xl mx-auto">
          <div className="grid sm:grid-cols-3 gap-6">
            {[
              {
                icon: Shield,
                color: "text-green-600",
                bg: "bg-green-50",
                border: "border-green-200",
                title: "Paiement au résultat",
                desc: "Les 350 $ sont dus uniquement quand Joventy a confirmé votre créneau. Pas de créneau = pas de paiement.",
              },
              {
                icon: Zap,
                color: "text-secondary",
                bg: "bg-orange-50",
                border: "border-orange-200",
                title: "Surveillance active 24h/24",
                desc: "Le système Joventy surveille le portail consulaire en permanence. Vous êtes prévenu dans les secondes qui suivent l'apparition d'un créneau disponible.",
              },
              {
                icon: Clock,
                color: "text-blue-600",
                bg: "bg-blue-50",
                border: "border-blue-200",
                title: "Suivi en temps réel",
                desc: "Suivez le statut de votre demande depuis votre espace client Joventy. Notification WhatsApp instantanée.",
              },
            ].map((card) => (
              <div key={card.title} className={`rounded-2xl border ${card.border} ${card.bg} p-6`}>
                <div className={`w-10 h-10 rounded-xl ${card.bg} flex items-center justify-center mb-4`}>
                  <card.icon className={`w-6 h-6 ${card.color}`} />
                </div>
                <h3 className="font-bold text-primary text-sm mb-2">{card.title}</h3>
                <p className="text-xs text-slate-600 leading-relaxed">{card.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ INCLUDED ═══ */}
      <section className="py-16 px-4">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-black text-primary mb-8 text-center">Ce qui est inclus dans les 350 $</h2>
          <div className="bg-white border border-border rounded-2xl shadow-sm overflow-hidden">
            <div className="divide-y divide-border">
              {data.included.map((item) => (
                <div key={item} className="flex items-start gap-4 px-6 py-4">
                  <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-slate-700">{item}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ FAQ ═══ */}
      <section className="py-20 px-4 bg-slate-50">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-10">
            <p className="text-secondary font-bold text-xs uppercase tracking-widest mb-2">Questions fréquentes</p>
            <h2 className="text-3xl font-black text-primary">
              Créneau visa {data.name} depuis Kinshasa — FAQ
            </h2>
          </div>
          <div className="space-y-3">
            {data.faqs.map((faq, i) => (
              <div key={i} className="bg-white rounded-2xl border border-border overflow-hidden">
                <button
                  className="w-full flex items-center justify-between gap-4 p-6 text-left"
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                >
                  <p className="font-bold text-primary text-sm">{faq.q}</p>
                  <div className={`w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 transition-transform ${openFaq === i ? "rotate-180" : ""}`}>
                    <ChevronRight className="w-4 h-4 text-primary rotate-90" />
                  </div>
                </button>
                {openFaq === i && (
                  <div className="px-6 pb-6">
                    <p className="text-sm text-slate-600 leading-relaxed border-t border-border pt-4">{faq.a}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════ FINAL CTA ═══ */}
      <section className="py-20 px-4">
        <div className="max-w-3xl mx-auto">
          <div className="bg-primary rounded-3xl p-8 sm:p-12 text-white text-center">
            <div className="text-5xl mb-6">{data.emoji}</div>
            <h2 className="text-3xl sm:text-4xl font-black mb-4">
              Prêt à obtenir votre créneau {data.name} ?
            </h2>
            <p className="text-white/70 text-base mb-8 max-w-xl mx-auto leading-relaxed">
              Votre dossier est prêt. Joventy surveille le système consulaire en permanence.
              Aucun acompte — vous payez 350 $ uniquement quand le créneau est confirmé.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link href="/dashboard/applications/new/creneau">
                <button className="inline-flex items-center gap-3 bg-secondary hover:bg-secondary/90 text-white font-black text-lg px-10 py-4 rounded-2xl shadow-xl shadow-black/20 transition-all hover:scale-105 active:scale-100">
                  Obtenir mon créneau · 0 $ d'acompte
                  <ChevronRight className="w-5 h-5" />
                </button>
              </Link>
              <a href="https://wa.me/243840808122" target="_blank" rel="noopener noreferrer">
                <button className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/20 border border-white/30 text-white font-bold px-6 py-4 rounded-2xl transition-all">
                  <MessageCircle className="w-5 h-5" />
                  Question ? WhatsApp
                </button>
              </a>
            </div>
            <p className="text-white/40 text-xs mt-6">
              Paiement via M-Pesa · Airtel Money · Orange Money · uniquement après résultat
            </p>
          </div>

          {/* Cross-links */}
          <div className="mt-8 grid sm:grid-cols-2 gap-4">
            <Link href={`/${data.relatedDestSlug}`}>
              <div className="group border border-border rounded-xl p-4 hover:border-primary/40 hover:bg-muted/50 transition-all cursor-pointer">
                <p className="text-xs text-muted-foreground mb-1">Service complet disponible →</p>
                <p className="font-bold text-primary text-sm group-hover:underline">
                  Visa {data.name} complet — dossier + créneau · 1 500 $
                </p>
              </div>
            </Link>
            <Link href="/prix">
              <div className="group border border-border rounded-xl p-4 hover:border-primary/40 hover:bg-muted/50 transition-all cursor-pointer">
                <p className="text-xs text-muted-foreground mb-1">Comparer les formules →</p>
                <p className="font-bold text-primary text-sm group-hover:underline">
                  Voir tous les tarifs Joventy
                </p>
              </div>
            </Link>
          </div>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}
