// Settings popup (top-bar Settings icon, ⌘,): the agent's provider / key / model (AiSettings), preview quality, updates.
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../store';
import { effectiveQuality, QUALITY_ORDER, QUALITY_PRESETS, type RenderQuality } from '../quality';
import type { AppSettings } from '../types';
import UpdatesSection from './UpdatesSection';
import AiSettings from './AiSettings';

export default function SettingsDialog() {
  const quality = useStore((s) => s.renderQuality);
  const gl = useStore((s) => s.gl);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const close = () => useStore.setState({ settingsOpen: false });

  useEffect(() => {
    window.studio.settings?.get().then(setSettings).catch(() => {});
    // an open dropdown inside (model list) takes Escape first
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[data-takes-escape]')) { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const setQuality = async (q: RenderQuality) => {
    useStore.setState({ renderQuality: q });
    const r = await window.studio.settings?.set({ quality: q });
    if (r && !r.error) setSettings(r);
  };

  const eff = effectiveQuality(quality, gl);

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal settings-dlg" data-testid="settings-panel">
        <div className="modal-head">
          <h3>Settings</h3>
          <button className="icon-btn" onClick={close} title="Close (Esc)" data-testid="settings-close"><X size={15} /></button>
        </div>
        <div className="set-grid">
          {settings && <AiSettings settings={settings} onChange={setSettings} />}

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
