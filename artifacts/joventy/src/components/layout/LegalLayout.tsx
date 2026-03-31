import { Link } from "wouter";
import { ArrowLeft, Mail, Phone } from "lucide-react";
import { Helmet } from "react-helmet-async";
import { JoventyLogo } from "@/components/JoventyLogo";

interface LegalLayoutProps {
  title: string;
  subtitle?: string;
  lastUpdated?: string;
  description?: string;
  slug?: string;
  children: React.ReactNode;
}

export function LegalLayout({ title, subtitle, lastUpdated, description, slug, children }: LegalLayoutProps) {
  const pageTitle = `${title} — Joventy | Akollad Groupe`;
  const metaDesc = description ?? subtitle ?? "Page légale du site Joventy.cd, service d'assistance visa premium édité par Akollad Groupe, Kinshasa RDC.";
  const canonical = slug ? `https://www.joventy.cd/${slug}` : "https://www.joventy.cd/";

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      <Helmet>
        <title>{pageTitle}</title>
        <meta name="description" content={metaDesc} />
        <link rel="canonical" href={canonical} />
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content={metaDesc} />
        <meta property="og:url" content={canonical} />
        <meta property="og:type" content="website" />
      </Helmet>

      {/* Header */}
      <header className="bg-white border-b border-border sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <Link href="/">
            <JoventyLogo variant="light" size="sm" />
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Retour à l'accueil
          </Link>
        </div>
      </header>

      {/* Hero */}
      <div className="bg-primary text-white py-12 px-4">
        <div className="max-w-5xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-serif font-bold mb-2">{title}</h1>
          {subtitle && <p className="text-white/65 text-sm">{subtitle}</p>}
          {lastUpdated && (
            <p className="text-white/45 text-xs mt-3">Dernière mise à jour : {lastUpdated}</p>
          )}
        </div>
      </div>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <div className="bg-white rounded-2xl border border-border shadow-sm p-8 sm:p-12 prose prose-slate max-w-none
          prose-headings:font-serif prose-headings:text-primary
          prose-h2:text-xl prose-h2:font-bold prose-h2:mt-10 prose-h2:mb-4 prose-h2:pb-2 prose-h2:border-b prose-h2:border-border
          prose-h3:text-base prose-h3:font-bold prose-h3:mt-6 prose-h3:mb-2 prose-h3:text-slate-700
          prose-p:text-slate-600 prose-p:leading-relaxed prose-p:text-sm
          prose-li:text-slate-600 prose-li:text-sm prose-li:leading-relaxed
          prose-strong:text-slate-800
          prose-a:text-primary prose-a:no-underline hover:prose-a:underline">
          {children}
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-primary text-white py-10 mt-8">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row justify-between items-center gap-4 text-sm">
          <div className="flex items-center gap-3">
            <JoventyLogo variant="dark" size="sm" />
            <span className="text-white/40">Assistance visa premium · Kinshasa, RDC</span>
          </div>
          <div className="flex flex-col sm:flex-row items-center gap-4 text-white/50 text-xs">
            <a href="mailto:contact@joventy.cd" className="flex items-center gap-1.5 hover:text-white transition-colors">
              <Mail className="w-3.5 h-3.5" /> contact@joventy.cd
            </a>
            <a href="https://wa.me/243840808122" className="flex items-center gap-1.5 hover:text-white transition-colors">
              <Phone className="w-3.5 h-3.5" /> +243 840 808 122
            </a>
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 mt-6 pt-6 border-t border-white/10 flex flex-wrap justify-center gap-4 text-white/30 text-xs">
          <Link href="/mentions-legales" className="hover:text-white transition-colors">Mentions légales</Link>
          <Link href="/confidentialite" className="hover:text-white transition-colors">Confidentialité</Link>
          <Link href="/conditions" className="hover:text-white transition-colors">CGU</Link>
          <Link href="/remboursement" className="hover:text-white transition-colors">Remboursements</Link>
        </div>
      </footer>
    </div>
  );
}
