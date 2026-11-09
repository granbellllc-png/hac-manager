import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/layout';
import { navItems } from './nav';
import { PlaceholderPage } from './pages/placeholder';
import { AuditPage } from './pages/audit';
import { HostsPage } from './pages/hosts';
import { HostDetailPage } from './pages/host-detail';
import { AuthProvider } from './auth/auth-context';
import { AuthGate } from './auth/AuthGate';

export function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<HostsPage />} />
            <Route path="/hosts/:id" element={<HostDetailPage />} />
            {navItems
              .filter((item) => item.path !== '/')
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
