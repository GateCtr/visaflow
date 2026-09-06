import { Link } from "wouter";
import { JoventyLogo } from "@/components/JoventyLogo";
import { LegalFooterNote } from "@/components/LegalFooterNote";

const FLAG_SIZES = [20, 40, 80, 160, 320, 640];
function snapFlagSize(n: number) {
  return FLAG_SIZES.find((s) => s >= n) ?? 80;
}
function FlagImg({ code, size = 20, className = "" }: { code: string; size?: number; className?: string }) {
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

const DESTINATIONS = [
  { code: "us", label: "Visa USA", href: "/visa-usa-kinshasa" },
  { code: "ca", label: "Visa Canada", href: "/visa-canada-kinshasa" },
  { code: "gb", label: "Visa Royaume-Uni", href: "/visa-royaume-uni-kinshasa" },
  { code: "eu", label: "Visa Schengen", href: "/visa-schengen-kinshasa" },
  { code: "es", label: "Visa Espagne", href: "/visa-espagne-kinshasa" },
  { code: "fr", label: "France long séjour", href: "/visa-france-long-sejour-kinshasa" },
  { code: "be", label: "Belgique long séjour", href: "/visa-belgique-long-sejour-kinshasa" },
  { code: "de", label: "Allemagne type D", href: "/visa-allemagne-kinshasa" },
  { code: "ch", label: "Visa Suisse", href: "/visa-suisse-kinshasa" },
  { code: "ae", label: "E-Visa Dubaï", href: "/e-visa-dubai-kinshasa" },
  { code: "tr", label: "Visa Turquie", href: "/visa-turquie-kinshasa" },
  { code: "ma", label: "Visa Maroc", href: "/visa-maroc-kinshasa" },
  { code: "eg", label: "Visa Égypte", href: "/e-visa-egypte-kinshasa" },
  { code: "cn", label: "Visa Chine", href: "/visa-chine-kinshasa" },
  { code: "in", label: "E-Visa Inde", href: "/e-visa-inde-kinshasa" },
  { code: "br", label: "Visa Brésil", href: "/visa-bresil-kinshasa" },
];

const AMBASSADES = [
  { code: "us", label: "Ambassade USA", href: "/ambassade-usa-kinshasa" },
  { code: "ca", label: "Ambassade Canada", href: "/ambassade-canada-kinshasa" },
  { code: "gb", label: "Ambassade Royaume-Uni", href: "/ambassade-royaume-uni-kinshasa" },
  { code: "fr", label: "Ambassade France", href: "/ambassade-schengen-france-kinshasa" },
  { code: "de", label: "Ambassade Allemagne", href: "/ambassade-allemagne-kinshasa" },
  { code: "be", label: "Ambassade Belgique", href: "/ambassade-belgique-kinshasa" },
  { code: "es", label: "Ambassade Espagne", href: "/ambassade-espagne-kinshasa" },
  { code: "cn", label: "Ambassade Chine", href: "/ambassade-chine-kinshasa" },
  { code: "cd", label: "Toutes les ambassades →", href: "/ambassades" },
];

const GUIDES = [
  { label: "🌍 Purger 21 jours (Ebola)", href: "/guides/purger-21-jours-ebola-pays-neutre-visa-usa-2026" },
  { label: "🚨 Suspension Canada RDC", href: "/guides/suspension-visa-canada-rdc-ebola-2026" },
  { label: "⚽ Coupe du Monde 2026", href: "/guides/coupe-du-monde-2026-visa-usa-kinshasa" },
  { label: "Créneau visa USA", href: "/guides/comment-obtenir-creneau-visa-usa-kinshasa" },
  { label: "Documents Schengen", href: "/guides/documents-visa-schengen-kinshasa" },
  { label: "Rendez-vous CEV Kinshasa", href: "/guides/rendez-vous-cev-kinshasa-visa-schengen" },
  { label: "Visa Belgique long séjour", href: "/guides/visa-belgique-long-sejour-kinshasa-procedure" },
  { label: "Aucun créneau CEV ?", href: "/guides/aucun-creneau-rendez-vous-cev-kinshasa" },
  { label: "RDV Espagne 2026", href: "/guides/visa-espagne-kinshasa-rendez-vous-ambassade-2026" },
  { label: "Tous les guides →", href: "/guides" },
];

const LEGAL = [
  { label: "Mentions légales", href: "/mentions-legales" },
  { label: "Politique de confidentialité", href: "/confidentialite" },
  { label: "Conditions d'utilisation", href: "/conditions" },
  { label: "Politique de remboursement", href: "/remboursement" },
];

export function PublicFooter() {
  return (
    <footer className="bg-primary text-white py-14">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-10 mb-10">

          {/* Brand column */}
          <div className="md:col-span-1">
            <JoventyLogo variant="dark" size="md" />
            <p className="mt-4 text-white/55 text-sm leading-relaxed max-w-xs">
              Assistance visa premium pour les voyageurs congolais. Formulaires, créneaux, e-Visas — nous gérons tout.
            </p>
            <div className="mt-5 flex flex-col gap-1.5 text-xs text-white/40">
              <a href="mailto:contact@joventy.cd" className="hover:text-white transition-colors">✉ contact@joventy.cd</a>
              <a href="https://wa.me/243840808122" target="_blank" rel="noopener noreferrer nofollow" className="hover:text-white transition-colors">
                💬 +243 840 808 122
              </a>
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              <Link href="/alerte-espagne" className="inline-flex items-center gap-1.5 bg-white/10 hover:bg-white/15 transition-colors border border-white/10 rounded-xl px-3 py-1.5 text-xs font-semibold text-white/70">
                🇪🇸 Alerte Espagne
              </Link>
              <Link href="/alerte-schengen" className="inline-flex items-center gap-1.5 bg-white/10 hover:bg-white/15 transition-colors border border-white/10 rounded-xl px-3 py-1.5 text-xs font-semibold text-white/70">
                🇧🇪 Alerte Schengen
              </Link>
              <Link href="/audit-diagnostic" className="inline-flex items-center gap-1.5 bg-white/10 hover:bg-white/15 transition-colors border border-white/10 rounded-xl px-3 py-1.5 text-xs font-semibold text-white/70">
                🔍 Audit & Diagnostic
              </Link>
            </div>
          </div>

          {/* Destinations */}
          <div>
            <h4 className="font-bold text-sm uppercase tracking-wider text-white/65 mb-4">Destinations visa</h4>
            <ul className="space-y-2 text-sm text-white/50">
              {DESTINATIONS.map((d) => (
                <li key={d.code}>
                  <Link href={d.href} className="hover:text-white transition-colors flex items-center gap-2">
                    <FlagImg code={d.code} size={20} className="opacity-90" />
                    {d.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Ambassades */}
          <div>
            <h4 className="font-bold text-sm uppercase tracking-wider text-white/65 mb-4">Ambassades à Kinshasa</h4>
            <ul className="space-y-2 text-sm text-white/50">
              {AMBASSADES.map((d) => (
                <li key={d.code}>
                  <Link href={d.href} className="hover:text-white transition-colors flex items-center gap-2">
                    <FlagImg code={d.code} size={20} className="opacity-90" />
                    {d.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Guides */}
          <div>
            <h4 className="font-bold text-sm uppercase tracking-wider text-white/65 mb-4">Guides populaires</h4>
            <ul className="space-y-2 text-sm text-white/50">
              {GUIDES.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="hover:text-white transition-colors">{l.label}</Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Légal */}
          <div>
            <h4 className="font-bold text-sm uppercase tracking-wider text-white/65 mb-4">Légal</h4>
            <ul className="space-y-2 text-sm text-white/50">
              {LEGAL.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="hover:text-white transition-colors">{l.label}</Link>
                </li>
              ))}
            </ul>
            <div className="mt-6 space-y-1.5 text-sm text-white/50">
              <Link href="/prix" className="block hover:text-white transition-colors">Tarifs</Link>
              <Link href="/a-propos" className="block hover:text-white transition-colors">À propos</Link>
            </div>
          </div>
        </div>

        <div className="pt-8 border-t border-white/10 flex flex-col sm:flex-row justify-between items-center gap-4 text-xs text-white/35">
          <p>© {new Date().getFullYear()} Joventy · Un service{" "}
            <a href="https://akollad.com" target="_blank" rel="noreferrer nofollow" className="hover:text-white/60 underline underline-offset-2">Akollad Groupe</a>
            {" "}· Kinshasa, RDC
          </p>
          <p>Paiement via M-Pesa, Airtel Money & Orange Money 🇨🇩</p>
        </div>
        <div className="pt-5 mt-5 border-t border-white/10 text-white/35">
          <LegalFooterNote />
        </div>
      </div>
    </footer>
  );
}
