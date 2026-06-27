import { api } from './api.js';
import { useStore } from './state.js';

/**
 * Open a file picker, upload the chosen file(s) straight into the knowledge base
 * (default audience = everyone), then open the tagging dialog for the first one.
 * `ctx` carries where the upload came from so the dialog can notify the agent/room.
 */
export function pickAndUpload(ctx: { agentId?: string; meeting?: boolean } = {}): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = async () => {
    const files = Array.from(input.files ?? []);
    if (!files.length) return;
    let firstName: string | null = null;
    for (const f of files) {
      try {
        await api.kbUpload(f.name, f, 'all', 'boss');
        if (!firstName) firstName = f.name;
      } catch (e) {
        alert(`Upload failed for ${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (firstName) useStore.getState().set({ uploadDialog: { name: firstName, ...ctx } });
  };
  input.click();
}
