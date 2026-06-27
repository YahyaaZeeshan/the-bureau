import { useEffect, useState } from 'react';
import { useStore } from '../state.js';
import { wsSend } from '../ws.js';
import { engine } from '../game/OfficeCanvas.js';

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return <span className="clock">🕐 {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>;
}

export function TopBar() {
  const { mode, personas, connected, meeting, selectedChar, meetingPicker, pendingCount, set } = useStore();
  const [picked, setPicked] = useState<string[]>([]);
  const selected = personas.find((p) => p.id === selectedChar);
  const picking = meetingPicker;
  const setPicking = (on: boolean) => set({ meetingPicker: on });

  const startBreak = () => {
    set({ mode: 'break' });
    engine.setMode('break');
    wsSend({ type: 'break.start' });
  };
  const backToWork = () => {
    if (meeting?.active) wsSend({ type: 'meeting.end' });
    if (mode === 'break') wsSend({ type: 'break.end' });
    set({ mode: 'work' });
    engine.setMode('work');
  };
  const startMeeting = () => {
    const attendees = picked.length ? picked : personas.map((p) => p.id);
    wsSend({ type: 'meeting.start', attendees });
    set({ mode: 'meeting', dockOpen: true, dockTab: 'meeting' });
    engine.setMode('meeting', attendees);
    setPicking(false);
    setPicked([]);
  };

  return (
    <div className="topbar">
      <div className="brand">
        <span className="brand-icon">🕵️</span>
        <span className="brand-name">THE&nbsp;BUREAU</span>
        <span className={`conn ${connected ? 'on' : 'off'}`} title={connected ? 'connected' : 'reconnecting…'} />
        <Clock />
      </div>
      {selected ? (
        <span className="select-hint">
          {selected.emoji} <b>{selected.name}</b> selected — click floor to send, double-click for menu, Esc to deselect
        </span>
      ) : (
        <span className="select-hint dim2">click = select/move · double-click = menu</span>
      )}
      <div className="spacer" />
      {picking ? (
        <div className="meeting-picker">
          <button className="btn ghost" onClick={() => setPicked(personas.map((p) => p.id))}>All</button>
          <button className="btn ghost" onClick={() => setPicked([])}>None</button>
          {personas.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={picked.includes(p.id)}
                onChange={(e) =>
                  setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))
                }
              />
              {p.emoji} {p.name}
            </label>
          ))}
          <button className="btn primary" onClick={startMeeting}>
            Start {picked.length ? `with ${picked.length} selected` : 'with everyone'}
          </button>
          <button className="btn ghost" onClick={() => setPicking(false)}>✕</button>
        </div>
      ) : (
        <div className="actions">
          <button className="btn review" onClick={() => set({ dockOpen: true, dockTab: 'inbox' })}>
            📥 Review{pendingCount > 0 && <span className="badge">{pendingCount}</span>}
          </button>
          {mode !== 'meeting' && (
            <button className="btn primary" onClick={() => setPicking(true)}>📣 Meeting</button>
          )}
          {mode === 'work' && <button className="btn" onClick={startBreak}>☕ Break</button>}
          {mode !== 'work' && (
            <button className="btn" onClick={backToWork}>
              {mode === 'meeting' ? '🚪 End Meeting' : '💼 Back to Work'}
            </button>
          )}
          <button className="btn" onClick={() => set({ dockOpen: !useStore.getState().dockOpen })}>
            🗂 Panel
          </button>
          <button className="btn ghost" title="Office settings" onClick={() => set({ settingsOpen: true })}>
            ⚙
          </button>
        </div>
      )}
    </div>
  );
}

const PROVIDER_PRESETS: Record<string, { name: string; baseUrl: string; defaultModel: string }> = {
  anthropic: { name: 'Anthropic Claude', baseUrl: '', defaultModel: 'claude-sonnet-4-20250514' },
  openai: { name: 'OpenAI GPT', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  mimo: { name: 'Xiaomi MiMo', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic', defaultModel: 'mimo-v2.5-pro' },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'anthropic/claude-sonnet-4' },
  nemotron: { name: 'NVIDIA Nemotron', baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModel: 'nvidia/llama-3.1-nemotron-70b-instruct' },
  custom: { name: 'Custom (OpenAI-compatible)', baseUrl: '', defaultModel: '' },
};

export function SettingsModal() {
  const { settingsOpen, settings, integrations, set } = useStore();
  const [showKey, setShowKey] = useState(false);
  if (!settingsOpen) return null;

  const provider = settings.provider || { id: 'anthropic', name: 'Anthropic Claude', baseUrl: '', apiKey: '', model: '' };
  const patchProvider = (p: Record<string, string>) => wsSend({ type: 'settings.update', patch: { provider: { ...provider, ...p } } });
  const patch = (p: Record<string, unknown>) => wsSend({ type: 'settings.update', patch: p });

  const selectPreset = (id: string) => {
    const preset = PROVIDER_PRESETS[id];
    if (!preset) return;
    patchProvider({ id, name: preset.name, baseUrl: preset.baseUrl, model: preset.defaultModel });
  };

  return (
    <div className="modal-backdrop" onClick={() => set({ settingsOpen: false })}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h3>⚙ Office Settings</h3>

        <fieldset>
          <legend>LLM Provider</legend>
          <label>
            Provider
            <select value={provider.id} onChange={(e) => selectPreset(e.target.value)}>
              {Object.entries(PROVIDER_PRESETS).map(([id, p]) => (
                <option key={id} value={id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label>
            API Key
            <div className="input-row">
              <input
                type={showKey ? 'text' : 'password'}
                value={provider.apiKey}
                placeholder="sk-... or your provider's API key"
                onChange={(e) => patchProvider({ apiKey: e.target.value })}
              />
              <button className="btn ghost sm" onClick={() => setShowKey(!showKey)}>{showKey ? '🙈' : '👁'}</button>
            </div>
          </label>
          <label>
            Base URL {provider.id !== 'custom' && <span className="dim2">(auto-filled)</span>}
            <input
              value={provider.baseUrl}
              placeholder={provider.id === 'anthropic' ? 'https://api.anthropic.com (default)' : 'API endpoint URL'}
              onChange={(e) => patchProvider({ baseUrl: e.target.value })}
            />
          </label>
          <label>
            Model
            <input
              value={provider.model}
              placeholder={PROVIDER_PRESETS[provider.id]?.defaultModel || 'model-name'}
              onChange={(e) => patchProvider({ model: e.target.value })}
            />
          </label>
          <div className="hint">
            {provider.id === 'anthropic' && 'Direct Anthropic API. Leave Base URL empty for default.'}
            {provider.id === 'openai' && 'OpenAI API. Uses Anthropic SDK format — ensure your model supports tools.'}
            {provider.id === 'mimo' && 'Xiaomi MiMo proxy (Anthropic-compatible).'}
            {provider.id === 'openrouter' && 'OpenRouter supports many models. Use model format: provider/model-name.'}
            {provider.id === 'nemotron' && 'NVIDIA API Catalog. Sign up at build.nvidia.com for a key.'}
            {provider.id === 'custom' && 'Any Anthropic-compatible API endpoint.'}
          </div>
        </fieldset>

        <fieldset>
          <legend>Chatter / Fallback (Groq)</legend>
          <label>
            Groq API Key <span className="dim2">(free — for break-room chat & fallback)</span>
            <input
              type="password"
              value={settings.groqKey || ''}
              placeholder="gsk_..."
              onChange={(e) => patch({ groqKey: e.target.value })}
            />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={settings.autonomousChat} onChange={(e) => patch({ autonomousChat: e.target.checked })} />
            Lively break room — agents chat on break (Groq, near-free). Off = canned bubbles.
          </label>
          <label className="check-row">
            <input type="checkbox" checked={settings.groqFallback} onChange={(e) => patch({ groqFallback: e.target.checked })} />
            Groq fallback — if main LLM errors, agents answer on Groq (toolless).
          </label>
        </fieldset>

        <fieldset>
          <legend>Behavior</legend>
          <label className="check-row">
            <input type="checkbox" checked={settings.autoApprove} onChange={(e) => patch({ autoApprove: e.target.checked })} />
            Auto-approve sensitive actions (Jira writes, emails, shell commands). OFF recommended.
          </label>
        </fieldset>

        <div className="hint">
          Integrations: {Object.entries(integrations).map(([k, v]) => `${v ? '✓' : '✗'} ${k}`).join('  ')}
        </div>
        <div className="row right">
          <button className="btn primary" onClick={() => set({ settingsOpen: false })}>Done</button>
        </div>
      </div>
    </div>
  );
}
