import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { loginBrokerAccount } from '../services/api';
import './KiteCallback.css';

const EMPTY = { userId: '', clientId: '', apiKey: '', apiSecret: '' };

/**
 * Handles the Kite Connect OAuth redirect.
 * Kite redirects here as: /callback?request_token=xxx&action=login&status=success
 *
 * The user fills in their credentials (apiKey, apiSecret, userId, clientId)
 * and the page calls the Broker Engine login API automatically.
 */
export default function KiteCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const requestToken = searchParams.get('request_token') || '';
  const status       = searchParams.get('status') || '';

  const [form, setForm]       = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [done, setDone]       = useState(false);

  // If Kite returned an error status
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
      await loginBrokerAccount({
        ...form,
        brokerName: 'kite',
        requestToken,
      });
      setDone(true);
      // Redirect to accounts page — it will reload from DB on mount
      setTimeout(() => navigate('/accounts'), 1800);
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
          <p className="cb-hint">Go back and try the login URL again.</p>
          <button className="btn-secondary" onClick={() => navigate('/accounts')}>
            Back to Accounts
          </button>
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
          <p className="cb-hint">
            This page is the OAuth callback for Kite Connect.<br />
            It should be reached via Kite's redirect after login.
          </p>
          <button className="btn-secondary" onClick={() => navigate('/accounts')}>
            Go to Accounts
          </button>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="callback-page">
        <div className="callback-card card">
          <div className="cb-icon cb-icon-success">✓</div>
          <h2>Authenticated!</h2>
          <p className="cb-hint">Token stored securely. Redirecting to Accounts…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="callback-page">
      <div className="callback-card card">
        <div className="cb-icon cb-icon-success">✓</div>
        <h2>Kite Login Successful</h2>
        <p className="cb-sub">Request token received. Enter your API credentials to complete authentication.</p>

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
