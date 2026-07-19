import { ShieldCheck, MapPin, BadgeCheck, Star } from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const QUESTIONS = [
  {
    q: "Avez-vous un bureau physique à Kinshasa ?",
    a: "Non, et c'est volontaire : Joventy est une plateforme 100% en ligne, sans bureau à visiter. Vous créez votre dossier, envoyez vos documents et suivez son avancement depuis votre téléphone — sans file d'attente ni déplacement. Notre équipe reste joignable par WhatsApp et par l'espace client à chaque étape.",
  },
  {
    q: "Joventy est-elle une entreprise légalement enregistrée ?",
    a: "Oui. Joventy est édité et géré par Akollad Groupe, entreprise de droit congolais enregistrée à Kinshasa : RCCM CD/KNG/RCCM/25-A-07960, N° Impôt A2557944L, ID Nat 01-J6100-N86614P. Ces informations sont vérifiables et affichées en bas de chaque page du site.",
  },
  {
    q: "Que se passe-t-il si vous ne trouvez pas de créneau ou que mon dossier n'aboutit pas ?",
    a: "Les frais d'engagement couvrent le travail réalisé dès le départ (analyse du dossier, vérification des pièces, démarches). La prime de succès, elle, n'est due que si nous obtenons un résultat concret — créneau confirmé ou e-Visa délivré. Si nous n'obtenons rien, vous ne payez jamais la prime de succès.",
  },
  {
    q: "Comment savoir si je peux vous faire confiance avant de payer ?",
    a: "Consultez les avis de clients réels plus bas sur cette page, vérifiez nos informations légales (RCCM/Impôt/ID Nat) en pied de page, et posez-nous vos questions par WhatsApp avant de créer votre dossier — nous répondons en moins de 2h, 7j/7.",
  },
];

/**
 * "Sommes-nous fiables ?" trust FAQ — placed right before the WhatsApp / contact
 * section to answer the two objections prospects raise most: no physical office,
 * and reluctance to pay before seeing a result.
 */
export function TrustFAQ() {
  return (
    <section className="py-20 bg-white border-t border-border">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-secondary/10 text-secondary text-xs font-bold uppercase tracking-widest mb-4">
            <ShieldCheck className="w-3.5 h-3.5" />
            Avant de nous écrire
          </div>
          <h2 className="text-3xl md:text-4xl font-bold text-primary mb-4">Sommes-nous fiables ?</h2>
          <p className="text-muted-foreground text-lg max-w-xl mx-auto">
            Les questions que nos clients nous posent le plus souvent avant de créer leur dossier.
          </p>
        </div>

        <Accordion type="single" collapsible className="bg-muted rounded-2xl border border-border px-6 sm:px-8">
          {QUESTIONS.map((item, i) => (
            <AccordionItem key={item.q} value={`item-${i}`} className={i === QUESTIONS.length - 1 ? "border-b-0" : ""}>
              <AccordionTrigger className="text-primary font-semibold text-left py-5">
                {item.q}
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground leading-relaxed">
                {item.a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-8">
          {[
            { icon: MapPin, label: "Entreprise enregistrée à Kinshasa", sub: "RCCM · Impôt · ID Nat vérifiables" },
            { icon: BadgeCheck, label: "Paiement au résultat", sub: "Prime de succès due uniquement si créneau ou e-Visa obtenu" },
            { icon: Star, label: "Avis clients vérifiés", sub: "Publiés uniquement après validation d'un dossier réel" },
          ].map((b) => (
            <div key={b.label} className="flex items-start gap-3 bg-muted border border-border rounded-xl p-4">
              <b.icon className="w-5 h-5 text-secondary flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-primary">{b.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{b.sub}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
