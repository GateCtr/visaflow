import { LegalLayout } from "@/components/layout/LegalLayout";
import { Link } from "wouter";

export default function Remboursement() {
  return (
    <LegalLayout
      title="Politique de remboursement"
      subtitle="Conditions dans lesquelles un remboursement peut être accordé"
      lastUpdated="Mars 2025"
    >
      <p>
        Chez Joventy, nous croyons en la transparence totale sur notre modèle de tarification.
        La présente politique décrit clairement les conditions dans lesquelles des remboursements
        peuvent être accordés ou non.
      </p>

      <h2>1. Rappel de la structure tarifaire</h2>
      <p>
        Le service Joventy repose sur deux types de frais distincts, avec des règles
        de remboursement différentes :
      </p>
      <ul>
        <li>
          <strong>Frais d'engagement</strong> : payés à l'ouverture du dossier, ils rémunèrent
          le travail de préparation et de traitement du dossier par l'équipe Joventy
        </li>
        <li>
          <strong>Prime de succès</strong> : payée uniquement si un résultat est obtenu
          (créneau de rendez-vous ou visa accordé)
        </li>
      </ul>

      <h2>2. Frais d'engagement — Politique de non-remboursement</h2>
      <p>
        Les frais d'engagement sont <strong>non remboursables</strong> dès lors que
        Joventy a commencé à travailler sur votre dossier, c'est-à-dire dès la validation
        de votre paiement.
      </p>
      <p>Ces frais couvrent :</p>
      <ul>
        <li>La vérification et l'analyse de vos documents</li>
        <li>Le remplissage des formulaires officiels (DS-160, formulaires e-Visa, etc.)</li>
        <li>Les démarches de recherche de créneaux auprès des consulats ou centres VFS</li>
        <li>Le suivi et la communication avec notre équipe dédiée</li>
      </ul>
      <p>
        Ce travail est accompli indépendamment du résultat final de votre demande de visa.
        C'est pourquoi les frais d'engagement ne sont pas remboursables.
      </p>

      <h3>Exception — Dossier non démarré</h3>
      <p>
        Si Joventy n'a pas encore commencé à traiter votre dossier (dans les 24 heures
        suivant votre paiement d'engagement), vous pouvez demander une annulation avec
        remboursement intégral en contactant notre équipe via le chat ou à{" "}
        <a href="mailto:contact@joventy.cd">contact@joventy.cd</a>.
      </p>

      <h2>3. Prime de succès — Principe de base</h2>
      <p>
        La prime de succès ne vous est facturée que si Joventy obtient un résultat concret :
      </p>
      <ul>
        <li>
          <strong>Visa USA, Turquie (modèle rendez-vous) :</strong> un créneau de rendez-vous
          consulaire confirmé est obtenu pour vous
        </li>
        <li>
          <strong>Dubaï, Inde (modèle e-Visa) :</strong> le visa électronique est accordé
          par les autorités du pays de destination
        </li>
      </ul>
      <p>
        <strong>Si aucun résultat n'est obtenu</strong> malgré les efforts de notre équipe,
        aucune prime de succès ne vous sera demandée. C'est notre engagement.
      </p>

      <h2>4. Remboursement de la prime de succès — Cas particuliers</h2>

      <h3>4.1 Refus de visa après rendez-vous consulaire (USA, Turquie)</h3>
      <p>
        Si Joventy a obtenu un créneau de rendez-vous pour vous et que vous vous êtes
        présenté à l'entretien consulaire, <strong>la prime de succès est due et non
        remboursable</strong>. En effet, Joventy a rempli sa mission : obtenir l'accès à
        un entretien. La décision de l'ambassadeur ou du consul est une décision souveraine
        d'un gouvernement étranger sur laquelle Joventy n'a aucun contrôle.
      </p>

      <h3>4.2 Non-présentation au rendez-vous</h3>
      <p>
        Si vous ne vous présentez pas à votre rendez-vous consulaire sans en avoir informé
        Joventy au préalable, la prime de succès est due. Si le créneau peut être replanifié
        à votre demande, Joventy fera de son mieux, sans garantie de disponibilité.
      </p>

      <h3>4.3 Annulation à votre initiative après obtention du résultat</h3>
      <p>
        Si vous décidez d'annuler votre démarche après que Joventy a obtenu un résultat
        (créneau ou e-Visa), la prime de succès est due et non remboursable.
      </p>

      <h2>5. Frais consulaires, assurances et réservations</h2>
      <p>
        Les frais suivants sont entièrement à votre charge et réglés directement par vous
        auprès des organismes concernés. Joventy ne les perçoit pas et ne peut en aucun
        cas vous les rembourser :
      </p>
      <ul>
        <li>Frais MRV (ambassade des États-Unis) : 185 $ ou 265 $ selon le visa</li>
        <li>Frais SEVIS (visa F1 USA) : 350 $</li>
        <li>Frais consulaires et de service VFS (Turquie) : 100 $ à 480 $ selon la formule</li>
        <li>Frais d'assurance maladie (Turquie) : 65 $ à 110 $</li>
        <li>Frais e-Visa (Dubaï, Inde) : 25 $ à 100 $</li>
        <li>Billets d'avion, réservations hôtel, examens médicaux (Panel Physician)</li>
      </ul>
      <p>
        En cas de refus de visa, ces frais ne sont pas remboursés par Joventy car ils ont
        été réglés à des organismes tiers indépendants. Certains de ces organismes peuvent
        avoir leurs propres politiques de remboursement — renseignez-vous auprès d'eux directement.
      </p>

      <h2>6. Force majeure</h2>
      <p>
        En cas de survenance d'un événement de force majeure rendant l'exécution du service
        impossible (fermeture temporaire d'une ambassade, suspension du programme de visa,
        pandémie, conflit armé, catastrophe naturelle, etc.), Joventy s'engage à vous en
        informer dans les meilleurs délais et à proposer :
      </p>
      <ul>
        <li>Un report du traitement de votre dossier dès que la situation le permet, ou</li>
        <li>Un remboursement partiel ou total des frais d'engagement selon l'avancement du dossier</li>
      </ul>
      <p>
        Chaque situation de force majeure sera traitée individuellement par notre équipe.
      </p>

      <h2>7. Procédure de demande de remboursement</h2>
      <p>
        Pour toute demande de remboursement éligible, contactez notre équipe :
      </p>
      <ul>
        <li>Via le chat dans votre espace client Joventy</li>
        <li>Par e-mail à : <a href="mailto:contact@joventy.cd">contact@joventy.cd</a></li>
        <li>Via WhatsApp : <a href="https://wa.me/243840808122">+243 840 808 122</a></li>
      </ul>
      <p>
        Précisez dans votre message : votre nom complet, votre numéro de référence de dossier
        (format JOV-XXXXX), la nature de votre demande et les justificatifs éventuels.
        Notre équipe vous répondra dans un délai de <strong>5 jours ouvrables</strong>.
      </p>
      <p>
        Les remboursements accordés sont effectués via le même canal de paiement que celui
        utilisé lors de la transaction initiale (M-Pesa, Airtel Money ou Orange Money),
        dans un délai de 5 à 10 jours ouvrables après validation.
      </p>

      <h2>8. Récapitulatif</h2>
      <div className="not-prose overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-border">
              <th className="text-left px-4 py-3 font-semibold text-primary">Situation</th>
              <th className="text-center px-4 py-3 font-semibold text-primary">Engagement</th>
              <th className="text-center px-4 py-3 font-semibold text-primary">Prime de succès</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-slate-600">
            <tr>
              <td className="px-4 py-3">Dossier non démarré ({"<"}24h)</td>
              <td className="px-4 py-3 text-center text-green-700 font-semibold">Remboursé</td>
              <td className="px-4 py-3 text-center text-slate-400">N/A</td>
            </tr>
            <tr className="bg-slate-50/50">
              <td className="px-4 py-3">Dossier en cours, aucun résultat obtenu</td>
              <td className="px-4 py-3 text-center text-red-600 font-semibold">Non remboursé</td>
              <td className="px-4 py-3 text-center text-green-700 font-semibold">Non dû</td>
            </tr>
            <tr>
              <td className="px-4 py-3">Créneau/visa obtenu, annulation client</td>
              <td className="px-4 py-3 text-center text-red-600 font-semibold">Non remboursé</td>
              <td className="px-4 py-3 text-center text-red-600 font-semibold">Non remboursé</td>
            </tr>
            <tr className="bg-slate-50/50">
              <td className="px-4 py-3">Visa refusé après entretien consulaire</td>
              <td className="px-4 py-3 text-center text-red-600 font-semibold">Non remboursé</td>
              <td className="px-4 py-3 text-center text-red-600 font-semibold">Non remboursé</td>
            </tr>
            <tr>
              <td className="px-4 py-3">Force majeure (ambassade fermée, etc.)</td>
              <td className="px-4 py-3 text-center text-amber-600 font-semibold">Étudié au cas par cas</td>
              <td className="px-4 py-3 text-center text-amber-600 font-semibold">Non dû</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>9. Questions</h2>
      <p>
        Des questions sur notre politique de remboursement ?{" "}
        Consultez également nos{" "}
        <Link href="/conditions">Conditions Générales d'Utilisation</Link> ou
        contactez-nous directement — notre équipe est disponible pour vous répondre.
      </p>
    </LegalLayout>
  );
}
