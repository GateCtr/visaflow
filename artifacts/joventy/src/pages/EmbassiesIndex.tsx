import { Link } from "wouter";
import { Helmet } from "react-helmet-async";
import { ArrowRight, ChevronRight, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JoventyLogo } from "@/components/JoventyLogo";
import { EMBASSIES_SEO } from "@/data/embassies-seo";

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

export default function EmbassiesIndex() {
  const schemaItemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Ambassades à Kinshasa — Joventy",
    description: "Adresses et contacts des ambassades étrangères à Kinshasa, RDC",
    numberOfItems: EMBASSIES_SEO.length,
    itemListElement: EMBASSIES_SEO.map((e, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: e.officialName,
      url: `https://joventy.cd/${e.slug}`,
    })),
  };

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Accueil", item: "https://joventy.cd/" },
      { "@type": "ListItem", position: 2, name: "Ambassades à Kinshasa", item: "https://joventy.cd/ambassades" },
    ],
  };

  return (
    <div className="min-h-screen bg-white font-sans">
      <Helmet>
        <title>Ambassades à Kinshasa 2026 — Adresses, Horaires & Contacts | Joventy</title>
        <meta name="description" content="Liste complète des ambassades à Kinshasa (USA, Canada, UK, France, Belgique, Espagne, Suisse, Turquie, Inde, Maroc, Égypte, Chine) : adresses, téléphones, horaires et infos visa." />
        <link rel="canonical" href="https://joventy.cd/ambassades" />
        <meta property="og:title" content="Ambassades à Kinshasa 2026 — Adresses, Horaires & Contacts | Joventy" />
        <meta property="og:description" content="Liste complète des ambassades à Kinshasa : adresses, téléphones, horaires et infos visa pour chaque pays." />
        <meta property="og:url" content="https://joventy.cd/ambassades" />
        <meta property="og:type" content="website" />
        <meta property="og:image" content="https://joventy.cd/opengraph.jpg" />
        <meta property="og:locale" content="fr_CD" />
        <meta property="og:site_name" content="Joventy" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Ambassades à Kinshasa 2026 — Adresses, Horaires & Contacts | Joventy" />
        <meta name="twitter:description" content="Liste complète des ambassades à Kinshasa : adresses, téléphones, horaires et infos visa pour chaque pays." />
        <meta name="twitter:site" content="@JoventyCD" />
        <script type="application/ld+json">{JSON.stringify(schemaItemList)}</script>
        <script type="application/ld+json">{JSON.stringify(breadcrumbSchema)}</script>
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
            <span className="text-primary font-semibold">Ambassades</span>
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
        <div className="max-w-6xl mx-auto px-4 sm:px-6 text-center">
          <div className="inline-flex items-center gap-2 bg-white/15 border border-white/20 text-white text-xs font-semibold px-3 py-1.5 rounded-full mb-5">
            <MapPin className="w-3.5 h-3.5" /> Kinshasa, RDC
          </div>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold leading-tight mb-4 max-w-3xl mx-auto text-white">
            Ambassades à Kinshasa — Adresses & Contacts
          </h1>
          <p className="text-white/75 text-lg max-w-2xl mx-auto leading-relaxed">
            Retrouvez l'adresse exacte, le téléphone, l'email et les horaires de chaque ambassade présente à Kinshasa, ainsi que les démarches de visa correspondantes prises en charge par Joventy.
          </p>
        </div>
      </section>

      {/* ── EMBASSY GRID ── */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {EMBASSIES_SEO.map((e) => (
            <Link key={e.slug} href={`/${e.slug}`} className="group block">
              <article className="h-full bg-muted border border-border rounded-2xl p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-200 flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <FlagImg code={e.flagCode} size={40} className="shadow-sm" />
                  <div>
                    <p className="font-bold text-primary text-sm group-hover:text-secondary transition-colors">{e.country}</p>
                    <p className="text-xs text-muted-foreground">{e.neighborhood}, Kinshasa</p>
                  </div>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed flex-1">{e.address}</p>
                <div className="flex items-center gap-1 text-secondary text-sm font-semibold mt-auto">
                  Voir l'adresse complète <ChevronRight className="w-4 h-4" />
                </div>
              </article>
            </Link>
          ))}
        </div>
      </div>

      {/* ── CTA ── */}
      <section className="bg-primary text-white py-14 px-4">
        <div className="max-w-2xl mx-auto text-center">
          <h2 className="text-2xl font-bold mb-3">Besoin d'aide pour votre visa ?</h2>
          <p className="text-white/70 mb-6">
            Joventy prend en charge l'intégralité de vos démarches — préparation du dossier, prise de rendez-vous et suivi jusqu'au résultat.
          </p>
          <Link href="/register">
            <Button size="lg" className="bg-secondary hover:bg-secondary/90 text-white font-semibold">
              Créer mon dossier <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
          </Link>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="bg-primary text-white py-10">
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
