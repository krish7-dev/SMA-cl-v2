import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { loginBrokerAccount, fetchBrokerCredentials } from '../services/api';
import { useSession } from '../context/SessionContext';
import './KiteCallback.css';

/**
 * Handles the Kite Connect OAuth redirect.
 *
 * Re-login flow (session.userId exists):
 *   Fetches stored credentials from Broker Engine automatically — no form shown.
 *
 * First-time flow (no session):
 *   Shows a form asking only for userId + apiSecret.
 *   clientId and apiKey are fetched from the server once userId is known.
 *   If the account doesn't exist yet (truly first time), shows the full form.
 */
export default function KiteCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { session, saveSession } = useSession();

  const requestToken = searchParams.get('request_token') || '';
  const status       = searchParams.get('status') || '';

  // phase: 'init' | 'auto' | 'form' | 'submitting' | 'done' | 'kite-error' | 'no-token'
  const [phase, setPhase]     = useState('init');
  const [errorMsg, setErrorMsg] = useState('');

  // Form state — shown when no existing session (first-time login)
  const [form, setForm] = useState({ userId: '', clientId: '', apiKey: '', apiSecret: '' });

  const kiteError = status && status !== 'success';

  function handleChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
    setErrorMsg('');
  }

  async function authenticate(payload) {
    const res  = await loginBrokerAccount({ ...payload, brokerName: 'kite', requestToken });
    const data = res?.data;
    saveSession({
      userId:      data?.userId      || payload.userId,
      clientId:    data?.clientId    || payload.clientId,
      brokerName:  data?.brokerName  || 'kite',
      apiKey:      data?.apiKey      || payload.apiKey,
      accessToken: data?.accessToken || '',
    });
    setPhase('done');
    setTimeout(() => navigate('/accounts'), 1800);
  }

  // On mount: try to auto-authenticate if session.userId is available
  useEffect(() => {
    if (kiteError || !requestToken) return;

    const userId     = session.userId;
    const brokerName = session.brokerName || 'kite';

    if (!userId) {
      // No session — show form for first-time login
      setPhase('form');
      return;
    }

    // Session exists — fetch stored credentials and auto-submit
    setPhase('auto');
    fetchBrokerCredentials(userId, brokerName)
      .then(res => authenticate({
        userId:    res.data.userId,
        clientId:  res.data.clientId,
        apiKey:    res.data.apiKey,
        apiSecret: res.data.apiSecret,
      }))
      .catch(err => {
        // Fallback: pre-fill whatever we have from session, ask for apiSecret only
        setForm({
          userId:    session.userId     || '',
          clientId:  session.clientId   || '',
          apiKey:    session.apiKey     || '',
          apiSecret: '',
        });
        setErrorMsg('Could not fetch stored credentials — please enter your API secret below.');
        setPhase('form');
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setErrorMsg('');
    setPhase('submitting');
    try {
      // Try to fetch clientId/apiKey from server if not already filled
      let payload = { ...form };
      if (!payload.clientId || !payload.apiKey) {
        try {
          const res = await fetchBrokerCredentials(payload.userId, 'kite');
          payload = { ...payload, clientId: res.data.clientId || payload.clientId, apiKey: res.data.apiKey || payload.apiKey };
        } catch (_) { /* first-time: no stored creds yet, use form values */ }
      }
      await authenticate(payload);
    } catch (err) {
      setErrorMsg(err.message);
      setPhase('form');
    }
  }

  // ── Early exits ──────────────────────────────────────────────────────────────

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

  if (phase === 'init' || phase === 'auto') {
    return (
      <div className="callback-page">
        <div className="callback-card card">
          <div className="cb-icon cb-icon-success" style={{ opacity: 0.6 }}>⟳</div>
          <h2>Authenticating…</h2>
          <p className="cb-hint">Fetching stored credentials and exchanging request token.</p>
        </div>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="callback-page">
        <div className="callback-card card">
          <div className="cb-icon cb-icon-success">✓</div>
          <h2>Session Active!</h2>
          <p className="cb-hint">Credentials saved. Redirecting to Accounts…</p>
        </div>
      </div>
    );
  }

  // phase === 'form' | 'submitting' — first-time login or fallback
  const isFirstTime = !session.userId;
  const needsApiKey = !form.apiKey;

  return (
    <div className="callback-page">
      <div className="callback-card card">
        <div className="cb-icon cb-icon-success">✓</div>
        <h2>Kite Login Successful</h2>
        <p className="cb-sub">
          {isFirstTime
            ? 'Enter your credentials once — they\'ll be saved for all future logins.'
            : 'Enter your API secret to complete re-authentication.'}
        </p>

        <div className="token-preview">
          <span className="token-label">Request Token</span>
          <span className="token-value">{requestToken.slice(0, 16)}…</span>
        </div>

        {errorMsg && <div className="error-msg" style={{ marginTop: 12 }}>{errorMsg}</div>}

        <form onSubmit={handleSubmit} className="cb-form">
          {/* Always show userId */}
          <div className="form-row">
            <div className="form-group">
              <label>User ID *</label>
              <input name="userId" value={form.userId} onChange={handleChange} placeholder="e.g. user123" required />
            </div>
            <div className="form-group">
              <label>Client ID {isFirstTime ? '*' : ''}</label>
              <input name="clientId" value={form.clientId} onChange={handleChange} placeholder="e.g. GG4570" required={isFirstTime} />
            </div>
          </div>

          {/* Only show apiKey field if not pre-filled from session */}
          {needsApiKey && (
            <div className="form-group">
              <label>API Key *</label>
              <input name="apiKey" value={form.apiKey} onChange={handleChange} placeholder="Your Kite API key" required />
            </div>
          )}

          {/* Always need apiSecret — never stored in frontend session */}
          <div className="form-group">
            <label>API Secret *</label>
            <input name="apiSecret" type="password" value={form.apiSecret} onChange={handleChange} placeholder="Your Kite API secret" required />
          </div>

          <div className="form-actions">
            <button type="submit" className="btn-primary" disabled={phase === 'submitting'}>
              {phase === 'submitting' ? 'Authenticating…' : 'Complete Authentication'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
