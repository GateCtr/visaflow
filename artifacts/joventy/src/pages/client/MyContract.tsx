import { useRef, useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { CheckCircle2, FileText, ShieldCheck, User, Clock, Hash, Download, Printer, PenLine, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const CONTRACT_SECTIONS = [
  {
    title: "1. Parties au contrat",
    content: (
      <p>
        Le présent contrat est conclu entre <strong>Joventy</strong> (ci-après « le Prestataire »),
        plateforme d'accompagnement spécialisée dans les démarches de visa et rendez-vous consulaires,
        opérée par <strong>Akollad Groupe</strong>, holding technologique de droit congolais dont le
        siège est établi à Kinshasa, République Démocratique du Congo — et le Client soussigné
        (ci-après « le Client »).
      </p>
    ),
  },
  {
    title: "2. Objet du contrat",
    content: (
      <>
        <p className="mb-3">
          Joventy s'engage à fournir au Client un service d'accompagnement pour l'obtention d'un
          rendez-vous consulaire, d'un visa électronique (e-Visa) ou de tout visa ne nécessitant pas
          de rendez-vous physique. Ce service comprend, selon le package choisi :
        </p>
        <ul className="space-y-1.5 pl-3 border-l-2 border-[#F59E0B]/30">
          {[
            ["Service Complet", "remplissage des formulaires, vérification du dossier et recherche active de créneau consulaire."],
            ["Créneau Uniquement", "surveillance automatisée des portails consulaires et capture d'un créneau disponible."],
            ["E-Visa / Visa sans rendez-vous", "constitution, vérification et soumission du dossier sur le portail officiel compétent."],
            ["Accompagnement Partiel", "vous fournissez vos documents ou la majorité ; Joventy complète les pièces manquantes, constitue votre profil et capture votre créneau. Prime de succès due uniquement à l'obtention de votre visa."],
          ].map(([label, desc]) => (
            <li key={label} className="pl-3 text-sm"><strong>{label} :</strong> {desc}</li>
          ))}
        </ul>
      </>
    ),
  },
  {
    title: "3. Conditions financières",
    content: (
      <>
        <p className="mb-3">
          Structure de paiement en deux temps pour les packages incluant la recherche de créneau ou la soumission e-Visa :
        </p>
        <ul className="space-y-2 pl-3 border-l-2 border-[#F59E0B]/30">
          {[
            ["Frais d'engagement (non remboursables)", "payables à l'ouverture du dossier. Ils couvrent le travail administratif initial, la mise en surveillance du portail et la préparation du dossier."],
            ["Prime de succès — Visa avec rendez-vous", "due uniquement si un créneau consulaire est effectivement obtenu. Elle n'est jamais due en cas d'indisponibilité de créneaux."],
            ["Prime de succès — E-Visa / Visa sans rendez-vous", "due uniquement si le visa est accordé par l'autorité compétente. Elle n'est jamais due en cas de refus ou de non-réponse."],
          ].map(([label, desc]) => (
            <li key={label} className="pl-3 text-sm"><strong>{label} :</strong> {desc}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm">
          Les paiements s'effectuent via Mobile Money (M-Pesa, Airtel Money, Orange Money).
        </p>
      </>
    ),
  },
  {
    title: "3 bis. E-Visa et visa sans rendez-vous",
    content: (
      <>
        <p className="mb-3">
          Pour les procédures ne requérant pas de rendez-vous consulaire physique, le critère de succès
          est <strong>l'obtention effective du visa</strong> (approbation officielle par l'autorité émettrice).
        </p>
        <ul className="space-y-1.5 pl-3 border-l-2 border-[#F59E0B]/30 text-sm">
          <li className="pl-3">Joventy prend en charge la constitution, la vérification et la soumission du dossier sur le portail officiel.</li>
          <li className="pl-3">Le Client s'engage à fournir tous les documents requis dans les délais indiqués.</li>
          <li className="pl-3">La prime de succès est due dans les <strong>48 heures suivant la notification d'obtention du visa</strong>.</li>
          <li className="pl-3">En cas de refus, la prime de succès n'est pas due. Les frais d'engagement restent non remboursables.</li>
        </ul>
      </>
    ),
  },
  {
    title: "4. Obligations de Joventy",
    content: (
      <ul className="space-y-1.5 pl-3 border-l-2 border-[#F59E0B]/30 text-sm">
        {[
          "Déployer les moyens techniques disponibles pour surveiller les portails consulaires de façon continue.",
          "Notifier le Client immédiatement (WhatsApp, email et tableau de bord) dès qu'un créneau est obtenu.",
          "Traiter les données personnelles du Client avec confidentialité, conformément à la section 8.",
          "Fournir un suivi transparent via le tableau de bord client en temps réel.",
        ].map((item) => <li key={item} className="pl-3">{item}</li>)}
      </ul>
    ),
  },
  {
    title: "5. Obligations du Client",
    content: (
      <ul className="space-y-1.5 pl-3 border-l-2 border-[#F59E0B]/30 text-sm">
        {[
          "Fournir des informations exactes, complètes et à jour lors de l'ouverture du dossier.",
          "Transmettre sans délai les documents demandés par Joventy pour compléter le dossier.",
          "Régler les frais d'engagement dans les 48 heures suivant l'ouverture du dossier, sous peine d'annulation automatique.",
          "Visa avec rendez-vous : se présenter au rendez-vous consulaire à la date et l'heure indiquées, muni de l'intégralité des documents requis, et payer la prime de succès dans les 48 heures suivant la notification.",
          "E-Visa / Visa sans rendez-vous : s'assurer que tous les documents fournis sont authentiques et conformes aux exigences du pays de destination, et payer la prime de succès dans les 48 heures suivant la notification d'obtention du visa.",
        ].map((item) => <li key={item} className="pl-3">{item}</li>)}
      </ul>
    ),
  },
  {
    title: "6. Limitation de responsabilité",
    content: (
      <>
        <p className="mb-3 text-sm">
          Le Client reconnaît que <strong>Joventy n'est pas une ambassade et ne délivre pas de visas</strong>.
          Joventy intervient uniquement en qualité d'intermédiaire technique et administratif.
        </p>
        <p className="mb-3 text-sm">
          La décision d'accorder ou de refuser un visa appartient exclusivement à l'autorité consulaire ou
          gouvernementale compétente. <strong>Joventy ne peut en aucun cas garantir l'obtention du visa.</strong>
        </p>
        <p className="text-sm">
          En cas de refus, les frais d'engagement ne sont pas remboursables. La prime de succès n'est pas due.
        </p>
      </>
    ),
  },
  {
    title: "7. Politique de remboursement",
    content: (
      <ul className="space-y-2 pl-3 border-l-2 border-[#F59E0B]/30 text-sm">
        {[
          ["Frais d'engagement", "non remboursables après paiement, quelle que soit l'issue de la demande."],
          ["Prime de succès — Visa avec rendez-vous", "due uniquement après obtention effective d'un créneau. En l'absence de créneau, elle n'est jamais prélevée."],
          ["Prime de succès — E-Visa / Visa sans rendez-vous", "due uniquement après notification officielle d'obtention du visa. En cas de refus ou non-réponse, elle n'est jamais prélevée."],
          ["Annulation par le Client", "en cas d'annulation avant toute action de Joventy, un remboursement partiel peut être étudié au cas par cas. Contactez le support."],
        ].map(([label, desc]) => (
          <li key={label} className="pl-3"><strong>{label} :</strong> {desc}</li>
        ))}
      </ul>
    ),
  },
  {
    title: "8. Protection des données personnelles",
    content: (
      <>
        <p className="mb-2 text-sm">
          Les données personnelles collectées sont utilisées exclusivement pour l'exécution du service.
          Elles ne sont jamais vendues à des tiers. Elles peuvent être transmises aux portails consulaires
          officiels dans le cadre strict de la prise de rendez-vous.
        </p>
        <p className="text-sm">
          Droit d'accès, de rectification et de suppression : <strong>contact@joventy.cd</strong>.
        </p>
      </>
    ),
  },
  {
    title: "9. Signature numérique",
    content: (
      <p className="text-sm">
        En signant numériquement ce contrat, le Client reconnaît avoir lu, compris et accepté l'intégralité
        des conditions ci-dessus. La signature numérique a valeur de consentement électronique et est archivée
        avec horodatage sur la plateforme Joventy.
      </p>
    ),
  },
  {
    title: "10. Droit applicable",
    content: (
      <p className="text-sm">
        Le présent contrat est soumis au droit de la République Démocratique du Congo. Tout litige sera soumis
        à la compétence des juridictions de Kinshasa.
      </p>
    ),
  },
];

import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";

const oklchCache = new Map<string, string>();

/**
 * Convertit oklch en rgb directement (sans dépendre du navigateur)
 * Basé sur la spécification CSS Color Level 4
 */
function oklchToRgb(oklch: string): string {
  // Parser oklch(l c h / alpha)
  const match = oklch.match(/oklch\s*\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)(?:\s*\/\s*([\d.]+%?))?\s*\)/i);
  if (!match) return "rgb(0,0,0)";

  let l = parseFloat(match[1]);
  let c = parseFloat(match[2]);
  let h = parseFloat(match[3]);
  const alpha = match[4] ? parseFloat(match[4]) : 1;

  // Convertir les pourcentages en valeurs décimales
  if (match[1].includes("%")) l /= 100;
  if (match[2].includes("%")) c /= 100;
  if (match[3].includes("%")) h /= 100;

  // Convertir oklch en oklab
  const hRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hRad);
  const b = c * Math.sin(hRad);

  // Convertir oklab en XYZ (D65)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  const l__ = l_ * l_ * l_;
  const m__ = m_ * m_ * m_;
  const s__ = s_ * s_ * s_;

  const x = +4.0767416621 * l__ - 3.3077335964 * m__ + 0.2309699292 * s__;
  const y = -1.2684380046 * l__ + 2.6097574011 * m__ - 0.3413193965 * s__;
  const z = -0.0041960863 * l__ - 0.7034186147 * m__ + 1.7076147010 * s__;

  // Convertir XYZ en sRGB (D65)
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
  const b_ = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

  // Gamma correction sRGB
  const toLinear = (v: number) => v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  const toGamma = (v: number) => v > 0.0031308 ? 1.055 * Math.pow(v, 1 / 2.4) - 0.055 : 12.92 * v;

  const rLinear = toLinear(r);
  const gLinear = toLinear(g);
  const bLinear = toLinear(b_);

  const rGamma = toGamma(rLinear);
  const gGamma = toGamma(gLinear);
  const bGamma = toGamma(bLinear);

  // Clip et convertir en 0-255
  const r255 = Math.max(0, Math.min(255, Math.round(rGamma * 255)));
  const g255 = Math.max(0, Math.min(255, Math.round(gGamma * 255)));
  const b255 = Math.max(0, Math.min(255, Math.round(bGamma * 255)));

  if (alpha < 1) {
    return `rgba(${r255}, ${g255}, ${b255}, ${alpha})`;
  }
  return `rgb(${r255}, ${g255}, ${b255})`;
}

function convertOklchValue(oklchStr: string): string {
  const oklchRe = /oklch\([^)]*\)/g;
  let result = oklchStr.replace(oklchRe, (m) => {
    const trimmed = m.trim();
    if (oklchCache.has(trimmed)) {
      return oklchCache.get(trimmed)!;
    }
    try {
      const rgb = oklchToRgb(trimmed);
      oklchCache.set(trimmed, rgb);
      return rgb;
    } catch {
      return "rgb(0,0,0)";
    }
  });
  
  // Aussi convertir oklab en rgb
  const oklabRe = /oklab\([^)]*\)/g;
  result = result.replace(oklabRe, (m) => {
    const trimmed = m.trim();
    if (oklchCache.has(trimmed)) {
      return oklchCache.get(trimmed)!;
    }
    try {
      const rgb = oklabToRgb(trimmed);
      oklchCache.set(trimmed, rgb);
      return rgb;
    } catch {
      return "rgb(0,0,0)";
    }
  });
  
  return result;
}

/**
 * Convertit oklab en rgb directement (sans dépendre du navigateur)
 * Basé sur la spécification CSS Color Level 4
 */
function oklabToRgb(oklab: string): string {
  // Parser oklab(l a b / alpha)
  const match = oklab.match(/oklab\s*\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+%?)(?:\s*\/\s*([\d.]+%?))?\s*\)/i);
  if (!match) return "rgb(0,0,0)";

  let l = parseFloat(match[1]);
  let a = parseFloat(match[2]);
  let b = parseFloat(match[3]);
  const alpha = match[4] ? parseFloat(match[4]) : 1;

  // Convertir les pourcentages en valeurs décimales
  if (match[1].includes("%")) l /= 100;
  if (match[2].includes("%")) a /= 100;
  if (match[3].includes("%")) b /= 100;

  // Convertir oklab en XYZ (D65)
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  const l__ = l_ * l_ * l_;
  const m__ = m_ * m_ * m_;
  const s__ = s_ * s_ * s_;

  const x = +4.0767416621 * l__ - 3.3077335964 * m__ + 0.2309699292 * s__;
  const y = -1.2684380046 * l__ + 2.6097574011 * m__ - 0.3413193965 * s__;
  const z = -0.0041960863 * l__ - 0.7034186147 * m__ + 1.7076147010 * s__;

  // Convertir XYZ en sRGB (D65)
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.9692660 * x + 1.8760108 * y + 0.0415560 * z;
  const b_ = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;

  // Gamma correction sRGB
  const toLinear = (v: number) => v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  const toGamma = (v: number) => v > 0.0031308 ? 1.055 * Math.pow(v, 1 / 2.4) - 0.055 : 12.92 * v;

  const rLinear = toLinear(r);
  const gLinear = toLinear(g);
  const bLinear = toLinear(b_);

  const rGamma = toGamma(rLinear);
  const gGamma = toGamma(gLinear);
  const bGamma = toGamma(bLinear);

  // Clip et convertir en 0-255
  const r255 = Math.max(0, Math.min(255, Math.round(rGamma * 255)));
  const g255 = Math.max(0, Math.min(255, Math.round(gGamma * 255)));
  const b255 = Math.max(0, Math.min(255, Math.round(bGamma * 255)));

  if (alpha < 1) {
    return `rgba(${r255}, ${g255}, ${b255}, ${alpha})`;
  }
  return `rgb(${r255}, ${g255}, ${b255})`;
}

/**
 * Pré-traite toutes les règles CSS pour convertir oklch/oklab → rgb.
 * html2canvas lit parfois les CSS directement sans passer par getComputedStyle.
 */
function patchAllCssRules(): void {
  try {
    const sheets = Array.from(document.styleSheets);
    for (const sheet of sheets) {
      try {
        const rules = Array.from(sheet.cssRules);
        for (const rule of rules) {
          // Seuls CSSStyleRule ont une propriété style
          if ((rule as CSSStyleRule).style) {
            const styleRule = rule as CSSStyleRule;
            for (let i = 0; i < styleRule.style.length; i++) {
              const prop = styleRule.style[i];
              const val = styleRule.style.getPropertyValue(prop);
              if (val && (val.includes("oklch") || val.includes("oklab"))) {
                const converted = convertOklchValue(val);
                styleRule.style.setProperty(prop, converted);
              }
            }
          }
        }
      } catch (e) {
        // Ignore CORS errors on stylesheets
      }
    }
  } catch (e) {
    // Ignore errors accessing stylesheets
  }
}

/* ── Confirmation plein-écran après signature inline ── */
function InlineSignedConfirmation({ signedName, onContinue }: { signedName: string; onContinue: () => void }) {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState<0 | 1 | 2>(0);

  const signedAt = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const signedTime = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

  useEffect(() => {
    const t1 = setTimeout(() => setVisible(true), 80);
    const t2 = setTimeout(() => setStep(1), 500);
    const t3 = setTimeout(() => setStep(2), 900);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#0B111E] px-4">
      <div
        className="relative flex items-center justify-center mb-8 transition-all duration-700"
        style={{ opacity: visible ? 1 : 0, transform: visible ? "scale(1)" : "scale(0.5)" }}
      >
        <div className="absolute w-36 h-36 rounded-full bg-[#F59E0B]/10 animate-ping" style={{ animationDuration: "2s" }} />
        <div className="absolute w-28 h-28 rounded-full bg-[#F59E0B]/15" />
        <div className="relative w-24 h-24 rounded-full bg-[#F59E0B] flex items-center justify-center shadow-[0_0_60px_rgba(245,158,11,0.5)]">
          <CheckCircle2 className="w-12 h-12 text-[#0B111E]" strokeWidth={2.5} />
        </div>
      </div>

      <div className="text-center transition-all duration-500 mb-6" style={{ opacity: step >= 1 ? 1 : 0, transform: step >= 1 ? "translateY(0)" : "translateY(16px)" }}>
        <h1 className="text-white text-2xl sm:text-3xl font-bold mb-2">Contrat signé !</h1>
        <p className="text-white/50 text-sm sm:text-base">Votre engagement a été enregistré avec succès.</p>
      </div>

      <div className="w-full max-w-sm transition-all duration-500 mb-8" style={{ opacity: step >= 2 ? 1 : 0, transform: step >= 2 ? "translateY(0)" : "translateY(20px)" }}>
        <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10">
            <div className="w-8 h-8 rounded-lg bg-[#F59E0B]/20 flex items-center justify-center flex-shrink-0">
              <FileText className="w-4 h-4 text-[#F59E0B]" />
            </div>
            <div>
              <p className="text-white text-xs font-semibold">Contrat d'accompagnement Visa</p>
              <p className="text-white/40 text-[11px]">Version 1.1 · Joventy / Akollad Groupe</p>
            </div>
          </div>
          <div className="px-5 py-4 space-y-3">
            {[
              ["Signataire", signedName],
              ["Date", signedAt],
              ["Heure", signedTime],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between items-center">
                <span className="text-white/40 text-xs">{label}</span>
                <span className="text-white text-xs font-semibold capitalize">{value}</span>
              </div>
            ))}
            <div className="flex justify-between items-center">
              <span className="text-white/40 text-xs">Statut</span>
              <span className="flex items-center gap-1.5 text-emerald-400 text-xs font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                Archivé et horodaté
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="w-full max-w-sm transition-all duration-500" style={{ opacity: step >= 2 ? 1 : 0, transform: step >= 2 ? "translateY(0)" : "translateY(20px)" }}>
        <Button
          onClick={onContinue}
          className="w-full h-14 text-base font-bold gap-2 bg-[#F59E0B] hover:bg-[#d97706] text-[#0B111E] rounded-xl"
        >
          Voir mon contrat signé
          <ArrowRight className="w-5 h-5" />
        </Button>
        <p className="text-white/30 text-[11px] text-center mt-3">
          Vous retrouverez ce contrat dans votre espace client à tout moment.
        </p>
      </div>
    </div>
  );
}

/* ── Vue signature inline (contrat non signé) ── */
function UnsignedView({ onSigned }: { onSigned: (name: string) => void }) {
  const [signedName, setSignedName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [hasScrolled, setHasScrolled] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const signContract = useMutation(api.contracts.signContract);

  const today = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const max = el.scrollHeight - el.clientHeight;
      const pct = max > 0 ? Math.min(100, Math.round((el.scrollTop / max) * 100)) : 100;
      setScrollProgress(pct);
      if (pct >= 98) setHasScrolled(true);
    };
    el.addEventListener("scroll", handleScroll);
    handleScroll();
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
      onSigned(signedName.trim());
    } catch {
      setError("Une erreur est survenue. Veuillez réessayer.");
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-3xl mx-auto">

      {/* En-tête + barre de progression */}
      <div className="rounded-2xl bg-[#0B111E] overflow-hidden">
        <div className="h-1 bg-white/10">
          <div className="h-full bg-[#F59E0B] transition-all duration-300" style={{ width: `${scrollProgress}%` }} />
        </div>
        <div className="px-6 sm:px-8 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#F59E0B] flex items-center justify-center flex-shrink-0">
              <FileText className="w-5 h-5 text-[#0B111E]" />
            </div>
            <div>
              <div className="text-[#F59E0B] text-[10px] font-bold tracking-widest uppercase mb-0.5">Signature requise</div>
              <h1 className="text-white text-base sm:text-lg font-bold">Contrat d'Accompagnement Visa</h1>
            </div>
          </div>
          <div className="flex-shrink-0 text-right">
            {!hasScrolled
              ? <span className="text-white/50 text-xs tabular-nums">{scrollProgress}% lu</span>
              : <span className="text-emerald-400 text-xs font-semibold">✓ Prêt à signer</span>
            }
          </div>
        </div>
      </div>

      {/* Contrat scrollable */}
      <div
        ref={scrollRef}
        className="bg-white rounded-2xl border border-border shadow-sm overflow-y-auto relative"
        style={{ maxHeight: "60vh", scrollbarWidth: "thin", scrollbarColor: "#cbd5e1 transparent" }}
      >
        {/* En-tête document */}
        <div className="bg-[#0B111E] px-6 sm:px-10 py-6 sm:py-8">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <div className="text-[#F59E0B] text-[10px] font-bold tracking-widest uppercase mb-2">Document officiel — Akollad Groupe</div>
              <h2 className="text-white text-xl sm:text-2xl font-bold leading-tight">
                Contrat d'Accompagnement <span className="text-[#F59E0B]">Visa</span>
              </h2>
              <p className="text-white/40 text-xs mt-1.5">Version 1.1 — {today}</p>
            </div>
            <div className="hidden sm:block text-right flex-shrink-0 text-white/30 text-[10px] leading-relaxed">
              <div>RCCM : CD/KNG/RCCM/25-A-07960</div>
              <div>N° Impôt : A2557944L</div>
              <div>IDNAT : 01-J6100-N86614P</div>
            </div>
          </div>
        </div>

        {/* Sections du contrat */}
        <div
          className="px-6 sm:px-10 py-7 sm:py-10 space-y-7 text-slate-700 leading-[1.85]"
          style={{ fontFamily: "'Georgia','Times New Roman',serif", fontSize: "15px" }}
        >
          {CONTRACT_SECTIONS.map((section) => (
            <section key={section.title}>
              <h2 className="font-sans font-bold text-[#0B111E] text-xs sm:text-sm uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                {section.title}
              </h2>
              {section.content}
            </section>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-4 border-t border-dashed border-slate-200 text-xs text-slate-400">
            <span>Joventy · Akollad Groupe · Kinshasa, RDC</span>
            <span>Version 1.1 · {new Date().getFullYear()}</span>
          </div>
        </div>

        {/* Indicateur "continuer à lire" */}
        {!hasScrolled && (
          <div className="sticky bottom-0 bg-gradient-to-t from-white via-white/90 to-transparent pt-10 pb-4 px-6 text-center pointer-events-none">
            <p className="text-xs text-slate-400">↓ Faites défiler jusqu'en bas pour signer</p>
          </div>
        )}
      </div>

      {/* Formulaire de signature (révélé après lecture complète) */}
      <div
        className="overflow-hidden transition-all duration-700 ease-out"
        style={{ maxHeight: hasScrolled ? "700px" : "0px", opacity: hasScrolled ? 1 : 0 }}
      >
        <div className="bg-white rounded-2xl border border-border border-t-2 border-t-[#F59E0B] shadow-sm p-6 sm:p-8 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#0B111E] flex items-center justify-center flex-shrink-0">
              <PenLine className="w-5 h-5 text-[#F59E0B]" />
            </div>
            <div>
              <p className="font-bold text-[#0B111E] text-base">Signature numérique</p>
              <p className="text-xs text-slate-500">Tapez votre nom complet pour signer ce contrat</p>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">Nom complet du signataire</label>
            <Input
              placeholder="Votre nom complet"
              value={signedName}
              onChange={(e) => setSignedName(e.target.value)}
              className="text-base font-medium border-slate-300 focus:border-[#0B111E] bg-white"
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
            className="w-full text-base font-bold gap-2 bg-[#0B111E] hover:bg-[#1a2540] text-white disabled:opacity-30 rounded-xl"
            style={{ height: "56px" }}
          >
            <ShieldCheck className="w-5 h-5 text-[#F59E0B]" />
            {isPending ? "Enregistrement en cours…" : "Je signe ce contrat numériquement"}
          </Button>

          <p className="text-[11px] text-slate-400 text-center">
            Signature horodatée · RCCM CD/KNG/RCCM/25-A-07960 · contact@joventy.cd
          </p>
        </div>
      </div>
    </div>
  );
}

export default function MyContract() {
  const sig = useQuery(api.contracts.getContractSignature);
  const contractRef = useRef<HTMLDivElement>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [finalName, setFinalName] = useState("");

  const signedDate = sig
    ? new Date(sig.signedAt).toLocaleDateString("fr-FR", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  const signedTime = sig
    ? new Date(sig.signedAt).toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  const filename = sig
    ? `Contrat-Joventy-${sig.signedName.replace(/\s+/g, "-")}-${sig.contractVersion}.pdf`
    : "Contrat-Joventy.pdf";

  // ── États conditionnels ──

  // Chargement
  if (sig === undefined) {
    return (
      <div className="max-w-3xl mx-auto space-y-4 animate-pulse">
        <div className="h-24 rounded-2xl bg-slate-200" />
        <div className="h-96 rounded-2xl bg-slate-100" />
      </div>
    );
  }

  // Écran de confirmation post-signature
  if (showConfirmation) {
    return (
      <InlineSignedConfirmation
        signedName={finalName}
        onContinue={() => setShowConfirmation(false)}
      />
    );
  }

  // Contrat non signé → vue inline
  if (!sig) {
    return (
      <UnsignedView
        onSigned={(name) => {
          setFinalName(name);
          setShowConfirmation(true);
        }}
      />
    );
  }

  const handleDownload = async () => {
    if (!contractRef.current) return;
    setIsGenerating(true);
    const el = contractRef.current;

    // Pré-convertit les images en data URL pour éviter que html2canvas se bloque
    const imgs = Array.from(el.querySelectorAll("img")) as HTMLImageElement[];
    const origSrcs = new Map<HTMLImageElement, string>();
    await Promise.allSettled(
      imgs.map(async (img) => {
        const src = img.getAttribute("src") ?? "";
        if (!src || src.startsWith("data:")) return;
        origSrcs.set(img, src);
        try {
          const resp = await Promise.race<Response>([
            fetch(src, { mode: "cors", cache: "force-cache" }),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error("timeout")), 4000)
            ),
          ]);
          const blob = await resp.blob();
          const dataUrl = await new Promise<string>((res) => {
            const reader = new FileReader();
            reader.onload = () => res(reader.result as string);
            reader.readAsDataURL(blob);
          });
          img.src = dataUrl;
        } catch {
          img.style.visibility = "hidden";
        }
      })
    );

    const originalGetComputedStyle = window.getComputedStyle;

    // Pré-traite toutes les règles CSS pour convertir oklch/oklab → rgb
    patchAllCssRules();

    // Proxy getComputedStyle pour intercepter et patcher les couleurs oklch/oklab retournées à html2canvas
    window.getComputedStyle = (elt, pseudoElt) => {
      const style = originalGetComputedStyle(elt, pseudoElt);
      return new Proxy(style, {
        get(target, prop) {
          if (prop === "getPropertyValue") {
            return (propertyName: string) => {
              const val = target.getPropertyValue(propertyName);
              if (val && (val.includes("oklch") || val.includes("oklab"))) {
                return convertOklchValue(val);
              }
              return val;
            };
          }
          const val = (target as any)[prop];
          if (typeof val === "string" && (val.includes("oklch") || val.includes("oklab"))) {
            return convertOklchValue(val);
          }
          if (typeof val === "function") {
            return val.bind(target);
          }
          return val;
        }
      });
    };

    try {
      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: "#ffffff",
        logging: false,
        imageTimeout: 0,
      });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const imgH = (canvas.height * pageW) / canvas.width;
      let heightLeft = imgH;
      let position = 0;
      pdf.addImage(imgData, "PNG", 0, position, pageW, imgH);
      heightLeft -= pageH;
      while (heightLeft > 0) {
        position = heightLeft - imgH;
        pdf.addPage();
        pdf.addImage(imgData, "PNG", 0, position, pageW, imgH);
        heightLeft -= pageH;
      }
      // Blob URL — fonctionne dans les iframes et sur tous les navigateurs
      const blob = pdf.output("blob");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      console.error("PDF error:", err);
    } finally {
      window.getComputedStyle = originalGetComputedStyle;
      // Restaure les src et visibilités d'origine
      origSrcs.forEach((src, img) => { img.src = src; img.style.visibility = ""; });
      imgs.forEach((img) => { if (!origSrcs.has(img)) img.style.visibility = ""; });
      setIsGenerating(false);
    }
  };

  const handlePrint = () => {
    const el = contractRef.current;
    if (!el) return;
    const cssTexts = Array.from(document.styleSheets)
      .flatMap((sheet) => {
        try { return Array.from(sheet.cssRules).map((r) => r.cssText); }
        catch { return []; }
      })
      .join("\n");
    const win = window.open("", "_blank", "width=960,height=700");
    if (!win) return;
    win.document.write(`<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"/><title>${filename}</title>
<style>${cssTexts}</style>
<style>@page{margin:10mm}body{background:white;margin:0;padding:16px;font-family:'Georgia','Times New Roman',serif}</style>
</head><body>${el.outerHTML}</body></html>`);
    win.document.close();
    setTimeout(() => { win.focus(); win.print(); win.close(); }, 800);
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-3xl mx-auto">

      {/* ── EN-TÊTE ── */}
      <div className="rounded-2xl bg-[#0B111E] p-6 sm:p-8">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-[#F59E0B] flex items-center justify-center flex-shrink-0">
              <ShieldCheck className="w-6 h-6 text-[#0B111E]" strokeWidth={2.5} />
            </div>
            <div>
              <div className="text-[#F59E0B] text-[10px] font-bold tracking-widest uppercase mb-1">
                Document archivé · Akollad Groupe
              </div>
              <h1 className="text-white text-xl sm:text-2xl font-bold">
                Contrat d'Accompagnement Visa
              </h1>
              <p className="text-white/50 text-sm mt-0.5">Version 1.1</p>
            </div>
          </div>
          {/* Boutons d'action */}
          <div className="flex flex-col sm:flex-row gap-2 flex-shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrint}
              className="gap-1.5 text-xs bg-white/10 border-white/20 text-white hover:bg-white/20 hover:text-white"
            >
              <Printer className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Imprimer</span>
            </Button>
            <Button
              size="sm"
              onClick={handleDownload}
              disabled={isGenerating || !sig}
              className="gap-1.5 text-xs bg-[#F59E0B] hover:bg-[#d97706] text-[#0B111E] font-bold disabled:opacity-40"
            >
              <Download className="w-3.5 h-3.5" />
              {isGenerating ? "Génération…" : <><span className="hidden sm:inline">Télécharger </span>PDF</>}
            </Button>
          </div>
        </div>

        {/* Grille des métadonnées de signature */}
        {sig ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3">
              <User className="w-4 h-4 text-[#F59E0B] flex-shrink-0" />
              <div>
                <p className="text-white/40 text-[11px]">Signataire</p>
                <p className="text-white text-sm font-semibold">{sig.signedName}</p>
              </div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3">
              <Clock className="w-4 h-4 text-[#F59E0B] flex-shrink-0" />
              <div>
                <p className="text-white/40 text-[11px]">Date de signature</p>
                <p className="text-white text-sm font-semibold capitalize">{signedDate}</p>
              </div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3">
              <Hash className="w-4 h-4 text-[#F59E0B] flex-shrink-0" />
              <div>
                <p className="text-white/40 text-[11px]">Version signée</p>
                <p className="text-white text-sm font-semibold">{sig.contractVersion}</p>
              </div>
            </div>
            <div className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 flex items-center gap-3">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <div>
                <p className="text-white/40 text-[11px]">Heure · Statut</p>
                <p className="text-emerald-400 text-sm font-semibold">{signedTime} · Archivé</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white/50 text-sm">
            Chargement…
          </div>
        )}
      </div>

      {/* ── CONTENU DU CONTRAT ── */}
      <div ref={contractRef} className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
        {/* En-tête document */}
        <div className="flex items-center gap-3 px-6 py-5 border-b border-border">
          <div className="w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
            <FileText className="w-4 h-4 text-slate-500" />
          </div>
          <div>
            <p className="font-bold text-[#0B111E] text-sm">Contrat d'accompagnement Visa — Version 1.1</p>
            <p className="text-xs text-slate-400">
              RCCM : CD/KNG/RCCM/25-A-07960 · N° Impôt : A2557944L · IDNAT : 01-J6100-N86614P
            </p>
          </div>
        </div>

        {/* Sections */}
        <div
          className="px-6 sm:px-10 py-8 space-y-7 text-slate-700 leading-[1.8]"
          style={{ fontFamily: "'Georgia', 'Times New Roman', serif" }}
        >
          {CONTRACT_SECTIONS.map((section) => (
            <section key={section.title}>
              <h2 className="font-sans font-bold text-[#0B111E] text-xs sm:text-sm uppercase tracking-wider mb-3 pb-2 border-b border-slate-100">
                {section.title}
              </h2>
              {section.content}
            </section>
          ))}

          {/* Bloc de signature dans le document */}
          {sig && (
            <div className="mt-4 pt-6 border-t-2 border-dashed border-slate-200">
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                  <div>
                    <p className="font-bold text-emerald-800 text-sm">Signé numériquement</p>
                    <p className="text-emerald-700 text-xs mt-0.5">
                      par <strong>{sig.signedName}</strong> · le <span className="capitalize">{signedDate}</span> à {signedTime}
                    </p>
                  </div>
                </div>
                <div className="flex-shrink-0">
                  <span className="inline-flex items-center gap-1.5 bg-emerald-100 border border-emerald-300 text-emerald-700 text-[11px] font-bold px-3 py-1 rounded-full">
                    <ShieldCheck className="w-3 h-3" />
                    Archivé · {sig.contractVersion}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Pied de page document */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-4 border-t border-dashed border-slate-200 text-xs text-slate-400">
            <span>Joventy · Akollad Groupe · Kinshasa, RDC</span>
            <span>Version 1.1 · {new Date().getFullYear()} · contact@joventy.cd</span>
          </div>
        </div>
      </div>
    </div>
  );
}
