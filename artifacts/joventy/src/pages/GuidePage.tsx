import { Link, useLocation } from "wouter";
import { Helmet } from "react-helmet-async";
import { Clock, ChevronRight, ArrowRight, BookOpen, MessageCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JoventyLogo } from "@/components/JoventyLogo";
import { getGuideBySlug, getRelatedGuides } from "@/data/guides-seo";
import { EMBASSIES_SEO } from "@/data/embassies-seo";
import { WhatsAppAuditCTA } from "@/components/WhatsAppAuditCTA";
import { ShieldCheck } from "lucide-react";
import { PublicLayout } from "@/components/layout/PublicLayout";
import { AdSenseInArticle } from "@/components/AdSenseInArticle";

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

export default function GuidePage() {
  const [location] = useLocation();
  const slug = location.replace(/^\/guides\//, "").split("?")[0];
  const guide = getGuideBySlug(slug);

  if (!guide) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 gap-6 px-4">
        <JoventyLogo className="w-14 h-14" />
        <h2 className="text-xl font-bold text-primary">Guide introuvable</h2>
        <Link href="/guides">
          <Button>Voir tous les guides</Button>
        </Link>
      </div>
    );
  }

  const relatedGuides = getRelatedGuides(guide.relatedSlugs);
  const isSpainGuide = guide.relatedDestination === "visa-espagne-kinshasa";
  const isCevGuide = guide.slug.includes("cev") ||
    guide.category === "Visa Schengen" ||
    guide.relatedDestination === "visa-schengen-kinshasa" ||
    guide.relatedDestination === "visa-belgique-long-sejour-kinshasa";
  const destinationOffice = EMBASSIES_SEO.find((embassy) => embassy.destinationSlug === guide.relatedDestination);
  const officialLinks = [
    ...(isSpainGuide
      ? [{
          label: "Portail officiel des rendez-vous Espagne",
          href: "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/#services",
          description: "Accéder directement au portail citaconsular.es utilisé pour rechercher et confirmer votre rendez-vous.",
        }]
      : []),
    ...(isCevGuide
      ? [
          {
            label: "CEV Kinshasa — site officiel",
            href: "https://www.cev-kin.eu",
            description: "Vérifier les pays représentés, le type de séjour et les instructions de dépôt en vigueur.",
          },
          {
            label: "Visa On Web — portail officiel belge",
            href: "https://visaonweb.diplomatie.be/",
            description: "Créer ou ouvrir votre demande officielle Visa On Web avant la réservation et le dépôt au CEV.",
          },
        ]
      : []),
    ...(!isSpainGuide && !isCevGuide && destinationOffice?.website
      ? [{
          label: `${destinationOffice.officialName} — site officiel`,
          href: destinationOffice.website,
          description: "Consulter les instructions, conditions et éventuelles mises à jour publiées par l'autorité compétente.",
        }]
      : []),
  ];

  return (
    <PublicLayout solidNav>
      <Helmet>
        <title>{guide.metaTitle}</title>
        <meta name="description" content={guide.metaDescription} />
        <link rel="canonical" href={`https://joventy.cd/guides/${guide.slug}`} />
        <meta property="og:title" content={guide.metaTitle} />
        <meta property="og:description" content={guide.metaDescription} />
        <meta property="og:type" content="article" />
        <meta property="og:url" content={`https://joventy.cd/guides/${guide.slug}`} />
        <meta property="og:image" content="https://joventy.cd/opengraph.jpg" />
        <meta property="og:locale" content="fr_CD" />
        <meta property="og:site_name" content="Joventy" />
        <meta property="article:published_time" content={guide.publishedDate} />
        <meta property="article:modified_time" content={guide.updatedDate} />
      </Helmet>

      <article className="max-w-3xl mx-auto px-4 py-10">

        {/* Breadcrumb */}
        <nav aria-label="Fil d'Ariane" className="flex items-center gap-1.5 text-sm text-slate-400 mb-6">
          <Link href="/" className="hover:text-primary transition-colors">Accueil</Link>
          <ChevronRight className="w-3.5 h-3.5" />
          <Link href="/guides" className="hover:text-primary transition-colors">Guides</Link>
          <ChevronRight className="w-3.5 h-3.5" />
          <span className="text-slate-600 line-clamp-1">{guide.title}</span>
        </nav>

        {/* Header */}
        <header className="mb-8">
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${getCategoryColor(guide.category)}`}>
              {guide.category}
            </span>
            <span className="text-sm text-slate-400 flex items-center gap-1.5">
              <Clock className="w-4 h-4" /> {guide.readingTime} min de lecture
            </span>
            <span className="text-sm text-slate-400">
              Mis à jour le <time dateTime={guide.updatedDate}>{new Date(guide.updatedDate).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}</time>
            </span>
          </div>
          <h1 className="text-2xl md:text-3xl font-serif font-bold text-primary leading-snug mb-4">
            {guide.title}
          </h1>
          <p className="text-slate-600 text-base leading-relaxed border-l-4 border-primary/30 pl-4 bg-primary/5 py-3 rounded-r-lg">
            {guide.intro}
          </p>
          <p className="mt-4 text-sm text-slate-500">
            Par <span className="font-semibold text-slate-700">Équipe éditoriale Joventy</span> · Les règles sont vérifiées à partir de sources officielles disponibles et peuvent évoluer.
          </p>
        </header>

        {/* Sections */}
        <div className="space-y-10">
          {guide.sections.map((section, i) => (
            <section key={i}>
              <h2 className="text-lg font-bold text-slate-800 mb-3 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0">
                  {i + 1}
                </span>
                {section.heading}
              </h2>
              <p className="text-slate-600 leading-relaxed mb-3">{section.body}</p>
              {section.list && (
                <ul className="space-y-2">
                  {section.list.map((item, j) => (
                    <li key={j} className="flex items-start gap-2.5 text-slate-600 text-sm">
                      <span className="mt-1 w-1.5 h-1.5 rounded-full bg-primary/60 flex-shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              )}
              {section.imageSrc && (
                <figure className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <img
                    src={section.imageSrc}
                    alt={section.imageAlt ?? section.heading}
                    className="mx-auto max-h-[680px] w-auto max-w-full rounded-xl object-contain"
                    loading="lazy"
                  />
                  {section.imageCaption && (
                    <figcaption className="px-2 pt-3 text-center text-xs leading-relaxed text-slate-500">
                      {section.imageCaption}
                    </figcaption>
                  )}
                </figure>
              )}
              {guide.auditCtaAfterSection === i && (
                <div className="mt-6 bg-green-50 border border-green-200 rounded-2xl p-6 flex flex-col sm:flex-row items-center gap-4">
                  <ShieldCheck className="w-10 h-10 text-green-700 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="font-bold text-slate-800 mb-1">Un doute sur votre dossier ?</p>
                    <p className="text-slate-600 text-sm">
                      Faites vérifier vos documents par un expert avant de déposer — verdict par WhatsApp sous 48h, à partir de 25 $.
                    </p>
                  </div>
                  <WhatsAppAuditCTA className="flex-shrink-0" />
                </div>
              )}
              {/* In-article ad after every 4 sections */}
              {(i + 1) % 4 === 0 && i < guide.sections.length - 1 && (
                <AdSenseInArticle slot="4084632507" />
              )}
            </section>
          ))}
        </div>

        {/* Fallback Audit & Diagnostic CTA for guides without a designated risk section */}
        {guide.auditCtaAfterSection === undefined && (
          <div className="my-10 bg-green-50 border border-green-200 rounded-2xl p-6 flex flex-col sm:flex-row items-center gap-4">
            <ShieldCheck className="w-10 h-10 text-green-700 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-bold text-slate-800 mb-1">Un doute sur votre dossier ?</p>
              <p className="text-slate-600 text-sm">
                Faites vérifier vos documents par un expert avant de déposer — verdict par WhatsApp sous 48h, à partir de 25 $.
              </p>
            </div>
            <WhatsAppAuditCTA className="flex-shrink-0" />
          </div>
        )}

        {/* Conversion CTA */}
        {guide.conversion && (
          <section className="my-12 bg-gradient-to-r from-primary to-blue-700 rounded-2xl p-6 sm:p-8 text-white">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
              <div className="flex-1">
                <p className="font-bold text-lg mb-2">{guide.conversion.heading}</p>
                <p className="text-white/75 text-sm leading-relaxed">
                  {guide.conversion.body}
                </p>
              </div>
              <div className="flex flex-col sm:items-end gap-3 flex-shrink-0">
                <Link href={guide.conversion.primaryHref}>
                  <Button className="w-full sm:w-auto bg-secondary hover:bg-secondary/90 text-white font-semibold">
                    {guide.conversion.primaryLabel} <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </Link>
                <a
                  href={`https://wa.me/243840808122?text=${encodeURIComponent(guide.conversion.whatsappMessage)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center text-sm font-semibold text-white/90 hover:text-white underline underline-offset-4"
                >
                  <MessageCircle className="mr-2 h-4 w-4" />
                  {guide.conversion.whatsappLabel}
                </a>
              </div>
            </div>
          </section>
        )}

        {/* FAQ */}
        {guide.faq.length > 0 && (
          <section className="mb-12">
            <h2 className="text-xl font-bold text-primary mb-6 flex items-center gap-2">
              <BookOpen className="w-5 h-5" /> Questions fréquentes
            </h2>
            <div className="space-y-4">
              {guide.faq.map((item, i) => (
                <details key={i} className="group border border-slate-200 rounded-xl overflow-hidden">
                  <summary className="flex items-center justify-between gap-4 px-5 py-4 cursor-pointer font-medium text-slate-800 hover:bg-slate-50 transition-colors list-none">
                    <span>{item.q}</span>
                    <ChevronRight className="w-4 h-4 text-slate-400 group-open:rotate-90 transition-transform flex-shrink-0" />
                  </summary>
                  <div className="px-5 pb-4 text-slate-600 text-sm leading-relaxed border-t border-slate-100 pt-4">
                    {item.a}
                  </div>
                </details>
              ))}
            </div>
          </section>
        )}

        {/* Internal links */}
        {guide.internalLinks && guide.internalLinks.length > 0 && (
          <section className="my-10 rounded-2xl border border-blue-100 bg-blue-50/60 p-6">
            <h2 className="mb-4 text-lg font-bold text-primary">Pour poursuivre votre démarche</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {guide.internalLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="group rounded-xl border border-blue-100 bg-white p-4 transition-colors hover:border-primary/30 hover:shadow-sm"
                >
                  <span className="font-semibold text-slate-800 transition-colors group-hover:text-primary">
                    {link.label}
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-slate-500">
                    {link.description}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="my-10 rounded-2xl border border-amber-200 bg-amber-50/70 p-6">
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">Provenance</p>
            <h2 className="mt-1 text-lg font-bold text-primary">Sources officielles et vérification</h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">
              Ce guide distingue les informations publiées par les autorités de nos conseils pratiques. Vérifiez toujours la source officielle avant de déposer, car les règles et disponibilités peuvent changer.
            </p>
          </div>
          {officialLinks.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {officialLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-start gap-3 rounded-xl border border-amber-200 bg-white p-4 transition-colors hover:border-amber-400 hover:shadow-sm"
                >
                  <ExternalLink className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-700" />
                  <span>
                    <span className="font-semibold text-slate-800 transition-colors group-hover:text-primary">{link.label}</span>
                    <span className="mt-1 block text-sm leading-relaxed text-slate-500">{link.description}</span>
                  </span>
                </a>
              ))}
            </div>
          ) : (
            <p className="text-sm leading-relaxed text-slate-600">
              Consultez le portail officiel de la destination concernée avant toute démarche ; aucun lien n’est affiché ici lorsqu’il n’est pas identifié dans nos données.
            </p>
          )}
        </section>

        {/* Related destination */}
        {guide.relatedDestination && (
          <div className="mb-10 bg-slate-50 border border-slate-200 rounded-xl p-5 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Page destination associée</p>
              <p className="font-semibold text-slate-800">Voir nos tarifs et services pour cette destination</p>
            </div>
            <Link href={`/${guide.relatedDestination}`}>
              <Button variant="outline" size="sm" className="flex-shrink-0">
                Voir la page <ChevronRight className="ml-1 w-4 h-4" />
              </Button>
            </Link>
          </div>
        )}

        {/* Related guides */}
        {relatedGuides.length > 0 && (
          <section>
            <h2 className="text-lg font-bold text-slate-800 mb-4">Guides associés</h2>
            <div className="grid sm:grid-cols-3 gap-4">
              {relatedGuides.map((g) => (
                <Link key={g.slug} href={`/guides/${g.slug}`} className="group block">
                  <div className="bg-white border border-slate-100 rounded-xl p-4 hover:shadow-md hover:border-primary/20 transition-all h-full flex flex-col">
                    <span className="text-2xl mb-2">{g.coverEmoji}</span>
                    <p className="text-sm font-semibold text-slate-700 group-hover:text-primary transition-colors line-clamp-2 flex-1">
                      {g.title}
                    </p>
                    <span className="mt-3 text-xs text-primary flex items-center gap-0.5 font-medium">
                      Lire <ChevronRight className="w-3 h-3" />
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}
      </article>

      {/* WhatsApp floating */}
      <a
        href="https://wa.me/243840808122"
        target="_blank"
        rel="noreferrer"
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 bg-[#25D366] text-white text-sm font-semibold px-4 py-3 rounded-full shadow-lg hover:bg-[#1ebe5d] transition-colors sm:right-24"
      >
        <MessageCircle className="w-5 h-5" />
        WhatsApp
      </a>

    </PublicLayout>
  );
}