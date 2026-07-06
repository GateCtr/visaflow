import { Link, useLocation } from "wouter";
import { Helmet } from "react-helmet-async";
import {
  ArrowRight, MapPin, Phone, Mail, Clock, ChevronRight,
  MessageCircle, CheckCircle2, HelpCircle, Building2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { JoventyLogo } from "@/components/JoventyLogo";
import { getEmbassyBySlug, EMBASSIES_SEO } from "@/data/embassies-seo";
import { getDestinationBySlug } from "@/data/destinations-seo";

const FLAG_SIZES = [20, 40, 80, 160, 320, 640];
function snapFlagSize(n: number) {
  return FLAG_SIZES.find((s) => s >= n) ?? 80;
}
function FlagImg({ code, size = 32, className = "" }: { code: string; size?: number; className?: string }) {
  const snapped = snapFlagSize(size);
  const snapped2x = snapFlagSize(size * 2);
  return (
    <img
      src={`https://flagcdn.com/w${snapped}/${code.toLowerCase()}.png`}
      srcSet={`https://flagcdn.com/w${snapped2x}/${code.toLowerCase()}.png 2x`}
      width={snapped}
      alt={`Drapeau ${code.toUpperCase()}`}
      className={`rounded-sm object-cover flex-shrink-0 ${className}`}
    />
  );
}

export default function EmbassyPage() {
  const [location] = useLocation();
  const slug = location.replace(/^\//, "").split("?")[0];
  const embassy = getEmbassyBySlug(slug);

  if (!embassy) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 gap-6 px-4">
        <Helmet>
          <title>Ambassade introuvable — Joventy</title>
          <meta name="robots" content="noindex" />
        </Helmet>
        <JoventyLogo variant="light" size="md" href="/" />
        <p className="text-xl font-bold text-primary">Page introuvable</p>
        <Link href="/">
          <Button>Retour à l'accueil</Button>
        </Link>
      </div>
    );
  }

  const destination = embassy.destinationSlug ? getDestinationBySlug(embassy.destinationSlug) : undefined;
  const relatedEmbassies = EMBASSIES_SEO.filter((e) => e.slug !== embassy.slug).slice(0, 3);
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(embassy.mapsQuery)}`;

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: embassy.faqs.map((faq) => ({
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
      { "@type": "ListItem", position: 2, name: embassy.officialName, item: `https://joventy.cd/${embassy.slug}` },
    ],
  };

  const localBusinessSchema = {
    "@context": "https://schema.org",
    "@type": "GovernmentOffice",
    name: embassy.officialName,
    address: {
      "@type": "PostalAddress",
      streetAddress: embassy.address,
      addressLocality: "Kinshasa",
      addressCountry: "CD",
    },
    telephone: embassy.phones[0]?.split(" (")[0],
    url: embassy.website,
  };

  return (
    <div className="min-h-screen bg-white font-sans">
      <Helmet>
        <title>{embassy.title}</title>
        <meta name="description" content={embassy.metaDescription} />
        <link rel="canonical" href={`https://joventy.cd/${embassy.slug}`} />
        <meta property="og:title" content={embassy.title} />
        <meta property="og:description" content={embassy.metaDescription} />
        <meta property="og:url" content={`https://joventy.cd/${embassy.slug}`} />
        <meta property="og:type" content="website" />
        <meta property="og:image" content="https://joventy.cd/opengraph.jpg" />
        <meta property="og:locale" content="fr_CD" />
        <meta property="og:site_name" content="Joventy" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={embassy.title} />
        <meta name="twitter:description" content={embassy.metaDescription} />
        <meta name="twitter:site" content="@JoventyCD" />
        <script type="application/ld+json">{JSON.stringify(faqSchema)}</script>
        <script type="application/ld+json">{JSON.stringify(breadcrumbSchema)}</script>
        <script type="application/ld+json">{JSON.stringify(localBusinessSchema)}</script>
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
            <Link href="/ambassades" className="hover:text-primary transition-colors">Ambassades</Link>
            <ChevronRight className="w-3 h-3" />
            <span className="text-primary font-semibold">{embassy.countryShort}</span>
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
            <FlagImg code={embassy.flagCode} size={48} className="shadow-md rounded" />
            <div>
              <p className="text-white/60 text-xs font-semibold uppercase tracking-widest">Adresse & Contact · Kinshasa, RDC</p>
              <p className="text-secondary font-bold text-sm">{embassy.country}</p>
            </div>
          </div>

          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold leading-tight mb-4 max-w-3xl text-white">
            {embassy.h1}
          </h1>

          <p className="text-white/75 text-lg max-w-2xl leading-relaxed mb-8">{embassy.intro}</p>

          <div className="flex flex-wrap gap-4">
            {destination && (
              <Link href={`/${destination.slug}`}>
                <Button size="lg" className="h-12 px-7 bg-secondary hover:bg-secondary/90 text-white font-bold shadow-xl rounded-xl">
                  Faire ma demande de visa {destination.nameShort} <ArrowRight className="ml-2 w-4 h-4" />
                </Button>
              </Link>
            )}
            <a href="https://wa.me/243840808122" target="_blank" rel="noopener noreferrer">
              <Button size="lg" variant="outline" className="h-12 px-7 border-white/30 text-white hover:bg-white/10 font-semibold rounded-xl">
                <MessageCircle className="mr-2 w-4 h-4" /> WhatsApp
              </Button>
            </a>
          </div>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 space-y-20">

        {/* ── CONTACT CARD ── */}
        <section>
          <h2 className="text-2xl md:text-3xl font-bold text-primary mb-2">
            Adresse & contact — {embassy.officialName}
          </h2>
          <p className="text-muted-foreground mb-8">Coordonnées officielles vérifiées pour votre déplacement à Kinshasa.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-muted border border-border rounded-2xl p-6 space-y-5">
              <div className="flex gap-4">
                <div className="w-9 h-9 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <MapPin className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <p className="font-bold text-primary text-sm mb-1">Adresse</p>
                  <p className="text-sm text-slate-700 leading-relaxed">{embassy.address}</p>
                  {embassy.poBox && <p className="text-xs text-muted-foreground mt-1">{embassy.poBox}</p>}
                  <a href={mapsHref} target="_blank" rel="noopener noreferrer" className="inline-block mt-2 text-xs font-semibold text-secondary hover:underline">
                    Voir sur Google Maps →
                  </a>
                </div>
              </div>

              {embassy.phones.length > 0 && (
                <div className="flex gap-4">
                  <div className="w-9 h-9 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Phone className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <p className="font-bold text-primary text-sm mb-1">Téléphone</p>
                    {embassy.phones.map((p) => (
                      <p key={p} className="text-sm text-slate-700">{p}</p>
                    ))}
                  </div>
                </div>
              )}

              {embassy.emails.length > 0 && (
                <div className="flex gap-4">
                  <div className="w-9 h-9 bg-primary/10 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Mail className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <p className="font-bold text-primary text-sm mb-1">Email</p>
                    {embassy.emails.map((e) => (
                      <p key={e.email} className="text-sm text-slate-700">
                        <span className="text-muted-foreground">{e.label} : </span>
                        <a href={`mailto:${e.email}`} className="hover:underline text-primary">{e.email}</a>
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-white border border-border rounded-2xl p-6 shadow-sm space-y-5">
              <div className="flex gap-4">
                <div className="w-9 h-9 bg-secondary/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Clock className="w-4 h-4 text-secondary" />
                </div>
                <div className="flex-1">
                  <p className="font-bold text-primary text-sm mb-2">Horaires d'ouverture</p>
                  <div className="space-y-1.5">
                    {embassy.hours.map((h) => (
                      <div key={h.days} className="flex justify-between text-sm gap-4">
                        <span className="text-muted-foreground">{h.days}</span>
                        <span className="font-semibold text-slate-700 text-right">{h.hours}</span>
                      </div>
                    ))}
                  </div>
                  {embassy.appointmentOnly && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">
                      Rendez-vous obligatoire pour toute démarche visa
                    </p>
                  )}
                </div>
              </div>

              <div className="flex gap-4">
                <div className="w-9 h-9 bg-secondary/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Building2 className="w-4 h-4 text-secondary" />
                </div>
                <div>
                  <p className="font-bold text-primary text-sm mb-1">Site officiel</p>
                  {embassy.website ? (
                    <a href={embassy.website} target="_blank" rel="noopener noreferrer" className="text-sm text-secondary hover:underline break-all">
                      {embassy.website.replace(/^https?:\/\//, "")}
                    </a>
                  ) : (
                    <p className="text-sm text-muted-foreground">Non communiqué publiquement</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── PRACTICAL INFO ── */}
        <section className="bg-muted rounded-3xl p-8 sm:p-10">
          <h2 className="text-2xl md:text-3xl font-bold text-primary mb-2">
            Bon à savoir avant de vous déplacer
          </h2>
          <p className="text-muted-foreground mb-7">Informations pratiques utiles pour votre visite à {embassy.officialName}.</p>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {embassy.practicalInfo.map((info) => (
              <li key={info} className="flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                <span className="text-sm text-slate-700 leading-relaxed">{info}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* ── VISA NOTE / CTA ── */}
        <section className="bg-primary rounded-3xl p-8 sm:p-12 text-center text-white">
          <FlagImg code={embassy.flagCode} size={64} className="mx-auto mb-5 shadow-lg rounded-xl" />
          <h2 className="text-2xl sm:text-3xl font-bold mb-3">
            Comment obtenir votre visa {embassy.countryShort} avec Joventy
          </h2>
          <p className="text-white/70 text-base mb-8 max-w-2xl mx-auto leading-relaxed">
            {embassy.visaNote}
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            {destination ? (
              <Link href={`/${destination.slug}`}>
                <Button size="lg" className="h-13 px-8 text-base bg-secondary hover:bg-secondary/90 text-white font-bold shadow-xl rounded-xl">
                  Voir la démarche complète {destination.nameShort} <ArrowRight className="ml-2 w-5 h-5" />
                </Button>
              </Link>
            ) : (
              <Link href="/register">
                <Button size="lg" className="h-13 px-8 text-base bg-secondary hover:bg-secondary/90 text-white font-bold shadow-xl rounded-xl">
                  Créer mon dossier <ArrowRight className="ml-2 w-5 h-5" />
                </Button>
              </Link>
            )}
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
            Questions fréquentes — {embassy.officialName}
          </h2>
          <div className="space-y-4">
            {embassy.faqs.map((faq) => (
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

        {/* ── RELATED EMBASSIES ── */}
        <section>
          <h2 className="text-2xl font-bold text-primary mb-6">
            Autres ambassades à Kinshasa
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {relatedEmbassies.map((e) => (
              <Link key={e.slug} href={`/${e.slug}`}>
                <div className="bg-muted border border-border rounded-2xl p-5 hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer flex items-center gap-4">
                  <FlagImg code={e.flagCode} size={40} />
                  <div>
                    <p className="font-bold text-primary text-sm">{e.country}</p>
                    <p className="text-xs text-muted-foreground">{e.neighborhood}, Kinshasa</p>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground ml-auto" />
                </div>
              </Link>
            ))}
          </div>
          <div className="mt-6">
            <Link href="/ambassades" className="text-sm font-semibold text-secondary hover:underline inline-flex items-center gap-1">
              Voir toutes les ambassades à Kinshasa <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </section>
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
