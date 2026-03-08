import { useState, useEffect, useCallback } from 'react';
import { NavLink } from 'react-router-dom';
import {
  createStrategyInstance, listStrategyInstances,
  activateStrategyInstance, deactivateStrategyInstance,
  deleteStrategyInstance, getStrategyTypes,
  evaluateStrategy, getSignalsByInstance, getSignalsBySymbol,
} from '../services/api';
import { useSession } from '../context/SessionContext';
import './StrategyEngine.css';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusBadge(status) {
  if (!status) return <span className="badge badge-muted">—</span>;
  const s = status.toUpperCase();
  if (s === 'ACTIVE')   return <span className="badge badge-success">{status}</span>;
  if (s === 'INACTIVE') return <span className="badge badge-muted">{status}</span>;
  if (s === 'ERROR')    return <span className="badge badge-danger">{status}</span>;
  return <span className="badge badge-muted">{status}</span>;
}

function signalBadge(signal) {
  if (!signal) return <span className="badge badge-muted">—</span>;
  const s = signal.toUpperCase();
  if (s === 'BUY')  return <span className="badge badge-success">BUY</span>;
  if (s === 'SELL') return <span className="badge badge-danger">SELL</span>;
  return <span className="badge badge-muted">HOLD</span>;
}

function execBadge(status) {
  if (!status) return null;
  const s = status.toUpperCase();
  if (s === 'SENT')    return <span className="badge badge-success">SENT</span>;
  if (s === 'FAILED')  return <span className="badge badge-danger">FAILED</span>;
  if (s === 'SKIPPED') return <span className="badge badge-muted">SKIPPED</span>;
  return <span className="badge badge-muted">{status}</span>;
}

const PARAM_DEFS = {
  SMA_CROSSOVER: [
    { key: 'shortPeriod', label: 'Short Period',  placeholder: 'default: 5',  hint: 'Fast SMA lookback (candles)' },
    { key: 'longPeriod',  label: 'Long Period',   placeholder: 'default: 20', hint: 'Slow SMA lookback (candles)' },
  ],
};

/**
 * Client-side catalog enriching backend type keys with human-readable metadata.
 * When new strategy types are added to the backend, add an entry here.
 */
const STRATEGY_CATALOG = {
  SMA_CROSSOVER: {
    label:       'SMA Crossover',
    description: 'Generates buy and sell signals based on two Simple Moving Averages (fast and slow). When the fast SMA crosses above the slow SMA a BUY signal is fired; when it crosses below, a SELL signal is fired.',
    signals: [
      { signal: 'BUY',  condition: 'Short SMA crosses above Long SMA' },
      { signal: 'SELL', condition: 'Short SMA crosses below Long SMA' },
      { signal: 'HOLD', condition: 'No crossover, or warming up (not enough candles yet)' },
    ],
    params: [
      { key: 'shortPeriod', label: 'Short Period', default: '5',  description: 'Number of candles for the fast SMA. Must be less than Long Period.' },
      { key: 'longPeriod',  label: 'Long Period',  default: '20', description: 'Number of candles for the slow SMA. Needs longPeriod + 1 candles to warm up.' },
    ],
    warmup:  'longPeriod + 1 candles',
    state:   'In-memory per instance (resets on service restart)',
  },
};

const EMPTY_FORM = {
  name: '', strategyType: 'SMA_CROSSOVER',
  symbol: '', exchange: 'NSE',
  product: 'MIS', quantity: '', orderType: 'MARKET',
};

const EMPTY_CANDLE = {
  symbol: '', exchange: 'NSE',
  open: '', high: '', low: '', close: '', volume: '',
};

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

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function StrategyEngine() {
  const { session, isActive } = useSession();
  const [tab, setTab] = useState('instances');

  // Instances tab
  const [instances, setInstances]       = useState(null);
  const [instLoading, setInstLoading]   = useState(false);
  const [instError, setInstError]       = useState('');
  const [actionLoading, setActionLoading] = useState('');

  // Create tab
  const [form, setForm]                 = useState({ ...EMPTY_FORM });
  const [params, setParams]             = useState({});
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError]   = useState('');
  const [createResult, setCreateResult] = useState(null);
  const [knownTypes, setKnownTypes]     = useState(['SMA_CROSSOVER']);

  // Evaluate tab
  const [candleForm, setCandleForm]     = useState({ ...EMPTY_CANDLE });
  const [evalLoading, setEvalLoading]   = useState(false);
  const [evalError, setEvalError]       = useState('');
  const [evalResult, setEvalResult]     = useState(null);

  // Signals tab
  const [sigMode, setSigMode]           = useState('instance'); // 'instance' | 'symbol'
  const [sigInstanceId, setSigInstanceId] = useState('');
  const [sigSymbol, setSigSymbol]       = useState('');
  const [sigExchange, setSigExchange]   = useState('NSE');
  const [sigActionable, setSigActionable] = useState(false);
  const [sigLoading, setSigLoading]     = useState(false);
  const [sigError, setSigError]         = useState('');
  const [signals, setSignals]           = useState(null);

  // Load types once
  useEffect(() => {
    getStrategyTypes().then(r => { if (r?.data) setKnownTypes([...r.data].sort()); }).catch(() => {});
  }, []);

  // Load instances when tab becomes active
  const loadInstances = useCallback(async () => {
    if (!isActive) return;
    setInstError(''); setInstLoading(true);
    try {
      const res = await listStrategyInstances(session.userId);
      setInstances(res?.data || []);
    } catch (err) { setInstError(err.message); }
    finally { setInstLoading(false); }
  }, [session, isActive]);

  useEffect(() => {
    if (tab === 'instances') loadInstances();
  }, [tab, loadInstances]);

  // ─── Instances handlers ──────────────────────────────────────────────────

  async function handleActivate(instanceId) {
    setActionLoading(instanceId + ':activate');
    try {
      await activateStrategyInstance(instanceId);
      await loadInstances();
    } catch (err) { setInstError(err.message); }
    finally { setActionLoading(''); }
  }

  async function handleDeactivate(instanceId) {
    setActionLoading(instanceId + ':deactivate');
    try {
      await deactivateStrategyInstance(instanceId);
      await loadInstances();
    } catch (err) { setInstError(err.message); }
    finally { setActionLoading(''); }
  }

  async function handleDelete(instanceId, name) {
    if (!window.confirm(`Delete strategy instance "${name}"?`)) return;
    setActionLoading(instanceId + ':delete');
    try {
      await deleteStrategyInstance(instanceId);
      await loadInstances();
    } catch (err) { setInstError(err.message); }
    finally { setActionLoading(''); }
  }

  // ─── Create handlers ─────────────────────────────────────────────────────

  function handleFormChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setCreateError('');
  }

  function handleParamChange(e) {
    setParams(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  async function handleCreate(e) {
    e.preventDefault();
    setCreateError(''); setCreateResult(null); setCreateLoading(true);
    try {
      const payload = {
        ...form,
        userId: session.userId,
        brokerName: session.brokerName,
        quantity: parseInt(form.quantity, 10),
        parameters: { ...params },
      };
      const res = await createStrategyInstance(payload);
      setCreateResult(res?.data);
      setForm({ ...EMPTY_FORM }); setParams({});
    } catch (err) { setCreateError(err.message); }
    finally { setCreateLoading(false); }
  }

  // ─── Evaluate handlers ───────────────────────────────────────────────────

  async function handleEvaluate(e) {
    e.preventDefault();
    setEvalError(''); setEvalResult(null); setEvalLoading(true);
    try {
      const payload = {
        symbol:   candleForm.symbol.toUpperCase(),
        exchange: candleForm.exchange.toUpperCase(),
        candle: {
          open:   parseFloat(candleForm.open),
          high:   parseFloat(candleForm.high),
          low:    parseFloat(candleForm.low),
          close:  parseFloat(candleForm.close),
          volume: candleForm.volume ? parseInt(candleForm.volume, 10) : 0,
        },
      };
      const res = await evaluateStrategy(payload);
      setEvalResult(res?.data);
    } catch (err) { setEvalError(err.message); }
    finally { setEvalLoading(false); }
  }

  // ─── Signals handlers ────────────────────────────────────────────────────

  async function handleLoadSignals(e) {
    e.preventDefault();
    setSigError(''); setSignals(null); setSigLoading(true);
    try {
      let res;
      if (sigMode === 'instance') {
        res = await getSignalsByInstance(sigInstanceId, sigActionable);
      } else {
        res = await getSignalsBySymbol(sigSymbol, sigExchange);
      }
      setSignals(res?.data || []);
    } catch (err) { setSigError(err.message); }
    finally { setSigLoading(false); }
  }

  // ─── Param fields for current strategy type ──────────────────────────────

  const paramDefs = PARAM_DEFS[form.strategyType] || [];

  const TABS = [
    ['instances', 'My Instances'],
    ['create',    'Create Instance'],
    ['evaluate',  'Evaluate'],
    ['signals',   'Signal History'],
    ['types',     'Strategy Types'],
  ];

  return (
    <div>
      <div className="page-header strategy-header">
        <div>
          <h1>Strategy Engine</h1>
          <p>{isActive ? `${session.userId} · ${session.brokerName}` : 'No active session'}</p>
        </div>
        {isActive && <span className="badge badge-success"><span className="dot dot-success" />Session Active</span>}
      </div>

      {!isActive ? <NoSession /> : (
        <>
          <div className="tabs">
            {TABS.map(([key, label]) => (
              <button key={key} className={`tab-btn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>

          {/* ── My Instances ────────────────────────────────────────────── */}
          {tab === 'instances' && (
            <div>
              <div className="card" style={{ marginBottom: 16 }}>
                {instError && <div className="error-msg">{instError}</div>}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                    {instances ? `${instances.length} instance(s)` : ''}
                  </span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-secondary btn-sm" onClick={loadInstances} disabled={instLoading}>
                      {instLoading ? 'Loading…' : 'Refresh'}
                    </button>
                    <button className="btn-primary btn-sm" onClick={() => setTab('create')}>
                      + Create
                    </button>
                  </div>
                </div>
              </div>

              {instances !== null && (
                instances.length === 0
                  ? <div className="card"><div className="empty-state"><p>No strategy instances yet. Click <strong>Create</strong> to add one.</p></div></div>
                  : instances.map(inst => (
                      <InstanceCard
                        key={inst.instanceId}
                        inst={inst}
                        actionLoading={actionLoading}
                        onActivate={handleActivate}
                        onDeactivate={handleDeactivate}
                        onDelete={handleDelete}
                      />
                    ))
              )}
            </div>
          )}

          {/* ── Create Instance ─────────────────────────────────────────── */}
          {tab === 'create' && (
            <div className="card">
              {createError  && <div className="error-msg">{createError}</div>}
              {createResult && (
                <div className="success-msg">
                  Instance created — ID: <span className="mono-sm">{createResult.instanceId}</span>,
                  Status: {statusBadge(createResult.status)}.
                  &nbsp;<button className="btn-link" onClick={() => { setCreateResult(null); setTab('instances'); }}>View all →</button>
                </div>
              )}
              <form onSubmit={handleCreate}>
                <div className="form-row">
                  <div className="form-group" style={{ flex: 2 }}>
                    <label>Instance Name *</label>
                    <input name="name" value={form.name} onChange={handleFormChange} placeholder="e.g. Reliance SMA Demo" required />
                  </div>
                  <div className="form-group">
                    <label>Strategy Type *</label>
                    <select name="strategyType" value={form.strategyType} onChange={e => { handleFormChange(e); setParams({}); }}>
                      {knownTypes.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Symbol *</label>
                    <input name="symbol" value={form.symbol} onChange={handleFormChange} placeholder="e.g. RELIANCE" required />
                  </div>
                  <div className="form-group">
                    <label>Exchange *</label>
                    <select name="exchange" value={form.exchange} onChange={handleFormChange}>
                      {['NSE','BSE','NFO','MCX','CDS'].map(x => <option key={x} value={x}>{x}</option>)}
                    </select>
                  </div>
                </div>
                <div className="form-row three-col">
                  <div className="form-group">
                    <label>Product *</label>
                    <select name="product" value={form.product} onChange={handleFormChange}>
                      <option value="MIS">MIS (Intraday)</option>
                      <option value="CNC">CNC (Delivery)</option>
                      <option value="NRML">NRML (F&amp;O)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Order Type *</label>
                    <select name="orderType" value={form.orderType} onChange={handleFormChange}>
                      <option value="MARKET">MARKET</option>
                      <option value="LIMIT">LIMIT</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Quantity *</label>
                    <input name="quantity" type="number" min="1" value={form.quantity} onChange={handleFormChange} placeholder="e.g. 10" required />
                  </div>
                </div>

                {paramDefs.length > 0 && (
                  <div className="strategy-params-section">
                    <div className="params-label">{form.strategyType} Parameters</div>
                    <div className="form-row">
                      {paramDefs.map(def => (
                        <div className="form-group" key={def.key}>
                          <label>{def.label}</label>
                          <input
                            name={def.key}
                            value={params[def.key] || ''}
                            onChange={handleParamChange}
                            placeholder={def.placeholder}
                            type="number" min="1"
                          />
                          <div className="field-hint">{def.hint}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="form-actions">
                  <button type="submit" className="btn-primary" disabled={createLoading}>
                    {createLoading ? 'Creating…' : 'Create Instance'}
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => { setForm({ ...EMPTY_FORM }); setParams({}); setCreateResult(null); setCreateError(''); }}>
                    Reset
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* ── Evaluate ────────────────────────────────────────────────── */}
          {tab === 'evaluate' && (
            <div>
              <div className="card" style={{ marginBottom: 16 }}>
                {evalError && <div className="error-msg">{evalError}</div>}
                <p className="section-hint">
                  Feed one OHLCV candle to all <strong>ACTIVE</strong> strategy instances for the given instrument.
                  BUY/SELL signals are automatically forwarded to Execution Engine.
                </p>
                <form onSubmit={handleEvaluate}>
                  <div className="form-row">
                    <div className="form-group">
                      <label>Symbol *</label>
                      <input value={candleForm.symbol} onChange={e => setCandleForm(p => ({ ...p, symbol: e.target.value }))} placeholder="e.g. RELIANCE" required />
                    </div>
                    <div className="form-group">
                      <label>Exchange *</label>
                      <select value={candleForm.exchange} onChange={e => setCandleForm(p => ({ ...p, exchange: e.target.value }))}>
                        {['NSE','BSE','NFO','MCX','CDS'].map(x => <option key={x} value={x}>{x}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="form-row four-col">
                    {[['open','Open *'],['high','High *'],['low','Low *'],['close','Close *']].map(([field, lbl]) => (
                      <div className="form-group" key={field}>
                        <label>{lbl}</label>
                        <input
                          type="number" step="0.05"
                          value={candleForm[field]}
                          onChange={e => setCandleForm(p => ({ ...p, [field]: e.target.value }))}
                          placeholder="Price"
                          required
                        />
                      </div>
                    ))}
                  </div>
                  <div className="form-group" style={{ maxWidth: 200 }}>
                    <label>Volume</label>
                    <input type="number" value={candleForm.volume} onChange={e => setCandleForm(p => ({ ...p, volume: e.target.value }))} placeholder="0" />
                  </div>
                  <div className="form-actions">
                    <button type="submit" className="btn-primary" disabled={evalLoading}>
                      {evalLoading ? 'Evaluating…' : 'Evaluate Candle'}
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => { setCandleForm({ ...EMPTY_CANDLE }); setEvalResult(null); setEvalError(''); }}>
                      Reset
                    </button>
                  </div>
                </form>
              </div>

              {evalResult && <EvaluationResultCard result={evalResult} />}
            </div>
          )}

          {/* ── Signal History ──────────────────────────────────────────── */}
          {tab === 'signals' && (
            <div>
              <div className="card" style={{ marginBottom: 16 }}>
                {sigError && <div className="error-msg">{sigError}</div>}
                <div className="sig-mode-toggle">
                  <button className={`tab-btn ${sigMode === 'instance' ? 'active' : ''}`} onClick={() => setSigMode('instance')}>By Instance ID</button>
                  <button className={`tab-btn ${sigMode === 'symbol'   ? 'active' : ''}`} onClick={() => setSigMode('symbol')}>By Symbol</button>
                </div>
                <form onSubmit={handleLoadSignals} style={{ marginTop: 12 }}>
                  {sigMode === 'instance' ? (
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div className="form-group" style={{ flex: 1, marginBottom: 0, minWidth: 260 }}>
                        <label>Instance ID *</label>
                        <input value={sigInstanceId} onChange={e => setSigInstanceId(e.target.value)} placeholder="UUID of strategy instance" required />
                      </div>
                      <label className="checkbox-label">
                        <input type="checkbox" checked={sigActionable} onChange={e => setSigActionable(e.target.checked)} />
                        BUY/SELL only
                      </label>
                      <button type="submit" className="btn-primary" disabled={sigLoading}>{sigLoading ? 'Loading…' : 'Load Signals'}</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                        <label>Symbol *</label>
                        <input value={sigSymbol} onChange={e => setSigSymbol(e.target.value)} placeholder="e.g. RELIANCE" required />
                      </div>
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label>Exchange *</label>
                        <select value={sigExchange} onChange={e => setSigExchange(e.target.value)}>
                          {['NSE','BSE','NFO','MCX','CDS'].map(x => <option key={x} value={x}>{x}</option>)}
                        </select>
                      </div>
                      <button type="submit" className="btn-primary" disabled={sigLoading}>{sigLoading ? 'Loading…' : 'Load Signals'}</button>
                    </div>
                  )}
                </form>
              </div>

              {signals !== null && (
                <div className="card">
                  {signals.length === 0
                    ? <div className="empty-state"><p>No signals found.</p></div>
                    : (
                      <div className="sig-table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Time</th>
                              <th>Signal</th>
                              <th>Symbol</th>
                              <th>Close</th>
                              <th>Execution</th>
                              <th>Intent ID</th>
                              <th>Reason</th>
                            </tr>
                          </thead>
                          <tbody>
                            {signals.map(s => (
                              <tr key={s.signalId}>
                                <td className="mono-sm">{s.createdAt ? new Date(s.createdAt).toLocaleString() : '—'}</td>
                                <td>{signalBadge(s.signal)}</td>
                                <td style={{ fontWeight: 600 }}>{s.symbol}</td>
                                <td>{s.candleClose ? `₹${s.candleClose}` : '—'}</td>
                                <td>{execBadge(s.executionStatus)}</td>
                                <td className="mono-sm">{s.intentId || '—'}</td>
                                <td className="reason-cell">{s.meta ? <MetaTooltip meta={s.meta} reason={s.signal} /> : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                </div>
              )}
            </div>
          )}
          {/* ── Strategy Types ─────────────────────────────────────────── */}
          {tab === 'types' && (
            <div>
              <div className="card types-intro">
                <span className="types-count">{knownTypes.length}</span>
                <span className="types-count-label">strategy type{knownTypes.length !== 1 ? 's' : ''} registered in the engine</span>
              </div>
              {knownTypes.map(type => {
                const meta = STRATEGY_CATALOG[type];
                return (
                  <div key={type} className="card strategy-type-card">
                    <div className="type-card-header">
                      <div>
                        <span className="type-name">{meta ? meta.label : type}</span>
                        <span className="type-key">{type}</span>
                      </div>
                      <button
                        className="btn-primary btn-sm"
                        onClick={() => { setForm(prev => ({ ...prev, strategyType: type })); setParams({}); setTab('create'); }}
                      >
                        Use this →
                      </button>
                    </div>

                    {meta ? (
                      <>
                        <p className="type-description">{meta.description}</p>

                        <div className="type-section-label">Signal Rules</div>
                        <div className="signal-rules">
                          {meta.signals.map(s => (
                            <div key={s.signal} className="signal-rule">
                              <span className={`signal-rule-badge ${s.signal.toLowerCase()}`}>{s.signal}</span>
                              <span className="signal-rule-text">{s.condition}</span>
                            </div>
                          ))}
                        </div>

                        <div className="type-section-label" style={{ marginTop: 16 }}>Parameters</div>
                        <table className="params-table">
                          <thead>
                            <tr>
                              <th>Parameter</th>
                              <th>Default</th>
                              <th>Description</th>
                            </tr>
                          </thead>
                          <tbody>
                            {meta.params.map(p => (
                              <tr key={p.key}>
                                <td><code>{p.key}</code></td>
                                <td><code>{p.default}</code></td>
                                <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{p.description}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        <div className="type-meta-row">
                          <span><span className="meta-label">Warmup</span> {meta.warmup}</span>
                          <span><span className="meta-label">State</span> {meta.state}</span>
                        </div>
                      </>
                    ) : (
                      <p className="type-description" style={{ color: 'var(--text-muted)' }}>
                        No documentation available for this strategy type.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function InstanceCard({ inst, actionLoading, onActivate, onDeactivate, onDelete }) {
  const isLoading = (suffix) => actionLoading === inst.instanceId + ':' + suffix;
  const anyLoading = actionLoading.startsWith(inst.instanceId);

  return (
    <div className={`card instance-card ${inst.status === 'ACTIVE' ? 'instance-active' : ''}`}>
      <div className="instance-header">
        <div>
          <span className="instance-name">{inst.name}</span>
          <span className="instance-type">{inst.strategyType}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {statusBadge(inst.status)}
          {inst.status !== 'ACTIVE' && (
            <button className="btn-primary btn-sm" onClick={() => onActivate(inst.instanceId)} disabled={anyLoading}>
              {isLoading('activate') ? '…' : 'Activate'}
            </button>
          )}
          {inst.status === 'ACTIVE' && (
            <button className="btn-secondary btn-sm" onClick={() => onDeactivate(inst.instanceId)} disabled={anyLoading}>
              {isLoading('deactivate') ? '…' : 'Deactivate'}
            </button>
          )}
          <button className="btn-danger btn-sm" onClick={() => onDelete(inst.instanceId, inst.name)} disabled={anyLoading}>
            {isLoading('delete') ? '…' : 'Delete'}
          </button>
        </div>
      </div>
      <div className="instance-meta">
        <span><span className="meta-label">Symbol</span> {inst.symbol} / {inst.exchange}</span>
        <span><span className="meta-label">Product</span> {inst.product}</span>
        <span><span className="meta-label">Qty</span> {inst.quantity}</span>
        <span><span className="meta-label">Order</span> {inst.orderType}</span>
        {inst.parameters && Object.keys(inst.parameters).length > 0 && (
          <span>
            <span className="meta-label">Params</span>{' '}
            {Object.entries(inst.parameters).map(([k, v]) => `${k}=${v}`).join(', ')}
          </span>
        )}
      </div>
      <div className="instance-id">ID: {inst.instanceId}</div>
    </div>
  );
}

function EvaluationResultCard({ result }) {
  return (
    <div className="card">
      <div className="eval-summary">
        <div className="eval-stat">
          <span className="eval-stat-val">{result.evaluatedInstances}</span>
          <span className="eval-stat-label">Evaluated</span>
        </div>
        <div className="eval-stat">
          <span className="eval-stat-val" style={{ color: result.actionableSignals > 0 ? 'var(--accent)' : undefined }}>
            {result.actionableSignals}
          </span>
          <span className="eval-stat-label">Actionable</span>
        </div>
        <div className="eval-stat">
          <span className="eval-stat-val">{result.symbol} / {result.exchange}</span>
          <span className="eval-stat-label">Instrument</span>
        </div>
      </div>

      {result.signals && result.signals.length > 0 && (
        <table style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>Instance</th>
              <th>Signal</th>
              <th>Execution</th>
              <th>Intent ID</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {result.signals.map(s => (
              <tr key={s.instanceId}>
                <td>
                  <div style={{ fontWeight: 600 }}>{s.instanceName}</div>
                  <div className="mono-sm" style={{ marginTop: 2 }}>{s.strategyType}</div>
                </td>
                <td>{signalBadge(s.signal)}</td>
                <td>{s.executionStatus
                  ? <span className={`badge ${s.executionStatus === 'SENT' ? 'badge-success' : s.executionStatus === 'FAILED' ? 'badge-danger' : 'badge-muted'}`}>{s.executionStatus}</span>
                  : '—'}
                </td>
                <td className="mono-sm">{s.intentId || '—'}</td>
                <td className="reason-cell">{s.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MetaTooltip({ meta, reason }) {
  let parsed = null;
  try { parsed = JSON.parse(meta); } catch (_) {}
  if (!parsed) return <span>{reason}</span>;
  const entries = Object.entries(parsed).slice(0, 4);
  return (
    <span className="meta-tooltip-wrap" title={entries.map(([k,v]) => `${k}: ${v}`).join(' | ')}>
      {entries.map(([k, v]) => (
        <span key={k} className="meta-chip">
          {k}: {typeof v === 'number' ? v.toFixed(2) : v}
        </span>
      ))}
    </span>
  );
}
