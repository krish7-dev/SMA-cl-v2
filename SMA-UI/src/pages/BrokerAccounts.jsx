import { useState, useEffect, useCallback } from 'react';
import { listBrokerAccounts, loginBrokerAccount, logoutBrokerAccount, fetchBrokerCredentials } from '../services/api';
import { useSession } from '../context/SessionContext';
import './BrokerAccounts.css';

const EMPTY_FORM = {
  userId: '', clientId: '', brokerName: 'kite',
  apiKey: '', apiSecret: '', requestToken: '',
};

export default function BrokerAccounts() {
  const { session, saveSession, clearSession, isActive } = useSession();

  const [form, setForm]         = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');

  const [accounts, setAccounts]               = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError]     = useState('');

  const [activating, setActivating] = useState(null); // accountId being activated

  const [kiteApiKey, setKiteApiKey] = useState('');
  const kiteLoginUrl = kiteApiKey
    ? `https://kite.trade/connect/login?api_key=${kiteApiKey}&v=3`
    : '';

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
    setError(''); setSuccess('');
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError(''); setSuccess(''); setLoading(true);
    try {
      const res = await loginBrokerAccount(form);
      const data = res?.data;
      saveSession({
        userId:      data?.userId      || form.userId,
        clientId:    data?.clientId    || form.clientId,
        brokerName:  data?.brokerName  || form.brokerName,
        apiKey:      data?.apiKey      || form.apiKey,
        accessToken: data?.accessToken || '',
      });
      setSuccess('Account authenticated. Session is now active.');
      setForm(EMPTY_FORM);
      setShowForm(false);
      await loadAccounts();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleActivate(account) {
    setActivating(account.accountId);
    setError(''); setSuccess('');
    try {
      const res = await fetchBrokerCredentials(account.userId, account.brokerName);
      const data = res?.data;
      saveSession({
        userId:      data.userId,
        clientId:    data.clientId,
        brokerName:  data.brokerName,
        apiKey:      data.apiKey,
        accessToken: data.accessToken || '',
      });
      setSuccess(`Session activated for ${data.userId} (${data.brokerName}).`);
    } catch (err) {
      setError('Activate failed: ' + err.message);
    } finally {
      setActivating(null);
    }
  }

  async function handleLogout(account) {
    if (!window.confirm(`Logout ${account.userId} from ${account.brokerName}?`)) return;
    try {
      await logoutBrokerAccount(account.userId, account.brokerName);
      if (session.userId === account.userId && session.brokerName === account.brokerName) {
        clearSession();
      }
      setSuccess(`Logged out ${account.userId}.`);
      await loadAccounts();
    } catch (err) {
      setError(err.message);
    }
  }

  function statusBadge(status) {
    const map = { ACTIVE: 'badge-success', INACTIVE: 'badge-muted', TOKEN_EXPIRED: 'badge-warning', SUSPENDED: 'badge-danger' };
    return <span className={`badge ${map[status] || 'badge-muted'}`}>{status}</span>;
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Broker Accounts</h1>
          <p>Authenticate once — activate a session to use across all pages without re-entering credentials.</p>
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

      {/* Active Session Banner */}
      {isActive && (
        <div className="success-msg" style={{ marginBottom: 16 }}>
          Active session: <strong>{session.userId}</strong> via <strong>{session.brokerName}</strong>
          <button className="btn-secondary btn-sm" style={{ marginLeft: 12 }} onClick={clearSession}>Clear Session</button>
        </div>
      )}

      {success && <div className="success-msg">{success}</div>}
      {error   && <div className="error-msg">{error}</div>}

      {/* Step 1 — Kite Login URL */}
      <div className="card kite-helper">
        <div className="kite-helper-title">
          <span className="badge badge-warning">Step 1</span>
          <span>Generate Kite Request Token</span>
        </div>
        <p className="section-hint" style={{ marginBottom: 12 }}>
          Enter your API key to build the Kite login URL. After login, Kite redirects to
          <code> localhost:3000/callback</code> which auto-saves your session.
        </p>
        <div className="kite-url-row">
          <div style={{ flex: 1 }}>
            <label>Your Kite API Key</label>
            <input value={kiteApiKey} onChange={e => setKiteApiKey(e.target.value)} placeholder="Paste your API key here" />
          </div>
          {kiteLoginUrl && (
            <a href={kiteLoginUrl} target="_blank" rel="noopener noreferrer" className="btn-primary kite-login-btn">
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

      {/* Step 2 — Manual Login */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="kite-helper-title">
          <span className="badge badge-info">Step 2</span>
          <span>Complete Authentication (manual fallback)</span>
        </div>
        <p className="section-hint" style={{ marginBottom: 0 }}>
          After Kite login you'll land on <code>/callback</code> automatically. Use this only if the redirect didn't work.
        </p>
        {!showForm && (
          <button className="btn-secondary" style={{ marginTop: 12 }} onClick={() => setShowForm(true)}>
            Enter credentials manually
          </button>
        )}
        {showForm && (
          <>
            <hr className="divider" />
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
                <div className="field-hint">Copy the <code>request_token</code> value from your browser's address bar after Kite login.</div>
              </div>
              <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? 'Authenticating…' : 'Authenticate & Activate Session'}
                </button>
                <button type="button" className="btn-secondary" onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}>
                  Cancel
                </button>
              </div>
            </form>
          </>
        )}
      </div>

      {/* Accounts Table */}
      <div className="card">
        <h3 className="section-title">Stored Accounts</h3>
        <p className="section-hint">Click <strong>Activate</strong> on an ACTIVE account to use it as the current session — no credential re-entry needed.</p>

        {accountsError && <div className="error-msg">{accountsError}</div>}

        {accountsLoading ? (
          <div className="empty-state"><p>Loading accounts…</p></div>
        ) : accounts.length === 0 ? (
          <div className="empty-state"><p>No accounts found. Follow Steps 1 and 2 above to authenticate.</p></div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>User ID</th>
                <th>Client ID</th>
                <th>Broker</th>
                <th>Status</th>
                <th>Token Expiry</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map(a => {
                const isCurrentSession = session.userId === a.userId && session.brokerName === a.brokerName;
                return (
                  <tr key={a.accountId} className={isCurrentSession ? 'active-session-row' : ''}>
                    <td style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
                      {a.userId}
                      {isCurrentSession && <span className="badge badge-success" style={{ marginLeft: 8 }}>Active</span>}
                    </td>
                    <td>{a.clientId}</td>
                    <td><span className="badge badge-info">{a.brokerName}</span></td>
                    <td>{statusBadge(a.status)}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {a.tokenExpiry ? new Date(a.tokenExpiry).toLocaleString() : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {a.status === 'ACTIVE' && (
                          <button
                            className="btn-primary btn-sm"
                            disabled={activating === a.accountId}
                            onClick={() => handleActivate(a)}
                          >
                            {activating === a.accountId ? '…' : isCurrentSession ? 'Re-activate' : 'Activate'}
                          </button>
                        )}
                        <button className="btn-danger btn-sm" onClick={() => handleLogout(a)}>
                          Logout
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
