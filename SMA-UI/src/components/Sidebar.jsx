import { NavLink } from 'react-router-dom';
import './Sidebar.css';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard',     icon: '◈' },
  { to: '/accounts',  label: 'Broker Accounts', icon: '⬡' },
  { to: '/orders',    label: 'Orders',         icon: '◫' },
  { to: '/portfolio', label: 'Portfolio',      icon: '◱' },
];

const SWAGGER_LINKS = [
  { label: 'Broker Engine',    port: 9003 },
  { label: 'Execution Engine', port: 9004 },
  { label: 'Data Engine',      port: 9005 },
  { label: 'Strategy Engine',  port: 9006 },
];

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark">SMA</span>
        <span className="brand-sub">Trading Platform</span>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map(({ to, label, icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
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
