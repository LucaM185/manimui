// Self-update status, mirrored from the main process (electron/main.cjs "updates"). Installs that
// can update themselves download a new version in the background and then show one toast,
// "MathStudio x is ready · Restart" (it also installs on the next quit). Others get "x is available ·
// Download", which opens the releases page. Either way there is a dot on the top-bar Settings icon.
import { create } from 'zustand';
import { useStore } from './store';
import type { UpdateStatus } from './types';

export const useUpdate = create<{ status: UpdateStatus | null }>(() => ({ status: null }));

let started = false;
const toasted = new Set<string>();

function apply(s: UpdateStatus) {
  useUpdate.setState({ status: s });
  if (!s.silent || !s.version) return;
  const once = (key: string) => !toasted.has(key) && !!toasted.add(key);
  const api = window.studio.updates;
  if (s.state === 'ready' && once(`ready ${s.version}`)) {
    useStore.getState().toast(`MathStudio ${s.version} is ready`, 'info', { label: 'Restart', run: () => { api?.install(); } });
  } else if (s.state === 'available' && s.mode === 'notify' && once(`available ${s.version}`)) {
    useStore.getState().toast(`MathStudio ${s.version} is available`, 'info', { label: 'Download', run: () => { api?.openPage(); } });
  }
}

export function initUpdates() {
  const api = window.studio.updates;
  if (!api || started) return;
  started = true;
  api.onState(apply);
  api.get().then(apply).catch(() => {});
}

/** worth a dot on the top-bar Settings icon */
export const hasUpdate = (s: UpdateStatus | null) => !!s && (s.state === 'available' || s.state === 'ready');

export function formatBytes(n?: number) {
  if (!n && n !== 0) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function timeAgo(iso: string | null) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
