import { useState, useEffect, useCallback, useRef } from 'react';
import { listBrokerAccounts, loginBrokerAccount, logoutBrokerAccount, fetchBrokerCredentials } from '../services/api';
import { useSession } from '../context/SessionContext';
import './BrokerAccounts.css';

const EMPTY_FORM = {
  userId: '', clientId: '', brokerName: 'kite',
  apiKey: '', apiSecret: '', requestToken: '',
};

function isExpired(account) {
  return account.tokenExpiry && new Date(account.tokenExpiry) < new Date();
}

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

  const [activating, setActivating] = useState(null);

  const [kiteApiKey, setKiteApiKey] = useState('');
  const kiteLoginUrl = kiteApiKey
    ? `https://kite.trade/connect/login?api_key=${kiteApiKey}&v=3`
    : '';

  const step1Ref = useRef(null);

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

  // Pre-fill the Kite login URL field from the active session's stored API key
  useEffect(() => {
    if (session.apiKey) setKiteApiKey(session.apiKey);
  }, [session.apiKey]);

  function handleChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setError(''); setSuccess('');
  }

  function openManualForm() {
    // Pre-fill known fields from the active session so the user only needs to paste requestToken
    setForm({
      ...EMPTY_FORM,
      userId:     session.userId     || '',
      clientId:   session.clientId   || '',
      brokerName: session.brokerName || 'kite',
      apiKey:     session.apiKey     || '',
    });
    setShowForm(true);
  }

  async function handleRelogin(account) {
    setError(''); setSuccess('');
    try {
      const res  = await fetchBrokerCredentials(account.userId, account.brokerName);
      const data = res?.data;
      const apiKey = data?.apiKey || '';

      // Pre-fill Step 1 login URL and open Kite login directly
      if (apiKey) {
        setKiteApiKey(apiKey);
        const loginUrl = `https://kite.trade/connect/login?api_key=${apiKey}&v=3`;
        window.open(loginUrl, '_blank', 'noopener,noreferrer');
      }

      // Pre-fill Step 2 manual form so user just pastes the request token
      setForm({
        ...EMPTY_FORM,
        userId:     account.userId,
        clientId:   account.clientId || '',
        brokerName: account.brokerName,
        apiKey,
      });
      setShowForm(true);

      // Scroll to Step 2 (manual form) so user can paste the request token
      step1Ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      setError('Could not load stored credentials: ' + err.message);
    }
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

  function statusBadge(account) {
    if (account.status === 'ACTIVE' && isExpired(account)) {
      return <span className="badge badge-warning">TOKEN EXPIRED</span>;
    }
    const map = { ACTIVE: 'badge-success', INACTIVE: 'badge-muted', SUSPENDED: 'badge-danger' };
    return <span className={`badge ${map[account.status] || 'badge-muted'}`}>{account.status}</span>;
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Broker Accounts</h1>
          <p>Activate a session from your stored accounts — or add a new account below.</p>
        </div>
        <button className="btn-secondary" onClick={loadAccounts} disabled={accountsLoading}>
          {accountsLoading ? 'Loading…' : 'Refresh'}
        </button>
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

      {/* Accounts Table — top so daily re-login is one click */}
      <div className="card">
        <h3 className="section-title">Stored Accounts</h3>
        <p className="section-hint">
          Click <strong>Activate</strong> to use an account as the current session.
          Click <strong>Re-login ↗</strong> on an expired token — it opens Kite login in a new tab and pre-fills the form below.
        </p>

        {accountsError && <div className="error-msg">{accountsError}</div>}

        {accountsLoading ? (
          <div className="empty-state"><p>Loading accounts…</p></div>
        ) : accounts.length === 0 ? (
          <div className="empty-state"><p>No accounts yet. Use the form below to authenticate.</p></div>
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
                    <td>{statusBadge(a)}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {a.tokenExpiry ? new Date(a.tokenExpiry).toLocaleString() : '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {a.status === 'ACTIVE' && isExpired(a) ? (
                          <button className="btn-warning btn-sm" onClick={() => handleRelogin(a)}>
                            Re-login ↗
                          </button>
                        ) : a.status === 'ACTIVE' && (
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

      {/* Step 1 — Kite Login URL */}
      <div className="card kite-helper" style={{ marginTop: 24 }}>
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
      <div className="card" ref={step1Ref} style={{ marginBottom: 16 }}>
        <div className="kite-helper-title">
          <span className="badge badge-info">Step 2</span>
          <span>Complete Authentication</span>
        </div>
        <p className="section-hint" style={{ marginBottom: 0 }}>
          After Kite login you'll land on <code>/callback</code> automatically. Use this form if the redirect didn't work,
          or to paste the <code>request_token</code> manually.
        </p>
        {!showForm && (
          <button className="btn-secondary" style={{ marginTop: 12 }} onClick={openManualForm}>
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
    </div>
  );
}
