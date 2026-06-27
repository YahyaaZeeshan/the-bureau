import { useEffect } from 'react';
import { OfficeCanvas } from './game/OfficeCanvas.js';
import { TopBar, SettingsModal } from './ui/TopBar.js';
import { Dock, PersonaModal } from './ui/Dock.js';
import { CharacterMenu, ApprovalToasts, UploadDialog } from './ui/Overlays.js';
import { connectWs } from './ws.js';
import { useStore } from './state.js';
import { api } from './api.js';

export function App() {
  const deliverablesVersion = useStore((s) => s.deliverablesVersion);
  const connected = useStore((s) => s.connected);
  useEffect(() => {
    connectWs();
  }, []);
  // keep the pending-review badge fresh
  useEffect(() => {
    api
      .deliverables()
      .then((items: { status: string }[]) =>
        useStore.getState().set({ pendingCount: items.filter((i) => i.status === 'pending').length }),
      )
      .catch(() => undefined);
  }, [deliverablesVersion]);

  return (
    <div className="app">
      {!connected && (
        <div className="disconnect-banner">
          ⚠️ Disconnected from the office server — reconnecting… If this persists, the server stopped:
          run <code>npm run dev</code> (or Start Office.bat) in the project folder. You can still pan and look around.
        </div>
      )}
      <TopBar />
      <div className="stage">
        <OfficeCanvas />
        <Dock />
      </div>
      <CharacterMenu />
      <ApprovalToasts />
      <PersonaModal />
      <SettingsModal />
      <UploadDialog />
    </div>
  );
}
