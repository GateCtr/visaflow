import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { useEffect, ReactNode } from "react";
import {
  ClerkProvider,
  useAuth as useClerkAuth,
} from "@clerk/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient } from "convex/react";
import { HelmetProvider } from "react-helmet-async";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { AuthProvider, useAuth } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useTrafficTracker } from "@/hooks/useTrafficTracker";

import Landing from "@/pages/Landing";
import Login from "@/pages/auth/Login";
import Register from "@/pages/auth/Register";
import SSOCallback from "@/pages/auth/SSOCallback";
import ContinueSignUp from "@/pages/auth/ContinueSignUp";
import NotFound from "@/pages/not-found";
import PublicTracking from "@/pages/PublicTracking";
import DestinationPage from "@/pages/DestinationPage";
import GuidesIndex from "@/pages/GuidesIndex";
import GuidePage from "@/pages/GuidePage";
import EmbassiesIndex from "@/pages/EmbassiesIndex";
import EmbassyPage from "@/pages/EmbassyPage";

import AlerteEspagne from "@/pages/AlerteEspagne";
import AlerteSchengen from "@/pages/AlerteSchengen";
import Prix from "@/pages/Prix";
import CreneauxAllemagne from "@/pages/creneaux/CreneauxAllemagne";
import CreneauxEspagne from "@/pages/creneaux/CreneauxEspagne";
import CreneauxSchengen from "@/pages/creneaux/CreneauxSchengen";
import CreneauxUSA from "@/pages/creneaux/CreneauxUSA";
import CreneauxFranceLongSejour from "@/pages/creneaux/CreneauxFranceLongSejour";
import AuditDiagnostic from "@/pages/AuditDiagnostic";
import APropos from "@/pages/APropos";

import MentionsLegales from "@/pages/legal/MentionsLegales";
import Confidentialite from "@/pages/legal/Confidentialite";
import Conditions from "@/pages/legal/Conditions";
import Remboursement from "@/pages/legal/Remboursement";

import ClientDashboard from "@/pages/client/Dashboard";
import ClientApplications from "@/pages/client/Applications";
import NewApplication from "@/pages/client/NewApplication";
import NewCreneauApplication from "@/pages/client/NewCreneauApplication";
import ClientApplicationDetail from "@/pages/client/ApplicationDetail";
import PaymentGate from "@/pages/client/PaymentGate";
import ClientInvoice from "@/pages/client/Invoice";
import ClientMessages from "@/pages/client/Messages";
import MyContract from "@/pages/client/MyContract";

import SpainAlerts from "@/pages/admin/SpainAlerts";
import SchengenAlerts from "@/pages/admin/SchengenAlerts";
import AdminDashboard from "@/pages/admin/Dashboard";
import AdminApplications from "@/pages/admin/Applications";
import AdminApplicationDetail from "@/pages/admin/application-detail/index";
import AdminClients from "@/pages/admin/Clients";
import ClientDetail from "@/pages/admin/ClientDetail";
import AdminMessages from "@/pages/admin/Messages";
import AdminReviews from "@/pages/admin/Reviews";
import AdminBotTest from "@/pages/admin/BotTest";
import AdminBotLogs from "@/pages/admin/BotLogs";
import AdminCevSessions from "@/pages/admin/CevSessions";
import AdminAnalytics from "@/pages/admin/Analytics";
import AdminCalendar from "@/pages/admin/Calendar";
import AdminBotSettings from "@/pages/admin/BotSettings";
import VictorAnalytics from "@/pages/admin/VictorAnalytics";
import { VictorWidget } from "@/components/VictorWidget";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

// In dev mode, prefer the dev key but fall back to the prod key if not set.
// Without this fallback, ClerkProvider receives `undefined` and all auth fails.
const clerkPublishableKey = (
  import.meta.env.DEV
    ? (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY_DEV ?? import.meta.env.VITE_CLERK_PUBLISHABLE_KEY)
    : import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
) as string;

const Redirect = ({ to }: { to: string }) => {
  const [, setLocation] = useLocation();
  useEffect(() => {
    setLocation(to);
  }, [to, setLocation]);
  return null;
};

const ProtectedRoute = ({
  component: Component,
  adminOnly = false,
  ...rest
}: any) => {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-muted-foreground">
        Chargement...
      </div>
    );
  }

  if (!user) return <Redirect to="/login" />;
  if (adminOnly && user.role !== "admin") return <Redirect to="/dashboard" />;

  if (!adminOnly) {
    return (
      <DashboardLayout isAdmin={false}>
        <Component {...rest} />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout isAdmin={adminOnly}>
      <Component {...rest} />
    </DashboardLayout>
  );
};

function RouterWithTracker() {
  useTrafficTracker();
  return null;
}

function Router() {
  return (
    <>
    <RouterWithTracker />
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/sso-callback" component={SSOCallback} />
      <Route path="/continue" component={ContinueSignUp} />
      <Route path="/suivi/:token" component={PublicTracking} />

      {/* Guides SEO pages */}
      <Route path="/guides" component={GuidesIndex} />
      <Route path="/guides/:slug" component={GuidePage} />

      {/* Destination SEO pages */}
      <Route path="/visa-usa-kinshasa" component={DestinationPage} />
      <Route path="/visa-canada-kinshasa" component={DestinationPage} />
      <Route path="/visa-royaume-uni-kinshasa" component={DestinationPage} />
      <Route path="/visa-schengen-kinshasa" component={DestinationPage} />
      <Route path="/visa-espagne-kinshasa" component={DestinationPage} />
      <Route path="/visa-france-long-sejour-kinshasa" component={DestinationPage} />
      <Route path="/visa-allemagne-kinshasa" component={DestinationPage} />
      <Route path="/visa-suisse-kinshasa" component={DestinationPage} />
      <Route path="/e-visa-dubai-kinshasa" component={DestinationPage} />
      <Route path="/visa-turquie-kinshasa" component={DestinationPage} />
      <Route path="/e-visa-inde-kinshasa" component={DestinationPage} />
      <Route path="/visa-maroc-kinshasa" component={DestinationPage} />
      <Route path="/e-visa-egypte-kinshasa" component={DestinationPage} />
      <Route path="/visa-chine-kinshasa" component={DestinationPage} />
      <Route path="/visa-albanie-kinshasa" component={DestinationPage} />
      <Route path="/visa-bresil-kinshasa" component={DestinationPage} />

      {/* Embassy SEO pages */}
      <Route path="/ambassades" component={EmbassiesIndex} />
      <Route path="/ambassade-usa-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-canada-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-royaume-uni-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-schengen-france-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-allemagne-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-belgique-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-espagne-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-suisse-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-emirats-arabes-unis-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-turquie-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-inde-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-maroc-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-egypte-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-chine-kinshasa" component={EmbassyPage} />
      <Route path="/ambassade-bresil-kinshasa" component={EmbassyPage} />

      {/* Alertes */}
      <Route path="/alerte-espagne" component={AlerteEspagne} />
      <Route path="/alerte-schengen" component={AlerteSchengen} />

      {/* Créneau landing pages — slot_only SEO */}
      <Route path="/creneaux-visa-allemagne-kinshasa" component={CreneauxAllemagne} />
      <Route path="/creneaux-visa-espagne-kinshasa" component={CreneauxEspagne} />
      <Route path="/creneaux-visa-schengen-belgique-kinshasa" component={CreneauxSchengen} />
      <Route path="/creneaux-visa-usa-kinshasa" component={CreneauxUSA} />
      <Route path="/creneaux-visa-france-long-sejour-kinshasa" component={CreneauxFranceLongSejour} />

      {/* Pricing & About */}
      <Route path="/prix" component={Prix} />
      <Route path="/audit-diagnostic" component={AuditDiagnostic} />
      <Route path="/a-propos" component={APropos} />

      <Route path="/mentions-legales" component={MentionsLegales} />
      <Route path="/confidentialite" component={Confidentialite} />
      <Route path="/conditions" component={Conditions} />
      <Route path="/remboursement" component={Remboursement} />

      <Route path="/dashboard">
        {() => <ProtectedRoute component={ClientDashboard} />}
      </Route>
      <Route path="/dashboard/applications">
        {() => <ProtectedRoute component={ClientApplications} />}
      </Route>
      <Route path="/dashboard/applications/new/creneau">
        {() => <ProtectedRoute component={NewCreneauApplication} />}
      </Route>
      <Route path="/dashboard/applications/new">
        {() => <ProtectedRoute component={NewApplication} />}
      </Route>
      <Route path="/dashboard/applications/:id/payment">
        {() => <ProtectedRoute component={PaymentGate} />}
      </Route>
      <Route path="/dashboard/applications/:id/invoice">
        {() => <ProtectedRoute component={ClientInvoice} />}
      </Route>
      <Route path="/dashboard/applications/:id">
        {() => <ProtectedRoute component={ClientApplicationDetail} />}
      </Route>
      <Route path="/dashboard/messages">
        {() => <ProtectedRoute component={ClientMessages} />}
      </Route>
      <Route path="/dashboard/contrat">
        {() => <ProtectedRoute component={MyContract} />}
      </Route>

      <Route path="/admin">
        {() => <ProtectedRoute adminOnly component={AdminDashboard} />}
      </Route>
      <Route path="/admin/applications">
        {() => <ProtectedRoute adminOnly component={AdminApplications} />}
      </Route>
      <Route path="/admin/applications/:id">
        {() => <ProtectedRoute adminOnly component={AdminApplicationDetail} />}
      </Route>
      <Route path="/admin/clients">
        {() => <ProtectedRoute adminOnly component={AdminClients} />}
      </Route>
      <Route path="/admin/clients/:clerkId">
        {() => <ProtectedRoute adminOnly component={ClientDetail} />}
      </Route>
      <Route path="/admin/messages">
        {() => <ProtectedRoute adminOnly component={AdminMessages} />}
      </Route>
      <Route path="/admin/reviews">
        {() => <ProtectedRoute adminOnly component={AdminReviews} />}
      </Route>
      <Route path="/admin/cev-sessions">
        {() => <ProtectedRoute adminOnly component={AdminCevSessions} />}
      </Route>
      <Route path="/admin/analytics">
        {() => <ProtectedRoute adminOnly component={AdminAnalytics} />}
      </Route>
      <Route path="/admin/calendar">
        {() => <ProtectedRoute adminOnly component={AdminCalendar} />}
      </Route>
      <Route path="/admin/bot-test">
        {() => <ProtectedRoute adminOnly component={AdminBotTest} />}
      </Route>
      <Route path="/admin/bot-logs">
        {() => <ProtectedRoute adminOnly component={AdminBotLogs} />}
      </Route>
      <Route path="/admin/bot-settings">
        {() => <ProtectedRoute adminOnly component={AdminBotSettings} />}
      </Route>
      <Route path="/admin/victor">
        {() => <ProtectedRoute adminOnly component={VictorAnalytics} />}
      </Route>
      <Route path="/admin/spain-alerts">
        {() => <ProtectedRoute adminOnly component={SpainAlerts} />}
      </Route>
      <Route path="/admin/schengen-alerts">
        {() => <ProtectedRoute adminOnly component={SchengenAlerts} />}
      </Route>

      <Route component={NotFound} />
    </Switch>
    <VictorWidget />
    </>
  );
}

function App() {
  const base = (import.meta.env.BASE_URL as string).replace(/\/$/, "");

  return (
    <HelmetProvider>
      <WouterRouter base={base}>
        <ClerkProvider publishableKey={clerkPublishableKey}>
          <ConvexProviderWithClerk client={convex} useAuth={useClerkAuth}>
            <TooltipProvider>
              <AuthProvider>
                <Router />
              </AuthProvider>
              <Toaster />
            </TooltipProvider>
          </ConvexProviderWithClerk>
        </ClerkProvider>
      </WouterRouter>
    </HelmetProvider>
  );
}

export default App;
