import { NavLink } from 'react-router-dom';
import { useSession } from '../context/SessionContext';
import './Sidebar.css';

const NAV_ITEMS = [
  { to: '/dashboard',   label: 'Dashboard',       icon: '◈' },
  { to: '/accounts',    label: 'Broker Accounts',  icon: '⬡' },
  { to: '/orders',      label: 'Orders',           icon: '◫' },
  { to: '/portfolio',   label: 'Portfolio',        icon: '◱' },
  { to: '/data-engine',       label: 'Data Engine',      icon: '◉' },
  { to: '/execution-engine',  label: 'Execution Engine',  icon: '◬' },
  { to: '/strategy-engine',   label: 'Strategy Engine',   icon: '◇' },
  { to: '/session',           label: 'Session',           icon: '◎' },
];

const SWAGGER_LINKS = [
  { label: 'Broker Engine',    port: 9003 },
  { label: 'Execution Engine', port: 9004 },
  { label: 'Data Engine',      port: 9005 },
  { label: 'Strategy Engine',  port: 9006 },
];

export default function Sidebar() {
  const { session, isActive } = useSession();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark">SMA</span>
        <span className="brand-sub">Trading Platform</span>
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
        {SWAGGER_LINKS.map(({ label, port }) => (
          <a
            key={port}
            href={`http://localhost:${port}/swagger-ui/index.html`}
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
