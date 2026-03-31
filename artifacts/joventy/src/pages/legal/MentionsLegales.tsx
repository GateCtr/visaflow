import { LegalLayout } from "@/components/layout/LegalLayout";

export default function MentionsLegales() {
  return (
    <LegalLayout
      title="Mentions légales"
      subtitle="Informations légales relatives au site joventy.cd"
      lastUpdated="Mars 2025"
    >
      <h2>1. Éditeur du site</h2>
      <p>
        Le site <strong>joventy.cd</strong> est un site vitrine institutionnel présentant un service
        édité par <strong>Akollad Groupe S.A.S.</strong>, holding technologique de droit congolais
        dont le siège est établi à Kinshasa, République Démocratique du Congo.
      </p>
      <ul>
        <li><strong>Dénomination sociale :</strong> Akollad Groupe S.A.S.</li>
        <li><strong>Forme juridique :</strong> Société par Actions Simplifiée (S.A.S.)</li>
        <li><strong>Siège social :</strong> Kinshasa, République Démocratique du Congo</li>
        <li><strong>RCCM :</strong> CD/KNG/RCCM/25-A-07960</li>
        <li><strong>Numéro d'Impôt :</strong> A2557944L</li>
        <li><strong>Identifiant National :</strong> 01-J6100-N86614P</li>
        <li><strong>Site groupe :</strong> <a href="https://akollad.com" target="_blank" rel="noreferrer">akollad.com</a></li>
        <li><strong>Email :</strong> <a href="mailto:contact@joventy.cd">contact@joventy.cd</a></li>
        <li><strong>WhatsApp :</strong> <a href="https://wa.me/243840808122">+243 840 808 122</a></li>
      </ul>

      <h2>2. Directeur de la publication</h2>
      <p>
        Le directeur de la publication du site est le représentant légal d'Akollad Groupe S.A.S.
        Pour toute question relative au contenu du site, vous pouvez le contacter à l'adresse
        e-mail : <a href="mailto:contact@joventy.cd">contact@joventy.cd</a>.
      </p>

      <h2>3. Hébergement</h2>
      <p>Le site joventy.cd est hébergé par les prestataires techniques suivants :</p>
      <ul>
        <li>
          <strong>Convex, Inc.</strong> — Infrastructure de base de données et backend en temps réel<br />
          555 Twin Dolphin Drive, Redwood City, CA 94065, États-Unis<br />
          Site : <a href="https://www.convex.dev" target="_blank" rel="noreferrer">www.convex.dev</a>
        </li>
        <li>
          <strong>Replit, Inc.</strong> — Hébergement de l'application<br />
          Site : <a href="https://replit.com" target="_blank" rel="noreferrer">replit.com</a>
        </li>
        <li>
          <strong>Clerk, Inc.</strong> — Gestion de l'authentification et des comptes utilisateurs<br />
          Site : <a href="https://clerk.com" target="_blank" rel="noreferrer">clerk.com</a>
        </li>
      </ul>

      <h2>4. Propriété intellectuelle</h2>
      <p>
        L'ensemble du contenu du site joventy.cd (textes, images, logos, graphismes, icônes,
        structure, logiciels, bases de données, etc.) est la propriété exclusive d'Akollad Groupe S.A.S.
        ou de ses partenaires, et est protégé par les lois en vigueur sur la propriété intellectuelle.
      </p>
      <p>
        Toute reproduction, représentation, modification, publication ou adaptation de tout ou
        partie des éléments du site, quel que soit le moyen ou le procédé utilisé, est
        <strong> interdite, sauf autorisation écrite préalable</strong> d'Akollad Groupe S.A.S.
      </p>
      <p>
        Le non-respect de cette interdiction constitue une contrefaçon pouvant engager la
        responsabilité civile et pénale du contrefacteur.
      </p>

      <h2>5. Nature du service</h2>
      <p>
        Joventy est une <strong>société d'assistance administrative</strong> spécialisée dans la
        préparation et le dépôt des dossiers de demande de visa. Joventy n'est ni un consulat,
        ni une ambassade, ni un organisme gouvernemental.
      </p>
      <p>
        La décision d'accorder ou de refuser un visa appartient exclusivement aux autorités
        consulaires ou gouvernementales du pays de destination. Joventy ne peut pas garantir
        l'approbation d'une demande de visa.
      </p>

      <h2>6. Limitation de responsabilité</h2>
      <p>
        Joventy s'engage à fournir des informations aussi précises et actualisées que possible sur
        son site. Toutefois, elle ne saurait être tenue responsable des omissions, inexactitudes
        ou carences dans la mise à jour des informations, qu'elles soient de son fait ou du fait
        des tiers partenaires qui lui fournissent ces informations.
      </p>
      <p>
        Joventy ne saurait être tenue responsable des dommages directs ou indirects causés au
        matériel de l'utilisateur, lors de l'accès au site joventy.cd, résultant de l'utilisation
        d'un matériel non conforme aux spécifications techniques requises.
      </p>

      <h2>7. Liens hypertextes</h2>
      <p>
        Le site joventy.cd peut contenir des liens hypertextes vers d'autres sites internet
        (ambassades, portails gouvernementaux, centres VFS, etc.). Joventy n'exerce aucun contrôle
        sur ces sites et décline toute responsabilité quant à leur contenu ou aux pratiques de
        protection des données qui y sont appliquées.
      </p>

      <h2>8. Droit applicable et juridiction compétente</h2>
      <p>
        Les présentes mentions légales sont soumises au droit de la République Démocratique du Congo.
        En cas de litige et à défaut de résolution amiable, les tribunaux compétents de Kinshasa
        seront seuls habilités à en connaître.
      </p>

      <h2>9. Contact</h2>
      <p>
        Pour toute question relative aux présentes mentions légales, vous pouvez nous contacter :
      </p>
      <ul>
        <li>Par e-mail : <a href="mailto:contact@joventy.cd">contact@joventy.cd</a></li>
        <li>Via WhatsApp : <a href="https://wa.me/243840808122">+243 840 808 122</a></li>
      </ul>
    </LegalLayout>
  );
}
