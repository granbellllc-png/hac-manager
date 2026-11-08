import type { NavItem } from '../nav';

export function PlaceholderPage({ item }: { item: NavItem }) {
  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold">{item.label}</h1>
      <p className="text-muted-foreground">{item.description}</p>
      <p className="text-sm text-muted-foreground">Coming soon.</p>
    </section>
  );
}
