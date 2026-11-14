import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

interface InstallEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const readFlag = (key: string) => { try { return localStorage.getItem('les-manager.' + key) === 'true'; } catch { return false; } };
const saveFlag = (key: string) => { try { localStorage.setItem('les-manager.' + key, 'true'); } catch { /* Kept for this render. */ } };
const standalone = () => matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** A compact install suggestion. Shown until installed or dismissed once. */
export function InstallApp() {
  const [event, setEvent] = useState<InstallEvent>();
  const [help, setHelp] = useState(false);
  const [hidden, setHidden] = useState(() => standalone() || readFlag('installed') || readFlag('install-dismissed'));

  useEffect(() => {
    const capture = (value: Event) => { value.preventDefault(); setEvent(value as InstallEvent); };
    const complete = () => { saveFlag('installed'); setHidden(true); };
    addEventListener('beforeinstallprompt', capture);
    addEventListener('appinstalled', complete);
    return () => { removeEventListener('beforeinstallprompt', capture); removeEventListener('appinstalled', complete); };
  }, []);

  if (hidden) return null;
  function dismiss() { saveFlag('install-dismissed'); setHidden(true); }
  async function install() {
    if (!event) { setHelp(!help); return; }
    try {
      await event.prompt();
      if ((await event.userChoice).outcome === 'accepted') { saveFlag('installed'); setHidden(true); }
    } catch { setHelp(true); }
    finally { setEvent(undefined); }
  }
  return <aside className="install" aria-label="Instalação do aplicativo">
    <img src="/brand.png" alt="" width="36" height="36" />
    <div>
      <strong>Instalar o LeS Manager</strong>
      <small>{help ? 'No Chrome ou Edge, use Instalar no menu. No iPhone, Compartilhar › Adicionar à Tela de Início.' : 'Abra direto da tela inicial.'}</small>
    </div>
    {!help && <button type="button" className="btn small" onClick={install}>Instalar</button>}
    <button type="button" className="icon-button" aria-label="Dispensar" onClick={dismiss}><X size={18} aria-hidden="true" /></button>
  </aside>;
}
