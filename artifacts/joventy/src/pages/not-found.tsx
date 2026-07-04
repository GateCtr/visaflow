import { Link } from "wouter";
import { Helmet } from "react-helmet-async";
import { ArrowRight, ChevronRight, MessageCircle, BookOpen, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JoventyLogo } from "@/components/JoventyLogo";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-50">
      <Helmet>
        <title>Page introuvable — Joventy</title>
        <meta name="robots" content="noindex" />
      </Helmet>

      {/* Header */}
      <header className="bg-white border-b border-border py-4">
        <div className="max-w-5xl mx-auto px-4 flex items-center justify-between">
          <Link href="/">
            <JoventyLogo variant="light" size="sm" />
          </Link>
          <Link href="/register">
            <Button size="sm" className="bg-secondary hover:bg-secondary/90 text-white font-semibold">
              Commencer <ArrowRight className="ml-1.5 w-3.5 h-3.5" />
            </Button>
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-16 text-center">
        <p className="text-6xl font-bold text-primary mb-4">404</p>
        <h1 className="text-2xl font-bold text-slate-800 mb-3">Page introuvable</h1>
        <p className="text-muted-foreground mb-10 max-w-md mx-auto">
          Cette page n'existe pas ou a été déplacée. Retrouvez nos services et guides ci-dessous.
        </p>

        {/* Guides d'urgence */}
        <section className="mb-12">
          <div className="flex items-center justify-center gap-2 mb-5">
            <BookOpen className="w-5 h-5 text-red-600" />
            <h2 className="text-lg font-bold text-primary">Guides d'urgence — Ebola 2026</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-left">
            {[
              { emoji: "🌍", title: "Purger 21 jours dans un pays neutre", href: "/guides/purger-21-jours-ebola-pays-neutre-visa-usa-2026" },
              { emoji: "🚨", title: "Suspension visa Canada RDC", href: "/guides/suspension-visa-canada-rdc-ebola-2026" },
              { emoji: "⚽", title: "Coupe du Monde 2026 — Visa USA", href: "/guides/coupe-du-monde-2026-visa-usa-kinshasa" },
            ].map((g) => (
              <Link key={g.href} href={g.href}>
                <div className="bg-white border border-slate-200 rounded-xl p-4 hover:shadow-md hover:border-red-200 transition-all cursor-pointer h-full">
                  <span className="text-2xl">{g.emoji}</span>
                  <p className="text-sm font-semibold text-slate-700 mt-2">{g.title}</p>
                  <span className="text-xs text-red-600 font-medium flex items-center gap-0.5 mt-2">Lire <ChevronRight className="w-3 h-3" /></span>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* Destinations populaires */}
        <section className="mb-12">
          <div className="flex items-center justify-center gap-2 mb-5">
            <Globe className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-bold text-primary">Destinations populaires</h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-left">
            {[
              { flag: "🇺🇸", name: "Visa USA", href: "/visa-usa-kinshasa" },
              { flag: "🇨🇦", name: "Visa Canada", href: "/visa-canada-kinshasa" },
              { flag: "🇪🇺", name: "Visa Schengen", href: "/visa-schengen-kinshasa" },
              { flag: "🇦🇪", name: "E-Visa Dubaï", href: "/e-visa-dubai-kinshasa" },
              { flag: "🇲🇦", name: "Visa Maroc", href: "/visa-maroc-kinshasa" },
              { flag: "🇪🇬", name: "Visa Égypte", href: "/e-visa-egypte-kinshasa" },
              { flag: "🇹🇷", name: "Visa Turquie", href: "/visa-turquie-kinshasa" },
              { flag: "🇬🇧", name: "Visa UK", href: "/visa-royaume-uni-kinshasa" },
            ].map((d) => (
              <Link key={d.href} href={d.href}>
                <div className="bg-white border border-slate-200 rounded-xl p-3 hover:shadow-md transition-all cursor-pointer flex items-center gap-2">
                  <span className="text-lg">{d.flag}</span>
                  <span className="text-xs font-semibold text-slate-700">{d.name}</span>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* Tous les guides */}
        <section className="mb-12">
          <Link href="/guides">
            <Button variant="outline" className="font-semibold">
              <BookOpen className="mr-2 w-4 h-4" /> Voir tous les guides visa
            </Button>
          </Link>
        </section>

        {/* WhatsApp CTA */}
        <div className="bg-primary rounded-2xl p-6 text-white">
          <p className="font-bold text-lg mb-2">Besoin d'aide ?</p>
          <p className="text-white/70 text-sm mb-4">Contactez Joventy sur WhatsApp — réponse en moins de 2h.</p>
          <a href="https://wa.me/243840808122" target="_blank" rel="noopener noreferrer">
            <Button className="bg-[#25D366] hover:bg-[#1ebe5d] text-white font-bold">
              <MessageCircle className="mr-2 w-4 h-4" /> WhatsApp +243840808122
            </Button>
          </a>
        </div>
      </main>
    </div>
  );
}
