/**
 * Shared "Transparence & Légalité" block shown at the bottom of every public footer.
 * Displays Joventy's official company identifiers (Akollad Groupe) so visitors
 * can verify the business is a legally registered Congolese company.
 */
export function LegalFooterNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[11px] leading-relaxed ${className}`}>
      Joventy est une plateforme numérique éditée et gérée par{" "}
      <a
        href="https://akollad.com"
        target="_blank"
        rel="noreferrer nofollow"
        className="underline underline-offset-2 hover:text-white transition-colors"
      >
        Akollad Groupe
      </a>
      , entreprise de droit congolais enregistrée à Kinshasa.
      <br className="hidden sm:block" />
      {" "}RCCM&nbsp;: CD/KNG/RCCM/25-A-07960 &nbsp;|&nbsp; N° Impôt&nbsp;: A2557944L &nbsp;|&nbsp; ID Nat&nbsp;: 01-J6100-N86614P
    </p>
  );
}
