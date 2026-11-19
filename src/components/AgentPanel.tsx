import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowUp, BookOpen, Check, ChevronRight, Clock, Eye, FileCode, KeyRound, Loader2, MessageCirclePlus,
  MousePointerClick, Pencil, Plus, RotateCcw, Rows3, Search, Settings2, Sparkles, Square, Trash2, Undo2, Video, X,
} from 'lucide-react';
import { useStore } from '../store';
import { CAMERA_ID } from '../ops';
import { canUndoTurn, deleteChat, listChats, newChat, refreshStatus, resumeChat, retry, rewindTo, send, stop, undoTurn, useAgent, type ChatItem } from '../agent/agent';
import type { ChatMeta } from '../types';

const TOOL_ICONS: Record<string, any> = {
  add_clips: Plus,
  update_clips: Pencil,
  delete_clips: Trash2,
  set_camera: Video,
  update_scene: Settings2,
  set_tracks: Rows3,
  render_preview: Eye,
  get_item: BookOpen,
  get_scene_code: FileCode,
  set_playhead: MousePointerClick,
};

// ------------------------------------------------------------------ tiny markdown (no HTML injection)
function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (tok.startsWith('`')) out.push(<code key={k}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) out.push(<b key={k}>{tok.slice(2, -2)}</b>);
    else out.push(<i key={k}>{tok.slice(1, -1)}</i>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const parts = text.split(/```[\w-]*\n?/);
  parts.forEach((part, pi) => {
    if (pi % 2 === 1) {
      blocks.push(<pre key={`c${pi}`} className="ag-code">{part.replace(/\n$/, '')}</pre>);
      return;
    }
    const lines = part.split('\n');
    let list: { ordered: boolean; items: string[] } | null = null;
    let para: string[] = [];
    const flushPara = () => {
      if (para.length) blocks.push(<p key={`p${pi}-${blocks.length}`}>{inline(para.join(' '), blocks.length)}</p>);
      para = [];
    };
    const flushList = () => {
      if (!list) return;
      const items = list.items.map((it, j) => <li key={j}>{inline(it, j)}</li>);
      blocks.push(list.ordered ? <ol key={`l${pi}-${blocks.length}`}>{items}</ol> : <ul key={`l${pi}-${blocks.length}`}>{items}</ul>);
      list = null;
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const head = line.match(/^#{1,4}\s+(.*)$/);
      if (bullet || num) {
        flushPara();
        const ordered = !!num;
        if (!list || list.ordered !== ordered) {
          flushList();
          list = { ordered, items: [] };
        }
        list.items.push((bullet || num)![1]);
      } else if (head) {
        flushPara();
        flushList();
        blocks.push(<p key={`h${pi}-${blocks.length}`} className="ag-h">{inline(head[1])}</p>);
      } else if (!line.trim()) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(line.trim());
      }
    }
    flushPara();
    flushList();
  });
  return <div className="ag-md">{blocks}</div>;
}

// ------------------------------------------------------------------ rows
function ToolRow({ it }: { it: Extract<ChatItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[it.name] || Sparkles;
  const busy = it.status === 'pending' || it.status === 'running';
  return (
    <div className={`ag-tool ${it.status}`} data-testid="agent-tool">
      <button className="ag-tool-head" onClick={() => setOpen(!open)} disabled={busy && !it.args}>
        <span className="ag-tool-icon"><Icon size={12} /></span>
        <span className="grow ag-tool-sum">{it.summary}</span>
        {busy ? <Loader2 size={12} className="spin-icon" /> : it.status === 'ok' ? <Check size={12} className="ok" /> : <AlertTriangle size={12} className="bad" />}
        {!busy && <ChevronRight size={12} className={`chev ${open ? 'open' : ''}`} />}
      </button>
      {it.images && it.images.length > 0 && (
        <div className={`ag-shots n${Math.min(it.images.length, 4)}`}>
          {it.images.map((im, i) => (
            <button key={i} className="ag-shot" title={`Go to ${im.t.toFixed(2)}s`} onClick={() => { useStore.getState().setTime(im.t); useStore.setState({ playing: false }); }}>
              <img src={im.url} alt={`preview at ${im.t.toFixed(2)}s`} />
              <span>{im.t.toFixed(1)}s</span>
            </button>
          ))}
        </div>
      )}
      {open && !busy && (
        <div className="ag-tool-detail">
          {it.args !== undefined && <><div className="ag-label">input</div><pre>{typeof it.args === 'string' ? it.args : JSON.stringify(it.args, null, 2)}</pre></>}
          {it.result && <><div className="ag-label">result</div><pre>{pretty(it.result)}</pre></>}
        </div>
      )}
    </div>
  );
}

function pretty(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function UserRow({ it, running }: { it: Extract<ChatItem, { kind: 'user' }>; running: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = !!(it.checkpoint || it.snapshot);
  const title = running
    ? 'Stop the agent to go back'
    : it.checkpoint
      ? `Go back to before this message (checkpoint ${it.checkpoint.slice(0, 7)})`
      : it.checkpointError
        ? `Go back to before this message (git failed: ${it.checkpointError}; using the in-memory copy)`
        : 'Go back to before this message';
  return (
    <div className="ag-user-row" data-testid="agent-user-row">
      <div className="ag-user-line">
        <button
          className={`ag-back ${confirm ? 'on' : ''}`}
          onClick={() => setConfirm(!confirm)}
          disabled={running || !ready || busy}
          title={title}
          data-testid="agent-back"
        >
          <RotateCcw size={12} />
        </button>
        <div className="ag-user" data-testid="agent-user">{it.text}</div>
      </div>
      {confirm && !running && (
        <div className="ag-back-confirm" data-testid="agent-back-confirm">
          <span className="grow">Restore the project and chat to before this message?</span>
          <button className="btn small ghost" onClick={() => setConfirm(false)}>Cancel</button>
          <button
            className="btn small primary"
            disabled={busy}
            data-testid="agent-back-go"
            onClick={async () => {
              setBusy(true);
              const ok = await rewindTo(it.id);
              if (!ok) { setBusy(false); setConfirm(false); }
            }}
          >
            Restore
          </button>
        </div>
      )}
    </div>
  );
}

function DoneRow({ it }: { it: Extract<ChatItem, { kind: 'done' }> }) {
  // re-render when the project / history changes so the undo button disappears when stale
  useStore((s) => s.project);
  useStore((s) => s.past.length);
  const can = canUndoTurn(it);
  if (!it.changed && !it.cost) return null;
  return (
    <div className="ag-done">
      {it.changed ? <span title="The whole turn is one undo step (⌘Z)">Changes applied · ⌘Z undoes</span> : <span>No changes</span>}
      <span className="spacer" />
      {it.cost ? <span className="faint" title="Cost of this turn (as reported by the provider)">${it.cost < 0.01 ? it.cost.toFixed(4) : it.cost.toFixed(3)}</span> : null}
      {can && <button className="btn small ghost" onClick={() => undoTurn(it)} data-testid="agent-undo"><Undo2 size={12} /> Undo</button>}
    </div>
  );
}

// ------------------------------------------------------------------ history + new chat (tab bar)
function ago(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ChatHistory({ onClose }: { onClose: () => void }) {
  const chatId = useAgent((s) => s.chatId);
  const [chats, setChats] = useState<ChatMeta[] | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { listChats().then(setChats); }, []);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!box.current?.contains(t) && !t.closest('[data-testid=agent-history-btn]')) onClose();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [onClose]);

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (chats || []).filter((c) => words.every((w) => c.title.toLowerCase().includes(w)));
  const cur = Math.min(sel, Math.max(0, shown.length - 1));
  useEffect(() => { list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }, [cur]);

  const open = async (c: ChatMeta) => {
    if (await resumeChat(c.id)) onClose();
  };
  const remove = async (c: ChatMeta) => {
    await deleteChat(c.id);
    setChats((cs) => (cs || []).filter((x) => x.id !== c.id));
  };

  return (
    <div className="ag-history" ref={box} data-testid="agent-history">
      <div className="ag-history-search">
        <Search size={12} />
        <input
          autoFocus
          value={q}
          placeholder="Search chats"
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(cur + 1, shown.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(cur - 1, 0)); }
            else if (e.key === 'Enter' && shown[cur]) { e.preventDefault(); open(shown[cur]); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
          }}
          data-testid="agent-history-search"
        />
      </div>
      <div className="ag-history-list" ref={list}>
        {chats === null ? null : !shown.length ? (
          <div className="ag-history-empty">{chats.length ? 'No chats match.' : 'No past chats in this project yet.'}</div>
        ) : (
          shown.map((c, i) => (
            <div
              key={c.id}
              className={`ag-history-row ${i === cur ? 'on' : ''} ${c.id === chatId ? 'current' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => open(c)}
              data-testid="agent-history-row"
            >
              <div className="grow">
                <div className="ag-history-title">{c.title || 'Untitled chat'}</div>
                <div className="ag-history-sub">
                  {ago(c.updated)} · {c.messages} message{c.messages === 1 ? '' : 's'}
                  {c.cost > 0 && <> · ${c.cost < 0.01 ? c.cost.toFixed(4) : c.cost.toFixed(3)}</>}
                  {c.id === chatId && <> · <span className="ag-history-cur">current</span></>}
                </div>
              </div>
              <button className="mini ag-history-del" title="Delete this chat" onClick={(e) => { e.stopPropagation(); remove(c); }} data-testid="agent-history-delete"><X size={12} /></button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** History and New chat, on the right of the Inspector / AI Agent tabs. */
export function AgentTabActions() {
  const running = useAgent((s) => s.running);
  const empty = useAgent((s) => !s.items.length);
  const [open, setOpen] = useState(false);
  return (
    <div className="ag-tab-actions">
      <button
        className={`mini ${open ? 'on' : ''}`}
        onClick={() => setOpen(!open)}
        disabled={running}
        title="Chat history"
        data-testid="agent-history-btn"
      >
        <Clock size={15} />
      </button>
      <button className="mini" onClick={() => { setOpen(false); newChat(); window.dispatchEvent(new Event('agent:focus')); }} disabled={running || empty} title="New chat" data-testid="agent-new">
        <MessageCirclePlus size={15} />
      </button>
      {open && !running && <ChatHistory onClose={() => setOpen(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ panel
export default function AgentPanel() {
  const items = useAgent((s) => s.items);
  const running = useAgent((s) => s.running);
  const phase = useAgent((s) => s.phase);
  const status = useAgent((s) => s.status);
  const draft = useAgent((s) => s.draft);
  const selection = useStore((s) => s.selection);
  const clips = useStore((s) => s.project.clips);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    refreshStatus();
    const focus = () => input.current?.focus();
    window.addEventListener('agent:focus', focus);
    const t = setTimeout(focus, 30);
    return () => { window.removeEventListener('agent:focus', focus); clearTimeout(t); };
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, phase]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  const submit = (text = draft) => {
    if (!text.trim() || running || !status?.configured) return;
    stick.current = true;
    send(text);
  };

  const selNames = selection.map((id) => (id === CAMERA_ID ? 'Camera' : id.startsWith('__morph__:') ? `Transform of ${clips.find((c) => '__morph__:' + c.id === id)?.name ?? '?'}` : clips.find((c) => c.id === id)?.name)).filter(Boolean) as string[];
  const lastIsStreaming = items.length > 0 && items[items.length - 1].kind === 'assistant' && (items[items.length - 1] as any).streaming;
  const showWorking = running && !lastIsStreaming && !(items[items.length - 1]?.kind === 'tool' && (items[items.length - 1] as any).status !== 'ok' && (items[items.length - 1] as any).status !== 'error');

  return (
    <aside className="panel agent" data-testid="agent-panel">
      <div className="ag-scroll" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {status && !status.configured && (
          <div className="ag-nokey">
            <KeyRound size={16} />
            <div>
              {status.provider === 'custom' ? (
                <>
                  <b>Finish setting up {status.label || 'your provider'}</b>
                  <p>Set the base URL and model in <a onClick={() => useStore.setState({ settingsOpen: true })} data-testid="agent-open-settings">Settings</a>, then <a onClick={() => refreshStatus()}>check again</a>.</p>
                </>
              ) : (
                <>
                  <b>Add your OpenRouter key</b>
                  <p>The agent runs on OpenRouter, or on any OpenAI-compatible API. Paste a key or pick a provider in <a onClick={() => useStore.setState({ settingsOpen: true })} data-testid="agent-open-settings">Settings</a>, then <a onClick={() => refreshStatus()}>check again</a>.</p>
                </>
              )}
            </div>
          </div>
        )}
        {items.map((it) => {
          switch (it.kind) {
            case 'user':
              return <UserRow key={it.id} it={it} running={running} />;
            case 'assistant':
              return it.text.trim() ? <div key={it.id} className="ag-asst" data-testid="agent-reply"><Markdown text={it.text} />{it.streaming && <span className="ag-caret" />}</div> : null;
            case 'tool':
              return <ToolRow key={it.id} it={it} />;
            case 'error':
              return (
                <div key={it.id} className={`ag-error ${it.text === 'Stopped.' ? 'soft' : ''}`}>
                  {it.text !== 'Stopped.' && <AlertTriangle size={13} />}
                  <span className="grow">{it.text}</span>
                  {it.retry && !running && <button className="btn small" onClick={() => retry()}>Retry</button>}
                </div>
              );
            case 'done':
              return <DoneRow key={it.id} it={it} />;
          }
        })}
        {showWorking && (
          <div className="ag-working"><Loader2 size={13} className="spin-icon" /> {phase === 'tools' ? 'Working…' : 'Thinking…'}</div>
        )}
      </div>

      <div className="ag-composer">
        {selNames.length > 0 && (
          <div className="ag-context" title="The agent sees the whole project; this is what's selected">
            <MousePointerClick size={11} /> {selNames.length > 2 ? `${selNames.length} clips selected` : selNames.join(', ')}
          </div>
        )}
        <div className="ag-input">
          <textarea
            ref={input}
            rows={1}
            value={draft}
            placeholder={status?.configured === false ? (status.provider === 'custom' ? 'Set up the AI provider in Settings to start' : 'Add an OpenRouter key to start') : 'Describe what to build or change…'}
            onChange={(e) => useAgent.setState({ draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            data-testid="agent-input"
            spellCheck
          />
          {running ? (
            <button className="ag-send stop" onClick={() => stop()} title="Stop" data-testid="agent-stop"><Square size={11} fill="currentColor" /></button>
          ) : (
            <button className="ag-send" onClick={() => submit()} disabled={!draft.trim() || !status?.configured} title="Send (↩)" data-testid="agent-send"><ArrowUp size={15} /></button>
          )}
        </div>
        <div className="ag-hint faint">↩ send · ⇧↩ new line · ⌘L focus</div>
      </div>
    </aside>
  );
}
