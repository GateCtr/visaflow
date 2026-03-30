import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { useEffect, ReactNode } from "react";
import {
  ClerkProvider,
  useAuth as useClerkAuth,
} from "@clerk/clerk-react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ConvexReactClient } from "convex/react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { AuthProvider, useAuth } from "@/lib/auth";
import { DashboardLayout } from "@/components/layout/DashboardLayout";

import Landing from "@/pages/Landing";
import Login from "@/pages/auth/Login";
import Register from "@/pages/auth/Register";
import SSOCallback from "@/pages/auth/SSOCallback";
import NotFound from "@/pages/not-found";

import ClientDashboard from "@/pages/client/Dashboard";
import ClientApplications from "@/pages/client/Applications";
import NewApplication from "@/pages/client/NewApplication";
import ClientApplicationDetail from "@/pages/client/ApplicationDetail";
import ClientMessages from "@/pages/client/Messages";

import AdminDashboard from "@/pages/admin/Dashboard";
import AdminApplications from "@/pages/admin/Applications";
import AdminApplicationDetail from "@/pages/admin/ApplicationDetail";
import AdminClients from "@/pages/admin/Clients";
import AdminMessages from "@/pages/admin/Messages";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);
const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;

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

  return (
    <DashboardLayout isAdmin={adminOnly}>
      <Component {...rest} />
    </DashboardLayout>
  );
};

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/sso-callback" component={SSOCallback} />
      <Route path="/continue" component={SSOCallback} />

      <Route path="/dashboard">
        {() => <ProtectedRoute component={ClientDashboard} />}
      </Route>
      <Route path="/dashboard/applications">
        {() => <ProtectedRoute component={ClientApplications} />}
      </Route>
      <Route path="/dashboard/applications/new">
        {() => <ProtectedRoute component={NewApplication} />}
      </Route>
      <Route path="/dashboard/applications/:id">
        {() => <ProtectedRoute component={ClientApplicationDetail} />}
      </Route>
      <Route path="/dashboard/messages">
        {() => <ProtectedRoute component={ClientMessages} />}
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
      <Route path="/admin/messages">
        {() => <ProtectedRoute adminOnly component={AdminMessages} />}
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function ClerkNavigationProvider({ children }: { children: ReactNode }) {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPublishableKey}
      routerPush={(to) => setLocation(to.replace(/^\/?#/, ""))}
      routerReplace={(to) => setLocation(to.replace(/^\/?#/, ""))}
    >
      {children}
    </ClerkProvider>
  );
}

function HashGuard() {
  const [, setLocation] = useLocation();
  useEffect(() => {
    // Only intercept known Clerk internal hash routes
    const clerkHashRoutes = ["#/continue", "#/factor-one", "#/factor-two", "#/reset-password"];
    const hash = window.location.hash;
    if (hash && clerkHashRoutes.some((r) => hash.startsWith(r))) {
      const path = hash.slice(1);
      window.history.replaceState(null, "", window.location.pathname);
      setLocation(path);
    }
  }, []);
  return null;
}

function App() {
  const base = (import.meta.env.BASE_URL as string).replace(/\/$/, "");

  return (
    <WouterRouter base={base}>
      <HashGuard />
      <ClerkNavigationProvider>
        <ConvexProviderWithClerk client={convex} useAuth={useClerkAuth}>
          <TooltipProvider>
            <AuthProvider>
              <Router />
            </AuthProvider>
            <Toaster />
          </TooltipProvider>
        </ConvexProviderWithClerk>
      </ClerkNavigationProvider>
    </WouterRouter>
  );
}

export default App;
