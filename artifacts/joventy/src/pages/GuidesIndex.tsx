import { Link } from "wouter";
import { Helmet } from "react-helmet-async";
import { Clock, ChevronRight, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JoventyLogo } from "@/components/JoventyLogo";
import { getAllGuides } from "@/data/guides-seo";

const CATEGORY_COLORS: Record<string, string> = {
  "Visa USA": "bg-blue-100 text-blue-700",
  "Visa Schengen": "bg-indigo-100 text-indigo-700",
  "Comparatif": "bg-violet-100 text-violet-700",
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
      url: `https://www.joventy.cd/guides/${g.slug}`,
    })),
  };

  return (
    <>
      <Helmet>
        <title>Guides Visa depuis Kinshasa 2025 — Conseils & Démarches | Joventy</title>
        <meta
          name="description"
          content="Guides pratiques et conseils d'experts pour vos demandes de visa USA, Canada, Schengen depuis Kinshasa. Délais, documents, entretiens — tout ce qu'il faut savoir."
        />
        <link rel="canonical" href="https://www.joventy.cd/guides" />
        <script type="application/ld+json">{JSON.stringify(schemaArticleList)}</script>
      </Helmet>

      {/* Navbar */}
      <header className="sticky top-0 z-50 bg-white/95 backdrop-blur border-b border-slate-100">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-primary font-bold text-lg">
            <JoventyLogo className="w-8 h-8" showText={false} />
            Joventy
          </Link>
          <nav className="hidden md:flex items-center gap-6 text-sm text-slate-500">
            <Link href="/#destinations" className="hover:text-primary transition-colors">Destinations</Link>
            <Link href="/guides" className="text-primary font-medium">Guides</Link>
            <Link href="/#contact" className="hover:text-primary transition-colors">Contact</Link>
          </nav>
          <Link href="/register">
            <Button size="sm" className="bg-orange-500 hover:bg-orange-600 text-white">
              Commencer <ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </header>

      <main>
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
              <Button size="lg" className="bg-orange-500 hover:bg-orange-600 text-white font-semibold">
                Créer mon dossier <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            </Link>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-slate-900 text-white/50 py-8 px-4">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 text-xs">
          <p>© {new Date().getFullYear()} Joventy · Un service <a href="https://akollad.com" target="_blank" rel="noreferrer" className="hover:text-white/70 underline underline-offset-2">Akollad Groupe</a> · Kinshasa, RDC</p>
          <div className="flex gap-4">
            <Link href="/" className="hover:text-white transition-colors">Accueil</Link>
            <Link href="/guides" className="hover:text-white transition-colors">Guides</Link>
            <Link href="/mentions-legales" className="hover:text-white transition-colors">Légal</Link>
          </div>
        </div>
      </footer>
    </>
  );
}
