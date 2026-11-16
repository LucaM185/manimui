import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  action?: () => void;
  disabled?: boolean;
  danger?: boolean;
  sep?: boolean;
  submenu?: MenuItem[];
  testid?: string;
  /** small accent dot after the label (e.g. an update is waiting) */
  dot?: boolean;
}

/** `anchor`: the button that toggles this menu; pressing it is not an outside click (the button closes it). */
export default function ContextMenu({ x, y, items, onClose, className = '', anchor }: { x: number; y: number; items: MenuItem[]; onClose: () => void; className?: string; anchor?: HTMLElement | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [open, setOpen] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
  }, [x, y]);

  // Parents pass a fresh onClose every render. Re-subscribing on each one would drop Escape: the
  // app's own Escape handler re-renders the parent first, and a listener swapped mid-dispatch never runs.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onClose = () => onCloseRef.current();
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const blur = () => onClose();
    // pointerdown in the capture phase: timeline drags preventDefault their pointerdown (which
    // suppresses the compat mousedown) and stopPropagation it, so a bubbling mousedown listener
    // never heard clicks on lanes/clips and the menu stayed open.
    // Deferred so the click that opened the menu doesn't close it; the timer must be cleared too,
    // or a re-run before it fires leaks a listener that later closes newer menus.
    const t = setTimeout(() => window.addEventListener('pointerdown', close, true), 0);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', blur);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
      window.removeEventListener('blur', blur);
    };
  }, []);

  return (
    <div className={`ctx-menu ${className}`} ref={ref} style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <div
            key={i}
            className={`ctx-item ${it.disabled ? 'disabled' : ''} ${it.danger ? 'danger' : ''}`}
            data-testid={it.testid}
            onMouseEnter={() => setOpen(it.submenu ? i : null)}
            onClick={() => {
              if (it.disabled || it.submenu) return;
              it.action?.();
              onClose();
            }}
          >
            <span className="ctx-label"><span className="ctx-icon">{it.icon}</span>{it.label}{it.dot && <span className="upd-dot" />}</span>
            {it.shortcut && <span className="sc">{it.shortcut}</span>}
            {it.submenu && <span className="sc">▸</span>}
            {it.submenu && open === i && (
              <div className="ctx-menu sub">
                {it.submenu.map((s, j) => (
                  <div
                    key={j}
                    className="ctx-item"
                    onClick={(e) => {
                      e.stopPropagation();
                      s.action?.();
                      onClose();
                    }}
                  >
                    <span className="ctx-label"><span className="ctx-icon">{s.icon}</span>{s.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}
