import type { ReactNode } from 'react';

export function BoundaryCallout({ children }: { children: ReactNode }) {
  return (
    <aside className="my-6 rounded-lg border border-fd-border bg-fd-muted/40 px-4 py-3 text-sm leading-6">
      {children}
    </aside>
  );
}
