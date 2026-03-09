// Base URLs are proxied through Vite dev server to avoid CORS in development.
// In production, set VITE_BROKER_URL etc. as env vars.
const BROKER   = import.meta.env.VITE_BROKER_URL   || '/broker';
const EXECUTION = import.meta.env.VITE_EXECUTION_URL || '/execution';
const DATA      = import.meta.env.VITE_DATA_URL      || '/data-api';
const STRATEGY  = import.meta.env.VITE_STRATEGY_URL  || '/strategy';

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

export async function fetchAllHealthStatuses() {
  const services = [
    { name: 'Broker Engine',    prefix: BROKER,    port: 9003, swaggerPath: '/swagger-ui/index.html' },
    { name: 'Execution Engine', prefix: EXECUTION,  port: 9004, swaggerPath: '/swagger-ui/index.html' },
    { name: 'Data Engine',      prefix: DATA,       port: 9005, swaggerPath: '/swagger-ui/index.html' },
    { name: 'Strategy Engine',  prefix: STRATEGY,   port: 9006, swaggerPath: '/swagger-ui/index.html' },
  ];

  return Promise.all(
    services.map(async (svc) => {
      try {
        const data = await fetchHealth(svc.prefix);
        return { ...svc, status: data?.status === 'UP' ? 'UP' : 'DEGRADED', detail: data };
      } catch (e) {
        return { ...svc, status: 'DOWN', error: e.message };
      }
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

export async function searchInstruments(q, exchange, userId, brokerName) {
  const params = new URLSearchParams({ q: q || '', exchange: exchange || 'NSE', userId, brokerName: brokerName || 'kite' });
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

// ─── Portfolio ────────────────────────────────────────────────────────────────

export async function getPositions(userId, brokerName) {
  return request(`${BROKER}/api/v1/broker/portfolio/positions?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`);
}

export async function getMargins(userId, brokerName) {
  return request(`${BROKER}/api/v1/broker/portfolio/margins?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`);
}
