import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getStrategyTypes, runBacktest,
  startReplay, stopReplay, getReplayStatus,
  liveSubscribe, liveDisconnect, liveStatus,
  searchInstruments,
} from '../services/api';
import { useSession } from '../context/SessionContext';
import './StrategyEngine.css';
import './Backtest.css';

// ─── Constants ─────────────────────────────────────────────────────────────────

const PARAM_DEFS = {
  SMA_CROSSOVER: [
    { key: 'shortPeriod', label: 'Short Period', placeholder: '5',  hint: 'Fast SMA' },
    { key: 'longPeriod',  label: 'Long Period',  placeholder: '20', hint: 'Slow SMA' },
  ],
  EMA_CROSSOVER: [
    { key: 'shortPeriod', label: 'Short Period', placeholder: '9',  hint: 'Fast EMA' },
    { key: 'longPeriod',  label: 'Long Period',  placeholder: '21', hint: 'Slow EMA' },
  ],
  RSI: [
    { key: 'period',     label: 'Period',     placeholder: '14', hint: 'RSI lookback' },
    { key: 'oversold',   label: 'Oversold',   placeholder: '30', hint: 'Buy level'   },
    { key: 'overbought', label: 'Overbought', placeholder: '70', hint: 'Sell level'  },
  ],
  MACD: [
    { key: 'fastPeriod',   label: 'Fast Period',   placeholder: '12', hint: 'Fast EMA'   },
    { key: 'slowPeriod',   label: 'Slow Period',   placeholder: '26', hint: 'Slow EMA'   },
    { key: 'signalPeriod', label: 'Signal Period', placeholder: '9',  hint: 'Signal EMA' },
  ],
  RSI_REVERSAL: [
    { key: 'period',     label: 'Period',     placeholder: '14', hint: 'RSI lookback' },
    { key: 'oversold',   label: 'Oversold',   placeholder: '30', hint: 'Buy zone'     },
    { key: 'overbought', label: 'Overbought', placeholder: '70', hint: 'Sell zone'    },
  ],
  BREAKOUT: [
    { key: 'lookback', label: 'Lookback', placeholder: '20', hint: 'Channel window' },
  ],
  VWAP_PULLBACK: [
    { key: 'lookback', label: 'Lookback', placeholder: '20', hint: 'Rolling VWAP window' },
  ],
  BOLLINGER_REVERSION: [
    { key: 'period',     label: 'Period',     placeholder: '20', hint: 'SMA / std dev window'  },
    { key: 'multiplier', label: 'Multiplier', placeholder: '2',  hint: 'Band width (std devs)' },
  ],
  LIQUIDITY_SWEEP: [
    { key: 'lookback', label: 'Lookback', placeholder: '10', hint: 'Prior candles for liquidity pool' },
  ],
};

const INTERVALS = [
  { value: 'MINUTE_1',  label: '1 Min'  },
  { value: 'MINUTE_3',  label: '3 Min'  },
  { value: 'MINUTE_5',  label: '5 Min'  },
  { value: 'MINUTE_10', label: '10 Min' },
  { value: 'MINUTE_15', label: '15 Min' },
  { value: 'MINUTE_30', label: '30 Min' },
  { value: 'MINUTE_60', label: '60 Min' },
  { value: 'DAY',       label: 'Day'    },
  { value: 'WEEK',      label: 'Week'   },
  { value: 'MONTH',     label: 'Month'  },
];

const STRATEGY_COLORS = {
  SMA_CROSSOVER:       '#6366f1',
  EMA_CROSSOVER:       '#0ea5e9',
  RSI:                 '#10b981',
  MACD:                '#f59e0b',
  RSI_REVERSAL:        '#8b5cf6',
  BREAKOUT:            '#ef4444',
  VWAP_PULLBACK:       '#06b6d4',
  BOLLINGER_REVERSION: '#ec4899',
  LIQUIDITY_SWEEP:     '#f97316',
};

const ALL_STRATEGY_TYPES = Object.keys(PARAM_DEFS);

const DATE_PRESETS = [
  { label: '7 Days',  days: 7   },
  { label: '1 Month', days: 30  },
  { label: '3 Months',days: 90  },
  { label: '6 Months',days: 180 },
  { label: '1 Year',  days: 365 },
];

const RECENT_KEY = 'sma_recent_instruments';
const MAX_RECENT = 6;

function loadRecentInstruments() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
function saveRecentInstrument(inst) {
  const list = loadRecentInstruments().filter(
    i => !(i.instrumentToken === inst.instrumentToken && i.exchange === inst.exchange)
  );
  localStorage.setItem(RECENT_KEY, JSON.stringify([inst, ...list].slice(0, MAX_RECENT)));
}

function toISODate(d) {
  return d.toISOString().split('T')[0];
}
function datePreset(days) {
  const to   = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  return { fromDate: toISODate(from), toDate: toISODate(to) };
}

function defaultParams(type) {
  const defs = PARAM_DEFS[type] || [];
  return Object.fromEntries(defs.map(d => [d.key, d.placeholder]));
}

function emptyVariant(type) {
  return { strategyType: type || 'SMA_CROSSOVER', label: '', parameters: defaultParams(type || 'SMA_CROSSOVER') };
}

// Fixed strategy entries — all strategies always shown, each with an enabled toggle
function defaultStrategies() {
  return ALL_STRATEGY_TYPES.map(type => ({
    strategyType: type,
    enabled: true,
    label: '',
    parameters: defaultParams(type),
  }));
}

const EMPTY_DATA_CTX = {
  symbol: '', exchange: 'NSE', instrumentToken: '',
  interval: 'DAY', fromDate: '', toDate: '',
  initialCapital: '100000', quantity: '0', product: 'CNC',
};

const EMPTY_INST = { symbol: '', exchange: 'NSE', instrumentToken: '' };

// ─── Local strategy evaluators (mirror Java strategy implementations) ───────────

class LocalSmaEvaluator {
  constructor(shortPeriod, longPeriod) {
    this.s = Math.max(1, parseInt(shortPeriod) || 5);
    this.l = Math.max(this.s + 1, parseInt(longPeriod) || 20);
    this.prices = [];
  }
  next(close) {
    const price = parseFloat(close);
    if (isNaN(price)) return 'HOLD';
    this.prices.push(price);
    const needed = this.l + 1;
    if (this.prices.length > needed) this.prices.shift();
    if (this.prices.length < needed) return 'HOLD';
    const prev = this.prices.slice(0, this.l);
    const cur  = this.prices.slice(1);
    const avg  = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const shortSmaPrev = avg(prev.slice(0, this.s));
    const longSmaPrev  = avg(prev);
    const shortSmaCur  = avg(cur.slice(cur.length - this.s));
    const longSmaCur   = avg(cur);
    if (shortSmaPrev <= longSmaPrev && shortSmaCur > longSmaCur) return 'BUY';
    if (shortSmaPrev >= longSmaPrev && shortSmaCur < longSmaCur) return 'SELL';
    return 'HOLD';
  }
  reset() { this.prices = []; }
  get warmupNeeded() { return this.l + 1; }
  get candlesSeen()  { return this.prices.length; }
}

class LocalEmaEvaluator {
  constructor(shortPeriod, longPeriod) {
    this.s = Math.max(1, parseInt(shortPeriod) || 9);
    this.l = Math.max(this.s + 1, parseInt(longPeriod) || 21);
    this.shortMult = 2 / (this.s + 1);
    this.longMult  = 2 / (this.l + 1);
    this.count = 0; this.warmup = [];
    this.shortEma = 0; this.longEma = 0;
    this.prevShort = 0; this.prevLong = 0;
  }
  next(close) {
    const price = parseFloat(close);
    if (isNaN(price)) return 'HOLD';
    this.count++;
    if (this.warmup !== null) this.warmup.push(price);
    if (this.count < this.l) return 'HOLD';
    if (this.count === this.l) {
      const avg = (arr, from, n) => arr.slice(from, from + n).reduce((a, b) => a + b, 0) / n;
      this.longEma  = avg(this.warmup, 0, this.l);
      this.shortEma = avg(this.warmup, this.l - this.s, this.s);
      this.prevShort = this.shortEma; this.prevLong = this.longEma;
      this.warmup = null;
      return 'HOLD';
    }
    this.prevShort = this.shortEma; this.prevLong = this.longEma;
    this.shortEma = price * this.shortMult + this.shortEma * (1 - this.shortMult);
    this.longEma  = price * this.longMult  + this.longEma  * (1 - this.longMult);
    if (this.prevShort <= this.prevLong && this.shortEma > this.longEma) return 'BUY';
    if (this.prevShort >= this.prevLong && this.shortEma < this.longEma) return 'SELL';
    return 'HOLD';
  }
  reset() { this.count = 0; this.warmup = []; this.shortEma = 0; this.longEma = 0; }
  get warmupNeeded() { return this.l + 1; }
  get candlesSeen()  { return this.count; }
}

class LocalRsiEvaluator {
  constructor(period, oversold, overbought) {
    this.period     = Math.max(2, parseInt(period)     || 14);
    this.oversold   = parseFloat(oversold)   || 30;
    this.overbought = parseFloat(overbought) || 70;
    this.count = 0; this.prevClose = NaN;
    this.avgGain = 0; this.avgLoss = 0;
    this.prevRsi = NaN; this.warmupChanges = [];
  }
  next(close) {
    const price = parseFloat(close);
    if (isNaN(price)) return 'HOLD';
    this.count++;
    if (this.count === 1) { this.prevClose = price; return 'HOLD'; }
    const change = price - this.prevClose;
    const gain   = Math.max(change, 0);
    const loss   = Math.max(-change, 0);
    this.prevClose = price;
    if (this.count <= this.period) { this.warmupChanges.push(change); return 'HOLD'; }
    if (this.count === this.period + 1) {
      let sumG = gain, sumL = loss;
      for (const c of this.warmupChanges) { if (c > 0) sumG += c; else sumL += -c; }
      this.avgGain = sumG / this.period;
      this.avgLoss = sumL / this.period;
      this.warmupChanges = null;
    } else {
      this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
      this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
    }
    const rsi = this.avgLoss === 0 ? 100 : 100 - (100 / (1 + this.avgGain / this.avgLoss));
    const prev = this.prevRsi;
    this.prevRsi = rsi;
    if (isNaN(prev)) return 'HOLD';
    if (prev <= this.oversold   && rsi > this.oversold)   return 'BUY';
    if (prev >= this.overbought && rsi < this.overbought) return 'SELL';
    return 'HOLD';
  }
  reset() { this.count = 0; this.prevClose = NaN; this.avgGain = 0; this.avgLoss = 0; this.prevRsi = NaN; this.warmupChanges = []; }
  get warmupNeeded() { return this.period + 2; }
  get candlesSeen()  { return this.count; }
}

class LocalMacdEvaluator {
  constructor(fastPeriod, slowPeriod, signalPeriod) {
    this.fast   = Math.max(2, parseInt(fastPeriod)   || 12);
    this.slow   = Math.max(this.fast + 1, parseInt(slowPeriod) || 26);
    this.signal = Math.max(1, parseInt(signalPeriod) || 9);
    this.fastMult   = 2 / (this.fast   + 1);
    this.slowMult   = 2 / (this.slow   + 1);
    this.signalMult = 2 / (this.signal + 1);
    this.count = 0; this.priceWarmup = []; this.macdWarmup = [];
    this.fastEma = 0; this.slowEma = 0; this.signalEma = 0;
    this.prevMacd = NaN; this.prevSignal = NaN; this.signalReady = false;
  }
  next(close) {
    const price = parseFloat(close);
    if (isNaN(price)) return 'HOLD';
    this.count++;
    if (this.count < this.slow) { this.priceWarmup.push(price); return 'HOLD'; }
    if (this.count === this.slow) {
      this.priceWarmup.push(price);
      const avg = (arr, f, n) => arr.slice(f, f + n).reduce((a, b) => a + b, 0) / n;
      this.slowEma = avg(this.priceWarmup, 0, this.slow);
      this.fastEma = avg(this.priceWarmup, this.slow - this.fast, this.fast);
      this.priceWarmup = null;
    } else {
      this.fastEma = price * this.fastMult + this.fastEma * (1 - this.fastMult);
      this.slowEma = price * this.slowMult + this.slowEma * (1 - this.slowMult);
    }
    const macd = this.fastEma - this.slowEma;
    if (!this.signalReady) {
      this.macdWarmup.push(macd);
      if (this.macdWarmup.length < this.signal) return 'HOLD';
      this.signalEma   = this.macdWarmup.reduce((a, b) => a + b, 0) / this.signal;
      this.signalReady = true; this.macdWarmup = null;
      this.prevMacd = macd; this.prevSignal = this.signalEma;
      return 'HOLD';
    }
    const prevMacd = this.prevMacd, prevSignal = this.prevSignal;
    this.signalEma  = macd * this.signalMult + this.signalEma * (1 - this.signalMult);
    this.prevMacd   = macd;
    this.prevSignal = this.signalEma;
    if (prevMacd <= prevSignal && macd > this.signalEma) return 'BUY';
    if (prevMacd >= prevSignal && macd < this.signalEma) return 'SELL';
    return 'HOLD';
  }
  reset() { this.count = 0; this.priceWarmup = []; this.macdWarmup = []; this.fastEma = 0; this.slowEma = 0; this.signalEma = 0; this.prevMacd = NaN; this.prevSignal = NaN; this.signalReady = false; }
  get warmupNeeded() { return this.slow + this.signal; }
  get candlesSeen()  { return this.count; }
}

class LocalRsiReversalEvaluator {
  constructor(period, oversold, overbought) {
    this.period = Math.max(2, parseInt(period) || 14);
    this.oversold = parseFloat(oversold) || 30;
    this.overbought = parseFloat(overbought) || 70;
    this.count = 0; this.prevClose = NaN;
    this.avgGain = 0; this.avgLoss = 0;
    this.prevRsi = NaN; this.warmupChanges = [];
  }
  next(close) {
    const price = parseFloat(close); if (isNaN(price)) return 'HOLD';
    this.count++;
    if (this.count === 1) { this.prevClose = price; return 'HOLD'; }
    const change = price - this.prevClose;
    const gain = Math.max(change, 0), loss = Math.max(-change, 0);
    this.prevClose = price;
    if (this.count <= this.period) { this.warmupChanges.push(change); return 'HOLD'; }
    if (this.count === this.period + 1) {
      let sg = gain, sl = loss;
      for (const c of this.warmupChanges) { if (c > 0) sg += c; else sl += -c; }
      this.avgGain = sg / this.period; this.avgLoss = sl / this.period; this.warmupChanges = null;
    } else {
      this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
      this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
    }
    const rsi = this.avgLoss === 0 ? 100 : 100 - (100 / (1 + this.avgGain / this.avgLoss));
    const prev = this.prevRsi; this.prevRsi = rsi;
    if (isNaN(prev)) return 'HOLD';
    if (rsi < this.oversold   && rsi > prev) return 'BUY';
    if (rsi > this.overbought && rsi < prev) return 'SELL';
    return 'HOLD';
  }
  reset() { this.count = 0; this.prevClose = NaN; this.avgGain = 0; this.avgLoss = 0; this.prevRsi = NaN; this.warmupChanges = []; }
  get warmupNeeded() { return this.period + 2; }
  get candlesSeen()  { return this.count; }
}

class LocalBreakoutEvaluator {
  constructor(lookback) {
    this.lookback = Math.max(2, parseInt(lookback) || 20);
    this.window = []; // [{high, low}]
  }
  next(close, high, low) {
    const c = parseFloat(close), h = parseFloat(high) || c, l = parseFloat(low) || c;
    let result = 'HOLD';
    if (this.window.length >= this.lookback) {
      const channelHigh = Math.max(...this.window.map(e => e.high));
      const channelLow  = Math.min(...this.window.map(e => e.low));
      if (c > channelHigh) result = 'BUY';
      else if (c < channelLow) result = 'SELL';
    }
    this.window.push({ high: h, low: l });
    if (this.window.length > this.lookback) this.window.shift();
    return result;
  }
  reset() { this.window = []; }
  get warmupNeeded() { return this.lookback; }
  get candlesSeen()  { return this.window.length; }
}

class LocalVwapPullbackEvaluator {
  constructor(lookback) {
    this.lookback = Math.max(2, parseInt(lookback) || 20);
    this.window = []; // [{tpv, vol}]
    this.prevClose = NaN; this.prevVwap = NaN;
  }
  next(close, high, low, volume) {
    const c = parseFloat(close), h = parseFloat(high) || c, l = parseFloat(low) || c;
    const vol = parseFloat(volume) || 0;
    const typical = (h + l + c) / 3;
    this.window.push({ tpv: typical * vol, vol });
    if (this.window.length > this.lookback) this.window.shift();
    const sumTpv = this.window.reduce((a, e) => a + e.tpv, 0);
    const sumVol = this.window.reduce((a, e) => a + e.vol, 0);
    const vwap   = sumVol > 0 ? sumTpv / sumVol : c;
    if (this.window.length < this.lookback || isNaN(this.prevClose)) {
      this.prevClose = c; this.prevVwap = vwap; return 'HOLD';
    }
    let result = 'HOLD';
    if (this.prevClose < this.prevVwap && c > vwap) result = 'BUY';
    else if (this.prevClose > this.prevVwap && c < vwap) result = 'SELL';
    this.prevClose = c; this.prevVwap = vwap;
    return result;
  }
  reset() { this.window = []; this.prevClose = NaN; this.prevVwap = NaN; }
  get warmupNeeded() { return this.lookback; }
  get candlesSeen()  { return this.window.length; }
}

class LocalBollingerEvaluator {
  constructor(period, multiplier) {
    this.period = Math.max(2, parseInt(period) || 20);
    this.mult   = parseFloat(multiplier) || 2.0;
    this.window = [];
  }
  next(close) {
    const c = parseFloat(close); if (isNaN(c)) return 'HOLD';
    this.window.push(c);
    if (this.window.length > this.period) this.window.shift();
    if (this.window.length < this.period) return 'HOLD';
    const mean   = this.window.reduce((a, b) => a + b, 0) / this.period;
    const stdDev = Math.sqrt(this.window.reduce((a, v) => a + (v - mean) ** 2, 0) / this.period);
    const upper  = mean + this.mult * stdDev;
    const lower  = mean - this.mult * stdDev;
    if (c < lower) return 'BUY';
    if (c > upper) return 'SELL';
    return 'HOLD';
  }
  reset() { this.window = []; }
  get warmupNeeded() { return this.period; }
  get candlesSeen()  { return this.window.length; }
}

class LocalLiquiditySweepEvaluator {
  constructor(lookback) {
    this.lookback = Math.max(2, parseInt(lookback) || 10);
    this.window   = []; // { high, low }
  }
  next(close, high, low) {
    const c = parseFloat(close), h = parseFloat(high), l = parseFloat(low);
    if (isNaN(c) || isNaN(h) || isNaN(l)) return 'HOLD';
    let result = 'HOLD';
    if (this.window.length >= this.lookback) {
      const poolHigh = Math.max(...this.window.map(e => e.high));
      const poolLow  = Math.min(...this.window.map(e => e.low));
      if (l < poolLow  && c > poolLow)  result = 'BUY';
      else if (h > poolHigh && c < poolHigh) result = 'SELL';
    }
    this.window.push({ high: h, low: l });
    if (this.window.length > this.lookback) this.window.shift();
    return result;
  }
  reset() { this.window = []; }
  get warmupNeeded() { return this.lookback; }
  get candlesSeen()  { return this.window.length; }
}

function buildLocalEvaluator(strategyType, params = {}) {
  switch (strategyType) {
    case 'EMA_CROSSOVER':
      return new LocalEmaEvaluator(params.shortPeriod, params.longPeriod);
    case 'RSI':
      return new LocalRsiEvaluator(params.period, params.oversold, params.overbought);
    case 'MACD':
      return new LocalMacdEvaluator(params.fastPeriod, params.slowPeriod, params.signalPeriod);
    case 'RSI_REVERSAL':
      return new LocalRsiReversalEvaluator(params.period, params.oversold, params.overbought);
    case 'BREAKOUT':
      return new LocalBreakoutEvaluator(params.lookback);
    case 'VWAP_PULLBACK':
      return new LocalVwapPullbackEvaluator(params.lookback);
    case 'BOLLINGER_REVERSION':
      return new LocalBollingerEvaluator(params.period, params.multiplier);
    case 'LIQUIDITY_SWEEP':
      return new LocalLiquiditySweepEvaluator(params.lookback);
    case 'SMA_CROSSOVER':
    default:
      return new LocalSmaEvaluator(params.shortPeriod, params.longPeriod);
  }
}

// ─── Page ───────────────────────────────────────────────────────────────────────

export default function Backtest() {
  const [tab, setTab] = useState('backtest');

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Backtest Lab</h1>
          <p>Compare, replay, and live-test strategy configurations.</p>
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 24 }}>
        {[
          ['backtest', 'Historical Backtest'],
          ['replay',   'Replay Test'],
          ['live',     'Live Test'],
        ].map(([key, label]) => (
          <button
            key={key}
            className={`tab-btn ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'backtest' && <HistoricalBacktest />}
      {tab === 'replay'   && <ReplayTest />}
      {tab === 'live'     && <LiveTest />}
    </div>
  );
}

// ─── Tab 1: Historical Backtest ───────────────────────────────────────────────

function HistoricalBacktest() {
  const { session, isActive } = useSession();

  const [strategies, setStrategies] = useState(defaultStrategies);
  const [dataCtx, setDataCtx]       = useState({ ...EMPTY_DATA_CTX });
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  const [result, setResult]         = useState(null);

  const enabledCount = strategies.filter(s => s.enabled).length;

  function toggleStrategy(idx) {
    setStrategies(prev => prev.map((s, i) => i === idx ? { ...s, enabled: !s.enabled } : s));
  }

  function updateParam(idx, key, value) {
    setStrategies(prev => prev.map((s, i) =>
      i === idx ? { ...s, parameters: { ...s.parameters, [key]: value } } : s
    ));
  }

  function updateLabel(idx, value) {
    setStrategies(prev => prev.map((s, i) => i === idx ? { ...s, label: value } : s));
  }

  function applyPreset(days) {
    const { fromDate, toDate } = datePreset(days);
    setDataCtx(p => ({ ...p, fromDate, toDate }));
  }

  function handleInstrumentSelect(inst) {
    setDataCtx(p => ({ ...p, symbol: inst.tradingSymbol, exchange: inst.exchange, instrumentToken: String(inst.instrumentToken) }));
    saveRecentInstrument(inst);
  }

  async function handleRun(e) {
    e.preventDefault();
    if (enabledCount === 0) { setError('Enable at least one strategy.'); return; }
    setError(''); setResult(null); setLoading(true);
    try {
      const payload = {
        userId:          session.userId,
        brokerName:      session.brokerName,
        symbol:          dataCtx.symbol.toUpperCase(),
        exchange:        dataCtx.exchange.toUpperCase(),
        instrumentToken: parseInt(dataCtx.instrumentToken, 10),
        interval:        dataCtx.interval,
        fromDate:        dataCtx.fromDate + 'T09:15:00',
        toDate:          dataCtx.toDate   + 'T15:30:00',
        product:         dataCtx.product,
        quantity:        parseInt(dataCtx.quantity, 10) || 0,
        initialCapital:  parseFloat(dataCtx.initialCapital),
        strategies: strategies.filter(s => s.enabled).map(s => ({
          strategyType: s.strategyType,
          label:        s.label || undefined,
          parameters:   s.parameters,
        })),
      };
      const res = await runBacktest(payload);
      setResult(res?.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleRun}>
      {/* Strategy Cards — all always visible */}
      <div className="bt-section-label">
        <span className="bt-section-title">Strategies</span>
        <span className="bt-section-sub">{enabledCount} of {strategies.length} enabled — all run on the same instrument and date range</span>
      </div>

      <div className="bt-variants-grid">
        {strategies.map((s, idx) => {
          const color    = STRATEGY_COLORS[s.strategyType] || '#6366f1';
          const paramDefs = PARAM_DEFS[s.strategyType] || [];
          return (
            <div key={s.strategyType} className={`bt-variant-card ${!s.enabled ? 'bt-variant-disabled' : ''}`} style={{ '--variant-color': color }}>
              <div className="bt-variant-header">
                <span className="bt-variant-index" style={{ background: color }}>{s.strategyType.replace('_', ' ')}</span>
                <button
                  type="button"
                  className={s.enabled ? 'btn-danger btn-sm' : 'btn-secondary btn-sm'}
                  onClick={() => toggleStrategy(idx)}
                >
                  {s.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>

              <div className="form-group" style={{ marginBottom: 10, opacity: s.enabled ? 1 : 0.5 }}>
                <label>Label <span className="field-optional">(optional)</span></label>
                <input value={s.label} onChange={e => updateLabel(idx, e.target.value)} placeholder={s.strategyType} disabled={!s.enabled} />
              </div>

              {paramDefs.length > 0 && (
                <div className="bt-params-block" style={{ opacity: s.enabled ? 1 : 0.5 }}>
                  <div className="bt-params-label">Parameters</div>
                  {paramDefs.map(def => (
                    <div className="bt-param-row" key={def.key}>
                      <label className="bt-param-label">{def.label}</label>
                      <input type="number" min="1" className="bt-param-input"
                        value={s.parameters?.[def.key] || ''}
                        onChange={e => updateParam(idx, def.key, e.target.value)}
                        placeholder={def.placeholder}
                        disabled={!s.enabled}
                      />
                      <span className="bt-param-hint">{def.hint}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Data Context */}
      <div className="bt-section-label" style={{ marginTop: 28 }}>
        <span className="bt-section-title">Instrument & Date Range</span>
        <span className="bt-section-sub">All enabled strategies run on this data</span>
      </div>

      <div className="card bt-data-ctx">
        {/* Instrument picker */}
        <InstrumentPicker
          session={session}
          symbol={dataCtx.symbol}
          exchange={dataCtx.exchange}
          instrumentToken={dataCtx.instrumentToken}
          onSelect={handleInstrumentSelect}
          onChange={patch => setDataCtx(p => ({ ...p, ...patch }))}
        />

        {/* Date range */}
        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>
            Date Range — Quick Select
          </label>
          <div className="bt-preset-row">
            {DATE_PRESETS.map(p => (
              <button key={p.days} type="button" className="bt-preset-btn" onClick={() => applyPreset(p.days)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="form-row" style={{ marginTop: 8 }}>
          <div className="form-group">
            <label>Interval *</label>
            <select value={dataCtx.interval} onChange={e => setDataCtx(p => ({ ...p, interval: e.target.value }))}>
              {INTERVALS.map(iv => <option key={iv.value} value={iv.value}>{iv.label}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>From Date *</label>
            <input type="date" value={dataCtx.fromDate} onChange={e => setDataCtx(p => ({ ...p, fromDate: e.target.value }))} required />
          </div>
          <div className="form-group">
            <label>To Date *</label>
            <input type="date" value={dataCtx.toDate} onChange={e => setDataCtx(p => ({ ...p, toDate: e.target.value }))} required />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Initial Capital (₹) *</label>
            <input type="number" value={dataCtx.initialCapital} onChange={e => setDataCtx(p => ({ ...p, initialCapital: e.target.value }))} required />
          </div>
          <div className="form-group">
            <label>Quantity <span className="form-hint">(0 = auto: max units from capital)</span></label>
            <input type="number" min="0" placeholder="0 = auto" value={dataCtx.quantity} onChange={e => setDataCtx(p => ({ ...p, quantity: e.target.value }))} />
          </div>
          <div className="form-group">
            <label>Product</label>
            <select value={dataCtx.product} onChange={e => setDataCtx(p => ({ ...p, product: e.target.value }))}>
              <option value="CNC">CNC (Delivery)</option>
              <option value="MIS">MIS (Intraday)</option>
              <option value="NRML">NRML (F&O)</option>
            </select>
          </div>
        </div>
      </div>

      {error && <div className="error-msg" style={{ marginBottom: 16 }}>{error}</div>}
      {!isActive && <div className="error-msg" style={{ marginBottom: 16 }}>No active session — activate one in Broker Accounts first.</div>}

      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={loading || !isActive || enabledCount === 0}>
          {loading ? `Running ${enabledCount} strateg${enabledCount !== 1 ? 'ies' : 'y'}…` : `Run Backtest — ${enabledCount} strateg${enabledCount !== 1 ? 'ies' : 'y'}`}
        </button>
        <button type="button" className="btn-secondary" onClick={() => { setStrategies(defaultStrategies()); setDataCtx({ ...EMPTY_DATA_CTX }); setResult(null); setError(''); }} disabled={loading}>
          Reset
        </button>
      </div>

      {result && <BacktestResultPanel result={result} />}
    </form>
  );
}

// ─── Instrument Picker ────────────────────────────────────────────────────────
// Shared component used in all 3 tabs: search box + recent instruments list

function InstrumentPicker({ session, symbol, exchange, instrumentToken, onSelect, onChange, disabled }) {
  const [query, setQuery]       = useState('');
  const [results, setResults]   = useState([]);
  const [searching, setSearching] = useState(false);
  const [showDrop, setShowDrop] = useState(false);
  const [recent, setRecent]     = useState(loadRecentInstruments);
  const debounceRef             = useRef(null);
  const wrapRef                 = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    function onClickOut(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setShowDrop(false); }
    document.addEventListener('mousedown', onClickOut);
    return () => document.removeEventListener('mousedown', onClickOut);
  }, []);

  function handleQueryChange(e) {
    const q = e.target.value;
    setQuery(q);
    if (!q.trim()) { setResults([]); setShowDrop(false); return; }
    setShowDrop(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!session?.userId) return;
      setSearching(true);
      try {
        const res = await searchInstruments(q, exchange, session.userId, session.brokerName || 'kite');
        setResults(res?.data || []);
      } catch { setResults([]); }
      finally { setSearching(false); }
    }, 300);
  }

  function pickResult(inst) {
    onSelect(inst);
    setQuery('');
    setResults([]);
    setShowDrop(false);
    setRecent(loadRecentInstruments());
  }

  function pickRecent(inst) {
    onSelect(inst);
    setRecent(loadRecentInstruments());
  }

  return (
    <div>
      {/* Recent instruments */}
      {recent.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Recent Instruments</label>
          <div className="bt-recent-row">
            {recent.map((r, i) => (
              <button key={i} type="button" className="bt-recent-chip" onClick={() => pickRecent(r)} disabled={disabled}>
                <span className="bt-recent-symbol">{r.tradingSymbol}</span>
                <span className="bt-recent-exchange">{r.exchange}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Search box */}
      <div ref={wrapRef} style={{ position: 'relative', marginBottom: 10 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
          Search Instrument
        </label>
        <input
          value={query}
          onChange={handleQueryChange}
          onFocus={() => query.trim() && setShowDrop(true)}
          placeholder={session?.userId ? 'Type symbol or company name (e.g. RELIANCE)' : 'Activate a session to search instruments'}
          disabled={disabled || !session?.userId}
        />
        {showDrop && (
          <div className="bt-instrument-drop">
            {searching && <div className="bt-drop-hint">Searching…</div>}
            {!searching && results.length === 0 && <div className="bt-drop-hint">No matches found</div>}
            {results.map((r, i) => (
              <button key={i} type="button" className="bt-drop-item" onClick={() => pickResult(r)}>
                <span className="bt-drop-symbol">{r.tradingSymbol}</span>
                <span className="bt-drop-name">{r.name}</span>
                <span className="bt-drop-meta">{r.exchange} · {r.instrumentType} · {r.instrumentToken}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Manual fields — auto-filled by search or recent, still editable */}
      <div className="form-row">
        <div className="form-group">
          <label>Symbol *</label>
          <input value={symbol} onChange={e => onChange({ symbol: e.target.value })} placeholder="e.g. RELIANCE" required disabled={disabled} />
        </div>
        <div className="form-group">
          <label>Exchange *</label>
          <select value={exchange} onChange={e => onChange({ exchange: e.target.value })} disabled={disabled}>
            {['NSE','BSE','NFO','MCX','CDS'].map(x => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Instrument Token *</label>
          <input type="number" value={instrumentToken} onChange={e => onChange({ instrumentToken: e.target.value })} placeholder="e.g. 738561" required disabled={disabled} />
        </div>
      </div>
    </div>
  );
}

// ─── Tab 2: Replay Test ───────────────────────────────────────────────────────

function ReplayTest() {
  const { session, isActive } = useSession();

  const [knownTypes, setKnownTypes]   = useState(['SMA_CROSSOVER']);
  const [variant, setVariant]         = useState(emptyVariant('SMA_CROSSOVER'));
  const [inst, setInst]               = useState({ ...EMPTY_INST });
  const [interval, setInterval]       = useState('DAY');
  const [fromDate, setFromDate]       = useState('');
  const [toDate, setToDate]           = useState('');
  const [speed, setSpeed]             = useState(1);

  const [sessionId, setSessionId]     = useState(null);
  const [status, setStatus]           = useState('idle');   // idle|starting|running|completed|stopped|failed
  const [progress, setProgress]       = useState({ emitted: 0, total: 0 });
  const [error, setError]             = useState('');
  const [feed, setFeed]               = useState([]);       // { time, symbol, open, high, low, close, signal }
  const [currentCandle, setCurrentCandle] = useState(null);

  const evaluatorRef  = useRef(null);
  const sseRef        = useRef(null);
  const pollRef       = useRef(null);
  const feedRef       = useRef([]);

  useEffect(() => {
    getStrategyTypes().then(r => { if (r?.data) setKnownTypes([...r.data].sort()); }).catch(() => {});
    return () => cleanup();
  }, []);

  function cleanup() {
    if (sseRef.current)  { sseRef.current.close(); sseRef.current = null; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  function updateVariantField(field, value) {
    if (field === 'strategyType') setVariant(v => ({ ...v, strategyType: value, parameters: defaultParams(value) }));
    else setVariant(v => ({ ...v, [field]: value }));
  }

  function updateVariantParam(key, value) {
    setVariant(v => ({ ...v, parameters: { ...v.parameters, [key]: value } }));
  }

  async function handleStart(e) {
    e.preventDefault();
    cleanup();
    setError(''); setFeed([]); feedRef.current = [];
    setProgress({ emitted: 0, total: 0 });
    setStatus('starting'); setSessionId(null); setCurrentCandle(null);

    // Build evaluator matching the selected strategy type
    evaluatorRef.current = buildLocalEvaluator(variant.strategyType, variant.parameters || {});

    try {
      const res = await startReplay({
        userId:          session.userId,
        brokerName:      session.brokerName,
        instrumentToken: parseInt(inst.instrumentToken, 10),
        symbol:          inst.symbol.toUpperCase(),
        exchange:        inst.exchange.toUpperCase(),
        interval,
        fromDate:        fromDate + 'T09:15:00',
        toDate:          toDate   + 'T15:30:00',
        speedMultiplier: speed,
      });

      const sid = res?.data?.sessionId;
      if (!sid) throw new Error('No session ID returned');
      setSessionId(sid);
      setProgress({ emitted: 0, total: res?.data?.totalCandles || 0 });
      setStatus('running');

      // Connect SSE
      const sse = new EventSource(`/data-api/api/v1/data/stream/candles?sessionId=${encodeURIComponent(sid)}`);
      sseRef.current = sse;

      sse.addEventListener('candle', (ev) => {
        try {
          const candle = JSON.parse(ev.data);
          const signal = evaluatorRef.current.next(parseFloat(candle.close), parseFloat(candle.high), parseFloat(candle.low), parseFloat(candle.volume));
          const entry = { ...candle, signal, ts: new Date().toLocaleTimeString() };
          setCurrentCandle(entry);
          feedRef.current = [entry, ...feedRef.current].slice(0, 500);
          setFeed([...feedRef.current]);
          setProgress(prev => ({ ...prev, emitted: prev.emitted + 1 }));
        } catch {}
      });

      sse.onerror = () => {
        setStatus(s => s === 'running' ? 'completed' : s);
        cleanup();
      };

      // Poll for completion
      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await getReplayStatus(sid);
          const st = statusRes?.data?.status;
          if (st === 'COMPLETED' || st === 'STOPPED' || st === 'FAILED') {
            setStatus(st.toLowerCase());
            cleanup();
          }
        } catch {}
      }, 2000);

    } catch (err) {
      setError(err.message);
      setStatus('idle');
      cleanup();
    }
  }

  async function handleStop() {
    if (!sessionId) return;
    try {
      await stopReplay(sessionId);
      setStatus('stopped');
    } catch {}
    cleanup();
  }

  const isRunning = status === 'running' || status === 'starting';
  const paramDefs = PARAM_DEFS[variant.strategyType] || [];

  return (
    <div>
      {/* Config */}
      <div className="bt-replay-layout">
        <div className="bt-replay-config">
          <div className="card">
            <h3 className="section-title">Strategy</h3>

            <div className="form-group">
              <label>Strategy Type</label>
              <select value={variant.strategyType} onChange={e => updateVariantField('strategyType', e.target.value)} disabled={isRunning}>
                {knownTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            {paramDefs.length > 0 && (
              <div className="bt-params-block" style={{ marginTop: 8 }}>
                <div className="bt-params-label">Parameters</div>
                {paramDefs.map(def => (
                  <div className="bt-param-row" key={def.key}>
                    <label className="bt-param-label">{def.label}</label>
                    <input type="number" min="1" className="bt-param-input"
                      value={variant.parameters?.[def.key] || ''}
                      onChange={e => updateVariantParam(def.key, e.target.value)}
                      placeholder={def.placeholder}
                      disabled={isRunning}
                    />
                    <span className="bt-param-hint">{def.hint}</span>
                  </div>
                ))}
              </div>
            )}

            <h3 className="section-title" style={{ marginTop: 16 }}>Data</h3>

            <form onSubmit={handleStart}>
              <InstrumentPicker
                session={session}
                symbol={inst.symbol}
                exchange={inst.exchange}
                instrumentToken={inst.instrumentToken}
                onSelect={r => { setInst({ symbol: r.tradingSymbol, exchange: r.exchange, instrumentToken: String(r.instrumentToken) }); saveRecentInstrument(r); }}
                onChange={patch => setInst(p => ({ ...p, ...patch }))}
                disabled={isRunning}
              />

              {/* Date preset buttons */}
              <div style={{ marginBottom: 8 }}>
                <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 6 }}>Date Range</label>
                <div className="bt-preset-row">
                  {DATE_PRESETS.map(p => (
                    <button key={p.days} type="button" className="bt-preset-btn" disabled={isRunning}
                      onClick={() => { const d = datePreset(p.days); setFromDate(d.fromDate); setToDate(d.toDate); }}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Interval *</label>
                  <select value={interval} onChange={e => setInterval(e.target.value)} disabled={isRunning}>
                    {INTERVALS.map(iv => <option key={iv.value} value={iv.value}>{iv.label}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Speed (candles/s)</label>
                  <select value={speed} onChange={e => setSpeed(parseInt(e.target.value))} disabled={isRunning}>
                    {[1, 2, 5, 10, 20, 50].map(s => <option key={s} value={s}>{s}×</option>)}
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>From Date *</label>
                  <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} required disabled={isRunning} />
                </div>
                <div className="form-group">
                  <label>To Date *</label>
                  <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} required disabled={isRunning} />
                </div>
              </div>

              {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
              {!isActive && <div className="error-msg" style={{ marginBottom: 12 }}>No active session.</div>}

              <div style={{ display: 'flex', gap: 8 }}>
                {!isRunning ? (
                  <button type="submit" className="btn-primary" disabled={!isActive}>▶ Start Replay</button>
                ) : (
                  <button type="button" className="btn-danger" onClick={handleStop}>■ Stop</button>
                )}
                {!isRunning && (
                  <button type="button" className="btn-secondary" onClick={() => { cleanup(); setFeed([]); feedRef.current = []; setStatus('idle'); setSessionId(null); setProgress({ emitted: 0, total: 0 }); setCurrentCandle(null); setError(''); }}>
                    Reset
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>

        {/* Live feed */}
        <div className="bt-replay-feed">
          {/* Status bar */}
          <div className="card bt-feed-status">
            <div className="bt-feed-status-row">
              <span className={`bt-status-pill bt-status-${status}`}>{status.toUpperCase()}</span>
              {sessionId && <span className="mono-sm" style={{ color: 'var(--text-muted)', fontSize: 11 }}>{sessionId.substring(0, 16)}…</span>}
              {progress.total > 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {progress.emitted} / {progress.total} candles
                </span>
              )}
            </div>
            {progress.total > 0 && (
              <div className="bt-progress-bar">
                <div className="bt-progress-fill" style={{ width: `${Math.min(100, (progress.emitted / progress.total) * 100)}%` }} />
              </div>
            )}
          </div>

          {/* Current candle */}
          {currentCandle && (
            <div className="card bt-current-candle">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{currentCandle.symbol}</span>
                  <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)' }}>{currentCandle.openTime?.substring(0, 16)}</span>
                </div>
                {signalBadge(currentCandle.signal)}
              </div>
              <div className="bt-ohlc-row">
                {[['O', currentCandle.open],['H', currentCandle.high],['L', currentCandle.low],['C', currentCandle.close]].map(([l, v]) => (
                  <span key={l}><span className="meta-label">{l}</span> {Number(v).toFixed(2)}</span>
                ))}
                <span><span className="meta-label">Vol</span> {currentCandle.volume?.toLocaleString()}</span>
              </div>
            </div>
          )}

          {/* Signal log */}
          <div className="card" style={{ padding: 0 }}>
            <div className="bt-feed-header">
              <span className="bt-params-label" style={{ margin: 0 }}>Signal Log</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {feed.filter(f => f.signal !== 'HOLD').length} actionable / {feed.length} total
              </span>
            </div>
            <div className="bt-signal-log">
              {feed.length === 0
                ? <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Signals will appear here when replay starts.</div>
                : feed.map((row, i) => (
                  <div key={i} className={`bt-signal-row ${row.signal !== 'HOLD' ? 'bt-signal-actionable' : ''}`}>
                    <span className="mono-sm" style={{ color: 'var(--text-muted)', minWidth: 56 }}>{row.ts}</span>
                    {signalBadge(row.signal)}
                    <span style={{ flex: 1, fontSize: 12 }}>{row.symbol}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>C: {Number(row.close).toFixed(2)}</span>
                  </div>
                ))
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Tab 3: Live Test ─────────────────────────────────────────────────────────

function LiveTest() {
  const { session, isActive } = useSession();

  const [knownTypes, setKnownTypes]   = useState(['SMA_CROSSOVER']);
  const [variant, setVariant]         = useState(emptyVariant('SMA_CROSSOVER'));
  const [inst, setInst]               = useState({ ...EMPTY_INST });
  const [mode, setMode]               = useState('QUOTE');

  const [connected, setConnected]     = useState(false);
  const [status, setStatus]           = useState('idle');
  const [error, setError]             = useState('');
  const [ticks, setTicks]             = useState([]);
  const [signals, setSignals]         = useState([]);
  const [latestTick, setLatestTick]   = useState(null);

  const evaluatorRef = useRef(null);
  const sseRef       = useRef(null);
  const ticksRef     = useRef([]);
  const signalsRef   = useRef([]);

  useEffect(() => {
    getStrategyTypes().then(r => { if (r?.data) setKnownTypes([...r.data].sort()); }).catch(() => {});
    return () => cleanup();
  }, []);

  function cleanup() {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
  }

  function updateVariantField(field, value) {
    if (field === 'strategyType') setVariant(v => ({ ...v, strategyType: value, parameters: defaultParams(value) }));
    else setVariant(v => ({ ...v, [field]: value }));
  }

  function updateVariantParam(key, value) {
    setVariant(v => ({ ...v, parameters: { ...v.parameters, [key]: value } }));
  }

  async function handleConnect(e) {
    e.preventDefault();
    setError(''); setTicks([]); ticksRef.current = []; setSignals([]); signalsRef.current = [];
    setLatestTick(null);
    evaluatorRef.current = buildLocalEvaluator(variant.strategyType, variant.parameters || {});

    try {
      setStatus('connecting');
      await liveSubscribe({
        userId:      session.userId,
        brokerName:  session.brokerName,
        apiKey:      session.apiKey,
        accessToken: session.accessToken,
        mode,
        instruments: [{
          instrumentToken: parseInt(inst.instrumentToken, 10),
          symbol:          inst.symbol.toUpperCase(),
          exchange:        inst.exchange.toUpperCase(),
        }],
      });

      // Connect to SSE tick stream
      const sse = new EventSource('/data-api/api/v1/data/stream/ticks');
      sseRef.current = sse;

      sse.addEventListener('tick', (ev) => {
        try {
          const tick = JSON.parse(ev.data);
          setLatestTick(tick);
          ticksRef.current = [{ ...tick, ts: new Date().toLocaleTimeString() }, ...ticksRef.current].slice(0, 200);
          setTicks([...ticksRef.current]);

          // Evaluate using LTP as surrogate close
          const signal = evaluatorRef.current.next(parseFloat(tick.ltp));
          if (signal !== 'HOLD') {
            const entry = { signal, price: tick.ltp, symbol: tick.symbol, ts: new Date().toLocaleTimeString() };
            signalsRef.current = [entry, ...signalsRef.current].slice(0, 100);
            setSignals([...signalsRef.current]);
          }
        } catch {}
      });

      sse.onerror = () => {
        setConnected(false);
        setStatus('disconnected');
        cleanup();
      };

      setConnected(true);
      setStatus('connected');
    } catch (err) {
      setError(err.message);
      setStatus('idle');
      cleanup();
    }
  }

  async function handleDisconnect() {
    try {
      await liveDisconnect(session.userId, session.brokerName);
    } catch {}
    cleanup();
    setConnected(false);
    setStatus('idle');
  }

  const paramDefs = PARAM_DEFS[variant.strategyType] || [];
  const changeColor = latestTick?.change >= 0 ? 'var(--text-success, #22c55e)' : '#ef4444';

  return (
    <div className="bt-replay-layout">
      {/* Config */}
      <div className="bt-replay-config">
        <div className="card">
          <h3 className="section-title">Strategy</h3>

          <div className="form-group">
            <label>Strategy Type</label>
            <select value={variant.strategyType} onChange={e => updateVariantField('strategyType', e.target.value)} disabled={connected}>
              {knownTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          {paramDefs.length > 0 && (
            <div className="bt-params-block" style={{ marginTop: 8 }}>
              <div className="bt-params-label">Parameters</div>
              {paramDefs.map(def => (
                <div className="bt-param-row" key={def.key}>
                  <label className="bt-param-label">{def.label}</label>
                  <input type="number" min="1" className="bt-param-input"
                    value={variant.parameters?.[def.key] || ''}
                    onChange={e => updateVariantParam(def.key, e.target.value)}
                    placeholder={def.placeholder}
                    disabled={connected}
                  />
                  <span className="bt-param-hint">{def.hint}</span>
                </div>
              ))}
            </div>
          )}

          <h3 className="section-title" style={{ marginTop: 16 }}>Instrument</h3>

          <form onSubmit={handleConnect}>
            <InstrumentPicker
              session={session}
              symbol={inst.symbol}
              exchange={inst.exchange}
              instrumentToken={inst.instrumentToken}
              onSelect={r => { setInst({ symbol: r.tradingSymbol, exchange: r.exchange, instrumentToken: String(r.instrumentToken) }); saveRecentInstrument(r); }}
              onChange={patch => setInst(p => ({ ...p, ...patch }))}
              disabled={connected}
            />
            <div className="form-group">
              <label>Subscription Mode</label>
              <select value={mode} onChange={e => setMode(e.target.value)} disabled={connected}>
                <option value="LTP">LTP — last price only</option>
                <option value="QUOTE">QUOTE — market quote</option>
                <option value="FULL">FULL — full depth</option>
              </select>
            </div>

            {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
            {!isActive && <div className="error-msg" style={{ marginBottom: 12 }}>No active session.</div>}

            <div style={{ display: 'flex', gap: 8 }}>
              {!connected ? (
                <button type="submit" className="btn-primary" disabled={!isActive || status === 'connecting'}>
                  {status === 'connecting' ? 'Connecting…' : '⬤ Connect Live'}
                </button>
              ) : (
                <button type="button" className="btn-danger" onClick={handleDisconnect}>✕ Disconnect</button>
              )}
            </div>
          </form>
        </div>
      </div>

      {/* Live feed */}
      <div className="bt-replay-feed">
        {/* Status + latest tick */}
        <div className="card bt-feed-status">
          <div className="bt-feed-status-row">
            <span className={`bt-status-pill bt-status-${status}`}>{status.toUpperCase()}</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Evaluator warming up: {evaluatorRef.current?.candlesSeen || 0} / {evaluatorRef.current?.warmupNeeded || '—'} ticks
            </span>
          </div>

          {latestTick && (
            <div className="bt-live-ticker">
              <span style={{ fontWeight: 700, fontSize: 18 }}>{latestTick.symbol}</span>
              <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>
                ₹{Number(latestTick.ltp).toFixed(2)}
              </span>
              <span style={{ fontSize: 13, color: changeColor }}>
                {latestTick.change >= 0 ? '+' : ''}{Number(latestTick.change).toFixed(2)}%
              </span>
              {latestTick.open && (
                <div className="bt-ohlc-row" style={{ marginTop: 6 }}>
                  {[['O', latestTick.open],['H', latestTick.high],['L', latestTick.low]].map(([l, v]) => (
                    <span key={l}><span className="meta-label">{l}</span> {Number(v).toFixed(2)}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Signal log */}
        {signals.length > 0 && (
          <div className="card" style={{ marginBottom: 12, padding: 0 }}>
            <div className="bt-feed-header"><span className="bt-params-label" style={{ margin: 0 }}>Signals</span></div>
            <div className="bt-signal-log">
              {signals.map((s, i) => (
                <div key={i} className="bt-signal-row bt-signal-actionable">
                  <span className="mono-sm" style={{ color: 'var(--text-muted)', minWidth: 56 }}>{s.ts}</span>
                  {signalBadge(s.signal)}
                  <span style={{ flex: 1, fontSize: 12 }}>{s.symbol}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>₹{Number(s.price).toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tick stream */}
        <div className="card" style={{ padding: 0 }}>
          <div className="bt-feed-header">
            <span className="bt-params-label" style={{ margin: 0 }}>Tick Stream</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ticks.length} ticks received</span>
          </div>
          <div className="bt-signal-log">
            {ticks.length === 0
              ? <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Ticks will appear here when connected to live data.</div>
              : ticks.map((t, i) => (
                <div key={i} className="bt-signal-row">
                  <span className="mono-sm" style={{ color: 'var(--text-muted)', minWidth: 56 }}>{t.ts}</span>
                  <span style={{ fontWeight: 600, fontSize: 12, minWidth: 80 }}>{t.symbol}</span>
                  <span style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 700 }}>₹{Number(t.ltp).toFixed(2)}</span>
                  {t.change !== undefined && (
                    <span style={{ fontSize: 11, color: Number(t.change) >= 0 ? '#22c55e' : '#ef4444' }}>
                      {Number(t.change) >= 0 ? '+' : ''}{Number(t.change).toFixed(2)}%
                    </span>
                  )}
                </div>
              ))
            }
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function signalBadge(signal) {
  const s = (signal || '').toUpperCase();
  if (s === 'BUY')  return <span className="badge badge-success">BUY</span>;
  if (s === 'SELL') return <span className="badge badge-danger">SELL</span>;
  return <span className="badge badge-muted">HOLD</span>;
}

// ─── Backtest Result Panel ────────────────────────────────────────────────────

function BacktestResultPanel({ result }) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const selected = result.results[selectedIdx];

  function fmt(v, digits = 2) {
    if (v == null) return '—';
    return typeof v === 'number' ? v.toFixed(digits) : String(v);
  }
  function fmtRs(v) {
    return v != null ? `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—';
  }

  return (
    <div style={{ marginTop: 28 }}>
      {/* Banner */}
      <div className="bt-banner card">
        <div>
          <span className="bt-banner-symbol">{result.symbol} / {result.exchange}</span>
          <span className="bt-banner-detail">
            {result.interval} · {result.totalCandles} candles · qty {result.resolvedQuantity} · {result.fromDate?.split('T')[0]} → {result.toDate?.split('T')[0]}
          </span>
        </div>
        {result.bestStrategyLabel && (
          <div className="bt-best-badge">
            <span className="bt-best-label">Best Strategy</span>
            <span className="bt-best-name">{result.bestStrategyLabel}</span>
          </div>
        )}
      </div>

      {/* Comparison table */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Strategy Comparison</h3>
        <div className="bt-compare-wrap">
          <table>
            <thead>
              <tr>
                <th></th>
                <th>Strategy</th>
                <th>Type</th>
                <th>Trades</th>
                <th>Win Rate</th>
                <th>Total PnL</th>
                <th>Return %</th>
                <th>Max DD %</th>
                <th>Profit Factor</th>
                <th>Sharpe</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((r, i) => {
                const m = r.metrics;
                const isBest = r.label === result.bestStrategyLabel;
                return (
                  <tr key={i} className={`bt-row ${i === selectedIdx ? 'bt-row-selected' : ''} ${isBest ? 'bt-row-best' : ''}`}
                    onClick={() => setSelectedIdx(i)} style={{ cursor: 'pointer' }}>
                    <td>{isBest && <span className="best-star">★</span>}</td>
                    <td style={{ fontWeight: 600 }}>{r.label}</td>
                    <td><span className="instance-type">{r.strategyType}</span></td>
                    <td>{m.totalTrades}</td>
                    <td className={m.winRate >= 50 ? 'text-success' : 'text-danger'}>{fmt(m.winRate)}%</td>
                    <td className={m.totalPnl >= 0 ? 'text-success' : 'text-danger'} style={{ fontWeight: 600 }}>{fmtRs(m.totalPnl)}</td>
                    <td className={m.totalReturnPct >= 0 ? 'text-success' : 'text-danger'}>{fmt(m.totalReturnPct)}%</td>
                    <td className={m.maxDrawdownPct > 20 ? 'text-danger' : ''}>{fmt(m.maxDrawdownPct)}%</td>
                    <td>{fmt(m.profitFactor)}</td>
                    <td className={m.sharpeRatio >= 1 ? 'text-success' : ''}>{fmt(m.sharpeRatio)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="field-hint" style={{ marginTop: 8 }}>Click a row to drill into metrics and trades.</div>
      </div>

      {/* Detailed metrics */}
      {selected && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 className="section-title">
            Detailed Metrics — <span style={{ color: 'var(--accent)' }}>{selected.label}</span>
            <span className="instance-type" style={{ marginLeft: 8 }}>{selected.strategyType}</span>
          </h3>
          <div className="bt-metrics-grid">
            {[
              ['Total Trades',    selected.metrics.totalTrades],
              ['Winning Trades',  selected.metrics.winningTrades],
              ['Losing Trades',   selected.metrics.losingTrades],
              ['Win Rate',        fmt(selected.metrics.winRate) + '%'],
              ['Total PnL',       fmtRs(selected.metrics.totalPnl)],
              ['Initial Capital', fmtRs(selected.metrics.initialCapital)],
              ['Final Capital',   fmtRs(selected.metrics.finalCapital)],
              ['Total Return',    fmt(selected.metrics.totalReturnPct) + '%'],
              ['Max Drawdown',    fmt(selected.metrics.maxDrawdownPct) + '%'],
              ['Profit Factor',   fmt(selected.metrics.profitFactor)],
              ['Avg Win',         fmtRs(selected.metrics.avgWin)],
              ['Avg Loss',        fmtRs(selected.metrics.avgLoss)],
              ['Best Trade',      fmtRs(selected.metrics.bestTrade)],
              ['Worst Trade',     fmtRs(selected.metrics.worstTrade)],
              ['Sharpe Ratio',    fmt(selected.metrics.sharpeRatio)],
              ['Warmup Candles',  selected.metrics.warmupCandles],
            ].map(([label, val]) => (
              <div key={label} className="bt-metric-cell">
                <span className="bt-metric-label">{label}</span>
                <span className="bt-metric-val">{val}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trade list */}
      {selected?.trades?.length > 0 && (
        <div className="card">
          <h3 className="section-title">Trades — {selected.label} ({selected.trades.length} total)</h3>
          <div className="bt-trades-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Entry Time</th><th>Exit Time</th>
                  <th>Entry Price</th><th>Exit Price</th><th>Qty</th>
                  <th>PnL</th><th>Return %</th><th>Capital After</th>
                </tr>
              </thead>
              <tbody>
                {selected.trades.map((t, i) => (
                  <tr key={i} className={t.pnl >= 0 ? 'trade-win' : 'trade-loss'}>
                    <td className="mono-sm">{i + 1}</td>
                    <td className="mono-sm">{t.entryTime ? new Date(t.entryTime).toLocaleString() : '—'}</td>
                    <td className="mono-sm">{t.exitTime  ? new Date(t.exitTime).toLocaleString()  : '—'}</td>
                    <td>{fmtRs(t.entryPrice)}</td>
                    <td>{fmtRs(t.exitPrice)}</td>
                    <td>{t.quantity}</td>
                    <td className={t.pnl >= 0 ? 'text-success' : 'text-danger'} style={{ fontWeight: 600 }}>{fmtRs(t.pnl)}</td>
                    <td className={t.pnlPct >= 0 ? 'text-success' : 'text-danger'}>{fmt(t.pnlPct)}%</td>
                    <td>{fmtRs(t.runningCapital)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
