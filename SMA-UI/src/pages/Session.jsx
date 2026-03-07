import { useState } from 'react';
import { fetchBrokerCredentials } from '../services/api';
import { useSession } from '../context/SessionContext';
import './Session.css';

export default function Session() {
  const { session, saveSession, clearSession, isActive } = useSession();

  const [form, setForm]       = useState({ ...session });
  const [saved, setSaved]     = useState(false);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError]     = useState('');

  function handleChange(e) {
    setForm(p => ({ ...p, [e.target.name]: e.target.value }));
    setSaved(false);
  }

  function handleSave(e) {
    e.preventDefault();
    saveSession(form);
    setSaved(true);
  }

  async function handleFetchFromServer() {
    if (!form.userId || !form.brokerName) return;
    setFetchError(''); setFetchLoading(true);
    try {
      const res = await fetchBrokerCredentials(form.userId, form.brokerName);
      const data = res?.data;
      const updated = {
        userId:      data.userId,
        clientId:    data.clientId,
        brokerName:  data.brokerName,
        apiKey:      data.apiKey,
        accessToken: data.accessToken || '',
      };
      setForm(updated);
      saveSession(updated);
      setSaved(true);
    } catch (err) {
      setFetchError(err.message);
    } finally {
      setFetchLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Session</h1>
        <p>Credentials stored here are used automatically by every page — no re-entry needed.</p>
      </div>

      {/* Status */}
      <div className={`session-status-card card ${isActive ? 'status-active' : 'status-none'}`}>
        <div className="session-status-row">
          <div>
            <span className={`badge ${isActive ? 'badge-success' : 'badge-muted'}`}>
              <span className={`dot ${isActive ? 'dot-success' : ''}`} />
              {isActive ? 'Session Active' : 'No Active Session'}
            </span>
            {isActive && (
              <span className="session-who">
                {session.userId} · {session.brokerName}
                {session.clientId && ` · ${session.clientId}`}
              </span>
            )}
          </div>
          {isActive && (
            <button className="btn-danger btn-sm" onClick={clearSession}>Clear Session</button>
          )}
        </div>

        {isActive && (
          <div className="session-fields-preview">
            <div className="spf-row">
              <span className="spf-key">API Key</span>
              <span className="spf-val spf-masked">
                {session.apiKey ? `${session.apiKey.slice(0, 4)}••••${session.apiKey.slice(-4)}` : '—'}
              </span>
            </div>
            <div className="spf-row">
              <span className="spf-key">Access Token</span>
              <span className="spf-val spf-masked">
                {session.accessToken ? `${session.accessToken.slice(0, 6)}••••${session.accessToken.slice(-4)}` : '—'}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Configure */}
      <div className="card">
        <h3 className="session-section-title">Configure Session</h3>
        <p className="session-section-hint">
          The easiest way is to login via <strong>Broker Accounts → Login with Kite</strong> — the session is set automatically.
          Use this form to manually update or override.
        </p>

        {fetchError && <div className="error-msg">{fetchError}</div>}
        {saved      && <div className="success-msg">Session saved.</div>}

        <form onSubmit={handleSave}>
          <div className="form-row">
            <div className="form-group">
              <label>User ID *</label>
              <input name="userId" value={form.userId} onChange={handleChange} placeholder="e.g. user123" required />
            </div>
            <div className="form-group">
              <label>Client ID</label>
              <input name="clientId" value={form.clientId} onChange={handleChange} placeholder="e.g. GG4570" />
            </div>
          </div>
          <div className="form-group">
            <label>Broker</label>
            <select name="brokerName" value={form.brokerName} onChange={handleChange}>
              <option value="kite">Kite (Zerodha)</option>
            </select>
          </div>
          <div className="form-group">
            <label>API Key</label>
            <input name="apiKey" value={form.apiKey} onChange={handleChange} placeholder="Kite API key" />
          </div>
          <div className="form-group">
            <label>Access Token</label>
            <input name="accessToken" value={form.accessToken} onChange={handleChange} placeholder="Live access token" />
            <div className="field-hint">Kite access tokens expire daily. Re-login via Broker Accounts to refresh automatically.</div>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn-primary">Save Session</button>
            <button
              type="button"
              className="btn-secondary"
              disabled={fetchLoading || !form.userId}
              onClick={handleFetchFromServer}
            >
              {fetchLoading ? 'Fetching…' : 'Fetch from Server'}
            </button>
          </div>
        </form>
      </div>

      {/* How it works */}
      <div className="card session-info-card">
        <h3 className="session-section-title">How it works</h3>
        <ol className="session-steps">
          <li>Go to <strong>Broker Accounts</strong>, generate your Kite login URL, and complete OAuth login.</li>
          <li>After login, this session is automatically set — you won't need to enter credentials anywhere else.</li>
          <li>Kite tokens expire daily. When that happens, repeat Step 1. The token updates automatically.</li>
          <li>The session is stored in your browser's <code>localStorage</code>. Clearing browser data will reset it.</li>
        </ol>
      </div>
    </div>
  );
}
