import { Link } from "wouter";
import { Navbar } from "@/components/layout/Navbar";
import { Button } from "@/components/ui/button";
import { JoventyLogo } from "@/components/JoventyLogo";
import { Plane, ShieldCheck, Clock, FileText, ArrowRight, Star } from "lucide-react";

export default function Landing() {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      
      {/* Hero Section */}
      <section className="relative pt-32 pb-20 lg:pt-48 lg:pb-32 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <img 
            src={`${import.meta.env.BASE_URL}images/hero-bg.png`} 
            alt="Hero abstract background" 
            className="w-full h-full object-cover opacity-90"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-primary/80 via-primary/90 to-background"></div>
        </div>

        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-white text-sm font-medium mb-8">
            <Star className="w-4 h-4 text-secondary fill-secondary" />
            <span>Excellence & Discrétion pour la RDC</span>
          </div>
          
          <h1 className="text-4xl md:text-6xl lg:text-7xl font-serif font-bold text-white tracking-tight leading-tight max-w-4xl mx-auto mb-6">
            Votre passeport pour le monde, <br/>
            <span className="text-gradient-brand">notre expertise absolue.</span>
          </h1>
          
          <p className="text-lg md:text-xl text-slate-300 max-w-2xl mx-auto mb-10 font-light">
            L'accompagnement premium institutionnel pour l'obtention de vos visas USA, Dubaï, Turquie et Inde. Sécurisé, rapide et transparent.
          </p>
          
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/register">
              <Button size="lg" className="w-full sm:w-auto h-14 px-8 text-lg bg-secondary hover:bg-orange-500 text-primary font-bold shadow-xl shadow-secondary/25 rounded-xl transition-all hover:scale-105">
                Démarrer mon dossier
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </Link>
            <Link href="/login">
              <Button size="lg" variant="outline" className="w-full sm:w-auto h-14 px-8 text-lg border-white/30 text-white hover:bg-white/10 hover:text-white backdrop-blur-md rounded-xl">
                Espace Client
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Destinations Section */}
      <section id="destinations" className="py-24 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-serif font-bold text-primary mb-4">Destinations Privilégiées</h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">Nous simplifions les démarches complexes pour les destinations les plus demandées.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {[
              { name: "États-Unis", visa: "B1/B2, F1, K1", icon: Plane },
              { name: "Dubaï (EAU)", visa: "Tourisme & Affaires", icon: Plane },
              { name: "Turquie", visa: "E-Visa & Consulaire", icon: Plane },
              { name: "Inde", visa: "Médical & Affaires", icon: Plane }
            ].map((dest, i) => (
              <div key={i} className="bg-white rounded-2xl p-8 border border-border hover-lift">
                <div className="w-12 h-12 rounded-xl bg-primary/5 flex items-center justify-center mb-6">
                  <dest.icon className="w-6 h-6 text-primary" />
                </div>
                <h3 className="text-xl font-bold text-primary mb-2">{dest.name}</h3>
                <p className="text-sm text-muted-foreground font-medium text-secondary">{dest.visa}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Process Section */}
      <section className="py-24 bg-primary text-white relative overflow-hidden">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="text-3xl md:text-5xl font-serif font-bold mb-6">L'excellence dans chaque détail du processus.</h2>
              <p className="text-slate-300 text-lg mb-8 leading-relaxed">
                Notre plateforme technologique vous permet de suivre l'évolution de votre demande en temps réel, avec la garantie d'une confidentialité totale digne d'une institution bancaire.
              </p>
              
              <div className="space-y-6">
                {[
                  { title: "Évaluation de profil personnalisée", icon: FileText },
                  { title: "Formulaires officiels remplis à votre place", icon: ShieldCheck },
                  { title: "Suivi en temps réel & Chat dédié", icon: Clock }
                ].map((feature, i) => (
                  <div key={i} className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
                      <feature.icon className="w-5 h-5 text-secondary" />
                    </div>
                    <span className="text-lg font-medium">{feature.title}</span>
                  </div>
                ))}
              </div>
            </div>
            
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-tr from-secondary/20 to-transparent rounded-3xl blur-3xl"></div>
              <div className="relative bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-8 shadow-2xl">
                <div className="space-y-4">
                  {[1, 2, 3].map((item) => (
                    <div key={item} className="h-20 rounded-xl bg-white/5 animate-pulse border border-white/10 flex items-center px-6 gap-4">
                      <div className="w-10 h-10 rounded-full bg-white/10"></div>
                      <div className="flex-1 space-y-2">
                        <div className="h-2 bg-white/20 rounded w-1/3"></div>
                        <div className="h-2 bg-white/10 rounded w-1/2"></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-white border-t border-border py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row justify-between items-center gap-6">
          <JoventyLogo variant="light" size="md" />
          <p className="text-sm text-muted-foreground">© {new Date().getFullYear()} Joventy RDC. Tous droits réservés.</p>
        </div>
      </footer>
    </div>
  );
}
