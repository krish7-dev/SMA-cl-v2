// Base URLs are proxied through Vite dev server to avoid CORS in development.
// In production, set VITE_BROKER_URL etc. as env vars.
const BROKER        = import.meta.env.VITE_BROKER_URL        || '/broker';
const EXECUTION     = import.meta.env.VITE_EXECUTION_URL     || '/execution';
const DATA          = import.meta.env.VITE_DATA_URL          || '/data-api';
const STRATEGY      = import.meta.env.VITE_STRATEGY_URL      || '/strategy';
const STRATEGY_API  = import.meta.env.VITE_STRATEGY_API_URL  || '/strategy-api';

async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      errorMsg = err.message || err.error || errorMsg;
    } catch (_) {
      // Non-JSON response — service is likely starting up, restarting, or crashed
      if (res.status === 500) errorMsg = 'Service error (non-JSON response) — check that the backend service is running';
      else if (res.status === 502 || res.status === 503) errorMsg = 'Service unavailable — the backend service may be starting up, try again in a moment';
    }
    throw new Error(errorMsg);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ─── Health ───────────────────────────────────────────────────────────────────

export async function fetchHealth(servicePrefix) {
  return request(`${servicePrefix}/actuator/health`);
}

export async function fetchInfo(servicePrefix, versionPath) {
  return request(`${servicePrefix}${versionPath}`);
}

export async function fetchAllHealthStatuses() {
  const services = [
    { name: 'Broker Engine',    prefix: BROKER,    versionPath: '/api/v1/broker/version' },
    { name: 'Execution Engine', prefix: EXECUTION,  versionPath: '/api/v1/execution/version' },
    { name: 'Data Engine',      prefix: DATA,       versionPath: '/api/v1/data/version' },
    { name: 'Strategy Engine',  prefix: STRATEGY,   versionPath: '/api/v1/strategy/version' },
  ];

  return Promise.all(
    services.map(async (svc) => {
      const [healthResult, infoResult] = await Promise.allSettled([
        fetchHealth(svc.prefix),
        fetchInfo(svc.prefix, svc.versionPath),
      ]);
      const health = healthResult.status === 'fulfilled' ? healthResult.value : null;
      const info   = infoResult.status   === 'fulfilled' ? infoResult.value   : null;
      const commitId  = null;
      const buildTime = info?.buildTime || null;
      const status = health
        ? (health.status === 'UP' ? 'UP' : 'DEGRADED')
        : 'DOWN';
      return { ...svc, status, detail: health, commitId, buildTime, error: healthResult.reason?.message };
    })
  );
}

// ─── Broker Auth ──────────────────────────────────────────────────────────────

export async function listBrokerAccounts(userId) {
  const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  return request(`${BROKER}/api/v1/broker/accounts${qs}`);
}

export async function loginBrokerAccount(payload) {
  return request(`${BROKER}/api/v1/broker/auth/login`, { method: 'POST', body: payload });
}

export async function fetchBrokerCredentials(userId, brokerName) {
  return request(
    `${BROKER}/api/v1/broker/auth/credentials?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`
  );
}

export async function logoutBrokerAccount(userId, brokerName) {
  return request(`${BROKER}/api/v1/broker/auth/logout?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`, {
    method: 'POST',
  });
}

// ─── Orders ───────────────────────────────────────────────────────────────────

export async function placeOrder(payload) {
  return request(`${BROKER}/api/v1/broker/orders`, { method: 'POST', body: payload });
}

export async function getOrder(clientOrderId) {
  return request(`${BROKER}/api/v1/broker/orders/${encodeURIComponent(clientOrderId)}`);
}

export async function getOrders(userId, brokerName) {
  return request(`${BROKER}/api/v1/broker/orders?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`);
}

export async function cancelOrder(payload) {
  return request(`${BROKER}/api/v1/broker/orders`, { method: 'DELETE', body: payload });
}

// ─── Data Engine — Instruments ────────────────────────────────────────────────

export async function searchInstruments(q, exchange, userId, brokerName, type) {
  const params = new URLSearchParams({ q: q || '', exchange: exchange || 'NSE', userId, brokerName: brokerName || 'kite' });
  if (type) params.set('type', type);
  return request(`${DATA}/api/v1/data/instruments/search?${params}`);
}

// ─── Data Engine — Historical ─────────────────────────────────────────────────

export async function fetchHistoricalData(payload) {
  return request(`${DATA}/api/v1/data/history`, { method: 'POST', body: payload });
}

// ─── Data Engine — Live ───────────────────────────────────────────────────────

export async function liveSubscribe(payload) {
  return request(`${DATA}/api/v1/data/live/subscribe`, { method: 'POST', body: payload });
}

export async function liveUnsubscribe(payload) {
  return request(`${DATA}/api/v1/data/live/unsubscribe`, { method: 'POST', body: payload });
}

export async function liveDisconnect(userId, brokerName) {
  return request(
    `${DATA}/api/v1/data/live/disconnect?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`,
    { method: 'DELETE' }
  );
}

export async function liveStatus(userId, brokerName) {
  return request(
    `${DATA}/api/v1/data/live/status?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`
  );
}

export async function liveConnect(payload) {
  return request(`${DATA}/api/v1/data/live/connect`, { method: 'POST', body: payload });
}

export async function getLiveSnapshot(userId, brokerName) {
  return request(
    `${STRATEGY_API}/api/v1/strategy/live/snapshot?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`
  );
}

export async function deleteLiveSnapshot(userId, brokerName) {
  return request(
    `${STRATEGY_API}/api/v1/strategy/live/snapshot?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`,
    { method: 'DELETE' }
  );
}

// ─── Data Engine — Replay ─────────────────────────────────────────────────────

export async function startReplay(payload) {
  return request(`${DATA}/api/v1/data/replay/start`, { method: 'POST', body: payload });
}

export async function stopReplay(sessionId) {
  return request(`${DATA}/api/v1/data/replay/stop/${encodeURIComponent(sessionId)}`, { method: 'POST' });
}

export async function getReplayStatus(sessionId) {
  return request(`${DATA}/api/v1/data/replay/status/${encodeURIComponent(sessionId)}`);
}

// ─── Execution Engine ─────────────────────────────────────────────────────────

export async function submitExecution(payload) {
  return request(`${EXECUTION}/api/v1/execution/orders`, { method: 'POST', body: payload });
}

export async function cancelExecution(intentId) {
  return request(`${EXECUTION}/api/v1/execution/orders/${encodeURIComponent(intentId)}`, { method: 'DELETE' });
}

export async function getExecution(intentId) {
  return request(`${EXECUTION}/api/v1/execution/orders/${encodeURIComponent(intentId)}`);
}

export async function listExecutions(userId, brokerName) {
  const qs = brokerName
    ? `?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`
    : `?userId=${encodeURIComponent(userId)}`;
  return request(`${EXECUTION}/api/v1/execution/orders${qs}`);
}

export async function syncExecutionStatus(intentId) {
  return request(`${EXECUTION}/api/v1/execution/orders/${encodeURIComponent(intentId)}/sync`, { method: 'POST' });
}

// ─── Strategy Engine ──────────────────────────────────────────────────────────

export async function createStrategyInstance(payload) {
  return request(`${STRATEGY}/api/v1/strategy/instances`, { method: 'POST', body: payload });
}

export async function getStrategyInstance(instanceId) {
  return request(`${STRATEGY}/api/v1/strategy/instances/${encodeURIComponent(instanceId)}`);
}

export async function listStrategyInstances(userId, status) {
  const qs = status
    ? `?userId=${encodeURIComponent(userId)}&status=${encodeURIComponent(status)}`
    : `?userId=${encodeURIComponent(userId)}`;
  return request(`${STRATEGY}/api/v1/strategy/instances${qs}`);
}

export async function updateStrategyInstance(instanceId, payload) {
  return request(`${STRATEGY}/api/v1/strategy/instances/${encodeURIComponent(instanceId)}`, { method: 'PUT', body: payload });
}

export async function deleteStrategyInstance(instanceId) {
  return request(`${STRATEGY}/api/v1/strategy/instances/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
}

export async function activateStrategyInstance(instanceId) {
  return request(`${STRATEGY}/api/v1/strategy/instances/${encodeURIComponent(instanceId)}/activate`, { method: 'POST' });
}

export async function deactivateStrategyInstance(instanceId) {
  return request(`${STRATEGY}/api/v1/strategy/instances/${encodeURIComponent(instanceId)}/deactivate`, { method: 'POST' });
}

export async function getStrategyTypes() {
  return request(`${STRATEGY}/api/v1/strategy/types`);
}

export async function evaluateStrategy(payload) {
  return request(`${STRATEGY}/api/v1/strategy/evaluate`, { method: 'POST', body: payload });
}

export async function getSignalsByInstance(instanceId, actionableOnly) {
  const qs = actionableOnly
    ? `?instanceId=${encodeURIComponent(instanceId)}&actionableOnly=true`
    : `?instanceId=${encodeURIComponent(instanceId)}`;
  return request(`${STRATEGY}/api/v1/strategy/signals${qs}`);
}

export async function getSignalsBySymbol(symbol, exchange) {
  return request(
    `${STRATEGY}/api/v1/strategy/signals?symbol=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}`
  );
}

export async function runBacktest(payload) {
  return request(`${STRATEGY}/api/v1/strategy/backtest`, { method: 'POST', body: payload });
}

/**
 * Starts a server-side replay evaluation stream.
 *
 * Returns a fetch Response whose body is a text/event-stream.
 * Events are named "candle" and carry JSON-serialised ReplayCandleEvent objects.
 *
 * Usage:
 *   const res = await startReplayEval(config);
 *   // then read res.body as a ReadableStream and parse SSE events manually
 */
export async function startReplayEval(config, signal) {
  const res = await fetch(`${STRATEGY_API}/api/v1/strategy/replay/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(config),
    signal,
  });
  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      errorMsg = err.message || err.error || errorMsg;
    } catch (_) {}
    throw new Error(errorMsg);
  }
  return res; // caller reads res.body as ReadableStream
}

// ─── Strategy Engine — Live Eval ──────────────────────────────────────────────

/**
 * Starts a live evaluation session in the Strategy Engine.
 * Returns { data: { sessionId: "..." } }
 */
export async function startLiveEval(config) {
  return request(`${STRATEGY_API}/api/v1/strategy/live/evaluate`, {
    method: 'POST',
    body: config,
  });
}

/**
 * Stops a live evaluation session.
 */
export async function stopLiveEval(sessionId) {
  return request(`${STRATEGY_API}/api/v1/strategy/live/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

// ─── Portfolio ────────────────────────────────────────────────────────────────

export async function getPositions(userId, brokerName) {
  return request(`${BROKER}/api/v1/broker/portfolio/positions?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`);
}

export async function getMargins(userId, brokerName) {
  return request(`${BROKER}/api/v1/broker/portfolio/margins?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`);
}

// ─── Strategy Engine — Options Replay Eval ────────────────────────────────────

/**
 * Starts a server-side options replay evaluation stream.
 *
 * Returns a fetch Response whose body is a text/event-stream.
 * Events: "init" (config echo), "candle" (OptionsReplayCandleEvent JSON), "summary" (final P&L).
 */
export async function startOptionsReplayEval(config, signal) {
  const res = await fetch(`${STRATEGY_API}/api/v1/strategy/options-replay/evaluate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(config),
    signal,
  });
  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      errorMsg = err.message || err.error || errorMsg;
    } catch (_) {}
    throw new Error(errorMsg);
  }
  return res;
}

// ─── Strategy Engine — Tick Replay Eval ──────────────────────────────────────

/**
 * Lists all recorded tick sessions from the Data Engine.
 * Returns ApiResponse<List<TickSessionInfo>>.
 */
export async function listTickSessions() {
  return request(`${DATA}/api/v1/data/ticks/sessions`);
}

/**
 * Fetches raw ticks for a session + token list from the Data Engine.
 * Returns ApiResponse<List<TickEntryDto>> — each entry: { instrumentToken, ltp, volume, tickTimeMs }
 */
export async function querySessionTicks(sessionId, tokens) {
  return request(`${DATA}/api/v1/data/ticks/query`, {
    method: 'POST',
    body: { sessionId, tokens },
  });
}

/**
 * Starts a tick replay background session.
 * Returns { data: { sessionId: "..." } }
 */
export async function startTickReplayEval(config) {
  return request(`${STRATEGY_API}/api/v1/strategy/tick-replay/evaluate`, {
    method: 'POST',
    body: config,
  });
}

/**
 * Opens the SSE stream for a tick replay session.
 * Returns a fetch Response whose body is a text/event-stream.
 * Events: "init", "tick", "candle", "summary", "error".
 */
export async function streamTickReplayEval(sessionId, signal) {
  const res = await fetch(
    `${STRATEGY_API}/api/v1/strategy/tick-replay/stream/${encodeURIComponent(sessionId)}`,
    { headers: { Accept: 'text/event-stream' }, signal },
  );
  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      errorMsg = err.message || err.error || errorMsg;
    } catch (_) {}
    throw new Error(errorMsg);
  }
  return res;
}

/**
 * Stops a tick replay session early.
 */
export async function stopTickReplayEval(sessionId) {
  return request(
    `${STRATEGY_API}/api/v1/strategy/tick-replay/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
}

/**
 * Lists all currently active (running) tick replay sessions.
 */
export async function listActiveTickReplays() {
  return request(`${STRATEGY_API}/api/v1/strategy/tick-replay/sessions`);
}

// ─── Strategy Engine — Options Live Eval ──────────────────────────────────────

/**
 * Starts a live options evaluation session.
 * Returns { data: { sessionId: "..." } }
 */
export async function startOptionsLiveEval(config) {
  return request(`${STRATEGY_API}/api/v1/strategy/options-live/evaluate`, {
    method: 'POST',
    body: config,
  });
}

/**
 * Opens the SSE stream for a live options session.
 * Returns a fetch Response whose body is a text/event-stream.
 * Events: "init", "candle" (OptionsReplayCandleEvent JSON), "error".
 */
export async function streamOptionsLiveEval(sessionId, signal) {
  const res = await fetch(
    `${STRATEGY_API}/api/v1/strategy/options-live/stream/${encodeURIComponent(sessionId)}`,
    { headers: { Accept: 'text/event-stream' }, signal },
  );
  if (!res.ok) {
    let errorMsg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      errorMsg = err.message || err.error || errorMsg;
    } catch (_) {}
    throw new Error(errorMsg);
  }
  return res;
}

/**
 * Stops a live options evaluation session.
 */
export async function stopOptionsLiveEval(sessionId) {
  return request(
    `${STRATEGY_API}/api/v1/strategy/options-live/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
}

/**
 * Returns the active sessionId for a given userId, or null if none running.
 */
export async function getActiveOptionsLiveSession(userId) {
  try {
    const res = await request(
      `${STRATEGY_API}/api/v1/strategy/options-live/active/${encodeURIComponent(userId)}`,
    );
    return res?.data?.sessionId ?? null;
  } catch {
    return null; // 404 = no active session
  }
}

// ─── Strategy Engine — Session Results ───────────────────────────────────────

export async function saveSessionResult(data) {
  return request(`${STRATEGY_API}/api/v1/strategy/session-results`, { method: 'POST', body: data });
}

export async function listSessionResults(userId, type) {
  const params = new URLSearchParams();
  if (userId) params.set('userId', userId);
  if (type)   params.set('type', type);
  return request(`${STRATEGY_API}/api/v1/strategy/session-results?${params}`);
}

export async function getSessionResult(sessionId) {
  return request(`${STRATEGY_API}/api/v1/strategy/session-results/${encodeURIComponent(sessionId)}`);
}

export async function deleteSessionResult(sessionId) {
  return request(`${STRATEGY_API}/api/v1/strategy/session-results/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

/**
 * Runs a server-side field-by-field comparison of two saved sessions.
 * Returns ApiResponse<DivergenceReport>:
 *   { sessionA, sessionB, matchedCandles, liveOnlyCount, replayOnlyCount,
 *     divergentCandleCount, firstDivergenceTime, firstDivergenceStage,
 *     divergences: [{niftyTime, stage, field, liveValue, replayValue}],
 *     liveOnlyTimes, replayOnlyTimes,
 *     tradeComparison: [{liveEntryTime, replayEntryTime, side, entryPriceMismatch,
 *                        exitPriceMismatch, exitReasonMismatch, pnlDiff, status}] }
 */
export async function getSessionDivergence(sessionA, sessionB) {
  return request(
    `${STRATEGY_API}/api/v1/strategy/session-results/divergence?sessionA=${encodeURIComponent(sessionA)}&sessionB=${encodeURIComponent(sessionB)}`
  );
}
