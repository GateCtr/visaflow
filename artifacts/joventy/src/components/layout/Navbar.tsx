import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { LogOut, User as UserIcon } from "lucide-react";
import { JoventyLogo } from "@/components/JoventyLogo";

export function Navbar() {
  const { user, logout } = useAuth();

  return (
    <header className="fixed top-0 left-0 right-0 z-50 glass-panel border-b border-white/20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
        <JoventyLogo href="/" variant="light" size="md" />

        <nav className="hidden md:flex items-center gap-8">
          <Link href="/#services" className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors">Nos Services</Link>
          <Link href="/#destinations" className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors">Destinations</Link>
          <Link href="/#contact" className="text-sm font-medium text-muted-foreground hover:text-primary transition-colors">Contact</Link>
        </nav>

        <div className="flex items-center gap-4">
          {user ? (
            <>
              <Link href={user.role === "admin" ? "/admin" : "/dashboard"}>
                <Button variant="ghost" className="hidden sm:flex gap-2">
                  <UserIcon className="w-4 h-4" />
                  Mon Espace
                </Button>
              </Link>
              <Button onClick={logout} variant="outline" className="gap-2 border-primary/20 hover:bg-red-50 hover:text-red-600 hover:border-red-200">
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">Déconnexion</span>
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
      </div>
    </header>
  );
}
