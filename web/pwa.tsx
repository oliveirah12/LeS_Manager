import { useEffect, useState } from 'react';

interface InstallEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallApp() {
  const [event, setEvent] = useState<InstallEvent>();
  const [help, setHelp] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem('les-manager.install-dismissed') === 'true'; } catch { return false; }
  });
  const [installed, setInstalled] = useState(() => matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);

  useEffect(() => {
    const capture = (value: Event) => { value.preventDefault(); setEvent(value as InstallEvent); };
    const complete = () => { setInstalled(true); setEvent(undefined); setHelp(false); };
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', complete);
    return () => {
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', complete);
    };
  }, []);

  if (installed || dismissed) return null;
  function dismiss() {
    setDismissed(true);
    try { sessionStorage.setItem('les-manager.install-dismissed', 'true'); } catch { /* Dismiss for this render. */ }
  }
  async function install() {
    if (!event) { setHelp(!help); return; }
    try {
      await event.prompt();
      if ((await event.userChoice).outcome === 'accepted') setInstalled(true);
    } catch { setHelp(true); }
    finally { setEvent(undefined); }
  }
  return <aside className="install-toast" aria-label="Instalação do aplicativo">
    <div className="install-heading">
      <img src="/brand.png" alt="" width="36" height="36" />
      <div><strong>Instale o LeS Manager</strong><p>Abra o painel direto da tela inicial.</p></div>
      <button type="button" className="icon-close" aria-label="Dispensar instalação" onClick={dismiss}>×</button>
    </div>
    <button type="button" aria-expanded={help} onClick={install}>Instalar aplicativo</button>
    {help && <div className="install-help">
      <p><strong>Chrome ou Edge</strong><br />Procure a opção de instalar o LeS Manager no menu do navegador.</p>
      <p><strong>Safari no iPhone</strong><br />Abra Compartilhar e escolha Adicionar à Tela de Início.</p>
      <button type="button" className="secondary" onClick={() => setHelp(false)}>Ocultar instruções</button>
    </div>}
  </aside>;
}
