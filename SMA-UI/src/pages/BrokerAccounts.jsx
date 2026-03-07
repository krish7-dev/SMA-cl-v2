import { useState, useEffect, useCallback } from 'react';
import { listBrokerAccounts, loginBrokerAccount, logoutBrokerAccount } from '../services/api';
import './BrokerAccounts.css';

const EMPTY_FORM = {
  userId: '',
  clientId: '',
  brokerName: 'kite',
  apiKey: '',
  apiSecret: '',
  requestToken: '',
};

export default function BrokerAccounts() {
  const [form, setForm]         = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');

  // Accounts from DB
  const [accounts, setAccounts]         = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError]     = useState('');

  // Kite login URL helper
  const [kiteApiKey, setKiteApiKey] = useState('');
  const kiteLoginUrl = kiteApiKey
    ? `https://kite.trade/connect/login?api_key=${kiteApiKey}&v=3`
    : '';

  // Logout
  const [logoutUserId, setLogoutUserId]   = useState('');
  const [logoutBroker, setLogoutBroker]   = useState('kite');
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [logoutResult, setLogoutResult]   = useState('');

  const loadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError('');
    try {
      const res = await listBrokerAccounts();
      setAccounts(res?.data || []);
    } catch (err) {
      setAccountsError('Could not load accounts: ' + err.message);
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  function handleChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setError('');
    setSuccess('');
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      await loginBrokerAccount(form);
      setSuccess('Account authenticated successfully. Access token stored securely.');
      setForm(EMPTY_FORM);
      setShowForm(false);
      await loadAccounts(); // refresh from DB
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout(e) {
    e.preventDefault();
    setLogoutResult('');
    setLogoutLoading(true);
    try {
      await logoutBrokerAccount(logoutUserId, logoutBroker);
      setLogoutResult(`success:Logged out ${logoutUserId} from ${logoutBroker}`);
      setLogoutUserId('');
      await loadAccounts(); // refresh from DB
    } catch (err) {
      setLogoutResult(`error:${err.message}`);
    } finally {
      setLogoutLoading(false);
    }
  }

  const [logoutMsg, logoutIsError] = logoutResult.startsWith('error:')
    ? [logoutResult.slice(6), true]
    : [logoutResult.slice(8), false];

  function statusBadge(status) {
    const map = { ACTIVE: 'badge-success', INACTIVE: 'badge-muted', TOKEN_EXPIRED: 'badge-warning', SUSPENDED: 'badge-danger' };
    return <span className={`badge ${map[status] || 'badge-muted'}`}>{status}</span>;
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Broker Accounts</h1>
          <p>Authenticate and manage broker API credentials. Tokens are stored encrypted in the database.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-secondary" onClick={loadAccounts} disabled={accountsLoading}>
            {accountsLoading ? 'Loading…' : 'Refresh'}
          </button>
          <button className="btn-primary" onClick={() => { setShowForm(v => !v); setError(''); setSuccess(''); }}>
            {showForm ? 'Cancel' : '+ Add Account'}
          </button>
        </div>
      </div>

      {success && <div className="success-msg">{success}</div>}

      {/* Kite Login URL Generator */}
      <div className="card kite-helper">
        <div className="kite-helper-title">
          <span className="badge badge-warning">Step 1</span>
          <span>Generate Kite Request Token</span>
        </div>
        <p className="section-hint" style={{ marginBottom: 12 }}>
          Enter your API key to build the Kite login URL. Click it to log in — Kite will redirect to
          <code> localhost:3000/callback</code> with the request token automatically.
        </p>
        <div className="kite-url-row">
          <div style={{ flex: 1 }}>
            <label>Your Kite API Key</label>
            <input
              value={kiteApiKey}
              onChange={e => setKiteApiKey(e.target.value)}
              placeholder="Paste your API key here"
            />
          </div>
          {kiteLoginUrl && (
            <a
              href={kiteLoginUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary kite-login-btn"
            >
              Login with Kite ↗
            </a>
          )}
        </div>
        {kiteLoginUrl && (
          <div className="kite-url-preview">
            <span className="url-label">Login URL</span>
            <span className="url-text">{kiteLoginUrl}</span>
          </div>
        )}
      </div>

      {/* Manual Login Form */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="kite-helper-title">
          <span className="badge badge-info">Step 2</span>
          <span>Complete Authentication (if not auto-redirected)</span>
        </div>
        <p className="section-hint" style={{ marginBottom: 0 }}>
          After Kite login, you'll land on <code>/callback</code> and the form auto-submits.
          If you need to enter the token manually, use the form below.
        </p>
        {!showForm && (
          <button className="btn-secondary" style={{ marginTop: 12 }} onClick={() => setShowForm(true)}>
            Enter credentials manually
          </button>
        )}
        {showForm && (
          <>
            <hr className="divider" />
            {error && <div className="error-msg">{error}</div>}
            <form onSubmit={handleLogin}>
              <div className="form-row">
                <div className="form-group">
                  <label>User ID *</label>
                  <input name="userId" value={form.userId} onChange={handleChange} placeholder="e.g. user123" required />
                </div>
                <div className="form-group">
                  <label>Client ID *</label>
                  <input name="clientId" value={form.clientId} onChange={handleChange} placeholder="e.g. GG4570" required />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Broker *</label>
                  <select name="brokerName" value={form.brokerName} onChange={handleChange}>
                    <option value="kite">Kite (Zerodha)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>API Key *</label>
                  <input name="apiKey" value={form.apiKey} onChange={handleChange} placeholder="Your Kite API key" required />
                </div>
              </div>
              <div className="form-group">
                <label>API Secret *</label>
                <input name="apiSecret" type="password" value={form.apiSecret} onChange={handleChange} placeholder="Your Kite API secret" required />
              </div>
              <div className="form-group">
                <label>Request Token *</label>
                <input name="requestToken" value={form.requestToken} onChange={handleChange} placeholder="One-time token from the OAuth redirect URL" required />
                <div className="field-hint">After Kite login, copy the <code>request_token</code> value from your browser's address bar.</div>
              </div>
              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? 'Authenticating…' : 'Authenticate & Store'}
                </button>
                <button type="button" className="btn-secondary" onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}>
                  Cancel
                </button>
              </div>
            </form>
          </>
        )}
      </div>

      {/* Accounts Table — loaded from DB */}
      <div className="card" style={{ marginBottom: 24 }}>
        <h3 className="section-title">Stored Accounts</h3>
        <p className="section-hint">All broker accounts persisted in the database. Credentials are AES/GCM encrypted at rest.</p>

        {accountsError && <div className="error-msg">{accountsError}</div>}

        {accountsLoading ? (
          <div className="empty-state"><p>Loading accounts…</p></div>
        ) : accounts.length === 0 ? (
          <div className="empty-state"><p>No accounts found. Follow Steps 1 and 2 above to authenticate.</p></div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>User ID</th>
                <th>Client ID</th>
                <th>Broker</th>
                <th>Status</th>
                <th>Token Expiry</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => (
                <tr key={a.accountId}>
                  <td style={{ color: 'var(--text-muted)', fontFamily: 'monospace' }}>{a.accountId}</td>
                  <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{a.userId}</td>
                  <td>{a.clientId}</td>
                  <td><span className="badge badge-info">{a.brokerName}</span></td>
                  <td>{statusBadge(a.status)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                    {a.tokenExpiry ? new Date(a.tokenExpiry).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Logout Panel */}
      <div className="card">
        <h3 className="section-title">Logout Account</h3>
        <p className="section-hint">Invalidate stored access token and mark the account inactive in the database.</p>
        <hr className="divider" />

        {logoutResult && (
          <div className={logoutIsError ? 'error-msg' : 'success-msg'}>{logoutMsg}</div>
        )}

        <form onSubmit={handleLogout}>
          <div className="form-row" style={{ alignItems: 'flex-end' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>User ID *</label>
              <input value={logoutUserId} onChange={e => setLogoutUserId(e.target.value)} placeholder="User ID to logout" required />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>Broker</label>
              <select value={logoutBroker} onChange={e => setLogoutBroker(e.target.value)}>
                <option value="kite">Kite (Zerodha)</option>
              </select>
            </div>
            <div style={{ marginBottom: 0 }}>
              <button type="submit" className="btn-danger" disabled={logoutLoading}>
                {logoutLoading ? 'Logging out…' : 'Logout'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
