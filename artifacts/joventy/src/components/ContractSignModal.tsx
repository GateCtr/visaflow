import { useState, useRef, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PenLine, ShieldCheck, ChevronDown } from "lucide-react";

interface ContractSignModalProps {
  userName: string;
  onSigned: () => void;
}

export function ContractSignModal({ userName, onSigned }: ContractSignModalProps) {
  const [signedName, setSignedName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
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
      const progress = el.scrollTop / (el.scrollHeight - el.clientHeight);
      const pct = Math.min(100, Math.round(progress * 100));
      setScrollProgress(pct);
      if (pct >= 98) setHasScrolled(true);
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
      await signContract({ signedName: signedName.trim(), userAgent: navigator.userAgent });
      onSigned();
    } catch {
      setError("Une erreur est survenue. Veuillez réessayer.");
    } finally {
      setIsPending(false);
    }
  };

  const scrollDown = () => {
    scrollRef.current?.scrollBy({ top: 300, behavior: "smooth" });
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0B111E]">

      {/* ── BARRE DE PROGRESSION ── */}
      <div className="flex-shrink-0 h-1 bg-white/10">
        <div
          className="h-full bg-[#F59E0B] transition-all duration-300"
          style={{ width: `${scrollProgress}%` }}
        />
      </div>

      {/* ── EN-TÊTE ── */}
      <div className="flex-shrink-0 flex items-center justify-between px-6 sm:px-10 py-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <img
            src="https://akollad.com/web-app-manifest-512x512.png"
            alt="Akollad"
            className="w-8 h-8 rounded-lg"
          />
          <div>
            <span className="text-white font-bold text-sm tracking-tight">Joventy</span>
            <span className="text-white/30 mx-2 text-sm">·</span>
            <span className="text-white/50 text-xs">Contrat d'accompagnement visa</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!hasScrolled ? (
            <span className="text-[11px] text-white/40 hidden sm:block">
              Lisez jusqu'au bas pour signer — {scrollProgress}% lu
            </span>
          ) : (
            <span className="text-[11px] text-emerald-400 font-semibold hidden sm:block">
              ✓ Lecture complète — vous pouvez signer
            </span>
          )}
        </div>
      </div>

      {/* ── ZONE PRINCIPALE ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Colonne document */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto"
          style={{ scrollbarWidth: "thin", scrollbarColor: "#334155 transparent" }}
        >
          {/* Page blanche centrée */}
          <div className="max-w-3xl mx-auto my-8 sm:my-12 px-4 sm:px-0">
            <div className="bg-white rounded-2xl shadow-2xl overflow-hidden">

              {/* En-tête du document */}
              <div className="bg-[#0B111E] px-8 sm:px-12 py-8">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-[#F59E0B] text-[10px] font-bold tracking-widest uppercase mb-2">
                      Document officiel — Akollad Groupe
                    </div>
                    <h1 className="text-white text-2xl sm:text-3xl font-bold leading-tight">
                      Contrat d'Accompagnement<br />
                      <span className="text-[#F59E0B]">Visa</span>
                    </h1>
                    <p className="text-white/40 text-xs mt-2">Version 1.1 — {today}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-white/30 text-[10px] leading-relaxed">
                      <div>RCCM : CD/KNG/RCCM/25-A-07960</div>
                      <div>N° Impôt : A2557944L</div>
                      <div>IDNAT : 01-J6100-N86614P</div>
                    </div>
                  </div>
                </div>

                <div className="mt-6 pt-6 border-t border-white/10 flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#F59E0B]" />
                  <span className="text-white/60 text-xs">
                    Signature numérique obligatoire avant l'accès à la plateforme
                  </span>
                </div>
              </div>

              {/* Corps du contrat */}
              <div
                className="px-8 sm:px-12 py-10 text-slate-700 leading-[1.85] space-y-8"
                style={{ fontFamily: "'Georgia', 'Times New Roman', serif", fontSize: "15px" }}
              >

                <section>
                  <h2 className="font-sans font-bold text-[#0B111E] text-base uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                    1. Parties au contrat
                  </h2>
                  <p>
                    Le présent contrat est conclu entre <strong>Joventy</strong> (ci-après « le Prestataire »),
                    plateforme d'accompagnement spécialisée dans les démarches de visa et rendez-vous
                    consulaires, opérée par <strong>Akollad Groupe</strong>, holding technologique de droit
                    congolais dont le siège est établi à Kinshasa, République Démocratique du Congo —
                    et le Client soussigné (ci-après « le Client »).
                  </p>
                </section>

                <section>
                  <h2 className="font-sans font-bold text-[#0B111E] text-base uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                    2. Objet du contrat
                  </h2>
                  <p className="mb-3">
                    Joventy s'engage à fournir au Client un service d'accompagnement pour l'obtention d'un
                    rendez-vous consulaire, d'un visa électronique (e-Visa) ou de tout visa ne nécessitant pas
                    de rendez-vous physique, selon le package sélectionné lors de l'ouverture du dossier.
                    Ce service comprend, selon le package choisi :
                  </p>
                  <ul className="space-y-2 pl-4 border-l-2 border-[#F59E0B]/30">
                    <li className="pl-4"><strong>Service Complet :</strong> remplissage des formulaires, vérification du dossier et recherche active de créneau consulaire.</li>
                    <li className="pl-4"><strong>Créneau Uniquement :</strong> surveillance automatisée des portails consulaires et capture d'un créneau disponible.</li>
                    <li className="pl-4"><strong>E-Visa / Visa sans rendez-vous :</strong> constitution, vérification et soumission du dossier sur le portail officiel compétent.</li>
                    <li className="pl-4"><strong>Dossier Uniquement :</strong> remplissage des formulaires et vérification des pièces justificatives, sans soumission ni prise de rendez-vous.</li>
                  </ul>
                </section>

                <section>
                  <h2 className="font-sans font-bold text-[#0B111E] text-base uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                    3. Conditions financières
                  </h2>
                  <p className="mb-3">
                    Le service est soumis à une <strong>structure de paiement en deux temps</strong> pour les
                    packages incluant la recherche de créneau ou la soumission e-Visa :
                  </p>
                  <ul className="space-y-2 pl-4 border-l-2 border-[#F59E0B]/30 mb-3">
                    <li className="pl-4">
                      <strong>Frais d'engagement</strong> (non remboursables) : payables à l'ouverture du dossier.
                      Ils couvrent le travail administratif initial, la mise en surveillance du portail et la préparation du dossier.
                    </li>
                    <li className="pl-4">
                      <strong>Prime de succès — Visa avec rendez-vous :</strong> due uniquement si un créneau consulaire
                      est effectivement obtenu. Elle n'est jamais due en cas d'indisponibilité de créneaux.
                    </li>
                    <li className="pl-4">
                      <strong>Prime de succès — E-Visa / Visa sans rendez-vous :</strong> due uniquement si le visa
                      est accordé par l'autorité compétente. Elle n'est jamais due en cas de refus ou de non-réponse.
                    </li>
                  </ul>
                  <p>
                    Pour le package <strong>Dossier Uniquement</strong>, un tarif fixe est appliqué — aucune prime
                    de succès n'est due. Les paiements s'effectuent via Mobile Money (M-Pesa, Airtel Money,
                    Orange Money) selon les instructions affichées sur la plateforme.
                  </p>
                </section>

                <section>
                  <h2 className="font-sans font-bold text-[#0B111E] text-base uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                    3 bis. E-Visa et visa sans rendez-vous
                  </h2>
                  <p className="mb-3">
                    Pour les procédures ne requérant pas de rendez-vous consulaire physique (e-Visa, visa on arrival,
                    visa postal, etc.), le critère de succès est <strong>l'obtention effective du visa</strong>
                    (approbation officielle par l'autorité émettrice), et non la prise d'un rendez-vous.
                  </p>
                  <ul className="space-y-2 pl-4 border-l-2 border-[#F59E0B]/30">
                    <li className="pl-4">Joventy prend en charge la constitution, la vérification et la soumission du dossier sur le portail officiel.</li>
                    <li className="pl-4">Le Client s'engage à fournir tous les documents requis dans les délais indiqués.</li>
                    <li className="pl-4">La prime de succès est due dans les <strong>48 heures suivant la notification d'obtention du visa</strong>.</li>
                    <li className="pl-4">
                      En cas de refus par l'autorité compétente, la prime de succès n'est pas due.
                      Les frais d'engagement restent non remboursables car le travail de préparation et de soumission a été accompli.
                    </li>
                    <li className="pl-4">
                      En cas de refus lié à des informations inexactes ou des documents manquants fournis par le Client,
                      les frais d'engagement et toute resoumission éventuelle restent à la charge du Client.
                    </li>
                  </ul>
                </section>

                <section>
                  <h2 className="font-sans font-bold text-[#0B111E] text-base uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                    4. Obligations de Joventy
                  </h2>
                  <ul className="space-y-2 pl-4 border-l-2 border-[#F59E0B]/30">
                    <li className="pl-4">Déployer les moyens techniques disponibles pour surveiller les portails consulaires de façon continue.</li>
                    <li className="pl-4">Notifier le Client immédiatement (WhatsApp, email et tableau de bord) dès qu'un créneau est obtenu.</li>
                    <li className="pl-4">Traiter les données personnelles du Client avec confidentialité, conformément à la section 8.</li>
                    <li className="pl-4">Fournir un suivi transparent via le tableau de bord client en temps réel.</li>
                  </ul>
                </section>

                <section>
                  <h2 className="font-sans font-bold text-[#0B111E] text-base uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                    5. Obligations du Client
                  </h2>
                  <ul className="space-y-2 pl-4 border-l-2 border-[#F59E0B]/30">
                    <li className="pl-4">Fournir des informations exactes, complètes et à jour lors de l'ouverture du dossier.</li>
                    <li className="pl-4">Transmettre sans délai les documents demandés par Joventy pour compléter le dossier.</li>
                    <li className="pl-4">Régler les frais d'engagement dans les 48 heures suivant l'ouverture du dossier, sous peine d'annulation automatique.</li>
                    <li className="pl-4"><strong>Visa avec rendez-vous :</strong> se présenter au rendez-vous consulaire à la date et l'heure indiquées, muni de l'intégralité des documents requis, et payer la prime de succès dans les 48 heures suivant la notification d'obtention du créneau.</li>
                    <li className="pl-4"><strong>E-Visa / Visa sans rendez-vous :</strong> s'assurer que tous les documents fournis sont authentiques et conformes aux exigences du pays de destination, et payer la prime de succès dans les 48 heures suivant la notification d'obtention du visa.</li>
                  </ul>
                </section>

                <section>
                  <h2 className="font-sans font-bold text-[#0B111E] text-base uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                    6. Limitation de responsabilité
                  </h2>
                  <p className="mb-3">
                    Le Client reconnaît et accepte expressément que <strong>Joventy n'est pas une ambassade et ne délivre
                    pas de visas</strong>. Joventy intervient uniquement en qualité d'intermédiaire technique et administratif.
                  </p>
                  <p className="mb-3">
                    La décision d'accorder ou de refuser un visa appartient exclusivement à l'autorité consulaire
                    ou gouvernementale compétente. <strong>Joventy ne peut en aucun cas garantir l'obtention du visa,
                    qu'il s'agisse d'un visa avec rendez-vous ou d'un e-Visa.</strong>
                  </p>
                  <p>
                    En cas de refus de visa par les autorités compétentes, les frais d'engagement déjà versés ne sont
                    pas remboursables. La prime de succès n'est pas due dans ce cas. Joventy ne peut être tenu
                    responsable des délais de traitement, des changements de politique consulaire ou des fermetures
                    de portails gouvernementaux indépendants de sa volonté.
                  </p>
                </section>

                <section>
                  <h2 className="font-sans font-bold text-[#0B111E] text-base uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                    7. Politique de remboursement
                  </h2>
                  <ul className="space-y-2 pl-4 border-l-2 border-[#F59E0B]/30">
                    <li className="pl-4">
                      <strong>Frais d'engagement :</strong> non remboursables après paiement, quelle que soit l'issue
                      de la demande (créneau non disponible, refus de visa, annulation consulaire, etc.).
                    </li>
                    <li className="pl-4">
                      <strong>Prime de succès — Visa avec rendez-vous :</strong> due uniquement après obtention
                      effective d'un créneau. En l'absence de créneau, elle n'est jamais prélevée.
                    </li>
                    <li className="pl-4">
                      <strong>Prime de succès — E-Visa / Visa sans rendez-vous :</strong> due uniquement après
                      notification officielle d'obtention du visa. En cas de refus ou non-réponse de l'autorité
                      compétente, elle n'est jamais prélevée.
                    </li>
                    <li className="pl-4">
                      <strong>Annulation par le Client :</strong> en cas d'annulation avant toute action de Joventy,
                      un remboursement partiel peut être étudié au cas par cas. Contactez le support.
                    </li>
                  </ul>
                </section>

                <section>
                  <h2 className="font-sans font-bold text-[#0B111E] text-base uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                    8. Protection des données personnelles
                  </h2>
                  <p className="mb-3">
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

                <section>
                  <h2 className="font-sans font-bold text-[#0B111E] text-base uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                    9. Signature numérique
                  </h2>
                  <p>
                    En signant numériquement ce contrat, le Client reconnaît avoir lu, compris et accepté
                    l'intégralité des conditions ci-dessus. La signature numérique (saisie du nom complet)
                    a valeur de consentement électronique et est archivée avec horodatage sur la plateforme Joventy.
                  </p>
                </section>

                <section>
                  <h2 className="font-sans font-bold text-[#0B111E] text-base uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                    10. Droit applicable
                  </h2>
                  <p>
                    Le présent contrat est soumis au droit de la République Démocratique du Congo.
                    Tout litige sera soumis à la compétence des juridictions de Kinshasa.
                  </p>
                </section>

                {/* Pied du document */}
                <div className="pt-6 border-t border-dashed border-slate-200 flex items-center justify-between text-xs text-slate-400">
                  <span>Joventy · Akollad Groupe · Kinshasa, RDC</span>
                  <span>Version 1.1 · {new Date().getFullYear()}</span>
                </div>
              </div>

              {/* ── ZONE DE SIGNATURE (n'apparaît qu'après lecture complète) ── */}
              <div
                className="overflow-hidden transition-all duration-700 ease-out"
                style={{
                  maxHeight: hasScrolled ? "600px" : "0px",
                  opacity: hasScrolled ? 1 : 0,
                }}
              >
                <div className="bg-slate-50 border-t-2 border-[#F59E0B] px-8 sm:px-12 py-8 space-y-6">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-10 h-10 rounded-xl bg-[#0B111E] flex items-center justify-center flex-shrink-0">
                      <PenLine className="w-5 h-5 text-[#F59E0B]" />
                    </div>
                    <div>
                      <p className="font-bold text-[#0B111E] text-base">Signature numérique</p>
                      <p className="text-xs text-slate-500">Tapez votre nom complet pour signer ce contrat</p>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-700">
                      Nom complet du signataire
                    </label>
                    <Input
                      placeholder={userName ? `Ex : ${userName}` : "Votre nom complet"}
                      value={signedName}
                      onChange={(e) => setSignedName(e.target.value)}
                      className="h-13 text-base font-medium border-slate-300 focus:border-[#0B111E] bg-white"
                      style={{ height: "52px" }}
                    />
                    {signedName.trim().length > 0 && signedName.trim().length < 3 && (
                      <p className="text-xs text-red-500">Veuillez entrer votre nom complet (au moins 3 caractères).</p>
                    )}
                  </div>

                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={accepted}
                      onChange={(e) => setAccepted(e.target.checked)}
                      className="mt-1 w-4 h-4 accent-[#0B111E] flex-shrink-0"
                    />
                    <span className="text-sm text-slate-600 leading-relaxed">
                      Je déclare avoir lu et compris l'intégralité du contrat d'accompagnement Joventy, et j'accepte
                      sans réserve l'ensemble de ses conditions, notamment l'absence de garantie de visa et la
                      non-remboursabilité des frais d'engagement.
                    </span>
                  </label>

                  {error && (
                    <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>
                  )}

                  <Button
                    onClick={handleSign}
                    disabled={!canSign}
                    className="w-full h-14 text-base font-bold gap-2 bg-[#0B111E] hover:bg-[#1a2540] text-white disabled:opacity-30 rounded-xl"
                  >
                    <ShieldCheck className="w-5 h-5 text-[#F59E0B]" />
                    {isPending ? "Enregistrement en cours…" : "Je signe ce contrat numériquement"}
                  </Button>

                  <p className="text-[11px] text-slate-400 text-center">
                    Signature horodatée et archivée · RCCM CD/KNG/RCCM/25-A-07960 · contact@joventy.cd
                  </p>
                </div>
              </div>

            </div>

            {/* Espace bas de page */}
            <div className="h-16" />
          </div>
        </div>

        {/* ── BARRE LATÉRALE DROITE (desktop) ── */}
        <div className="hidden lg:flex flex-col items-center py-12 px-4 w-20 border-l border-white/10 gap-6">
          {/* Progression verticale */}
          <div className="flex-1 w-1.5 bg-white/10 rounded-full overflow-hidden">
            <div
              className="w-full bg-[#F59E0B] rounded-full transition-all duration-300"
              style={{ height: `${scrollProgress}%` }}
            />
          </div>
          <span className="text-white/30 text-[10px] font-mono tabular-nums">{scrollProgress}%</span>
        </div>
      </div>

      {/* ── BOUTON "CONTINUER À LIRE" (fixé en bas si pas encore scrollé) ── */}
      {!hasScrolled && (
        <div className="flex-shrink-0 flex items-center justify-center py-4 bg-[#0B111E] border-t border-white/10">
          <button
            onClick={scrollDown}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-white/10 hover:bg-white/15 text-white text-sm font-medium transition-colors"
          >
            <ChevronDown className="w-4 h-4 animate-bounce" />
            Continuer la lecture pour signer ({scrollProgress}% lu)
          </button>
        </div>
      )}
    </div>
  );
}
