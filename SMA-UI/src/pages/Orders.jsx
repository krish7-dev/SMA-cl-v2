import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { placeOrder, getOrder, getOrders, cancelOrder } from '../services/api';
import { useSession } from '../context/SessionContext';
import './Orders.css';

const EMPTY_ORDER = {
  symbol: '', exchange: 'NSE', transactionType: 'BUY',
  orderType: 'MARKET', product: 'MIS', quantity: '',
  price: '', triggerPrice: '', validity: 'DAY', tag: '',
};

function genId() {
  return `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function statusBadge(status) {
  if (!status) return <span className="badge badge-muted">—</span>;
  const s = status.toUpperCase();
  if (['COMPLETE', 'FILLED'].includes(s))                    return <span className="badge badge-success">{status}</span>;
  if (['REJECTED', 'CANCELLED'].includes(s))                 return <span className="badge badge-danger">{status}</span>;
  if (['OPEN', 'PENDING', 'TRIGGER PENDING'].includes(s))    return <span className="badge badge-warning">{status}</span>;
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

export default function Orders() {
  const { session, isActive } = useSession();
  const [tab, setTab] = useState('place');

  // Place order
  const [orderForm, setOrderForm]       = useState({ ...EMPTY_ORDER, clientOrderId: genId() });
  const [placeLoading, setPlaceLoading] = useState(false);
  const [placeError, setPlaceError]     = useState('');
  const [placeResult, setPlaceResult]   = useState(null);

  // Get / List
  const [lookupId, setLookupId]         = useState('');
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError]     = useState('');
  const [singleOrder, setSingleOrder]   = useState(null);
  const [orderList, setOrderList]       = useState(null);

  // Cancel
  const [cancelForm, setCancelForm]       = useState({ clientOrderId: '', variety: 'regular' });
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError]     = useState('');
  const [cancelResult, setCancelResult]   = useState(null);

  function handleOrderChange(e) {
    setOrderForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setPlaceError('');
  }

  async function handlePlaceOrder(e) {
    e.preventDefault();
    setPlaceError(''); setPlaceResult(null); setPlaceLoading(true);
    try {
      const payload = {
        ...orderForm,
        userId:       session.userId,
        brokerName:   session.brokerName,
        quantity:     parseInt(orderForm.quantity, 10),
        price:        orderForm.price        ? parseFloat(orderForm.price)        : undefined,
        triggerPrice: orderForm.triggerPrice ? parseFloat(orderForm.triggerPrice) : undefined,
      };
      if (!payload.price)        delete payload.price;
      if (!payload.triggerPrice) delete payload.triggerPrice;
      if (!payload.tag)          delete payload.tag;
      const res = await placeOrder(payload);
      setPlaceResult(res?.data);
      setOrderForm(prev => ({ ...prev, clientOrderId: genId() }));
    } catch (err) { setPlaceError(err.message); }
    finally { setPlaceLoading(false); }
  }

  async function handleGetOrder(e) {
    e.preventDefault();
    setFetchError(''); setSingleOrder(null); setFetchLoading(true);
    try {
      const res = await getOrder(lookupId);
      setSingleOrder(res?.data);
    } catch (err) { setFetchError(err.message); }
    finally { setFetchLoading(false); }
  }

  async function handleListOrders(e) {
    e.preventDefault();
    setFetchError(''); setOrderList(null); setFetchLoading(true);
    try {
      const res = await getOrders(session.userId, session.brokerName);
      setOrderList(res?.data || []);
    } catch (err) { setFetchError(err.message); }
    finally { setFetchLoading(false); }
  }

  async function handleCancelOrder(e) {
    e.preventDefault();
    setCancelError(''); setCancelResult(null); setCancelLoading(true);
    try {
      const res = await cancelOrder({ ...cancelForm, userId: session.userId, brokerName: session.brokerName });
      setCancelResult(res?.data);
    } catch (err) { setCancelError(err.message); }
    finally { setCancelLoading(false); }
  }

  const needsPrice   = ['LIMIT', 'SL'].includes(orderForm.orderType);
  const needsTrigger = ['SL', 'SL_M'].includes(orderForm.orderType);

  return (
    <div>
      <div className="page-header orders-header">
        <div>
          <h1>Orders</h1>
          <p>{isActive ? `${session.userId} · ${session.brokerName}` : 'No active session'}</p>
        </div>
        {isActive && <span className="badge badge-success"><span className="dot dot-success" />Session Active</span>}
      </div>

      {!isActive ? <NoSession /> : (
        <>
          <div className="tabs">
            {[['place', 'Place Order'], ['status', 'Order Status'], ['list', 'List Orders'], ['cancel', 'Cancel Order']].map(([key, label]) => (
              <button key={key} className={`tab-btn ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>

          {/* ── Place Order ─────────────────────────────────────────────── */}
          {tab === 'place' && (
            <div className="card">
              {placeError  && <div className="error-msg">{placeError}</div>}
              {placeResult && (
                <div className="success-msg">
                  Order submitted — Client ID: <strong>{placeResult.clientOrderId}</strong>,
                  Broker ID: <strong>{placeResult.brokerOrderId}</strong>,
                  Status: {statusBadge(placeResult.status)}
                </div>
              )}
              <form onSubmit={handlePlaceOrder}>
                <div className="form-group">
                  <label>Client Order ID *</label>
                  <input name="clientOrderId" value={orderForm.clientOrderId} onChange={handleOrderChange} required />
                  <div className="field-hint">Auto-generated idempotency key — change if needed.</div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Symbol *</label>
                    <input name="symbol" value={orderForm.symbol} onChange={handleOrderChange} placeholder="e.g. RELIANCE, NIFTY25MAYFUT" required />
                  </div>
                  <div className="form-group">
                    <label>Exchange *</label>
                    <select name="exchange" value={orderForm.exchange} onChange={handleOrderChange}>
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
                    <label>Transaction Type *</label>
                    <select name="transactionType" value={orderForm.transactionType} onChange={handleOrderChange}>
                      <option value="BUY">BUY</option>
                      <option value="SELL">SELL</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Order Type *</label>
                    <select name="orderType" value={orderForm.orderType} onChange={handleOrderChange}>
                      <option value="MARKET">MARKET</option>
                      <option value="LIMIT">LIMIT</option>
                      <option value="SL">SL (Stop-Loss Limit)</option>
                      <option value="SL_M">SL-M (Stop-Loss Market)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Product *</label>
                    <select name="product" value={orderForm.product} onChange={handleOrderChange}>
                      <option value="MIS">MIS (Intraday)</option>
                      <option value="CNC">CNC (Delivery)</option>
                      <option value="NRML">NRML (F&amp;O Carry)</option>
                    </select>
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Quantity *</label>
                    <input name="quantity" type="number" min="1" value={orderForm.quantity} onChange={handleOrderChange} placeholder="e.g. 10" required />
                  </div>
                  <div className="form-group">
                    <label>Validity</label>
                    <select name="validity" value={orderForm.validity} onChange={handleOrderChange}>
                      <option value="DAY">DAY</option>
                      <option value="IOC">IOC</option>
                    </select>
                  </div>
                </div>
                {(needsPrice || needsTrigger) && (
                  <div className="form-row">
                    {needsPrice   && <div className="form-group"><label>Price *</label><input name="price" type="number" step="0.05" value={orderForm.price} onChange={handleOrderChange} placeholder="Limit price" /></div>}
                    {needsTrigger && <div className="form-group"><label>Trigger Price *</label><input name="triggerPrice" type="number" step="0.05" value={orderForm.triggerPrice} onChange={handleOrderChange} placeholder="Trigger price" /></div>}
                  </div>
                )}
                <div className="form-group">
                  <label>Tag (optional)</label>
                  <input name="tag" value={orderForm.tag} onChange={handleOrderChange} placeholder="e.g. strategy-momentum" />
                </div>
                <div className="form-actions">
                  <button type="submit" className="btn-primary" disabled={placeLoading}>{placeLoading ? 'Placing…' : 'Place Order'}</button>
                  <button type="button" className="btn-secondary" onClick={() => { setOrderForm({ ...EMPTY_ORDER, clientOrderId: genId() }); setPlaceResult(null); setPlaceError(''); }}>Reset</button>
                </div>
              </form>
            </div>
          )}

          {/* ── Order Status ─────────────────────────────────────────────── */}
          {tab === 'status' && (
            <div>
              <div className="card" style={{ marginBottom: 16 }}>
                {fetchError && <div className="error-msg">{fetchError}</div>}
                <form onSubmit={handleGetOrder} style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                  <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                    <label>Client Order ID *</label>
                    <input value={lookupId} onChange={e => setLookupId(e.target.value)} placeholder="Client Order ID" required />
                  </div>
                  <button type="submit" className="btn-primary" disabled={fetchLoading}>{fetchLoading ? 'Fetching…' : 'Get Status'}</button>
                </form>
              </div>
              {singleOrder && <OrderDetailCard order={singleOrder} />}
            </div>
          )}

          {/* ── List Orders ──────────────────────────────────────────────── */}
          {tab === 'list' && (
            <div>
              <div className="card" style={{ marginBottom: 16 }}>
                {fetchError && <div className="error-msg">{fetchError}</div>}
                <form onSubmit={handleListOrders} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="btn-primary" disabled={fetchLoading}>
                    {fetchLoading ? 'Loading…' : `Load Orders for ${session.userId}`}
                  </button>
                </form>
              </div>
              {orderList !== null && (
                <div className="card">
                  {orderList.length === 0
                    ? <div className="empty-state"><p>No orders found.</p></div>
                    : (
                      <table>
                        <thead><tr><th>Client Order ID</th><th>Symbol</th><th>Type</th><th>Side</th><th>Qty</th><th>Price</th><th>Status</th></tr></thead>
                        <tbody>
                          {orderList.map(o => (
                            <tr key={o.clientOrderId}>
                              <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{o.clientOrderId}</td>
                              <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{o.symbol}</td>
                              <td><span className="badge badge-muted">{o.orderType}</span></td>
                              <td><span className={`badge ${o.transactionType === 'BUY' ? 'badge-success' : 'badge-danger'}`}>{o.transactionType}</span></td>
                              <td>{o.quantity}</td>
                              <td>{o.price ? `₹${o.price}` : '—'}</td>
                              <td>{statusBadge(o.status)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                </div>
              )}
            </div>
          )}

          {/* ── Cancel Order ─────────────────────────────────────────────── */}
          {tab === 'cancel' && (
            <div className="card">
              {cancelError  && <div className="error-msg">{cancelError}</div>}
              {cancelResult && <div className="success-msg">Cancellation submitted — Status: {statusBadge(cancelResult.status)}</div>}
              <form onSubmit={handleCancelOrder}>
                <div className="form-row">
                  <div className="form-group">
                    <label>Client Order ID *</label>
                    <input value={cancelForm.clientOrderId} onChange={e => setCancelForm(p => ({ ...p, clientOrderId: e.target.value }))} placeholder="Client Order ID to cancel" required />
                  </div>
                  <div className="form-group">
                    <label>Variety</label>
                    <select value={cancelForm.variety} onChange={e => setCancelForm(p => ({ ...p, variety: e.target.value }))}>
                      <option value="regular">regular</option>
                      <option value="amo">amo</option>
                      <option value="co">co</option>
                    </select>
                  </div>
                </div>
                <div className="form-actions">
                  <button type="submit" className="btn-danger" disabled={cancelLoading}>{cancelLoading ? 'Cancelling…' : 'Cancel Order'}</button>
                </div>
              </form>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function OrderDetailCard({ order }) {
  const rows = [
    ['Client Order ID', order.clientOrderId], ['Broker Order ID', order.brokerOrderId],
    ['Symbol', order.symbol], ['Exchange', order.exchange],
    ['Transaction Type', order.transactionType], ['Order Type', order.orderType],
    ['Product', order.product], ['Quantity', order.quantity],
    ['Price', order.price ? `₹${order.price}` : '—'], ['Status', order.status],
    ['Status Message', order.statusMessage || '—'], ['Filled Quantity', order.filledQuantity ?? '—'],
    ['Average Price', order.averagePrice ? `₹${order.averagePrice}` : '—'],
  ];
  return (
    <div className="card">
      <h3 className="section-title">Order Details</h3>
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
