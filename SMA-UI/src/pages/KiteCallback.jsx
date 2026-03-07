import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { loginBrokerAccount } from '../services/api';
import { useSession } from '../context/SessionContext';
import './KiteCallback.css';

const EMPTY = { userId: '', clientId: '', apiKey: '', apiSecret: '' };

/**
 * Handles the Kite Connect OAuth redirect.
 * After successful login, automatically saves the session so all pages
 * work without re-entering credentials.
 */
export default function KiteCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { saveSession } = useSession();

  const requestToken = searchParams.get('request_token') || '';
  const status       = searchParams.get('status') || '';

  const [form, setForm]       = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [done, setDone]       = useState(false);

  const kiteError = status && status !== 'success';

  function handleChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await loginBrokerAccount({ ...form, brokerName: 'kite', requestToken });
      const data = res?.data;
      // Auto-save session — no manual credential entry needed on other pages
      saveSession({
        userId:      data?.userId      || form.userId,
        clientId:    data?.clientId    || form.clientId,
        brokerName:  data?.brokerName  || 'kite',
        apiKey:      data?.apiKey      || form.apiKey,
        accessToken: data?.accessToken || '',
      });
      setDone(true);
      setTimeout(() => navigate('/dashboard'), 1800);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (kiteError) {
    return (
      <div className="callback-page">
        <div className="callback-card card">
          <div className="cb-icon cb-icon-error">✕</div>
          <h2>Kite Login Failed</h2>
          <p className="cb-sub">Kite returned status: <strong>{status}</strong></p>
          <button className="btn-secondary" onClick={() => navigate('/accounts')}>Back to Accounts</button>
        </div>
      </div>
    );
  }

  if (!requestToken) {
    return (
      <div className="callback-page">
        <div className="callback-card card">
          <div className="cb-icon cb-icon-warn">!</div>
          <h2>No Request Token</h2>
          <p className="cb-hint">This page is the OAuth callback for Kite Connect. It should be reached via Kite's redirect after login.</p>
          <button className="btn-secondary" onClick={() => navigate('/accounts')}>Go to Accounts</button>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="callback-page">
        <div className="callback-card card">
          <div className="cb-icon cb-icon-success">✓</div>
          <h2>Session Active!</h2>
          <p className="cb-hint">Credentials saved. All pages are ready — redirecting to Dashboard…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="callback-page">
      <div className="callback-card card">
        <div className="cb-icon cb-icon-success">✓</div>
        <h2>Kite Login Successful</h2>
        <p className="cb-sub">Enter your credentials once — they'll be saved for the entire session.</p>

        <div className="token-preview">
          <span className="token-label">Request Token</span>
          <span className="token-value">{requestToken.slice(0, 16)}…</span>
        </div>

        {error && <div className="error-msg">{error}</div>}

        <form onSubmit={handleSubmit} className="cb-form">
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
          <div className="form-group">
            <label>API Key *</label>
            <input name="apiKey" value={form.apiKey} onChange={handleChange} placeholder="Your Kite API key" required />
          </div>
          <div className="form-group">
            <label>API Secret *</label>
            <input name="apiSecret" type="password" value={form.apiSecret} onChange={handleChange} placeholder="Your Kite API secret" required />
          </div>
          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Authenticating…' : 'Complete Authentication'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
