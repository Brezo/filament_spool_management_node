import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import './styles.css';

const STATUS = {
  unassigned: 'Nicht zugeordnet',
  stored: 'Eingelagert',
  in_use: 'In Verwendung',
  archived: 'Archiviert',
};
const BOARDS = [2, 1];
const ACROSS = Array.from({ length: 8 }, (_, index) => index + 1);
const DEPTHS = [1, 2];
const ToastContext = createContext(() => {});

async function api(url, options) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Die Anfrage ist fehlgeschlagen.');
  return payload;
}

function locationKey(location) {
  return location ? `${location.board}-${location.across}-${location.stacked}-${location.deep}` : '';
}

function locationLabel(location) {
  return location ? `B${location.board} · X${location.across} · Y${location.stacked} · D${location.deep}` : '–';
}

function ColorDot({ spool }) {
  return <span className="color-dot" style={{ background: spool.colorHex ? `#${spool.colorHex}` : '#dedede' }} />;
}

function SpoolSummary({ spool, showLocation = true }) {
  return (
    <div className="spool-summary">
      <ColorDot spool={spool} />
      <Link className="strong" to={`/spool/${spool.inventoryId}`}>{spool.inventoryId}</Link>
      <span>{spool.brand} · {spool.material} · {spool.colorName}</span>
      <span className="badge">{STATUS[spool.status]}</span>
      {showLocation && spool.location && <span className="muted">{locationLabel(spool.location)}</span>}
    </div>
  );
}

function AppShell({ children }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <header>
        <button className="icon-button" aria-label="Menü" onClick={() => setMenuOpen(value => !value)}>☰</button>
        <Link to="/" className="brand">Filamentregal</Link>
      </header>
      <div className={`drawer ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
        <Link to="/" className="drawer-title">Filamentregal</Link>
        <NavLink to="/">Regal</NavLink>
        <NavLink to="/spools">Bestand</NavLink>
        <NavLink to="/spool/new">Neue Spule</NavLink>
        <NavLink to="/lookup">QR / ID</NavLink>
        <NavLink to="/archive">Archiv</NavLink>
      </div>
      {menuOpen && <button className="backdrop" aria-label="Menü schließen" onClick={() => setMenuOpen(false)} />}
      <main>{children}</main>
    </>
  );
}

function Page({ title, children, className = '' }) {
  return <div className={`page ${className}`}><h1>{title}</h1>{children}</div>;
}

function ShelfBoard({ board, occupied, onCell }) {
  return (
    <section className="card board">
      <h2>B{board}</h2>
      <div className="shelf-scroll">
        <div className="shelf-grid">
          {DEPTHS.map(deep => (
            <div className="shelf-row" key={deep}>
              <strong className="depth">D{deep}</strong>
              {ACROSS.map(across => {
                const location = { board, across, stacked: 1, deep };
                const spool = occupied.get(locationKey(location));
                return (
                  <button className={`shelf-cell ${spool ? 'occupied' : ''}`} key={across} onClick={() => onCell(location, spool)}>
                    <span className="cell-top"><small>X{across}</small>{spool && <ColorDot spool={spool} />}</span>
                    {spool ? <><strong>{spool.inventoryId}</strong><small>{spool.material} · {spool.colorName}</small></> : <span className="free">Frei</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Modal({ title, children, onClose, wide = false }) {
  useEffect(() => {
    const close = event => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <section className={`modal card ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-heading"><h2>{title}</h2><button className="icon-button dark" onClick={onClose}>×</button></div>
        {children}
      </section>
    </div>
  );
}

function ShelfPage() {
  const navigate = useNavigate();
  const toast = useContext(ToastContext);
  const [spools, setSpools] = useState([]);
  const [destination, setDestination] = useState(null);
  const load = useCallback(() => api('/api/spools').then(setSpools).catch(error => toast(error.message, true)), [toast]);
  useEffect(() => { load(); }, [load]);
  const occupied = useMemo(() => new Map(spools.filter(spool => spool.location).map(spool => [locationKey(spool.location), spool])), [spools]);
  const candidates = spools.filter(spool => ['unassigned', 'in_use'].includes(spool.status));

  async function place(id) {
    try {
      await api(`/api/spools/${id}/move`, { method: 'POST', body: JSON.stringify({ location: destination }) });
      toast(`${id} wurde in ${locationLabel(destination)} eingelagert.`);
      setDestination(null);
      load();
    } catch (error) { toast(error.message, true); }
  }

  return (
    <Page title="Regalübersicht">
      <p className="muted">Bretter sind von unten nach oben nummeriert; D1 liegt hinten, D2 vorne.</p>
      <div className="stack">{BOARDS.map(board => <ShelfBoard key={board} board={board} occupied={occupied} onCell={(location, spool) => spool ? navigate(`/spool/${spool.inventoryId}`) : setDestination(location)} />)}</div>
      {destination && (
        <Modal title={`Spule für ${locationLabel(destination)} auswählen`} onClose={() => setDestination(null)}>
          {candidates.length ? candidates.map(spool => (
            <button className="candidate" key={spool.inventoryId} onClick={() => place(spool.inventoryId)}>
              <SpoolSummary spool={spool} showLocation={false} />
            </button>
          )) : <p>Es gibt keine nicht zugeordneten oder verwendeten Spulen.</p>}
          <div className="actions"><button className="button ghost" onClick={() => setDestination(null)}>Abbrechen</button></div>
        </Modal>
      )}
    </Page>
  );
}

function InventoryPage({ archived = false }) {
  const toast = useContext(ToastContext);
  const [filters, setFilters] = useState({ query: '', status: '', board: '', deep: '' });
  const [spools, setSpools] = useState([]);
  useEffect(() => {
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ archived: String(archived) });
      Object.entries(filters).forEach(([key, value]) => value && query.set(key, value));
      api(`/api/spools?${query}`).then(setSpools).catch(error => toast(error.message, true));
    }, 100);
    return () => clearTimeout(timer);
  }, [filters, archived, toast]);
  const update = event => setFilters(current => ({ ...current, [event.target.name]: event.target.value }));
  return (
    <Page title={archived ? 'Archiv' : 'Aktiver Bestand'}>
      <div className="filters">
        <label className="search-field">Suche<input name="query" value={filters.query} onChange={update} placeholder="ID, Hersteller, Material oder Farbe" /></label>
        {!archived && <label>Zustand<select name="status" value={filters.status} onChange={update}><option value="">Alle Zustände</option>{Object.entries(STATUS).filter(([key]) => key !== 'archived').map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>}
        <label>Brett<select name="board" value={filters.board} onChange={update}><option value="">Alle Bretter</option><option value="1">B1</option><option value="2">B2</option></select></label>
        <label>Tiefe<select name="deep" value={filters.deep} onChange={update}><option value="">Alle Tiefen</option><option value="1">D1</option><option value="2">D2</option></select></label>
      </div>
      <p className="muted">{spools.length} Spule(n)</p>
      <div className="stack">{spools.length ? spools.map(spool => <article className="card" key={spool.inventoryId}><SpoolSummary spool={spool} /></article>) : <p>Keine passenden Spulen gefunden.</p>}</div>
    </Page>
  );
}

function NewSpoolPage() {
  const navigate = useNavigate();
  const toast = useContext(ToastContext);
  const [suggestions, setSuggestions] = useState({ brands: [], materials: [] });
  const [form, setForm] = useState({ brand: '', material: '', colorName: '', colorHex: '#2D2D2D', useColor: false });
  useEffect(() => { api('/api/suggestions').then(setSuggestions).catch(() => {}); }, []);
  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
  async function submit(event) {
    event.preventDefault();
    try {
      const spool = await api('/api/spools', { method: 'POST', body: JSON.stringify({ ...form, colorHex: form.useColor ? form.colorHex : null }) });
      toast(`${spool.inventoryId} wurde angelegt.`);
      navigate(`/spool/${spool.inventoryId}`);
    } catch (error) { toast(error.message, true); }
  }
  return (
    <Page title="Neue Spule" className="narrow">
      <form className="card form" onSubmit={submit}>
        <label>Hersteller *<input required name="brand" list="brands" value={form.brand} onChange={update} /></label>
        <datalist id="brands">{suggestions.brands.map(value => <option value={value} key={value} />)}</datalist>
        <label>Material *<input required name="material" list="materials" value={form.material} onChange={update} /></label>
        <datalist id="materials">{suggestions.materials.map(value => <option value={value} key={value} />)}</datalist>
        <label>Farbbezeichnung *<input required name="colorName" value={form.colorName} onChange={update} /></label>
        <label className="checkbox"><input type="checkbox" name="useColor" checked={form.useColor} onChange={update} /> Hex-Farbe festlegen</label>
        {form.useColor && <label>Farbe<input type="color" name="colorHex" value={form.colorHex} onChange={update} /></label>}
        <button className="button primary" type="submit">＋ Spule anlegen</button>
      </form>
    </Page>
  );
}

function LocationPicker({ spool, spools, onClose, onMoved }) {
  const toast = useContext(ToastContext);
  const [selected, setSelected] = useState(spool.location);
  const occupied = new Map(spools.filter(item => item.location && item.inventoryId !== spool.inventoryId).map(item => [locationKey(item.location), item]));
  async function move() {
    if (!selected) return toast('Bitte eine Zielposition auswählen.', true);
    const occupant = occupied.get(locationKey(selected));
    const action = spool.location ? 'Positionen tauschen' : `${occupant?.inventoryId} auf „In Verwendung“ setzen`;
    if (occupant && !window.confirm(`${locationLabel(selected)} ist durch ${occupant.inventoryId} belegt.\n${action}?`)) return;
    try {
      await api(`/api/spools/${spool.inventoryId}/move`, { method: 'POST', body: JSON.stringify({ location: selected, replaceOccupied: Boolean(occupant) }) });
      toast('Positionen wurden aktualisiert.');
      onMoved();
    } catch (error) { toast(error.message, true); }
  }
  return (
    <Modal title={`${spool.inventoryId} verschieben`} onClose={onClose} wide>
      <p className="muted">Zielposition im Regal auswählen</p>
      <div className="picker-scroll"><div className="picker-grid">{BOARDS.map(board => (
        <section className="card inset" key={board}><h3>B{board}</h3>{DEPTHS.map(deep => (
          <div className="shelf-row" key={deep}><strong className="depth">D{deep}</strong>{ACROSS.map(across => {
            const location = { board, across, stacked: 1, deep };
            const occupant = occupied.get(locationKey(location));
            const current = locationKey(location) === locationKey(spool.location);
            const chosen = locationKey(location) === locationKey(selected);
            return <button key={across} className={`picker-cell ${occupant ? 'occupied' : ''} ${current ? 'current' : ''} ${chosen ? 'selected' : ''}`} onClick={() => setSelected(location)}><small>X{across}</small><strong>{current ? 'Aktuell' : occupant ? 'Belegt' : 'Frei'}</strong></button>;
          })}</div>
        ))}</section>
      ))}</div></div>
      <div className="actions"><strong>{selected ? `Ausgewählt: ${locationLabel(selected)}` : 'Noch keine Position ausgewählt'}</strong><span className="spacer" /><button className="button ghost" onClick={onClose}>Abbrechen</button><button className="button primary" onClick={move}>Übernehmen</button></div>
    </Modal>
  );
}

function SpoolDetailPage() {
  const { inventoryId } = useParams();
  const navigate = useNavigate();
  const toast = useContext(ToastContext);
  const [spool, setSpool] = useState(null);
  const [spools, setSpools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [item, all] = await Promise.all([api(`/api/spools/${inventoryId}`), api('/api/spools')]);
      setSpool(item); setSpools(all);
    } catch (error) { setSpool(null); }
    finally { setLoading(false); }
  }, [inventoryId]);
  useEffect(() => { load(); }, [load]);
  async function setStatus(status) {
    const verb = { unassigned: 'als nicht zugeordnet markieren', in_use: 'als in Verwendung markieren', archived: 'archivieren' }[status];
    if (status !== 'unassigned' || spool.status !== 'archived') {
      if (!window.confirm(`${spool.inventoryId} wirklich ${verb}?`)) return;
    }
    try {
      const updated = await api(`/api/spools/${spool.inventoryId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      toast(status === 'unassigned' && spool.status === 'archived' ? 'Spule wurde wiederhergestellt.' : 'Zustand wurde aktualisiert.');
      if (status === 'archived') navigate('/archive'); else setSpool(updated);
    } catch (error) { toast(error.message, true); }
  }
  if (loading) return <Page title="Spule"><p>Lädt …</p></Page>;
  if (!spool) return <Page title="Spule nicht gefunden"><p>Zu dieser Inventarnummer existiert keine Spule.</p><Link to="/spools">Zum Bestand</Link></Page>;
  return (
    <Page title={spool.inventoryId}>
      <article className="card detail">
        <SpoolSummary spool={spool} />
        <hr />
        <dl><dt>Hersteller</dt><dd>{spool.brand}</dd><dt>Material</dt><dd>{spool.material}</dd><dt>Farbe</dt><dd>{spool.colorName}</dd><dt>Hex-Farbcode</dt><dd>{spool.colorHex ? `#${spool.colorHex}` : '–'}</dd><dt>Position</dt><dd>{locationLabel(spool.location)}</dd></dl>
        <div className="actions">
          {spool.status !== 'archived' ? <>
            <button className="button primary" onClick={() => setMoving(true)}>↔ Einlagern / Verschieben</button>
            <button className="button ghost" onClick={() => setStatus('unassigned')}>Nicht zugeordnet</button>
            <button className="button ghost" onClick={() => setStatus('in_use')}>In Verwendung</button>
            <button className="button danger" onClick={() => setStatus('archived')}>Archivieren</button>
          </> : <button className="button primary" onClick={() => setStatus('unassigned')}>↶ Wiederherstellen</button>}
          <Link className="button ghost" to={`/spool/${spool.inventoryId}/label`}>Etikett</Link>
        </div>
      </article>
      {moving && <LocationPicker spool={spool} spools={spools} onClose={() => setMoving(false)} onMoved={() => { setMoving(false); navigate('/'); }} />}
    </Page>
  );
}

function LabelPage() {
  const { inventoryId } = useParams();
  const [spool, setSpool] = useState(null);
  useEffect(() => { api(`/api/spools/${inventoryId}`).then(setSpool).catch(() => setSpool(null)); }, [inventoryId]);
  if (!spool) return <Page title="Etikett"><p>Spule nicht gefunden.</p></Page>;
  return (
    <div className="label-page">
      <article className="print-label">
        <img src={`/api/spools/${spool.inventoryId}/qr.svg`} alt={`QR-Code ${spool.inventoryId}`} />
        <strong className="label-id">{spool.inventoryId}</strong>
        <strong>{spool.brand} · {spool.material}</strong>
        <span>{spool.colorName}</span>
      </article>
      <div className="actions no-print"><button className="button primary" onClick={() => window.print()}>Drucken</button><Link className="button ghost" to={`/spool/${spool.inventoryId}`}>Zurück</Link></div>
    </div>
  );
}

function LookupPage() {
  const navigate = useNavigate();
  const toast = useContext(ToastContext);
  const [id, setId] = useState('');
  const [file, setFile] = useState(null);
  async function openId(value) {
    const normalized = String(value || '').trim().toUpperCase();
    if (!/^S\d{4,}$/.test(normalized)) return toast('Die Inventarnummer muss dem Format S0001 entsprechen.', true);
    try { await api(`/api/spools/${normalized}`); navigate(`/spool/${normalized}`); }
    catch { toast(`Die Spule ${normalized} wurde nicht gefunden.`, true); }
  }
  async function scan() {
    if (!file) return toast('Bitte zuerst ein Foto auswählen.', true);
    if (!window.Html5Qrcode) return toast('Der QR-Decoder konnte nicht geladen werden.', true);
    const scanner = new window.Html5Qrcode('qr-reader-hidden');
    try { await openId(await scanner.scanFile(file, false)); }
    catch { toast('Auf dem Foto wurde kein lesbarer QR-Code gefunden.', true); }
    finally { try { await scanner.clear(); } catch {} }
  }
  return (
    <Page title="QR-Code oder Inventarnummer suchen" className="narrow">
      <section className="card form">
        <label>Inventarnummer<input value={id} onChange={event => setId(event.target.value)} placeholder="S0001" onKeyDown={event => event.key === 'Enter' && openId(id)} /></label>
        <button className="button primary" onClick={() => openId(id)}>⌕ Suchen</button>
        <hr /><h2>QR-Foto auswählen oder aufnehmen</h2>
        <input type="file" accept="image/*" capture="environment" onChange={event => setFile(event.target.files?.[0] || null)} />
        <div id="qr-reader-hidden" hidden />
        <button className="button primary" onClick={scan}>▣ QR-Foto auswerten</button>
      </section>
    </Page>
  );
}

function Application() {
  const [toast, setToast] = useState(null);
  const notify = useCallback((message, error = false) => {
    setToast({ message, error });
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(null), 4000);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      <AppShell>
        <Routes>
          <Route path="/" element={<ShelfPage />} />
          <Route path="/spools" element={<InventoryPage />} />
          <Route path="/archive" element={<InventoryPage archived />} />
          <Route path="/spool/new" element={<NewSpoolPage />} />
          <Route path="/spool/:inventoryId/label" element={<LabelPage />} />
          <Route path="/spool/:inventoryId" element={<SpoolDetailPage />} />
          <Route path="/lookup" element={<LookupPage />} />
          <Route path="*" element={<Page title="Seite nicht gefunden"><Link to="/">Zur Startseite</Link></Page>} />
        </Routes>
      </AppShell>
      {toast && <div className={`toast ${toast.error ? 'error' : ''}`}>{toast.message}</div>}
    </ToastContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(<BrowserRouter><Application /></BrowserRouter>);
