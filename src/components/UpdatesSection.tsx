// Settings → Updates row: version, status, one action button, auto-check toggle.
// AppImage, Windows and Mac release builds install updates themselves; other installs get a link
// to the releases page (see updateMode in main.cjs).
import { useState } from 'react';
import { Check, ExternalLink, X } from 'lucide-react';
import { timeAgo, useUpdate } from '../updates';

export default function UpdatesSection() {
  const s = useUpdate((x) => x.status);
  const [busy, setBusy] = useState(false);
  const api = window.studio.updates;
  if (!api) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const state = s?.state || 'idle';
  const working = state === 'checking' || state === 'downloading' || busy;
  const canInstall = s?.mode === 'install';
  const pct = Math.floor(s?.percent || 0);

  return (
    <>
      <label>Updates</label>
      <div className="set-cell" data-testid="settings-updates">
        <div className="set-line">
          <span className="upd-ver" data-testid="update-current">v{s?.current || '…'}</span>
          {s?.mode === 'source' ? (
            <span className="faint" data-testid="update-source">from source · <code>git pull</code></span>
          ) : (
            <>
              <span className="upd-status" data-testid="update-status" data-state={state}>
                {state === 'checking' && <span className="faint">Checking…</span>}
                {state === 'latest' && <span className="set-test ok"><Check size={12} /> Up to date</span>}
                {state === 'error' && <span className="set-test bad" title={s?.error}><X size={12} /> {s?.error}</span>}
                {state === 'available' && <b>{s?.version} is available</b>}
                {state === 'downloading' && <span>Downloading… {pct}%</span>}
                {state === 'ready' && <b>{s?.version} is ready</b>}
              </span>
              <span className="spacer" />
              {state === 'available' && canInstall && (
                <button className="btn small primary" disabled={working} onClick={() => run(() => api.download())} data-testid="update-download">Download</button>
              )}
              {state === 'available' && !canInstall && (
                <button className="btn small primary" onClick={() => api.openPage()} data-testid="update-open-page">Download <ExternalLink size={11} /></button>
              )}
              {state === 'ready' && (
                <button className="btn small primary" disabled={busy} onClick={() => run(() => api.install())} data-testid="update-install">Restart to update</button>
              )}
              {state !== 'ready' && state !== 'downloading' && (
                <button className="btn small" disabled={working} onClick={() => run(() => api.check())} data-testid="update-check">Check</button>
              )}
            </>
          )}
        </div>
        {s?.mode !== 'source' && (
          <>
            {state === 'downloading' && (
              <div className="upd-bar" data-testid="update-progress"><i style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></div>
            )}
            {(state === 'available' || state === 'downloading' || state === 'ready') && s?.notes ? (
              <div className="upd-notes" data-testid="update-notes">{s.notes}</div>
            ) : null}
            <div className="set-line faint small">
              <label className="upd-auto">
                <input type="checkbox" checked={!!s?.autoCheck} onChange={(e) => api.setAuto(e.target.checked).then((n) => useUpdate.setState({ status: n }))} data-testid="update-auto" />
                Check automatically
              </label>
              {s?.lastCheck && <span data-testid="update-last">· checked {timeAgo(s.lastCheck)}</span>}
            </div>
          </>
        )}
      </div>
    </>
  );
}
