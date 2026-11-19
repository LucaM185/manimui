// AI rows of the Settings popup: which API the agent talks to (OpenRouter, or any OpenAI-compatible
// chat-completions endpoint), its key, the model and the model options. Everything is saved through
// settings:set in main, which keeps the keys and shapes each request for the provider.
import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';
import { refreshStatus } from '../agent/agent';
import type { AiModelOptions, AiProvider, AiSettingsPatch, AppSettings, ThinkingEffort } from '../types';
import './AiSettings.css';

type KeyTest = { state: 'idle' | 'testing' | 'ok' | 'bad'; text?: string };
type Models = { state: 'idle' | 'loading' | 'ok' | 'bad'; list: string[]; text?: string };

/** Quick fills for the base URL; any other OpenAI-compatible URL works too. */
export const PRESETS: { name: string; url: string; keyUrl?: string; local?: boolean }[] = [
  { name: 'OpenAI', url: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  { name: 'Anthropic', url: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey' },
  { name: 'Groq', url: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  { name: 'Mistral', url: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys' },
  { name: 'Together', url: 'https://api.together.xyz/v1', keyUrl: 'https://api.together.ai/settings/api-keys' },
  { name: 'Ollama', url: 'http://localhost:11434/v1', local: true },
  { name: 'LM Studio', url: 'http://localhost:1234/v1', local: true },
];

const EFFORTS: { id: ThinkingEffort; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

/** A text input that saves on Enter / blur (not on every keystroke), and resyncs when the saved value changes. */
function CommitInput({ value, onCommit, testid, ...rest }: {
  value: string;
  onCommit: (v: string) => void | Promise<unknown>;
  testid: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft.trim() !== value) onCommit(draft.trim()); };
  return (
    <input
      {...rest}
      value={draft}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape' && draft !== value) { e.stopPropagation(); setDraft(value); }
      }}
      data-testid={testid}
    />
  );
}

/**
 * Model id input with a suggestion list of the provider's models (filtered as you type, ↑↓ ↩).
 * Not a <datalist>: Chromium's native datalist popup crashes Electron's main process on macOS.
 */
function ModelPicker({ value, placeholder, models, onOpen, onCommit }: {
  value: string;
  placeholder: string;
  models: string[];
  onOpen: () => void;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setDraft(value), [value]);
  const q = draft.trim().toLowerCase();
  const shown = (q && q !== value.toLowerCase() ? models.filter((id) => id.toLowerCase().includes(q)) : models).slice(0, 300);
  const commit = (v: string) => {
    setOpen(false);
    setHi(-1);
    setDraft(v);
    if (v.trim() !== value) onCommit(v.trim());
  };
  useEffect(() => {
    if (hi >= 0) listRef.current?.children[hi]?.scrollIntoView({ block: 'nearest' });
  }, [hi]);
  return (
    <div className="ai-picker">
      <input
        className="ai-model"
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => { onOpen(); setOpen(true); }}
        onChange={(e) => { setDraft(e.target.value); setOpen(true); setHi(-1); }}
        onBlur={() => commit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && shown.length) { e.preventDefault(); setOpen(true); setHi((h) => Math.min(shown.length - 1, h + 1)); }
          else if (e.key === 'ArrowUp' && shown.length) { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); commit(open && hi >= 0 && shown[hi] ? shown[hi] : draft); }
          else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
        }}
        data-testid="settings-ai-model"
      />
      {open && shown.length > 0 && (
        <div className="ai-picker-list" ref={listRef} data-takes-escape data-testid="settings-ai-model-list">
          {shown.map((id, i) => (
            <div
              key={id}
              className={`ai-picker-item ${i === hi ? 'hi' : ''} ${id === value ? 'cur' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); commit(id); }}
              onMouseEnter={() => setHi(i)}
              data-testid="settings-ai-model-option"
            >
              {id}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A saved secret: shown masked with Change / Remove, or an input to paste one. */
function KeyField({ set, masked, source, placeholder, onSave, onTest, test, prefix, getUrl }: {
  set: boolean;
  masked: string;
  source?: string | null;
  placeholder: string;
  onSave: (k: string | null) => Promise<string | null>;
  onTest?: () => void;
  test: KeyTest;
  prefix: string;
  getUrl?: string;
}) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (k: string | null) => {
    setErr(null);
    const e = await onSave(k);
    if (e) return setErr(e);
    setDraft('');
    setEditing(false);
  };
  return (
    <div className="set-cell">
      {set && !editing ? (
        <div className="set-line" data-testid={`${prefix}-state`}>
          <Check size={13} className="ok" />
          <code>{masked}</code>
          {source && source !== 'settings' && <span className="faint">(from {source === 'environment' ? 'env' : '.env'})</span>}
          <span className="spacer" />
          {onTest && <button className="mini text" onClick={onTest} data-testid={`${prefix}-test`}>{test.state === 'testing' ? 'Testing…' : 'Test'}</button>}
          <button className="mini text" onClick={() => setEditing(true)} data-testid={`${prefix}-change`}>Change</button>
          {(!source || source === 'settings') && <button className="mini text" onClick={() => save(null)} data-testid={`${prefix}-remove`}>Remove</button>}
        </div>
      ) : (
        <div className="set-line" data-testid={`${prefix}-state`}>
          <input
            type="password"
            autoFocus={editing}
            placeholder={placeholder}
            value={draft}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => { setDraft(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) save(draft.trim()); }}
            data-testid={`${prefix}-input`}
          />
          <button className="btn small primary" disabled={!draft.trim()} onClick={() => save(draft.trim())} data-testid={`${prefix}-save`}>Save</button>
          {editing && <button className="mini text" onClick={() => { setEditing(false); setDraft(''); setErr(null); }}>Cancel</button>}
        </div>
      )}
      {err && <div className="set-test bad" data-testid={`${prefix}-error`}><X size={12} /> {err}</div>}
      {test.state === 'ok' && <div className="set-test ok" data-testid={`${prefix}-test-result`}><Check size={12} /> {test.text}</div>}
      {test.state === 'bad' && <div className="set-test bad" data-testid={`${prefix}-test-result`}><X size={12} /> {test.text}</div>}
      {!set && getUrl && (
        <a className="set-link" onClick={() => window.studio.openExternal?.(getUrl)}>Get a key <ExternalLink size={10} /></a>
      )}
    </div>
  );
}

export default function AiSettings({ settings, onChange }: { settings: AppSettings; onChange: (s: AppSettings) => void }) {
  const ai = settings.ai;
  const provider = ai.provider;
  const [err, setErr] = useState<string | null>(null);
  const [orTest, setOrTest] = useState<KeyTest>({ state: 'idle' });
  const [models, setModels] = useState<Record<AiProvider, Models>>({ openrouter: { state: 'idle', list: [] }, custom: { state: 'idle', list: [] } });
  const modelsFor = useRef<string>('');

  /** Save a patch; returns the error text, if any (also shown under the rows). */
  const save = async (patch: { ai?: AiSettingsPatch; openrouterKey?: string | null }, showErr = true) => {
    setErr(null);
    const r = await window.studio.settings?.set(patch);
    if (!r) return 'Settings are unavailable.';
    if (r.error) { if (showErr) setErr(r.error); return r.error; }
    onChange(r);
    refreshStatus();
    return null;
  };

  const loadModels = async (p: AiProvider = provider) => {
    setModels((m) => ({ ...m, [p]: { ...m[p], state: 'loading', text: undefined } }));
    const r = await window.studio.settings?.models({ provider: p });
    if (!r) return;
    setModels((m) => ({
      ...m,
      [p]: r.ok
        ? { state: 'ok', list: r.models || [], text: p === 'custom' ? `Connected · ${r.models?.length ?? 0} model${r.models?.length === 1 ? '' : 's'}` : undefined }
        : { state: 'bad', list: m[p].list, text: r.error },
    }));
  };

  // the custom provider's model list follows its URL + key: reload when they change
  const customSig = `${ai.custom.baseUrl}|${ai.custom.key.masked}`;
  useEffect(() => {
    if (provider !== 'custom' || !ai.custom.baseUrl || modelsFor.current === customSig) return;
    modelsFor.current = customSig;
    loadModels('custom');
  }, [provider, customSig]);

  const runOrTest = async (k?: string) => {
    setOrTest({ state: 'testing' });
    const r = await window.studio.settings?.testKey(k);
    if (!r) return setOrTest({ state: 'idle' });
    setOrTest(r.ok ? { state: 'ok', text: 'Key works' } : { state: 'bad', text: r.error });
  };

  const opts: AiModelOptions = provider === 'custom' ? ai.custom : ai.openrouter;
  const setOpts = (o: Partial<Record<keyof AiModelOptions, unknown>>) => save({ ai: { [provider]: o } as AiSettingsPatch });
  const preset = PRESETS.find((p) => p.url === ai.custom.baseUrl);
  const m = models[provider];

  return (
    <>
      <label>Agent</label>
      <div className="set-cell">
        <div className="seg set-provider" role="radiogroup">
          {(['openrouter', 'custom'] as AiProvider[]).map((p) => (
            <button key={p} role="radio" aria-checked={provider === p} className={provider === p ? 'on' : ''} onClick={() => provider !== p && save({ ai: { provider: p } })} data-testid={`settings-ai-provider-${p}`}>
              {p === 'openrouter' ? 'OpenRouter' : 'OpenAI-compatible'}
            </button>
          ))}
        </div>
        {!ai.configured && (
          <div className="faint small" data-testid="settings-ai-hint">
            {provider === 'custom' ? 'Set a base URL and a model to use the agent.' : 'Add an OpenRouter key to use the agent.'}
          </div>
        )}
      </div>

      {provider === 'custom' && (
        <>
          <label>URL</label>
          <div className="set-cell">
            <div className="set-line">
              <select
                className="ai-preset"
                value={preset?.name ?? ''}
                onChange={(e) => {
                  const p = PRESETS.find((x) => x.name === e.target.value);
                  if (p) save({ ai: { custom: { baseUrl: p.url, name: p.name } } });
                }}
                title="Fill in a known provider"
                data-testid="settings-ai-preset"
              >
                <option value="">{ai.custom.baseUrl ? 'Custom' : 'Preset…'}</option>
                {PRESETS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
              <CommitInput
                className="ai-url"
                value={ai.custom.baseUrl}
                placeholder="https://api.example.com/v1"
                onCommit={(v) => save({ ai: { custom: { baseUrl: v, name: PRESETS.find((p) => p.url === v.replace(/\/+$/, ''))?.name ?? '' } } })}
                testid="settings-ai-baseurl"
              />
            </div>
          </div>

          <label>Key</label>
          <KeyField
            prefix="settings-ai-key"
            set={ai.custom.key.set}
            masked={ai.custom.key.masked}
            placeholder={preset?.local ? 'Not needed for a local server' : 'Paste API key (if the server needs one)'}
            onSave={(k) => save({ ai: { custom: { apiKey: k } } }, false)}
            test={{ state: 'idle' }}
            getUrl={preset?.keyUrl}
          />
        </>
      )}

      {provider === 'openrouter' && (
        <>
          <label>Key</label>
          <KeyField
            prefix="settings-key"
            set={settings.key.set}
            masked={settings.key.masked}
            source={settings.key.source}
            placeholder="Paste OpenRouter key"
            onSave={async (k) => {
              const e = await save({ openrouterKey: k }, false);
              if (!e) { setOrTest({ state: 'idle' }); if (k) runOrTest(); }
              return e;
            }}
            onTest={() => runOrTest()}
            test={orTest}
            getUrl="https://openrouter.ai/keys"
          />
        </>
      )}

      <label>Model</label>
      <div className="set-cell">
        <div className="set-line">
          <ModelPicker
            value={provider === 'openrouter' && opts.model === ai.defaultModel ? '' : opts.model}
            placeholder={provider === 'openrouter' ? ai.defaultModel : m.list[0] ? `e.g. ${m.list[0]}` : 'model id'}
            models={m.list}
            onOpen={() => { if (m.state === 'idle' && (provider === 'openrouter' ? settings.key.set : ai.custom.baseUrl)) loadModels(); }}
            onCommit={(v) => setOpts({ model: v })}
          />
          <button
            className="icon-btn"
            onClick={() => loadModels()}
            disabled={m.state === 'loading' || (provider === 'custom' && !ai.custom.baseUrl)}
            title={provider === 'custom' ? 'Connect and list the models' : 'List the OpenRouter models that can use tools'}
            data-testid="settings-ai-models-load"
          >
            {m.state === 'loading' ? <Loader2 size={13} className="spin-icon" /> : <RefreshCw size={13} />}
          </button>
        </div>
        {m.state === 'ok' && m.text && <div className="set-test ok" data-testid="settings-ai-conn"><Check size={12} /> {m.text}</div>}
        {m.state === 'bad' && <div className="set-test bad" data-testid="settings-ai-conn"><X size={12} /> {m.text}</div>}
        {provider === 'custom' && m.state === 'ok' && opts.model && m.list.length > 0 && !m.list.includes(opts.model) && (
          <div className="set-test warn" data-testid="settings-ai-model-unknown">“{opts.model}” is not in this server’s list.</div>
        )}
        <div className="faint small">The model must support tool calls{provider === 'custom' ? ' (function calling)' : ''}.</div>
      </div>

      <label>Thinking</label>
      <div className="set-cell">
        <div className="seg set-effort" role="radiogroup">
          {EFFORTS.map((e) => (
            <button key={e.id} role="radio" aria-checked={opts.reasoning === e.id} className={opts.reasoning === e.id ? 'on' : ''} onClick={() => setOpts({ reasoning: e.id })} data-testid={`settings-ai-effort-${e.id}`}>
              {e.label}
            </button>
          ))}
        </div>
        {provider === 'custom' && opts.reasoning !== 'off' && <div className="faint small">Sent as reasoning_effort — only reasoning models accept it.</div>}
      </div>

      <label>Output</label>
      <div className="set-cell">
        <div className="set-line ai-nums">
          <span className="faint">Max tokens</span>
          <CommitInput className="ai-num" inputMode="numeric" value={opts.maxTokens == null ? '' : String(opts.maxTokens)} placeholder="default" onCommit={(v) => setOpts({ maxTokens: v })} testid="settings-ai-maxtokens" />
          <span className="faint">Temperature</span>
          <CommitInput className="ai-num" inputMode="decimal" value={opts.temperature == null ? '' : String(opts.temperature)} placeholder="default" onCommit={(v) => setOpts({ temperature: v })} testid="settings-ai-temperature" />
        </div>
        {provider === 'custom' && (
          <div className="set-line ai-checks">
            <label title="Send the agent's rendered previews to the model. Turn off for text-only models.">
              <input type="checkbox" checked={ai.custom.vision} onChange={(e) => save({ ai: { custom: { vision: e.target.checked } } })} data-testid="settings-ai-vision" /> Image input
            </label>
            <label title="Keep Anthropic-style cache_control hints in the request (prompt caching on servers that support it).">
              <input type="checkbox" checked={ai.custom.cache} onChange={(e) => save({ ai: { custom: { cache: e.target.checked } } })} data-testid="settings-ai-cache" /> Cache hints
            </label>
          </div>
        )}
        {err && <div className="set-test bad" data-testid="settings-ai-error"><X size={12} /> {err}</div>}
      </div>
    </>
  );
}
