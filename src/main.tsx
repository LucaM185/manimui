import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { useStore } from './store';
import * as actions from './actions';
import * as agent from './agent/agent';
import * as sessions from './sessions';
import { editorState, runTool } from './agent/tools';
import { buildSystemPrompt } from './agent/prompt';
import { useSessions } from './store';
import * as ops from './ops';
import { cameraAt } from './ops';
import { loadClipParts } from './parts';

// handle for automated UI tests / debugging from devtools
(window as any).__ms = { store: useStore, actions, agent, sessions, bg: useSessions, agentTools: { runTool, editorState, buildSystemPrompt }, cameraAt, ops, parts: { loadClipParts } };

createRoot(document.getElementById('root')!).render(<App />);
