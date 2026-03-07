import { useState } from 'react';
import { getPositions, getMargins } from '../services/api';
import './Portfolio.css';

export default function Portfolio() {
  const [userId, setUserId]           = useState('');
  const [brokerName, setBrokerName]   = useState('kite');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [positions, setPositions]     = useState(null);
  const [margins, setMargins]         = useState(null);
  const [activeTab, setActiveTab]     = useState('positions');

  async function fetchPortfolio(e) {
    e.preventDefault();
    setError('');
    setPositions(null);
    setMargins(null);
    setLoading(true);
    try {
      const [posRes, marRes] = await Promise.all([
        getPositions(userId, brokerName),
        getMargins(userId, brokerName),
      ]);
      setPositions(posRes?.data || []);
      setMargins(marRes?.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function pnlClass(val) {
    const n = parseFloat(val);
    if (isNaN(n) || n === 0) return '';
    return n > 0 ? 'pnl-positive' : 'pnl-negative';
  }

  function fmt(val, prefix = '₹') {
    const n = parseFloat(val);
    if (isNaN(n)) return '—';
    return `${prefix}${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  return (
    <div>
      <div className="page-header">
        <h1>Portfolio</h1>
        <p>View live positions and margin utilization for a broker account.</p>
      </div>

      <div className="card query-card">
        {error && <div className="error-msg">{error}</div>}
        <form onSubmit={fetchPortfolio}>
          <div className="form-row" style={{ alignItems: 'flex-end', marginBottom: 0 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>User ID *</label>
              <input value={userId} onChange={e => setUserId(e.target.value)} placeholder="e.g. user123" required />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Broker</label>
              <select value={brokerName} onChange={e => setBrokerName(e.target.value)}>
                <option value="kite">Kite (Zerodha)</option>
              </select>
            </div>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Fetching…' : 'Fetch Portfolio'}
            </button>
          </div>
        </form>
      </div>

      {(positions !== null || margins !== null) && (
        <>
          <div className="tabs" style={{ marginTop: 20 }}>
            <button className={`tab-btn ${activeTab === 'positions' ? 'active' : ''}`} onClick={() => setActiveTab('positions')}>
              Positions {positions ? `(${positions.length})` : ''}
            </button>
            <button className={`tab-btn ${activeTab === 'margins' ? 'active' : ''}`} onClick={() => setActiveTab('margins')}>
              Margins {margins ? `(${margins.length})` : ''}
            </button>
          </div>

          {activeTab === 'positions' && positions !== null && (
            <div className="card">
              {positions.length === 0
                ? <div className="empty-state"><p>No open positions.</p></div>
                : (
                  <>
                    <div className="positions-summary">
                      <SummaryTile
                        label="Total P&L"
                        value={fmt(positions.reduce((acc, p) => acc + parseFloat(p.pnl || 0), 0))}
                        cls={pnlClass(positions.reduce((acc, p) => acc + parseFloat(p.pnl || 0), 0))}
                      />
                      <SummaryTile
                        label="Unrealised P&L"
                        value={fmt(positions.reduce((acc, p) => acc + parseFloat(p.unrealisedPnl || 0), 0))}
                        cls={pnlClass(positions.reduce((acc, p) => acc + parseFloat(p.unrealisedPnl || 0), 0))}
                      />
                      <SummaryTile
                        label="Realised P&L"
                        value={fmt(positions.reduce((acc, p) => acc + parseFloat(p.realisedPnl || 0), 0))}
                        cls={pnlClass(positions.reduce((acc, p) => acc + parseFloat(p.realisedPnl || 0), 0))}
                      />
                      <SummaryTile label="Open Positions" value={positions.filter(p => p.quantity !== 0).length} />
                    </div>
                    <table>
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th>Exchange</th>
                          <th>Product</th>
                          <th>Qty</th>
                          <th>Avg Price</th>
                          <th>Last Price</th>
                          <th>P&L</th>
                          <th>Unrealised</th>
                          <th>Realised</th>
                        </tr>
                      </thead>
                      <tbody>
                        {positions.map((p, i) => (
                          <tr key={i}>
                            <td style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{p.symbol}</td>
                            <td><span className="badge badge-muted">{p.exchange}</span></td>
                            <td><span className="badge badge-info">{p.product}</span></td>
                            <td style={{ color: p.quantity > 0 ? 'var(--success)' : p.quantity < 0 ? 'var(--danger)' : 'var(--text-muted)', fontWeight: 700 }}>
                              {p.quantity}
                            </td>
                            <td>{fmt(p.averagePrice)}</td>
                            <td>{fmt(p.lastPrice)}</td>
                            <td className={pnlClass(p.pnl)}>{fmt(p.pnl)}</td>
                            <td className={pnlClass(p.unrealisedPnl)}>{fmt(p.unrealisedPnl)}</td>
                            <td className={pnlClass(p.realisedPnl)}>{fmt(p.realisedPnl)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
            </div>
          )}

          {activeTab === 'margins' && margins !== null && (
            <div>
              {margins.length === 0
                ? <div className="card"><div className="empty-state"><p>No margin data available.</p></div></div>
                : margins.map((m, i) => (
                  <div key={i} className="card margin-card">
                    <div className="margin-segment">
                      <span className="badge badge-info" style={{ textTransform: 'capitalize' }}>{m.segment}</span>
                    </div>
                    <div className="margin-grid">
                      <MarginTile label="Net Balance" value={fmt(m.net)} />
                      <MarginTile label="Available Cash" value={fmt(m.available)} />
                      <MarginTile label="Payin (Intraday)" value={fmt(m.payin)} />
                      <MarginTile label="Utilised (Debits)" value={fmt(m.utilised)} highlight />
                    </div>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SummaryTile({ label, value, cls }) {
  return (
    <div className="summary-tile">
      <div className={`tile-value ${cls || ''}`}>{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

function MarginTile({ label, value, highlight }) {
  return (
    <div className={`margin-tile ${highlight ? 'highlight' : ''}`}>
      <div className="margin-tile-label">{label}</div>
      <div className="margin-tile-value">{value}</div>
    </div>
  );
}
