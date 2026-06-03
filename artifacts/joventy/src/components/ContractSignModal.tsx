import { useState, useRef, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollText, PenLine, ShieldCheck, AlertCircle } from "lucide-react";

interface ContractSignModalProps {
  userName: string;
  onSigned: () => void;
}

export function ContractSignModal({ userName, onSigned }: ContractSignModalProps) {
  const [signedName, setSignedName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const signContract = useMutation(api.contracts.signContract);

  const today = new Date().toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
      if (atBottom) setHasScrolled(true);
    };
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  const isNameMatch = signedName.trim().length >= 3;
  const canSign = hasScrolled && accepted && isNameMatch && !isPending;

  const handleSign = async () => {
    if (!canSign) return;
    setIsPending(true);
    setError("");
    try {
      await signContract({
        signedName: signedName.trim(),
        userAgent: navigator.userAgent,
      });
      onSigned();
    } catch {
      setError("Une erreur est survenue. Veuillez réessayer.");
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-5 border-b border-border flex-shrink-0">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <ScrollText className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-primary">Contrat d'Accompagnement</h2>
            <p className="text-xs text-muted-foreground">Signature numérique obligatoire avant l'ouverture d'un dossier</p>
          </div>
        </div>

        {/* Contract text — scrollable */}
        <div
          ref={scrollRef}
          className="overflow-y-auto flex-1 px-6 py-5 text-sm text-slate-700 leading-relaxed space-y-5"
        >
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-800 font-medium">
              Veuillez lire entièrement ce contrat avant de signer. Faites défiler jusqu'en bas pour activer la signature.
            </p>
          </div>

          <div className="text-center space-y-1">
            <p className="font-bold text-base text-primary uppercase tracking-wide">Contrat d'Accompagnement Visa</p>
            <p className="text-xs text-muted-foreground">Version 1.0 — {today}</p>
          </div>

          <section className="space-y-2">
            <h3 className="font-bold text-primary">1. Parties au contrat</h3>
            <p>
              Le présent contrat est conclu entre <strong>Joventy</strong> (ci-après « le Prestataire »),
              plateforme d'accompagnement spécialisée dans les démarches de visa et rendez-vous
              consulaires basée à Kinshasa, République Démocratique du Congo, et le Client soussigné
              (ci-après « le Client »).
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold text-primary">2. Objet du contrat</h3>
            <p>
              Joventy s'engage à fournir au Client un service d'accompagnement pour l'obtention d'un
              rendez-vous consulaire ou d'un visa électronique (e-Visa), selon le package sélectionné
              lors de l'ouverture du dossier. Ce service comprend, selon le package choisi :
            </p>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              <li><strong>Service Complet :</strong> remplissage des formulaires, vérification du dossier et recherche active de créneau consulaire.</li>
              <li><strong>Créneau Uniquement :</strong> surveillance automatisée des portails consulaires et capture d'un créneau disponible.</li>
              <li><strong>Dossier Uniquement :</strong> remplissage des formulaires et vérification des pièces justificatives.</li>
            </ul>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold text-primary">3. Conditions financières</h3>
            <p>
              Le service est soumis à une <strong>structure de paiement en deux temps</strong> pour les
              packages incluant la recherche de créneau :
            </p>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              <li>
                <strong>Frais d'engagement</strong> (non remboursables) : payables à l'ouverture du dossier.
                Ils couvrent le travail administratif initial et la mise en surveillance du portail consulaire.
              </li>
              <li>
                <strong>Prime de succès</strong> : due uniquement si un créneau est effectivement obtenu ou si
                le visa électronique est accordé. Elle n'est jamais due en cas d'échec.
              </li>
            </ul>
            <p>
              Pour le package <strong>Dossier Uniquement</strong>, un tarif fixe est appliqué — aucune prime
              de succès n'est due. Les paiements s'effectuent via Mobile Money (M-Pesa, Airtel Money,
              Orange Money) selon les instructions affichées sur la plateforme.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold text-primary">4. Obligations de Joventy</h3>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              <li>Déployer les moyens techniques disponibles pour surveiller les portails consulaires de façon continue.</li>
              <li>Notifier le Client immédiatement (WhatsApp, email et tableau de bord) dès qu'un créneau est obtenu.</li>
              <li>Traiter les données personnelles du Client avec confidentialité, conformément à la section 7.</li>
              <li>Fournir un suivi transparent via le tableau de bord client en temps réel.</li>
            </ul>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold text-primary">5. Obligations du Client</h3>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              <li>Fournir des informations exactes, complètes et à jour lors de l'ouverture du dossier.</li>
              <li>Transmettre sans délai les documents demandés par Joventy pour compléter le dossier.</li>
              <li>Régler les frais d'engagement dans les 48 heures suivant l'ouverture du dossier, sous peine d'annulation automatique.</li>
              <li>Se présenter au rendez-vous consulaire à la date et l'heure indiquées, muni de l'intégralité des documents requis.</li>
              <li>Payer la prime de succès dans les 48 heures suivant la notification d'obtention du créneau.</li>
            </ul>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold text-primary">6. Limitation de responsabilité — Absence de garantie de visa</h3>
            <p>
              Le Client reconnaît et accepte expressément que <strong>Joventy n'est pas une ambassade et ne délivre
              pas de visas</strong>. Joventy intervient uniquement en qualité d'intermédiaire technique et administratif.
            </p>
            <p>
              La décision d'accorder ou de refuser un visa appartient exclusivement à l'autorité consulaire
              compétente. <strong>Joventy ne peut en aucun cas garantir l'obtention du visa.</strong>
            </p>
            <p>
              En cas de refus de visa par les autorités consulaires, les frais d'engagement déjà versés ne sont
              pas remboursables. La prime de succès n'est pas due dans ce cas.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold text-primary">7. Politique de remboursement</h3>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              <li>
                <strong>Frais d'engagement :</strong> non remboursables après paiement, quelle que soit l'issue de la demande.
              </li>
              <li>
                <strong>Prime de succès :</strong> due uniquement après obtention effective du créneau ou du visa.
                En l'absence de résultat, elle n'est jamais prélevée.
              </li>
              <li>
                <strong>Annulation par le Client :</strong> en cas d'annulation avant toute action de Joventy,
                un remboursement partiel peut être étudié au cas par cas. Contactez le support.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold text-primary">8. Protection des données personnelles</h3>
            <p>
              Les données personnelles collectées (nom, passeport, motif de voyage, etc.) sont utilisées
              exclusivement pour l'exécution du service d'accompagnement. Elles ne sont jamais vendues
              à des tiers. Elles peuvent être transmises aux portails consulaires officiels dans le cadre
              strict de la prise de rendez-vous.
            </p>
            <p>
              Le Client dispose d'un droit d'accès, de rectification et de suppression de ses données.
              Pour toute demande : <strong>contact@joventy.cd</strong>.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold text-primary">9. Signature numérique</h3>
            <p>
              En signant numériquement ce contrat, le Client reconnaît avoir lu, compris et accepté
              l'intégralité des conditions ci-dessus. La signature numérique (saisie du nom complet)
              a valeur de consentement électronique et est archivée avec horodatage sur la plateforme Joventy.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="font-bold text-primary">10. Droit applicable</h3>
            <p>
              Le présent contrat est soumis au droit de la République Démocratique du Congo.
              Tout litige sera soumis à la compétence des juridictions de Kinshasa.
            </p>
          </section>

          <div className="border-t border-dashed border-slate-200 pt-4 text-xs text-muted-foreground text-center">
            Fin du contrat — Version 1.0 | Joventy © {new Date().getFullYear()} | contact@joventy.cd
          </div>
        </div>

        {/* Signature zone */}
        <div className="flex-shrink-0 border-t border-border px-6 py-5 space-y-4 bg-slate-50/60 rounded-b-2xl">
          {!hasScrolled && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-center font-medium">
              ↓ Faites défiler jusqu'en bas du contrat pour activer la signature
            </p>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-semibold text-primary flex items-center gap-2">
              <PenLine className="w-4 h-4 text-secondary" />
              Signez en tapant votre nom complet
            </label>
            <Input
              placeholder={`Ex : ${userName || "Jean Dupont"}`}
              value={signedName}
              onChange={(e) => setSignedName(e.target.value)}
              disabled={!hasScrolled}
              className="h-12 text-base font-medium placeholder:font-normal"
            />
            {signedName.trim().length > 0 && signedName.trim().length < 3 && (
              <p className="text-xs text-red-500">Veuillez entrer votre nom complet (au moins 3 caractères).</p>
            )}
          </div>

          <label className={`flex items-start gap-3 cursor-pointer ${!hasScrolled ? "opacity-40 pointer-events-none" : ""}`}>
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-[var(--primary)]"
            />
            <span className="text-sm text-slate-700 leading-relaxed">
              Je déclare avoir lu et compris l'intégralité du contrat d'accompagnement Joventy, et j'accepte
              sans réserve l'ensemble de ses conditions, notamment l'absence de garantie de visa et la
              non-remboursabilité des frais d'engagement.
            </span>
          </label>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}

          <Button
            onClick={handleSign}
            disabled={!canSign}
            className="w-full h-12 text-base font-bold gap-2 bg-primary text-white hover:bg-primary/90 disabled:opacity-40"
          >
            <ShieldCheck className="w-5 h-5" />
            {isPending ? "Enregistrement…" : "Je signe ce contrat numériquement"}
          </Button>

          <p className="text-[11px] text-muted-foreground text-center">
            Votre signature sera archivée avec horodatage. Ce contrat sera accessible depuis votre espace client.
          </p>
        </div>
      </div>
    </div>
  );
}
