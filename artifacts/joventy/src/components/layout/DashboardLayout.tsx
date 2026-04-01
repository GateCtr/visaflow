import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { OnboardingModal } from "@/components/OnboardingModal";
import {
  LayoutDashboard,
  FileText,
  PlusCircle,
  Users,
  LogOut,
  ChevronRight,
  MessageCircle,
  MessageSquareHeart,
  Menu,
  X,
  Bot,
} from "lucide-react";
import { JoventyLogo } from "@/components/JoventyLogo";

interface DashboardLayoutProps {
  children: ReactNode;
  isAdmin?: boolean;
}

export function DashboardLayout({ children, isAdmin = false }: DashboardLayoutProps) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const unreadTotal = useQuery(api.messages.getUnreadTotal) ?? 0;
  const [mobileOpen, setMobileOpen] = useState(false);

  const clientLinks = [
    { href: "/dashboard", label: "Vue d'ensemble", icon: LayoutDashboard },
    { href: "/dashboard/applications", label: "Mes Dossiers", icon: FileText },
    { href: "/dashboard/applications/new", label: "Nouveau Dossier", icon: PlusCircle },
    { href: "/dashboard/messages", label: "Messagerie", icon: MessageCircle, badge: unreadTotal },
  ];

  const pendingReviews = useQuery(isAdmin ? api.reviews.listAll : "skip");
  const pendingReviewCount = pendingReviews?.filter((r) => !r.isApproved).length ?? 0;

  const adminLinks = [
    { href: "/admin", label: "Tableau de Bord", icon: LayoutDashboard },
    { href: "/admin/applications", label: "Tous les Dossiers", icon: FileText },
    { href: "/admin/clients", label: "Clients", icon: Users },
    { href: "/admin/messages", label: "Messagerie", icon: MessageCircle, badge: unreadTotal },
    { href: "/admin/reviews", label: "Avis Clients", icon: MessageSquareHeart, badge: pendingReviewCount },
    { href: "/admin/bot-test", label: "Bot & Portails", icon: Bot },
  ];

  const links = isAdmin ? adminLinks : clientLinks;

  const SidebarContent = ({ onNav }: { onNav?: () => void }) => (
    <>
      <div className="p-6 border-b border-border flex items-center justify-between">
        <JoventyLogo href="/" variant="light" size="sm" />
        {onNav && (
          <button
            onClick={onNav}
            className="md:hidden flex items-center justify-center w-8 h-8 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5 text-slate-500" />
          </button>
        )}
      </div>

      <div className="p-4 flex-1 overflow-y-auto">
        <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Menu Principal
        </div>
        <nav className="space-y-1">
          {links.map((link) => {
            const Icon = link.icon;
            const isActive = location === link.href;
            const badge = "badge" in link ? link.badge : 0;
            return (
              <Link key={link.href} href={link.href} onClick={onNav}>
                <div
                  className={`
                    flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer
                    ${
                      isActive
                        ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
                        : "text-slate-600 hover:bg-slate-100 hover:text-primary"
                    }
                  `}
                >
                  <div className="flex items-center gap-3">
                    <Icon
                      className={`w-5 h-5 ${isActive ? "text-secondary" : "text-slate-400"}`}
                    />
                    {link.label}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {(badge ?? 0) > 0 && !isActive && (
                      <span className="bg-red-500 text-white text-[10px] font-bold min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center">
                        {(badge ?? 0) > 99 ? "99+" : badge}
                      </span>
                    )}
                    {isActive && <ChevronRight className="w-4 h-4 opacity-50" />}
                  </div>
                </div>
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="p-4 border-t border-border">
        <div className="flex items-center gap-3 px-3 py-2 mb-4">
          <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center font-bold text-primary border border-slate-200 flex-shrink-0">
            {user?.firstName?.[0]}
            {user?.lastName?.[0]}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold text-primary truncate">
              {user?.firstName} {user?.lastName}
            </div>
            <div className="text-xs text-muted-foreground truncate">{user?.email}</div>
          </div>
        </div>
        <button
          onClick={logout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
        >
          <LogOut className="w-5 h-5 text-red-500" />
          Déconnexion
        </button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row">
      {!isAdmin && <OnboardingModal />}
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-64 bg-white border-r border-border flex-shrink-0 flex-col z-20 sticky top-0 h-screen">
        <SidebarContent />
      </aside>

      {/* Mobile top bar */}
      <header className="md:hidden flex items-center justify-between px-4 py-3 bg-white border-b border-border sticky top-0 z-30">
        <JoventyLogo href="/" variant="light" size="sm" />
        <div className="flex items-center gap-2">
          {unreadTotal > 0 && (
            <span className="bg-red-500 text-white text-[10px] font-bold min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center">
              {unreadTotal > 99 ? "99+" : unreadTotal}
            </span>
          )}
          <button
            onClick={() => setMobileOpen(true)}
            className="flex items-center justify-center w-10 h-10 rounded-xl hover:bg-slate-100 transition-colors"
            aria-label="Menu"
          >
            <Menu className="w-5 h-5 text-primary" />
          </button>
        </div>
      </header>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <div
        className={`fixed top-0 left-0 z-50 h-full w-72 bg-white flex flex-col shadow-2xl md:hidden transition-transform duration-300 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <SidebarContent onNav={() => setMobileOpen(false)} />
      </div>

      {/* Main Content */}
      <main className="flex-1 overflow-x-hidden flex flex-col min-h-[calc(100vh-57px)] md:min-h-screen">
        <div className="p-4 sm:p-8 flex-1">{children}</div>
      </main>
    </div>
  );
}
