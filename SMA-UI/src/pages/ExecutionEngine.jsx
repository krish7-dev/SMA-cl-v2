import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  submitExecution,
  cancelExecution,
  getExecution,
  listExecutions,
  syncExecutionStatus,
} from '../services/api';
import { useSession } from '../context/SessionContext';
import './ExecutionEngine.css';

const EMPTY_INTENT = {
  symbol: '', exchange: 'NSE', side: 'BUY',
  orderType: 'MARKET', product: 'MIS', quantity: '',
  price: '', triggerPrice: '', validity: 'DAY', tag: '', maxNotional: '',
};

function genIntentId() {
  return `INTENT-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function statusBadge(status) {
  if (!status) return <span className="badge badge-muted">—</span>;
  const s = status.toUpperCase();
  if (s === 'FILLED')                     return <span className="badge badge-success">{status}</span>;
  if (['REJECTED', 'FAILED'].includes(s)) return <span className="badge badge-danger">{status}</span>;
  if (s === 'CANCELLED')                  return <span className="badge badge-muted">{status}</span>;
  if (['PENDING', 'SUBMITTED'].includes(s)) return <span className="badge badge-warning">{status}</span>;
  return <span className="badge badge-muted">{status}</span>;
}

function NoSession() {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '40px 24px' }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>◎</div>
      <h3 style={{ marginBottom: 8 }}>No Active Session</h3>
      <p style={{ color: 'var(--text-muted)', marginBottom: 20 }}>
        Activate a session first — go to Broker Accounts and click <strong>Activate</strong> on an account.
      </p>
      <NavLink to="/accounts" className="btn-primary" style={{ display: 'inline-block' }}>
        Go to Broker Accounts
      </NavLink>
    </div>
  );
}

function ExecutionDetailCard({ record, onSync }) {
  const rows = [
    ['Intent ID',              record.intentId],
    ['Broker Client Order ID', record.brokerClientOrderId || '—'],
    ['Broker Order ID',        record.brokerOrderId || '—'],
    ['User ID',                record.userId],
    ['Broker',                 record.brokerName],
    ['Symbol',                 record.symbol],
    ['Exchange',               record.exchange],
    ['Side',                   record.side],
    ['Order Type',             record.orderType],
    ['Product',                record.product],
    ['Quantity',               record.quantity],
    ['Price',                  record.price ? `₹${record.price}` : '—'],
    ['Trigger Price',          record.triggerPrice ? `₹${record.triggerPrice}` : '—'],
    ['Validity',               record.validity || '—'],
    ['Tag',                    record.tag || '—'],
    ['Status',                 statusBadge(record.status)],
    ['Error',                  record.errorMessage || '—'],
    ['Created At',             record.createdAt ? new Date(record.createdAt).toLocaleString() : '—'],
    ['Updated At',             record.updatedAt ? new Date(record.updatedAt).toLocaleString() : '—'],
  ];
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 className="section-title" style={{ margin: 0 }}>Execution Record</h3>
        {onSync && (
          <button className="btn-secondary btn-sm" onClick={() => onSync(record.intentId)}>
            Sync Status
          </button>
        )}
      </div>
      <table>
        <tbody>
          {rows.map(([key, val]) => (
            <tr key={key}>
              <th style={{ width: '40%', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'none', fontSize: 13, letterSpacing: 0 }}>{key}</th>
              <td>{val}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ExecutionEngine() {
  const { session, isActive } = useSession();
  const [tab, setTab] = useState('submit');

  // Submit
  const [intentForm, setIntentForm]       = useState({ ...EMPTY_INTENT, intentId: genIntentId() });
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitError, setSubmitError]     = useState('');
  const [submitResult, setSubmitResult]   = useState(null);

  // List
  const [listLoading, setListLoading]   = useState(false);
  const [listError, setListError]       = useState('');
  const [execList, setExecList]         = useState(null);
  const [listBroker, setListBroker]     = useState('');

  // Lookup by intentId
  const [lookupId, setLookupId]         = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError]   = useState('');
  const [lookupResult, setLookupResult] = useState(null);

  // Cancel
  const [cancelIntentId, setCancelIntentId]   = useState('');
  const [cancelLoading, setCancelLoading]     = useState(false);
  const [cancelError, setCancelError]         = useState('');
  const [cancelResult, setCancelResult]       = useState(null);

  // Sync
  const [syncIntentId, setSyncIntentId] = useState('');
  const [syncLoading, setSyncLoading]   = useState(false);
  const [syncError, setSyncError]       = useState('');
  const [syncResult, setSyncResult]     = useState(null);

  function handleIntentChange(e) {
    setIntentForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setSubmitError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitError(''); setSubmitResult(null); setSubmitLoading(true);
    try {
      const payload = {
        intentId:   intentForm.intentId,
        userId:     session.userId,
        brokerName: session.brokerName,
        symbol:     intentForm.symbol,
        exchange:   intentForm.exchange,
        side:       intentForm.side,
        orderType:  intentForm.orderType,
        product:    intentForm.product,
        quantity:   parseInt(intentForm.quantity, 10),
        validity:   intentForm.validity || undefined,
        tag:        intentForm.tag || undefined,
        price:        intentForm.price        ? parseFloat(intentForm.price)        : undefined,
        triggerPrice: intentForm.triggerPrice ? parseFloat(intentForm.triggerPrice) : undefined,
        maxNotional:  intentForm.maxNotional  ? parseFloat(intentForm.maxNotional)  : undefined,
      };
      // Strip undefined fields
      Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
      const res = await submitExecution(payload);
      setSubmitResult(res?.data);
      setIntentForm(prev => ({ ...prev, intentId: genIntentId() }));
    } catch (err) { setSubmitError(err.message); }
    finally { setSubmitLoading(false); }
  }

  async function handleListExecutions(e) {
    e.preventDefault();
    setListError(''); setExecList(null); setListLoading(true);
    try {
      const res = await listExecutions(session.userId, listBroker || session.brokerName);
      setExecList(res?.data || []);
    } catch (err) { setListError(err.message); }
    finally { setListLoading(false); }
  }

  async function handleLookup(e) {
    e.preventDefault();
    setLookupError(''); setLookupResult(null); setLookupLoading(true);
    try {
      const res = await getExecution(lookupId);
      setLookupResult(res?.data);
    } catch (err) { setLookupError(err.message); }
    finally { setLookupLoading(false); }
  }

  async function handleCancel(e) {
    e.preventDefault();
    setCancelError(''); setCancelResult(null); setCancelLoading(true);
    try {
      const res = await cancelExecution(cancelIntentId);
      setCancelResult(res?.data);
    } catch (err) { setCancelError(err.message); }
    finally { setCancelLoading(false); }
  }

  async function handleSync(e) {
    e.preventDefault();
    setSyncError(''); setSyncResult(null); setSyncLoading(true);
    try {
      const res = await syncExecutionStatus(syncIntentId);
      setSyncResult(res?.data);
    } catch (err) { setSyncError(err.message); }
    finally { setSyncLoading(false); }
  }

  async function handleSyncFromCard(intentId) {
    setSyncIntentId(intentId);
    setSyncError(''); setSyncResult(null); setSyncLoading(true);
    try {
      const res = await syncExecutionStatus(intentId);
      setSyncResult(res?.data);
      // Refresh lookup result if visible
      if (lookupResult?.intentId === intentId) setLookupResult(res?.data);
    } catch (err) { setSyncError(err.message); }
    finally { setSyncLoading(false); }
  }

  const needsPrice   = ['LIMIT', 'SL'].includes(intentForm.orderType);
  const needsTrigger = ['SL', 'SL_M'].includes(intentForm.orderType);

  const TABS = [
    ['submit',  'Submit Intent'],
    ['list',    'List Executions'],
    ['lookup',  'Lookup by Intent ID'],
    ['cancel',  'Cancel'],
    ['sync',    'Sync Status'],
  ];

  return (
    <div>
      <div className="page-header exec-header">
        <div>
          <h1>Execution Engine</h1>
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

          {/* ── Submit Intent ─────────────────────────────────────────────── */}
          {tab === 'submit' && (
            <div className="card">
              {submitError  && <div className="error-msg">{submitError}</div>}
              {submitResult && (
                <div className="success-msg">
                  Intent submitted — ID: <strong style={{ fontFamily: 'monospace' }}>{submitResult.intentId}</strong>,
                  Status: {statusBadge(submitResult.status)}
                  {submitResult.brokerOrderId && <>, Broker Order ID: <strong>{submitResult.brokerOrderId}</strong></>}
                  {submitResult.errorMessage  && <>, Error: <span style={{ color: 'var(--danger)' }}>{submitResult.errorMessage}</span></>}
                </div>
              )}
              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>Intent ID *</label>
                  <input name="intentId" value={intentForm.intentId} onChange={handleIntentChange} required />
                  <div className="field-hint">Auto-generated idempotency key — submitting the same intent ID twice returns the existing record.</div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Symbol *</label>
                    <input name="symbol" value={intentForm.symbol} onChange={handleIntentChange} placeholder="e.g. RELIANCE, NIFTY25MAYFUT" required />
                  </div>
                  <div className="form-group">
                    <label>Exchange *</label>
                    <select name="exchange" value={intentForm.exchange} onChange={handleIntentChange}>
                      <option value="NSE">NSE</option>
                      <option value="BSE">BSE</option>
                      <option value="NFO">NFO</option>
                      <option value="MCX">MCX</option>
                      <option value="CDS">CDS</option>
                    </select>
                  </div>
                </div>
                <div className="form-row three-col">
                  <div className="form-group">
                    <label>Side *</label>
                    <select name="side" value={intentForm.side} onChange={handleIntentChange}>
                      <option value="BUY">BUY</option>
                      <option value="SELL">SELL</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Order Type *</label>
                    <select name="orderType" value={intentForm.orderType} onChange={handleIntentChange}>
                      <option value="MARKET">MARKET</option>
                      <option value="LIMIT">LIMIT</option>
                      <option value="SL">SL (Stop-Loss Limit)</option>
                      <option value="SL_M">SL-M (Stop-Loss Market)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Product *</label>
                    <select name="product" value={intentForm.product} onChange={handleIntentChange}>
                      <option value="MIS">MIS (Intraday)</option>
                      <option value="CNC">CNC (Delivery)</option>
                      <option value="NRML">NRML (F&amp;O Carry)</option>
                    </select>
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Quantity *</label>
                    <input name="quantity" type="number" min="1" value={intentForm.quantity} onChange={handleIntentChange} placeholder="e.g. 10" required />
                  </div>
                  <div className="form-group">
                    <label>Validity</label>
                    <select name="validity" value={intentForm.validity} onChange={handleIntentChange}>
                      <option value="DAY">DAY</option>
                      <option value="IOC">IOC</option>
                    </select>
                  </div>
                </div>
                {(needsPrice || needsTrigger) && (
                  <div className="form-row">
                    {needsPrice   && <div className="form-group"><label>Price *</label><input name="price" type="number" step="0.05" value={intentForm.price} onChange={handleIntentChange} placeholder="Limit price" /></div>}
                    {needsTrigger && <div className="form-group"><label>Trigger Price *</label><input name="triggerPrice" type="number" step="0.05" value={intentForm.triggerPrice} onChange={handleIntentChange} placeholder="Trigger price" /></div>}
                  </div>
                )}
                <div className="form-row">
                  <div className="form-group">
                    <label>Tag (optional)</label>
                    <input name="tag" value={intentForm.tag} onChange={handleIntentChange} placeholder="e.g. strategy-momentum" />
                  </div>
                  <div className="form-group">
                    <label>Max Notional Override (optional)</label>
                    <input name="maxNotional" type="number" step="0.01" value={intentForm.maxNotional} onChange={handleIntentChange} placeholder="e.g. 100000" />
                    <div className="field-hint">Overrides global risk cap for this intent.</div>
                  </div>
                </div>
                <div className="form-actions">
                  <button type="submit" className="btn-primary" disabled={submitLoading}>{submitLoading ? 'Submitting…' : 'Submit Intent'}</button>
                  <button type="button" className="btn-secondary" onClick={() => { setIntentForm({ ...EMPTY_INTENT, intentId: genIntentId() }); setSubmitResult(null); setSubmitError(''); }}>Reset</button>
                </div>
              </form>
            </div>
          )}

          {/* ── List Executions ───────────────────────────────────────────── */}
          {tab === 'list' && (
            <div>
              <div className="card" style={{ marginBottom: 16 }}>
                {listError && <div className="error-msg">{listError}</div>}
                <form onSubmit={handleListExecutions} style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                  <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                    <label>Broker Filter (optional)</label>
                    <input value={listBroker} onChange={e => setListBroker(e.target.value)} placeholder={`Defaults to ${session.brokerName}`} />
                  </div>
                  <button type="submit" className="btn-primary" disabled={listLoading}>
                    {listLoading ? 'Loading…' : `Load Executions for ${session.userId}`}
                  </button>
                </form>
              </div>
              {execList !== null && (
                <div className="card">
                  {execList.length === 0
                    ? <div className="empty-state"><p>No execution records found.</p></div>
                    : (
                      <div className="exec-table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Intent ID</th>
                              <th>Symbol</th>
                              <th>Type</th>
                              <th>Side</th>
                              <th>Qty</th>
                              <th>Price</th>
                              <th>Status</th>
                              <th>Error</th>
                            </tr>
                          </thead>
                          <tbody>
                            {execList.map(r => (
                              <tr key={r.intentId}>
                                <td className="mono-sm">{r.intentId}</td>
                                <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{r.symbol}</td>
                                <td><span className="badge badge-muted">{r.orderType}</span></td>
                                <td><span className={`badge ${r.side === 'BUY' ? 'badge-success' : 'badge-danger'}`}>{r.side}</span></td>
                                <td>{r.quantity}</td>
                                <td>{r.price ? `₹${r.price}` : '—'}</td>
                                <td>{statusBadge(r.status)}</td>
                                <td className="error-cell">{r.errorMessage || '—'}</td>
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

          {/* ── Lookup by Intent ID ───────────────────────────────────────── */}
          {tab === 'lookup' && (
            <div>
              <div className="card" style={{ marginBottom: 16 }}>
                {lookupError && <div className="error-msg">{lookupError}</div>}
                <form onSubmit={handleLookup} style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                  <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                    <label>Intent ID *</label>
                    <input value={lookupId} onChange={e => setLookupId(e.target.value)} placeholder="INTENT-..." required />
                  </div>
                  <button type="submit" className="btn-primary" disabled={lookupLoading}>{lookupLoading ? 'Fetching…' : 'Lookup'}</button>
                </form>
              </div>
              {lookupResult && <ExecutionDetailCard record={lookupResult} onSync={handleSyncFromCard} />}
              {syncResult && lookupResult?.intentId === syncResult.intentId && (
                <div className="success-msg" style={{ marginTop: 8 }}>Synced — new status: {statusBadge(syncResult.status)}</div>
              )}
            </div>
          )}

          {/* ── Cancel ────────────────────────────────────────────────────── */}
          {tab === 'cancel' && (
            <div className="card">
              {cancelError  && <div className="error-msg">{cancelError}</div>}
              {cancelResult && (
                <div className="success-msg">
                  Cancellation submitted — Status: {statusBadge(cancelResult.status)}
                  {cancelResult.errorMessage && <>, Error: <span style={{ color: 'var(--danger)' }}>{cancelResult.errorMessage}</span></>}
                </div>
              )}
              <form onSubmit={handleCancel}>
                <div className="form-group">
                  <label>Intent ID *</label>
                  <input value={cancelIntentId} onChange={e => setCancelIntentId(e.target.value)} placeholder="INTENT-..." required />
                  <div className="field-hint">Only SUBMITTED orders can be cancelled.</div>
                </div>
                <div className="form-actions">
                  <button type="submit" className="btn-danger" disabled={cancelLoading}>{cancelLoading ? 'Cancelling…' : 'Cancel Intent'}</button>
                </div>
              </form>
            </div>
          )}

          {/* ── Sync Status ───────────────────────────────────────────────── */}
          {tab === 'sync' && (
            <div className="card">
              {syncError  && <div className="error-msg">{syncError}</div>}
              {syncResult && (
                <div style={{ marginBottom: 16 }}>
                  <div className="success-msg" style={{ marginBottom: 12 }}>
                    Status synced — current status: {statusBadge(syncResult.status)}
                  </div>
                  <ExecutionDetailCard record={syncResult} />
                </div>
              )}
              <form onSubmit={handleSync}>
                <div className="form-group">
                  <label>Intent ID *</label>
                  <input value={syncIntentId} onChange={e => setSyncIntentId(e.target.value)} placeholder="INTENT-..." required />
                  <div className="field-hint">Polls Broker Engine to detect fills, rejections, and cancellations.</div>
                </div>
                <div className="form-actions">
                  <button type="submit" className="btn-primary" disabled={syncLoading}>{syncLoading ? 'Syncing…' : 'Sync Status'}</button>
                </div>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}
