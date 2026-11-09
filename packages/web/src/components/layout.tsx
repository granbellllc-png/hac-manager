const projectName = 'HAC Manager';
import { Menu, Moon, Sun, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { navItems } from '../nav';
import { useTheme } from '../theme';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { ServerStatus } from './server-status';

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <ul className="flex flex-col gap-1">
      {navItems.map(({ path, label, icon: Icon }) => (
        <li key={path}>
          <NavLink
            to={path}
            end={path === '/'}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent',
                isActive && 'bg-accent text-accent-foreground',
              )
            }
          >
            <Icon aria-hidden className="h-4 w-4" />
            {label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { theme, toggle } = useTheme();
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col gap-4 border-r border-border p-4 md:flex">
        <span className="px-3 text-lg font-semibold">{projectName}</span>
        <nav aria-label="Primary">
          <NavList />
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-4 py-2">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open navigation"
            onClick={() => {
              setDrawerOpen(true);
            }}
          >
            <Menu aria-hidden className="h-5 w-5" />
          </Button>
          <span className="font-semibold md:hidden">{projectName}</span>
          <div className="ml-auto flex items-center gap-3">
            <ServerStatus />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              onClick={toggle}
            >
              {theme === 'dark' ? (
                <Sun aria-hidden className="h-5 w-5" />
              ) : (
                <Moon aria-hidden className="h-5 w-5" />
              )}
            </Button>
          </div>
        </header>
        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Close navigation overlay"
            className="absolute inset-0 bg-black/50"
            onClick={() => {
              setDrawerOpen(false);
            }}
          />
          <nav
            aria-label="Mobile"
            className="absolute inset-y-0 left-0 flex w-64 flex-col gap-4 bg-background p-4 shadow-lg"
          >
            <div className="flex items-center justify-between">
              <span className="px-3 text-lg font-semibold">{projectName}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close navigation"
                onClick={() => {
                  setDrawerOpen(false);
                }}
              >
                <X aria-hidden className="h-5 w-5" />
              </Button>
            </div>
            <NavList
              onNavigate={() => {
                setDrawerOpen(false);
              }}
            />
          </nav>
        </div>
      )}
    </div>
  );
}
