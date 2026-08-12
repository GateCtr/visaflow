import { Link } from "wouter";
import { Helmet } from "react-helmet-async";
import { Clock, ChevronRight, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAllGuides } from "@/data/guides-seo";
import { PublicLayout } from "@/components/layout/PublicLayout";

const CATEGORY_COLORS: Record<string, string> = {
  "Visa USA": "bg-blue-100 text-blue-700",
  "Visa Schengen": "bg-indigo-100 text-indigo-700",
  "Visa Canada": "bg-red-100 text-red-700",
  "Comparatif": "bg-violet-100 text-violet-700",
  "Visa Business": "bg-amber-100 text-amber-700",
  "Recours & Urgences": "bg-rose-100 text-rose-700",
};

function getCategoryColor(cat: string) {
  return CATEGORY_COLORS[cat] ?? "bg-slate-100 text-slate-600";
}

export default function GuidesIndex() {
  const guides = getAllGuides();

  const schemaArticleList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Guides Visa Kinshasa — Joventy",
    description: "Guides pratiques pour les demandes de visa depuis Kinshasa, RDC",
    numberOfItems: guides.length,
    itemListElement: guides.map((g, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: g.title,
      url: `https://joventy.cd/guides/${g.slug}`,
    })),
  };

  return (
    <PublicLayout solidNav>
      <Helmet>
        <title>Guides Visa depuis Kinshasa 2026 — Conseils & Démarches | Joventy</title>
        <meta name="description" content="Guides pratiques et conseils d'experts pour vos demandes de visa USA, Canada, Schengen depuis Kinshasa. Délais, documents, entretiens — tout ce qu'il faut savoir." />
        <link rel="canonical" href="https://joventy.cd/guides" />
        <meta property="og:title" content="Guides Visa depuis Kinshasa 2026 — Conseils & Démarches | Joventy" />
        <meta property="og:description" content="Guides pratiques et conseils d'experts pour vos demandes de visa USA, Canada, Schengen depuis Kinshasa. Délais, documents, entretiens — tout ce qu'il faut savoir." />
        <meta property="og:url" content="https://joventy.cd/guides" />
        <meta property="og:type" content="website" />
        <meta property="og:image" content="https://joventy.cd/opengraph.jpg" />
        <meta property="og:locale" content="fr_CD" />
        <meta property="og:site_name" content="Joventy" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Guides Visa depuis Kinshasa 2026 — Conseils & Démarches | Joventy" />
        <meta name="twitter:description" content="Guides pratiques et conseils d'experts pour vos demandes de visa USA, Canada, Schengen depuis Kinshasa. Délais, documents, entretiens — tout ce qu'il faut savoir." />
        <meta name="twitter:image" content="https://joventy.cd/opengraph.jpg" />
        <meta name="twitter:site" content="@JoventyCD" />
        <script type="application/ld+json">{JSON.stringify(schemaArticleList)}</script>
      </Helmet>

      <div>
        {/* Hero */}
        <section className="bg-gradient-to-b from-primary/5 to-white py-16 px-4">
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary text-xs font-semibold px-3 py-1.5 rounded-full mb-4">
              📚 Ressources gratuites
            </div>
            <h1 className="text-3xl md:text-4xl font-serif font-bold text-primary mb-4">
              Guides visa depuis Kinshasa
            </h1>
            <p className="text-slate-500 text-lg leading-relaxed">
              Tout ce que vous devez savoir pour préparer votre demande de visa — délais réels,
              documents exacts, questions d'entretien et stratégies pour maximiser vos chances.
            </p>
          </div>
        </section>

        {/* Guides grid */}
        <section className="max-w-5xl mx-auto px-4 py-12">
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {guides.map((guide) => (
              <Link key={guide.slug} href={`/guides/${guide.slug}`} className="group block">
                <article className="h-full bg-white border border-slate-100 rounded-2xl p-6 hover:shadow-lg hover:border-primary/20 transition-all duration-200 flex flex-col">
                  <div className="text-3xl mb-3">{guide.coverEmoji}</div>
                  <div className="flex items-center gap-2 mb-3">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${getCategoryColor(guide.category)}`}>
                      {guide.category}
                    </span>
                    <span className="text-xs text-slate-400 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {guide.readingTime} min
                    </span>
                  </div>
                  <h2 className="font-bold text-slate-800 text-base leading-snug mb-2 group-hover:text-primary transition-colors line-clamp-3">
                    {guide.title}
                  </h2>
                  <p className="text-sm text-slate-500 line-clamp-2 flex-1 mb-4">
                    {guide.intro.substring(0, 120)}…
                  </p>
                  <div className="flex items-center gap-1 text-primary text-sm font-medium mt-auto">
                    Lire le guide <ChevronRight className="w-4 h-4" />
                  </div>
                </article>
              </Link>
            ))}
          </div>
        </section>

        {/* CTA banner */}
        <section className="bg-primary text-white py-14 px-4 mt-8">
          <div className="max-w-2xl mx-auto text-center">
            <h2 className="text-2xl font-bold mb-3">Prêt à démarrer votre dossier ?</h2>
            <p className="text-white/70 mb-6">
              Joventy prend en charge l'intégralité de vos démarches — de la préparation du dossier à la capture du créneau consulaire.
            </p>
            <Link href="/register">
              <Button size="lg" className="bg-secondary hover:bg-secondary/90 text-white font-semibold">
                Créer mon dossier <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            </Link>
          </div>
        </section>
      </div>
    </PublicLayout>
  );
}
