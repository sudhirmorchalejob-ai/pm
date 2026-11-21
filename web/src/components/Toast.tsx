import { useEffect, useState } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';

type T = { id: number; kind: 'success' | 'error' | 'info'; text: string };
let push: (t: Omit<T, 'id'>) => void = () => undefined;
let seq = 0;

export const toast = {
  success: (text: string) => push({ kind: 'success', text }),
  error: (text: string) => push({ kind: 'error', text }),
  info: (text: string) => push({ kind: 'info', text }),
};

export function Toaster() {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    push = (t) => {
      const id = ++seq;
      setItems((x) => [...x.slice(-3), { ...t, id }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), t.kind === 'error' ? 6000 : 3500);
    };
  }, []);
  const Icon = { success: CheckCircle2, error: XCircle, info: Info };
  const tone = { success: 'text-emerald-500', error: 'text-rose-500', info: 'text-brand-500' };
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[100] flex flex-col items-center gap-2 px-4 lg:bottom-6 lg:right-6 lg:left-auto lg:items-end" aria-live="polite">
      {items.map((t) => {
        const I = Icon[t.kind];
        return (
          <div key={t.id} role="status" className="card pointer-events-auto flex w-full max-w-sm items-start gap-3 p-3 shadow-lg">
            <I className={`mt-0.5 h-5 w-5 shrink-0 ${tone[t.kind]}`} />
            <p className="flex-1 text-sm">{t.text}</p>
            <button className="muted" aria-label="Dismiss" onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))}><X className="h-4 w-4" /></button>
          </div>
        );
      })}
    </div>
  );
}
