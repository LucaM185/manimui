import { Code2, Download, LayoutGrid, Settings } from 'lucide-react';
import { useStore } from '../store';
import { hasUpdate, useUpdate } from '../updates';
import RecentStrip from './RecentStrip';

type Flag = 'projectsOpen' | 'codeOpen' | 'exportOpen' | 'settingsOpen';

const ACTIONS: { id: string; label: string; icon: React.ReactNode; shortcut: string; flag: Flag; extra?: object }[] = [
  { id: 'projects', label: 'Projects', icon: <LayoutGrid size={16} />, shortcut: '⌘P', flag: 'projectsOpen' },
  { id: 'code', label: 'Code', icon: <Code2 size={16} />, shortcut: '⇧⌘C', flag: 'codeOpen', extra: { codeClip: null } },
  { id: 'export', label: 'Export', icon: <Download size={16} />, shortcut: '⌘E', flag: 'exportOpen' },
  { id: 'settings', label: 'Settings', icon: <Settings size={16} />, shortcut: '⌘,', flag: 'settingsOpen' },
];

// Chrome-like title bar: one tab per project (the one on screen merges into the panels below and
// holds the editable name), free space to drag the window, and a row of small icon buttons on the
// right that open every popup (Projects, Code, Export, Settings). Hovering one shows its name and
// shortcut in a tooltip.
export default function TopBar() {
  const updateDot = useUpdate((u) => hasUpdate(u.status));
  const open: Record<Flag, boolean> = {
    projectsOpen: useStore((s) => s.projectsOpen),
    codeOpen: useStore((s) => s.codeOpen),
    exportOpen: useStore((s) => s.exportOpen),
    settingsOpen: useStore((s) => s.settingsOpen),
  };

  return (
    <header className="topbar">
      <RecentStrip />
      <div className="tb-group right tb-actions" data-testid="app-actions">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            className={`btn ghost tb-icon ${open[a.flag] ? 'active' : ''}`}
            onClick={() => useStore.setState({ [a.flag]: !open[a.flag], ...(open[a.flag] ? {} : a.extra) })}
            aria-label={a.label}
            data-testid={`tb-${a.id}`}
          >
            {a.icon}
            {a.id === 'settings' && updateDot && !open.settingsOpen && <span className="upd-dot" data-testid="update-dot" />}
            <span className="tb-tip" role="tooltip">
              {a.label}
              {a.id === 'settings' && updateDot ? ' · update available' : ''}
              <kbd>{a.shortcut}</kbd>
            </span>
          </button>
        ))}
      </div>
    </header>
  );
}
