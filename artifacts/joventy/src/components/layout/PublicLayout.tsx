import { Navbar } from "@/components/layout/Navbar";
import { PublicFooter } from "@/components/layout/PublicFooter";

interface PublicLayoutProps {
  children: React.ReactNode;
  /**
   * When true, the Navbar is always solid/white (for pages with light-background heroes).
   * When false (default), the Navbar starts transparent and becomes solid on scroll
   * — used for pages where the hero background extends behind the fixed navbar.
   * Also adds pt-20 to the main area when true, to clear the fixed navbar.
   */
  solidNav?: boolean;
}

export function PublicLayout({ children, solidNav = false }: PublicLayoutProps) {
  return (
    <div className="min-h-screen bg-background font-sans">
      <Navbar forceSolid={solidNav} />
      <main className={solidNav ? "pt-20" : ""}>
        {children}
      </main>
      <PublicFooter />
    </div>
  );
}
