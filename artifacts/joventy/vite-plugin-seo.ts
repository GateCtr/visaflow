import type { Plugin, IndexHtmlTransformContext } from "vite";
import { DESTINATIONS_SEO } from "./src/data/destinations-seo";
import { getGuideBySlug, getAllGuides } from "./src/data/guides-seo";
import { EMBASSIES_SEO, getEmbassyBySlug } from "./src/data/embassies-seo";
import { CRENEAUX_PAGES, getCreneauxPageBySlug } from "./src/data/creneaux-seo";

export type { Guide } from "./src/data/guides-seo";
export { getAllGuides, DESTINATIONS_SEO, EMBASSIES_SEO, CRENEAUX_PAGES };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function appendBeforeHeadClose(html: string, tags: string[]): string {
  if (tags.length === 0) return html;
  return html.replace("</head>", `${tags.join("\n")}\n</head>`);
}

function buildDestSchemas(dest: (typeof DESTINATIONS_SEO)[0], url: string): string {
  const faq = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: dest.faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  });
  const breadcrumb = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Accueil", item: "https://joventy.cd/" },
      { "@type": "ListItem", position: 2, name: dest.name, item: url },
    ],
  });
  const service = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Service",
    name: `Assistance Visa ${dest.name} depuis Kinshasa`,
    description: dest.metaDescription,
    url,
    provider: {
      "@id": "https://joventy.cd/#organization",
    },
    areaServed: { "@type": "Place", name: "Kinshasa, République Démocratique du Congo" },
  });
  return [
    `<script type="application/ld+json">${faq}</script>`,
    `<script type="application/ld+json">${breadcrumb}</script>`,
    `<script type="application/ld+json">${service}</script>`,
  ].join("\n");
}

function buildArticleMeta(publishedTime: string, modifiedTime: string): string[] {
  return [
    `<meta property="article:published_time" content="${publishedTime}" />`,
    `<meta property="article:modified_time" content="${modifiedTime}" />`,
  ];
}

function buildMethodologySchemas(): string {
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": ["WebPage", "AboutPage"],
    "@id": "https://joventy.cd/methodologie-sources#webpage",
    url: "https://joventy.cd/methodologie-sources",
    name: "Méthodologie et sources — Joventy",
    description: "Méthode de vérification des informations visa publiées par Joventy.",
    isPartOf: { "@id": "https://joventy.cd/#website" },
    about: { "@id": "https://joventy.cd/#organization" },
    publisher: { "@id": "https://joventy.cd/#organization" },
    inLanguage: "fr",
  });
}

function buildEmbassySchemas(embassy: NonNullable<ReturnType<typeof getEmbassyBySlug>>, url: string): string {
  const faq = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: embassy.faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  });
  const breadcrumb = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Accueil", item: "https://joventy.cd/" },
      { "@type": "ListItem", position: 2, name: embassy.officialName, item: url },
    ],
  });
  const govOffice = JSON.stringify({
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
  });
  return [
    `<script type="application/ld+json">${faq}</script>`,
    `<script type="application/ld+json">${breadcrumb}</script>`,
    `<script type="application/ld+json">${govOffice}</script>`,
  ].join("\n");
}

function buildGuideSchemas(guide: NonNullable<ReturnType<typeof getGuideBySlug>>, url: string): string {
  const article = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: guide.title,
    description: guide.metaDescription,
    datePublished: guide.publishedDate,
    dateModified: guide.updatedDate,
    author: { "@type": "Organization", "@id": "https://joventy.cd/#organization", name: "Équipe éditoriale Joventy" },
    publisher: { "@id": "https://joventy.cd/#organization" },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    isPartOf: { "@id": "https://joventy.cd/#website" },
  });
  const breadcrumb = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Accueil", item: "https://joventy.cd/" },
      { "@type": "ListItem", position: 2, name: "Guides", item: "https://joventy.cd/guides" },
      { "@type": "ListItem", position: 3, name: guide.title, item: url },
    ],
  });
  const parts = [
    `<script type="application/ld+json">${article}</script>`,
    `<script type="application/ld+json">${breadcrumb}</script>`,
  ];
  if (guide.faq.length > 0) {
    const faq = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: guide.faq.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
    parts.push(`<script type="application/ld+json">${faq}</script>`);
  }
  return parts.join("\n");
}

function buildCreneauxSchemas(page: (typeof CRENEAUX_PAGES)[0], url: string): string {
  const service = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Service",
    name: `Créneau Visa ${page.name} depuis Kinshasa`,
    description: page.metaDescription,
    url,
    provider: {
      "@id": "https://joventy.cd/#organization",
    },
    areaServed: { "@type": "Place", name: "Kinshasa, République Démocratique du Congo" },
    hasOfferCatalog: {
      "@type": "OfferCatalog",
      name: "Formules créneau Joventy",
      itemListElement: [
        { "@type": "Offer", name: "Créneau normal", priceCurrency: "USD", price: "350" },
        { "@type": "Offer", name: "Créneau express", priceCurrency: "USD", price: "500" },
      ],
    },
  });
  const faq = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: page.faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  });
  const breadcrumb = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Accueil", item: "https://joventy.cd/" },
      { "@type": "ListItem", position: 2, name: "Tarifs", item: "https://joventy.cd/prix" },
      { "@type": "ListItem", position: 3, name: `Créneau ${page.name}`, item: url },
    ],
  });
  return [
    `<script type="application/ld+json">${service}</script>`,
    `<script type="application/ld+json">${faq}</script>`,
    `<script type="application/ld+json">${breadcrumb}</script>`,
  ].join("\n");
}

export function injectSeoMeta(html: string, pathname: string): string {
  const clean = pathname.split("?")[0].replace(/\/$/, "") || "/";

  if (clean === "/methodologie-sources") {
    const title = "Méthodologie et sources visa | Joventy";
    const description = "Découvrez comment Joventy distingue les sources officielles des conseils pratiques, présente ses limites et affiche ses tarifs d’assistance visa.";
    const url = "https://joventy.cd/methodologie-sources";
    const schema = buildMethodologySchemas();
    return appendBeforeHeadClose(
      html
        .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
        .replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${esc(description)}"`)
        .replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${url}"`)
        .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${title}"`)
        .replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${esc(description)}"`)
        .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${url}"`),
      [`<script type="application/ld+json">${schema}</script>`],
    );
  }

  // Créneau landing pages
  const creneauxSlug = clean.replace(/^\//, "");
  const creneauxPage = getCreneauxPageBySlug(creneauxSlug);
  if (creneauxPage) {
    const url = `https://joventy.cd/${creneauxPage.slug}`;
    const schemas = buildCreneauxSchemas(creneauxPage, url);
    return html
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(creneauxPage.title)}</title>`)
      .replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${esc(creneauxPage.metaDescription)}"`)
      .replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${url}"`)
      .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${esc(creneauxPage.title)}"`)
      .replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${esc(creneauxPage.metaDescription)}"`)
      .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${url}"`)
      .replace(/<meta name="twitter:title" content="[^"]*"/, `<meta name="twitter:title" content="${esc(creneauxPage.title)}"`)
      .replace(/<meta name="twitter:description" content="[^"]*"/, `<meta name="twitter:description" content="${esc(creneauxPage.metaDescription)}"`)
      .replace(/<meta property="og:image" content="[^"]*"/, `<meta property="og:image" content="https://joventy.cd/opengraph.jpg"`)
      .replace(/<meta property="og:image:alt" content="[^"]*"/, `<meta property="og:image:alt" content="${esc(`Créneau Visa ${creneauxPage.name} depuis Kinshasa avec Joventy`)}"`)
      .replace(/<meta name="twitter:image" content="[^"]*"/, `<meta name="twitter:image" content="https://joventy.cd/opengraph.jpg"`)
      .replace("</head>", `${schemas}\n</head>`);
  }

  const destSlug = clean.replace(/^\//, "");
  const dest = DESTINATIONS_SEO.find((d) => d.slug === destSlug);
  if (dest) {
    const url = `https://joventy.cd/${dest.slug}`;
    const schemas = buildDestSchemas(dest, url);
    return html
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(dest.title)}</title>`)
      .replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${esc(dest.metaDescription)}"`)
      .replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${url}"`)
      .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${esc(dest.title)}"`)
      .replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${esc(dest.metaDescription)}"`)
      .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${url}"`)
      .replace(/<meta name="twitter:title" content="[^"]*"/, `<meta name="twitter:title" content="${esc(dest.title)}"`)
      .replace(/<meta name="twitter:description" content="[^"]*"/, `<meta name="twitter:description" content="${esc(dest.metaDescription)}"`)
      .replace(/<meta property="og:image" content="[^"]*"/, `<meta property="og:image" content="https://joventy.cd/opengraph.jpg"`)
      .replace(/<meta property="og:image:alt" content="[^"]*"/, `<meta property="og:image:alt" content="${esc(`${dest.name} depuis Kinshasa avec Joventy`)}"`)
      .replace(/<meta name="twitter:image" content="[^"]*"/, `<meta name="twitter:image" content="https://joventy.cd/opengraph.jpg"`)
      .replace("</head>", `${schemas}\n</head>`);
  }

  const embassySlug = clean.replace(/^\//, "");
  const embassy = EMBASSIES_SEO.find((e) => e.slug === embassySlug);
  if (embassy) {
    const url = `https://joventy.cd/${embassy.slug}`;
    const schemas = buildEmbassySchemas(embassy, url);
    return html
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(embassy.title)}</title>`)
      .replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${esc(embassy.metaDescription)}"`)
      .replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${url}"`)
      .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${esc(embassy.title)}"`)
      .replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${esc(embassy.metaDescription)}"`)
      .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${url}"`)
      .replace(/<meta name="twitter:title" content="[^"]*"/, `<meta name="twitter:title" content="${esc(embassy.title)}"`)
      .replace(/<meta name="twitter:description" content="[^"]*"/, `<meta name="twitter:description" content="${esc(embassy.metaDescription)}"`)
      .replace(/<meta property="og:image" content="[^"]*"/, `<meta property="og:image" content="https://joventy.cd/opengraph.jpg"`)
      .replace(/<meta property="og:image:alt" content="[^"]*"/, `<meta property="og:image:alt" content="${esc(`${embassy.officialName} à Kinshasa`)}"`)
      .replace(/<meta name="twitter:image" content="[^"]*"/, `<meta name="twitter:image" content="https://joventy.cd/opengraph.jpg"`)
      .replace("</head>", `${schemas}\n</head>`);
  }

  const guideMatch = clean.match(/^\/guides\/([^/?]+)$/);
  if (guideMatch) {
    const guide = getGuideBySlug(guideMatch[1]);
    if (guide) {
      const url = `https://joventy.cd/guides/${guide.slug}`;
      const schemas = buildGuideSchemas(guide, url);
      const articleMeta = buildArticleMeta(guide.publishedDate, guide.updatedDate);
      const updated = html
        .replace(/<title>[^<]*<\/title>/, `<title>${esc(guide.metaTitle)}</title>`)
        .replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${esc(guide.metaDescription)}"`)
        .replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${url}"`)
        .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${esc(guide.metaTitle)}"`)
        .replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${esc(guide.metaDescription)}"`)
        .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${url}"`)
        .replace(/<meta property="og:type" content="[^"]*"/, `<meta property="og:type" content="article"`)
        .replace(/<meta name="twitter:title" content="[^"]*"/, `<meta name="twitter:title" content="${esc(guide.metaTitle)}"`)
        .replace(/<meta name="twitter:description" content="[^"]*"/, `<meta name="twitter:description" content="${esc(guide.metaDescription)}"`)
        .replace(/<meta property="og:image" content="[^"]*"/, `<meta property="og:image" content="https://joventy.cd/opengraph.jpg"`)
        .replace(/<meta property="og:image:alt" content="[^"]*"/, `<meta property="og:image:alt" content="${esc(guide.title)}"`)
        .replace(/<meta name="twitter:image" content="[^"]*"/, `<meta name="twitter:image" content="https://joventy.cd/opengraph.jpg"`)
      return appendBeforeHeadClose(updated, [...articleMeta, schemas]);
    }
  }

  return html;
}

export function seoMetaInjectPlugin(): Plugin {
  return {
    name: "joventy-seo-meta-inject",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const orig = res.end.bind(res);
        const url = (req as any).url ?? "/";
        const pathname = url.split("?")[0];

        const isHtmlRoute =
          !pathname.includes(".") ||
          pathname.endsWith(".html");
        const isSemanticRoute =
          /^\/visa-/.test(pathname) || /^\/guides\//.test(pathname) ||
          /^\/e-visa-/.test(pathname) || /^\/ambassade/.test(pathname) ||
          /^\/creneaux-/.test(pathname);

        if (!isHtmlRoute || !isSemanticRoute) return next();

        const chunks: Buffer[] = [];
        const origWrite = res.write.bind(res);

        (res as any).write = (chunk: any, ...args: any[]) => {
          if (Buffer.isBuffer(chunk)) chunks.push(chunk);
          else if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
          else return (origWrite as any)(chunk, ...args);
          return true;
        };

        (res as any).end = (chunk?: any, ...args: any[]) => {
          if (chunk) {
            if (Buffer.isBuffer(chunk)) chunks.push(chunk);
            else if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
          }

          const body = Buffer.concat(chunks).toString("utf-8");
          const ct = res.getHeader("content-type") as string | undefined;

          if (ct?.includes("text/html") && body.includes("</head>")) {
            const injected = injectSeoMeta(body, pathname);
            const buf = Buffer.from(injected, "utf-8");
            res.setHeader("content-length", buf.length);
            (orig as any)(buf, ...args);
          } else {
            (orig as any)(Buffer.concat(chunks), ...args);
          }
        };

        next();
      });
    },
  };
}
