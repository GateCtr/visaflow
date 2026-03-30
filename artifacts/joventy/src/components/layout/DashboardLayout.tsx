import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import {
  Shield,
  LayoutDashboard,
  FileText,
  PlusCircle,
  Users,
  LogOut,
  ChevronRight,
  MessageCircle,
} from "lucide-react";

interface DashboardLayoutProps {
  children: ReactNode;
  isAdmin?: boolean;
}

export function DashboardLayout({ children, isAdmin = false }: DashboardLayoutProps) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const unreadTotal = useQuery(api.messages.getUnreadTotal) ?? 0;

  const clientLinks = [
    { href: "/dashboard", label: "Vue d'ensemble", icon: LayoutDashboard },
    { href: "/dashboard/applications", label: "Mes Dossiers", icon: FileText },
    { href: "/dashboard/applications/new", label: "Nouveau Dossier", icon: PlusCircle },
    { href: "/dashboard/messages", label: "Messagerie", icon: MessageCircle, badge: unreadTotal },
  ];

  const adminLinks = [
    { href: "/admin", label: "Tableau de Bord", icon: LayoutDashboard },
    { href: "/admin/applications", label: "Tous les Dossiers", icon: FileText },
    { href: "/admin/clients", label: "Clients", icon: Users },
    { href: "/admin/messages", label: "Messagerie", icon: MessageCircle, badge: unreadTotal },
  ];

  const links = isAdmin ? adminLinks : clientLinks;

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col md:flex-row">
      {/* Sidebar */}
      <aside className="w-full md:w-64 bg-white border-r border-border flex-shrink-0 flex flex-col z-20 sticky top-0 md:h-screen">
        <div className="p-6 border-b border-border flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3 group">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <Shield className="w-4 h-4 text-secondary" />
            </div>
            <span className="font-serif text-xl font-bold text-primary">Joventy</span>
          </Link>
        </div>

        <div className="p-4">
          <div className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Menu Principal
          </div>
          <nav className="space-y-1">
            {links.map((link) => {
              const Icon = link.icon;
              const isActive = location === link.href;
              const badge = "badge" in link ? link.badge : 0;
              return (
                <Link key={link.href} href={link.href}>
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

        <div className="mt-auto p-4 border-t border-border">
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
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-x-hidden flex flex-col min-h-[calc(100vh-80px)] md:min-h-screen">
        <div className="p-4 sm:p-8 flex-1">{children}</div>
      </main>
    </div>
  );
}
