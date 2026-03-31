import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { LogOut, User as UserIcon, Menu, X } from "lucide-react";
import { JoventyLogo } from "@/components/JoventyLogo";

export function Navbar() {
  const { user, logout } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 60);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const close = () => setIsOpen(false);
  const solid = scrolled || isOpen;

  return (
    <>
      <header
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          solid
            ? "bg-white/95 backdrop-blur-lg border-b border-border shadow-sm shadow-primary/5"
            : "bg-transparent border-b border-transparent"
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <JoventyLogo href="/" variant={solid ? "light" : "dark"} size="md" />

          <nav className="hidden md:flex items-center gap-8">
            {[
              { label: "Nos Services", anchor: "services" },
              { label: "Destinations", anchor: "destinations" },
              { label: "Contact", anchor: "contact" },
            ].map((link) => (
              <a
                key={link.label}
                href={`#${link.anchor}`}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(link.anchor)?.scrollIntoView({ behavior: "smooth" });
                }}
                className={`text-sm font-medium transition-colors cursor-pointer ${
                  solid
                    ? "text-muted-foreground hover:text-primary"
                    : "text-white/80 hover:text-white"
                }`}
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="hidden md:flex items-center gap-3">
            {user ? (
              <>
                <Link href={user.role === "admin" ? "/admin" : "/dashboard"}>
                  <Button
                    variant="ghost"
                    className={`gap-2 ${solid ? "" : "text-white hover:bg-white/10 hover:text-white"}`}
                  >
                    <UserIcon className="w-4 h-4" />
                    Mon Espace
                  </Button>
                </Link>
                <Button
                  onClick={logout}
                  variant="outline"
                  className={`gap-2 ${
                    solid
                      ? "border-primary/20 hover:bg-red-50 hover:text-red-600 hover:border-red-200"
                      : "border-white/30 text-white hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <LogOut className="w-4 h-4" />
                  Déconnexion
                </Button>
              </>
            ) : (
              <>
                <Link href="/login">
                  <Button
                    variant="ghost"
                    className={`font-medium ${solid ? "" : "text-white hover:bg-white/10 hover:text-white"}`}
                  >
                    Connexion
                  </Button>
                </Link>
                <Link href="/register">
                  <Button
                    className={`font-semibold shadow-lg transition-all ${
                      solid
                        ? "bg-primary hover:bg-primary/90 text-white shadow-primary/20"
                        : "bg-secondary hover:bg-orange-500 text-primary shadow-secondary/30"
                    }`}
                  >
                    Commencer
                  </Button>
                </Link>
              </>
            )}
          </div>

          <button
            className={`md:hidden flex items-center justify-center w-10 h-10 rounded-xl transition-colors ${
              solid ? "hover:bg-primary/10" : "hover:bg-white/10"
            }`}
            onClick={() => setIsOpen((v) => !v)}
            aria-label="Menu"
          >
            {isOpen ? (
              <X className={`w-6 h-6 ${solid ? "text-primary" : "text-white"}`} />
            ) : (
              <Menu className={`w-6 h-6 ${solid ? "text-primary" : "text-white"}`} />
            )}
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
          {[
            { label: "Nos Services", anchor: "services" },
            { label: "Destinations", anchor: "destinations" },
            { label: "Contact", anchor: "contact" },
          ].map((link) => (
            <a
              key={link.label}
              href={`#${link.anchor}`}
              onClick={(e) => {
                e.preventDefault();
                close();
                document.getElementById(link.anchor)?.scrollIntoView({ behavior: "smooth" });
              }}
            >
              <span className="block px-6 py-4 text-sm font-medium text-foreground hover:bg-muted transition-colors">
                {link.label}
              </span>
            </a>
          ))}
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
