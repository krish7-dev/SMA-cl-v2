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
    } catch (_) { /* ignore */ }
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

// ─── Portfolio ────────────────────────────────────────────────────────────────

export async function getPositions(userId, brokerName) {
  return request(`${BROKER}/api/v1/broker/portfolio/positions?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`);
}

export async function getMargins(userId, brokerName) {
  return request(`${BROKER}/api/v1/broker/portfolio/margins?userId=${encodeURIComponent(userId)}&brokerName=${encodeURIComponent(brokerName)}`);
}
