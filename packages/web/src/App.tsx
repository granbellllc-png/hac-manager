import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/layout';
import { navItems } from './nav';
import { PlaceholderPage } from './pages/placeholder';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        {navItems.map((item) => (
          <Route
            key={item.path}
            path={item.path}
            element={<PlaceholderPage item={item} />}
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
  );
}
