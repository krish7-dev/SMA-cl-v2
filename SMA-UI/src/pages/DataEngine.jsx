import { useState, useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import {
  fetchHistoricalData,
  liveSubscribe, liveUnsubscribe, liveDisconnect, liveStatus,
  startReplay, stopReplay, getReplayStatus,
} from '../services/api';
import { useSession } from '../context/SessionContext';
import './DataEngine.css';

const INTERVALS = [
  { value: 'MINUTE_1',  label: '1 min' },
  { value: 'MINUTE_3',  label: '3 min' },
  { value: 'MINUTE_5',  label: '5 min' },
  { value: 'MINUTE_10', label: '10 min' },
  { value: 'MINUTE_15', label: '15 min' },
  { value: 'MINUTE_30', label: '30 min' },
  { value: 'MINUTE_60', label: '60 min' },
  { value: 'DAY',       label: 'Day' },
  { value: 'WEEK',      label: 'Week' },
  { value: 'MONTH',     label: 'Month' },
];

const EXCHANGES = ['NSE', 'BSE', 'NFO', 'MCX', 'CDS'];

function toIsoLocal(dtLocal) {
  if (!dtLocal) return undefined;
  return dtLocal.length === 16 ? `${dtLocal}:00` : dtLocal;
}

function replayBadge(status) {
  if (!status) return null;
  const s = status.toUpperCase();
  if (s === 'COMPLETED') return <span className="badge badge-success">{status}</span>;
  if (s === 'FAILED')    return <span className="badge badge-danger">{status}</span>;
  if (s === 'RUNNING')   return <span className="badge badge-warning">{status}</span>;
  if (s === 'STOPPED')   return <span className="badge badge-muted">{status}</span>;
  return <span className="badge badge-info">{status}</span>;
}

function NoSession() {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>◎</div>
      <h3 style={{ marginBottom: 8 }}>No Active Session</h3>
      <p style={{ color: 'var(--text-muted)', marginBottom: 20 }}>
        Activate a session first — go to Broker Accounts and click <strong>Activate</strong>.
      </p>
      <NavLink to="/accounts" className="btn-primary" style={{ display: 'inline-block' }}>
        Go to Broker Accounts
      </NavLink>
    </div>
  );
}

// ─── Candlestick Chart ────────────────────────────────────────────────────────

function CandleChart({ candles }) {
  if (!candles || candles.length === 0) return null;
  const W = 800, H = 260;
  const PAD = { t: 12, r: 12, b: 36, l: 64 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  const highs  = candles.map(c => parseFloat(c.high));
  const lows   = candles.map(c => parseFloat(c.low));
  const maxP   = Math.max(...highs);
  const minP   = Math.min(...lows);
  const range  = maxP - minP || 1;

  const scaleY  = val => PAD.t + plotH - ((val - minP) / range) * plotH;
  const colW    = plotW / candles.length;
  const barW    = Math.max(1, Math.min(10, colW - 2));
  const scaleX  = i => PAD.l + (i + 0.5) * colW;

  const priceTicks = Array.from({ length: 5 }, (_, i) => {
    const val = minP + (range * i) / 4;
    return { val, y: scaleY(val) };
  });
  const dateStep = Math.max(1, Math.floor(candles.length / 6));

  return (
    <div className="de-chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {priceTicks.map(({ val, y }, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y} y2={y}
              stroke="var(--border)" strokeDasharray="3 5" strokeWidth="1" />
            <text x={PAD.l - 6} y={y + 4} textAnchor="end" fontSize="10" fill="var(--text-muted)">
              {val.toFixed(2)}
            </text>
          </g>
        ))}
        {candles.map((c, i) => {
          const x     = scaleX(i);
          const open  = parseFloat(c.open);
          const close = parseFloat(c.close);
          const high  = parseFloat(c.high);
          const low   = parseFloat(c.low);
          const bull  = close >= open;
          const color = bull ? 'var(--success)' : 'var(--danger)';
          const bodyT = scaleY(Math.max(open, close));
          const bodyH = Math.max(1, scaleY(Math.min(open, close)) - bodyT);
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={scaleY(high)} y2={scaleY(low)} stroke={color} strokeWidth="1" />
              <rect x={x - barW / 2} y={bodyT} width={barW} height={bodyH} fill={color} />
            </g>
          );
        })}
        {candles.map((c, i) => {
          if (i % dateStep !== 0) return null;
          const label = c.openTime ? String(c.openTime).slice(0, 10) : '';
          return (
            <text key={i} x={scaleX(i)} y={H - 6} textAnchor="middle" fontSize="9" fill="var(--text-muted)">
              {label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Historical Data Tab ──────────────────────────────────────────────────────

const HIST_DEFAULTS = {
  instrumentToken: '', symbol: '', exchange: 'NSE',
  interval: 'MINUTE_5', fromDate: '', toDate: '',
  continuous: false, persist: true,
};

function HistoricalTab({ session }) {
  const [form, setForm]       = useState({ ...HIST_DEFAULTS });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [candles, setCandles] = useState(null);

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setForm(p => ({ ...p, [name]: type === 'checkbox' ? checked : value }));
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(''); setCandles(null); setLoading(true);
    try {
      const payload = {
        userId:          session.userId,
        brokerName:      session.brokerName,
        apiKey:          session.apiKey,
        accessToken:     session.accessToken,
        instrumentToken: parseInt(form.instrumentToken, 10),
        symbol:          form.symbol,
        exchange:        form.exchange,
        interval:        form.interval,
        fromDate:        toIsoLocal(form.fromDate),
        toDate:          toIsoLocal(form.toDate),
        continuous:      form.continuous,
        persist:         form.persist,
      };
      const res = await fetchHistoricalData(payload);
      setCandles(res?.data ?? []);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        {error && <div className="error-msg">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-row three-col">
            <div className="form-group">
              <label>Instrument Token *</label>
              <input name="instrumentToken" type="number" value={form.instrumentToken} onChange={handleChange} placeholder="e.g. 738561" required />
            </div>
            <div className="form-group">
              <label>Symbol</label>
              <input name="symbol" value={form.symbol} onChange={handleChange} placeholder="e.g. RELIANCE" />
            </div>
            <div className="form-group">
              <label>Exchange</label>
              <select name="exchange" value={form.exchange} onChange={handleChange}>
                {EXCHANGES.map(ex => <option key={ex} value={ex}>{ex}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row three-col">
            <div className="form-group">
              <label>Interval *</label>
              <select name="interval" value={form.interval} onChange={handleChange}>
                {INTERVALS.map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>From Date *</label>
              <input name="fromDate" type="datetime-local" value={form.fromDate} onChange={handleChange} required />
            </div>
            <div className="form-group">
              <label>To Date *</label>
              <input name="toDate" type="datetime-local" value={form.toDate} onChange={handleChange} required />
            </div>
          </div>
          <div className="de-checkboxes">
            <label className="checkbox-label">
              <input type="checkbox" name="continuous" checked={form.continuous} onChange={handleChange} />
              Continuous contract (futures)
            </label>
            <label className="checkbox-label">
              <input type="checkbox" name="persist" checked={form.persist} onChange={handleChange} />
              Persist to DB (for replay)
            </label>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={loading}>{loading ? 'Fetching…' : 'Fetch Candles'}</button>
            <button type="button" className="btn-secondary" onClick={() => { setForm({ ...HIST_DEFAULTS }); setCandles(null); setError(''); }}>Reset</button>
          </div>
        </form>
      </div>

      {candles !== null && (
        <div className="card">
          <div className="de-result-header">
            <span className="de-result-count">{candles.length} candle{candles.length !== 1 ? 's' : ''} returned</span>
            {candles.length > 0 && (
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Close range: ₹{Math.min(...candles.map(c => parseFloat(c.close))).toFixed(2)}
                {' – '}
                ₹{Math.max(...candles.map(c => parseFloat(c.close))).toFixed(2)}
              </span>
            )}
          </div>
          {candles.length === 0
            ? <div className="empty-state"><p>No candles found for the selected range.</p></div>
            : (
              <>
                <CandleChart candles={candles} />
                <div className="de-table-wrap" style={{ marginTop: 16 }}>
                <table>
                  <thead>
                    <tr><th>Open Time</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th><th>OI</th></tr>
                  </thead>
                  <tbody>
                    {candles.map((c, i) => (
                      <tr key={i}>
                        <td className="de-mono">{c.openTime}</td>
                        <td>{c.open}</td>
                        <td className="text-up">{c.high}</td>
                        <td className="text-down">{c.low}</td>
                        <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{c.close}</td>
                        <td>{c.volume?.toLocaleString()}</td>
                        <td>{c.openInterest ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
        </div>
      )}
    </div>
  );
}

// ─── Live Data Tab ────────────────────────────────────────────────────────────

const EMPTY_INSTRUMENT = { instrumentToken: '', symbol: '', exchange: 'NSE' };

function LiveTab({ session }) {
  const [mode, setMode]             = useState('FULL');
  const [instruments, setInstruments] = useState([{ ...EMPTY_INSTRUMENT }]);
  const [subLoading, setSubLoading] = useState(false);
  const [subError, setSubError]     = useState('');
  const [subResult, setSubResult]   = useState(null);

  const [unsubTokens, setUnsubTokens]     = useState('');
  const [unsubLoading, setUnsubLoading]   = useState(false);
  const [unsubError, setUnsubError]       = useState('');
  const [unsubResult, setUnsubResult]     = useState(null);

  const [connLoading, setConnLoading] = useState(false);
  const [connError, setConnError]     = useState('');
  const [connStatus, setConnStatus]   = useState(null);

  // Auto-poll connection status every 5s while connected
  const pollRef = useRef(null);
  useEffect(() => {
    if (connStatus?.connected) {
      pollRef.current = setInterval(async () => {
        try {
          const res = await liveStatus(session.userId, session.brokerName);
          setConnStatus({ connected: res?.data, message: res?.message });
        } catch (_) {}
      }, 5000);
    } else {
      clearInterval(pollRef.current);
    }
    return () => clearInterval(pollRef.current);
  }, [connStatus?.connected, session.userId, session.brokerName]);

  function addInstrument() { setInstruments(p => [...p, { ...EMPTY_INSTRUMENT }]); }
  function removeInstrument(idx) { setInstruments(p => p.filter((_, i) => i !== idx)); }
  function updateInstrument(idx, field, val) {
    setInstruments(p => p.map((inst, i) => i === idx ? { ...inst, [field]: val } : inst));
  }

  async function handleSubscribe(e) {
    e.preventDefault();
    setSubError(''); setSubResult(null); setSubLoading(true);
    try {
      const res = await liveSubscribe({
        userId:      session.userId,
        brokerName:  session.brokerName,
        apiKey:      session.apiKey,
        accessToken: session.accessToken,
        mode,
        instruments: instruments.map(inst => ({ ...inst, instrumentToken: parseInt(inst.instrumentToken, 10) })),
      });
      setSubResult(res?.data);
    } catch (err) { setSubError(err.message); }
    finally { setSubLoading(false); }
  }

  async function handleUnsubscribe(e) {
    e.preventDefault();
    setUnsubError(''); setUnsubResult(null); setUnsubLoading(true);
    try {
      const tokens = unsubTokens.split(',').map(t => parseInt(t.trim(), 10)).filter(Boolean);
      const res = await liveUnsubscribe({ userId: session.userId, brokerName: session.brokerName, instrumentTokens: tokens });
      setUnsubResult(res?.message);
    } catch (err) { setUnsubError(err.message); }
    finally { setUnsubLoading(false); }
  }

  async function handleDisconnect() {
    setConnError(''); setConnStatus(null); setConnLoading(true);
    try {
      const res = await liveDisconnect(session.userId, session.brokerName);
      setConnStatus({ connected: false, message: res?.message || 'Disconnected' });
    } catch (err) { setConnError(err.message); }
    finally { setConnLoading(false); }
  }

  async function handleCheckStatus() {
    setConnError(''); setConnStatus(null); setConnLoading(true);
    try {
      const res = await liveStatus(session.userId, session.brokerName);
      setConnStatus({ connected: res?.data, message: res?.message });
    } catch (err) { setConnError(err.message); }
    finally { setConnLoading(false); }
  }

  return (
    <div className="de-live-grid">
      {/* Subscribe */}
      <div className="card">
        <h3 className="de-section-title">Subscribe</h3>
        {subError  && <div className="error-msg">{subError}</div>}
        {subResult && <div className="success-msg">Subscribed — {subResult.subscribedCount} instrument(s) active</div>}
        <form onSubmit={handleSubscribe}>
          <div className="form-group">
            <label>Mode</label>
            <select value={mode} onChange={e => setMode(e.target.value)}>
              <option value="LTP">LTP (last price only)</option>
              <option value="QUOTE">QUOTE (market quote)</option>
              <option value="FULL">FULL (full depth)</option>
            </select>
          </div>
          <div className="de-instruments-header">
            <span className="de-instruments-label">Instruments</span>
            <button type="button" className="btn-secondary btn-sm" onClick={addInstrument}>+ Add</button>
          </div>
          {instruments.map((inst, idx) => (
            <div key={idx} className="de-instrument-row">
              <input type="number" placeholder="Token" value={inst.instrumentToken} onChange={e => updateInstrument(idx, 'instrumentToken', e.target.value)} required />
              <input placeholder="Symbol" value={inst.symbol} onChange={e => updateInstrument(idx, 'symbol', e.target.value)} />
              <select value={inst.exchange} onChange={e => updateInstrument(idx, 'exchange', e.target.value)}>
                {EXCHANGES.map(ex => <option key={ex} value={ex}>{ex}</option>)}
              </select>
              {instruments.length > 1 && <button type="button" className="btn-danger btn-sm" onClick={() => removeInstrument(idx)}>✕</button>}
            </div>
          ))}
          <div className="form-actions" style={{ marginTop: 16 }}>
            <button type="submit" className="btn-primary" disabled={subLoading}>{subLoading ? 'Subscribing…' : 'Subscribe'}</button>
          </div>
        </form>
      </div>

      <div className="de-live-right">
        {/* Unsubscribe */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 className="de-section-title">Unsubscribe</h3>
          {unsubError  && <div className="error-msg">{unsubError}</div>}
          {unsubResult && <div className="success-msg">{unsubResult}</div>}
          <form onSubmit={handleUnsubscribe}>
            <div className="form-group">
              <label>Instrument Tokens * (comma-separated)</label>
              <input value={unsubTokens} onChange={e => setUnsubTokens(e.target.value)} placeholder="e.g. 738561, 256265" required />
            </div>
            <div className="form-actions">
              <button type="submit" className="btn-secondary" disabled={unsubLoading}>{unsubLoading ? 'Unsubscribing…' : 'Unsubscribe'}</button>
            </div>
          </form>
        </div>

        {/* Session Control */}
        <div className="card">
          <h3 className="de-section-title">Session Control</h3>
          {connError && <div className="error-msg">{connError}</div>}
          <div className="de-conn-status-box">
            <div className="de-conn-indicator">
              <span className={`de-conn-dot ${connStatus?.connected ? 'de-conn-dot-live' : ''}`} />
              <span className="de-conn-label">
                {connStatus === null ? 'Unknown' : connStatus.connected ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {session.userId} · {session.brokerName}
              {connStatus?.connected && ' — polling every 5s'}
            </span>
          </div>
          {subResult && connStatus?.connected && (
            <div className="de-subscribed-list">
              <div className="de-subscribed-title">Subscribed instruments</div>
              {instruments.map((inst, i) => (
                <div key={i} className="de-subscribed-row">
                  <span className="de-mono">{inst.instrumentToken || '—'}</span>
                  <span>{inst.symbol || '—'}</span>
                  <span className="badge badge-muted">{inst.exchange}</span>
                </div>
              ))}
            </div>
          )}
          <div className="form-actions">
            <button className="btn-secondary" onClick={handleCheckStatus} disabled={connLoading}>{connLoading ? '…' : 'Check Status'}</button>
            <button className="btn-danger"    onClick={handleDisconnect}  disabled={connLoading}>{connLoading ? '…' : 'Disconnect'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Replay Tab ───────────────────────────────────────────────────────────────

const REPLAY_DEFAULTS = {
  instrumentToken: '', symbol: '', exchange: 'NSE',
  interval: 'MINUTE_5', fromDate: '', toDate: '',
  speedMultiplier: 1, provider: 'kite', persist: true,
};

function ReplayTab({ session }) {
  const [form, setForm]                 = useState({ ...REPLAY_DEFAULTS });
  const [startLoading, setStartLoading] = useState(false);
  const [startError, setStartError]     = useState('');
  const [startResult, setStartResult]   = useState(null);

  const [sessionId, setSessionId]     = useState('');
  const [ctrlLoading, setCtrlLoading] = useState(false);
  const [ctrlError, setCtrlError]     = useState('');
  const [ctrlResult, setCtrlResult]   = useState(null);

  // Auto-poll replay status while RUNNING
  const replayPollRef = useRef(null);
  useEffect(() => {
    const isRunning = (ctrlResult?.status || startResult?.status || '').toUpperCase() === 'RUNNING';
    if (isRunning && sessionId) {
      replayPollRef.current = setInterval(async () => {
        try {
          const res = await getReplayStatus(sessionId);
          setCtrlResult(res?.data);
        } catch (_) {}
      }, 2000);
    } else {
      clearInterval(replayPollRef.current);
    }
    return () => clearInterval(replayPollRef.current);
  }, [ctrlResult?.status, startResult?.status, sessionId]);

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setForm(p => ({ ...p, [name]: type === 'checkbox' ? checked : value }));
    setStartError('');
  }

  async function handleStart(e) {
    e.preventDefault();
    setStartError(''); setStartResult(null); setStartLoading(true);
    try {
      const payload = {
        userId:          session.userId,
        brokerName:      session.brokerName,
        apiKey:          session.apiKey,
        accessToken:     session.accessToken,
        instrumentToken: parseInt(form.instrumentToken, 10),
        symbol:          form.symbol,
        exchange:        form.exchange,
        interval:        form.interval,
        fromDate:        toIsoLocal(form.fromDate),
        toDate:          toIsoLocal(form.toDate),
        speedMultiplier: parseInt(form.speedMultiplier, 10),
        provider:        session.brokerName || form.provider,
        persist:         form.persist,
      };
      const res = await startReplay(payload);
      setStartResult(res?.data);
      if (res?.data?.sessionId) setSessionId(res.data.sessionId);
    } catch (err) { setStartError(err.message); }
    finally { setStartLoading(false); }
  }

  async function handleStop() {
    if (!sessionId) return;
    setCtrlError(''); setCtrlResult(null); setCtrlLoading(true);
    try { const res = await stopReplay(sessionId); setCtrlResult(res?.data); }
    catch (err) { setCtrlError(err.message); }
    finally { setCtrlLoading(false); }
  }

  async function handleStatus() {
    if (!sessionId) return;
    setCtrlError(''); setCtrlResult(null); setCtrlLoading(true);
    try { const res = await getReplayStatus(sessionId); setCtrlResult(res?.data); }
    catch (err) { setCtrlError(err.message); }
    finally { setCtrlLoading(false); }
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="de-section-title">Start Replay</h3>
        <p className="de-section-hint">
          Fetches data from broker API on demand (DB cache checked first) and streams it like live data.
          Session credentials are used automatically from your active session.
        </p>
        {startError  && <div className="error-msg">{startError}</div>}
        {startResult && (
          <div className="success-msg">
            Session started — ID: <span className="de-mono">{startResult.sessionId}</span> &nbsp; {replayBadge(startResult.status)} &nbsp; {startResult.totalCandles} candles
          </div>
        )}
        <form onSubmit={handleStart}>
          <div className="form-row three-col">
            <div className="form-group">
              <label>Instrument Token *</label>
              <input name="instrumentToken" type="number" value={form.instrumentToken} onChange={handleChange} placeholder="e.g. 738561" required />
            </div>
            <div className="form-group">
              <label>Symbol</label>
              <input name="symbol" value={form.symbol} onChange={handleChange} placeholder="e.g. RELIANCE" />
            </div>
            <div className="form-group">
              <label>Exchange</label>
              <select name="exchange" value={form.exchange} onChange={handleChange}>
                {EXCHANGES.map(ex => <option key={ex} value={ex}>{ex}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row three-col">
            <div className="form-group">
              <label>Interval *</label>
              <select name="interval" value={form.interval} onChange={handleChange}>
                {INTERVALS.map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>From Date *</label>
              <input name="fromDate" type="datetime-local" value={form.fromDate} onChange={handleChange} required />
            </div>
            <div className="form-group">
              <label>To Date *</label>
              <input name="toDate" type="datetime-local" value={form.toDate} onChange={handleChange} required />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Speed Multiplier (1–100)</label>
              <input name="speedMultiplier" type="number" min="1" max="100" value={form.speedMultiplier} onChange={handleChange} />
              <div className="field-hint">Candles emitted per second.</div>
            </div>
            <div className="form-group">
              <label>Provider</label>
              <select name="provider" value={form.provider} onChange={handleChange}>
                <option value="kite">kite</option>
              </select>
            </div>
          </div>
          <div className="de-checkboxes">
            <label className="checkbox-label">
              <input type="checkbox" name="persist" checked={form.persist} onChange={handleChange} />
              Persist fetched candles to DB
            </label>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={startLoading}>{startLoading ? 'Starting…' : 'Start Replay'}</button>
            <button type="button" className="btn-secondary" onClick={() => { setForm({ ...REPLAY_DEFAULTS }); setStartResult(null); setStartError(''); }}>Reset</button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3 className="de-section-title">Stop / Status</h3>
        {ctrlError  && <div className="error-msg">{ctrlError}</div>}
        {ctrlResult && <ReplayDetail result={ctrlResult} />}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
            <label>Session ID *</label>
            <input value={sessionId} onChange={e => setSessionId(e.target.value)} placeholder="UUID from start response" />
          </div>
          <button className="btn-secondary" onClick={handleStatus} disabled={ctrlLoading || !sessionId}>{ctrlLoading ? '…' : 'Get Status'}</button>
          <button className="btn-danger"    onClick={handleStop}   disabled={ctrlLoading || !sessionId}>{ctrlLoading ? '…' : 'Stop'}</button>
        </div>
      </div>
    </div>
  );
}

function ReplayDetail({ result }) {
  const emitted = result.emittedCandles ?? 0;
  const total   = result.totalCandles   ?? 0;
  const pct     = total > 0 ? Math.round((emitted / total) * 100) : 0;
  const isRunning = (result.status || '').toUpperCase() === 'RUNNING';

  const rows = [
    ['Session ID',       <span className="de-mono" style={{ fontSize: 11 }}>{result.sessionId}</span>],
    ['Status',           replayBadge(result.status)],
    ['Instrument Token', result.instrumentToken],
    ['Symbol',           result.symbol || '—'],
    ['Interval',         result.interval],
    ['From',             result.fromDate],
    ['To',               result.toDate],
    ['Speed',            `${result.speedMultiplier}x`],
    ['Candles Emitted',  `${emitted} / ${total}`],
  ];
  return (
    <div className="de-replay-detail">
      {total > 0 && (
        <div className="de-replay-progress-wrap">
          <div className="de-replay-progress-bar">
            <div
              className={`de-replay-progress-fill ${isRunning ? 'de-replay-progress-animated' : ''}`}
              style={{ width: `${pct}%`, background: isRunning ? 'var(--accent)' : 'var(--success)' }}
            />
          </div>
          <span className="de-replay-pct">{pct}%</span>
        </div>
      )}
      {rows.map(([k, v]) => (
        <div key={k} className="de-replay-row">
          <span className="de-replay-key">{k}</span>
          <span className="de-replay-val">{v}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function DataEngine() {
  const { session, isActive } = useSession();
  const [tab, setTab] = useState('historical');

  return (
    <div>
      <div className="page-header de-page-header">
        <div>
          <h1>Data Engine</h1>
          <p>
            {isActive
              ? `${session.userId} · ${session.brokerName} — historical candles, live data, replay`
              : 'No active session'}
          </p>
        </div>
        {isActive && <span className="badge badge-success"><span className="dot dot-success" />Session Active</span>}
      </div>

      {!isActive ? <NoSession /> : (
        <>
          <div className="tabs">
            {[['historical', 'Historical Data'], ['live', 'Live Data'], ['replay', 'Replay']].map(([key, label]) => (
              <button key={key} className={`tab-btn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'historical' && <HistoricalTab session={session} />}
          {tab === 'live'       && <LiveTab       session={session} />}
          {tab === 'replay'     && <ReplayTab     session={session} />}
        </>
      )}
    </div>
  );
}
