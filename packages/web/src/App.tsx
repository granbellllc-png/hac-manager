import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/layout';
import { navItems } from './nav';
import { PlaceholderPage } from './pages/placeholder';
import { AuditPage } from './pages/audit';
import { HostsPage } from './pages/hosts';
import { HostDetailPage } from './pages/host-detail';
import { AuthProvider } from './auth/auth-context';
import { AuthGate } from './auth/AuthGate';

const ResourcesPage = lazy(() =>
  import('./pages/resources').then((module) => ({
    default: module.ResourcesPage,
  })),
);
const GuestDetailPage = lazy(() =>
  import('./pages/guest-detail').then((module) => ({
    default: module.GuestDetailPage,
  })),
);
const JobsPage = lazy(() =>
  import('./pages/jobs').then((module) => ({
    default: module.JobsPage,
  })),
);
const DriftPage = lazy(() =>
  import('./pages/drift').then((module) => ({
    default: module.DriftPage,
  })),
);

export function RouteLoading() {
  return <p className="text-sm text-muted-foreground">Loading page…</p>;
}

export function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<HostsPage />} />
            <Route path="/hosts/:id" element={<HostDetailPage />} />
            <Route
              path="/resources"
              element={
                <Suspense fallback={<RouteLoading />}>
                  <ResourcesPage />
                </Suspense>
              }
            />
            <Route
              path="/resources/:hostId/:vmid"
              element={
                <Suspense fallback={<RouteLoading />}>
                  <GuestDetailPage />
                </Suspense>
              }
            />
            <Route
              path="/jobs"
              element={
                <Suspense fallback={<RouteLoading />}>
                  <JobsPage />
                </Suspense>
              }
            />
            <Route
              path="/drift"
              element={
                <Suspense fallback={<RouteLoading />}>
                  <DriftPage />
                </Suspense>
              }
            />
            {navItems
              .filter(
                (item) =>
                  item.path !== '/' &&
                  item.path !== '/resources' &&
                  item.path !== '/jobs' &&
                  item.path !== '/drift',
              )
              .map((item) => (
                <Route
                  key={item.path}
                  path={item.path}
                  element={
                    item.path === '/audit' ? (
                      <AuditPage />
                    ) : (
                      <PlaceholderPage item={item} />
                    )
                  }
                />
              ))}
            <Route
              path="*"
              element={
                <section>
                  <h1 className="text-2xl font-semibold">Not found</h1>
                </section>
              }
            />
          </Route>
        </Routes>
      </AuthGate>
    </AuthProvider>
  );
}
