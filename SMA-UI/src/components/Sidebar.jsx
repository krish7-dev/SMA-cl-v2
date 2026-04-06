import { NavLink } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useSession } from '../context/SessionContext';
import { fetchAllHealthStatuses } from '../services/api';
import './Sidebar.css';

const NAV_ITEMS = [
  { to: '/dashboard',   label: 'Dashboard',       icon: '◈' },
  { to: '/accounts',    label: 'Broker Accounts',  icon: '⬡' },
  { to: '/orders',      label: 'Orders',           icon: '◫' },
  { to: '/portfolio',   label: 'Portfolio',        icon: '◱' },
  { to: '/data-engine',       label: 'Data Engine',      icon: '◉' },
  { to: '/execution-engine',  label: 'Execution Engine',  icon: '◬' },
  { to: '/strategy-engine',   label: 'Strategy Engine',   icon: '◇' },
  { to: '/backtest',          label: 'Backtest Lab',      icon: '◑' },
  { to: '/session',           label: 'Session',           icon: '◎' },
];

const SWAGGER_LINKS = [
  { label: 'Broker Engine',    path: '/api/broker' },
  { label: 'Execution Engine', path: '/api/execution' },
  { label: 'Data Engine',      path: '/api/data' },
  { label: 'Strategy Engine',  path: '/api/strategy' },
];

const HEALTH_SERVICES = [
  { name: 'Broker',    abbr: 'B', prefix: '/api/broker' },
  { name: 'Execution', abbr: 'E', prefix: '/api/execution' },
  { name: 'Data',      abbr: 'D', prefix: '/api/data' },
  { name: 'Strategy',  abbr: 'S', prefix: '/api/strategy' },
];

export default function Sidebar() {
  const { session, isActive } = useSession();
  const [health, setHealth] = useState({});

  useEffect(() => {
    async function check() {
      const results = await Promise.all(
        HEALTH_SERVICES.map(async svc => {
          try {
            const res = await fetch(`${svc.prefix}/actuator/health`);
            const data = await res.json();
            return [svc.name, data?.status === 'UP' ? 'UP' : 'DEGRADED'];
          } catch {
            return [svc.name, 'DOWN'];
          }
        })
      );
      setHealth(Object.fromEntries(results));
    }
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark">SMA</span>
        <span className="brand-sub">Trading Platform</span>
      </div>

      {/* Service health bar */}
      <div className="sidebar-health-bar">
        {HEALTH_SERVICES.map(svc => {
          const status = health[svc.name];
          const cls = status === 'UP' ? 'shb-up' : status === 'DOWN' ? 'shb-down' : status === 'DEGRADED' ? 'shb-warn' : 'shb-unknown';
          return (
            <div key={svc.name} className={`shb-item ${cls}`} title={`${svc.name}: ${status || 'checking…'}`}>
              <span className={`shb-dot ${cls}`} />
              <span className="shb-label">{svc.abbr}</span>
            </div>
          );
        })}
      </div>

      {/* Session status pill */}
      <div className="sidebar-session">
        {isActive ? (
          <NavLink to="/session" className="session-pill session-pill-active">
            <span className="session-dot session-dot-active" />
            <span className="session-info">
              <span className="session-user">{session.userId}</span>
              <span className="session-broker">{session.brokerName}</span>
            </span>
          </NavLink>
        ) : (
          <NavLink to="/session" className="session-pill session-pill-none">
            <span className="session-dot" />
            <span className="session-info">
              <span className="session-user">No Session</span>
              <span className="session-broker">Click to configure</span>
            </span>
          </NavLink>
        )}
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map(({ to, label, icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive: a }) => `nav-item ${a ? 'active' : ''}`}
          >
            <span className="nav-icon">{icon}</span>
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-section-title">Swagger UI</div>
      <div className="sidebar-swagger">
        {SWAGGER_LINKS.map(({ label, path }) => (
          <a
            key={path}
            href={`${path}/swagger-ui/index.html`}
            target="_blank"
            rel="noopener noreferrer"
            className="swagger-link"
          >
            <span className="swagger-dot" />
            {label}
            <span className="ext-icon">↗</span>
          </a>
        ))}
      </div>

      <div className="sidebar-footer">
        <span>v0.1.0</span>
      </div>
    </aside>
  );
}
