import type { Plugin, IndexHtmlTransformContext } from "vite";
import { DESTINATIONS_SEO } from "./src/data/destinations-seo";
import { getGuideBySlug, getAllGuides } from "./src/data/guides-seo";

export type { Guide } from "./src/data/guides-seo";
export { getAllGuides, DESTINATIONS_SEO };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function replaceMeta(html: string, tag: string, newContent: string): string {
  const re = new RegExp(`<meta\\s+${tag}\\s+content="[^"]*"`);
  return html.replace(re, `<meta ${tag} content="${newContent}"`);
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
      "@type": "LocalBusiness",
      name: "Joventy",
      url: "https://joventy.cd",
      telephone: "+243840808122",
      address: { "@type": "PostalAddress", addressLocality: "Kinshasa", addressCountry: "CD" },
    },
    areaServed: { "@type": "Place", name: "Kinshasa, République Démocratique du Congo" },
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: "4.9",
      bestRating: "5",
      worstRating: "1",
      reviewCount: "127",
    },
  });
  return [
    `<script type="application/ld+json">${faq}</script>`,
    `<script type="application/ld+json">${breadcrumb}</script>`,
    `<script type="application/ld+json">${service}</script>`,
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
    author: { "@type": "Organization", name: "Joventy", url: "https://joventy.cd" },
    publisher: {
      "@type": "Organization",
      name: "Joventy",
      logo: { "@type": "ImageObject", url: "https://joventy.cd/logo.png" },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
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

export function injectSeoMeta(html: string, pathname: string): string {
  const clean = pathname.split("?")[0].replace(/\/$/, "") || "/";

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
      .replace("</head>", `${schemas}\n</head>`);
  }

  const guideMatch = clean.match(/^\/guides\/([^/?]+)$/);
  if (guideMatch) {
    const guide = getGuideBySlug(guideMatch[1]);
    if (guide) {
      const url = `https://joventy.cd/guides/${guide.slug}`;
      const schemas = buildGuideSchemas(guide, url);
      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${esc(guide.metaTitle)}</title>`)
        .replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${esc(guide.metaDescription)}"`)
        .replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${url}"`)
        .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${esc(guide.metaTitle)}"`)
        .replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${esc(guide.metaDescription)}"`)
        .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${url}"`)
        .replace(/<meta property="og:type" content="[^"]*"/, `<meta property="og:type" content="article"`)
        .replace(/<meta name="twitter:title" content="[^"]*"/, `<meta name="twitter:title" content="${esc(guide.metaTitle)}"`)
        .replace(/<meta name="twitter:description" content="[^"]*"/, `<meta name="twitter:description" content="${esc(guide.metaDescription)}"`)
        .replace("</head>", `${schemas}\n</head>`);
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
          /^\/visa-/.test(pathname) || /^\/guides\//.test(pathname);

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
