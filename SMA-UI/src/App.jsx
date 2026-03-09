import { Routes, Route, Navigate } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import BrokerAccounts from './pages/BrokerAccounts';
import Orders from './pages/Orders';
import Portfolio from './pages/Portfolio';
import DataEngine from './pages/DataEngine';
import ExecutionEngine from './pages/ExecutionEngine';
import StrategyEngine from './pages/StrategyEngine';
import Backtest from './pages/Backtest';
import Session from './pages/Session';
import KiteCallback from './pages/KiteCallback';
import './App.css';

export default function App() {
  return (
    <div className="app-layout">
      {/* Hide sidebar on the callback page — it's a standalone OAuth landing */}
      <Routes>
        <Route path="/callback" element={<KiteCallback />} />
        <Route
          path="*"
          element={
            <>
              <Sidebar />
              <main className="app-main">
                <Routes>
                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route path="/accounts" element={<BrokerAccounts />} />
                  <Route path="/orders" element={<Orders />} />
                  <Route path="/portfolio" element={<Portfolio />} />
                  <Route path="/data-engine" element={<DataEngine />} />
                  <Route path="/execution-engine" element={<ExecutionEngine />} />
                  <Route path="/strategy-engine" element={<StrategyEngine />} />
                  <Route path="/backtest" element={<Backtest />} />
                  <Route path="/session" element={<Session />} />
                </Routes>
              </main>
            </>
          }
        />
      </Routes>
    </div>
  );
}
