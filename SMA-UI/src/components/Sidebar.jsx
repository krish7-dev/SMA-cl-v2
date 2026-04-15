import { NavLink } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useSession } from '../context/SessionContext';
import { fetchAllHealthStatuses } from '../services/api';
import './Sidebar.css';

const NSE_HOLIDAYS = {
  '2026-01-26': 'Republic Day',
  '2026-03-19': 'Holi',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Ambedkar Jayanti',
  '2026-04-21': 'Ram Navami',
  '2026-05-01': 'Maharashtra Day',
  '2026-08-27': 'Ganesh Chaturthi',
  '2026-10-02': 'Gandhi Jayanti',
  '2026-11-13': 'Diwali',
  '2026-11-14': 'Diwali',
  '2026-12-25': 'Christmas',
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toISTDateStr(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function MarketWeekStrip() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const todayStr = toISTDateStr(now.getTime());

  // Find Monday of the current IST week
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const dow = istNow.getUTCDay(); // 0=Sun
  const daysSinceMon = dow === 0 ? 6 : dow - 1;
  const mondayMs = now.getTime() - daysSinceMon * 86_400_000;

  const days = Array.from({ length: 5 }, (_, i) => {
    const ms = mondayMs + i * 86_400_000;
    const dateStr = toISTDateStr(ms);
    const holiday = NSE_HOLIDAYS[dateStr] || null;
    const isToday = dateStr === todayStr;
    const isFuture = dateStr > todayStr;

    let open = false;
    if (isToday && !holiday) {
      const d = new Date(now.getTime() + IST_OFFSET_MS);
      const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
      open = mins >= 555 && mins <= 930; // 09:15–15:30
    }

    return { dateStr, holiday, isToday, open };
  });

  const todayDay = days.find(d => d.isToday);
  let statusText, statusColor;
  if (!todayDay)             { statusText = 'Weekend';       statusColor = 'var(--text-muted)'; }
  else if (todayDay.open)    { statusText = 'Market Open';   statusColor = '#22c55e'; }
  else if (todayDay.holiday) { statusText = todayDay.holiday; statusColor = '#f59e0b'; }
  else                       { statusText = 'Closed';        statusColor = 'var(--text-muted)'; }

  const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F'];

  return (
    <div className="sidebar-market-week">
      <div className="smw-header">
        <span className="smw-title">NSE Market</span>
        <span className="smw-status" style={{ color: statusColor }}>{statusText}</span>
      </div>
      <div className="smw-dots">
        {days.map(({ dateStr, holiday, isToday, open }, i) => {
          const color = open    ? '#22c55e'
                      : holiday ? '#f59e0b'
                      : '#16a34a';
          const title = holiday ? `${dateStr} — ${holiday}` : dateStr;
          return (
            <div key={dateStr} className="smw-day" title={title}>
              <div className="smw-dot-wrap">
                {open && <div className="smw-pulse-ring" />}
                <div className={`smw-dot${isToday ? ' smw-dot-today' : ''}`} style={{ background: color }} />
              </div>
              <span className="smw-letter">{DAY_LETTERS[i]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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

const HEALTH_ABBR = {
  'Broker Engine':    { abbr: 'B' },
  'Execution Engine': { abbr: 'E' },
  'Data Engine':      { abbr: 'D' },
  'Strategy Engine':  { abbr: 'S' },
};

const backendHost = import.meta.env.VITE_BACKEND_HOST || 'http://localhost';
const ENV_LABEL = backendHost.includes('localhost') ? 'LOCAL' : 'EC2';
const ENV_CLASS = backendHost.includes('localhost') ? 'env-local' : 'env-ec2';

export default function Sidebar() {
  const { session, isActive } = useSession();
  const [health, setHealth] = useState([]);

  useEffect(() => {
    async function check() {
      const results = await fetchAllHealthStatuses();
      setHealth(results);
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
        {health.map(svc => {
          const abbr = HEALTH_ABBR[svc.name]?.abbr || svc.name[0];
          const cls = svc.status === 'UP' ? 'shb-up' : svc.status === 'DOWN' ? 'shb-down' : svc.status === 'DEGRADED' ? 'shb-warn' : 'shb-unknown';
          const tooltip = svc.commitId
            ? `${svc.name}: ${svc.status || 'checking…'}\ncommit: ${svc.commitId}`
            : `${svc.name}: ${svc.status || 'checking…'}`;
          return (
            <div key={svc.name} className={`shb-item ${cls}`} title={tooltip}>
              <span className={`shb-dot ${cls}`} />
              <span className="shb-label">{abbr}</span>
            </div>
          );
        })}
        {health.length === 0 && ['B','E','D','S'].map(a => (
          <div key={a} className="shb-item shb-unknown">
            <span className="shb-dot shb-unknown" />
            <span className="shb-label">{a}</span>
          </div>
        ))}
        <span className={`env-badge ${ENV_CLASS}`}>{ENV_LABEL}</span>
      </div>
      {/* Build timestamps */}
      {health.some(s => s.buildTime) && (
        <div className="sidebar-build-info">
          {health.map(svc => {
            const abbr = HEALTH_ABBR[svc.name]?.abbr || svc.name[0];
            const ts = svc.buildTime
              ? new Date(svc.buildTime).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' })
              : '—';
            return (
              <span key={svc.name} className="build-commit" title={`${svc.name} built at ${svc.buildTime || 'unknown'}`}>
                {abbr}:{ts}
              </span>
            );
          })}
        </div>
      )}

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

      <MarketWeekStrip />

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
