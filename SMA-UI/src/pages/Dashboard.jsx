import { useState, useEffect, useCallback } from 'react';
import { fetchAllHealthStatuses } from '../services/api';
import './Dashboard.css';

const REFRESH_INTERVAL_MS = 30_000;

export default function Dashboard() {
  const [services, setServices] = useState([]);
  const [lastChecked, setLastChecked] = useState(null);
  const [checking, setChecking] = useState(false);

  const checkHealth = useCallback(async () => {
    setChecking(true);
    try {
      const results = await fetchAllHealthStatuses();
      setServices(results);
      setLastChecked(new Date());
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const timer = setInterval(checkHealth, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [checkHealth]);

  const upCount = services.filter(s => s.status === 'UP').length;
  const total = services.length;

  return (
    <div>
      <div className="page-header dashboard-header">
        <div>
          <h1>Dashboard</h1>
          <p>
            {lastChecked
              ? `Last checked at ${lastChecked.toLocaleTimeString()} — auto-refreshes every 30s`
              : 'Checking service health…'}
          </p>
        </div>
        <button
          className="btn-secondary"
          onClick={checkHealth}
          disabled={checking}
        >
          {checking ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {services.length > 0 && (
        <div className="health-summary card">
          <div className="summary-stat">
            <span className="summary-value">{upCount}/{total}</span>
            <span className="summary-label">Services Online</span>
          </div>
          <div className={`summary-bar ${upCount === total ? 'all-up' : upCount === 0 ? 'all-down' : 'partial'}`}>
            <div
              className="summary-bar-fill"
              style={{ width: `${(upCount / total) * 100}%` }}
            />
          </div>
        </div>
      )}

      <div className="health-grid">
        {services.length === 0
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="health-card card loading">
                <div className="hc-skeleton hc-sk-title" />
                <div className="hc-skeleton hc-sk-badge" />
                <div className="hc-skeleton hc-sk-link" />
              </div>
            ))
          : services.map((svc) => (
              <ServiceCard key={svc.name} svc={svc} />
            ))}
      </div>

      <div className="swagger-section">
        <h2>API Documentation</h2>
        <p>Open each service's Swagger UI to explore and test endpoints interactively.</p>
        <div className="swagger-cards">
          {[
            { name: 'Broker Engine',    port: 9003, desc: 'Auth, orders, portfolio, margins' },
            { name: 'Execution Engine', port: 9004, desc: 'Order routing and execution' },
            { name: 'Data Engine',      port: 9005, desc: 'Market data, ticks, candles' },
            { name: 'Strategy Engine',  port: 9006, desc: 'Signal generation, strategy eval' },
          ].map(({ name, port, desc }) => (
            <a
              key={port}
              href={`http://localhost:${port}/swagger-ui/index.html`}
              target="_blank"
              rel="noopener noreferrer"
              className="swagger-card card"
            >
              <div className="sw-card-name">{name}</div>
              <div className="sw-card-desc">{desc}</div>
              <div className="sw-card-port">:{port} ↗</div>
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function ServiceCard({ svc }) {
  const isUp   = svc.status === 'UP';
  const isDown = svc.status === 'DOWN';

  return (
    <div className={`health-card card ${isDown ? 'card-down' : isUp ? 'card-up' : 'card-warn'}`}>
      <div className="hc-top">
        <span className="hc-name">{svc.name}</span>
        <span className={`badge ${isUp ? 'badge-success' : isDown ? 'badge-danger' : 'badge-warning'}`}>
          <span className={`dot ${isUp ? 'dot-success' : isDown ? 'dot-danger' : 'dot-warning'}`} />
          {svc.status}
        </span>
      </div>

      <div className="hc-port">Port {svc.port}</div>

      {isDown && svc.error && (
        <div className="hc-error">{svc.error}</div>
      )}

      {svc.detail?.components && (
        <div className="hc-components">
          {Object.entries(svc.detail.components).map(([key, val]) => (
            <div key={key} className="hc-component">
              <span className="hc-comp-name">{key}</span>
              <span className={`hc-comp-status ${val.status === 'UP' ? 'text-up' : 'text-down'}`}>
                {val.status}
              </span>
            </div>
          ))}
        </div>
      )}

      <a
        href={`http://localhost:${svc.port}/swagger-ui/index.html`}
        target="_blank"
        rel="noopener noreferrer"
        className="hc-swagger-link"
      >
        Open Swagger UI ↗
      </a>
    </div>
  );
}
