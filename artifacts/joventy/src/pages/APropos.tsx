import { Link } from "wouter";
import { Helmet } from "react-helmet-async";
import { ArrowRight, MessageCircle, ChevronRight, ShieldCheck, Users, Globe, Zap, Award, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { JoventyLogo } from "@/components/JoventyLogo";

export default function APropos() {
  const orgSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Joventy",
    "legalName": "Akollad Groupe",
    "url": "https://joventy.cd",
    "foundingDate": "2024",
    "foundingLocation": { "@type": "Place", "name": "Kinshasa, RDC" },
    "description": "Joventy est un service d'assistance visa premium basé à Kinshasa, en République Démocratique du Congo. Fondé par Akollad Groupe, Joventy aide les voyageurs congolais à obtenir leurs visas pour les USA, le Canada, l'Europe, Dubaï, la Turquie et l'Inde grâce à une approche technologique et un modèle de paiement au résultat.",
    "address": { "@type": "PostalAddress", "addressLocality": "Kinshasa", "addressCountry": "CD" },
    "contactPoint": { "@type": "ContactPoint", "telephone": "+243840808122", "contactType": "customer service", "availableLanguage": ["French", "English"] },
    "sameAs": ["https://akollad.com", "https://wa.me/243840808122"],
  };

  return (
    <div className="min-h-screen bg-white font-sans">
      <Helmet>
        <title>À propos de Joventy — Assistance Visa Kinshasa, RDC | Qui sommes-nous ?</title>
        <meta name="description" content="Joventy est un service d'assistance visa premium basé à Kinshasa (RDC). Fondé par Akollad Groupe, nous aidons les voyageurs congolais à obtenir leurs visas USA, Canada, Europe, Dubaï. Paiement M-Pesa, résultat garanti." />
        <link rel="canonical" href="https://joventy.cd/a-propos" />
        <meta property="og:title" content="À propos de Joventy — Assistance Visa Kinshasa, RDC" />
        <meta property="og:description" content="Service d'assistance visa premium basé à Kinshasa. Paiement M-Pesa, prime de succès uniquement si résultat." />
        <meta property="og:url" content="https://joventy.cd/a-propos" />
        <meta property="og:type" content="website" />
        <meta property="og:image" content="https://joventy.cd/opengraph.jpg" />
        <meta property="og:locale" content="fr_CD" />
        <meta property="og:site_name" content="Joventy" />
        <script type="application/ld+json">{JSON.stringify(orgSchema)}</script>
      </Helmet>

      {/* NAV */}
      <header className="bg-white border-b border-border sticky top-0 z-50 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <Link href="/"><JoventyLogo variant="light" size="sm" /></Link>
          <nav className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
            <Link href="/" className="hover:text-primary transition-colors">Accueil</Link>
            <ChevronRight className="w-3 h-3" />
            <span className="text-primary font-semibold">À propos</span>
          </nav>
          <Link href="/register">
            <Button size="sm" className="bg-secondary hover:bg-secondary/90 text-white font-semibold">
              Commencer <ArrowRight className="ml-1.5 w-3.5 h-3.5" />
            </Button>
          </Link>
        </div>
      </header>

      {/* HERO */}
      <section className="bg-gradient-to-b from-primary/5 to-white py-16 px-4">
        <div className="max-w-3xl mx-auto text-center">
          <h1 className="text-3xl md:text-4xl font-bold text-primary mb-4">
            À propos de Joventy
          </h1>
          <p className="text-muted-foreground text-lg leading-relaxed max-w-2xl mx-auto">
            Joventy est le premier service d'assistance visa premium conçu spécifiquement pour les voyageurs congolais, basé à Kinshasa. Nous combinons expertise consulaire et technologie pour simplifier vos démarches de visa — et vous ne payez la prime de succès que si nous obtenons un résultat.
          </p>
        </div>
      </section>

      {/* NOTRE MISSION */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-2xl font-bold text-primary mb-4">Notre mission</h2>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Obtenir un visa depuis la RDC est souvent un parcours du combattant : portails inaccessibles, formulaires complexes en anglais, créneaux consulaires qui disparaissent en secondes, et aucune visibilité sur l'avancement de son dossier.
            </p>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Joventy a été créé pour résoudre ce problème. Notre équipe basée à Kinshasa prend en charge l'intégralité de vos démarches — du remplissage des formulaires officiels à la recherche de créneaux consulaires — pour que vous puissiez vous concentrer sur la préparation de votre voyage.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              Notre promesse : <strong>si nous n'obtenons pas de résultat, vous ne payez pas la prime de succès.</strong> C'est notre manière d'aligner nos intérêts avec les vôtres.
            </p>
          </div>
          <div className="bg-primary/5 rounded-3xl p-8">
            <div className="space-y-5">
              {[
                { icon: Globe, label: "11 destinations", desc: "USA, Canada, Schengen, UK, Dubaï, Turquie, Maroc, Égypte, Inde..." },
                { icon: Users, label: "150+ dossiers traités", desc: "Depuis notre lancement, des dizaines de Congolais ont obtenu leur visa grâce à Joventy." },
                { icon: Zap, label: "48h pour les e-Visas", desc: "Dubaï, Inde, Turquie — résultat en 2-3 jours ouvrables." },
                { icon: Award, label: "4.8/5 satisfaction", desc: "Noté par nos clients sur la base de 127 avis vérifiés." },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.label} className="flex items-start gap-4">
                    <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center flex-shrink-0">
                      <Icon className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <p className="font-bold text-primary text-sm">{item.label}</p>
                      <p className="text-xs text-muted-foreground">{item.desc}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* POURQUOI JOVENTY */}
      <section className="bg-muted py-16 px-4">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-2xl font-bold text-primary text-center mb-10">Ce qui nous différencie</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              { icon: ShieldCheck, title: "Paiement au résultat", desc: "La prime de succès n'est due que lorsque nous obtenons votre créneau consulaire ou votre e-Visa. Aucun résultat = aucun solde. Zéro risque pour vous." },
              { icon: Zap, title: "100% Mobile Money", desc: "Payez via M-Pesa (Vodacom), Airtel Money ou Orange Money. Aucune carte bancaire internationale, aucun virement SWIFT. Conçu pour les résidents de Kinshasa et de la RDC." },
              { icon: Users, title: "Équipe basée à Kinshasa", desc: "Notre équipe connaît les réalités locales : les files au CEV, les particularités de l'ambassade US de Gombe, les banques pour le paiement MRV." },
              { icon: Globe, title: "Surveillance 24/7 des portails", desc: "Nos systèmes surveillent en permanence les portails officiels (usvisaappt.com, CEV, IRCC, ICP) pour capturer les disponibilités dès qu'elles apparaissent." },
              { icon: Award, title: "Expertise multi-destinations", desc: "USA, Canada, Schengen, UK, Dubaï, Turquie, Maroc, Égypte, Inde — chaque destination a ses particularités que nous maîtrisons." },
              { icon: CheckCircle2, title: "Transparence totale", desc: "Tableau de bord client en temps réel, notifications WhatsApp à chaque étape, tarifs affichés publiquement. Aucun frais caché." },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.title} className="bg-white border border-border rounded-2xl p-6">
                  <div className="w-10 h-10 bg-primary/10 rounded-xl flex items-center justify-center mb-4">
                    <Icon className="w-5 h-5 text-primary" />
                  </div>
                  <h3 className="font-bold text-primary mb-2 text-sm">{item.title}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* AKOLLAD GROUPE */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 py-16">
        <div className="bg-primary/5 border border-primary/10 rounded-3xl p-8 sm:p-10">
          <h2 className="text-2xl font-bold text-primary mb-4">Akollad Groupe — Notre société mère</h2>
          <p className="text-muted-foreground leading-relaxed mb-4">
            Joventy est un service de <a href="https://akollad.com" target="_blank" rel="noreferrer" className="text-primary font-semibold hover:underline">Akollad Groupe</a>, une entreprise technologique basée à Kinshasa spécialisée dans le développement de solutions numériques pour l'Afrique centrale.
          </p>
          <p className="text-muted-foreground leading-relaxed mb-4">
            Akollad Groupe développe des plateformes technologiques qui résolvent des problèmes concrets pour les Congolais : accès aux services consulaires, digitalisation de processus administratifs, et solutions de paiement mobile.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            Notre approche : combiner la technologie (surveillance automatisée, portails en ligne, tableaux de bord) avec l'expertise humaine (connaissance des consulats, préparation des dossiers, accompagnement personnalisé).
          </p>
        </div>
      </section>

      {/* COMMENT NOUS CONTACTER */}
      <section className="bg-primary py-14 px-4">
        <div className="max-w-3xl mx-auto text-center text-white">
          <h2 className="text-2xl font-bold mb-3">Contactez-nous</h2>
          <p className="text-white/70 mb-4">Notre équipe est disponible 7j/7 de 8h à 20h (heure Kinshasa).</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8 text-sm">
            <div className="bg-white/10 rounded-xl p-4">
              <p className="font-bold text-white">WhatsApp</p>
              <p className="text-white/60">+243 840 808 122</p>
              <p className="text-white/40 text-xs">Réponse en moins de 2h</p>
            </div>
            <div className="bg-white/10 rounded-xl p-4">
              <p className="font-bold text-white">Email</p>
              <p className="text-white/60">contact@joventy.cd</p>
              <p className="text-white/40 text-xs">Réponse en 24h ouvrables</p>
            </div>
            <div className="bg-white/10 rounded-xl p-4">
              <p className="font-bold text-white">Localisation</p>
              <p className="text-white/60">Kinshasa, RDC</p>
              <p className="text-white/40 text-xs">Équipe 100% locale</p>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row justify-center gap-4">
            <Link href="/register">
              <Button size="lg" className="bg-secondary hover:bg-secondary/90 text-white font-bold">
                Créer mon dossier <ArrowRight className="ml-2 w-4 h-4" />
              </Button>
            </Link>
            <a href="https://wa.me/243840808122" target="_blank" rel="noopener noreferrer">
              <Button size="lg" variant="outline" className="border-white/30 text-white hover:bg-white/10 font-semibold">
                <MessageCircle className="mr-2 w-4 h-4" /> WhatsApp
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="bg-slate-900 text-white/50 py-8 px-4">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4 text-xs">
          <p>© {new Date().getFullYear()} Joventy · Un service <a href="https://akollad.com" target="_blank" rel="noreferrer" className="hover:text-white/70 underline underline-offset-2">Akollad Groupe</a> · Kinshasa, RDC</p>
          <div className="flex gap-4">
            <Link href="/" className="hover:text-white transition-colors">Accueil</Link>
            <Link href="/prix" className="hover:text-white transition-colors">Tarifs</Link>
            <Link href="/guides" className="hover:text-white transition-colors">Guides</Link>
            <Link href="/mentions-legales" className="hover:text-white transition-colors">Légal</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
