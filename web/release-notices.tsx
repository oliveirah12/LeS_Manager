import { useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { currentVersion, releases } from './releases';
import { Modal } from './ui';

const checkEvery = 5 * 60 * 1000;
const seenKey = 'release.seen';
const shownDate = (day: string) => new Date(day + 'T12:00:00').toLocaleDateString('pt-BR');

/** Shows what changed once per version, and offers a reload when the server already runs a newer one. */
export function ReleaseNotices({ read, save }: { read: (key: string) => string | null; save: (key: string, value: string) => void }) {
  const [open, setOpen] = useState(() => read(seenKey) !== currentVersion);
  const [served, setServed] = useState<string>();

  useEffect(() => {
    async function check() {
      try {
        // A static file: it says which version is deployed without touching the API or its data.
        const response = await fetch('/version.json', { cache: 'no-store' });
        if (!response.ok) return;
        const { version } = await response.json() as { version?: unknown };
        if (typeof version === 'string' && version !== currentVersion) setServed(version);
      } catch { /* Offline or in development: the notice simply waits for the next check. */ }
    }
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    void check();
    const timer = setInterval(check, checkEvery);
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, []);

  function close() {
    save(seenKey, currentVersion);
    setOpen(false);
  }

  return <>
    <button type="button" className="btn ghost small" aria-label={'Novidades da versão ' + currentVersion} onClick={() => setOpen(true)}>
      <Sparkles size={15} aria-hidden="true" /><span>v{currentVersion}</span>
    </button>
    {served && <div className="update-banner" role="status">
      <span>A versão {served} está disponível.</span>
      <button type="button" className="btn small" onClick={() => location.reload()}><RefreshCw size={14} aria-hidden="true" />Atualizar</button>
    </div>}
    {open && <Modal title="Novidades" subtitle={'Você está na versão ' + currentVersion} close={close}>
      <div className="stack">
        {releases.map(release => <section className="release" key={release.version}>
          <span className="eyebrow">Versão {release.version} · {shownDate(release.date)}</span>
          <h3>{release.title}</h3>
          <ul>{release.changes.map(change => <li key={change}>{change}</li>)}</ul>
        </section>)}
      </div>
    </Modal>}
  </>;
}
