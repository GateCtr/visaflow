import { Clock, Wallet, ShieldCheck } from "lucide-react";

const ARGUMENTS = [
  {
    icon: Clock,
    title: "Gain de temps",
    desc: "Pas besoin de subir les embouteillages de Kinshasa pour déposer des papiers. Vous gérez tout depuis votre téléphone.",
  },
  {
    icon: Wallet,
    title: "Économie",
    desc: "Moins de frais de bureaux physiques pour nous = des tarifs d'accompagnement plus bas pour vous.",
  },
  {
    icon: ShieldCheck,
    title: "Traçabilité",
    desc: "Un espace client sécurisé unique où vous suivez l'avancement de votre dossier en temps réel.",
  },
];

/**
 * "Pourquoi 100% en ligne ?" reassurance block — placed just before pricing /
 * WhatsApp CTAs to defuse the "you have no physical office" objection.
 */
export function Why100PercentOnline() {
  return (
    <section className="py-16 sm:py-20 bg-muted">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <p className="text-secondary font-semibold text-sm uppercase tracking-widest mb-3">Pourquoi 100% en ligne ?</p>
        <h2 className="text-3xl md:text-4xl font-bold text-primary mb-4">
          Un service moderne, 100% à distance.
        </h2>
        <p className="text-muted-foreground text-lg max-w-2xl mx-auto mb-12">
          Joventy n'a pas de bureau physique à Kinshasa — et c'est un choix, pas un manque.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {ARGUMENTS.map((a) => (
            <div key={a.title} className="bg-white border border-border rounded-2xl p-7 text-left">
              <div className="w-11 h-11 rounded-xl bg-secondary/10 flex items-center justify-center mb-4">
                <a.icon className="w-5 h-5 text-secondary" />
              </div>
              <h3 className="font-bold text-primary mb-2">{a.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{a.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
