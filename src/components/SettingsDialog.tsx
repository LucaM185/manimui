// Settings popup (top-bar Settings icon, ⌘,): the agent's OpenRouter key, preview quality, updates.
import { useEffect, useState } from 'react';
import { Check, ExternalLink, X } from 'lucide-react';
import { useStore } from '../store';
import { refreshStatus } from '../agent/agent';
import { effectiveQuality, QUALITY_ORDER, QUALITY_PRESETS, type RenderQuality } from '../quality';
import type { AppSettings } from '../types';
import UpdatesSection from './UpdatesSection';

type KeyTest = { state: 'idle' | 'testing' | 'ok' | 'bad'; text?: string };

export default function SettingsDialog() {
  const quality = useStore((s) => s.renderQuality);
  const gl = useStore((s) => s.gl);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<KeyTest>({ state: 'idle' });
  const close = () => useStore.setState({ settingsOpen: false });

  useEffect(() => {
    window.studio.settings?.get().then(setSettings).catch(() => {});
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const setQuality = async (q: RenderQuality) => {
    useStore.setState({ renderQuality: q });
    const r = await window.studio.settings?.set({ quality: q });
    if (r && !r.error) setSettings(r);
  };

  const runTest = async (k?: string) => {
    setTest({ state: 'testing' });
    const r = await window.studio.settings?.testKey(k);
    if (!r) return setTest({ state: 'idle' });
    setTest(r.ok ? { state: 'ok', text: 'Key works' } : { state: 'bad', text: r.error });
  };

  const saveKey = async (k: string | null) => {
    setErr(null);
    const r = await window.studio.settings?.set({ openrouterKey: k });
    if (!r) return;
    if (r.error) return setErr(r.error);
    setSettings(r);
    setDraft('');
    setEditing(false);
    setTest({ state: 'idle' });
    refreshStatus();
    if (k) runTest();
  };

  const key = settings?.key;
  const showInput = !key?.set || editing;
  const eff = effectiveQuality(quality, gl);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal settings-dlg" data-testid="settings-panel">
        <div className="modal-head">
          <h3>Settings</h3>
          <button className="icon-btn" onClick={close} title="Close (Esc)" data-testid="settings-close"><X size={15} /></button>
        </div>
        <div className="set-grid">
          <label>AI key</label>
          <div className="set-cell">
            {key?.set && !editing ? (
              <div className="set-line" data-testid="settings-key-state">
                <Check size={13} className="ok" />
                <code>{key.masked}</code>
                {key.source !== 'settings' && <span className="faint">(from {key.source === 'environment' ? 'env' : '.env'})</span>}
                <span className="spacer" />
                <button className="mini text" onClick={() => runTest()} data-testid="settings-key-test">{test.state === 'testing' ? 'Testing…' : 'Test'}</button>
                <button className="mini text" onClick={() => setEditing(true)} data-testid="settings-key-change">Change</button>
                {key.source === 'settings' && <button className="mini text" onClick={() => saveKey(null)} data-testid="settings-key-remove">Remove</button>}
              </div>
            ) : (
              <div className="set-line" data-testid="settings-key-state">
                <input
                  type="password"
                  autoFocus={editing}
                  placeholder="Paste OpenRouter key"
                  value={draft}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => { setDraft(e.target.value); setErr(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) saveKey(draft.trim()); }}
                  data-testid="settings-key-input"
                />
                <button className="btn small primary" disabled={!draft.trim()} onClick={() => saveKey(draft.trim())} data-testid="settings-key-save">Save</button>
                {editing && <button className="mini text" onClick={() => { setEditing(false); setDraft(''); setErr(null); }}>Cancel</button>}
              </div>
            )}
            {err && <div className="set-test bad" data-testid="settings-key-error"><X size={12} /> {err}</div>}
            {test.state === 'ok' && <div className="set-test ok" data-testid="settings-key-test-result"><Check size={12} /> {test.text}</div>}
            {test.state === 'bad' && <div className="set-test bad" data-testid="settings-key-test-result"><X size={12} /> {test.text}</div>}
            {showInput && !key?.set && (
              <a className="set-link" onClick={() => window.studio.openExternal?.('https://openrouter.ai/keys')}>Get a key <ExternalLink size={10} /></a>
            )}
          </div>

          <label>Quality</label>
          <div className="set-cell">
            <div className="seg set-quality" role="radiogroup">
              {QUALITY_ORDER.map((q) => (
                <button
                  key={q}
                  role="radio"
                  aria-checked={quality === q}
                  className={quality === q ? 'on' : ''}
                  onClick={() => setQuality(q)}
                  title={q === 'auto' ? `${QUALITY_PRESETS[effectiveQuality('auto', gl)].label} on this machine` : `Preview up to ${QUALITY_PRESETS[q].idle} px`}
                  data-testid={`settings-quality-${q}`}
                >
                  {q === 'auto' ? 'Auto' : QUALITY_PRESETS[q].label}
                </button>
              ))}
            </div>
            <div className="faint small" data-testid="settings-quality-now">
              <span data-testid="settings-gl">{gl ? `${gl.software ? 'CPU' : 'GPU'}${gl.renderer ? ` · ${gl.renderer}` : ''}` : 'Engine starting…'}</span>
              {' · '}{QUALITY_PRESETS[eff].idle} px
            </div>
          </div>

          <UpdatesSection />
        </div>
      </div>
    </div>
  );
}
