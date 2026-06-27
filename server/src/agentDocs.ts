/**
 * Agent-docs layer: editable markdown rulebooks loaded into every agent's system
 * prompt. Each .md is capped so growing them doesn't balloon the prompt.
 *
 *   _common.md     — team rules + senior-judgment discipline (everyone)
 *   <agentId>.md   — that agent's playbook (skills, hard rules, role specifics)
 *
 *   _ponytail.md is OPTIONAL; if present it's appended after _common (legacy).
 *
 * Agents can update their own <agentId>.md via the `update_playbook` tool — so
 * lessons learned today become permanent skill instead of next-turn re-derivation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { bus } from './bus.js';

const DOCS_DIR = path.join(DATA_DIR, 'agent-docs');
const DEFAULTS_DIR = path.join(DATA_DIR, 'agent-docs-default');
const PER_DOC_CAP = 4000;

fs.mkdirSync(DOCS_DIR, { recursive: true });
// First boot: copy default playbooks if agent-docs is empty
if (fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.md')).length === 0 && fs.existsSync(DEFAULTS_DIR)) {
  for (const f of fs.readdirSync(DEFAULTS_DIR).filter(f => f.endsWith('.md'))) {
    fs.copyFileSync(path.join(DEFAULTS_DIR, f), path.join(DOCS_DIR, f));
  }
}

const safeName = (name: string) => name.replace(/[^\w.-]/g, '_');
const filePath = (name: string) => path.join(DOCS_DIR, safeName(name));

export function listAgentDocs(): { name: string; size: number; mtime: number }[] {
  return fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const st = fs.statSync(path.join(DOCS_DIR, f));
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readAgentDoc(name: string): string {
  try {
    return fs.readFileSync(filePath(name), 'utf8');
  } catch {
    return '';
  }
}

export function writeAgentDoc(name: string, content: string): void {
  const p = filePath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  bus.broadcast({ type: 'agent-docs.changed' });
}

export function deleteAgentDoc(name: string): void {
  try {
    fs.rmSync(filePath(name));
    bus.broadcast({ type: 'agent-docs.changed' });
  } catch { /* ignore */ }
}

/** Cap a single doc's text so a runaway playbook can't blow up the system prompt. */
function capDoc(text: string, cap = PER_DOC_CAP): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n…[truncated to ${cap} chars — split this playbook if you need more]`;
}

/** Compose the agent-docs block for an agent's system prompt: project + common + ponytail + their own. */
export function composeAgentDocs(agentId: string): string {
  const parts: string[] = [];
  const project = readAgentDoc('_project.md');
  const common = readAgentDoc('_common.md');
  const ponytail = readAgentDoc('_ponytail.md');
  const own = readAgentDoc(`${agentId}.md`);
  if (project) parts.push(capDoc(project, 3000));
  if (common) parts.push(capDoc(common));
  if (ponytail) parts.push(capDoc(ponytail));
  if (own) parts.push(`# Your playbook\n\n${capDoc(own)}`);
  return parts.join('\n\n---\n\n');
}

/**
 * Append a learned-this-turn note to the agent's playbook (or replace it
 * wholesale). Used by the `update_playbook` tool.
 */
export function patchPlaybook(agentId: string, patch: { append?: string; replace?: string }): string {
  const name = `${agentId}.md`;
  if (patch.replace !== undefined) {
    writeAgentDoc(name, patch.replace);
    return `Replaced playbook (${patch.replace.length} chars).`;
  }
  if (patch.append) {
    const cur = readAgentDoc(name);
    const stamp = new Date().toISOString().slice(0, 10);
    const next = `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}\n## Learned ${stamp}\n${patch.append.trim()}\n`;
    writeAgentDoc(name, next);
    return `Appended note (${patch.append.length} chars).`;
  }
  return 'No change (give append or replace).';
}
