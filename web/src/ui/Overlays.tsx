import { useEffect, useState } from 'react';
import { useStore } from '../state.js';
import { wsSend } from '../ws.js';
import { api } from '../api.js';
import { Markdown } from './Markdown.js';

/** Click-menu when you double-tap a character (or yourself — CEO controls). */
export function CharacterMenu() {
  const { charMenu, personas, mode, pendingCount, set } = useStore();
  if (!charMenu) return null;
  const close = () => set({ charMenu: null });
  const pos = {
    left: Math.min(charMenu.x, window.innerWidth - 230),
    top: Math.min(charMenu.y, window.innerHeight - 280),
  };

  if (charMenu.id === 'you') {
    return (
      <div className="char-menu" style={pos}>
        <div className="char-menu-title">👑 You<span className="dim"> · CEO</span></div>
        <button onClick={() => { set({ dockOpen: true, dockTab: 'inbox' }); close(); }}>
          📥 Review team's work{pendingCount > 0 ? ` (${pendingCount} pending)` : ''}
        </button>
        <button onClick={() => { set({ meetingPicker: true }); close(); }}>📣 Call a meeting…</button>
        {mode !== 'break' && (
          <button onClick={() => { set({ mode: 'break' }); engineSetMode('break'); wsSend({ type: 'break.start' }); close(); }}>☕ Break time for everyone</button>
        )}
        {mode !== 'work' && (
          <button onClick={() => { const st = useStore.getState(); if (st.meeting?.active) wsSend({ type: 'meeting.end' }); if (st.mode === 'break') wsSend({ type: 'break.end' }); set({ mode: 'work' }); engineSetMode('work'); close(); }}>💼 Everyone back to work</button>
        )}
        <button onClick={() => { set({ dockOpen: true, dockTab: 'kb' }); close(); }}>📚 Knowledge base</button>
        <button onClick={() => { set({ dockOpen: true, dockTab: 'routines' }); close(); }}>⏰ Routines</button>
        <button onClick={() => { set({ settingsOpen: true }); close(); }}>⚙ Office settings</button>
        <button onClick={close}>✕ Close</button>
      </div>
    );
  }

  const p = personas.find((x) => x.id === charMenu.id);
  if (!p) return null;
  return (
    <div className="char-menu" style={pos}>
      <div className="char-menu-title">{p.emoji} {p.name}<span className="dim"> · {p.title}</span></div>
      <button onClick={() => { set({ dockOpen: true, dockTab: 'chat', chatTarget: p.id }); close(); }}>💬 Talk / assign task</button>
      <button onClick={() => { set({ editingPersona: { ...p } }); close(); }}>🎨 Persona & look</button>
      <button onClick={() => { set({ dockOpen: true, dockTab: 'logs' }); close(); }}>📜 View logs</button>
      <button onClick={close}>✕ Close</button>
    </div>
  );
}

// avoid circular import: lazy engine access
import { engine } from '../game/OfficeCanvas.js';
const engineSetMode = (m: 'work' | 'break' | 'meeting') => engine.setMode(m);

/** After uploading a doc to the KB, tag who can see it (+ optional AI analysis). */
export function UploadDialog() {
  const { uploadDialog, personas, set } = useStore();
  const [mode, setMode] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [summary, setSummary] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Load existing meta when editing an already-tagged file; defaults for fresh uploads.
    const ex = uploadDialog;
    if (ex && Array.isArray(ex.audience)) { setMode('some'); setPicked(ex.audience); }
    else { setMode('all'); setPicked([]); }
    setSummary(ex?.summary ?? '');
    setTags(ex?.tags ?? []);
    setTagInput('');
  }, [uploadDialog?.name]);

  if (!uploadDialog) return null;
  const { name, agentId, meeting } = uploadDialog;

  const addTag = () => {
    const t = tagInput.trim().replace(/,$/, '');
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput('');
  };
  const removeTag = (t: string) => setTags(tags.filter((x) => x !== t));

  const analyze = async () => {
    setBusy(true);
    try {
      const r = await api.kbAnalyze(name);
      setSummary(r.summary ?? '');
      setTags(r.tags ?? []);
      if (r.suggested && r.suggested !== 'all') {
        const ids = String(r.suggested).split(',').map((s: string) => s.trim()).filter((id: string) => personas.some((p) => p.id === id));
        if (ids.length) {
          setMode('some');
          setPicked(ids);
        }
      } else {
        setMode('all');
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const audience = mode === 'all' ? 'all' : picked.join(',');
    // always send tags (even []) so removing every tag actually clears them
    await api.kbSetAudience(name, audience, summary || undefined, tags);
    const who = mode === 'all' ? 'everyone' : picked.map((id) => personas.find((p) => p.id === id)?.name ?? id).join(', ');
    if (agentId) wsSend({ type: 'chat', agentId, text: `📎 I've added "${name}" to the knowledge base (shared with ${who}). Please review it when relevant.` });
    else if (meeting) wsSend({ type: 'meeting.say', text: `📎 I've shared "${name}" in the knowledge base for this meeting (visible to ${who}). Take a look.` });
    set({ uploadDialog: null });
  };

  return (
    <div className="modal-backdrop" onClick={() => set({ uploadDialog: null })}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>🏷 Knowledge base: {name}</h3>
        <div className="hint">Set who can see it, plus tags & a summary that help agents find it.</div>

        <button className="btn" disabled={busy} onClick={analyze}>
          {busy ? '🧠 Analyzing…' : '🧠 Analyze & suggest (AI)'}
        </button>

        <label>
          Summary
          <input placeholder="one-line description (helps agents decide relevance)" value={summary} onChange={(e) => setSummary(e.target.value)} />
        </label>

        <label>
          Tags
          <div className="upload-tags">
            {tags.map((t) => (
              <span key={t} className="chip sm">{t} <button className="tag-x" onClick={() => removeTag(t)}>✕</button></span>
            ))}
            {tags.length === 0 && <span className="dim">no tags</span>}
          </div>
          <div className="row" style={{ padding: 0 }}>
            <input
              placeholder="add a tag, Enter"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
            />
            <button className="btn" onClick={addTag}>+ Tag</button>
          </div>
        </label>

        <label className="check-row">
          <input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} /> Everyone
        </label>
        <label className="check-row">
          <input type="radio" checked={mode === 'some'} onChange={() => setMode('some')} /> Only specific employees
        </label>
        {mode === 'some' && (
          <div className="toolset-row">
            {personas.map((p) => (
              <label key={p.id} className="check">
                <input
                  type="checkbox"
                  checked={picked.includes(p.id)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))}
                />
                {p.emoji} {p.name}
              </label>
            ))}
          </div>
        )}

        <div className="row right">
          <button className="btn" onClick={() => set({ uploadDialog: null })}>Cancel</button>
          <button className="btn primary" disabled={mode === 'some' && !picked.length} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

/** Approval prompts — every sensitive action waits for you here, with the full content to review. */
export function ApprovalToasts() {
  const { approvals, personas } = useStore();
  if (!approvals.length) return null;
  return (
    <div className="approvals">
      {approvals.map((a) => {
        const p = personas.find((x) => x.id === a.agentId);
        return (
          <div key={a.id} className="approval">
            <div className="approval-head">
              <div>
                <b>{p?.emoji ?? '🤖'} {p?.name ?? a.agentId}</b> wants to:
                <div className="approval-summary">{a.summary}</div>
              </div>
              <div className="approval-actions">
                <button className="btn primary" onClick={() => wsSend({ type: 'approval.response', id: a.id, approved: true })}>
                  ✓ Approve
                </button>
                <button className="btn danger" onClick={() => wsSend({ type: 'approval.response', id: a.id, approved: false })}>
                  ✗ Reject
                </button>
              </div>
            </div>
            {a.detail && (
              <div className="approval-detail">
                <Markdown text={a.detail} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
