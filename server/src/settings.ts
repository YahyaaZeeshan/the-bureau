import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { bus } from './bus.js';

export interface LLMProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface OfficeSettings {
  provider: LLMProvider;
  groqKey: string;
  groqFallback: boolean;
  autoApprove: boolean;
  autonomousChat: boolean;
  chatterEngine: 'groq';
}

export const PROVIDER_PRESETS: Record<string, { name: string; baseUrl: string; defaultModel: string }> = {
  anthropic: { name: 'Anthropic Claude', baseUrl: '', defaultModel: 'claude-sonnet-4-20250514' },
  openai: { name: 'OpenAI GPT', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  mimo: { name: 'Xiaomi MiMo', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic', defaultModel: 'mimo-v2.5-pro' },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'anthropic/claude-sonnet-4' },
  nemotron: { name: 'NVIDIA Nemotron', baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModel: 'nvidia/llama-3.1-nemotron-70b-instruct' },
  custom: { name: 'Custom (OpenAI-compatible)', baseUrl: '', defaultModel: '' },
};

const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS: OfficeSettings = {
  provider: { id: 'anthropic', name: 'Anthropic Claude', baseUrl: '', apiKey: '', model: 'claude-sonnet-4-20250514' },
  groqKey: process.env.GROQ_API_KEY || '',
  groqFallback: true,
  autoApprove: false,
  autonomousChat: false,
  chatterEngine: 'groq',
};

let settings: OfficeSettings = { ...DEFAULTS };
try {
  const loaded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (loaded.provider && typeof loaded.provider === 'object') {
    settings = { ...DEFAULTS, ...loaded, provider: { ...DEFAULTS.provider, ...loaded.provider } };
  } else {
    // Migration from old brainModel format
    const mimoBase = process.env.MIMO_BASE_URL || '';
    const mimoKey = process.env.MIMO_API_KEY || '';
    const model = loaded.brainModel || 'claude-sonnet-4-20250514';
    if (mimoBase && mimoKey) {
      settings = {
        ...DEFAULTS,
        ...loaded,
        provider: { id: 'mimo', name: 'Xiaomi MiMo', baseUrl: mimoBase, apiKey: mimoKey, model },
      };
    } else {
      settings = { ...DEFAULTS, ...loaded, provider: { ...DEFAULTS.provider, model } };
    }
  }
  if (loaded.groqKey) settings.groqKey = loaded.groqKey;
  else if (!settings.groqKey) settings.groqKey = process.env.GROQ_API_KEY || '';
} catch {
  /* first boot */
}

export const getSettings = (): OfficeSettings => settings;
// Expose for config.ts integrations() (breaks circular import)
(globalThis as any).__pixelSettings = getSettings;

export function updateSettings(patch: Partial<OfficeSettings>): OfficeSettings {
  if (patch.provider) {
    settings.provider = { ...settings.provider, ...patch.provider };
    delete (patch as any).provider;
  }
  settings = { ...settings, ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));
  bus.broadcast({ type: 'settings', settings });
  return settings;
}
