import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { LogOut, User as UserIcon, Menu, X } from "lucide-react";
import { JoventyLogo } from "@/components/JoventyLogo";

export function Navbar() {
  const { user, logout } = useAuth();
  const [isOpen, setIsOpen] = useState(false);

  const close = () => setIsOpen(false);

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-50 glass-panel border-b border-white/20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <JoventyLogo href="/" variant="light" size="md" />

          <nav className="hidden md:flex items-center gap-8">
            <Link href="/#services" className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors">Nos Services</Link>
            <Link href="/#destinations" className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors">Destinations</Link>
            <Link href="/#contact" className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors">Contact</Link>
          </nav>

          <div className="hidden md:flex items-center gap-4">
            {user ? (
              <>
                <Link href={user.role === "admin" ? "/admin" : "/dashboard"}>
                  <Button variant="ghost" className="gap-2">
                    <UserIcon className="w-4 h-4" />
                    Mon Espace
                  </Button>
                </Link>
                <Button onClick={logout} variant="outline" className="gap-2 border-primary/20 hover:bg-red-50 hover:text-red-600 hover:border-red-200">
                  <LogOut className="w-4 h-4" />
                  Déconnexion
                </Button>
              </>
            ) : (
              <>
                <Link href="/login">
                  <Button variant="ghost" className="font-medium">Connexion</Button>
                </Link>
                <Link href="/register">
                  <Button className="bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/20">
                    Commencer
                  </Button>
                </Link>
              </>
            )}
          </div>

          <button
            className="md:hidden flex items-center justify-center w-10 h-10 rounded-xl hover:bg-primary/10 transition-colors"
            onClick={() => setIsOpen((v) => !v)}
            aria-label="Menu"
          >
            {isOpen ? <X className="w-6 h-6 text-primary" /> : <Menu className="w-6 h-6 text-primary" />}
          </button>
        </div>
      </header>

      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={close}
        />
      )}

      <div
        className={`fixed top-20 left-0 right-0 z-40 md:hidden bg-white border-b border-border shadow-xl transition-all duration-300 ${
          isOpen ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 -translate-y-2 pointer-events-none"
        }`}
      >
        <nav className="flex flex-col divide-y divide-border">
          <Link href="/#services" onClick={close}>
            <span className="block px-6 py-4 text-sm font-medium text-primary hover:bg-slate-50 transition-colors">Nos Services</span>
          </Link>
          <Link href="/#destinations" onClick={close}>
            <span className="block px-6 py-4 text-sm font-medium text-primary hover:bg-slate-50 transition-colors">Destinations</span>
          </Link>
          <Link href="/#contact" onClick={close}>
            <span className="block px-6 py-4 text-sm font-medium text-primary hover:bg-slate-50 transition-colors">Contact</span>
          </Link>
        </nav>

        <div className="p-4 flex flex-col gap-3">
          {user ? (
            <>
              <Link href={user.role === "admin" ? "/admin" : "/dashboard"} onClick={close}>
                <Button variant="outline" className="w-full gap-2">
                  <UserIcon className="w-4 h-4" />
                  Mon Espace
                </Button>
              </Link>
              <Button
                onClick={() => { close(); logout(); }}
                variant="outline"
                className="w-full gap-2 border-red-200 text-red-600 hover:bg-red-50"
              >
                <LogOut className="w-4 h-4" />
                Déconnexion
              </Button>
            </>
          ) : (
            <>
              <Link href="/login" onClick={close}>
                <Button variant="outline" className="w-full font-medium">Connexion</Button>
              </Link>
              <Link href="/register" onClick={close}>
                <Button className="w-full bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/20">
                  Commencer
                </Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </>
  );
}
