/**
 * In-process MCP toolsets given to agent characters.
 * Sensitive tools are gated by canUseTool in agents.ts (user approval), not here.
 */
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { env } from './config.js';
import { spotifyConfigured, spotifyLinked } from './spotify.js';
import {
  jiraFetch,
  adf,
  zoomFetch,
  zoomDownload,
  smartScrape,
  pageMarkdown,
  gruntComplete,
  hfFetch,
  ghFetch,
  sendEmail,
} from './integrations.js';
import {
  spotifySearch,
  spotifyPlay,
  spotifyPause,
  spotifyResume,
  spotifyNext,
  spotifyPrevious,
  spotifySeek,
  spotifyVolume,
  spotifyNowPlaying,
} from './spotify.js';
import { kbList, kbRead, kbWrite, kbDelete, kbSearch } from './kb.js';
import { semanticSearch } from './embeddings.js';
import { patchPlaybook, readAgentDoc } from './agentDocs.js';
import { appendMemory } from './memory.js';
import { saveDraft, getDraft, listDrafts, markSent } from './drafts.js';
import { submitDeliverable } from './deliverables.js';
import { appendLog } from './logs.js';
import { compactText } from './compress.js';
import { createWordDoc, createSpreadsheet, createPresentation } from './office.js';
import type { Persona } from './types.js';

const text = (s: unknown) => ({
  content: [{ type: 'text' as const, text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }],
});
const errText = (e: unknown) => ({
  content: [{ type: 'text' as const, text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

/** Tool names that require explicit user approval before running. */
export const SENSITIVE_TOOLS = new Set([
  'mcp__jira__jira_create',
  'mcp__jira__jira_update',
  'mcp__jira__jira_delete',
  'mcp__jira__jira_transition',
  'mcp__jira__jira_comment',
  'mcp__email__email_send',
  'mcp__kb__kb_write',
  'mcp__kb__kb_delete',
  'mcp__github__gh_clone',
  'mcp__docs__create_word_doc',
  'mcp__docs__create_spreadsheet',
  'mcp__docs__create_presentation',
  'Bash',
  'Write',
  'Edit',
]);

/** Human-readable summary for the approval toast. */
export function approvalSummary(toolName: string, input: Record<string, unknown>): string {
  const short = (v: unknown, n = 120) => String(v ?? '').slice(0, n);
  switch (toolName) {
    case 'mcp__jira__jira_create':
      return `Create Jira issue in ${short(input.projectKey)}: "${short(input.summary)}"`;
    case 'mcp__jira__jira_update':
      return `Update Jira issue ${short(input.key)}`;
    case 'mcp__jira__jira_delete':
      return `DELETE Jira issue ${short(input.key)}`;
    case 'mcp__jira__jira_transition':
      return `Move ${short(input.key)} to "${short(input.transition)}"`;
    case 'mcp__jira__jira_comment':
      return `Comment on ${short(input.key)}: "${short(input.body, 80)}…"`;
    case 'mcp__email__email_send':
      return `SEND email draft ${short(input.draftId)}`;
    case 'mcp__kb__kb_write':
      return `Write knowledge base file "${short(input.name)}"`;
    case 'mcp__kb__kb_delete':
      return `Delete knowledge base file "${short(input.name)}"`;
    case 'mcp__github__gh_clone':
      return `Clone repo ${short(input.repoUrl)} into workspace`;
    case 'mcp__docs__create_word_doc':
      return `Create Word document "${short(input.name)}.docx"`;
    case 'mcp__docs__create_spreadsheet':
      return `Create Excel spreadsheet "${short(input.name)}.xlsx"`;
    case 'mcp__docs__create_presentation':
      return `Create PowerPoint "${short(input.name)}.pptx"`;
    case 'Bash':
      return `Run shell command: ${short(input.command, 160)}`;
    case 'Write':
      return `Write file ${short(input.file_path)}`;
    case 'Edit':
      return `Edit file ${short(input.file_path)}`;
    default:
      return toolName;
  }
}

/** Full content preview shown in the approval prompt so the boss reviews the actual thing. */
export function approvalDetail(toolName: string, input: Record<string, unknown>): string {
  const cap = (s: unknown, n = 2500) => {
    const t = String(s ?? '');
    return t.length > n ? t.slice(0, n) + '\n…[truncated]' : t;
  };
  switch (toolName) {
    case 'mcp__jira__jira_create':
      return `**Project:** ${input.projectKey}  ·  **Type:** ${input.issueType ?? 'Task'}\n**Summary:** ${input.summary}\n\n${cap(input.description ?? '_(no description)_')}`;
    case 'mcp__jira__jira_update':
      return [
        input.summary ? `**New summary:** ${input.summary}` : '',
        input.labels ? `**Labels:** ${(input.labels as string[]).join(', ')}` : '',
        input.description ? `**New description:**\n${cap(input.description)}` : '',
      ].filter(Boolean).join('\n\n') || '(no field changes)';
    case 'mcp__jira__jira_comment':
      return cap(input.body);
    case 'mcp__jira__jira_transition':
      return `Move **${input.key}** to status **"${input.transition}"**`;
    case 'mcp__jira__jira_delete':
      return `⚠️ Permanently delete issue **${input.key}**`;
    case 'mcp__kb__kb_write':
      return `**File:** ${input.name}\n\n${cap(input.content)}`;
    case 'mcp__kb__kb_delete':
      return `⚠️ Delete knowledge base file **${input.name}**`;
    case 'mcp__email__email_send': {
      try {
        const d = getDraft(String(input.draftId));
        return `**To:** ${d.to}\n**Subject:** ${d.subject}\n\n${cap(d.body)}`;
      } catch {
        return `Send draft ${input.draftId} (draft not found?)`;
      }
    }
    case 'mcp__github__gh_clone':
      return `Clone **${input.repoUrl}** into the agent's workspace`;
    case 'mcp__docs__create_word_doc':
      return `**Word document:** ${input.name}.docx\n\n${cap(input.markdown)}`;
    case 'mcp__docs__create_spreadsheet':
      return `**Excel spreadsheet:** ${input.name}.xlsx\n\n${cap(JSON.stringify(input.sheets, null, 2), 1800)}`;
    case 'mcp__docs__create_presentation':
      return `**PowerPoint:** ${input.name}.pptx\n\n${cap(
        ((input.slides as { title: string; bullets?: string[] }[]) ?? [])
          .map((s, i) => `Slide ${i + 1}: ${s.title}\n${(s.bullets ?? []).map((b) => '  • ' + b).join('\n')}`)
          .join('\n\n'),
        2000,
      )}`;
    case 'Bash':
      return '```\n' + cap(input.command, 800) + '\n```';
    case 'Write':
      return `**File:** ${input.file_path}\n\n${cap(input.content)}`;
    case 'Edit':
      return `**File:** ${input.file_path}\n\n**Replace:**\n\`\`\`\n${cap(input.old_string, 600)}\n\`\`\`\n**With:**\n\`\`\`\n${cap(input.new_string, 600)}\n\`\`\``;
    default:
      return cap(JSON.stringify(input, null, 2));
  }
}

// ── shared toolsets ────────────────────────────────────────

/** KB tools are per-agent so they only see documents shared with them. */
const kbServer = (agentId: string) =>
  createSdkMcpServer({
    name: 'kb',
    tools: [
      tool('kb_list', 'List knowledge base files shared with you', {}, async () => text(kbList(agentId))),
      tool('kb_read', 'Read a knowledge base file — text, Word (.docx), PDF, PowerPoint (.pptx) or Excel (only if shared with you)', { name: z.string() }, async (a) => {
        try {
          return text(await kbRead(a.name, agentId));
        } catch (e) {
          return errText(e);
        }
      }),
      tool('kb_search', 'Keyword search the knowledge base (only files shared with you)', { query: z.string() }, async (a) =>
        text(kbSearch(a.query, agentId)),
      ),
      tool(
        'kb_find',
        'SEMANTIC search the knowledge base by meaning — returns only the 2-3 most relevant passages (not whole files). Prefer this over kb_read for questions: it keeps your context small. Falls back gracefully if unavailable.',
        { query: z.string(), topK: z.number().optional() },
        async (a) => {
          try {
            const hits = await semanticSearch(a.query, agentId, a.topK ?? 3);
            if (!hits.length) return text('No relevant passages found. Try kb_search (keyword) or kb_list.');
            return text(hits.map((h) => `### ${h.name} (relevance ${h.score.toFixed(2)})\n${h.snippet}`).join('\n\n'));
          } catch (e) {
            // embeddings model unavailable → degrade to keyword search, don't fail the agent
            return text(`(semantic search unavailable: ${e instanceof Error ? e.message : String(e)} — falling back to keyword)\n` + JSON.stringify(kbSearch(a.query, agentId)));
          }
        },
      ),
      tool(
        'kb_write',
        'Create or overwrite a knowledge base document (requires user approval). audience: "all" or a comma list of coworker ids.',
        {
          name: z.string().describe('filename, e.g. research/competitors.md'),
          content: z.string(),
          audience: z.string().optional().describe('"all" (default) or comma-separated agent ids who may see it'),
        },
        async (a) => {
          try {
            const audience = !a.audience || a.audience.trim() === 'all'
              ? 'all'
              : a.audience.split(',').map((s) => s.trim()).filter(Boolean);
            kbWrite(a.name, a.content, { audience, by: agentId, ts: Date.now() });
            return text(`Saved ${a.name} (${a.content.length} chars), visible to ${audience === 'all' ? 'everyone' : (audience as string[]).join(', ')}`);
          } catch (e) {
            return errText(e);
          }
        },
      ),
      tool('kb_delete', 'Delete a knowledge base file (requires user approval)', { name: z.string() }, async (a) => {
        try {
          kbDelete(a.name);
          return text(`Deleted ${a.name}`);
        } catch (e) {
          return errText(e);
        }
      }),
    ],
  });

// Cheap-text offload: summarize/condense/classify big text on Groq (open-source,
// free) instead of spending Claude tokens. This is the token-saving lever — pull a
// large blob through here and feed Claude only the short result.
const analyzeServer = createSdkMcpServer({
  name: 'analyze',
  tools: [
    tool(
      'summarize_text',
      'Offload bulk/cheap text work to a fast free model: summarize a long passage, condense scraped text, extract fields, or classify a list. Use this BEFORE feeding large content back into your own context — it keeps token cost low.',
      {
        text: z.string().describe('the large text to process'),
        instruction: z.string().describe('what to do, e.g. "summarize in 5 bullets" or "extract every email address as JSON"'),
      },
      async (a) => {
        try {
          return text(
            await gruntComplete(
              `${a.text}\n\n---\nTask: ${a.instruction}\nBe precise and concise; never invent facts not present above.`,
              'You condense and extract from text for a busy team. Output only the result.',
              { maxTokens: 1200, temperature: 0.2 },
            ),
          );
        } catch (e) {
          return errText(e);
        }
      },
    ),
  ],
});

const docsServer = (agentId: string) =>
  createSdkMcpServer({
    name: 'docs',
    tools: [
      tool(
        'create_word_doc',
        'Create a real Microsoft Word (.docx) document from markdown (headings #, bullets -, numbered lists, **bold**, tables). Opens in MS Word AND Google Docs. Saved to the knowledge base; requires user approval.',
        {
          name: z.string().describe('file name without extension, e.g. "Q3 Strategy"'),
          markdown: z.string().describe('document body as markdown'),
          audience: z.string().optional().describe('"all" (default) or comma-separated coworker ids'),
        },
        async (a) => {
          try {
            const audience = !a.audience || a.audience.trim() === 'all' ? 'all' : a.audience.split(',').map((s) => s.trim()).filter(Boolean);
            const path = await createWordDoc(a.name, a.markdown, { audience, by: agentId, ts: Date.now() });
            return text(`Created Word doc → knowledge base ${path}. The boss can download it from the Knowledge tab.`);
          } catch (e) {
            return errText(e);
          }
        },
      ),
      tool(
        'create_spreadsheet',
        'Create a real Excel (.xlsx) spreadsheet. Opens in Excel AND Google Sheets. Saved to the knowledge base; requires user approval.',
        {
          name: z.string(),
          sheets: z
            .array(
              z.object({
                name: z.string().optional(),
                headers: z.array(z.string()).optional(),
                rows: z.array(z.array(z.union([z.string(), z.number()]))),
              }),
            )
            .describe('one or more sheets, each with optional headers + rows'),
          audience: z.string().optional(),
        },
        async (a) => {
          try {
            const audience = !a.audience || a.audience.trim() === 'all' ? 'all' : a.audience.split(',').map((s) => s.trim()).filter(Boolean);
            const path = await createSpreadsheet(a.name, a.sheets, { audience, by: agentId, ts: Date.now() });
            return text(`Created spreadsheet → knowledge base ${path}.`);
          } catch (e) {
            return errText(e);
          }
        },
      ),
      tool(
        'create_presentation',
        'Create a real PowerPoint (.pptx) deck. Opens in PowerPoint AND Google Slides. Saved to the knowledge base; requires user approval.',
        {
          name: z.string(),
          slides: z.array(z.object({ title: z.string(), bullets: z.array(z.string()).optional(), notes: z.string().optional() })),
          audience: z.string().optional(),
        },
        async (a) => {
          try {
            const audience = !a.audience || a.audience.trim() === 'all' ? 'all' : a.audience.split(',').map((s) => s.trim()).filter(Boolean);
            const path = await createPresentation(a.name, a.slides, { audience, by: agentId, ts: Date.now() });
            return text(`Created presentation → knowledge base ${path}.`);
          } catch (e) {
            return errText(e);
          }
        },
      ),
    ],
  });

const workServer = (agentId: string) =>
  createSdkMcpServer({
    name: 'work',
    tools: [
      tool(
        'submit_deliverable',
        'Submit a finished report/document/finding to the boss for review in his Inbox (he approves → saved to knowledge base, or rejects with feedback)',
        { title: z.string(), content: z.string().describe('full markdown content of the deliverable') },
        async (a) => {
          const d = submitDeliverable(agentId, a.title, a.content);
          return text(`Submitted "${a.title}" (id ${d.id}) to the boss's Inbox for review.`);
        },
      ),
    ],
  });

const memoryServer = (agentId: string) =>
  createSdkMcpServer({
    name: 'memory',
    tools: [
      tool(
        'remember',
        'Save a durable lesson/preference/fact you learned, so future conversations improve. Short notes; for big skill updates use update_playbook.',
        { lesson: z.string() },
        async (a) => {
          appendMemory(agentId, a.lesson);
          appendLog(agentId, 'system', `learned: ${a.lesson}`);
          return text('Remembered.');
        },
      ),
      tool(
        'read_playbook',
        'Read your own playbook (skills, hard rules, workflows you maintain). Already loaded in your system prompt — only call this if you need the full untruncated text.',
        {},
        async () => text(readAgentDoc(`${agentId}.md`) || '(empty playbook)'),
      ),
      tool(
        'update_playbook',
        'Update your own playbook to capture a durable lesson/skill/workflow. Use `append` for a dated note (most common), or `replace` to rewrite the whole doc (rare, requires the full new text). Persistent across sessions; future turns get this in their system prompt.',
        {
          append: z.string().optional().describe('Markdown to append as a dated note under "## Learned <today>"'),
          replace: z.string().optional().describe('Full new markdown — completely replaces the playbook'),
        },
        async (a) => {
          const r = patchPlaybook(agentId, { append: a.append, replace: a.replace });
          appendLog(agentId, 'system', `playbook update: ${r}`);
          return text(r);
        },
      ),
    ],
  });

// ── role toolsets ──────────────────────────────────────────

const jiraServer = createSdkMcpServer({
  name: 'jira',
  tools: [
    tool('jira_projects', 'List visible Jira projects', {}, async () => {
      try {
        const d = await jiraFetch('GET', '/project/search?maxResults=50');
        return text((d.values ?? []).map((p: any) => ({ key: p.key, name: p.name, type: p.projectTypeKey })));
      } catch (e) {
        return errText(e);
      }
    }),
    tool(
      'jira_search',
      'Search issues with JQL (e.g. "project = ABC AND status != Done ORDER BY updated DESC")',
      { jql: z.string(), maxResults: z.number().optional() },
      async (a) => {
        try {
          const d = await jiraFetch(
            'POST',
            '/search/jql',
            { jql: a.jql, maxResults: a.maxResults ?? 25, fields: ['summary', 'status', 'assignee', 'priority', 'issuetype', 'updated'] },
          );
          const issues = (d.issues ?? []).map((i: any) => ({
            key: i.key,
            summary: i.fields?.summary,
            status: i.fields?.status?.name,
            assignee: i.fields?.assignee?.displayName ?? null,
            priority: i.fields?.priority?.name,
            type: i.fields?.issuetype?.name,
            updated: i.fields?.updated,
          }));
          return text({ total: d.total ?? issues.length, issues });
        } catch (e) {
          return errText(e);
        }
      },
    ),
    tool('jira_get', 'Get full detail of one issue', { key: z.string() }, async (a) => {
      try {
        const i = await jiraFetch('GET', `/issue/${a.key}`);
        return text({
          key: i.key,
          summary: i.fields?.summary,
          description: JSON.stringify(i.fields?.description)?.slice(0, 3000),
          status: i.fields?.status?.name,
          assignee: i.fields?.assignee?.displayName,
          labels: i.fields?.labels,
          comments: (i.fields?.comment?.comments ?? []).slice(-5).map((c: any) => ({
            by: c.author?.displayName,
            body: JSON.stringify(c.body)?.slice(0, 500),
          })),
        });
      } catch (e) {
        return errText(e);
      }
    }),
    tool(
      'jira_create',
      'Create a Jira issue (requires user approval)',
      {
        projectKey: z.string(),
        summary: z.string(),
        description: z.string().optional(),
        issueType: z.string().optional().describe('Task, Bug, Story… default Task'),
      },
      async (a) => {
        try {
          const d = await jiraFetch('POST', '/issue', {
            fields: {
              project: { key: a.projectKey },
              summary: a.summary,
              ...(a.description ? { description: adf(a.description) } : {}),
              issuetype: { name: a.issueType ?? 'Task' },
            },
          });
          return text(`Created ${d.key}`);
        } catch (e) {
          return errText(e);
        }
      },
    ),
    tool(
      'jira_update',
      'Update summary/description/labels of an issue (requires user approval)',
      { key: z.string(), summary: z.string().optional(), description: z.string().optional(), labels: z.array(z.string()).optional() },
      async (a) => {
        try {
          const fields: any = {};
          if (a.summary) fields.summary = a.summary;
          if (a.description) fields.description = adf(a.description);
          if (a.labels) fields.labels = a.labels;
          await jiraFetch('PUT', `/issue/${a.key}`, { fields });
          return text(`Updated ${a.key}`);
        } catch (e) {
          return errText(e);
        }
      },
    ),
    tool('jira_delete', 'Delete an issue (requires user approval)', { key: z.string() }, async (a) => {
      try {
        await jiraFetch('DELETE', `/issue/${a.key}`);
        return text(`Deleted ${a.key}`);
      } catch (e) {
        return errText(e);
      }
    }),
    tool(
      'jira_transition',
      'Move an issue to another status by transition name (requires user approval)',
      { key: z.string(), transition: z.string() },
      async (a) => {
        try {
          const d = await jiraFetch('GET', `/issue/${a.key}/transitions`);
          const t = (d.transitions ?? []).find((x: any) => x.name.toLowerCase() === a.transition.toLowerCase());
          if (!t) return errText(new Error(`No transition "${a.transition}". Available: ${(d.transitions ?? []).map((x: any) => x.name).join(', ')}`));
          await jiraFetch('POST', `/issue/${a.key}/transitions`, { transition: { id: t.id } });
          return text(`${a.key} → ${t.name}`);
        } catch (e) {
          return errText(e);
        }
      },
    ),
    tool('jira_comment', 'Add a comment to an issue (requires user approval)', { key: z.string(), body: z.string() }, async (a) => {
      try {
        await jiraFetch('POST', `/issue/${a.key}/comment`, { body: adf(a.body) });
        return text(`Commented on ${a.key}`);
      } catch (e) {
        return errText(e);
      }
    }),
  ],
});

const zoomServer = createSdkMcpServer({
  name: 'zoom',
  tools: [
    tool(
      'zoom_list_recordings',
      'List my Zoom cloud recordings (dates YYYY-MM-DD; defaults to last 30 days)',
      { from: z.string().optional(), to: z.string().optional() },
      async (a) => {
        try {
          const to = a.to ?? new Date().toISOString().slice(0, 10);
          const from = a.from ?? new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
          const d = await zoomFetch(`/users/me/recordings?from=${from}&to=${to}&page_size=30`);
          return text(
            (d.meetings ?? []).map((m: any) => ({
              id: m.id,
              uuid: m.uuid,
              topic: m.topic,
              start: m.start_time,
              duration: m.duration,
              files: (m.recording_files ?? []).map((f: any) => f.file_type),
            })),
          );
        } catch (e) {
          return errText(e);
        }
      },
    ),
    tool('zoom_get_transcript', 'Download the transcript (VTT) of a recorded meeting by meeting id or uuid', { meetingId: z.string() }, async (a) => {
      try {
        const d = await zoomFetch(`/meetings/${encodeURIComponent(a.meetingId)}/recordings`);
        const t = (d.recording_files ?? []).find((f: any) => f.file_type === 'TRANSCRIPT');
        if (!t) return errText(new Error('No transcript file on that recording (audio transcript may still be processing or is disabled).'));
        const vtt = await zoomDownload(t.download_url);
        // Transcripts are huge — hand back a capped slice and steer to summarize_text
        // so the full VTT never has to live in the agent's context window.
        return text(vtt.length > 24_000 ? vtt.slice(0, 24_000) + '\n…[truncated — pass this through summarize_text for action items instead of re-reading raw]' : vtt);
      } catch (e) {
        return errText(e);
      }
    }),
    tool('zoom_upcoming_meetings', 'List my upcoming Zoom meetings', {}, async () => {
      try {
        const d = await zoomFetch('/users/me/meetings?type=upcoming&page_size=20');
        return text((d.meetings ?? []).map((m: any) => ({ id: m.id, topic: m.topic, start: m.start_time })));
      } catch (e) {
        return errText(e);
      }
    }),
  ],
});

const scrapeServer = createSdkMcpServer({
  name: 'scrape',
  tools: [
    tool(
      'scrape_page',
      'Extract structured info from any webpage (give the URL and what to extract). Fetches the page locally, strips it to text, then a free model extracts only the asked-for fields — never raw HTML in your context.',
      { url: z.string(), prompt: z.string().describe('what to extract, e.g. "research interests and contact email"') },
      async (a) => {
        try {
          const r = await smartScrape(a.url, a.prompt);
          return text(typeof r === 'string' ? compactText(r) : r);
        } catch (e) {
          return errText(e);
        }
      },
    ),
    tool('markdownify', 'Convert a webpage to clean readable text/markdown', { url: z.string() }, async (a) => {
      try {
        return text(compactText(await pageMarkdown(a.url)));
      } catch (e) {
        return errText(e);
      }
    }),
  ],
});

const emailServer = (agentId: string) =>
  createSdkMcpServer({
    name: 'email',
    tools: [
      tool(
        'email_save_draft',
        'Save a personalized email draft for the user to review',
        { to: z.string(), subject: z.string(), body: z.string() },
        async (a) => {
          const d = saveDraft(agentId, a.to, a.subject, a.body);
          appendLog(agentId, 'system', `draft saved: ${d.id} → ${a.to} "${a.subject}"`);
          return text(`Draft saved with id ${d.id}. Ask the user to review it in the Drafts panel; send only after they approve via email_send.`);
        },
      ),
      tool('email_list_drafts', 'List saved email drafts', {}, async () =>
        text(listDrafts().map((d) => ({ id: d.id, to: d.to, subject: d.subject, status: d.status }))),
      ),
      tool('email_send', 'Send a saved draft by id (requires user approval)', { draftId: z.string() }, async (a) => {
        try {
          const d = getDraft(a.draftId);
          const msgId = await sendEmail(d.to, d.subject, d.body);
          markSent(a.draftId);
          return text(`Sent to ${d.to} (message id ${msgId})`);
        } catch (e) {
          return errText(e);
        }
      }),
    ],
  });

const hfServer = createSdkMcpServer({
  name: 'hf',
  tools: [
    tool(
      'hf_search_models',
      'Search Hugging Face models (optionally filter by pipeline task like "object-detection", "pose-estimation" is under "keypoint-detection")',
      { query: z.string(), task: z.string().optional(), limit: z.number().optional() },
      async (a) => {
        try {
          const params = new URLSearchParams({ search: a.query, limit: String(a.limit ?? 10), sort: 'downloads' });
          if (a.task) params.set('pipeline_tag', a.task);
          const d = await hfFetch(`/models?${params}`);
          return text((d as any[]).map((m) => ({ id: m.modelId ?? m.id, downloads: m.downloads, likes: m.likes, task: m.pipeline_tag })));
        } catch (e) {
          return errText(e);
        }
      },
    ),
    tool('hf_search_spaces', 'Search Hugging Face Spaces (live demos)', { query: z.string(), limit: z.number().optional() }, async (a) => {
      try {
        const d = await hfFetch(`/spaces?search=${encodeURIComponent(a.query)}&limit=${a.limit ?? 10}&sort=likes`);
        return text((d as any[]).map((s) => ({ id: s.id, likes: s.likes, sdk: s.sdk, url: `https://huggingface.co/spaces/${s.id}` })));
      } catch (e) {
        return errText(e);
      }
    }),
    tool('hf_model_info', 'Get details of one Hugging Face model', { id: z.string() }, async (a) => {
      try {
        const m = await hfFetch(`/models/${a.id}`);
        return text({ id: m.id, task: m.pipeline_tag, downloads: m.downloads, tags: (m.tags ?? []).slice(0, 20), siblings: (m.siblings ?? []).slice(0, 30).map((s: any) => s.rfilename) });
      } catch (e) {
        return errText(e);
      }
    }),
  ],
});

const githubServer = (workspaceDir: string) =>
  createSdkMcpServer({
    name: 'github',
    tools: [
      tool('gh_search_repos', 'Search GitHub repositories', { query: z.string(), limit: z.number().optional() }, async (a) => {
        try {
          const d = await ghFetch(`/search/repositories?q=${encodeURIComponent(a.query)}&per_page=${a.limit ?? 8}&sort=stars`);
          return text(
            (d.items ?? []).map((r: any) => ({ full_name: r.full_name, stars: r.stargazers_count, desc: r.description, url: r.html_url, updated: r.pushed_at })),
          );
        } catch (e) {
          return errText(e);
        }
      }),
      tool('gh_readme', 'Fetch the README of a repo (owner/name)', { repo: z.string() }, async (a) => {
        try {
          const d = await ghFetch(`/repos/${a.repo}/readme`);
          const md = Buffer.from(d.content ?? '', 'base64').toString('utf8');
          return text(compactText(md));
        } catch (e) {
          return errText(e);
        }
      }),
      tool('gh_clone', 'Clone a GitHub repo into your workspace (requires user approval)', { repoUrl: z.string() }, async (a) => {
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const run = promisify(execFile);
          const name = a.repoUrl.split('/').pop()?.replace(/\.git$/, '') ?? 'repo';
          await run('git', ['clone', '--depth', '1', a.repoUrl, name], { cwd: workspaceDir });
          return text(`Cloned into workspace/${name}`);
        } catch (e) {
          return errText(e);
        }
      }),
    ],
  });

const spotifyServer = createSdkMcpServer({
  name: 'spotify',
  tools: [
    tool('spotify_search', 'Search Spotify for tracks/playlists/albums', { query: z.string(), type: z.enum(['track', 'playlist', 'album']).optional(), limit: z.number().optional() },
      async (a) => { try { return text(await spotifySearch(a.query, a.type ?? 'track', a.limit ?? 5)); } catch (e) { return errText(e); } }),
    tool('spotify_play', 'Play a track/playlist/album. Give a spotify uri OR a search query (plays the top hit). Use to motivate the team with music.', { uri: z.string().optional(), query: z.string().optional() },
      async (a) => { try { return text(await spotifyPlay({ uri: a.uri, query: a.query })); } catch (e) { return errText(e); } }),
    tool('spotify_pause', 'Pause playback', {}, async () => { try { return text(await spotifyPause()); } catch (e) { return errText(e); } }),
    tool('spotify_resume', 'Resume playback', {}, async () => { try { return text(await spotifyResume()); } catch (e) { return errText(e); } }),
    tool('spotify_next', 'Skip to the next song', {}, async () => { try { return text(await spotifyNext()); } catch (e) { return errText(e); } }),
    tool('spotify_previous', 'Go to the previous song', {}, async () => { try { return text(await spotifyPrevious()); } catch (e) { return errText(e); } }),
    tool('spotify_seek', 'Seek within the current song. Give ms (absolute) OR fraction 0-1 (e.g. 0.5 = play from halfway).', { ms: z.number().optional(), fraction: z.number().optional() },
      async (a) => { try { return text(await spotifySeek({ ms: a.ms, fraction: a.fraction })); } catch (e) { return errText(e); } }),
    tool('spotify_volume', 'Set playback volume 0-100 (lower/raise the sound)', { percent: z.number() },
      async (a) => { try { return text(await spotifyVolume(a.percent)); } catch (e) { return errText(e); } }),
    tool('spotify_now_playing', 'What is currently playing', {}, async () => { try { return text(await spotifyNowPlaying()); } catch (e) { return errText(e); } }),
  ],
});

const teamServer = (
  agentId: string,
  roster: () => Persona[],
  sendToAgent: (targetId: string, fromId: string, message: string, depth: number) => Promise<string>,
  depthRef: { depth: number },
) =>
  createSdkMcpServer({
    name: 'team',
    tools: [
      tool('team_roster', 'List your coworkers and their specialties', {}, async () =>
        text(roster().map((p) => ({ id: p.id, name: p.name, title: p.title }))),
      ),
      tool(
        'team_message',
        'Send a message to a coworker agent and get their reply (use their id from team_roster)',
        { targetId: z.string(), message: z.string() },
        async (a) => {
          if (a.targetId === agentId) return errText(new Error('That is you.'));
          if (depthRef.depth >= 2) return errText(new Error('Conversation chain too deep — summarize and report back to the user instead.'));
          try {
            appendLog(agentId, 'team', `→ ${a.targetId}: ${a.message.slice(0, 300)}`);
            const reply = await sendToAgent(a.targetId, agentId, a.message, depthRef.depth + 1);
            return text(reply);
          } catch (e) {
            return errText(e);
          }
        },
      ),
    ],
  });

// ── assembly ───────────────────────────────────────────────

export interface ToolBundle {
  mcpServers: Record<string, ReturnType<typeof createSdkMcpServer>>;
  allowedTools: string[];
}

export function buildToolBundle(
  persona: Persona,
  workspaceDir: string,
  roster: () => Persona[],
  sendToAgent: (targetId: string, fromId: string, message: string, depth: number) => Promise<string>,
  depthRef: { depth: number },
): ToolBundle {
  // Default toolset — only what EVERY persona needs. The docs server (3 heavy
  // schemas for .docx/.xlsx/.pptx) used to be here unconditionally, costing every
  // persona ~200 tokens/turn even if they never produce files. Now opt-in: a
  // persona needs `docs` in their toolsets to get it. Priya/Zola/Marco typically
  // do; Dex usually doesn't.
  const servers: Record<string, ReturnType<typeof createSdkMcpServer>> = {
    kb: kbServer(persona.id),
    memory: memoryServer(persona.id),
    team: teamServer(persona.id, roster, sendToAgent, depthRef),
    analyze: analyzeServer,
    work: workServer(persona.id),
  };
  const allowed: string[] = [
    'mcp__work__submit_deliverable',
    'mcp__kb__kb_list',
    'mcp__kb__kb_read',
    'mcp__kb__kb_search',
    'mcp__kb__kb_find',
    'mcp__kb__kb_write',
    'mcp__kb__kb_delete',
    'mcp__memory__remember',
    'mcp__memory__read_playbook',
    'mcp__memory__update_playbook',
    'mcp__team__team_roster',
    'mcp__team__team_message',
    'mcp__analyze__summarize_text',
    'WebSearch',
    'WebFetch',
  ];

  const add = (name: string, server: ReturnType<typeof createSdkMcpServer>, tools: string[]) => {
    servers[name] = server;
    allowed.push(...tools.map((t) => `mcp__${name}__${t}`));
  };

  // Runtime gating: only load tool schemas for integrations that are actually
  // configured. A persona can declare 'email' or 'zoom' in their toolsets, but if
  // the creds aren't in .env we skip — saves ~150 tokens/turn each in tool schemas
  // and prevents agents from calling tools that will error. Auto-enables the
  // moment the boss drops the creds in .env (no persona edit needed).
  const jiraOK = !!(env.jira.baseUrl && env.jira.email && env.jira.token);
  const zoomOK = !!(env.zoom.accountId && env.zoom.clientId && env.zoom.clientSecret);
  const emailOK = !!(env.smtp.host && env.smtp.user && env.smtp.pass);
  const spotifyOK = spotifyConfigured() && spotifyLinked();

  for (const ts of persona.toolsets) {
    switch (ts) {
      case 'jira':
        if (jiraOK) add('jira', jiraServer, ['jira_projects', 'jira_search', 'jira_get', 'jira_create', 'jira_update', 'jira_delete', 'jira_transition', 'jira_comment']);
        break;
      case 'zoom':
        if (zoomOK) add('zoom', zoomServer, ['zoom_list_recordings', 'zoom_get_transcript', 'zoom_upcoming_meetings']);
        break;
      case 'scrape':
        // Always available: local fetch + free grunt extraction (no creds needed).
        add('scrape', scrapeServer, ['scrape_page', 'markdownify']);
        break;
      case 'email':
        if (emailOK) add('email', emailServer(persona.id), ['email_save_draft', 'email_list_drafts', 'email_send']);
        break;
      case 'hf':
        // Public HF API works without a token; HF_TOKEN just raises rate limits.
        add('hf', hfServer, ['hf_search_models', 'hf_search_spaces', 'hf_model_info']);
        break;
      case 'github':
        // Public GitHub API works without a token; GITHUB_TOKEN just raises rate limits.
        add('github', githubServer(workspaceDir), ['gh_search_repos', 'gh_readme', 'gh_clone']);
        break;
      case 'docs':
        // No creds needed (local docx/xlsx/pptx writers).
        add('docs', docsServer(persona.id), ['create_word_doc', 'create_spreadsheet', 'create_presentation']);
        break;
      case 'spotify':
        if (spotifyOK) add('spotify', spotifyServer, ['spotify_search', 'spotify_play', 'spotify_pause', 'spotify_resume', 'spotify_next', 'spotify_previous', 'spotify_seek', 'spotify_volume', 'spotify_now_playing']);
        break;
      case 'bash':
        allowed.push('Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep');
        break;
    }
  }
  // Sensitive tools must NOT be pre-allowed — being absent from allowedTools is
  // what routes them through canUseTool, where the user approval prompt lives.
  return { mcpServers: servers, allowedTools: allowed.filter((t) => !SENSITIVE_TOOLS.has(t)) };
}
