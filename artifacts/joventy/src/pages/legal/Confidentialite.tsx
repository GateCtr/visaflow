import { LegalLayout } from "@/components/layout/LegalLayout";

export default function Confidentialite() {
  return (
    <LegalLayout
      title="Politique de confidentialité"
      subtitle="Comment Joventy collecte, utilise et protège vos données personnelles"
      lastUpdated="Mars 2025"
    >
      <p>
        La protection de vos données personnelles est une priorité pour Joventy. La présente
        politique décrit de manière transparente quelles données nous collectons, pourquoi, comment
        nous les utilisons et quels sont vos droits.
      </p>

      <h2>1. Responsable du traitement</h2>
      <p>
        Le responsable du traitement de vos données personnelles est :<br />
        <strong>Akollad Groupe S.A.S.</strong>, holding technologique dont le siège est établi à
        Kinshasa, République Démocratique du Congo (RCCM : CD/KNG/RCCM/25-A-07960 —
        N° Impôt : A2557944L — ID : 01-J6100-N86614P).<br />
        Site groupe : <a href="https://akollad.com" target="_blank" rel="noreferrer">akollad.com</a> —
        Contact : <a href="mailto:contact@joventy.cd">contact@joventy.cd</a>
      </p>

      <h2>2. Données collectées</h2>
      <p>Joventy collecte les données suivantes dans le cadre de la fourniture de ses services :</p>

      <h3>2.1 Données d'identification</h3>
      <ul>
        <li>Nom complet, prénom</li>
        <li>Adresse e-mail</li>
        <li>Numéro de téléphone (WhatsApp)</li>
        <li>Numéro de passeport et date d'expiration</li>
        <li>Date de naissance et nationalité</li>
      </ul>

      <h3>2.2 Documents personnels</h3>
      <ul>
        <li>Scans de passeport et pièces d'identité</li>
        <li>Photos d'identité</li>
        <li>Relevés bancaires et documents financiers</li>
        <li>Attestations de travail ou documents professionnels</li>
        <li>Tout autre document nécessaire à la constitution du dossier de visa</li>
      </ul>

      <h3>2.3 Données de navigation</h3>
      <ul>
        <li>Adresse IP</li>
        <li>Type de navigateur et système d'exploitation</li>
        <li>Pages visitées et durée de visite (à des fins statistiques)</li>
      </ul>

      <h3>2.4 Données de communication</h3>
      <ul>
        <li>Messages échangés dans l'espace client avec nos conseillers</li>
        <li>Historique des échanges par e-mail ou WhatsApp</li>
      </ul>

      <h2>3. Finalités du traitement</h2>
      <p>Vos données sont collectées et traitées pour les finalités suivantes :</p>
      <ul>
        <li><strong>Constitution et gestion de votre dossier de visa</strong> — finalité principale</li>
        <li>Vérification de votre identité et de la conformité de vos documents</li>
        <li>Communication avec les autorités consulaires et organismes visés (ambassades, VFS, etc.)</li>
        <li>Traitement des paiements mobiles et tenue des registres comptables</li>
        <li>Amélioration de nos services (statistiques anonymisées)</li>
        <li>Respect de nos obligations légales et réglementaires</li>
      </ul>

      <h2>4. Base légale du traitement</h2>
      <p>Le traitement de vos données repose sur les bases légales suivantes :</p>
      <ul>
        <li><strong>Exécution du contrat</strong> : vos données sont nécessaires pour vous fournir le service commandé</li>
        <li><strong>Consentement</strong> : pour les communications commerciales et la collecte de témoignages</li>
        <li><strong>Obligations légales</strong> : conservation de certains documents à des fins comptables ou réglementaires</li>
      </ul>

      <h2>5. Destinataires des données</h2>
      <p>
        Vos données personnelles sont strictement confidentielles. Elles peuvent être
        communiquées aux destinataires suivants dans la limite de ce qui est strictement nécessaire :
      </p>
      <ul>
        <li>
          <strong>Autorités consulaires et gouvernementales</strong> du pays de destination
          (ambassades, centres VFS, portails e-Visa officiels) — dans le cadre du traitement de votre dossier
        </li>
        <li>
          <strong>Prestataires techniques</strong> : Convex (base de données), Clerk (authentification),
          Replit (hébergement) — soumis à des engagements contractuels de confidentialité
        </li>
      </ul>
      <p>
        Joventy ne vend, ne loue et ne cède jamais vos données personnelles à des tiers
        à des fins commerciales.
      </p>

      <h2>6. Transferts internationaux de données</h2>
      <p>
        Dans la mesure où nos prestataires techniques sont établis aux États-Unis (Convex, Clerk,
        Replit), vos données peuvent faire l'objet d'un transfert vers des serveurs situés en
        dehors de la République Démocratique du Congo. Ces transferts sont encadrés par des
        garanties contractuelles appropriées (clauses contractuelles types, certifications).
      </p>

      <h2>7. Durée de conservation</h2>
      <ul>
        <li>
          <strong>Documents de dossier de visa</strong> : conservés pendant la durée du traitement
          de votre dossier, puis archivés 3 ans après la clôture de la relation client
        </li>
        <li>
          <strong>Données de compte utilisateur</strong> : pendant toute la durée d'utilisation
          du service, puis 1 an après la suppression du compte
        </li>
        <li>
          <strong>Données de facturation</strong> : 5 ans à compter de la date de la transaction
          (obligation légale)
        </li>
        <li>
          <strong>Données de navigation</strong> : 13 mois maximum
        </li>
      </ul>

      <h2>8. Sécurité des données</h2>
      <p>
        Joventy met en œuvre des mesures techniques et organisationnelles appropriées pour
        protéger vos données contre tout accès non autorisé, perte, destruction ou altération :
      </p>
      <ul>
        <li>Chiffrement des données au repos et en transit (HTTPS/TLS)</li>
        <li>Authentification sécurisée gérée par Clerk (OAuth 2.0, PKCE)</li>
        <li>Accès aux données limité aux seuls collaborateurs habilités</li>
        <li>Infrastructure Convex avec isolation des données par organisation</li>
        <li>Sauvegardes régulières et automatiques</li>
      </ul>

      <h2>9. Vos droits</h2>
      <p>Conformément aux principes généraux de protection des données personnelles, vous disposez des droits suivants :</p>
      <ul>
        <li><strong>Droit d'accès</strong> : obtenir une copie de vos données personnelles</li>
        <li><strong>Droit de rectification</strong> : corriger des données inexactes ou incomplètes</li>
        <li><strong>Droit à l'effacement</strong> : demander la suppression de vos données (sous réserve de nos obligations légales)</li>
        <li><strong>Droit d'opposition</strong> : vous opposer au traitement de vos données pour des raisons légitimes</li>
        <li><strong>Droit à la portabilité</strong> : recevoir vos données dans un format structuré</li>
        <li><strong>Droit de retrait du consentement</strong> : à tout moment, pour les traitements fondés sur le consentement</li>
      </ul>
      <p>
        Pour exercer ces droits, contactez-nous à :{" "}
        <a href="mailto:contact@joventy.cd">contact@joventy.cd</a>.
        Nous nous engageons à répondre dans un délai de 30 jours.
      </p>

      <h2>10. Cookies et traceurs</h2>
      <p>
        Le site joventy.cd utilise des technologies de stockage local (cookies de session, localStorage)
        uniquement à des fins fonctionnelles (maintien de la session, préférences utilisateur).
        Nous n'utilisons pas de cookies publicitaires ou de suivi comportemental tiers.
      </p>

      <h2>11. Modifications de la politique</h2>
      <p>
        La présente politique de confidentialité peut être mise à jour à tout moment.
        En cas de modification substantielle, nous vous informerons par e-mail ou via
        une notification dans votre espace client. La version en vigueur est celle publiée
        sur cette page.
      </p>

      <h2>12. Contact</h2>
      <p>
        Pour toute question ou réclamation relative à la protection de vos données :
      </p>
      <ul>
        <li>E-mail : <a href="mailto:contact@joventy.cd">contact@joventy.cd</a></li>
        <li>WhatsApp : <a href="https://wa.me/243840808122">+243 840 808 122</a></li>
      </ul>
    </LegalLayout>
  );
}
