import { useEffect, useRef, useState } from 'react';
import { useStore, type Persona } from '../state.js';
import { wsSend } from '../ws.js';
import { api } from '../api.js';
import { Markdown } from './Markdown.js';
import { pickAndUpload } from '../upload.js';

export function Dock() {
  const { dockOpen, dockTab, set } = useStore();
  if (!dockOpen) return null;
  const tabs = [
    ['chat', '💬 Chat'],
    ['meeting', '🤝 Meeting'],
    ['inbox', '📥 Inbox'],
    ['routines', '⏰ Routines'],
    ['kb', '📚 Knowledge'],
    ['logs', '📜 Logs'],
    ['drafts', '✉️ Drafts'],
    ['team', '👥 Overview'],
  ] as const;
  return (
    <div className="dock">
      <div className="dock-tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={dockTab === id ? 'tab active' : 'tab'} onClick={() => set({ dockTab: id })}>
            {label}
          </button>
        ))}
        <button className="tab close" onClick={() => set({ dockOpen: false })}>✕</button>
      </div>
      <div className="dock-body">
        {dockTab === 'chat' && <ChatPanel />}
        {dockTab === 'meeting' && <MeetingPanel />}
        {dockTab === 'inbox' && <InboxPanel />}
        {dockTab === 'routines' && <RoutinesPanel />}
        {dockTab === 'kb' && <KBPanel />}
        {dockTab === 'logs' && <LogsPanel />}
        {dockTab === 'drafts' && <DraftsPanel />}
        {dockTab === 'team' && <OverviewPanel />}
      </div>
    </div>
  );
}

// ── Chat ───────────────────────────────────────────────────
interface DiarizedSegment { speaker: string; start: number; end: number; text: string }

function ChatPanel() {
  const { personas, chats, chatTarget, statuses, set } = useStore();
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const msgs = chats[chatTarget] ?? [];
  const target = personas.find((p) => p.id === chatTarget);
  const busy = statuses[chatTarget]?.status && statuses[chatTarget].status !== 'idle';

  // ── meeting recording state ──
  const [recState, setRecState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [recElapsed, setRecElapsed] = useState(0);
  const [downloadStage, setDownloadStage] = useState<string | null>(null);
  const [pendingTranscript, setPendingTranscript] = useState<{ segments: DiarizedSegment[]; transcript: string; durationSec: number } | null>(null);
  const [notesTopic, setNotesTopic] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  // Listen for backend progress (model download + transcribe stages).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { type: string; stage?: string; got?: number; total?: number };
      if (detail.type === 'meeting.download') {
        const pct = detail.total ? Math.round(((detail.got ?? 0) / detail.total) * 100) : null;
        setDownloadStage(`${detail.stage}${pct !== null ? ` (${pct}%)` : ''}`);
        if (detail.stage === 'ready') setDownloadStage(null);
      } else if (detail.type === 'meeting.transcribing') {
        const stage = detail.stage ?? '';
        setDownloadStage(`Transcribing: ${stage}`);
        if (stage === 'done' || stage.startsWith('error')) setTimeout(() => setDownloadStage(null), 1500);
      }
    };
    window.addEventListener('pixel-office-bus', handler);
    return () => window.removeEventListener('pixel-office-bus', handler);
  }, []);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [msgs.length]);

  const send = () => {
    if (!text.trim()) return;
    wsSend({ type: 'chat', agentId: chatTarget, text: text.trim() });
    setText('');
  };

  const startRecord = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      // Prefer webm/opus (Chrome/Edge); browsers without it fall back to default.
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        setRecState('transcribing');
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        try {
          const r = await api.meetingTranscribe(blob);
          setPendingTranscript({ segments: r.segments, transcript: r.transcript, durationSec: r.durationSec });
        } catch (e) {
          alert(`Transcription failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setRecState('idle');
          setRecElapsed(0);
        }
      };
      rec.start(1000);
      recorderRef.current = rec;
      setRecState('recording');
      setRecElapsed(0);
      const t0 = Date.now();
      timerRef.current = window.setInterval(() => setRecElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
      // Pre-warm model download in parallel so the wait after stop is shorter.
      api.meetingStatus().then((s) => {
        if (!Object.values(s.models).every(Boolean)) api.meetingDownload();
      }).catch(() => {/* ignore */});
    } catch (e) {
      alert(`Mic access denied: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const stopRecord = () => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.stop();
    }
  };

  const confirmNotes = async (create: boolean) => {
    if (!pendingTranscript) return;
    if (!create) { setPendingTranscript(null); setNotesTopic(''); return; }
    try {
      await api.meetingNotes(pendingTranscript.segments, notesTopic.trim() || undefined);
      // Switch chat target to Zola so user sees her work the doc + approve.
      set({ chatTarget: 'notetaker' });
    } catch (e) {
      alert(`Failed to start notes: ${e instanceof Error ? e.message : String(e)}`);
    }
    setPendingTranscript(null);
    setNotesTopic('');
  };

  const recordLabel = recState === 'recording' ? `⏹ Stop (${Math.floor(recElapsed / 60)}:${String(recElapsed % 60).padStart(2, '0')})` : recState === 'transcribing' ? '… transcribing' : '🎙️ Record';
  const recBtnClass = recState === 'recording' ? 'btn danger' : recState === 'transcribing' ? 'btn ghost' : 'btn ghost';

  return (
    <div className="chat">
      <select value={chatTarget} onChange={(e) => set({ chatTarget: e.target.value })}>
        {personas.map((p) => (
          <option key={p.id} value={p.id}>
            {p.emoji} {p.name} — {p.title}
          </option>
        ))}
      </select>
      <div className="msgs">
        {msgs.length === 0 && (
          <div className="hint">
            Say hi to {target?.name}. Assign tasks, ask for status, anything — they remember across sessions.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <span className="avatar">{m.role === 'user' ? '👑' : m.role === 'system' ? '⚠️' : target?.emoji}</span>
            <div className="msg-body">
              <div className="msg-meta">
                <b>{m.role === 'user' ? 'You' : m.role === 'system' ? 'system' : target?.name}</b>
                <span className="msg-time">{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <div className="msg-bubble"><Markdown text={m.text} /></div>
            </div>
          </div>
        ))}
        {busy && <div className="hint">{target?.name} is {statuses[chatTarget].status === 'tool' ? `using ${statuses[chatTarget].tool}` : 'thinking'}…</div>}
        {downloadStage && <div className="hint">🎙️ {downloadStage}</div>}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <button className="btn ghost attach" title="Attach a document to the knowledge base" onClick={() => pickAndUpload({ agentId: chatTarget })}>📎</button>
        {chatTarget === 'notetaker' && (
          <button
            className={recBtnClass}
            title={recState === 'recording' ? 'Stop recording' : 'Record meeting (Zola transcribes + diarizes locally via sherpa-onnx)'}
            disabled={recState === 'transcribing'}
            onClick={() => recState === 'recording' ? stopRecord() : startRecord()}
          >
            {recordLabel}
          </button>
        )}
        <textarea
          value={text}
          placeholder={`Message ${target?.name ?? ''}… (Enter to send)`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn primary" onClick={send}>➤</button>
      </div>

      {pendingTranscript && (
        <div className="modal-backdrop" onClick={() => confirmNotes(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>📝 Meeting captured — create notes?</h3>
            <div className="hint">
              {pendingTranscript.segments.length} segments · {Math.ceil(pendingTranscript.durationSec / 60)} min · speakers detected: {Array.from(new Set(pendingTranscript.segments.map((s) => s.speaker))).join(', ') || 'none'}.
            </div>
            <label>
              Topic (optional — helps Zola title the doc)
              <input value={notesTopic} placeholder="e.g. sprint planning" onChange={(e) => setNotesTopic(e.target.value)} />
            </label>
            <div className="hint">Transcript preview:</div>
            <textarea className="editor" readOnly value={pendingTranscript.transcript} style={{ minHeight: 180 }} />
            <div className="row right">
              <button className="btn" onClick={() => confirmNotes(false)}>Skip</button>
              <button className="btn primary" onClick={() => confirmNotes(true)}>📝 Zola, draft the doc</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Meeting ────────────────────────────────────────────────
function MeetingPanel() {
  const { meeting, personas } = useStore();
  const [text, setText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [meeting?.transcript.length]);

  if (!meeting?.active)
    return <div className="hint pad">No meeting running. Hit 📣 Call Meeting in the top bar.</div>;

  const names = meeting.attendees
    .map((id) => personas.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => `${p!.emoji} ${p!.name}`)
    .join(', ');

  const send = () => {
    if (!text.trim()) return;
    wsSend({ type: 'meeting.say', text: text.trim() });
    setText('');
  };

  return (
    <div className="chat">
      <div className="hint">In the room: {names}. Tip: use @Name to address one person.</div>
      <div className="msgs">
        {meeting.transcript.map((t, i) => {
          const sp = personas.find((p) => p.name === t.speaker);
          return (
            <div key={i} className={`msg ${t.speaker === 'You' ? 'user' : 'agent'}`}>
              <span className="avatar">{t.speaker === 'You' ? '👑' : sp?.emoji ?? '🧑‍💼'}</span>
              <div className="msg-body">
                <div className="msg-meta">
                  <b>{t.speaker}</b>
                  <span className="msg-time">{new Date(t.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="msg-bubble"><Markdown text={t.text} /></div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <button className="btn ghost attach" title="Share a document to the knowledge base for this meeting" onClick={() => pickAndUpload({ meeting: true })}>📎</button>
        <textarea
          value={text}
          placeholder="Speak to the room… (Enter to send)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn primary" onClick={send}>➤</button>
      </div>
    </div>
  );
}

// ── Inbox (deliverables to approve/reject) ─────────────────
function InboxPanel() {
  const { personas, deliverablesVersion } = useStore();
  const [items, setItems] = useState<any[]>([]);
  const [open, setOpen] = useState<any | null>(null);
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    api.deliverables().then(setItems).catch(console.error);
  }, [deliverablesVersion]);

  const who = (id: string) => personas.find((p) => p.id === id);

  if (open) {
    const p = who(open.agentId);
    return (
      <div className="kb-edit">
        <div className="row">
          <button className="btn" onClick={() => setOpen(null)}>← back</button>
          <span className={`pill ${open.status}`}>{open.status}</span>
          <span className="dim">{p?.emoji} {p?.name}</span>
        </div>
        <div className="draft-view">
          <h4>{open.title}</h4>
          <Markdown text={open.content} />
        </div>
        {open.status === 'pending' && (
          <div className="review-bar">
            <input
              placeholder="optional feedback (sent to the agent, they learn from it)"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
            <button
              className="btn primary"
              onClick={() => api.reviewDeliverable(open.id, true, feedback || undefined).then(() => setOpen(null))}
            >
              ✓ Approve → KB
            </button>
            <button
              className="btn danger"
              onClick={() => api.reviewDeliverable(open.id, false, feedback || undefined).then(() => setOpen(null))}
            >
              ✗ Reject
            </button>
          </div>
        )}
      </div>
    );
  }

  const pending = items.filter((i) => i.status === 'pending');
  const done = items.filter((i) => i.status !== 'pending');
  return (
    <div className="kb">
      <div className="hint pad">Reports, findings & documents your team submits. Approve → saved to knowledge base reports/. Reject with feedback → they learn and redo.</div>
      <div className="list">
        {pending.map((d) => (
          <button key={d.id} className="list-item pending" onClick={() => { setFeedback(''); setOpen(d); }}>
            🟡 <b>{d.title}</b>
            <span className="dim"> — {who(d.agentId)?.emoji} {who(d.agentId)?.name} · {new Date(d.ts).toLocaleString()}</span>
          </button>
        ))}
        {done.map((d) => (
          <button key={d.id} className="list-item" onClick={() => setOpen(d)}>
            {d.status === 'approved' ? '✅' : '❌'} {d.title}
            <span className="dim"> — {who(d.agentId)?.name}</span>
          </button>
        ))}
        {!items.length && <div className="hint pad">Nothing yet. Set up a Routine or ask anyone for a report.</div>}
      </div>
    </div>
  );
}

// ── Routines (scheduled work) ──────────────────────────────
function RoutinesPanel() {
  const { personas, routinesVersion } = useStore();
  const [routines, setRoutines] = useState<any[]>([]);
  const [draft, setDraft] = useState<any | null>(null);

  useEffect(() => {
    api.routines().then(setRoutines).catch(console.error);
  }, [routinesVersion]);

  if (draft)
    return (
      <div className="kb-edit">
        <div className="row">
          <button className="btn" onClick={() => setDraft(null)}>← back</button>
          <b className="grow">{draft.id ? 'Edit routine' : 'New routine'}</b>
        </div>
        <div className="form">
          <label>Who
            <select value={draft.agentId} onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}>
              {personas.map((p) => <option key={p.id} value={p.id}>{p.emoji} {p.name} — {p.title}</option>)}
            </select>
          </label>
          <label>Name
            <input value={draft.name} placeholder="Morning Jira digest" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label>Task (what to do each run; result lands in your Inbox)
            <textarea
              className="editor"
              value={draft.prompt}
              placeholder="Summarize all ticket movement in the last 24h, flag stalled Highest-priority items, recommend one action."
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            />
          </label>
          <label>Schedule
            <div className="row" style={{ padding: 0 }}>
              <select value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })}>
                <option value="daily">daily at</option>
                <option value="interval">every N minutes</option>
              </select>
              {draft.schedule === 'daily' ? (
                <input type="time" value={draft.timeOfDay} onChange={(e) => setDraft({ ...draft, timeOfDay: e.target.value })} />
              ) : (
                <input type="number" min={15} value={draft.intervalMinutes} onChange={(e) => setDraft({ ...draft, intervalMinutes: Number(e.target.value) })} />
              )}
            </div>
          </label>
        </div>
        <div className="row right">
          <button
            className="btn primary"
            disabled={!draft.name || !draft.prompt}
            onClick={() => api.saveRoutine(draft).then(() => setDraft(null))}
          >
            Save routine
          </button>
        </div>
      </div>
    );

  return (
    <div className="kb">
      <div className="row">
        <button
          className="btn primary"
          onClick={() => setDraft({ agentId: personas[0]?.id ?? 'pm', name: '', prompt: '', schedule: 'daily', timeOfDay: '09:00', intervalMinutes: 240, enabled: true })}
        >
          + New routine
        </button>
      </div>
      <div className="hint">Scheduled background work. Each run ends as a deliverable in your 📥 Inbox.</div>
      <div className="list">
        {routines.map((r) => {
          const p = personas.find((x) => x.id === r.agentId);
          return (
            <div key={r.id} className="routine-item">
              <button className="routine-main" onClick={() => setDraft({ ...r })}>
                <b>{r.enabled ? '🟢' : '⚪'} {r.name}</b>
                <span className="dim"> — {p?.emoji} {p?.name} · {r.schedule === 'daily' ? `daily ${r.timeOfDay}` : `every ${r.intervalMinutes}m`}{r.lastRun ? ` · last ${new Date(r.lastRun).toLocaleTimeString()}` : ''}</span>
              </button>
              <button className="btn" title="run now" onClick={() => api.runRoutine(r.id)}>▶</button>
              <button className="btn" title={r.enabled ? 'pause' : 'resume'} onClick={() => api.saveRoutine({ ...r, enabled: !r.enabled })}>{r.enabled ? '⏸' : '⏵'}</button>
              <button className="btn danger" title="delete" onClick={() => api.deleteRoutine(r.id)}>✕</button>
            </div>
          );
        })}
        {!routines.length && <div className="hint pad">No routines yet — try "Morning Jira digest" for Priya at 09:00.</div>}
      </div>
    </div>
  );
}

// ── Knowledge Base ─────────────────────────────────────────
function KBPanel() {
  const kbVersion = useStore((s) => s.kbVersion);
  const personas = useStore((s) => s.personas);
  const set = useStore((s) => s.set);
  const [files, setFiles] = useState<{ name: string; size: number; audience: 'all' | string[]; summary?: string; tags?: string[] }[]>([]);
  const [open, setOpen] = useState<{ name: string; content: string } | null>(null);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    api.kbList().then(setFiles).catch(console.error);
  }, [kbVersion]);

  const audienceLabel = (a: 'all' | string[]) =>
    a === 'all' ? '🌐 Everyone' : '🔒 ' + a.map((id) => personas.find((p) => p.id === id)?.name ?? id).join(', ');
  const isEditable = (name: string) => /\.(md|txt|json|csv|html|yaml|yml)$/i.test(name);

  const openFile = (name: string) => api.kbRead(name).then(setOpen).catch(console.error);

  if (open)
    return (
      <div className="kb-edit">
        <div className="row">
          <button className="btn" onClick={() => setOpen(null)}>← back</button>
          <b className="grow">{open.name}</b>
          {isEditable(open.name) && (
            <button
              className="btn primary"
              onClick={() => api.kbWrite(open.name, open.content).then(() => setOpen(null))}
            >
              Save
            </button>
          )}
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Delete ${open.name}?`)) api.kbDelete(open.name).then(() => setOpen(null));
            }}
          >
            Delete
          </button>
        </div>
        {!isEditable(open.name) && (
          <div className="hint">Extracted text preview (read-only). The original {open.name.split('.').pop()?.toUpperCase()} file is what agents read.</div>
        )}
        <textarea
          className="editor"
          readOnly={!isEditable(open.name)}
          value={open.content}
          onChange={(e) => setOpen({ ...open, content: e.target.value })}
        />
      </div>
    );

  return (
    <div className="kb">
      <div className="row">
        <input
          placeholder="new-doc.md"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          className="btn"
          onClick={() => {
            if (newName.trim()) {
              api.kbWrite(newName.trim(), '# ' + newName.trim() + '\n\n').then(() => {
                setNewName('');
                openFile(newName.trim());
              });
            }
          }}
        >
          + New
        </button>
        <button className="btn" onClick={() => pickAndUpload({})}>⬆ Upload</button>
      </div>
      <div className="hint">Dump PRDs, docs, anything. Tag each one for everyone or specific employees — agents only see what's shared with them.</div>
      <div className="list">
        {files.map((f) => (
          <div key={f.name} className="kb-row">
            <button className="kb-row-main" onClick={() => openFile(f.name)}>
              {/\.(docx|xlsx|pptx|pdf)$/i.test(f.name) ? '📎' : '📄'} {f.name} <span className="dim">{(f.size / 1024).toFixed(1)}KB</span>
              <div><span className={`aud-chip ${f.audience === 'all' ? 'all' : 'some'}`}>{audienceLabel(f.audience)}</span></div>
            </button>
            <a className="btn ghost" title="Download" href={`/api/kb/raw?name=${encodeURIComponent(f.name)}`} download>⬇</a>
            <button className="btn ghost" title="Edit audience, tags & summary" onClick={() => set({ uploadDialog: { name: f.name, audience: f.audience, summary: f.summary, tags: f.tags } })}>🏷</button>
          </div>
        ))}
        {!files.length && <div className="hint pad">Knowledge base is empty — drop your first PRD here.</div>}
      </div>
    </div>
  );
}

// ── Logs ───────────────────────────────────────────────────
function LogsPanel() {
  const { personas, logLive } = useStore();
  const [agent, setAgent] = useState('pm');
  const [history, setHistory] = useState<{ ts: number; kind: string; text: string }[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.logs(agent).then(setHistory).catch(console.error);
  }, [agent]);
  const live = (logLive[agent] ?? []).filter((e) => !history.some((h) => h.ts === e.ts && h.text === e.text));
  const all = [...history, ...live];
  useEffect(() => endRef.current?.scrollIntoView(), [all.length, agent]);

  return (
    <div className="chat">
      <select value={agent} onChange={(e) => setAgent(e.target.value)}>
        {personas.map((p) => (
          <option key={p.id} value={p.id}>{p.emoji} {p.name}'s log</option>
        ))}
      </select>
      <div className="msgs logs">
        {all.map((e, i) => (
          <div key={i} className={`log-line ${e.kind}`}>
            <span className="dim">{new Date(e.ts).toLocaleTimeString()}</span> <b>[{e.kind}]</b> {e.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ── Drafts ─────────────────────────────────────────────────
function DraftsPanel() {
  const [drafts, setDrafts] = useState<any[]>([]);
  const [open, setOpen] = useState<any | null>(null);
  const refresh = () => {
    api.drafts().then(setDrafts).catch(console.error);
  };
  useEffect(refresh, []);

  if (open)
    return (
      <div className="kb-edit">
        <div className="row">
          <button className="btn" onClick={() => setOpen(null)}>← back</button>
          <span className={`pill ${open.status}`}>{open.status}</span>
          <button className="btn danger" onClick={() => api.deleteDraft(open.id).then(() => { setOpen(null); refresh(); })}>Delete</button>
        </div>
        <div className="draft-view">
          <p><b>To:</b> {open.to}</p>
          <p><b>Subject:</b> {open.subject}</p>
          <Markdown text={open.body} />
          <div className="hint">To send: ask Grace in chat — "send draft {open.id}" — then approve the prompt.</div>
        </div>
      </div>
    );

  return (
    <div className="kb">
      <div className="hint pad">Email drafts saved by Grace. Nothing is ever sent without your approval.</div>
      <div className="list">
        {drafts.map((d) => (
          <button key={d.id} className="list-item" onClick={() => setOpen(d)}>
            {d.status === 'sent' ? '✅' : '📝'} <b>{d.subject}</b> → {d.to}
          </button>
        ))}
        {!drafts.length && <div className="hint pad">No drafts yet.</div>}
      </div>
    </div>
  );
}

// ── Overview (employees: details, connections, schedules, CRUD) ──
const CONN: Record<string, { label: string; key?: string }> = {
  jira: { label: 'Jira', key: 'jira' },
  zoom: { label: 'Zoom', key: 'zoom' },
  scrape: { label: 'Web Scraping', key: 'scrape' },
  email: { label: 'Email (SMTP)', key: 'email' },
  hf: { label: 'Hugging Face', key: 'huggingface' },
  github: { label: 'GitHub', key: 'github' },
  spotify: { label: 'Spotify (music)', key: 'spotify' },
  docs: { label: 'Word/Excel/PPT files' },
  web: { label: 'WebSearch + WebFetch' },
  reach: { label: 'Agent-Reach: Jina + YouTube' },
  bash: { label: 'Workspace files + shell' },
};
const MODEL_LABEL: Record<string, string> = { auto: 'Auto', sonnet: 'Sonnet', opus: 'Opus', haiku: 'Haiku' };

export function blankPersona(): Persona {
  return { id: '', name: '', title: '', emoji: '🙂', sprite: 0, model: 'sonnet', toolsets: [], prompt: '' };
}

function OverviewPanel() {
  const { personas, integrations, routinesVersion, set } = useStore();
  const [openId, setOpenId] = useState<string | null>(null);
  const [routines, setRoutines] = useState<any[]>([]);
  const [editingDoc, setEditingDoc] = useState<{ name: string; content: string } | null>(null);
  useEffect(() => {
    api.routines().then(setRoutines).catch(console.error);
  }, [routinesVersion, openId]);

  const editDoc = (name: string) =>
    api.agentDocRead(name).then(setEditingDoc).catch((e) => alert(e.message));
  const saveDoc = () => {
    if (!editingDoc) return;
    api.agentDocWrite(editingDoc.name, editingDoc.content)
      .then(() => setEditingDoc(null))
      .catch((e) => alert(e.message));
  };

  if (editingDoc) {
    return (
      <div className="kb-edit">
        <div className="row">
          <button className="btn" onClick={() => setEditingDoc(null)}>← back</button>
          <b className="grow">📘 {editingDoc.name}</b>
          <button className="btn primary" onClick={saveDoc}>Save</button>
        </div>
        <div className="hint">Edits take effect immediately. Saving an agent's <code>&lt;id&gt;.md</code> resets their conversation so the new playbook loads cleanly. Shared docs (_common.md, _ponytail.md) apply to every agent on their next turn.</div>
        <textarea
          className="editor tall"
          value={editingDoc.content}
          spellCheck={false}
          onChange={(e) => setEditingDoc({ ...editingDoc, content: e.target.value })}
        />
      </div>
    );
  }

  const open = personas.find((p) => p.id === openId);

  if (open) {
    const conns = open.toolsets.length ? open.toolsets : [];
    const mine = routines.filter((r) => r.agentId === open.id);
    return (
      <div className="kb-edit">
        <div className="row">
          <button className="btn" onClick={() => setOpenId(null)}>← team</button>
          <b className="grow">{open.emoji} {open.name}</b>
          <button className="btn" onClick={() => set({ editingPersona: { ...open } })}>✏️ Edit</button>
          <button className="btn" onClick={() => editDoc(`${open.id}.md`)}>📘 Playbook</button>
          <button
            className="btn danger"
            onClick={() => {
              if (confirm(`Remove ${open.name} and their desk?`))
                api.deletePersona(open.id).then(() => setOpenId(null)).catch((e) => alert(e.message));
            }}
          >
            🗑 Delete
          </button>
        </div>
        <div className="emp-detail">
          <div className="emp-id">
            <img className="emp-portrait" src={`/assets/characters/char_${open.sprite}.png`} alt="" />
            <div>
              <div className="emp-name">{open.emoji} {open.name}</div>
              <div className="dim">{open.title}</div>
              <div className="emp-chips">
                <span className="chip">🧠 {MODEL_LABEL[open.model] ?? open.model}</span>
              </div>
            </div>
          </div>

          <h4>🔌 Connections</h4>
          {conns.length ? (
            <div className="conn-list">
              {conns.map((t) => {
                const c = CONN[t] ?? { label: t };
                const live = c.key ? integrations[c.key] : true;
                return (
                  <span key={t} className={`conn-chip ${live ? 'live' : 'off'}`}>
                    {live ? '🟢' : '⚪'} {c.label}
                  </span>
                );
              })}
            </div>
          ) : (
            <div className="hint">Core tools only (knowledge base, memory, team chat, web search).</div>
          )}

          <h4>⏰ Schedules</h4>
          {mine.length ? (
            <div className="conn-list">
              {mine.map((r) => (
                <div key={r.id} className="sched-row">
                  {r.enabled ? '🟢' : '⚪'} <b>{r.name}</b>
                  <span className="dim"> — {r.schedule === 'daily' ? `daily ${r.timeOfDay}` : `every ${r.intervalMinutes}m`}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="hint">No routines. Add one in the ⏰ Routines tab.</div>
          )}

          <h4>🎭 Persona & duties</h4>
          <div className="emp-prompt"><Markdown text={open.prompt} /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="kb">
      <div className="row">
        <b className="grow">👥 {personas.length} employee{personas.length === 1 ? '' : 's'}</b>
        <button className="btn" title="Team-wide rules (applies to every employee)" onClick={() => editDoc('_common.md')}>📕 Team rules</button>
        <button className="btn" title="Lazy-senior thinking discipline" onClick={() => editDoc('_ponytail.md')}>🎀 Ponytail</button>
        <button className="btn primary" onClick={() => set({ editingPersona: blankPersona() })}>+ Add employee</button>
      </div>
      <div className="emp-grid">
        {personas.map((p, i) => (
          <button key={p.id} className="emp-card" onClick={() => setOpenId(p.id)}>
            <img className="emp-portrait sm" src={`/assets/characters/char_${p.sprite}.png`} alt="" />
            <div className="emp-card-body">
              <div className="emp-name">{p.emoji} {p.name}</div>
              <div className="dim">{p.title}</div>
              <div className="emp-card-conns">
                <span className="chip sm">🧠 {MODEL_LABEL[p.model] ?? p.model}</span>
                <span className="chip sm">🪑 Desk {i + 1}</span>
                {(p.toolsets.length ? p.toolsets : ['core']).slice(0, 4).map((t) => (
                  <span key={t} className="chip sm">{(CONN[t]?.label ?? t)}</span>
                ))}
              </div>
            </div>
          </button>
        ))}
      </div>
      <div className="hint pad">
        Integrations: {Object.entries(integrations).map(([k, v]) => `${v ? '✓' : '✗'} ${k}`).join('  ')}
      </div>
    </div>
  );
}

// ── Persona editor modal ───────────────────────────────────
export function PersonaModal() {
  const editing = useStore((s) => s.editingPersona);
  const set = useStore((s) => s.set);
  const [p, setP] = useState<Persona | null>(null);
  const [mcpText, setMcpText] = useState('');
  const [mcpErr, setMcpErr] = useState('');
  useEffect(() => {
    setP(editing ? { ...editing } : null);
    setMcpText(editing?.mcp && Object.keys(editing.mcp).length ? JSON.stringify(editing.mcp, null, 2) : '');
    setMcpErr('');
  }, [editing]);
  if (!editing || !p) return null;

  const TOOLSETS = ['jira', 'zoom', 'scrape', 'web', 'reach', 'email', 'hf', 'github', 'spotify', 'docs', 'bash'];
  const isNew = !p.id;

  const save = async () => {
    // Parse the optional MCP/connector JSON into persona.mcp (empty = none).
    let mcp: Record<string, unknown> | undefined;
    const raw = mcpText.trim();
    if (raw) {
      try {
        mcp = JSON.parse(raw);
        if (typeof mcp !== 'object' || Array.isArray(mcp)) throw new Error('must be a JSON object of servers');
      } catch (e) {
        setMcpErr(`Invalid MCP JSON: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    const payload = { ...p, mcp };
    try {
      if (isNew) await api.createPersona(payload);
      else await api.savePersona(payload);
      set({ editingPersona: null });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => set({ editingPersona: null })}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isNew ? '➕ Add employee' : `${p.emoji} Edit ${p.name}`}</h3>
        <label>Name <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></label>
        <label>Title <input value={p.title} onChange={(e) => setP({ ...p, title: e.target.value })} /></label>
        <label>Emoji <input value={p.emoji} onChange={(e) => setP({ ...p, emoji: e.target.value })} /></label>
        <label>
          Look (sprite)
          <div className="sprite-row">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <button
                key={i}
                className={p.sprite === i ? 'sprite-pick active' : 'sprite-pick'}
                onClick={() => setP({ ...p, sprite: i })}
                style={{ backgroundImage: `url(/assets/characters/char_${i}.png)` }}
              />
            ))}
          </div>
        </label>
        <label>
          Model
          <select value={p.model} onChange={(e) => setP({ ...p, model: e.target.value })}>
            <option value="auto">auto (uses Settings provider)</option>
          </select>
        </label>
        <label>
          Toolsets
          <div className="toolset-row">
            {TOOLSETS.map((t) => (
              <label key={t} className="check">
                <input
                  type="checkbox"
                  checked={p.toolsets.includes(t)}
                  onChange={(e) =>
                    setP({
                      ...p,
                      toolsets: e.target.checked ? [...p.toolsets, t] : p.toolsets.filter((x) => x !== t),
                    })
                  }
                />
                {t}
              </label>
            ))}
          </div>
        </label>
        <label>
          Persona & duties (system prompt)
          <textarea className="editor tall" value={p.prompt} onChange={(e) => setP({ ...p, prompt: e.target.value })} />
        </label>
        <label>
          🔌 Connectors / MCP servers (optional, advanced)
          <textarea
            className="editor"
            spellCheck={false}
            placeholder={'{\n  "notion": { "type": "http", "url": "https://mcp.notion.com/mcp" },\n  "github-mcp": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n}'}
            value={mcpText}
            onChange={(e) => { setMcpText(e.target.value); setMcpErr(''); }}
          />
        </label>
        {mcpErr && <div className="hint" style={{ color: '#ff6b6b' }}>{mcpErr}</div>}
        <div className="hint">
          Attach any MCP server/connector to this employee — Notion, Slack, a custom HTTP/stdio server, etc. Same shape as Claude Code's <code>mcpServers</code>. Leave blank for none. Their tools route through your approval prompts.
        </div>
        <div className="hint">{isNew ? 'A new desk appears in the office for them.' : "Saving resets this character's conversation so the new persona takes effect."}</div>
        <div className="row right">
          {!isNew && <button className="btn" onClick={() => api.resetSession(p.id)}>♻ Reset chat</button>}
          {!isNew && <button className="btn danger" onClick={async () => { if (confirm(`Fire ${p.name}? This removes them from the office.`)) { await api.deletePersona(p.id); set({ editingPersona: null }); } }}>🗑 Fire</button>}
          <button className="btn" onClick={() => set({ editingPersona: null })}>Cancel</button>
          <button className="btn primary" disabled={isNew && !p.name.trim()} onClick={save}>{isNew ? 'Hire' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
