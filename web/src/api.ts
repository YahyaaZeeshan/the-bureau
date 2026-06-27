import type { Persona } from './state.js';

const json = async (r: Response) => {
  if (!r.ok) throw new Error((await r.json().catch(() => ({})) as any).error ?? `HTTP ${r.status}`);
  return r.json();
};

export const api = {
  health: () => fetch('/api/health').then(json),
  savePersona: (p: Persona) =>
    fetch(`/api/personas/${p.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    }).then(json),
  createPersona: (p: Partial<Persona>) =>
    fetch('/api/personas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    }).then(json),
  deletePersona: (id: string) => fetch(`/api/personas/${id}`, { method: 'DELETE' }).then(json),
  resetSession: (id: string) => fetch(`/api/personas/${id}/reset-session`, { method: 'POST' }).then(json),
  kbList: () => fetch('/api/kb').then(json),
  kbRead: (name: string) => fetch(`/api/kb/file?name=${encodeURIComponent(name)}`).then(json),
  kbWrite: (name: string, content: string) =>
    fetch('/api/kb/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content }),
    }).then(json),
  kbDelete: (name: string) => fetch(`/api/kb/file?name=${encodeURIComponent(name)}`, { method: 'DELETE' }).then(json),
  kbUpload: (name: string, file: File, audience: string = 'all', by: string = 'boss') =>
    fetch(`/api/kb/upload?name=${encodeURIComponent(name)}&audience=${encodeURIComponent(audience)}&by=${encodeURIComponent(by)}`, {
      method: 'POST',
      body: file,
    }).then(json),
  kbAnalyze: (name: string) =>
    fetch('/api/kb/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(json),
  kbSetAudience: (name: string, audience: string, summary?: string, tags?: string[]) =>
    fetch('/api/kb/audience', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, audience, summary, tags }),
    }).then(json),
  logs: (agentId: string) => fetch(`/api/logs/${agentId}`).then(json),
  deliverables: () => fetch('/api/deliverables').then(json),
  reviewDeliverable: (id: string, approved: boolean, feedback?: string) =>
    fetch(`/api/deliverables/${id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved, feedback }),
    }).then(json),
  deleteDeliverable: (id: string) => fetch(`/api/deliverables/${id}`, { method: 'DELETE' }).then(json),
  routines: () => fetch('/api/routines').then(json),
  saveRoutine: (r: unknown) =>
    fetch('/api/routines', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(r),
    }).then(json),
  runRoutine: (id: string) => fetch(`/api/routines/${id}/run`, { method: 'POST' }).then(json),
  deleteRoutine: (id: string) => fetch(`/api/routines/${id}`, { method: 'DELETE' }).then(json),
  drafts: () => fetch('/api/drafts').then(json),
  deleteDraft: (id: string) => fetch(`/api/drafts/${id}`, { method: 'DELETE' }).then(json),
  agentDocs: () => fetch('/api/agent-docs').then(json),
  agentDocRead: (name: string) => fetch(`/api/agent-docs/file?name=${encodeURIComponent(name)}`).then(json),
  agentDocWrite: (name: string, content: string) =>
    fetch('/api/agent-docs/file', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, content }) }).then(json),
  agentDocDelete: (name: string) => fetch(`/api/agent-docs/file?name=${encodeURIComponent(name)}`, { method: 'DELETE' }).then(json),
  meetingStatus: () => fetch('/api/meeting/status').then(json),
  meetingDownload: () => fetch('/api/meeting/download', { method: 'POST' }).then(json),
  meetingTranscribe: (blob: Blob) =>
    fetch('/api/meeting/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob }).then(json),
  meetingNotes: (segments: any[], topic?: string) =>
    fetch('/api/meeting/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segments, topic }) }).then(json),
};
