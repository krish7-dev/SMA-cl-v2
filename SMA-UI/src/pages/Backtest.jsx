import { useState, useEffect, useRef } from 'react';
import {
  getStrategyTypes, runBacktest,
  liveSubscribe, liveUnsubscribe, liveConnect, liveStatus,
  getLiveSnapshot, deleteLiveSnapshot,
  searchInstruments, fetchHistoricalData,
  startReplayEval,
  startLiveEval, stopLiveEval,
  startOptionsReplayEval,
} from '../services/api';
import { createChart, CandlestickSeries, LineSeries, createSeriesMarkers, CrosshairMode, LineStyle } from 'lightweight-charts';
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


// Fixed strategy entries — all strategies always shown, each with an enabled toggle
function defaultStrategies() {
  return ALL_STRATEGY_TYPES.map(type => ({
    strategyType: type,
    enabled: true,
    label: '',
    allowShorting: true,
    parameters: defaultParams(type),
  }));
}

const EMPTY_DATA_CTX = {
  symbol: '', exchange: 'NSE', instrumentToken: '', instrumentType: 'STOCK',
  interval: 'DAY', fromDate: '', toDate: '',
  initialCapital: '100000', quantity: '0', product: 'CNC',
};

const EMPTY_INST = { symbol: '', exchange: 'NSE', instrumentToken: '', instrumentType: 'STOCK' };

function deriveInstrumentType(kiteType) {
  return ['CE', 'PE'].includes(kiteType) ? 'OPTION' : 'STOCK';
}

/** Resolve instrument type: explicit value → exchange-based → symbol pattern fallback. */
function resolveInstrType(instrumentType, symbol, exchange) {
  if (instrumentType === 'OPTION') return 'OPTION';
  if (instrumentType === 'STOCK')  return 'STOCK';
  // Exchange is the most reliable indicator: NFO/BFO = derivatives
  const ex = (exchange || '').toUpperCase();
  if (ex === 'NFO' || ex === 'BFO') return 'OPTION';
  // Fallback: symbol ending with digits+CE/PE (e.g. NIFTY24000PE)
  if (/\d(CE|PE)$/i.test(symbol || '')) return 'OPTION';
  return 'STOCK';
}

const EMPTY_RISK = {
  enabled: false,
  stopLossPct: '2',
  takeProfitPct: '4',
  maxRiskPerTradePct: '1',
  dailyLossCapPct: '5',
  cooldownCandles: '3',
};

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

// ─── Candle pattern definitions ─────────────────────────────────────────────────

const BUY_PATTERNS = [
  { id: 'HAMMER',           label: 'Hammer'              },
  { id: 'BULLISH_ENGULFING',label: 'Bullish Engulfing'   },
  { id: 'MORNING_STAR',     label: 'Morning Star'        },
  { id: 'DOJI_BULLISH',     label: 'Doji (after bearish)'},
];
const SELL_PATTERNS = [
  { id: 'SHOOTING_STAR',    label: 'Shooting Star'       },
  { id: 'BEARISH_ENGULFING',label: 'Bearish Engulfing'   },
  { id: 'EVENING_STAR',     label: 'Evening Star'        },
  { id: 'DOJI_BEARISH',     label: 'Doji (after bullish)'},
];

const EMPTY_PATTERN = {
  enabled: false, minWickRatio: '2', maxBodyPct: '0.35',
  buyConfirmPatterns: [], sellConfirmPatterns: [],
};

const PATTERN_LABELS = {
  HAMMER: 'Hammer', SHOOTING_STAR: 'Shooting Star',
  BULLISH_ENGULFING: 'Bullish Engulf', BEARISH_ENGULFING: 'Bearish Engulf',
  MORNING_STAR: 'Morning Star', EVENING_STAR: 'Evening Star',
  DOJI: 'Doji', DOJI_BULLISH: 'Doji↑', DOJI_BEARISH: 'Doji↓',
};

const REGIMES = ['TRENDING', 'RANGING', 'VOLATILE', 'COMPRESSION'];
// Default regime suitability — auto-assigned when Market Regime Detection is ON
const STRATEGY_REGIME_MAP = {
  SMA_CROSSOVER:       ['TRENDING'],
  EMA_CROSSOVER:       ['TRENDING'],
  MACD:                ['TRENDING', 'VOLATILE'],
  RSI:                 ['RANGING'],
  RSI_REVERSAL:        ['RANGING', 'VOLATILE'],
  BREAKOUT:            ['VOLATILE', 'COMPRESSION'],
  VWAP_PULLBACK:       ['TRENDING'],
  BOLLINGER_REVERSION: ['RANGING', 'COMPRESSION'],
  LIQUIDITY_SWEEP:     ['VOLATILE'],
  CANDLE_PATTERN:      ['RANGING', 'VOLATILE'],
};
// Weights per strategy: how much each score component matters (0–1, sum ≈ 1)
const STRATEGY_SCORE_WEIGHTS = {
  SMA_CROSSOVER:       { trend: 0.50, volatility: 0.10, momentum: 0.30, confidence: 0.10 },
  EMA_CROSSOVER:       { trend: 0.50, volatility: 0.10, momentum: 0.30, confidence: 0.10 },
  MACD:                { trend: 0.35, volatility: 0.25, momentum: 0.30, confidence: 0.10 },
  RSI:                 { trend: 0.15, volatility: 0.15, momentum: 0.60, confidence: 0.10 },
  RSI_REVERSAL:        { trend: 0.10, volatility: 0.25, momentum: 0.55, confidence: 0.10 },
  BREAKOUT:            { trend: 0.20, volatility: 0.50, momentum: 0.20, confidence: 0.10 },
  VWAP_PULLBACK:       { trend: 0.40, volatility: 0.20, momentum: 0.30, confidence: 0.10 },
  BOLLINGER_REVERSION: { trend: 0.10, volatility: 0.30, momentum: 0.50, confidence: 0.10 },
  LIQUIDITY_SWEEP:     { trend: 0.10, volatility: 0.60, momentum: 0.20, confidence: 0.10 },
  CANDLE_PATTERN:      { trend: 0.15, volatility: 0.35, momentum: 0.40, confidence: 0.10 },
};
const COMBINED_LABEL = '⚡ Combined';
const EMPTY_REGIME_CONFIG = {
  enabled: false,
  adxPeriod: 14,
  atrPeriod: 14,
  adxTrendThreshold: 25,
  atrVolatilePct: 2.0,
  atrCompressionPct: 0.5,
};

const EMPTY_SCORE_CONFIG = {
  enabled: false,
  minScoreThreshold: 30,
};

// ── Trading Rules ──────────────────────────────────────────────────────────
const EMPTY_RULES_CONFIG = {
  enabled: true,
  stocks: {
    ranging_no_trade:        { enabled: true,  label: 'No trade in RANGING regime' },
    compression_short_only:  { enabled: true,  label: 'SHORT only in COMPRESSION regime' },
    long_quality_gate:       { enabled: true,  label: 'LONG requires min score + no recent reversal + within VWAP', scoreMin: 60, vwapMaxPct: 1.5 },
    no_same_candle_reversal: { enabled: true,  label: 'No same-candle reversal' },
  },
  options: {
    volatile_no_trade:       { enabled: true,  label: 'No trade in VOLATILE regime' },
    disable_sma_breakout:    { enabled: true,  label: 'Disable SMA_CROSSOVER and BREAKOUT' },
    use_only_specific:       { enabled: true,  label: 'Use only VWAP_PULLBACK / LIQUIDITY_SWEEP / BOLLINGER_REVERSION' },
    no_same_candle_reversal: { enabled: true,  label: 'No same-candle reversal' },
    distrust_high_vol_score: { enabled: true,  label: 'Distrust scores driven by high volatility', volScoreMax: 70 },
  },
};

const EMPTY_ENTRY_FILTER_CONFIG = {
  enabled: false,
  scoreGap: {
    label: 'Min Score Gap (winner − second)',
    description: 'Skip entry if winner score is too close to next best',
    stocks:  { enabled: false },
    options: { enabled: false },
    minGap: 2,
  },
  cooldown: {
    label: 'Cooldown (bars since last trade)',
    description: 'Skip entry if a trade just closed recently',
    stocks:  { enabled: false },
    options: { enabled: false },
    minBars: 3,
  },
  vwapExtension: {
    label: 'VWAP Extension Filter',
    description: 'Skip if price is overextended from VWAP',
    stocks:  { enabled: false },
    options: { enabled: false },
    maxDistPct: 1.5,
  },
  strategyFilter: {
    label: 'Strategy Allowlist',
    description: 'Block specific strategies from triggering combined entries',
    stocks:  { enabled: false },
    options: { enabled: false },
    blocked: 'SMA_CROSSOVER, EMA_CROSSOVER, MACD',
  },
  confidenceGate: {
    label: 'Confidence Gate (with exception)',
    description: 'Skip low-gap entries unless from a trusted strategy',
    stocks:  { enabled: false },
    options: { enabled: false },
    minGap: 3,
    exceptionStrategy: 'LIQUIDITY_SWEEP',
  },
};

class LocalCandlePatternEvaluator {
  constructor(pattern, minWickRatio, maxBodyPct) {
    this.pattern      = (pattern      || 'HAMMER').toUpperCase().trim();
    this.minWickRatio = parseFloat(minWickRatio) || 2.0;
    this.maxBodyPct   = parseFloat(maxBodyPct)   || 0.35;
    this.window       = []; // [{open, high, low, close}]
  }

  // Replay passes (close, high, low, volume, open); Live passes only (ltp)
  next(close, high, low, _volume, open) {
    const c = parseFloat(close), h = parseFloat(high), l = parseFloat(low), o = parseFloat(open);
    if (isNaN(c) || isNaN(h) || isNaN(l) || isNaN(o)) {
      return 'HOLD'; // Live tab (LTP only) — candle patterns need OHLC
    }
    const win = this.window;
    let signal = 'HOLD';
    switch (this.pattern) {
      case 'HAMMER':            signal = this._hammer(o, h, l, c);                           break;
      case 'SHOOTING_STAR':     signal = this._shootingStar(o, h, l, c);                     break;
      case 'BULLISH_ENGULFING': if (win.length >= 1) signal = this._bullishEngulfing(win[win.length-1], o, c); break;
      case 'BEARISH_ENGULFING': if (win.length >= 1) signal = this._bearishEngulfing(win[win.length-1], o, c); break;
      case 'DOJI_REVERSAL':     if (win.length >= 1) signal = this._dojiReversal(win[win.length-1], o, h, l, c); break;
      case 'MORNING_STAR':      if (win.length >= 2) signal = this._morningStar(win[win.length-2], win[win.length-1], o, c); break;
      case 'EVENING_STAR':      if (win.length >= 2) signal = this._eveningStar(win[win.length-2], win[win.length-1], o, c); break;
    }
    this.window.push({ open: o, high: h, low: l, close: c });
    if (this.window.length > 3) this.window.shift();
    return signal;
  }

  _hammer(open, high, low, close) {
    const range = high - low;
    if (range < 1e-9) return 'HOLD';
    const body      = Math.abs(close - open);
    const lowerWick = Math.min(open, close) - low;
    const upperWick = high - Math.max(open, close);
    if (body / range <= this.maxBodyPct &&
        (body < 1e-9 ? lowerWick > 0 : lowerWick >= this.minWickRatio * body) &&
        upperWick <= lowerWick * 0.5 + 1e-9) return 'BUY';
    return 'HOLD';
  }

  _shootingStar(open, high, low, close) {
    const range = high - low;
    if (range < 1e-9) return 'HOLD';
    const body      = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    if (body / range <= this.maxBodyPct &&
        (body < 1e-9 ? upperWick > 0 : upperWick >= this.minWickRatio * body) &&
        lowerWick <= upperWick * 0.5 + 1e-9) return 'SELL';
    return 'HOLD';
  }

  _bullishEngulfing(prev, open, close) {
    const prevBearish = prev.close < prev.open;
    const currBullish = close > open;
    const engulfs     = open <= prev.close && close >= prev.open;
    return (prevBearish && currBullish && engulfs) ? 'BUY' : 'HOLD';
  }

  _bearishEngulfing(prev, open, close) {
    const prevBullish = prev.close > prev.open;
    const currBearish = close < open;
    const engulfs     = open >= prev.close && close <= prev.open;
    return (prevBullish && currBearish && engulfs) ? 'SELL' : 'HOLD';
  }

  _dojiReversal(prev, open, high, low, close) {
    const range = high - low;
    if (range < 1e-9) return 'HOLD';
    const body = Math.abs(close - open);
    if (body / range > 0.05) return 'HOLD';
    if (prev.close < prev.open) return 'BUY';
    if (prev.close > prev.open) return 'SELL';
    return 'HOLD';
  }

  _morningStar(c0, c1, open, close) {
    if (!c0 || !c1) return 'HOLD';
    const c0Bearish = c0.close < c0.open;
    const c1Range   = c1.high - c1.low;
    const c1Body    = Math.abs(c1.close - c1.open);
    const c1Small   = c1Range < 1e-9 || c1Body / c1Range <= this.maxBodyPct;
    const c2Bullish = close > open;
    const midpoint  = (c0.open + c0.close) / 2;
    return (c0Bearish && c1Small && c2Bullish && close > midpoint) ? 'BUY' : 'HOLD';
  }

  _eveningStar(c0, c1, open, close) {
    if (!c0 || !c1) return 'HOLD';
    const c0Bullish = c0.close > c0.open;
    const c1Range   = c1.high - c1.low;
    const c1Body    = Math.abs(c1.close - c1.open);
    const c1Small   = c1Range < 1e-9 || c1Body / c1Range <= this.maxBodyPct;
    const c2Bearish = close < open;
    const midpoint  = (c0.open + c0.close) / 2;
    return (c0Bullish && c1Small && c2Bearish && close < midpoint) ? 'SELL' : 'HOLD';
  }

  reset() { this.window = []; }
  get warmupNeeded() {
    const p = this.pattern;
    if (p === 'MORNING_STAR' || p === 'EVENING_STAR')                             return 3;
    if (p === 'BULLISH_ENGULFING' || p === 'BEARISH_ENGULFING' || p === 'DOJI_REVERSAL') return 2;
    return 1;
  }
  get candlesSeen() { return this.window.length; }
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

// ─── Candle interval → milliseconds ──────────────────────────────────────────
const INTERVAL_MS = {
  MINUTE_1: 60_000, MINUTE_3: 180_000, MINUTE_5: 300_000,
  MINUTE_10: 600_000, MINUTE_15: 900_000, MINUTE_30: 1_800_000,
  MINUTE_60: 3_600_000, DAY: 86_400_000,
};

// ─── Local regime detector (mirrors Java MarketRegimeDetector) ────────────────
class LocalRegimeDetector {
  constructor(adxPeriod=14, atrPeriod=14, adxTrendThreshold=25, atrVolatilePct=2, atrCompressionPct=0.5) {
    this.adxPeriod = adxPeriod; this.atrPeriod = atrPeriod;
    this.adxTrendThreshold = adxTrendThreshold;
    this.atrVolatilePct = atrVolatilePct; this.atrCompressionPct = atrCompressionPct;
    this.H = []; this.L = []; this.C = [];
  }
  addCandle(high, low, close) {
    this.H.push(high); this.L.push(low); this.C.push(close);
    const keep = this.adxPeriod * 4;
    if (this.H.length > keep) { this.H.shift(); this.L.shift(); this.C.shift(); }
    return this._detect();
  }
  reset() { this.H = []; this.L = []; this.C = []; }
  _smooth(arr, p) {
    if (arr.length < p) return arr.map(() => 0);
    const r = new Array(arr.length).fill(0);
    let s = 0; for (let i = 0; i < p; i++) s += arr[i]; r[p-1] = s/p;
    for (let i = p; i < arr.length; i++) r[i] = (r[i-1]*(p-1)+arr[i])/p;
    return r;
  }
  _detect() {
    const { H, L, C, adxPeriod: p, atrPeriod: ap } = this;
    const n = C.length;
    if (n < p * 2) return 'RANGING';
    const trs = [], pdms = [], mdms = [];
    for (let i = 1; i < n; i++) {
      trs.push(Math.max(H[i]-L[i], Math.abs(H[i]-C[i-1]), Math.abs(L[i]-C[i-1])));
      const up = H[i]-H[i-1], dn = L[i-1]-L[i];
      pdms.push(up > dn && up > 0 ? up : 0);
      mdms.push(dn > up && dn > 0 ? dn : 0);
    }
    const sTR  = this._smooth(trs, p);
    const sPDM = this._smooth(pdms, p);
    const sMDM = this._smooth(mdms, p);
    const dxs  = sTR.map((tr, i) => {
      if (tr === 0) return 0;
      const pdi = sPDM[i]/tr*100, mdi = sMDM[i]/tr*100, sum = pdi+mdi;
      return sum === 0 ? 0 : Math.abs(pdi-mdi)/sum*100;
    });
    const adx = this._smooth(dxs, p);
    const lastAdx = adx[adx.length-1];
    const atrArr  = this._smooth(trs.slice(-Math.max(ap*3, trs.length)), ap);
    const atrPct  = (atrArr[atrArr.length-1] / C[C.length-1]) * 100;
    if (atrPct > this.atrVolatilePct)    return 'VOLATILE';
    if (atrPct < this.atrCompressionPct) return 'COMPRESSION';
    if (lastAdx >= this.adxTrendThreshold) return 'TRENDING';
    return 'RANGING';
  }
}

/**
 * Score-based strategy selector for the ⚡ Combined pool.
 * Computes trendStrength (ADX proxy), volatility (ATR%), direction-aware momentum (ROC),
 * and a regime-confidence bonus, then weights them per-strategy to pick the best fit.
 */
// Per-strategy penalty for instrument type mismatch
const STRATEGY_INSTRUMENT_MISMATCH = {
  SMA_CROSSOVER: { OPTION: 30 },
  EMA_CROSSOVER: { OPTION: 25 },
  MACD:          { OPTION: 15 },
  RSI:           { OPTION: 10 },
  RSI_REVERSAL:  { OPTION: 15 },
  BREAKOUT:      { OPTION: 20 },
};

class LocalStrategyScorer {
  constructor(adxPeriod = 14, atrPeriod = 14, rocPeriod = 10) {
    this.adxPeriod = adxPeriod;
    this.atrPeriod = atrPeriod;
    this.rocPeriod = rocPeriod;
    this.H = []; this.L = []; this.C = [];
  }

  addCandle(high, low, close) {
    this.H.push(parseFloat(high));
    this.L.push(parseFloat(low));
    this.C.push(parseFloat(close));
    const keep = Math.max(this.adxPeriod, this.atrPeriod, this.rocPeriod) * 4;
    if (this.H.length > keep) { this.H.shift(); this.L.shift(); this.C.shift(); }
  }

  reset() { this.H = []; this.L = []; this.C = []; }

  _smooth(arr, p) {
    if (arr.length < p) return arr.map(() => 0);
    const r = new Array(arr.length).fill(0);
    let s = 0; for (let i = 0; i < p; i++) s += arr[i]; r[p-1] = s / p;
    for (let i = p; i < arr.length; i++) r[i] = (r[i-1] * (p-1) + arr[i]) / p;
    return r;
  }

  /** trendStrength: 0–100 (ADX-based) */
  _trendStrength() {
    const { H, L, C, adxPeriod: p } = this;
    const n = C.length;
    if (n < p * 2) return 0;
    const trs = [], pdms = [], mdms = [];
    for (let i = 1; i < n; i++) {
      trs.push(Math.max(H[i]-L[i], Math.abs(H[i]-C[i-1]), Math.abs(L[i]-C[i-1])));
      const up = H[i]-H[i-1], dn = L[i-1]-L[i];
      pdms.push(up > dn && up > 0 ? up : 0);
      mdms.push(dn > up && dn > 0 ? dn : 0);
    }
    const sTR = this._smooth(trs, p), sPDM = this._smooth(pdms, p), sMDM = this._smooth(mdms, p);
    const dxs = sTR.map((tr, i) => {
      if (tr === 0) return 0;
      const pdi = sPDM[i]/tr*100, mdi = sMDM[i]/tr*100, sum = pdi + mdi;
      return sum === 0 ? 0 : Math.abs(pdi-mdi)/sum*100;
    });
    const adx = this._smooth(dxs, p);
    return Math.min(adx[adx.length-1], 100);
  }

  /** volatility: 0–100 (ATR% of price, scaled so 5% ATR ≈ 100) */
  _volatility() {
    const { H, L, C, atrPeriod: ap } = this;
    const n = C.length;
    if (n < 2) return 0;
    const trs = [];
    for (let i = 1; i < n; i++) {
      trs.push(Math.max(H[i]-L[i], Math.abs(H[i]-C[i-1]), Math.abs(L[i]-C[i-1])));
    }
    const atr = this._smooth(trs, ap);
    const atrPct = (atr[atr.length-1] / C[C.length-1]) * 100;
    return Math.min(atrPct / 5 * 100, 100); // 5% ATR → 100
  }

  /**
   * momentum: 0–100, direction-aware.
   * BUY signal → high ROC is good; SELL signal → negative ROC (falling) is good.
   */
  _momentum(signal) {
    const { C, rocPeriod: rp } = this;
    if (C.length < rp + 1) return 50;
    const roc = (C[C.length-1] - C[C.length-1-rp]) / C[C.length-1-rp] * 100;
    if (signal === 'BUY')  return Math.min(Math.max((roc + 5) / 10 * 100, 0), 100);
    if (signal === 'SELL') return Math.min(Math.max((-roc + 5) / 10 * 100, 0), 100);
    return 50;
  }

  /**
   * confidence: 0–25 bonus when strategy's preferred regimes include the current regime.
   */
  _confidence(strategyType, regime) {
    if (!regime) return 0;
    const preferred = STRATEGY_REGIME_MAP[strategyType] || [];
    return preferred.includes(regime) ? 25 : 0;
  }

  // ── Quality Penalties ──────────────────────────────────────────────────

  /**
   * reversalPenalty: penalise whipsaw. Detects sign-flips in recent close-to-close moves.
   * Most-recent flip = 20, multiple flips in last 5 candles = 25.
   */
  _reversalPenalty() {
    const { C } = this;
    const n = C.length;
    if (n < 4) return 0;
    const diffs = [];
    for (let i = Math.max(1, n - 5); i < n; i++) diffs.push(C[i] - C[i-1]);
    let flips = 0;
    for (let i = 1; i < diffs.length; i++) {
      if (diffs[i] * diffs[i-1] < 0) flips++;
    }
    const lastFlip = diffs.length >= 2 && diffs[diffs.length-1] * diffs[diffs.length-2] < 0;
    if (lastFlip && flips >= 2) return 25;
    if (lastFlip)  return 20;
    if (flips >= 2) return 12;
    return 0;
  }

  /**
   * overextensionPenalty: penalise entering when price is stretched from VWAP proxy.
   * Uses equal-weighted typical-price mean over last 50 candles as VWAP proxy.
   * Only penalises when signal is chasing the extension (BUY above VWAP, SELL below).
   */
  _overextensionPenalty(signal) {
    const { H, L, C } = this;
    const n = C.length;
    if (n < 10) return 0;
    const start = Math.max(0, n - 50);
    let sumTP = 0;
    for (let i = start; i < n; i++) sumTP += (H[i] + L[i] + C[i]) / 3;
    const vwap = sumTP / (n - start);
    const pctDev = (C[n-1] - vwap) / vwap * 100;
    // Only penalise when chasing the extension direction
    if (signal === 'BUY'  && pctDev <= 0) return 0;
    if (signal === 'SELL' && pctDev >= 0) return 0;
    const absPct = Math.abs(pctDev);
    if (absPct > 2.0) return 30;
    if (absPct > 1.5) return 22;
    if (absPct > 1.0) return 15;
    if (absPct > 0.5) return 8;
    return 0;
  }

  /**
   * sameColorPenalty: penalise entering after 3+ consecutive same-direction candles
   * (chasing exhausted moves). Uses close-to-close direction as candle colour proxy.
   */
  _sameColorPenalty(signal) {
    const { C } = this;
    const n = C.length;
    if (n < 4) return 0;
    const lastUp = C[n-1] > C[n-2];
    // Only penalise when signal chases the streak
    if (signal === 'BUY'  && !lastUp) return 0;
    if (signal === 'SELL' &&  lastUp) return 0;
    let streak = 1;
    for (let i = n - 2; i >= 1; i--) {
      if ((C[i] > C[i-1]) === lastUp) streak++;
      else break;
    }
    if (streak >= 5) return 30;
    if (streak >= 4) return 20;
    if (streak >= 3) return 12;
    return 0;
  }

  /**
   * instrumentMismatchPenalty: slow trend-following strategies perform poorly on options;
   * penalise those pairings.
   */
  _instrumentMismatchPenalty(strategyType, instrType) {
    return STRATEGY_INSTRUMENT_MISMATCH[strategyType]?.[instrType] || 0;
  }

  /**
   * volatileOptionPenalty: VOLATILE regime on options is the highest-risk combination —
   * options pricing becomes unreliable and spreads widen.
   */
  _volatileOptionPenalty(regime, instrType) {
    return (instrType === 'OPTION' && regime === 'VOLATILE') ? 35 : 0;
  }

  /**
   * Compute final score for a strategy given its signal, regime, and instrument type.
   * finalScore = max(0, baseScore - penalties)
   * Returns full breakdown including all penalty components.
   */
  score(strategyType, signal, regime, instrType = 'STOCK') {
    const w = STRATEGY_SCORE_WEIGHTS[strategyType] || { trend: 0.25, volatility: 0.25, momentum: 0.25, confidence: 0.25 };
    const trendStrength = this._trendStrength();
    const volatility    = this._volatility();
    const momentum      = this._momentum(signal);
    const confidence    = this._confidence(strategyType, regime);
    const baseScore     = w.trend * trendStrength + w.volatility * volatility + w.momentum * momentum + w.confidence * confidence;

    const reversalPenalty          = this._reversalPenalty();
    const overextensionPenalty     = this._overextensionPenalty(signal);
    const sameColorPenalty         = this._sameColorPenalty(signal);
    const instrumentMismatchPenalty = this._instrumentMismatchPenalty(strategyType, instrType);
    const volatileOptionPenalty    = this._volatileOptionPenalty(regime, instrType);
    const totalPenalty = reversalPenalty + overextensionPenalty + sameColorPenalty + instrumentMismatchPenalty + volatileOptionPenalty;
    const total = Math.max(0, baseScore - totalPenalty);

    return {
      total, baseScore, trendStrength, volatility, momentum, confidence,
      reversalPenalty, overextensionPenalty, sameColorPenalty,
      instrumentMismatchPenalty, volatileOptionPenalty, totalPenalty,
    };
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
          ['backtest',        'Historical Backtest'],
          ['replay',          'Replay Test'],
          ['live',            'Live Test'],
          ['options-replay',  'Options Replay Test'],
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

      {tab === 'backtest'       && <HistoricalBacktest />}
      {tab === 'replay'         && <ReplayTest />}
      {tab === 'live'           && <LiveTest />}
      {tab === 'options-replay' && <OptionsReplayTest />}
    </div>
  );
}

// ─── Tab 1: Historical Backtest ───────────────────────────────────────────────

function HistoricalBacktest() {
  const { session, isActive } = useSession();

  const [strategies, setStrategies] = useState(defaultStrategies);
  const [dataCtx, setDataCtx]       = useState({ ...EMPTY_DATA_CTX });
  const [riskConfig, setRiskConfig]         = useState({ ...EMPTY_RISK });
  const [patternConfig, setPatternConfig]   = useState({ ...EMPTY_PATTERN });
  const [regimeConfig, setRegimeConfig]     = useState({ ...EMPTY_REGIME_CONFIG });
  const [scoreConfig, setScoreConfig]       = useState({ ...EMPTY_SCORE_CONFIG });
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

  function updateRisk(key, value) {
    setRiskConfig(p => ({ ...p, [key]: value }));
  }

  function updatePattern(key, value) {
    setPatternConfig(p => ({ ...p, [key]: value }));
  }

  function togglePatternConfirm(listKey, patternId) {
    setPatternConfig(p => {
      const cur = p[listKey] || [];
      return {
        ...p,
        [listKey]: cur.includes(patternId)
          ? cur.filter(x => x !== patternId)
          : [...cur, patternId],
      };
    });
  }

  function updateRegime(key, value) {
    setRegimeConfig(p => ({ ...p, [key]: value }));
  }


  function applyPreset(days) {
    const { fromDate, toDate } = datePreset(days);
    setDataCtx(p => ({ ...p, fromDate, toDate }));
  }

  function handleInstrumentSelect(inst) {
    setDataCtx(p => ({ ...p, symbol: inst.tradingSymbol, exchange: inst.exchange, instrumentToken: String(inst.instrumentToken), instrumentType: deriveInstrumentType(inst.instrumentType) }));
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
          activeRegimes: regimeConfig.enabled
            ? (STRATEGY_REGIME_MAP[s.strategyType] || [])
            : undefined,
        })),
        riskConfig: riskConfig.enabled ? {
          enabled:            true,
          stopLossPct:        parseFloat(riskConfig.stopLossPct)        || null,
          takeProfitPct:      parseFloat(riskConfig.takeProfitPct)      || null,
          maxRiskPerTradePct: parseFloat(riskConfig.maxRiskPerTradePct) || null,
          dailyLossCapPct:    parseFloat(riskConfig.dailyLossCapPct)    || null,
          cooldownCandles:    parseInt(riskConfig.cooldownCandles, 10)  || 0,
        } : null,
        patternConfig: patternConfig.enabled ? {
          enabled:             true,
          minWickRatio:        parseFloat(patternConfig.minWickRatio) || 2,
          maxBodyPct:          parseFloat(patternConfig.maxBodyPct)   || 0.35,
          buyConfirmPatterns:  patternConfig.buyConfirmPatterns,
          sellConfirmPatterns: patternConfig.sellConfirmPatterns,
        } : null,
        regimeConfig: regimeConfig.enabled ? {
          enabled:            true,
          adxPeriod:          parseInt(regimeConfig.adxPeriod, 10)          || 14,
          atrPeriod:          parseInt(regimeConfig.atrPeriod, 10)          || 14,
          adxTrendThreshold:  parseFloat(regimeConfig.adxTrendThreshold)    || 25,
          atrVolatilePct:     parseFloat(regimeConfig.atrVolatilePct)       || 2.0,
          atrCompressionPct:  parseFloat(regimeConfig.atrCompressionPct)    || 0.5,
        } : undefined,
        scoreConfig: scoreConfig.enabled ? {
          enabled:            true,
          minScoreThreshold:  parseFloat(scoreConfig.minScoreThreshold) || 30,
        } : undefined,
        instrumentType: resolveInstrType(dataCtx.instrumentType, dataCtx.symbol, dataCtx.exchange),
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

              {/* Auto-assigned regimes (shown when regime detection is enabled) */}
              {regimeConfig.enabled && (
                <div className="bt-params-block" style={{ marginTop: 8, opacity: s.enabled ? 1 : 0.5 }}>
                  <div className="bt-params-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    Active Regimes
                    <span className="bt-regime-auto-tag">auto</span>
                  </div>
                  <div className="bt-regime-regimes">
                    {(STRATEGY_REGIME_MAP[s.strategyType] || []).length > 0
                      ? (STRATEGY_REGIME_MAP[s.strategyType] || []).map(r => (
                          <span key={r} className={`bt-regime-badge bt-regime-${r}`}>{r}</span>
                        ))
                      : <span className="field-hint">All regimes (no mapping defined)</span>
                    }
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Risk Management */}
      <div className="bt-section-label" style={{ marginTop: 28 }}>
        <span className="bt-section-title">Risk Management</span>
        <span className="bt-section-sub">
          {riskConfig.enabled
            ? `ON — SL ${riskConfig.stopLossPct}%, TP ${riskConfig.takeProfitPct}%, risk ${riskConfig.maxRiskPerTradePct}%/trade`
            : 'OFF — signal-only mode, all trades taken'}
        </span>
      </div>
      <div className="card bt-risk-card">
        <div className="bt-risk-toggle-row">
          <span className="bt-risk-label">Risk Management</span>
          <button type="button"
            className={riskConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
            onClick={() => updateRisk('enabled', !riskConfig.enabled)}>
            {riskConfig.enabled ? 'ON' : 'OFF'}
          </button>
          {!riskConfig.enabled && (
            <span className="bt-risk-hint">Enable to apply stop-loss, take-profit, position sizing, and daily loss limits</span>
          )}
        </div>
        {riskConfig.enabled && (
          <div className="bt-risk-fields">
            <div className="form-group">
              <label>Stop-Loss % <span className="form-hint">(0 = off)</span></label>
              <input type="number" min="0" max="100" step="0.1" value={riskConfig.stopLossPct}
                onChange={e => updateRisk('stopLossPct', e.target.value)} />
              <small className="bt-risk-hint">Exit when candle low drops this % below entry</small>
            </div>
            <div className="form-group">
              <label>Take-Profit % <span className="form-hint">(0 = off)</span></label>
              <input type="number" min="0" step="0.1" value={riskConfig.takeProfitPct}
                onChange={e => updateRisk('takeProfitPct', e.target.value)} />
              <small className="bt-risk-hint">Exit when candle high rises this % above entry</small>
            </div>
            <div className="form-group">
              <label>Max Risk / Trade % <span className="form-hint">(0 = use qty)</span></label>
              <input type="number" min="0" max="100" step="0.1" value={riskConfig.maxRiskPerTradePct}
                onChange={e => updateRisk('maxRiskPerTradePct', e.target.value)} />
              <small className="bt-risk-hint">% of capital to risk per trade — sizes position via SL</small>
            </div>
            <div className="form-group">
              <label>Daily Loss Cap % <span className="form-hint">(0 = off)</span></label>
              <input type="number" min="0" max="100" step="0.1" value={riskConfig.dailyLossCapPct}
                onChange={e => updateRisk('dailyLossCapPct', e.target.value)} />
              <small className="bt-risk-hint">Halt new entries when day's loss exceeds this % of capital</small>
            </div>
            <div className="form-group">
              <label>Cooldown After Loss <span className="form-hint">(candles)</span></label>
              <input type="number" min="0" step="1" value={riskConfig.cooldownCandles}
                onChange={e => updateRisk('cooldownCandles', e.target.value)} />
              <small className="bt-risk-hint">Skip this many candles after a losing trade</small>
            </div>
          </div>
        )}
      </div>

      {/* Pattern Confirmation */}
      <div className="bt-section-label" style={{ marginTop: 28 }}>
        <span className="bt-section-title">Candle Pattern Confirmation</span>
        <span className="bt-section-sub">
          {patternConfig.enabled
            ? `ON — BUY needs: ${patternConfig.buyConfirmPatterns.length ? patternConfig.buyConfirmPatterns.map(p => PATTERN_LABELS[p] || p).join(', ') : 'any'} · SELL needs: ${patternConfig.sellConfirmPatterns.length ? patternConfig.sellConfirmPatterns.map(p => PATTERN_LABELS[p] || p).join(', ') : 'any'}`
            : 'OFF — patterns detected and shown in trades, no signal filter'}
        </span>
      </div>
      <div className="card bt-risk-card">
        <div className="bt-risk-toggle-row">
          <span className="bt-risk-label">
            Pattern Confirmation
            <span className={patternConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
              {patternConfig.enabled ? 'enabled' : 'disabled'}
            </span>
          </span>
          <button type="button"
            className={patternConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
            onClick={() => updatePattern('enabled', !patternConfig.enabled)}>
            {patternConfig.enabled ? 'ON' : 'OFF'}
          </button>
          {!patternConfig.enabled && (
            <span className="bt-risk-hint">Patterns are always detected and shown in trades. Enable to require a pattern before entering or exiting.</span>
          )}
        </div>
        <div className="bt-pattern-groups">
          <div className="bt-pattern-group">
            <div className="bt-pattern-group-title">
              BUY confirmation
              <span className="bt-pattern-group-hint">{patternConfig.enabled ? '— at least one required to enter' : '— informational'}</span>
            </div>
            {BUY_PATTERNS.map(p => {
              const on = patternConfig.buyConfirmPatterns.includes(p.id);
              return (
                <label key={p.id} className="bt-pattern-check">
                  <input type="checkbox" checked={on}
                    onChange={() => togglePatternConfirm('buyConfirmPatterns', p.id)} />
                  {p.label}
                  <span className={on ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                    {on ? 'enabled' : 'disabled'}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="bt-pattern-group">
            <div className="bt-pattern-group-title">
              SELL confirmation
              <span className="bt-pattern-group-hint">{patternConfig.enabled ? '— at least one required to exit' : '— informational'}</span>
            </div>
            {SELL_PATTERNS.map(p => {
              const on = patternConfig.sellConfirmPatterns.includes(p.id);
              return (
                <label key={p.id} className="bt-pattern-check">
                  <input type="checkbox" checked={on}
                    onChange={() => togglePatternConfirm('sellConfirmPatterns', p.id)} />
                  {p.label}
                  <span className={on ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                    {on ? 'enabled' : 'disabled'}
                  </span>
                </label>
              );
            })}
          </div>
          {patternConfig.enabled && (
            <div className="bt-pattern-group bt-pattern-params">
              <div className="form-group">
                <label>Min Wick Ratio <span className="form-hint">wick ÷ body</span></label>
                <input type="number" min="0.5" step="0.1" value={patternConfig.minWickRatio}
                  onChange={e => updatePattern('minWickRatio', e.target.value)} />
              </div>
              <div className="form-group">
                <label>Max Body % <span className="form-hint">body ÷ range</span></label>
                <input type="number" min="0.01" max="1" step="0.01" value={patternConfig.maxBodyPct}
                  onChange={e => updatePattern('maxBodyPct', e.target.value)} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Market Regime Detection */}
      <div className="bt-section-label" style={{ marginTop: 28 }}>
        <span className="bt-section-title">Market Regime Detection</span>
        <span className="bt-section-sub">
          {regimeConfig.enabled
            ? `ON — ADX(${regimeConfig.adxPeriod}) trend>${regimeConfig.adxTrendThreshold} · ATR(${regimeConfig.atrPeriod}) volatile>${regimeConfig.atrVolatilePct}% compress<${regimeConfig.atrCompressionPct}%`
            : 'OFF — no regime filtering applied'}
        </span>
      </div>
      <div className="card bt-risk-card">
        <div className="bt-risk-toggle-row">
          <span className="bt-risk-label">
            Regime Detection
            <span className={regimeConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
              {regimeConfig.enabled ? 'enabled' : 'disabled'}
            </span>
          </span>
          <button type="button"
            className={regimeConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
            onClick={() => updateRegime('enabled', !regimeConfig.enabled)}>
            {regimeConfig.enabled ? 'ON' : 'OFF'}
          </button>
          {!regimeConfig.enabled && (
            <span className="bt-risk-hint">Enable to classify each candle as TRENDING / RANGING / VOLATILE / COMPRESSION and filter strategy entries by regime.</span>
          )}
        </div>
        {regimeConfig.enabled && (
          <>
            <div className="bt-risk-fields">
              <div className="form-group">
                <label>ADX Period</label>
                <input type="number" min="2" value={regimeConfig.adxPeriod}
                  onChange={e => updateRegime('adxPeriod', e.target.value)} />
                <small className="bt-risk-hint">Lookback for ADX indicator</small>
              </div>
              <div className="form-group">
                <label>ATR Period</label>
                <input type="number" min="2" value={regimeConfig.atrPeriod}
                  onChange={e => updateRegime('atrPeriod', e.target.value)} />
                <small className="bt-risk-hint">Lookback for ATR indicator</small>
              </div>
              <div className="form-group">
                <label>ADX Trend Threshold</label>
                <input type="number" min="1" max="100" step="0.5" value={regimeConfig.adxTrendThreshold}
                  onChange={e => updateRegime('adxTrendThreshold', e.target.value)} />
                <small className="bt-risk-hint">ADX above this = TRENDING</small>
              </div>
              <div className="form-group">
                <label>ATR Volatile % <span className="form-hint">(of price)</span></label>
                <input type="number" min="0" step="0.1" value={regimeConfig.atrVolatilePct}
                  onChange={e => updateRegime('atrVolatilePct', e.target.value)} />
                <small className="bt-risk-hint">ATR/close% above this = VOLATILE</small>
              </div>
              <div className="form-group">
                <label>ATR Compression % <span className="form-hint">(of price)</span></label>
                <input type="number" min="0" step="0.05" value={regimeConfig.atrCompressionPct}
                  onChange={e => updateRegime('atrCompressionPct', e.target.value)} />
                <small className="bt-risk-hint">ATR/close% below this = COMPRESSION</small>
              </div>
            </div>
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div className="bt-params-label" style={{ marginBottom: 6 }}>Regime Descriptions</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                {REGIMES.map(r => (
                  <span key={r} className={`bt-regime-badge bt-regime-${r}`}>{r}</span>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.6 }}>
                <strong style={{ color: 'var(--text-secondary)' }}>TRENDING</strong> — strong directional move (ADX high) &nbsp;·&nbsp;
                <strong style={{ color: 'var(--text-secondary)' }}>VOLATILE</strong> — large swings with no clear direction (ATR% high) &nbsp;·&nbsp;
                <strong style={{ color: 'var(--text-secondary)' }}>COMPRESSION</strong> — tight range / low-volatility squeeze (ATR% low) &nbsp;·&nbsp;
                <strong style={{ color: 'var(--text-secondary)' }}>RANGING</strong> — everything else
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                Per-strategy &quot;Active Regimes&quot; appear in each strategy card above. Empty selection = trades in all regimes.
              </div>
            </div>
          </>
        )}
      </div>

      {/* Score-Based Combined Pool */}
      <div className="bt-section-label" style={{ marginTop: 28 }}>
        <span className="bt-section-title">Score-Based Combined Pool</span>
        <span className="bt-section-sub">
          {scoreConfig.enabled
            ? `ON — min score ${scoreConfig.minScoreThreshold} · all strategies compete per candle`
            : 'OFF — no score-based combined result'}
        </span>
      </div>
      <div className="card bt-risk-card">
        <div className="bt-risk-toggle-row">
          <span className="bt-risk-label">
            Score Switching
            <span className={scoreConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
              {scoreConfig.enabled ? 'enabled' : 'disabled'}
            </span>
          </span>
          <button type="button"
            className={scoreConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
            onClick={() => setScoreConfig(p => ({ ...p, enabled: !p.enabled }))}>
            {scoreConfig.enabled ? 'ON' : 'OFF'}
          </button>
          {!scoreConfig.enabled && (
            <span className="bt-risk-hint">Enable to add a "Score-Switched" combined result — the scorer picks the highest-quality strategy per candle from one shared capital pool.</span>
          )}
        </div>
        {scoreConfig.enabled && (
          <div className="bt-risk-fields">
            <div className="form-group">
              <label>Min Score Threshold <span className="form-hint">(0–100)</span></label>
              <input type="number" min="0" max="100" step="1"
                value={scoreConfig.minScoreThreshold}
                onChange={e => setScoreConfig(p => ({ ...p, minScoreThreshold: e.target.value }))} />
              <small className="bt-risk-hint">Signals scoring below this are skipped</small>
            </div>
          </div>
        )}
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
        <button type="button" className="btn-secondary" onClick={() => { setStrategies(defaultStrategies()); setDataCtx({ ...EMPTY_DATA_CTX }); setRiskConfig({ ...EMPTY_RISK }); setPatternConfig({ ...EMPTY_PATTERN }); setRegimeConfig({ ...EMPTY_REGIME_CONFIG }); setScoreConfig({ ...EMPTY_SCORE_CONFIG }); setResult(null); setError(''); }} disabled={loading}>
          Reset
        </button>
      </div>

      {result && <BacktestResultPanel result={result} session={session} instrumentToken={dataCtx.instrumentToken} />}
    </form>
  );
}

// ─── Instrument Picker ────────────────────────────────────────────────────────
// Shared component used in all 3 tabs: search box + recent instruments list


const INSTRUMENT_TYPES = [
  { value: '',    label: 'All Types' },
  { value: 'EQ',  label: 'Equity (EQ)' },
  { value: 'FUT', label: 'Futures (FUT)' },
  { value: 'CE',  label: 'Call Option (CE)' },
  { value: 'PE',  label: 'Put Option (PE)' },
];

function InstrumentPicker({ session, symbol, exchange, instrumentToken, onSelect, onChange, disabled }) {
  const [query, setQuery]       = useState('');
  const [instType, setInstType] = useState('');
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

  // Auto-detect F&O exchange from query pattern
  function resolveSearchExchange(q) {
    const u = q.toUpperCase();
    // F&O contracts: options (CE/PE suffix), futures (digit+FUT), or index derivatives with expiry digits
    if (/CE$|PE$/.test(u) || /\dFUT/.test(u) || /(?:NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY)\d/.test(u)) {
      return 'NFO';
    }
    // Bare index names — always search NSE (where NIFTY 50, BANKNIFTY indices live)
    if (/^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|SENSEX|BANKEX)/.test(u)) {
      return 'NSE';
    }
    return exchange;
  }

  function doSearch(q, type) {
    if (!q.trim()) { setResults([]); setShowDrop(false); return; }
    setShowDrop(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!session?.userId) return;
      setSearching(true);
      try {
        const searchEx = resolveSearchExchange(q);
        const res = await searchInstruments(q, searchEx, session.userId, session.brokerName || 'kite', type || undefined);
        setResults(res?.data || []);
      } catch { setResults([]); }
      finally { setSearching(false); }
    }, 300);
  }

  function handleQueryChange(e) {
    const q = e.target.value;
    setQuery(q);
    doSearch(q, instType);
  }

  function handleTypeChange(e) {
    const t = e.target.value;
    setInstType(t);
    if (query.trim()) doSearch(query, t);
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

      {/* Search box + type filter */}
      <div ref={wrapRef} style={{ position: 'relative', marginBottom: 10 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
          Search Instrument
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ flex: 1 }}
            value={query}
            onChange={handleQueryChange}
            onFocus={() => query.trim() && setShowDrop(true)}
            placeholder={session?.userId ? 'Type symbol or name  (e.g. RELIANCE, NIFTY, NIFTY24DEC24450CE)' : 'Activate a session to search instruments'}
            disabled={disabled || !session?.userId}
          />
          <select
            style={{ width: 160, flexShrink: 0 }}
            value={instType}
            onChange={handleTypeChange}
            disabled={disabled || !session?.userId}
          >
            {INSTRUMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        {query.trim() && resolveSearchExchange(query) !== exchange && (
          <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 4 }}>
            Searching on <strong>{resolveSearchExchange(query)}</strong> (auto-detected from symbol)
          </div>
        )}
        {showDrop && (
          <div className="bt-instrument-drop">
            {searching && <div className="bt-drop-hint">Searching…</div>}
            {!searching && results.length === 0 && <div className="bt-drop-hint">No matches found</div>}
            {results.map((r, i) => (
              <button key={i} type="button" className="bt-drop-item" onClick={() => pickResult(r)}>
                <span className="bt-drop-symbol">{r.tradingSymbol}</span>
                <span className="bt-drop-name">{r.name}</span>
                <span className="bt-drop-meta">
                  {r.exchange} · <span className="bt-drop-type">{r.instrumentType}</span>
                  {r.expiry ? ` · exp ${r.expiry}` : ''}
                  {r.strike > 0 ? ` · ₹${r.strike}` : ''}
                  {` · lot ${r.lotSize}`}
                </span>
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
            {['NSE','BSE','NFO','BFO','MCX','CDS'].map(x => <option key={x} value={x}>{x}</option>)}
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

  const ls = (key, def) => { try { const s = localStorage.getItem(key); if (!s) return def; const v = JSON.parse(s); return (Array.isArray(def) && !Array.isArray(v)) ? def : v; } catch { return def; } };

  const [knownTypes, setKnownTypes]     = useState(['SMA_CROSSOVER']);
  const [strategies, setStrategies]     = useState(() => ls('sma_replay_strategies', defaultStrategies()));
  const [inst, setInst]                 = useState(() => ls('sma_replay_inst', { ...EMPTY_INST }));
  const [replayInterval, setReplayInterval] = useState(() => ls('sma_replay_interval', 'DAY'));
  const [fromDate, setFromDate]         = useState(() => ls('sma_replay_from', ''));
  const [toDate, setToDate]             = useState(() => ls('sma_replay_to', ''));
  const [speed, setSpeed]               = useState(() => ls('sma_replay_speed', 1));
  const [initialCapital, setInitialCapital] = useState(() => ls('sma_replay_capital', '100000'));
  const [quantity, setQuantity]         = useState(() => ls('sma_replay_qty', '0'));

  const [riskConfig, setRiskConfig]       = useState(() => ls('sma_replay_risk',    { ...EMPTY_RISK }));
  const [patternConfig, setPatternConfig] = useState(() => ls('sma_replay_pattern', { ...EMPTY_PATTERN }));
  const [regimeConfig, setRegimeConfig]   = useState(() => ls('sma_replay_regime',  { ...EMPTY_REGIME_CONFIG }));
  const [scoreConfig, setScoreConfig]     = useState(() => ls('sma_replay_score',   { ...EMPTY_SCORE_CONFIG }));
  const [rulesConfig, setRulesConfig]         = useState(() => {
    try { const s = localStorage.getItem('sma_rules_config');     return s ? { ...JSON.parse(JSON.stringify(EMPTY_RULES_CONFIG)),     ...JSON.parse(s) } : JSON.parse(JSON.stringify(EMPTY_RULES_CONFIG)); }
    catch { return JSON.parse(JSON.stringify(EMPTY_RULES_CONFIG)); }
  });
  const [entryFilterConfig, setEntryFilterConfig] = useState(() => {
    try { const s = localStorage.getItem('sma_entry_filter_config'); return s ? { ...JSON.parse(JSON.stringify(EMPTY_ENTRY_FILTER_CONFIG)), ...JSON.parse(s) } : JSON.parse(JSON.stringify(EMPTY_ENTRY_FILTER_CONFIG)); }
    catch { return JSON.parse(JSON.stringify(EMPTY_ENTRY_FILTER_CONFIG)); }
  });
  const [currentRegime, setCurrentRegime]     = useState(null);
  const [preload, setPreload]             = useState(() => ls('sma_replay_preload', { enabled: true, daysBack: 5, interval: 'MINUTE_5' }));
  const [combinedOnlyMode, setCombinedOnlyMode] = useState(() => ls('sma_replay_combined_only', false));

  useEffect(() => { try { localStorage.setItem('sma_rules_config',        JSON.stringify(rulesConfig));       } catch {} }, [rulesConfig]);
  useEffect(() => { try { localStorage.setItem('sma_entry_filter_config', JSON.stringify(entryFilterConfig)); } catch {} }, [entryFilterConfig]);
  useEffect(() => { try { localStorage.setItem('sma_replay_strategies',   JSON.stringify(strategies));        } catch {} }, [strategies]);
  useEffect(() => { try { localStorage.setItem('sma_replay_inst',         JSON.stringify(inst));              } catch {} }, [inst]);
  useEffect(() => { try { localStorage.setItem('sma_replay_interval',     JSON.stringify(replayInterval));    } catch {} }, [replayInterval]);
  useEffect(() => { try { localStorage.setItem('sma_replay_from',         JSON.stringify(fromDate));          } catch {} }, [fromDate]);
  useEffect(() => { try { localStorage.setItem('sma_replay_to',           JSON.stringify(toDate));            } catch {} }, [toDate]);
  useEffect(() => { try { localStorage.setItem('sma_replay_speed',        JSON.stringify(speed));             } catch {} }, [speed]);
  useEffect(() => { try { localStorage.setItem('sma_replay_capital',      JSON.stringify(initialCapital));    } catch {} }, [initialCapital]);
  useEffect(() => { try { localStorage.setItem('sma_replay_qty',          JSON.stringify(quantity));          } catch {} }, [quantity]);
  useEffect(() => { try { localStorage.setItem('sma_replay_risk',         JSON.stringify(riskConfig));        } catch {} }, [riskConfig]);
  useEffect(() => { try { localStorage.setItem('sma_replay_pattern',      JSON.stringify(patternConfig));     } catch {} }, [patternConfig]);
  useEffect(() => { try { localStorage.setItem('sma_replay_regime',       JSON.stringify(regimeConfig));      } catch {} }, [regimeConfig]);
  useEffect(() => { try { localStorage.setItem('sma_replay_score',        JSON.stringify(scoreConfig));       } catch {} }, [scoreConfig]);
  useEffect(() => { try { localStorage.setItem('sma_replay_preload',      JSON.stringify(preload));           } catch {} }, [preload]);
  useEffect(() => { try { localStorage.setItem('sma_replay_combined_only',JSON.stringify(combinedOnlyMode));  } catch {} }, [combinedOnlyMode]);
  const [preloadState, setPreloadState]   = useState({ status: 'idle', count: 0, error: null });

  const [sessionId, setSessionId]       = useState(null);
  const [status, setStatus]             = useState('idle');
  const [progress, setProgress]         = useState({ emitted: 0, total: 0 });
  const [error, setError]               = useState('');
  const [feed, setFeed]                 = useState([]);
  const [currentCandle, setCurrentCandle] = useState(null);
  const [stratStates, setStratStates]   = useState({});
  const [rightTab, setRightTab]         = useState('feed');
  const [ticks, setTicks]               = useState([]);
  const [candleLog, setCandleLog]       = useState([]);
  const [combOnlyView, setCombOnlyView] = useState(false);

  const abortCtrlRef      = useRef(null);
  const sseRef            = useRef(null);
  const tickSseRef        = useRef(null);
  const ticksRef          = useRef([]);
  const latestTickRef     = useRef(null);
  const candleLogRef           = useRef([]);
  const lastCombinedExitIdxRef = useRef(null);
  const pollRef           = useRef(null);
  const feedRef           = useRef([]);
  const capitalMap        = useRef({});
  const openPositionMap   = useRef({});
  const closedTradesMap   = useRef({});
  const equityMap         = useRef({});
  const regimeDetectorRef   = useRef(null);
  const patternEvalRef      = useRef(null);
  const cooldownRef         = useRef({});
  const dailyCapMap         = useRef({});
  const reversalCooldownRef = useRef({});

  useEffect(() => {
    getStrategyTypes().then(r => { if (r?.data) setKnownTypes([...r.data].sort()); }).catch(() => {});
    return () => cleanup();
  }, []);

  function cleanup() {
    if (abortCtrlRef.current) { abortCtrlRef.current.abort(); abortCtrlRef.current = null; }
    if (sseRef.current) {
      try { if (typeof sseRef.current.close  === 'function') sseRef.current.close();  } catch (_) {}
      try { if (typeof sseRef.current.cancel === 'function') sseRef.current.cancel().catch(() => {}); } catch (_) {}
      sseRef.current = null;
    }
    if (tickSseRef.current) { try { tickSseRef.current.close(); } catch (_) {} tickSseRef.current = null; }
    if (pollRef.current)    { clearInterval(pollRef.current); pollRef.current = null; }
  }

  function addStrategy() {
    const masterShort = strategies.every(s => s.allowShorting);
    setStrategies(p => [...p, { strategyType: 'SMA_CROSSOVER', enabled: true, label: '', allowShorting: masterShort, parameters: defaultParams('SMA_CROSSOVER') }]);
  }
  function removeStrategy(idx) { setStrategies(p => p.filter((_, i) => i !== idx)); }
  function toggleMasterShorting() {
    const next = !strategies.every(s => s.allowShorting);
    setStrategies(p => p.map(s => ({ ...s, allowShorting: next })));
  }
  function updateStrategy(idx, field, value) {
    setStrategies(p => p.map((s, i) => {
      if (i !== idx) return s;
      if (field === 'strategyType') return { ...s, strategyType: value, parameters: defaultParams(value) };
      return { ...s, [field]: value };
    }));
  }
  function updateStrategyParam(idx, key, value) {
    setStrategies(p => p.map((s, i) => i !== idx ? s : { ...s, parameters: { ...s.parameters, [key]: value } }));
  }
  function updateRisk(f, v)    { setRiskConfig(p => ({ ...p, [f]: v })); }
  function updatePattern(f, v) { setPatternConfig(p => ({ ...p, [f]: v })); }
  function togglePatternList(f, v) {
    setPatternConfig(p => ({ ...p, [f]: p[f].includes(v) ? p[f].filter(x => x !== v) : [...p[f], v] }));
  }
  function updateRegime(f, v)  { setRegimeConfig(p => ({ ...p, [f]: v })); }
  function updateRule(section, ruleKey, field, value) {
    setRulesConfig(p => ({ ...p, [section]: { ...p[section], [ruleKey]: { ...p[section][ruleKey], [field]: value } } }));
  }

  async function handleStart(e) {
    e.preventDefault();
    cleanup();
    setError(''); setFeed([]); feedRef.current = [];
    setTicks([]); ticksRef.current = []; latestTickRef.current = null;
    setCandleLog([]); candleLogRef.current = []; lastCombinedExitIdxRef.current = null;
    setProgress({ emitted: 0, total: 0 });
    setStatus('starting'); setSessionId(null); setCurrentCandle(null);
    setStratStates({});
    setCurrentRegime(null);
    setPreloadState({ status: 'loading', count: 0, error: null });

    // Reset all local tracking refs
    capitalMap.current = {};
    openPositionMap.current = {};
    closedTradesMap.current = {};
    equityMap.current = {};
    cooldownRef.current = {};
    dailyCapMap.current = {};
    reversalCooldownRef.current = {};

    const instrType = resolveInstrType(inst.instrumentType, inst.symbol, inst.exchange);

    // Build rulesConfig for backend — translate frontend shape to backend Java camelCase shape
    const rulesPayload = rulesConfig.enabled ? {
      enabled: true,
      stocks: {
        rangingNoTrade:       rulesConfig.stocks?.ranging_no_trade?.enabled ?? true,
        compressionShortOnly: rulesConfig.stocks?.compression_short_only?.enabled ?? true,
        noSameCandleReversal: rulesConfig.stocks?.no_same_candle_reversal?.enabled ?? true,
        longQualityGate: {
          enabled:    rulesConfig.stocks?.long_quality_gate?.enabled ?? true,
          scoreMin:   parseFloat(rulesConfig.stocks?.long_quality_gate?.scoreMin)  || 60,
          vwapMaxPct: parseFloat(rulesConfig.stocks?.long_quality_gate?.vwapMaxPct) || 1.5,
        },
      },
      options: {
        volatileNoTrade:      rulesConfig.options?.volatile_no_trade?.enabled ?? true,
        disableSmaBreakout:   rulesConfig.options?.disable_sma_breakout?.enabled ?? true,
        distrustHighVolScore: rulesConfig.options?.distrust_high_vol_score?.enabled ?? true,
        volScoreMax:          parseFloat(rulesConfig.options?.distrust_high_vol_score?.volScoreMax) || 70,
        noSameCandleReversal: rulesConfig.options?.no_same_candle_reversal?.enabled ?? true,
      },
    } : { enabled: false };

    const payload = {
      userId:          session.userId,
      brokerName:      session.brokerName,
      symbol:          inst.symbol.toUpperCase(),
      exchange:        inst.exchange.toUpperCase(),
      instrumentToken: parseInt(inst.instrumentToken, 10),
      instrumentType:  instrType,
      interval:        replayInterval,
      fromDate:        fromDate + 'T09:15:00',
      toDate:          toDate   + 'T15:30:00',
      speedMultiplier:  parseFloat(speed) || 1,
      combinedOnlyMode: combinedOnlyMode,
      initialCapital:   parseFloat(initialCapital) || 100000,
      quantity:        parseInt(quantity, 10) || 0,
      product:         'MIS',
      preloadDaysBack: preload.enabled ? (parseInt(preload.daysBack, 10) || 5) : 0,
      preloadInterval: preload.enabled ? preload.interval : replayInterval,
      strategies: strategies.filter(s => s.enabled).map(s => ({
        strategyType: s.strategyType,
        label:        s.label || undefined,
        parameters:   s.parameters,
        activeRegimes: regimeConfig.enabled
          ? (STRATEGY_REGIME_MAP[s.strategyType] || [])
          : [],
      })),
      riskConfig: riskConfig.enabled ? {
        enabled:            true,
        stopLossPct:        parseFloat(riskConfig.stopLossPct)        || null,
        takeProfitPct:      parseFloat(riskConfig.takeProfitPct)      || null,
        maxRiskPerTradePct: parseFloat(riskConfig.maxRiskPerTradePct) || null,
        dailyLossCapPct:    parseFloat(riskConfig.dailyLossCapPct)    || null,
        cooldownCandles:    parseInt(riskConfig.cooldownCandles, 10)  || 0,
      } : null,
      patternConfig: patternConfig.enabled ? {
        enabled:             true,
        minWickRatio:        parseFloat(patternConfig.minWickRatio) || 2,
        maxBodyPct:          parseFloat(patternConfig.maxBodyPct)   || 0.35,
        buyConfirmPatterns:  patternConfig.buyConfirmPatterns,
        sellConfirmPatterns: patternConfig.sellConfirmPatterns,
      } : null,
      regimeConfig: regimeConfig.enabled ? {
        enabled:           true,
        adxPeriod:         parseInt(regimeConfig.adxPeriod, 10)       || 14,
        atrPeriod:         parseInt(regimeConfig.atrPeriod, 10)       || 14,
        adxTrendThreshold: parseFloat(regimeConfig.adxTrendThreshold) || 25,
        atrVolatilePct:    parseFloat(regimeConfig.atrVolatilePct)    || 2.0,
        atrCompressionPct: parseFloat(regimeConfig.atrCompressionPct) || 0.5,
      } : null,
      scoreConfig: scoreConfig.enabled ? {
        enabled:           true,
        minScoreThreshold: parseFloat(scoreConfig.minScoreThreshold) || 30,
      } : null,
      rulesConfig: rulesPayload,
      entryFilterConfig: entryFilterConfig.enabled ? {
        enabled:    true,
        // Score Gap
        scoreGap:   { stocks: entryFilterConfig.scoreGap.stocks.enabled,   options: entryFilterConfig.scoreGap.options.enabled },
        minGap:     parseFloat(entryFilterConfig.scoreGap.minGap) || 2,
        // Cooldown
        cooldown:   { stocks: entryFilterConfig.cooldown.stocks.enabled,   options: entryFilterConfig.cooldown.options.enabled },
        minBars:    parseInt(entryFilterConfig.cooldown.minBars) || 3,
        // VWAP Extension
        vwapExtension: { stocks: entryFilterConfig.vwapExtension.stocks.enabled, options: entryFilterConfig.vwapExtension.options.enabled },
        maxDistPct: parseFloat(entryFilterConfig.vwapExtension.maxDistPct) || 1.5,
        // Strategy Filter
        strategyFilter: { stocks: entryFilterConfig.strategyFilter.stocks.enabled, options: entryFilterConfig.strategyFilter.options.enabled },
        blocked:    entryFilterConfig.strategyFilter.blocked || '',
        // Confidence Gate
        confidenceGate: { stocks: entryFilterConfig.confidenceGate.stocks.enabled, options: entryFilterConfig.confidenceGate.options.enabled },
        minConfGap: parseFloat(entryFilterConfig.confidenceGate.minGap) || 3,
        exceptionStrategy: entryFilterConfig.confidenceGate.exceptionStrategy || 'LIQUIDITY_SWEEP',
      } : { enabled: false },
    };

    try {
      setStatus('running');
      setPreloadState({ status: 'loading', count: 0, error: null });

      const abortCtrl = new AbortController();
      abortCtrlRef.current = abortCtrl;

      const response = await startReplayEval(payload, abortCtrl.signal);
      if (!response.body) throw new Error('No response body from Strategy Engine');

      // Read the SSE stream manually (POST SSE — cannot use EventSource)
      const reader   = response.body.getReader();
      const decoder  = new TextDecoder();
      sseRef.current = reader;

      let buffer = '';
      let done   = false;

      while (!done) {
        let chunk;
        try {
          const result = await reader.read();
          done  = result.done;
          chunk = result.value;
        } catch {
          break; // stream cancelled (cleanup called)
        }
        if (chunk) buffer += decoder.decode(chunk, { stream: true });

        // Parse SSE events from buffer
        const parts = buffer.split('\n\n');
        buffer = parts.pop(); // keep incomplete tail

        for (const part of parts) {
          const lines = part.split('\n');
          let eventName = null;
          let data = null;
          for (const line of lines) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          if (eventName === 'init' && data) {
            try {
              const init = JSON.parse(data);
              setPreloadState({ status: 'done', count: init.warmupCount || 0, error: null });
              setProgress({ emitted: 0, total: init.totalCandles || 0 });
            } catch {}
          } else if (eventName === 'candle' && data) {
            try {
              const event = JSON.parse(data);
              onReplayCandleEvent(event);
            } catch {}
          } else if (eventName === 'summary' && data) {
            try {
              const summary = JSON.parse(data);
              if (summary.strategyStates) setStratStates(summary.strategyStates);
            } catch {}
          }
        }
      }

      setStatus(s => (s === 'running' || s === 'starting') ? 'completed' : s);

    } catch (err) {
      if (err.name === 'AbortError') return; // intentional stop via handleStop — don't override status
      setError(err.message);
      setStatus('idle');
      cleanup();
    }
  }

  /**
   * Handles a ReplayCandleEvent received from the Strategy Engine SSE stream.
   * Replaces the old frontend-local onCandleEvent — all evaluation is now server-side.
   */
  function onReplayCandleEvent(event) {
    const candleTime = event.candleTime || '';
    const close = event.close;
    const high  = event.high;
    const low   = event.low;
    const open  = event.open;
    const vol   = event.volume || 0;

    // Update regime display
    if (event.regime) setCurrentRegime(event.regime);

    // Update progress
    setProgress({ emitted: event.emitted || 0, total: event.total || 0 });

    // Update current candle display
    setCurrentCandle({ openTime: candleTime, open, high, low, close, volume: vol, signals: event.signals });

    // Append to candle log
    const combinedState = event.strategyStates?.[COMBINED_LABEL];
    const combinedPos   = combinedState?.openPosition ?? null;
    const combinedUnrealizedPnl = combinedPos
      ? combinedPos.type === 'LONG'
        ? (close - combinedPos.entryPrice) * combinedPos.qty
        : (combinedPos.entryPrice - close) * combinedPos.qty
      : null;
    const prevLog     = candleLogRef.current;
    const prev3       = prevLog.length >= 3 ? prevLog[prevLog.length - 3] : null;
    const prev5       = prevLog.length >= 5 ? prevLog[prevLog.length - 5] : null;
    const recentMovePct  = (prev3 && close && prev3.close) ? ((close - prev3.close) / prev3.close * 100) : null;
    const recentMove5Pct = (prev5 && close && prev5.close) ? ((close - prev5.close) / prev5.close * 100) : null;

    // Score gap: winner - second-best (parsed from combinedAllScored sorted desc)
    // If only 1 strategy scored, gap = winner's score (no competition)
    const allScored = event.combinedAllScored || [];
    const parseScore = s => { const m = s.match(/score=([\d.]+)/); return m ? parseFloat(m[1]) : 0; };
    let scoreGap = null;
    if (allScored.length >= 2) {
      scoreGap = parseScore(allScored[0]) - parseScore(allScored[1]);
    } else if (allScored.length === 1) {
      scoreGap = parseScore(allScored[0]); // sole candidate — gap to 0
    }

    // Entry type tag: REVERSAL > BREAKOUT > PULLBACK > CHOP
    const combinedDetails = event.combinedDetails || [];
    const hasExit  = combinedDetails.some(d => d.action?.startsWith('Exit'));
    const hasEntry = combinedDetails.some(d => d.action?.startsWith('Enter'));
    let entryTypeTag = null;
    if (hasEntry) {
      if (hasExit) {
        entryTypeTag = 'REVERSAL';
      } else {
        const w = (event.combinedWinner || '').toUpperCase();
        if (w.includes('BREAKOUT') || w.includes('BOLLINGER')) entryTypeTag = 'BREAKOUT';
        else if (event.distanceFromVwapPct != null && Math.abs(event.distanceFromVwapPct) < 0.5) entryTypeTag = 'PULLBACK';
        else if (event.regime === 'RANGING') entryTypeTag = 'CHOP';
        else if (recentMovePct != null && Math.abs(recentMovePct) > 1.0) entryTypeTag = 'BREAKOUT';
        else entryTypeTag = 'PULLBACK';
      }
    }

    // Candles since last combined exit
    const currentIdx = candleLogRef.current.length;
    if (hasExit) lastCombinedExitIdxRef.current = currentIdx;
    const candlesSinceLastTrade = lastCombinedExitIdxRef.current != null
      ? currentIdx - lastCombinedExitIdxRef.current
      : null;

    const logEntry = {
      ts: candleTime, open, high, low, close, volume: vol,
      regime: event.regime,
      signals: event.signals || {},
      actions: (event.actions || []).map(a => ({
        strategy: a.strategyLabel, signal: a.action, price: a.price, reason: a.reason || '',
      })),
      blockedSignals: event.blockedSignals || [],
      combinedDetails,
      // Combined pool analytics
      combinedWinner:      event.combinedWinner      ?? null,
      combinedWinnerScore: event.combinedWinnerScore ?? null,
      combinedAllScored:   allScored,
      combinedCandidates:  event.combinedCandidates  || [],
      combinedBlockReason: event.combinedBlockReason ?? null,
      combinedPosition:    combinedPos,
      combinedUnrealizedPnl,
      // Derived analytics
      scoreGap,
      entryTypeTag,
      candlesSinceLastTrade,
      // Market context
      vwap:               event.vwap               ?? null,
      distanceFromVwapPct: event.distanceFromVwapPct ?? null,
      recentMovePct,
      recentMove5Pct,
    };
    candleLogRef.current = [...candleLogRef.current, logEntry];
    setCandleLog([...candleLogRef.current]);

    // Update feed (for the right-panel feed tab) from actions
    if (event.actions && event.actions.length > 0) {
      for (const a of event.actions) {
        const feedEntry = {
          ts: candleTime, strategyLabel: a.strategyLabel,
          signal: a.action, close, reason: a.reason || '',
        };
        feedRef.current = [feedEntry, ...feedRef.current].slice(0, 500);
      }
      setFeed([...feedRef.current]);
    }

    // Update strategy states from server snapshot
    if (event.strategyStates) {
      setStratStates(event.strategyStates);
    }
  }

  async function handleStop() {
    // Cancel the server-side SSE stream (reader.cancel() is called by cleanup)
    setStatus('stopped');
    cleanup();
  }

  function handleReset() {
    cleanup();
    setFeed([]); feedRef.current = [];
    setTicks([]); ticksRef.current = []; latestTickRef.current = null;
    setCandleLog([]); candleLogRef.current = []; lastCombinedExitIdxRef.current = null;
    setStatus('idle'); setSessionId(null);
    setProgress({ emitted: 0, total: 0 });
    setCurrentCandle(null); setError('');
    setStratStates({}); setCurrentRegime(null);
    capitalMap.current = {}; openPositionMap.current = {};
    closedTradesMap.current = {}; equityMap.current = {};
    cooldownRef.current = {}; dailyCapMap.current = {};
    regimeDetectorRef.current = null; patternEvalRef.current = null;
    setPreloadState({ status: 'idle', count: 0, error: null });
  }

  const isRunning      = status === 'running' || status === 'starting';
  const initCap        = parseFloat(initialCapital) || 100000;
  const allLabels      = Object.keys(stratStates);
  const totalDeployed  = initCap * (allLabels.length || 1);
  const totalCapital   = allLabels.reduce((s, l) => s + (stratStates[l]?.capital ?? initCap), 0);
  const totalPnl       = allLabels.reduce((s, l) => s + ((stratStates[l]?.capital ?? initCap) - initCap), 0);
  const totalPnlPct    = totalDeployed > 0 ? (totalPnl / totalDeployed) * 100 : 0;
  const allTrades      = allLabels.flatMap(l => stratStates[l]?.closedTrades || []);
  const fmtRs          = v => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  return (
    <div className="bt-replay-outer">

      {/* ── Top: config left + feed right ─────────────────────────────── */}
      <div className="bt-replay-layout">
        <div className="bt-replay-config">
          <div className="card">
            <h3 className="section-title">Data & Settings</h3>
            <form onSubmit={handleStart}>
              <InstrumentPicker
                session={session}
                symbol={inst.symbol} exchange={inst.exchange} instrumentToken={inst.instrumentToken}
                onSelect={r => { setInst({ symbol: r.tradingSymbol, exchange: r.exchange, instrumentToken: String(r.instrumentToken), instrumentType: deriveInstrumentType(r.instrumentType) }); saveRecentInstrument(r); }}
                onChange={patch => setInst(p => ({ ...p, ...patch }))}
                disabled={isRunning}
              />

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
                  <select value={replayInterval} onChange={e => setReplayInterval(e.target.value)} disabled={isRunning}>
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
              <div className="form-row">
                <div className="form-group">
                  <label>Initial Capital (₹)</label>
                  <input type="number" min="1000" value={initialCapital} onChange={e => setInitialCapital(e.target.value)} disabled={isRunning} />
                </div>
                <div className="form-group">
                  <label>Quantity <span className="form-hint">(0 = auto)</span></label>
                  <input type="number" min="0" value={quantity} onChange={e => setQuantity(e.target.value)} disabled={isRunning} />
                </div>
              </div>

              {/* ── Preload warmup ── */}
              <div className="de-preload-block" style={{ marginBottom: 14, marginTop: 4 }}>
                <div className="de-preload-header">
                  <label className="checkbox-label" style={{ margin: 0, fontWeight: 600 }}>
                    <input type="checkbox" checked={preload.enabled} disabled={isRunning}
                      onChange={e => setPreload(p => ({ ...p, enabled: e.target.checked }))} />
                    Preload past candles
                  </label>
                  <span className="de-preload-hint">Warms up indicators before replay start date</span>
                </div>
                {preload.enabled && (
                  <div className="de-preload-fields">
                    <div className="form-group">
                      <label>Days back</label>
                      <input type="number" min="1" max="60" value={preload.daysBack} disabled={isRunning}
                        onChange={e => setPreload(p => ({ ...p, daysBack: e.target.value }))} style={{ width: 80 }} />
                    </div>
                    <div className="form-group">
                      <label>Interval</label>
                      <select value={preload.interval} disabled={isRunning}
                        onChange={e => setPreload(p => ({ ...p, interval: e.target.value }))}>
                        {INTERVALS.map(iv => <option key={iv.value} value={iv.value}>{iv.label}</option>)}
                      </select>
                    </div>
                  </div>
                )}
                {preloadState.status === 'loading' && <div className="de-preload-results"><span className="de-preload-loading">{inst.symbol || 'Instrument'}: Fetching…</span></div>}
                {preloadState.status === 'done'    && <div className="de-preload-results"><span className="de-preload-result-item de-preload-ok">{inst.symbol}: {preloadState.count} candles warmed up</span></div>}
                {preloadState.status === 'error'   && <div className="de-preload-results"><span className="de-preload-result-item de-preload-error">Preload failed — {preloadState.error}</span></div>}
              </div>

              {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
              {!isActive && <div className="error-msg" style={{ marginBottom: 12 }}>No active session.</div>}

              <div style={{ display: 'flex', gap: 8 }}>
                {!isRunning
                  ? <button type="submit" className="btn-primary" disabled={!isActive || status === 'warming up'}>
                      {status === 'warming up' ? 'Warming up…' : '▶ Start Replay'}
                    </button>
                  : <button type="button" className="btn-danger" onClick={handleStop}>■ Stop</button>
                }
                {!isRunning && <button type="button" className="btn-secondary" onClick={handleReset}>Reset</button>}
              </div>
            </form>
          </div>

          {/* ── Risk Management ── */}
          <div className="card bt-risk-card" style={{ marginTop: 12 }}>
            <div className="bt-risk-toggle-row">
              <span className="bt-risk-label">Risk Management
                <span className={riskConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                  {riskConfig.enabled ? 'enabled' : 'disabled'}
                </span>
              </span>
              <button type="button" disabled={isRunning}
                className={riskConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                onClick={() => updateRisk('enabled', !riskConfig.enabled)}>
                {riskConfig.enabled ? 'ON' : 'OFF'}
              </button>
            </div>
            {riskConfig.enabled && (
              <div className="bt-risk-fields">
                {[
                  ['Stop Loss %', 'stopLossPct', '0.1', '100'],
                  ['Take Profit %', 'takeProfitPct', '0.1', null],
                  ['Max Risk / Trade %', 'maxRiskPerTradePct', '0.1', '100'],
                  ['Daily Loss Cap %', 'dailyLossCapPct', '0.1', '100'],
                  ['Cooldown Candles', 'cooldownCandles', '1', null],
                ].map(([lbl, key, step, max]) => (
                  <div className="form-group" key={key}>
                    <label>{lbl}</label>
                    <input type="number" min="0" max={max||undefined} step={step} value={riskConfig[key]} disabled={isRunning}
                      onChange={e => updateRisk(key, e.target.value)} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Market Regime Detection ── */}
          <div className="card bt-risk-card" style={{ marginTop: 12 }}>
            <div className="bt-risk-toggle-row">
              <span className="bt-risk-label">Market Regime Detection
                <span className={regimeConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                  {regimeConfig.enabled ? 'enabled' : 'disabled'}
                </span>
              </span>
              <button type="button" disabled={isRunning}
                className={regimeConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                onClick={() => updateRegime('enabled', !regimeConfig.enabled)}>
                {regimeConfig.enabled ? 'ON' : 'OFF'}
              </button>
            </div>
            {regimeConfig.enabled && (
              <div className="bt-risk-fields">
                {[['ADX Period','adxPeriod'],['ATR Period','atrPeriod'],['ADX Trend Threshold','adxTrendThreshold'],
                  ['ATR Volatile %','atrVolatilePct'],['ATR Compression %','atrCompressionPct']].map(([lbl, key]) => (
                  <div className="form-group" key={key}>
                    <label>{lbl}</label>
                    <input type="number" min="0" step="0.5" value={regimeConfig[key]} disabled={isRunning}
                      onChange={e => updateRegime(key, e.target.value)} />
                  </div>
                ))}
              </div>
            )}
            {currentRegime && (
              <div style={{ marginTop: 8 }}>
                <span className="bt-params-label" style={{ marginRight: 6 }}>Current:</span>
                <span className={`bt-regime-badge bt-regime-${currentRegime}`}>{currentRegime}</span>
              </div>
            )}
          </div>

          {/* ── Score-Based Combined Pool ── */}
          <div className="card bt-risk-card" style={{ marginTop: 12 }}>
            <div className="bt-risk-toggle-row">
              <span className="bt-risk-label">Score-Based Combined Pool
                <span className={scoreConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                  {scoreConfig.enabled ? 'enabled' : 'disabled'}
                </span>
              </span>
              <button type="button" disabled={isRunning}
                className={scoreConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                onClick={() => setScoreConfig(p => ({ ...p, enabled: !p.enabled }))}>
                {scoreConfig.enabled ? 'ON' : 'OFF'}
              </button>
            </div>
            {scoreConfig.enabled && (
              <div className="bt-risk-fields">
                <div className="form-group">
                  <label>Min Score Threshold</label>
                  <input type="number" min="0" max="100" step="1" disabled={isRunning}
                    value={scoreConfig.minScoreThreshold}
                    onChange={e => setScoreConfig(p => ({ ...p, minScoreThreshold: e.target.value }))} />
                </div>
              </div>
            )}
          </div>

          {/* ── Pattern Confirmation ── */}
          <div className="card bt-risk-card" style={{ marginTop: 12 }}>
            <div className="bt-risk-toggle-row">
              <span className="bt-risk-label">Pattern Confirmation
                <span className={patternConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                  {patternConfig.enabled ? 'enabled' : 'disabled'}
                </span>
              </span>
              <button type="button" disabled={isRunning}
                className={patternConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                onClick={() => updatePattern('enabled', !patternConfig.enabled)}>
                {patternConfig.enabled ? 'ON' : 'OFF'}
              </button>
            </div>
            {patternConfig.enabled && (
              <>
                <div className="bt-risk-fields">
                  <div className="form-group"><label>Min Wick Ratio</label>
                    <input type="number" min="0" step="0.1" value={patternConfig.minWickRatio} disabled={isRunning} onChange={e => updatePattern('minWickRatio', e.target.value)} />
                  </div>
                  <div className="form-group"><label>Max Body %</label>
                    <input type="number" min="0" max="1" step="0.05" value={patternConfig.maxBodyPct} disabled={isRunning} onChange={e => updatePattern('maxBodyPct', e.target.value)} />
                  </div>
                </div>
                <div className="bt-params-label" style={{ marginTop: 8 }}>BUY confirm patterns</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {BUY_PATTERNS.map(p => (
                    <label key={p.id} className="checkbox-label">
                      <input type="checkbox" disabled={isRunning} checked={patternConfig.buyConfirmPatterns.includes(p.id)}
                        onChange={() => togglePatternList('buyConfirmPatterns', p.id)} />
                      {p.label}
                    </label>
                  ))}
                </div>
                <div className="bt-params-label" style={{ marginTop: 8 }}>SELL confirm patterns</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {SELL_PATTERNS.map(p => (
                    <label key={p.id} className="checkbox-label">
                      <input type="checkbox" disabled={isRunning} checked={patternConfig.sellConfirmPatterns.includes(p.id)}
                        onChange={() => togglePatternList('sellConfirmPatterns', p.id)} />
                      {p.label}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* ── Trading Rules ── */}
          <div className="card bt-risk-card" style={{ marginTop: 12 }}>
            <div className="bt-risk-toggle-row">
              <span className="bt-risk-label">Trading Rules
                <span className={rulesConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                  {rulesConfig.enabled ? 'enabled' : 'disabled'}
                </span>
              </span>
              <button type="button" disabled={isRunning}
                className={rulesConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                onClick={() => setRulesConfig(p => ({ ...p, enabled: !p.enabled }))}>
                {rulesConfig.enabled ? 'ON' : 'OFF'}
              </button>
            </div>
            {rulesConfig.enabled && (() => {
              const instrType  = resolveInstrType(inst.instrumentType, inst.symbol, inst.exchange);
              const hasStock   = instrType !== 'OPTION';
              const hasOption  = instrType === 'OPTION';
              return (
                <>
                  {hasStock && (
                    <>
                      <div className="bt-params-label" style={{ marginTop: 10, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 11, background: 'rgba(34,197,94,0.15)', color: '#22c55e', borderRadius: 4, padding: '1px 7px', fontWeight: 700 }}>STOCK</span>
                        Rules
                      </div>
                      {[
                        ['ranging_no_trade',       'No trade in RANGING regime'],
                        ['compression_short_only', 'SHORT only in COMPRESSION regime'],
                        ['no_same_candle_reversal','No same-candle reversal'],
                      ].map(([key, lbl]) => (
                        <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, paddingRight: 8 }}>{lbl}</span>
                          <button type="button" disabled={isRunning}
                            className={rulesConfig.stocks[key]?.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                            style={{ minWidth: 36 }}
                            onClick={() => updateRule('stocks', key, 'enabled', !rulesConfig.stocks[key]?.enabled)}>
                            {rulesConfig.stocks[key]?.enabled ? 'ON' : 'OFF'}
                          </button>
                        </div>
                      ))}
                      <div style={{ padding: '6px 0', borderBottom: hasOption ? '1px solid var(--border)' : undefined }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, paddingRight: 8 }}>LONG requires min score + no recent reversal + within VWAP</span>
                          <button type="button" disabled={isRunning}
                            className={rulesConfig.stocks.long_quality_gate?.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                            style={{ minWidth: 36 }}
                            onClick={() => updateRule('stocks', 'long_quality_gate', 'enabled', !rulesConfig.stocks.long_quality_gate?.enabled)}>
                            {rulesConfig.stocks.long_quality_gate?.enabled ? 'ON' : 'OFF'}
                          </button>
                        </div>
                        {rulesConfig.stocks.long_quality_gate?.enabled && (
                          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                            <div className="form-group" style={{ flex: 1 }}>
                              <label>Min Score</label>
                              <input type="number" min="0" max="100" step="5" disabled={isRunning}
                                value={rulesConfig.stocks.long_quality_gate.scoreMin}
                                onChange={e => updateRule('stocks', 'long_quality_gate', 'scoreMin', parseFloat(e.target.value))} />
                            </div>
                            <div className="form-group" style={{ flex: 1 }}>
                              <label>Max VWAP Ext %</label>
                              <input type="number" min="0" step="0.1" disabled={isRunning}
                                value={rulesConfig.stocks.long_quality_gate.vwapMaxPct}
                                onChange={e => updateRule('stocks', 'long_quality_gate', 'vwapMaxPct', parseFloat(e.target.value))} />
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  {hasOption && (
                    <>
                      <div className="bt-params-label" style={{ marginTop: 10, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 11, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', borderRadius: 4, padding: '1px 7px', fontWeight: 700 }}>OPTION</span>
                        Rules
                      </div>
                      {[
                        ['volatile_no_trade',       'No trade in VOLATILE regime'],
                        ['disable_sma_breakout',    'Disable SMA_CROSSOVER and BREAKOUT'],
                        ['use_only_specific',       'Use only VWAP_PULLBACK / LIQUIDITY_SWEEP / BOLLINGER_REVERSION'],
                        ['no_same_candle_reversal', 'No same-candle reversal'],
                      ].map(([key, lbl]) => (
                        <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, paddingRight: 8 }}>{lbl}</span>
                          <button type="button" disabled={isRunning}
                            className={rulesConfig.options[key]?.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                            style={{ minWidth: 36 }}
                            onClick={() => updateRule('options', key, 'enabled', !rulesConfig.options[key]?.enabled)}>
                            {rulesConfig.options[key]?.enabled ? 'ON' : 'OFF'}
                          </button>
                        </div>
                      ))}
                      <div style={{ padding: '6px 0' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, paddingRight: 8 }}>Distrust scores driven by high volatility</span>
                          <button type="button" disabled={isRunning}
                            className={rulesConfig.options.distrust_high_vol_score?.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                            style={{ minWidth: 36 }}
                            onClick={() => updateRule('options', 'distrust_high_vol_score', 'enabled', !rulesConfig.options.distrust_high_vol_score?.enabled)}>
                            {rulesConfig.options.distrust_high_vol_score?.enabled ? 'ON' : 'OFF'}
                          </button>
                        </div>
                        {rulesConfig.options.distrust_high_vol_score?.enabled && (
                          <div className="form-group" style={{ marginTop: 6 }}>
                            <label>Max Volatility Score</label>
                            <input type="number" min="0" max="100" step="5" disabled={isRunning}
                              value={rulesConfig.options.distrust_high_vol_score.volScoreMax}
                              onChange={e => updateRule('options', 'distrust_high_vol_score', 'volScoreMax', parseFloat(e.target.value))} />
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </>
              );
            })()}
          </div>

          {/* ── Entry Filters ── */}
          <div className="card bt-risk-card" style={{ marginTop: 12 }}>
            <div className="bt-risk-toggle-row">
              <span className="bt-risk-label">Entry Filters
                <span className={entryFilterConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                  {entryFilterConfig.enabled ? 'enabled' : 'disabled'}
                </span>
              </span>
              <button type="button" disabled={isRunning}
                className={entryFilterConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                onClick={() => setEntryFilterConfig(p => ({ ...p, enabled: !p.enabled }))}>
                {entryFilterConfig.enabled ? 'ON' : 'OFF'}
              </button>
            </div>
            {entryFilterConfig.enabled && <>
              {[
              ['scoreGap',      'minGap',     'Min Gap',   0, 50,  0.5],
              ['cooldown',      'minBars',    'Min Bars',  1, 20,  1  ],
              ['vwapExtension', 'maxDistPct', 'Max Dist%', 0, 10,  0.1],
            ].map(([ruleKey, threshKey, threshLabel, min, max, step]) => {
              const rule = entryFilterConfig[ruleKey];
              const eitherOn = rule.stocks.enabled || rule.options.enabled;
              return (
                <div key={ruleKey} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: eitherOn ? 'var(--text-primary)' : 'var(--text-muted)', marginBottom: 4 }}>
                    {rule.label}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{rule.description}</div>
                  {/* Stock / Option toggles */}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 60 }}>Stocks</span>
                    <button type="button" disabled={isRunning}
                      className={rule.stocks.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                      style={{ minWidth: 36 }}
                      onClick={() => setEntryFilterConfig(p => ({ ...p, [ruleKey]: { ...p[ruleKey], stocks: { enabled: !p[ruleKey].stocks.enabled } } }))}>
                      {rule.stocks.enabled ? 'ON' : 'OFF'}
                    </button>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 60, marginLeft: 8 }}>Options</span>
                    <button type="button" disabled={isRunning}
                      className={rule.options.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                      style={{ minWidth: 36 }}
                      onClick={() => setEntryFilterConfig(p => ({ ...p, [ruleKey]: { ...p[ruleKey], options: { enabled: !p[ruleKey].options.enabled } } }))}>
                      {rule.options.enabled ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  {/* Threshold — always visible for quick tuning */}
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label>{threshLabel}</label>
                    <input type="number" min={min} max={max} step={step} disabled={isRunning}
                      value={rule[threshKey]}
                      onChange={e => setEntryFilterConfig(p => ({ ...p, [ruleKey]: { ...p[ruleKey], [threshKey]: parseFloat(e.target.value) } }))} />
                  </div>
                </div>
              );
            })}
              {/* Strategy Filter */}
              {(() => {
                const rule = entryFilterConfig.strategyFilter;
                const eitherOn = rule.stocks.enabled || rule.options.enabled;
                return (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: eitherOn ? 'var(--text-primary)' : 'var(--text-muted)', marginBottom: 4 }}>{rule.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{rule.description}</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 60 }}>Stocks</span>
                      <button type="button" disabled={isRunning}
                        className={rule.stocks.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'} style={{ minWidth: 36 }}
                        onClick={() => setEntryFilterConfig(p => ({ ...p, strategyFilter: { ...p.strategyFilter, stocks: { enabled: !p.strategyFilter.stocks.enabled } } }))}>
                        {rule.stocks.enabled ? 'ON' : 'OFF'}
                      </button>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 60, marginLeft: 8 }}>Options</span>
                      <button type="button" disabled={isRunning}
                        className={rule.options.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'} style={{ minWidth: 36 }}
                        onClick={() => setEntryFilterConfig(p => ({ ...p, strategyFilter: { ...p.strategyFilter, options: { enabled: !p.strategyFilter.options.enabled } } }))}>
                        {rule.options.enabled ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Blocked Strategies (comma-separated)</label>
                      <input type="text" disabled={isRunning} placeholder="e.g. SMA_CROSSOVER, EMA_CROSSOVER, MACD"
                        value={rule.blocked}
                        onChange={e => setEntryFilterConfig(p => ({ ...p, strategyFilter: { ...p.strategyFilter, blocked: e.target.value } }))} />
                    </div>
                  </div>
                );
              })()}
              {/* Confidence Gate */}
              {(() => {
                const rule = entryFilterConfig.confidenceGate;
                const eitherOn = rule.stocks.enabled || rule.options.enabled;
                return (
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: eitherOn ? 'var(--text-primary)' : 'var(--text-muted)', marginBottom: 4 }}>{rule.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>{rule.description}</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 60 }}>Stocks</span>
                      <button type="button" disabled={isRunning}
                        className={rule.stocks.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'} style={{ minWidth: 36 }}
                        onClick={() => setEntryFilterConfig(p => ({ ...p, confidenceGate: { ...p.confidenceGate, stocks: { enabled: !p.confidenceGate.stocks.enabled } } }))}>
                        {rule.stocks.enabled ? 'ON' : 'OFF'}
                      </button>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 60, marginLeft: 8 }}>Options</span>
                      <button type="button" disabled={isRunning}
                        className={rule.options.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'} style={{ minWidth: 36 }}
                        onClick={() => setEntryFilterConfig(p => ({ ...p, confidenceGate: { ...p.confidenceGate, options: { enabled: !p.confidenceGate.options.enabled } } }))}>
                        {rule.options.enabled ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                        <label>Min Gap</label>
                        <input type="number" min="0" max="50" step="0.5" disabled={isRunning}
                          value={rule.minGap}
                          onChange={e => setEntryFilterConfig(p => ({ ...p, confidenceGate: { ...p.confidenceGate, minGap: parseFloat(e.target.value) } }))} />
                      </div>
                      <div className="form-group" style={{ flex: 2, marginBottom: 0 }}>
                        <label>Exception Strategy</label>
                        <input type="text" disabled={isRunning} placeholder="e.g. LIQUIDITY_SWEEP"
                          value={rule.exceptionStrategy}
                          onChange={e => setEntryFilterConfig(p => ({ ...p, confidenceGate: { ...p.confidenceGate, exceptionStrategy: e.target.value } }))} />
                      </div>
                    </div>
                  </div>
                );
              })()}
            </>}
          </div>

        </div>

        {/* Right: tabs */}
        <div className="bt-replay-feed">

          {/* Status + progress */}
          <div className="card bt-feed-status">
            <div className="bt-feed-status-row">
              <span className={`bt-status-pill bt-status-${status}`}>{status.toUpperCase()}</span>
              {sessionId && <span className="mono-sm" style={{ color: 'var(--text-muted)', fontSize: 11 }}>{sessionId.substring(0, 16)}…</span>}
              {progress.total > 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{progress.emitted} / {progress.total} candles</span>
              )}
            </div>
            {progress.total > 0 && (
              <div className="bt-progress-bar">
                <div className="bt-progress-fill" style={{ width: `${Math.min(100, (progress.emitted / progress.total) * 100)}%` }} />
              </div>
            )}
          </div>

          {/* Tab bar */}
          <div className="bt-live-right-tabs">
            {[['feed','Feed'],['pnl','P&L'],['portfolio','Portfolio'],['details','Details']].map(([k,l]) => (
              <button key={k} className={`bt-live-tab-btn ${rightTab===k?'active':''}`} onClick={() => setRightTab(k)}>{l}</button>
            ))}
          </div>

          {/* ── Feed tab ── */}
          {rightTab === 'feed' && (
            <>
              {currentCandle && (
                <div className="card bt-current-candle">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                    <div>
                      <span style={{ fontWeight: 700, fontSize: 15 }}>{currentCandle.symbol}</span>
                      <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-muted)' }}>{currentCandle.ts}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {Object.entries(currentCandle.signals || {}).map(([lbl, sig]) => (
                        <span key={lbl} style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {lbl}: {signalBadge(sig)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="bt-ohlc-row">
                    {[['O', currentCandle.open],['H', currentCandle.high],['L', currentCandle.low],['C', currentCandle.close]].map(([l, v]) => (
                      <span key={l}><span className="meta-label">{l}</span> {Number(v).toFixed(2)}</span>
                    ))}
                    <span><span className="meta-label">Vol</span> {currentCandle.volume?.toLocaleString()}</span>
                  </div>
                </div>
              )}

              <div className="card" style={{ padding: 0 }}>
                <div className="bt-feed-header">
                  <span className="bt-params-label" style={{ margin: 0 }}>Trade Log</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {feed.filter(f => f.signal !== 'HOLD').length} actions / {feed.length} total
                  </span>
                </div>
                <div className="bt-signal-log">
                  {feed.length === 0
                    ? <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Actions will appear here when replay starts.</div>
                    : feed.map((row, i) => (
                      <div key={i} className={`bt-signal-row ${row.signal !== 'HOLD' ? 'bt-signal-actionable' : ''}`}>
                        <span className="mono-sm" style={{ color: 'var(--text-muted)', minWidth: 56 }}>{row.ts}</span>
                        {row.signal === 'SHORT'
                          ? <span className="badge" style={{ background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.3)', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700 }}>SHORT↓</span>
                          : signalBadge(row.signal)
                        }
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 90 }}>{row.strategyLabel}</span>
                        <span style={{ flex: 1, fontSize: 12 }}>{row.symbol}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>₹{Number(row.close).toFixed(2)}</span>
                        {row.note && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{row.note}</span>}
                      </div>
                    ))
                  }
                </div>
              </div>

              {/* Tick Stream */}
              <div className="card" style={{ padding: 0 }}>
                <div className="bt-feed-header">
                  <span className="bt-params-label" style={{ margin: 0 }}>Tick Stream</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ticks.length} received</span>
                </div>
                <div className="bt-signal-log">
                  {ticks.length === 0
                    ? <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                        Ticks will appear here when replay starts.
                      </div>
                    : ticks.map((t, i) => (
                      <div key={i} className="bt-signal-row">
                        <span className="mono-sm" style={{ color: 'var(--text-muted)', minWidth: 56 }}>{t.ts}</span>
                        <span style={{ fontWeight: 600, fontSize: 12, minWidth: 80 }}>{t.symbol}</span>
                        <span style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 700 }}>{fmtRs(t.ltp)}</span>
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
            </>
          )}

          {/* ── P&L tab ── */}
          {rightTab === 'pnl' && (
            <div className="card">
              <h3 className="section-title" style={{ marginBottom: 12 }}>P&L Summary</h3>
              <div className="bt-live-pnl-grid" style={{ marginBottom: 16 }}>
                {[
                  ['Total Capital', fmtRs(totalCapital), null],
                  ['Total P&L', fmtRs(totalPnl), totalPnl >= 0 ? '#22c55e' : '#ef4444'],
                  ['Return %', `${totalPnlPct.toFixed(2)}%`, totalPnlPct >= 0 ? '#22c55e' : '#ef4444'],
                  ['Total Trades', String(allTrades.length), null],
                  ['Win Rate', allTrades.length ? `${(allTrades.filter(t=>t.pnl>=0).length/allTrades.length*100).toFixed(1)}%` : '—', null],
                ].map(([lbl, val, col]) => (
                  <div key={lbl} className="bt-live-stat-card">
                    <div className="bt-live-stat-label">{lbl}</div>
                    <div className="bt-live-stat-val" style={col ? { color: col } : {}}>{val}</div>
                  </div>
                ))}
              </div>

              {allLabels.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['Strategy','Capital','P&L','Return %','Trades','Win%'].map(h => (
                        <th key={h} style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {allLabels.filter(l => l !== COMBINED_LABEL).map(lbl => {
                      const st = stratStates[lbl];
                      const cap = st?.capital ?? initCap;
                      const pnl = cap - initCap;
                      const pct = (pnl / initCap) * 100;
                      const trades = st?.closedTrades || [];
                      const wins = trades.filter(t => t.pnl >= 0).length;
                      return (
                        <tr key={lbl} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '6px 8px', fontWeight: 600 }}>{lbl}</td>
                          <td style={{ padding: '6px 8px' }}>{fmtRs(cap)}</td>
                          <td style={{ padding: '6px 8px', color: pnl >= 0 ? '#22c55e' : '#ef4444' }}>{fmtRs(pnl)}</td>
                          <td style={{ padding: '6px 8px', color: pct >= 0 ? '#22c55e' : '#ef4444' }}>{pct.toFixed(2)}%</td>
                          <td style={{ padding: '6px 8px' }}>{trades.length}</td>
                          <td style={{ padding: '6px 8px' }}>{trades.length ? `${(wins/trades.length*100).toFixed(1)}%` : '—'}</td>
                        </tr>
                      );
                    })}
                    {stratStates[COMBINED_LABEL] && (() => {
                      const st  = stratStates[COMBINED_LABEL];
                      const cap = st?.capital ?? initCap;
                      const pnl = cap - initCap;
                      const pct = (pnl / initCap) * 100;
                      const trades = st?.closedTrades || [];
                      const wins = trades.filter(t => t.pnl >= 0).length;
                      return (
                        <tr style={{ borderTop: '2px solid rgba(139,92,246,0.4)', background: 'rgba(139,92,246,0.06)' }}>
                          <td style={{ padding: '6px 8px', fontWeight: 700 }}>
                            <span style={{ color: '#8b5cf6' }}>{COMBINED_LABEL}</span>
                            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>regime-switched</span>
                          </td>
                          <td style={{ padding: '6px 8px', fontWeight: 600 }}>{fmtRs(cap)}</td>
                          <td style={{ padding: '6px 8px', fontWeight: 600, color: pnl >= 0 ? '#22c55e' : '#ef4444' }}>{fmtRs(pnl)}</td>
                          <td style={{ padding: '6px 8px', fontWeight: 600, color: pct >= 0 ? '#22c55e' : '#ef4444' }}>{pct.toFixed(2)}%</td>
                          <td style={{ padding: '6px 8px' }}>{trades.length}</td>
                          <td style={{ padding: '6px 8px' }}>{trades.length ? `${(wins/trades.length*100).toFixed(1)}%` : '—'}</td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </table>
              )}
              {allLabels.length === 0 && (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>P&L data will appear after replay starts.</div>
              )}
            </div>
          )}

          {/* ── Portfolio tab ── */}
          {rightTab === 'portfolio' && (
            <div className="card">
              <h3 className="section-title" style={{ marginBottom: 12 }}>Open Positions</h3>
              {allLabels.filter(l => stratStates[l]?.openPosition).length > 0
                ? allLabels.filter(l => stratStates[l]?.openPosition).map(lbl => {
                    const pos = stratStates[lbl].openPosition;
                    const isCombined = lbl === COMBINED_LABEL;
                    return (
                      <div key={lbl} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13,
                        ...(isCombined ? { background: 'rgba(139,92,246,0.06)', borderRadius: 6, padding: '8px 10px' } : {}) }}>
                        <span style={{ fontWeight: 600, minWidth: 120, color: isCombined ? '#8b5cf6' : undefined }}>{lbl}</span>
                        {pos.type === 'SHORT'
                          ? <span className="badge" style={{ background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.3)', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700 }}>SHORT↓</span>
                          : <span className="badge badge-success">LONG↑</span>}
                        {isCombined && pos.regime && <span className={`bt-regime-badge bt-regime-${pos.regime}`}>{pos.regime}</span>}
                        <span>Entry: <strong>₹{Number(pos.entryPrice).toFixed(2)}</strong></span>
                        <span>Qty: {pos.qty}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{pos.entryTime}</span>
                      </div>
                    );
                  })
                : <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>No open positions.</div>
              }

              {allLabels.some(l => (stratStates[l]?.closedTrades || []).length > 0) && (
                <>
                  <h3 className="section-title" style={{ margin: '16px 0 10px' }}>Trade History</h3>
                  {allLabels.filter(l => l !== COMBINED_LABEL).concat(stratStates[COMBINED_LABEL] ? [COMBINED_LABEL] : []).map(lbl => {
                    const trades = stratStates[lbl]?.closedTrades || [];
                    if (!trades.length) return null;
                    const isCombined = lbl === COMBINED_LABEL;
                    return (
                      <div key={lbl} style={{ marginBottom: 16, ...(isCombined ? { background: 'rgba(139,92,246,0.05)', borderRadius: 8, padding: '8px 10px', border: '1px solid rgba(139,92,246,0.2)' } : {}) }}>
                        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6, color: isCombined ? '#8b5cf6' : undefined }}>
                          {lbl}{isCombined && <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8, fontWeight: 400 }}>score-switched pool</span>}
                        </div>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                          <thead>
                            <tr style={{ borderBottom: '1px solid var(--border)' }}>
                              {['Dir','Regime','Entry','Exit','Qty','Entry ₹','Exit ₹','P&L','Reason',
                                ...(isCombined ? ['Strategy','Score'] : [])].map(h => (
                                <th key={h} style={{ textAlign: 'left', padding: '3px 6px', color: 'var(--text-muted)' }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {trades.map((t, i) => (
                              <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                                <td style={{ padding: '4px 6px' }}>
                                  {t.type === 'SHORT'
                                    ? <span style={{ color: '#8b5cf6', fontWeight: 700, fontSize: 11 }}>SHORT↓</span>
                                    : <span style={{ color: '#22c55e', fontWeight: 700, fontSize: 11 }}>LONG↑</span>}
                                </td>
                                <td style={{ padding: '4px 6px' }}>
                                  {t.regime
                                    ? <span className={`bt-regime-badge bt-regime-${t.regime}`}>{t.regime}</span>
                                    : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                </td>
                                <td style={{ padding: '4px 6px' }}>{t.entryTime}</td>
                                <td style={{ padding: '4px 6px' }}>{t.exitTime}</td>
                                <td style={{ padding: '4px 6px' }}>{t.qty}</td>
                                <td style={{ padding: '4px 6px' }}>₹{Number(t.entryPrice).toFixed(2)}</td>
                                <td style={{ padding: '4px 6px' }}>₹{Number(t.exitPrice).toFixed(2)}</td>
                                <td style={{ padding: '4px 6px', color: t.pnl >= 0 ? '#22c55e' : '#ef4444' }}>
                                  {t.pnl >= 0 ? '+' : ''}{fmtRs(t.pnl)} ({t.pnlPct?.toFixed(2)}%)
                                </td>
                                <td style={{ padding: '4px 6px', color: 'var(--text-muted)' }}>{t.exitReason}</td>
                                {isCombined && (
                                  <>
                                    <td style={{ padding: '4px 6px', fontSize: 10 }}>{t.sourceStrategy || '—'}</td>
                                    <td style={{ padding: '4px 6px', fontFamily: 'monospace', fontSize: 10,
                                      color: t.entryScore?.total >= 60 ? '#22c55e' : t.entryScore?.total >= 40 ? '#f59e0b' : '#ef4444' }}>
                                      {t.entryScore ? t.entryScore.total.toFixed(1) : '—'}
                                    </td>
                                  </>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* ── Details tab ── */}
          {rightTab === 'details' && (() => {
            const stratLabels = strategies.filter(s => s.enabled).map(s => s.label || s.strategyType);

            // Human-readable action label
            function fmtAction(a) {
              const r = a.reason === 'STOP_LOSS'   ? 'Stop Loss hit'
                      : a.reason === 'TAKE_PROFIT' ? 'Take Profit hit'
                      : a.reason === 'SIGNAL'      ? 'Signal'
                      : a.reason || '';
              if (a.signal === 'SHORT')             return `Enter Short — ${a.strategy} @${Number(a.price).toFixed(2)}`;
              if (a.signal === 'BUY'  && !a.reason) return `Enter Long — ${a.strategy} @${Number(a.price).toFixed(2)}`;
              if (a.signal === 'BUY'  &&  a.reason) return `Exit Short — ${a.strategy} @${Number(a.price).toFixed(2)} [${r}]`;
              if (a.signal === 'SELL')               return `Exit Long — ${a.strategy} @${Number(a.price).toFixed(2)} [${r}]`;
              return `${a.signal} — ${a.strategy} @${Number(a.price).toFixed(2)}`;
            }

            function downloadCSV() {
              const q = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
              const row = (...cols) => cols.map(q).join(',');
              const blank = '';
              const lines = [];

              // ── Instrument Details ────────────────────────────────────
              lines.push(row('=== Instrument Details ==='));
              lines.push(row('Symbol','Exchange','Token','Interval','From','To','Speed'));
              lines.push(row(inst.symbol, inst.exchange, inst.instrumentToken,
                replayInterval, fromDate, toDate, `${speed}x`));
              lines.push(blank);

              // ── Preload / Warmup ──────────────────────────────────────
              lines.push(row('=== Preload / Warmup ==='));
              lines.push(row('Enabled','Days Back','Interval','Candles Warmed Up'));
              lines.push(row(
                preload.enabled ? 'Yes' : 'No',
                preload.enabled ? preload.daysBack : '—',
                preload.enabled ? preload.interval : '—',
                preloadState.status === 'done' ? preloadState.count : '—',
              ));
              lines.push(blank);

              // ── Strategies ────────────────────────────────────────────
              lines.push(row('=== Strategies ==='));
              lines.push(row('Name','Type','Allow Shorting'));
              strategies.filter(s => s.enabled).forEach(s => {
                lines.push(row(s.label || s.strategyType, s.strategyType, s.allowShorting ? 'Yes' : 'No'));
              });
              lines.push(blank);

              // ── Risk Management ───────────────────────────────────────
              if (riskConfig.enabled) {
                lines.push(row('=== Risk Management ==='));
                lines.push(row('Stop Loss %','Take Profit %','Max Risk Per Trade %','Cooldown Candles','Daily Loss Cap %'));
                lines.push(row(
                  riskConfig.stopLossPct   || '—',
                  riskConfig.takeProfitPct || '—',
                  riskConfig.maxRiskPerTradePct || '—',
                  riskConfig.cooldownCandles    || '—',
                  riskConfig.dailyLossCapPct    || '—',
                ));
                lines.push(blank);
              }

              // ── Market Regime Detection ───────────────────────────────
              if (regimeConfig.enabled) {
                lines.push(row('=== Market Regime Detection ==='));
                lines.push(row('ADX Period','ATR Period','ADX Trend Threshold','ATR Volatile %','ATR Compression %'));
                lines.push(row(
                  regimeConfig.adxPeriod,
                  regimeConfig.atrPeriod,
                  regimeConfig.adxTrendThreshold,
                  regimeConfig.atrVolatilePct,
                  regimeConfig.atrCompressionPct,
                ));
                lines.push(blank);
              }

              // ── Pattern Confirmation (only if enabled) ─────────────────
              if (patternConfig.enabled) {
                lines.push(row('=== Pattern Confirmation ==='));
                lines.push(row('Buy Confirm Patterns','Sell Confirm Patterns','Min Wick Ratio','Max Body %'));
                lines.push(row(
                  (patternConfig.buyConfirmPatterns  || []).join('; ') || 'Any',
                  (patternConfig.sellConfirmPatterns || []).join('; ') || 'Any',
                  patternConfig.minWickRatio,
                  patternConfig.maxBodyPct,
                ));
                lines.push(blank);
              }

              // ── Trading Rules ──────────────────────────────────────────
              if (rulesConfig.enabled) {
                const csvInstrType = resolveInstrType(inst.instrumentType, inst.symbol, inst.exchange);
                lines.push(row(`=== Trading Rules (${csvInstrType}) ===`));
                lines.push(row('Rule','Enabled','Parameters'));
                if (csvInstrType === 'STOCK') {
                  const sr = rulesConfig.stocks;
                  lines.push(row('No trade in RANGING regime',           sr.ranging_no_trade?.enabled        ? 'ON' : 'OFF', ''));
                  lines.push(row('SHORT only in COMPRESSION regime',     sr.compression_short_only?.enabled  ? 'ON' : 'OFF', ''));
                  lines.push(row('LONG quality gate',                    sr.long_quality_gate?.enabled       ? 'ON' : 'OFF',
                    sr.long_quality_gate?.enabled ? `Min Score: ${sr.long_quality_gate.scoreMin} | Max VWAP Ext: ${sr.long_quality_gate.vwapMaxPct}%` : ''));
                  lines.push(row('No same-candle reversal',              sr.no_same_candle_reversal?.enabled ? 'ON' : 'OFF', ''));
                } else {
                  const or = rulesConfig.options;
                  lines.push(row('No trade in VOLATILE regime',               or.volatile_no_trade?.enabled       ? 'ON' : 'OFF', ''));
                  lines.push(row('Disable SMA_CROSSOVER and BREAKOUT',        or.disable_sma_breakout?.enabled    ? 'ON' : 'OFF', ''));
                  lines.push(row('Use only VWAP / LIQUIDITY / BOLLINGER',     or.use_only_specific?.enabled       ? 'ON' : 'OFF', ''));
                  lines.push(row('No same-candle reversal',                   or.no_same_candle_reversal?.enabled ? 'ON' : 'OFF', ''));
                  lines.push(row('Distrust scores driven by high volatility', or.distrust_high_vol_score?.enabled ? 'ON' : 'OFF',
                    or.distrust_high_vol_score?.enabled ? `Max Vol Score: ${or.distrust_high_vol_score.volScoreMax}` : ''));
                }
                lines.push(blank);
              }

              // ── Entry Filters ──────────────────────────────────────────
              {
                const ef = entryFilterConfig;
                lines.push(row('=== Entry Filters ==='));
                lines.push(row('Master', ef.enabled ? 'ON' : 'OFF'));
                lines.push(row('Rule', 'Stocks', 'Options', 'Threshold'));
                lines.push(row(
                  'Score Gap (winner − second)',
                  ef.scoreGap.stocks.enabled  ? 'ON' : 'OFF',
                  ef.scoreGap.options.enabled ? 'ON' : 'OFF',
                  `Min Gap: ${ef.scoreGap.minGap}`,
                ));
                lines.push(row(
                  'Cooldown (bars since last trade)',
                  ef.cooldown.stocks.enabled  ? 'ON' : 'OFF',
                  ef.cooldown.options.enabled ? 'ON' : 'OFF',
                  `Min Bars: ${ef.cooldown.minBars}`,
                ));
                lines.push(row(
                  'VWAP Extension Filter',
                  ef.vwapExtension.stocks.enabled  ? 'ON' : 'OFF',
                  ef.vwapExtension.options.enabled ? 'ON' : 'OFF',
                  `Max Dist: ${ef.vwapExtension.maxDistPct}%`,
                ));
                lines.push(row(
                  'Strategy Allowlist (blocked)',
                  ef.strategyFilter.stocks.enabled  ? 'ON' : 'OFF',
                  ef.strategyFilter.options.enabled ? 'ON' : 'OFF',
                  `Blocked: ${ef.strategyFilter.blocked || '—'}`,
                ));
                lines.push(row(
                  'Confidence Gate',
                  ef.confidenceGate.stocks.enabled  ? 'ON' : 'OFF',
                  ef.confidenceGate.options.enabled ? 'ON' : 'OFF',
                  `Min Gap: ${ef.confidenceGate.minGap} | Exception: ${ef.confidenceGate.exceptionStrategy || '—'}`,
                ));
                lines.push(blank);
              }

              // ── P&L Summary ───────────────────────────────────────────
              lines.push(row('=== P&L Summary ==='));
              lines.push(row('Strategy','Initial Capital','Final Capital','P&L','Return %','Total Trades','Wins','Losses','Win Rate %'));
              const allPnlLabels = [...stratLabels, ...(stratStates[COMBINED_LABEL] ? [COMBINED_LABEL] : [])];
              allPnlLabels.forEach(lbl => {
                const st     = stratStates[lbl];
                const cap    = st?.capital ?? initCap;
                const pnl    = cap - initCap;
                const pct    = ((pnl / initCap) * 100).toFixed(2);
                const trades = st?.closedTrades || [];
                const wins   = trades.filter(t => t.pnl >= 0).length;
                const losses = trades.length - wins;
                const wr     = trades.length ? ((wins / trades.length) * 100).toFixed(1) : '—';
                lines.push(row(lbl, initCap.toFixed(2), cap.toFixed(2), pnl.toFixed(2), pct, trades.length, wins, losses, wr));
              });
              lines.push(blank);

              // ── Score-Based Combined Pool ──────────────────────────────
              if (scoreConfig.enabled) {
                lines.push(row('=== Score-Based Combined Pool ==='));
                lines.push(row('Min Score Threshold'));
                lines.push(row(scoreConfig.minScoreThreshold));
                lines.push(blank);
              }

              // ── Trade History ─────────────────────────────────────────
              lines.push(row('=== Trade History ==='));
              lines.push(row('Strategy','Direction','Entry Time','Exit Time','Qty',
                'Entry Price','Exit Price','P&L','P&L %','Exit Reason',
                ...(regimeConfig.enabled ? ['Regime'] : []),
                ...(scoreConfig.enabled  ? ['Selected Strategy','Entry Score'] : [])));
              allPnlLabels.forEach(lbl => {
                const isComb = lbl === COMBINED_LABEL;
                const trades = stratStates[lbl]?.closedTrades || [];
                trades.slice().reverse().forEach(t => {
                  lines.push(row(
                    lbl,
                    t.type || 'LONG',
                    t.entryTime,
                    t.exitTime,
                    t.qty,
                    Number(t.entryPrice).toFixed(2),
                    Number(t.exitPrice).toFixed(2),
                    Number(t.pnl).toFixed(2),
                    Number(t.pnlPct ?? 0).toFixed(2),
                    t.exitReason === 'STOP_LOSS'   ? 'Stop Loss hit'
                      : t.exitReason === 'TAKE_PROFIT' ? 'Take Profit hit'
                      : t.exitReason || 'Signal',
                    ...(regimeConfig.enabled ? [t.regime ?? ''] : []),
                    ...(scoreConfig.enabled  ? [isComb ? (t.sourceStrategy || '') : '', isComb && t.entryScore ? t.entryScore.total.toFixed(1) : ''] : []),
                  ));
                });
              });
              lines.push(blank);

              // ── Candle Data ───────────────────────────────────────────
              lines.push(row('=== Candle Data ==='));
              const fmtCombinedAction = cd =>
                `${cd.action} @${Number(cd.price).toFixed(2)}` +
                (cd.sourceStrategy ? ` via ${cd.sourceStrategy}` : '') +
                (cd.regime         ? ` [${cd.regime}]`           : '') +
                ` · ${cd.reason}` +
                (cd.score ? ` · score=${cd.score.total.toFixed(1)}(trend=${cd.score.trendStrength.toFixed(0)},vol=${cd.score.volatility.toFixed(0)},mom=${cd.score.momentum.toFixed(0)},conf=${cd.score.confidence.toFixed(0)})` : '') +
                (cd.trigger ? ` · ${cd.trigger}` : '');
              // Shared extra columns for every candle
              const csvInstrType = resolveInstrType(inst.instrumentType, inst.symbol, inst.exchange);
              const csvIsOption  = csvInstrType === 'OPTION';

              // Entry Filter: returns 'ALLOW' / 'SKIP: reason' for candles with combined entries, '' otherwise
              const applyEntryFilters = r => {
                const hasEntry = (r.combinedDetails || []).some(d =>
                  typeof d.action === 'string' && d.action.toLowerCase().includes('enter')
                );
                if (!hasEntry) return '';
                const reasons = [];
                if (!entryFilterConfig.enabled) return 'ALLOW';
                const active = k => csvIsOption ? entryFilterConfig[k].options.enabled : entryFilterConfig[k].stocks.enabled;

                const sgRule = entryFilterConfig.scoreGap;
                if (active('scoreGap') && r.scoreGap != null && r.scoreGap < parseFloat(sgRule.minGap || 2))
                  reasons.push(`ScoreGap ${Number(r.scoreGap).toFixed(1)} < ${sgRule.minGap}`);

                const cdRule = entryFilterConfig.cooldown;
                if (active('cooldown') && r.candlesSinceLastTrade != null && r.candlesSinceLastTrade < parseInt(cdRule.minBars || 3))
                  reasons.push(`Cooldown ${r.candlesSinceLastTrade} < ${cdRule.minBars}`);

                const veRule = entryFilterConfig.vwapExtension;
                if (active('vwapExtension') && r.distanceFromVwapPct != null && Math.abs(r.distanceFromVwapPct) > parseFloat(veRule.maxDistPct || 1.5))
                  reasons.push(`VWAPExt ${Number(r.distanceFromVwapPct).toFixed(2)}% > ${veRule.maxDistPct}%`);

                const sfRule = entryFilterConfig.strategyFilter;
                if (active('strategyFilter') && r.combinedWinner) {
                  const blockedList = (sfRule.blocked || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
                  if (blockedList.includes((r.combinedWinner || '').toUpperCase()))
                    reasons.push(`Strategy ${r.combinedWinner} blocked`);
                }

                const cgRule = entryFilterConfig.confidenceGate;
                if (active('confidenceGate')) {
                  const exception = (cgRule.exceptionStrategy || '').trim().toUpperCase();
                  const winner    = (r.combinedWinner || '').toUpperCase();
                  if (r.scoreGap != null && r.scoreGap < parseFloat(cgRule.minGap || 3) && winner !== exception)
                    reasons.push(`ConfGap ${Number(r.scoreGap).toFixed(1)} < ${cgRule.minGap} (not ${cgRule.exceptionStrategy})`);
                }

                return reasons.length > 0 ? `SKIP: ${reasons.join('; ')}` : 'ALLOW';
              };

              const extraCols = [
                'Comb Position','Comb Unreal P&L','Comb Winner','Comb Winner Score','Confidence(ScoreGap)',
                'Comb All Scored','Comb Above Threshold','Comb Block Reason',
                'VWAP','DistanceFromVWAP%','RecentMove3%','RecentMove5%','Entry Phase','Entry Type','BarsSinceLastTrade',
                'Entry Filter',
              ];
              const fmtCombPos = r => {
                if (!r.combinedPosition) return '';
                const p = r.combinedPosition;
                return `${p.type} @${Number(p.entryPrice).toFixed(2)} x${p.qty}`;
              };
              const fmtEntryPhase = r => {
                const d = r.distanceFromVwapPct, m = r.recentMovePct;
                if (d == null || m == null) return '';
                const absD = Math.abs(d), absM = Math.abs(m);
                if (absD < 0.5 && absM < 0.5) return 'EARLY';
                if (absD > 1.5 || absM > 1.5) return 'LATE';
                return 'MID';
              };
              const fmtExtraCols = r => [
                fmtCombPos(r),
                r.combinedUnrealizedPnl != null ? Number(r.combinedUnrealizedPnl).toFixed(2) : '',
                r.combinedWinner || '',
                r.combinedWinnerScore != null ? Number(r.combinedWinnerScore).toFixed(1) : '',
                r.scoreGap != null ? Number(r.scoreGap).toFixed(1) : '',
                (r.combinedAllScored || []).join(' / '),
                (r.combinedCandidates || []).join(' | '),
                r.combinedBlockReason || '',
                r.vwap != null ? Number(r.vwap).toFixed(2) : '',
                r.distanceFromVwapPct != null ? Number(r.distanceFromVwapPct).toFixed(2) : '',
                r.recentMovePct != null ? Number(r.recentMovePct).toFixed(2) : '',
                r.recentMove5Pct != null ? Number(r.recentMove5Pct).toFixed(2) : '',
                fmtEntryPhase(r),
                r.entryTypeTag || '',
                r.candlesSinceLastTrade != null ? r.candlesSinceLastTrade : '',
                applyEntryFilters(r),
              ];

              if (combinedOnlyMode) {
                // Combined-only CSV: no per-strategy signal/action columns
                lines.push(row('Time','Open','High','Low','Close','Volume',
                  ...(regimeConfig.enabled ? ['Regime'] : []),
                  'Strategy Signals', ...extraCols, 'Combined Actions', 'Blocked Signals'));
                candleLogRef.current.forEach(r => {
                  const stratSignalsStr = Object.entries(r.signals || {})
                    .map(([lbl, sig]) => `${lbl}: ${sig}`).join(' | ');
                  const blockedStr = (r.blockedSignals || []).map(b =>
                    `${b.strategy} ${b.signal} @${Number(b.price).toFixed(2)} — ${b.reason}`
                  ).join(' | ');
                  lines.push(row(
                    r.ts,
                    Number(r.open).toFixed(2),
                    Number(r.high).toFixed(2),
                    Number(r.low).toFixed(2),
                    Number(r.close).toFixed(2),
                    r.volume ?? '',
                    ...(regimeConfig.enabled ? [r.regime ?? ''] : []),
                    stratSignalsStr,
                    ...fmtExtraCols(r),
                    (r.combinedDetails || []).map(fmtCombinedAction).join(' | '),
                    blockedStr,
                  ));
                });
              } else {
                const sigCols = stratLabels.map(l => `Signal_${l}`);
                lines.push(row('Time','Open','High','Low','Close','Volume',
                  ...(regimeConfig.enabled ? ['Regime'] : []),
                  ...sigCols, ...extraCols, 'Strategy Actions', 'Blocked Signals', 'Combined Actions'));
                candleLogRef.current.forEach(r => {
                  const blockedStr = (r.blockedSignals || []).map(b =>
                    `${b.strategy} ${b.signal} @${Number(b.price).toFixed(2)} — ${b.reason}`
                  ).join(' | ');
                  lines.push(row(
                    r.ts,
                    Number(r.open).toFixed(2),
                    Number(r.high).toFixed(2),
                    Number(r.low).toFixed(2),
                    Number(r.close).toFixed(2),
                    r.volume ?? '',
                    ...(regimeConfig.enabled ? [r.regime ?? ''] : []),
                    ...stratLabels.map(l => r.signals?.[l] ?? ''),
                    ...fmtExtraCols(r),
                    r.actions.map(fmtAction).join(' | '),
                    blockedStr,
                    (r.combinedDetails || []).map(fmtCombinedAction).join(' | '),
                  ));
                });
              }

              const csv  = lines.join('\n');
              const blob = new Blob([csv], { type: 'text/csv' });
              const url  = URL.createObjectURL(blob);
              const a    = document.createElement('a');
              a.href = url; a.download = `replay_${inst.symbol || 'data'}_${fromDate}.csv`; a.click();
              URL.revokeObjectURL(url);
            }

            // ── Info summary cards shown at top of tab ─────────────────
            const infoBlocks = [
              { label: 'Instrument', items: [
                  `${inst.symbol || '—'} · ${inst.exchange || '—'}`,
                  `Token: ${inst.instrumentToken || '—'}`,
                  `${replayInterval} · ${fromDate} → ${toDate} · ${speed}x`,
              ]},
              ...(riskConfig.enabled ? [{ label: 'Risk Management', items: [
                  riskConfig.stopLossPct    ? `SL: ${riskConfig.stopLossPct}%`        : null,
                  riskConfig.takeProfitPct  ? `TP: ${riskConfig.takeProfitPct}%`      : null,
                  riskConfig.maxRiskPerTradePct ? `Max Risk/Trade: ${riskConfig.maxRiskPerTradePct}%` : null,
                  riskConfig.cooldownCandles    ? `Cooldown: ${riskConfig.cooldownCandles} candles`   : null,
                  riskConfig.dailyLossCapPct    ? `Daily Cap: ${riskConfig.dailyLossCapPct}%`         : null,
              ].filter(Boolean) }] : []),
              ...(regimeConfig.enabled ? [{ label: 'Regime Detection', items: [
                  `ADX ${regimeConfig.adxPeriod}p · Trend ≥ ${regimeConfig.adxTrendThreshold}`,
                  `ATR ${regimeConfig.atrPeriod}p · Volatile ≥ ${regimeConfig.atrVolatilePct}% · Compress ≤ ${regimeConfig.atrCompressionPct}%`,
              ] }] : []),
              ...(patternConfig.enabled ? [{ label: 'Pattern Confirmation', items: [
                  `Buy: ${(patternConfig.buyConfirmPatterns||[]).join(', ') || 'Any'}`,
                  `Sell: ${(patternConfig.sellConfirmPatterns||[]).join(', ') || 'Any'}`,
                  `Wick ≥ ${patternConfig.minWickRatio} · Body ≤ ${patternConfig.maxBodyPct}%`,
              ] }] : []),
              ...(scoreConfig.enabled ? [{ label: 'Score-Based Pool', items: [
                  `Min Score: ${scoreConfig.minScoreThreshold}`,
              ] }] : []),
              ...(rulesConfig.enabled ? (() => {
                const iType = resolveInstrType(inst.instrumentType, inst.symbol, inst.exchange);
                const items = iType === 'STOCK' ? [
                  rulesConfig.stocks.ranging_no_trade?.enabled        ? 'No trade in RANGING' : null,
                  rulesConfig.stocks.compression_short_only?.enabled  ? 'SHORT only in COMPRESSION' : null,
                  rulesConfig.stocks.long_quality_gate?.enabled       ? `LONG gate: score≥${rulesConfig.stocks.long_quality_gate.scoreMin} VWAP≤${rulesConfig.stocks.long_quality_gate.vwapMaxPct}%` : null,
                  rulesConfig.stocks.no_same_candle_reversal?.enabled ? 'No same-candle reversal' : null,
                ].filter(Boolean) : [
                  rulesConfig.options.volatile_no_trade?.enabled       ? 'No trade in VOLATILE' : null,
                  rulesConfig.options.disable_sma_breakout?.enabled    ? 'SMA/BREAKOUT disabled' : null,
                  rulesConfig.options.use_only_specific?.enabled       ? 'VWAP/LIQUIDITY/BOLLINGER only' : null,
                  rulesConfig.options.no_same_candle_reversal?.enabled ? 'No same-candle reversal' : null,
                  rulesConfig.options.distrust_high_vol_score?.enabled ? `Distrust vol score >${rulesConfig.options.distrust_high_vol_score.volScoreMax}` : null,
                ].filter(Boolean);
                return items.length ? [{ label: `Rules (${iType})`, items }] : [];
              })() : []),
            ];

            return (
              <div className="card" style={{ padding: 0 }}>
                <div className="bt-feed-header">
                  <span className="bt-params-label" style={{ margin: 0 }}>Candle Details</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{candleLog.length} candles</span>
                    <button type="button"
                      onClick={() => setCombOnlyView(v => !v)}
                      style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, border: '1px solid', cursor: 'pointer',
                        background:  combOnlyView ? 'rgba(234,179,8,0.15)'  : 'transparent',
                        color:       combOnlyView ? '#ca8a04'               : 'var(--text-muted)',
                        borderColor: combOnlyView ? 'rgba(234,179,8,0.4)'   : 'var(--border)' }}>
                      {combOnlyView ? '⚡ Combined View' : 'All View'}
                    </button>
                    {candleLog.length > 0 && (
                      <button type="button" className="btn-secondary btn-xs" onClick={downloadCSV}>Download CSV</button>
                    )}
                  </div>
                </div>

                {/* ── Feature summary ── */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                  {infoBlocks.map(blk => (
                    <div key={blk.label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', minWidth: 160, flex: '1 1 160px' }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>{blk.label}</div>
                      {blk.items.map((it, i) => <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{it}</div>)}
                    </div>
                  ))}
                </div>

                {candleLog.length === 0
                  ? <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Candle details will appear when replay starts.</div>
                  : (
                    <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                        <thead style={{ position: 'sticky', top: 0, background: 'var(--card-bg)', zIndex: 1 }}>
                          <tr style={{ borderBottom: '1px solid var(--border)' }}>
                            {['Time','O','H','L','C','Vol',
                              ...(regimeConfig.enabled ? ['Regime'] : []),
                              ...(combOnlyView
                                ? ['Strategy Signals', 'Comb Position', 'Comb Unreal P&L',
                                   'Winner', 'Winner Score', 'Confidence',
                                   'All Scored', 'Above Threshold', 'Block Reason',
                                   'VWAP', 'VWAP Dist%', 'Move3%', 'Move5%', 'Entry Phase',
                                   'Entry Type', 'Bars Since Trade', 'Entry Filter',
                                   'Combined Analysis', 'Blocked']
                                : [...stratLabels.map(l => l.length > 10 ? l.slice(0,10)+'…' : l),
                                   'VWAP', 'Dist VWAP%', 'Move%(3c)', 'Actions']
                              )].map(h => (
                              <th key={h} style={{ padding: '5px 6px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {[...candleLog].reverse().map((row, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: row.actions.length > 0 || row.combinedDetails?.length > 0 ? 'rgba(99,102,241,0.06)' : row.blockedSignals?.length > 0 ? 'rgba(245,158,11,0.04)' : undefined }}>
                              <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{row.ts}</td>
                              <td style={{ padding: '4px 6px' }}>{Number(row.open).toFixed(2)}</td>
                              <td style={{ padding: '4px 6px', color: '#22c55e' }}>{Number(row.high).toFixed(2)}</td>
                              <td style={{ padding: '4px 6px', color: '#ef4444' }}>{Number(row.low).toFixed(2)}</td>
                              <td style={{ padding: '4px 6px', fontWeight: 600 }}>{Number(row.close).toFixed(2)}</td>
                              <td style={{ padding: '4px 6px', color: 'var(--text-muted)' }}>{row.volume?.toLocaleString() ?? '—'}</td>
                              {regimeConfig.enabled && (
                                <td style={{ padding: '4px 6px' }}>
                                  {row.regime
                                    ? <span className={`bt-regime-badge bt-regime-${row.regime}`}>{row.regime}</span>
                                    : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                </td>
                              )}
                              {combOnlyView ? (
                                <>
                                  {/* Strategy Signals — every strategy's signal for this candle */}
                                  <td style={{ padding: '4px 6px', minWidth: 160 }}>
                                    {Object.keys(row.signals || {}).length === 0
                                      ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                                      : Object.entries(row.signals).map(([lbl, sig]) => (
                                        <div key={lbl} style={{ lineHeight: 1.7, whiteSpace: 'nowrap' }}>
                                          <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{lbl}: </span>
                                          {sig === 'BUY'  ? <span style={{ color: '#22c55e', fontWeight: 700 }}>BUY</span>
                                          : sig === 'SELL' ? <span style={{ color: '#ef4444', fontWeight: 700 }}>SELL</span>
                                          : sig === 'SHORT'? <span style={{ color: '#8b5cf6', fontWeight: 700 }}>SHORT</span>
                                          : <span style={{ color: 'var(--text-muted)' }}>HOLD</span>}
                                        </div>
                                      ))
                                    }
                                  </td>
                                  {/* Combined Position */}
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', minWidth: 110 }}>
                                    {row.combinedPosition
                                      ? <>
                                          <span style={{ fontWeight: 700, color: row.combinedPosition.type === 'LONG' ? '#22c55e' : '#8b5cf6' }}>{row.combinedPosition.type}</span>
                                          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}> @{Number(row.combinedPosition.entryPrice).toFixed(2)} ×{row.combinedPosition.qty}</span>
                                        </>
                                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    }
                                  </td>
                                  {/* Combined Unrealized P&L */}
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                                    {row.combinedUnrealizedPnl != null
                                      ? <span style={{ fontWeight: 600, color: row.combinedUnrealizedPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                                          {row.combinedUnrealizedPnl >= 0 ? '+' : ''}₹{Number(row.combinedUnrealizedPnl).toFixed(2)}
                                        </span>
                                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    }
                                  </td>
                                  {/* Combined Winner */}
                                  <td style={{ padding: '4px 6px', fontSize: 10, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                                    {row.combinedWinner || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                  </td>
                                  {/* Combined Winner Score */}
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                                    {row.combinedWinnerScore != null
                                      ? <span style={{ fontWeight: 600, color: '#6366f1' }}>{Number(row.combinedWinnerScore).toFixed(1)}</span>
                                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    }
                                  </td>
                                  {/* Score Gap — winner minus second-best */}
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                                    {row.scoreGap != null
                                      ? <span style={{ fontWeight: 600, color: row.scoreGap >= 5 ? '#22c55e' : row.scoreGap >= 2 ? '#f59e0b' : '#ef4444' }}>
                                          +{Number(row.scoreGap).toFixed(1)}
                                        </span>
                                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    }
                                  </td>
                                  {/* All Scored — every strategy with a non-HOLD signal and its raw score */}
                                  <td style={{ padding: '4px 6px', minWidth: 180 }}>
                                    {!row.combinedAllScored?.length
                                      ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                                      : row.combinedAllScored.map((c, ci) => (
                                          <div key={ci} style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{c}</div>
                                        ))
                                    }
                                  </td>
                                  {/* Above Threshold — candidates that passed minScore */}
                                  <td style={{ padding: '4px 6px', minWidth: 140 }}>
                                    {!row.combinedCandidates?.length
                                      ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                                      : row.combinedCandidates.map((c, ci) => (
                                          <div key={ci} style={{ fontSize: 10, color: '#6366f1', lineHeight: 1.6, whiteSpace: 'nowrap' }}>{c}</div>
                                        ))
                                    }
                                  </td>
                                  {/* Combined Block Reason */}
                                  <td style={{ padding: '4px 6px', fontSize: 10, minWidth: 160 }}>
                                    {row.combinedBlockReason
                                      ? <span style={{ color: '#f59e0b' }}>{row.combinedBlockReason}</span>
                                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    }
                                  </td>
                                  {/* VWAP */}
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', fontSize: 10, color: 'var(--text-secondary)' }}>
                                    {row.vwap != null ? Number(row.vwap).toFixed(2) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                  </td>
                                  {/* Distance from VWAP % */}
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                                    {row.distanceFromVwapPct != null
                                      ? <span style={{ fontSize: 10, fontWeight: 600, color: row.distanceFromVwapPct >= 0 ? '#22c55e' : '#ef4444' }}>
                                          {row.distanceFromVwapPct >= 0 ? '+' : ''}{Number(row.distanceFromVwapPct).toFixed(2)}%
                                        </span>
                                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    }
                                  </td>
                                  {/* Recent Move % (3 candles) */}
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                                    {row.recentMovePct != null
                                      ? <span style={{ fontSize: 10, fontWeight: 600, color: row.recentMovePct >= 0 ? '#22c55e' : '#ef4444' }}>
                                          {row.recentMovePct >= 0 ? '+' : ''}{Number(row.recentMovePct).toFixed(2)}%
                                        </span>
                                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    }
                                  </td>
                                  {/* Recent Move % (5 candles) */}
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                                    {row.recentMove5Pct != null
                                      ? <span style={{ fontSize: 10, fontWeight: 600, color: row.recentMove5Pct >= 0 ? '#22c55e' : '#ef4444' }}>
                                          {row.recentMove5Pct >= 0 ? '+' : ''}{Number(row.recentMove5Pct).toFixed(2)}%
                                        </span>
                                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    }
                                  </td>
                                  {/* Entry Phase — EARLY / MID / LATE */}
                                  {(() => {
                                    const d = row.distanceFromVwapPct, m = row.recentMovePct;
                                    if (d == null || m == null) return <td style={{ padding: '4px 6px', color: 'var(--text-muted)' }}>—</td>;
                                    const absD = Math.abs(d), absM = Math.abs(m);
                                    const phase = absD < 0.5 && absM < 0.5 ? 'EARLY' : absD > 1.5 || absM > 1.5 ? 'LATE' : 'MID';
                                    const color = phase === 'EARLY' ? '#22c55e' : phase === 'LATE' ? '#ef4444' : '#f59e0b';
                                    return <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}><span style={{ fontSize: 10, fontWeight: 700, color }}>{phase}</span></td>;
                                  })()}
                                  {/* Entry Type — BREAKOUT / PULLBACK / REVERSAL / CHOP */}
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                                    {row.entryTypeTag
                                      ? (() => {
                                          const c = row.entryTypeTag === 'BREAKOUT' ? '#f59e0b'
                                                  : row.entryTypeTag === 'REVERSAL'  ? '#8b5cf6'
                                                  : row.entryTypeTag === 'PULLBACK'  ? '#22c55e'
                                                  : '#6b7280'; // CHOP
                                          return <span style={{ fontSize: 10, fontWeight: 700, color: c }}>{row.entryTypeTag}</span>;
                                        })()
                                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    }
                                  </td>
                                  {/* Candles Since Last Exit */}
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', textAlign: 'center' }}>
                                    {row.candlesSinceLastTrade != null
                                      ? <span style={{ fontSize: 10, fontWeight: 600, color: row.candlesSinceLastTrade <= 2 ? '#ef4444' : row.candlesSinceLastTrade <= 5 ? '#f59e0b' : 'var(--text-secondary)' }}>
                                          {row.candlesSinceLastTrade}
                                        </span>
                                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    }
                                  </td>
                                  {/* Entry Filter — would this entry be skipped? */}
                                  {(() => {
                                    const tblInstrType = resolveInstrType(inst.instrumentType, inst.symbol, inst.exchange);
                                    const tblIsOption  = tblInstrType === 'OPTION';
                                    const hasEntry = (row.combinedDetails || []).some(d =>
                                      typeof d.action === 'string' && d.action.toLowerCase().includes('enter')
                                    );
                                                    if (!hasEntry || !entryFilterConfig.enabled) return <td style={{ padding: '4px 6px', color: 'var(--text-muted)', textAlign: 'center' }}>—</td>;
                                    const reasons = [];
                                    const tblActive = k => tblIsOption ? entryFilterConfig[k].options.enabled : entryFilterConfig[k].stocks.enabled;

                                    const sgRule = entryFilterConfig.scoreGap;
                                    if (tblActive('scoreGap') && row.scoreGap != null && row.scoreGap < parseFloat(sgRule.minGap || 2))
                                      reasons.push(`Gap ${Number(row.scoreGap).toFixed(1)}<${sgRule.minGap}`);

                                    const cdRule = entryFilterConfig.cooldown;
                                    if (tblActive('cooldown') && row.candlesSinceLastTrade != null && row.candlesSinceLastTrade < parseInt(cdRule.minBars || 3))
                                      reasons.push(`CD ${row.candlesSinceLastTrade}<${cdRule.minBars}`);

                                    const veRule = entryFilterConfig.vwapExtension;
                                    if (tblActive('vwapExtension') && row.distanceFromVwapPct != null && Math.abs(row.distanceFromVwapPct) > parseFloat(veRule.maxDistPct || 1.5))
                                      reasons.push(`VWAPExt ${Number(row.distanceFromVwapPct).toFixed(2)}%>${veRule.maxDistPct}%`);

                                    const sfRule = entryFilterConfig.strategyFilter;
                                    if (tblActive('strategyFilter') && row.combinedWinner) {
                                      const blockedList = (sfRule.blocked || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
                                      if (blockedList.includes((row.combinedWinner || '').toUpperCase()))
                                        reasons.push(`${row.combinedWinner} blocked`);
                                    }

                                    const cgRule = entryFilterConfig.confidenceGate;
                                    if (tblActive('confidenceGate')) {
                                      const exception = (cgRule.exceptionStrategy || '').trim().toUpperCase();
                                      const winner    = (row.combinedWinner || '').toUpperCase();
                                      if (row.scoreGap != null && row.scoreGap < parseFloat(cgRule.minGap || 3) && winner !== exception)
                                        reasons.push(`Conf ${Number(row.scoreGap).toFixed(1)}<${cgRule.minGap}`);
                                    }
                                    const skip = reasons.length > 0;
                                    return (
                                      <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', textAlign: 'center' }}>
                                        <span style={{ fontSize: 10, fontWeight: 700, color: skip ? '#ef4444' : '#22c55e' }}>
                                          {skip ? `SKIP` : 'ALLOW'}
                                        </span>
                                        {skip && <div style={{ fontSize: 9, color: '#ef4444' }}>{reasons.join('; ')}</div>}
                                      </td>
                                    );
                                  })()}
                                  {/* Combined Analysis — full per-action detail */}
                                  <td style={{ padding: '4px 6px', minWidth: 260 }}>
                                    {!row.combinedDetails?.length
                                      ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                                      : row.combinedDetails.map((cd, ci) => {
                                          const isEnter = cd.action === 'BUY' || cd.action === 'SHORT';
                                          const color   = cd.action === 'SHORT' ? '#8b5cf6' : isEnter ? '#22c55e' : '#ef4444';
                                          return (
                                            <div key={ci} style={{ lineHeight: 1.7, borderTop: ci > 0 ? '1px dashed var(--border)' : undefined, paddingTop: ci > 0 ? 3 : 0, marginTop: ci > 0 ? 3 : 0 }}>
                                              <span style={{ fontWeight: 700, color: '#8b5cf6', fontSize: 10 }}>⚡ </span>
                                              <span style={{ fontWeight: 700, color }}>{cd.action}</span>
                                              <span style={{ color: 'var(--text-muted)', fontSize: 10 }}> @{Number(cd.price).toFixed(2)}</span>
                                              {cd.sourceStrategy && <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>via <span style={{ color: 'var(--text-secondary)' }}>{cd.sourceStrategy}</span></div>}
                                              {cd.regime && <div style={{ fontSize: 10 }}><span className={`bt-regime-badge bt-regime-${cd.regime}`} style={{ fontSize: 9 }}>{cd.regime}</span></div>}
                                              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{cd.reason}</div>
                                              {cd.score && (
                                                <div style={{ fontSize: 10, color: '#6366f1', fontFamily: 'monospace' }}>
                                                  score <span style={{ fontWeight: 700 }}>{cd.score.total.toFixed(1)}</span>
                                                  {' '}(T:{cd.score.trendStrength.toFixed(0)} V:{cd.score.volatility.toFixed(0)} M:{cd.score.momentum.toFixed(0)} C:{cd.score.confidence.toFixed(0)})
                                                </div>
                                              )}
                                              {cd.trigger && <div style={{ fontSize: 10, color: cd.trigger.startsWith('Score') ? '#6366f1' : cd.trigger === 'Risk Management' ? '#f59e0b' : 'var(--text-muted)' }}>{cd.trigger}</div>}
                                            </div>
                                          );
                                        })
                                    }
                                  </td>
                                  {/* Blocked */}
                                  <td style={{ padding: '4px 6px', minWidth: 160 }}>
                                    {!row.blockedSignals?.length
                                      ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                                      : row.blockedSignals.map((b, bi) => (
                                        <div key={bi} style={{ fontSize: 11, lineHeight: 1.6, color: '#f59e0b' }}>
                                          <span style={{ fontWeight: 700 }}>⊘ {b.strategy} {b.signal}</span>
                                          <span style={{ color: '#a16207', fontSize: 10 }}> — {b.reason}</span>
                                        </div>
                                      ))
                                    }
                                  </td>
                                </>
                              ) : (
                                <>
                                  {stratLabels.map(l => {
                                    const sig = row.signals?.[l];
                                    return (
                                      <td key={l} style={{ padding: '4px 6px' }}>
                                        {sig === 'BUY'  ? <span style={{ color: '#22c55e', fontWeight: 700 }}>BUY</span>
                                        : sig === 'SELL' ? <span style={{ color: '#ef4444', fontWeight: 700 }}>SELL</span>
                                        : sig === 'SHORT'? <span style={{ color: '#8b5cf6', fontWeight: 700 }}>SHORT</span>
                                        : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                      </td>
                                    );
                                  })}
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', fontSize: 10, color: 'var(--text-secondary)' }}>
                                    {row.vwap != null ? Number(row.vwap).toFixed(2) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                  </td>
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                                    {row.distanceFromVwapPct != null
                                      ? <span style={{ fontSize: 10, fontWeight: 600, color: row.distanceFromVwapPct >= 0 ? '#22c55e' : '#ef4444' }}>
                                          {row.distanceFromVwapPct >= 0 ? '+' : ''}{Number(row.distanceFromVwapPct).toFixed(2)}%
                                        </span>
                                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    }
                                  </td>
                                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                                    {row.recentMovePct != null
                                      ? <span style={{ fontSize: 10, fontWeight: 600, color: row.recentMovePct >= 0 ? '#22c55e' : '#ef4444' }}>
                                          {row.recentMovePct >= 0 ? '+' : ''}{Number(row.recentMovePct).toFixed(2)}%
                                        </span>
                                      : <span style={{ color: 'var(--text-muted)' }}>—</span>
                                    }
                                  </td>
                                  <td style={{ padding: '4px 6px', minWidth: 220 }}>
                                    {row.actions.length === 0 && !row.blockedSignals?.length && !row.combinedDetails?.length
                                      ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                                      : <>
                                        {row.actions.map((a, ai) => {
                                          const label   = fmtAction(a);
                                          const isEnter = !a.reason;
                                          const color   = a.signal === 'SHORT' ? '#8b5cf6' : isEnter ? '#22c55e' : '#ef4444';
                                          return (
                                            <div key={ai} style={{ fontSize: 11, lineHeight: 1.6 }}>
                                              <span style={{ fontWeight: 700, color }}>{label.split(' —')[0]}</span>
                                              <span style={{ color: 'var(--text-muted)' }}>{' —' + label.split(' —').slice(1).join(' —')}</span>
                                            </div>
                                          );
                                        })}
                                        {(row.blockedSignals || []).map((b, bi) => (
                                          <div key={`b${bi}`} style={{ fontSize: 11, lineHeight: 1.6, color: '#f59e0b' }}>
                                            <span style={{ fontWeight: 700 }}>⊘ {b.strategy} {b.signal}</span>
                                            <span style={{ color: '#a16207' }}> — {b.reason}</span>
                                          </div>
                                        ))}
                                        {(row.combinedDetails || []).map((cd, ci) => {
                                          const isEnter = cd.action.startsWith('Enter');
                                          const color   = cd.action.includes('Short') ? '#8b5cf6' : isEnter ? '#22c55e' : '#ef4444';
                                          return (
                                            <div key={'c'+ci} style={{ fontSize: 11, lineHeight: 1.6, borderTop: ci === 0 && (row.actions.length > 0 || row.blockedSignals?.length > 0) ? '1px dashed var(--border)' : undefined, marginTop: ci === 0 && (row.actions.length > 0 || row.blockedSignals?.length > 0) ? 3 : 0, paddingTop: ci === 0 && (row.actions.length > 0 || row.blockedSignals?.length > 0) ? 3 : 0 }}>
                                              <span style={{ fontWeight: 700, color: '#8b5cf6', fontSize: 10 }}>⚡</span>
                                              {' '}<span style={{ fontWeight: 700, color }}>{cd.action}</span>
                                              {' '}<span style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                                                @{Number(cd.price).toFixed(2)}
                                                {cd.sourceStrategy ? ` · via ${cd.sourceStrategy}` : ''}
                                                {cd.regime ? ` · ${cd.regime}` : ''}
                                                {' · '}{cd.reason}
                                                {cd.score ? ` · score=${cd.score.total.toFixed(1)} (trend=${cd.score.trendStrength.toFixed(0)} vol=${cd.score.volatility.toFixed(0)} mom=${cd.score.momentum.toFixed(0)} conf=${cd.score.confidence.toFixed(0)})` : ''}
                                                {' · '}<span style={{ color: cd.trigger?.startsWith('Score') ? '#6366f1' : cd.trigger === 'Risk Management' ? '#f59e0b' : 'var(--text-muted)' }}>{cd.trigger}</span>
                                              </span>
                                            </div>
                                          );
                                        })}
                                      </>
                                    }
                                  </td>
                                </>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                }
              </div>
            );
          })()}

        </div>
      </div>

      {/* ── Bottom: Strategies full-width ──────────────────────────────── */}
      <div className="card bt-live-strategies-row" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h3 className="section-title" style={{ margin: 0 }}>Strategies</h3>
            <button type="button" disabled={isRunning}
              onClick={toggleMasterShorting}
              style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, border: '1px solid', cursor: 'pointer',
                background: strategies.every(s => s.allowShorting) ? 'rgba(139,92,246,0.15)' : 'transparent',
                color:      strategies.every(s => s.allowShorting) ? '#8b5cf6' : 'var(--text-muted)',
                borderColor:strategies.every(s => s.allowShorting) ? 'rgba(139,92,246,0.4)' : 'var(--border)' }}>
              {strategies.every(s => s.allowShorting) ? 'Short ON' : 'Short OFF'}
            </button>
            <button type="button" disabled={isRunning}
              onClick={() => setCombinedOnlyMode(m => !m)}
              title="When ON: individual strategies only compute signals for the ⚡ Combined pool — they don't trade independently"
              style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, border: '1px solid', cursor: 'pointer',
                background:   combinedOnlyMode ? 'rgba(234,179,8,0.15)'  : 'transparent',
                color:        combinedOnlyMode ? '#ca8a04'               : 'var(--text-muted)',
                borderColor:  combinedOnlyMode ? 'rgba(234,179,8,0.4)'   : 'var(--border)' }}>
              {combinedOnlyMode ? '⚡ Combined Only' : 'All Strategies'}
            </button>
          </div>
          {!isRunning && <button type="button" className="btn-secondary btn-sm" onClick={addStrategy}>+ Add</button>}
        </div>
        <div className="bt-live-strategies-grid">
          {strategies.map((s, idx) => {
            const pdefs = PARAM_DEFS[s.strategyType] || [];
            return (
              <div key={idx} className={`bt-strategy-card ${s.enabled ? '' : 'bt-strategy-disabled'}`}>
                <div className="bt-strategy-header">
                  <label className="checkbox-label" style={{ margin: 0, fontWeight: 600 }}>
                    <input type="checkbox" checked={s.enabled} disabled={isRunning}
                      onChange={e => updateStrategy(idx, 'enabled', e.target.checked)} />
                    <select value={s.strategyType} disabled={isRunning} onChange={e => updateStrategy(idx, 'strategyType', e.target.value)}
                      className="bt-strategy-type-sel">
                      {knownTypes.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </label>
                  {strategies.length > 1 && !isRunning &&
                    <button type="button" className="btn-danger btn-xs" onClick={() => removeStrategy(idx)}>✕</button>}
                </div>
                {pdefs.length > 0 && s.enabled && (
                  <div className="bt-params-block" style={{ marginTop: 6 }}>
                    {pdefs.map(def => (
                      <div className="bt-param-row" key={def.key}>
                        <label className="bt-param-label">{def.label}</label>
                        <input type="number" min="1" className="bt-param-input"
                          value={s.parameters?.[def.key] || ''} disabled={isRunning}
                          onChange={e => updateStrategyParam(idx, def.key, e.target.value)}
                          placeholder={def.placeholder} />
                        <span className="bt-param-hint">{def.hint}</span>
                      </div>
                    ))}
                  </div>
                )}
                {s.enabled && (
                  <div style={{ marginTop: 6 }}>
                    <label className="checkbox-label" style={{ fontSize: 12, gap: 6 }}>
                      <input type="checkbox" checked={!!s.allowShorting} disabled={isRunning}
                        onChange={e => updateStrategy(idx, 'allowShorting', e.target.checked)} />
                      Allow Shorting
                    </label>
                  </div>
                )}
                {regimeConfig.enabled && s.enabled && (
                  <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="bt-params-label" style={{ marginRight: 4 }}>Regimes</span>
                    <span className="bt-regime-auto-tag">auto</span>
                    {(STRATEGY_REGIME_MAP[s.strategyType] || []).map(r => (
                      <span key={r} className={`bt-regime-badge bt-regime-${r}`}>{r}</span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}

// ─── Tab 3: Live Test ─────────────────────────────────────────────────────────

function LiveTest() {
  const { session, isActive } = useSession();

  // ── Config ────────────────────────────────────────────────────────────────
  const [knownTypes, setKnownTypes]         = useState(['SMA_CROSSOVER']);
  const [strategies, setStrategies]         = useState(defaultStrategies);
  const [riskConfig, setRiskConfig]         = useState({ ...EMPTY_RISK });
  const [patternConfig, setPatternConfig]   = useState({ ...EMPTY_PATTERN });
  const [regimeConfig, setRegimeConfig]     = useState({ ...EMPTY_REGIME_CONFIG });
  const [scoreConfig, setScoreConfig]       = useState({ ...EMPTY_SCORE_CONFIG });
  const [rulesConfig, setRulesConfig]       = useState(JSON.parse(JSON.stringify(EMPTY_RULES_CONFIG)));
  const [initialCapital, setInitialCapital] = useState('100000');
  const [quantity, setQuantity]             = useState('0');
  const [mode, setMode]                     = useState('QUOTE');
  const [preload, setPreload]             = useState({ enabled: true, daysBack: 5, interval: 'MINUTE_5' });
  const [preloadStateByToken, setPreloadStateByToken] = useState({});

  // ── Multi-instrument ──────────────────────────────────────────────────────
  const EMPTY_INSTR = () => ({ id: Date.now(), ...EMPTY_INST, candleInterval: 'MINUTE_5', instrumentType: 'STOCK' });
  const [instruments, setInstruments]           = useState([EMPTY_INSTR()]);
  const [selectedInstrToken, setSelectedInstrToken] = useState(null);

  // ── Snapshot / resume ─────────────────────────────────────────────────────
  const [savedSnapshot, setSavedSnapshot]     = useState(null);   // LiveSessionSnapshot from backend
  const [resumeFromSnapshot, setResumeFromSnapshot] = useState(false);

  // ── Connection ────────────────────────────────────────────────────────────
  const [kiteConnected, setKiteConnected] = useState(false);
  const [connected, setConnected]   = useState(false);
  const [status, setStatus]         = useState('idle');
  const [error, setError]           = useState('');
  const [liveSessionId, setLiveSessionId] = useState(null);

  // ── Live data — per instrument (keyed by token string) ───────────────────
  const [ticksByToken, setTicksByToken]             = useState({});
  const [signals, setSignals]                       = useState([]);
  const [liveCandlesByToken, setLiveCandlesByToken] = useState({});
  const [currentCandleByToken, setCurrentCandleByToken] = useState({});
  const [currentRegimeByToken, setCurrentRegimeByToken] = useState({});
  const [candleLogByToken, setCandleLogByToken]     = useState({});

  // ── Paper trading — keyed by `${token}::${stratLabel}` ───────────────────
  const [stratStates, setStratStates] = useState({});

  // ── UI ────────────────────────────────────────────────────────────────────
  const [combinedOnlyMode, setCombinedOnlyMode] = useState(false);
  const [rightTab, setRightTab] = useState('feed');
  const [expandedInstrs, setExpandedInstrs] = useState({});  // id → bool

  // ── Refs ─────────────────────────────────────────────────────────────────
  // evaluatorsRef: `${token}::${stratLabel}` → evaluator
  const evaluatorsRef      = useRef({});
  // patternEvalsRef: token → LocalCandlePatternEvaluator
  const patternEvalsRef    = useRef({});
  // regimeDetectorsRef: token → LocalRegimeDetector
  const regimeDetectorsRef = useRef({});
  const sseRef             = useRef(null);
  const liveAbortCtrlRef   = useRef(null);
  const signalsRef         = useRef([]);
  // Trading maps: `${token}::${stratLabel}` → value
  const capitalMap         = useRef({});
  const openPositionMap    = useRef({});
  const closedTradesMap    = useRef({});
  const equityMap          = useRef({});
  const cooldownRef        = useRef({});
  const dailyCapMap        = useRef({});
  // Per-instrument refs: token → value
  const currentCandlesRef  = useRef({});
  const liveCandles_Ref    = useRef({});
  const candleLogsRef      = useRef({});
  const ticksRef           = useRef({});   // token → []
  // Keep latest refs in sync so SSE closure can read current values
  const instrumentsRef     = useRef([]);
  const riskConfigRef      = useRef(riskConfig);
  const scorersRef             = useRef({}); // token → LocalStrategyScorer
  const reversalCooldownRef    = useRef({}); // key → remaining candles since last reversal

  useEffect(() => {
    getStrategyTypes().then(r => { if (r?.data) setKnownTypes([...r.data].sort()); }).catch(() => {});
    return () => cleanup();
  }, []);

  // Check for a saved snapshot whenever the session becomes active
  useEffect(() => {
    if (!isActive || !session?.userId || !session?.brokerName) return;
    getLiveSnapshot(session.userId, session.brokerName)
      .then(res => setSavedSnapshot(res?.data ?? null))
      .catch(() => setSavedSnapshot(null));
  }, [isActive, session?.userId, session?.brokerName]);

  // Keep refs in sync so SSE closure always reads current values
  useEffect(() => { instrumentsRef.current = instruments; }, [instruments]);
  useEffect(() => { riskConfigRef.current  = riskConfig;  }, [riskConfig]);

  function cleanup() {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    if (liveAbortCtrlRef.current) { liveAbortCtrlRef.current.abort(); liveAbortCtrlRef.current = null; }
  }

  // ── Instrument helpers ────────────────────────────────────────────────────
  function addInstrument() {
    setInstruments(p => [...p, { id: Date.now(), ...EMPTY_INST, candleInterval: 'MINUTE_5', instrumentType: 'STOCK' }]);
  }
  function removeInstrument(id) {
    setInstruments(p => p.filter(i => i.id !== id));
  }
  function updateInstrument(id, patch) {
    setInstruments(p => p.map(i => i.id === id ? { ...i, ...patch } : i));
  }

  // ── Strategy config helpers ───────────────────────────────────────────────
  function addStrategy() {
    const masterShort = strategies.every(s => s.allowShorting);
    setStrategies(p => [...p, { strategyType: 'SMA_CROSSOVER', enabled: true, label: '', allowShorting: masterShort, parameters: defaultParams('SMA_CROSSOVER') }]);
  }
  function removeStrategy(idx) { setStrategies(p => p.filter((_, i) => i !== idx)); }
  function updateStrategy(idx, field, value) {
    setStrategies(p => p.map((s, i) => {
      if (i !== idx) return s;
      if (field === 'strategyType') return { ...s, strategyType: value, parameters: defaultParams(value) };
      return { ...s, [field]: value };
    }));
  }
  function updateStrategyParam(idx, key, value) {
    setStrategies(p => p.map((s, i) => i !== idx ? s : { ...s, parameters: { ...s.parameters, [key]: value } }));
  }
  function toggleMasterShorting() {
    const next = !strategies.every(s => s.allowShorting);
    setStrategies(p => p.map(s => ({ ...s, allowShorting: next })));
  }
  function updateRisk(f, v)    { setRiskConfig(p => ({ ...p, [f]: v })); }
  function updatePattern(f, v) { setPatternConfig(p => ({ ...p, [f]: v })); }
  function togglePatternList(f, v) {
    setPatternConfig(p => ({ ...p, [f]: p[f].includes(v) ? p[f].filter(x => x !== v) : [...p[f], v] }));
  }
  function updateRegime(f, v)  { setRegimeConfig(p => ({ ...p, [f]: v })); }
  function updateRule(section, ruleKey, field, value) {
    setRulesConfig(p => ({ ...p, [section]: { ...p[section], [ruleKey]: { ...p[section][ruleKey], [field]: value } } }));
  }

  // ── Per-strategy state flush — key = `${token}::${stratLabel}` ───────────
  function flushStrat(key) {
    setStratStates(prev => ({
      ...prev,
      [key]: {
        capital:      capitalMap.current[key],
        openPosition: openPositionMap.current[key] || null,
        closedTrades: [...(closedTradesMap.current[key] || [])],
        equityHistory:[...(equityMap.current[key]       || [])],
      },
    }));
  }

  // ── Paper trading — key = `${token}::${stratLabel}`, symbol for signal log ─
  function computeQty(key, entryPrice) {
    const cap = capitalMap.current[key] || 0;
    const rc  = riskConfigRef.current;
    const baseQty = parseInt(quantity, 10);
    if (baseQty > 0) return baseQty;
    if (rc.enabled && parseFloat(rc.maxRiskPerTradePct) > 0 && parseFloat(rc.stopLossPct) > 0) {
      const riskAmt = cap * parseFloat(rc.maxRiskPerTradePct) / 100;
      const riskPS  = entryPrice * parseFloat(rc.stopLossPct) / 100;
      return Math.max(1, Math.floor(riskAmt / riskPS));
    }
    return Math.max(1, Math.floor(cap / entryPrice));
  }

  function openLong(key, price, regime, symbol) {
    const rc = riskConfigRef.current;
    if (openPositionMap.current[key]) return;
    const qty = computeQty(key, price);
    if (price * qty > (capitalMap.current[key] || 0)) return;
    const sl = rc.enabled && parseFloat(rc.stopLossPct)   > 0 ? price * (1 - parseFloat(rc.stopLossPct)/100)   : null;
    const tp = rc.enabled && parseFloat(rc.takeProfitPct) > 0 ? price * (1 + parseFloat(rc.takeProfitPct)/100) : null;
    const stratLabel = key.split('::')[1];
    const pos = { strategyLabel: stratLabel, type: 'LONG', entryPrice: price, qty, entryTime: new Date().toLocaleTimeString(), slPrice: sl, tpPrice: tp, regime };
    openPositionMap.current[key] = pos;
    flushStrat(key);
    signalsRef.current = [{ signal: 'BUY', price, symbol, ts: pos.entryTime, strategyLabel: stratLabel }, ...signalsRef.current].slice(0, 200);
    setSignals([...signalsRef.current]);
  }

  function closeLong(key, exitPrice, exitReason, symbol) {
    const rc  = riskConfigRef.current;
    const pos = openPositionMap.current[key];
    if (!pos || pos.type !== 'LONG') return;
    const pnl    = (exitPrice - pos.entryPrice) * pos.qty;
    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const newCap = (capitalMap.current[key] || 0) + pnl;
    capitalMap.current[key] = newCap;
    const exitTime = new Date().toLocaleTimeString();
    const trade = { ...pos, exitPrice, exitTime, pnl, pnlPct, exitReason, capitalAfter: newCap };
    closedTradesMap.current[key] = [trade, ...(closedTradesMap.current[key] || [])];
    equityMap.current[key]       = [...(equityMap.current[key] || []), { time: exitTime, capital: newCap }];
    openPositionMap.current[key] = null;
    flushStrat(key);
    if (pnl < 0 && rc.enabled && parseInt(rc.cooldownCandles, 10) > 0) cooldownRef.current[key] = parseInt(rc.cooldownCandles, 10);
    const stratLabel = key.split('::')[1];
    signalsRef.current = [{ signal: 'SELL', price: exitPrice, symbol, ts: exitTime, strategyLabel: stratLabel, reason: exitReason }, ...signalsRef.current].slice(0, 200);
    setSignals([...signalsRef.current]);
  }

  function openShort(key, price, regime, symbol) {
    const rc = riskConfigRef.current;
    if (openPositionMap.current[key]) return;
    const qty = computeQty(key, price);
    const sl = rc.enabled && parseFloat(rc.stopLossPct)   > 0 ? price * (1 + parseFloat(rc.stopLossPct)/100)   : null;
    const tp = rc.enabled && parseFloat(rc.takeProfitPct) > 0 ? price * (1 - parseFloat(rc.takeProfitPct)/100) : null;
    const stratLabel = key.split('::')[1];
    const pos = { strategyLabel: stratLabel, type: 'SHORT', entryPrice: price, qty, entryTime: new Date().toLocaleTimeString(), slPrice: sl, tpPrice: tp, regime };
    openPositionMap.current[key] = pos;
    flushStrat(key);
    signalsRef.current = [{ signal: 'SHORT', price, symbol, ts: pos.entryTime, strategyLabel: stratLabel }, ...signalsRef.current].slice(0, 200);
    setSignals([...signalsRef.current]);
  }

  function closeShort(key, exitPrice, exitReason, symbol) {
    const rc  = riskConfigRef.current;
    const pos = openPositionMap.current[key];
    if (!pos || pos.type !== 'SHORT') return;
    const pnl    = (pos.entryPrice - exitPrice) * pos.qty;
    const pnlPct = ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
    const newCap = (capitalMap.current[key] || 0) + pnl;
    capitalMap.current[key] = newCap;
    const exitTime = new Date().toLocaleTimeString();
    const trade = { ...pos, exitPrice, exitTime, pnl, pnlPct, exitReason, capitalAfter: newCap };
    closedTradesMap.current[key] = [trade, ...(closedTradesMap.current[key] || [])];
    equityMap.current[key]       = [...(equityMap.current[key] || []), { time: exitTime, capital: newCap }];
    openPositionMap.current[key] = null;
    flushStrat(key);
    if (pnl < 0 && rc.enabled && parseInt(rc.cooldownCandles, 10) > 0) cooldownRef.current[key] = parseInt(rc.cooldownCandles, 10);
    const stratLabel = key.split('::')[1];
    signalsRef.current = [{ signal: 'BUY', price: exitPrice, symbol, ts: exitTime, strategyLabel: stratLabel, reason: exitReason }, ...signalsRef.current].slice(0, 200);
    setSignals([...signalsRef.current]);
  }

  function closePaperPosition(key, exitPrice, exitReason, symbol) {
    const pos = openPositionMap.current[key];
    if (!pos) return;
    if (pos.type === 'SHORT') closeShort(key, exitPrice, exitReason, symbol);
    else closeLong(key, exitPrice, exitReason, symbol);
  }

  // NOTE: onCandleClose was removed — strategy evaluation is now handled by the Strategy Engine
  // backend (LiveEvalService). The backend subscribes to Data Engine ticks, builds candles,
  // runs the full evaluation pipeline, and streams ReplayCandleEvent objects via SSE.
  //
  // The following function is kept only to prevent reference errors in closePaperPosition
  // calls from manual close buttons that still exist in JSX. Those calls are now no-ops for
  // live mode since openPositionMap is no longer populated.
  function _removedOnCandleClose(candle, token, instrConfig) {
    const sym        = instrConfig?.symbol || '';
    const instrType  = resolveInstrType(instrConfig?.instrumentType, instrConfig?.symbol, instrConfig?.exchange);
    const activeRules = rulesConfig.enabled
      ? (instrType === 'OPTION' ? rulesConfig.options : rulesConfig.stocks)
      : {};

    liveCandles_Ref.current[token] = [...(liveCandles_Ref.current[token] || []), candle].slice(-500);
    setLiveCandlesByToken(prev => ({ ...prev, [token]: [...(liveCandles_Ref.current[token])] }));

    // Tick down cooldowns + reversal cooldowns for this instrument
    Object.keys(cooldownRef.current).forEach(k => {
      if (k.startsWith(token + '::') && cooldownRef.current[k] > 0) cooldownRef.current[k]--;
    });
    Object.keys(reversalCooldownRef.current).forEach(k => {
      if (k.startsWith(token + '::') && reversalCooldownRef.current[k] > 0) reversalCooldownRef.current[k]--;
    });

    // Regime detection (per instrument)
    let regime = null;
    if (regimeConfig.enabled && regimeDetectorsRef.current[token]) {
      regime = regimeDetectorsRef.current[token].addCandle(candle.high, candle.low, candle.close);
      setCurrentRegimeByToken(prev => ({ ...prev, [token]: regime }));
    }

    // VWAP for LONG quality gate (STOCK rule 3)
    const vwap = (() => {
      const cls = liveCandles_Ref.current[token] || [];
      if (!cls.length) return null;
      let sumTV = 0, sumV = 0;
      for (const c of cls.slice(-100)) { const tp = (c.high+c.low+c.close)/3; const v = c.volume||1; sumTV+=tp*v; sumV+=v; }
      return sumV > 0 ? sumTV/sumV : null;
    })();

    const today = new Date().toDateString();
    const candleTime = new Date().toLocaleTimeString();
    const latestSignals = {};
    const logActions    = [];
    const blockedSignals = [];   // signals generated but blocked by a rule
    // Track what was closed this candle per key (for no-same-candle-reversal)
    const candleClosedDir = {};

    for (const strat of strategies.filter(s => s.enabled)) {
      const stratLabel = strat.label || strat.strategyType;
      const key = `${token}::${stratLabel}`;
      const ev  = evaluatorsRef.current[key];
      if (!ev) continue;
      if ((cooldownRef.current[key] || 0) > 0) continue;

      if (riskConfig.enabled && riskConfig.dailyLossCapPct) {
        const dc = dailyCapMap.current[key];
        if (dc) {
          if (dc.date !== today) {
            dailyCapMap.current[key] = { date: today, startCapital: capitalMap.current[key], halted: false };
          } else {
            const dayLoss = (capitalMap.current[key] - dc.startCapital) / dc.startCapital * 100;
            if (dayLoss <= -parseFloat(riskConfig.dailyLossCapPct)) dailyCapMap.current[key].halted = true;
            if (dailyCapMap.current[key].halted) continue;
          }
        }
      }

      // Rule: OPTION — disable specific strategy types
      if (instrType === 'OPTION' && rulesConfig.enabled) {
        if (activeRules.disable_sma_breakout?.enabled && ['SMA_CROSSOVER','BREAKOUT'].includes(strat.strategyType)) continue;
        if (activeRules.use_only_specific?.enabled && !['VWAP_PULLBACK','LIQUIDITY_SWEEP','BOLLINGER_REVERSION'].includes(strat.strategyType)) continue;
      }

      if (regimeConfig.enabled && regime) {
        const allowed = STRATEGY_REGIME_MAP[strat.strategyType] || [];
        if (allowed.length > 0 && !allowed.includes(regime)) continue;
      }

      const signal = ev.next(candle.close);
      latestSignals[stratLabel] = signal;
      if (!signal || signal === 'HOLD') continue;

      // Regime-based rules — signal generated but blocked
      if (rulesConfig.enabled) {
        if (instrType === 'STOCK') {
          if (activeRules.ranging_no_trade?.enabled && regime === 'RANGING') {
            blockedSignals.push({ strategy: stratLabel, signal, price: candle.close, reason: 'Rule: No trade in RANGING regime' }); continue;
          }
          if (activeRules.compression_short_only?.enabled && regime === 'COMPRESSION' && signal === 'BUY') {
            blockedSignals.push({ strategy: stratLabel, signal, price: candle.close, reason: 'Rule: SHORT only in COMPRESSION (BUY blocked)' }); continue;
          }
        } else {
          if (activeRules.volatile_no_trade?.enabled && regime === 'VOLATILE') {
            blockedSignals.push({ strategy: stratLabel, signal, price: candle.close, reason: 'Rule: No trade in VOLATILE regime' }); continue;
          }
        }
      }

      if (patternConfig.enabled && patternEvalsRef.current[token]) {
        const patSig = patternEvalsRef.current[token].next(candle.close, candle.high, candle.low, candle.volume||0, candle.open);
        if (signal === 'BUY'  && patternConfig.buyConfirmPatterns.length  > 0 && !patternConfig.buyConfirmPatterns.includes(patSig)) {
          blockedSignals.push({ strategy: stratLabel, signal, price: candle.close, reason: `Pattern: no BUY confirm (got ${patSig||'none'})` }); continue;
        }
        if (signal === 'SELL' && patternConfig.sellConfirmPatterns.length > 0 && !patternConfig.sellConfirmPatterns.includes(patSig)) {
          blockedSignals.push({ strategy: stratLabel, signal, price: candle.close, reason: `Pattern: no SELL confirm (got ${patSig||'none'})` }); continue;
        }
      }

      const pos        = openPositionMap.current[key];
      const hasLong    = pos?.type === 'LONG';
      const hasShort   = pos?.type === 'SHORT';
      const allowShort = !!strat.allowShorting;
      const noSameCandleRev = rulesConfig.enabled && activeRules.no_same_candle_reversal?.enabled;

      // Helper: check LONG quality gate (STOCK rule 3) — returns block reason or null
      const longGateBlock = () => {
        if (instrType !== 'STOCK' || !rulesConfig.enabled || !activeRules.long_quality_gate?.enabled) return null;
        const sc = scorersRef.current[token]?.score(strat.strategyType, 'BUY', regime, instrType) || { total: 0 };
        const minScore = parseFloat(activeRules.long_quality_gate.scoreMin) || 60;
        if (sc.total < minScore) return `Rule: LONG gate — score ${sc.total.toFixed(1)} < ${minScore}`;
        if ((reversalCooldownRef.current[key] || 0) > 0) return 'Rule: LONG gate — reversal cooldown active';
        if (vwap) {
          const extPct = Math.abs(candle.close - vwap) / vwap * 100;
          const maxExt = parseFloat(activeRules.long_quality_gate.vwapMaxPct) || 1.5;
          if (extPct > maxExt) return `Rule: LONG gate — price ${extPct.toFixed(2)}% from VWAP (max ${maxExt}%)`;
        }
        return null;
      };

      if (signal === 'BUY') {
        if (hasLong) {
          blockedSignals.push({ strategy: stratLabel, signal, price: candle.close, reason: 'Already in LONG position' });
        } else if (hasShort) {
          if (noSameCandleRev && candleClosedDir[key] === 'SHORT') {
            blockedSignals.push({ strategy: stratLabel, signal, price: candle.close, reason: 'Rule: No same-candle reversal (SHORT already closed)' }); continue;
          }
          closeShort(key, candle.close, 'SIGNAL', sym);
          candleClosedDir[key] = 'SHORT';
          logActions.push({ strategy: stratLabel, signal: 'BUY', price: candle.close, reason: 'SIGNAL' });
          if (allowShort) {
            const gateBlock = longGateBlock();
            if (!gateBlock) {
              openLong(key, candle.close, regime, sym);
              reversalCooldownRef.current[key] = 2;
              logActions.push({ strategy: stratLabel, signal: 'BUY', price: candle.close, reason: '' });
            } else {
              blockedSignals.push({ strategy: stratLabel, signal, price: candle.close, reason: gateBlock });
            }
          }
        } else {
          const gateBlock = longGateBlock();
          if (!gateBlock) {
            openLong(key, candle.close, regime, sym);
            logActions.push({ strategy: stratLabel, signal: 'BUY', price: candle.close, reason: '' });
          } else {
            blockedSignals.push({ strategy: stratLabel, signal, price: candle.close, reason: gateBlock });
          }
        }
      } else if (signal === 'SELL') {
        if (hasShort) {
          blockedSignals.push({ strategy: stratLabel, signal, price: candle.close, reason: 'Already in SHORT position' });
        } else if (hasLong) {
          if (noSameCandleRev && candleClosedDir[key] === 'LONG') {
            blockedSignals.push({ strategy: stratLabel, signal, price: candle.close, reason: 'Rule: No same-candle reversal (LONG already closed)' }); continue;
          }
          closeLong(key, candle.close, 'SIGNAL', sym);
          candleClosedDir[key] = 'LONG';
          logActions.push({ strategy: stratLabel, signal: 'SELL', price: candle.close, reason: 'SIGNAL' });
          if (allowShort) {
            openShort(key, candle.close, regime, sym);
            reversalCooldownRef.current[key] = 2;
            logActions.push({ strategy: stratLabel, signal: 'SHORT', price: candle.close, reason: '' });
          }
        } else if (allowShort) {
          openShort(key, candle.close, regime, sym);
          logActions.push({ strategy: stratLabel, signal: 'SHORT', price: candle.close, reason: '' });
        } else {
          blockedSignals.push({ strategy: stratLabel, signal, price: candle.close, reason: 'Shorting disabled — no open LONG to exit' });
        }
      }
    }

    // Feed scorer
    scorersRef.current[token]?.addCandle(candle.high, candle.low, candle.close);

    // ── Combined pool (score-based regime-switched) ───────────────────────
    const combinedKey     = `${token}::${COMBINED_LABEL}`;
    const combinedDetails = [];
    if (capitalMap.current[combinedKey] !== undefined) {
      // Rule: global regime blocks
      const combinedBlocked = rulesConfig.enabled && (
        (instrType === 'STOCK'  && activeRules.ranging_no_trade?.enabled  && regime === 'RANGING') ||
        (instrType === 'OPTION' && activeRules.volatile_no_trade?.enabled && regime === 'VOLATILE')
      );

      if (!combinedBlocked) {
        let bestStrat = null, bestSignal = null, bestScore = null;
        for (const strat of strategies.filter(s => s.enabled)) {
          // Rule: OPTION — skip disabled strategy types in scoring
          if (instrType === 'OPTION' && rulesConfig.enabled) {
            if (activeRules.disable_sma_breakout?.enabled && ['SMA_CROSSOVER','BREAKOUT'].includes(strat.strategyType)) continue;
            if (activeRules.use_only_specific?.enabled && !['VWAP_PULLBACK','LIQUIDITY_SWEEP','BOLLINGER_REVERSION'].includes(strat.strategyType)) continue;
          }
          // Rule: STOCK COMPRESSION — skip BUY signals
          if (instrType === 'STOCK' && rulesConfig.enabled && activeRules.compression_short_only?.enabled && regime === 'COMPRESSION') {
            if (latestSignals[strat.label || strat.strategyType] === 'BUY') continue;
          }
          const stratLabel = strat.label || strat.strategyType;
          const signal = latestSignals[stratLabel];
          if (!signal || signal === 'HOLD') continue;
          const sc = scorersRef.current[token]
            ? scorersRef.current[token].score(strat.strategyType, signal, regime, instrType)
            : { total: 0, trendStrength: 0, volatility: 0, momentum: 0, confidence: 0 };
          // Rule: OPTION — distrust score driven by high volatility
          if (instrType === 'OPTION' && rulesConfig.enabled && activeRules.distrust_high_vol_score?.enabled) {
            if (sc.volatility > (parseFloat(activeRules.distrust_high_vol_score.volScoreMax) || 70)) continue;
          }
          const liveMinScore = parseFloat(scoreConfig.minScoreThreshold) || 0;
          if (sc.total < liveMinScore) continue;
          if (!bestScore || sc.total > bestScore.total) {
            bestStrat = strat; bestSignal = signal; bestScore = sc;
          }
        }

        const noSameCandleRevC = rulesConfig.enabled && activeRules.no_same_candle_reversal?.enabled;

        if (bestStrat && bestSignal) {
          const stratLabel = bestStrat.label || bestStrat.strategyType;
          const cp         = openPositionMap.current[combinedKey];
          const cHasLong   = cp?.type === 'LONG';
          const cHasShort  = cp?.type === 'SHORT';
          const allowShort = !!bestStrat.allowShorting;
          const trigger    = `Score-based (final=${bestScore.total.toFixed(1)}, base=${bestScore.baseScore?.toFixed(1)??'—'}, trend=${bestScore.trendStrength.toFixed(1)}, vol=${bestScore.volatility.toFixed(1)}, mom=${bestScore.momentum.toFixed(1)}, conf=${bestScore.confidence.toFixed(1)}, pen=${bestScore.totalPenalty?.toFixed(1)??0})`;

          // STOCK rule 3 — LONG quality gate for Combined
          const combinedPassesLongGate = () => {
            if (instrType !== 'STOCK' || !rulesConfig.enabled || !activeRules.long_quality_gate?.enabled) return true;
            if (bestScore.total < (parseFloat(activeRules.long_quality_gate.scoreMin) || 60)) return false;
            if ((reversalCooldownRef.current[combinedKey] || 0) > 0) return false;
            if (vwap) {
              const extPct = Math.abs(candle.close - vwap) / vwap * 100;
              if (extPct > (parseFloat(activeRules.long_quality_gate.vwapMaxPct) || 1.5)) return false;
            }
            return true;
          };

          const tagEntry = () => {
            if (openPositionMap.current[combinedKey]) {
              openPositionMap.current[combinedKey].sourceStrategy = stratLabel;
              openPositionMap.current[combinedKey].entryScore     = bestScore;
            }
          };
          if (bestSignal === 'BUY') {
            if (cHasShort) {
              if (noSameCandleRevC && candleClosedDir[combinedKey] === 'SHORT') { /* skip */ }
              else {
                closeShort(combinedKey, candle.close, 'SIGNAL', sym);
                candleClosedDir[combinedKey] = 'SHORT';
                combinedDetails.push({ action: 'Exit Short', price: candle.close, reason: 'Signal', regime, sourceStrategy: stratLabel, trigger, score: bestScore });
                if (allowShort && combinedPassesLongGate()) {
                  openLong(combinedKey, candle.close, regime, sym); tagEntry();
                  reversalCooldownRef.current[combinedKey] = 2;
                  combinedDetails.push({ action: 'Enter Long', price: candle.close, reason: 'Reversal SHORT→LONG', regime, sourceStrategy: stratLabel, trigger, score: bestScore });
                }
              }
            } else if (!cHasLong && combinedPassesLongGate()) {
              openLong(combinedKey, candle.close, regime, sym); tagEntry();
              combinedDetails.push({ action: 'Enter Long', price: candle.close, reason: 'Signal', regime, sourceStrategy: stratLabel, trigger, score: bestScore });
            }
          } else if (bestSignal === 'SELL') {
            if (cHasLong) {
              if (noSameCandleRevC && candleClosedDir[combinedKey] === 'LONG') { /* skip */ }
              else {
                closeLong(combinedKey, candle.close, 'SIGNAL', sym);
                candleClosedDir[combinedKey] = 'LONG';
                combinedDetails.push({ action: 'Exit Long', price: candle.close, reason: 'Signal', regime, sourceStrategy: stratLabel, trigger, score: bestScore });
                if (allowShort) {
                  openShort(combinedKey, candle.close, regime, sym); tagEntry();
                  reversalCooldownRef.current[combinedKey] = 2;
                  combinedDetails.push({ action: 'Enter Short', price: candle.close, reason: 'Reversal LONG→SHORT', regime, sourceStrategy: stratLabel, trigger, score: bestScore });
                }
              }
            } else if (!cHasShort && allowShort) {
              openShort(combinedKey, candle.close, regime, sym); tagEntry();
              combinedDetails.push({ action: 'Enter Short', price: candle.close, reason: 'Signal', regime, sourceStrategy: stratLabel, trigger, score: bestScore });
            }
          }
        }
      }
    }

    const logEntry = { ts: candleTime, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume, regime, signals: { ...latestSignals }, actions: logActions, blockedSignals, combinedDetails };
    candleLogsRef.current[token] = [...(candleLogsRef.current[token] || []), logEntry];
    setCandleLogByToken(prev => ({ ...prev, [token]: [...candleLogsRef.current[token]] }));
  }

  // ── KiteTicker connect handler (Step 1: establish WebSocket only) ─────────
  async function handleKiteConnect(e) {
    e.preventDefault();
    setError('');
    setStatus('connecting');
    try {
      await liveConnect({
        userId: session.userId, brokerName: session.brokerName,
        apiKey: session.apiKey, accessToken: session.accessToken,
      });

      // Poll until KiteTicker is connected (async handshake)
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
        const res = await liveStatus(session.userId, session.brokerName);
        if (res?.data === true) {
          setKiteConnected(true);
          setStatus('kite_ready');
          return;
        }
      }
      throw new Error('KiteTicker did not connect within 10 seconds — check credentials and try again');
    } catch (err) {
      setError(err.message);
      setStatus('idle');
    }
  }

  // ── Go Live handler (Step 2: subscribe instruments + start eval) ──────────
  async function handleGoLive(e) {
    e.preventDefault();
    const validInstrs = instruments.filter(i => i.instrumentToken);
    if (!validInstrs.length) { setError('Add at least one instrument with a token.'); return; }

    setError(''); setSignals([]); signalsRef.current = [];
    setTicksByToken({}); ticksRef.current = {};
    setLiveCandlesByToken({}); liveCandles_Ref.current = {};
    setCurrentCandleByToken({}); currentCandlesRef.current = {};
    setCurrentRegimeByToken({}); candleLogsRef.current = {};
    setCandleLogByToken({}); setPreloadStateByToken({});
    setStratStates({});
    setLiveSessionId(null);
    setSelectedInstrToken(String(validInstrs[0].instrumentToken));

    try {
      // ── Subscribe to Data Engine for price ticker display ─────────────────
      setStatus('connecting');
      await liveSubscribe({
        userId: session.userId, brokerName: session.brokerName,
        apiKey: session.apiKey, accessToken: session.accessToken, mode,
        instruments: validInstrs.map(i => ({
          instrumentToken: parseInt(i.instrumentToken, 10),
          symbol: i.symbol.toUpperCase(), exchange: i.exchange.toUpperCase(),
        })),
      });

      // Open Data Engine tick SSE — only used for price ticker updates
      const sse = new EventSource('/data-api/api/v1/data/stream/ticks');
      sseRef.current = sse;

      sse.addEventListener('tick', (ev) => {
        try {
          const tick  = JSON.parse(ev.data);
          const token = String(tick.instrumentToken ?? tick.token ?? '');
          if (!token) return;
          const instrConfig = instrumentsRef.current.find(i => String(i.instrumentToken) === token);
          if (!instrConfig) return;

          // Update ticks per instrument (price ticker display only)
          ticksRef.current[token] = [{ ...tick, ts: new Date().toLocaleTimeString() }, ...(ticksRef.current[token] || [])].slice(0, 200);
          setTicksByToken(prev => ({ ...prev, [token]: [...ticksRef.current[token]] }));

          // Update current forming candle for live price display
          const ltp   = parseFloat(tick.ltp);
          const tsMs  = Date.now();
          const ivMs  = INTERVAL_MS[instrConfig.candleInterval] || 300_000;
          const bucketStart = Math.floor(tsMs / ivMs) * ivMs;
          if (!currentCandlesRef.current[token]) {
            currentCandlesRef.current[token] = { open: ltp, high: ltp, low: ltp, close: ltp, volume: tick.volume||0, startTime: bucketStart };
          } else if (bucketStart > currentCandlesRef.current[token].startTime) {
            currentCandlesRef.current[token] = { open: ltp, high: ltp, low: ltp, close: ltp, volume: tick.volume||0, startTime: bucketStart };
          } else {
            const cur = currentCandlesRef.current[token];
            cur.high = Math.max(cur.high, ltp); cur.low = Math.min(cur.low, ltp);
            cur.close = ltp; cur.volume = tick.volume || cur.volume;
          }
          setCurrentCandleByToken(prev => ({ ...prev, [token]: { ...currentCandlesRef.current[token] } }));
        } catch {}
      });

      sse.onerror = () => {
        if (sse.readyState === EventSource.CLOSED) {
          setConnected(false); setStatus('disconnected'); cleanup();
        } else {
          setStatus('reconnecting');
          setTimeout(() => { if (sse.readyState === EventSource.OPEN) setStatus('connected'); }, 3000);
        }
      };

      // ── Step 2: Start Strategy Engine live eval session ──────────────────
      setStatus('warming up');
      const stratList = strategies.filter(s => s.enabled);
      const liveEvalRes = await startLiveEval({
        userId:     session.userId,
        brokerName: session.brokerName,
        resumeFromSnapshot,
        instruments: validInstrs.map(i => ({
          instrumentToken: parseInt(i.instrumentToken, 10),
          symbol:          i.symbol.toUpperCase(),
          exchange:        i.exchange.toUpperCase(),
          instrumentType:  resolveInstrType(i.instrumentType, i.symbol, i.exchange),
        })),
        candleInterval: mode,
        preloadDaysBack: preload.enabled ? (parseInt(preload.daysBack, 10) || 5) : 0,
        preloadInterval: preload.interval || mode,
        initialCapital:  parseFloat(initialCapital) || 100000,
        quantity:        parseInt(quantity, 10) || 0,
        product:         'MIS',
        combinedOnlyMode,
        allowShorting:   strategies.every(s => s.allowShorting),
        strategies:      stratList.map(s => ({
          strategyType:  s.strategyType,
          label:         s.label || '',
          parameters:    s.parameters || {},
          activeRegimes: s.activeRegimes || [],
          allowShorting: !!s.allowShorting,
        })),
        riskConfig:    riskConfig.enabled   ? riskConfig   : null,
        patternConfig: patternConfig.enabled ? patternConfig : null,
        regimeConfig:  regimeConfig.enabled  ? regimeConfig  : null,
        scoreConfig:   scoreConfig.enabled   ? scoreConfig   : null,
        rulesConfig: rulesConfig.enabled ? {
          enabled: true,
          stocks: {
            rangingNoTrade:       rulesConfig.stocks?.ranging_no_trade?.enabled ?? true,
            compressionShortOnly: rulesConfig.stocks?.compression_short_only?.enabled ?? true,
            noSameCandleReversal: rulesConfig.stocks?.no_same_candle_reversal?.enabled ?? true,
            longQualityGate: {
              enabled:    rulesConfig.stocks?.long_quality_gate?.enabled ?? true,
              scoreMin:   parseFloat(rulesConfig.stocks?.long_quality_gate?.scoreMin)  || 60,
              vwapMaxPct: parseFloat(rulesConfig.stocks?.long_quality_gate?.vwapMaxPct) || 1.5,
            },
          },
          options: {
            volatileNoTrade:      rulesConfig.options?.volatile_no_trade?.enabled ?? true,
            disableSmaBreakout:   rulesConfig.options?.disable_sma_breakout?.enabled ?? true,
            distrustHighVolScore: rulesConfig.options?.distrust_high_vol_score?.enabled ?? true,
            volScoreMax:          parseFloat(rulesConfig.options?.distrust_high_vol_score?.volScoreMax) || 70,
            noSameCandleReversal: rulesConfig.options?.no_same_candle_reversal?.enabled ?? true,
          },
        } : { enabled: false },
      });

      const newSessionId = liveEvalRes?.data?.sessionId;
      if (!newSessionId) throw new Error('Strategy Engine did not return a sessionId');
      setLiveSessionId(newSessionId);

      // Mark each instrument as preloading (the backend does the warmup)
      validInstrs.forEach(i => {
        const token = String(i.instrumentToken);
        setPreloadStateByToken(prev => ({ ...prev, [token]: { status: 'loading', count: 0, error: null } }));
      });

      // ── Step 3: Subscribe to Strategy Engine candle event SSE stream ─────
      const abortCtrl = new AbortController();
      liveAbortCtrlRef.current = abortCtrl;

      // Use fetch + ReadableStream for the SSE (same pattern as Replay Test)
      const sseResponse = await fetch(`/strategy-api/api/v1/strategy/live/stream/${newSessionId}`, {
        headers: { Accept: 'text/event-stream' },
        signal: abortCtrl.signal,
      });
      if (!sseResponse.ok) throw new Error(`Strategy Engine stream returned HTTP ${sseResponse.status}`);

      setConnected(true); setStatus('connected');

      // Read SSE stream in background (non-blocking — React state updates from a microtask loop)
      const reader   = sseResponse.body.getReader();
      const decoder  = new TextDecoder();
      let   buffer   = '';

      const processStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete last line

            let eventName  = null;
            let dataBuffer = '';
            for (const line of lines) {
              if (line.startsWith('event:')) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                dataBuffer = line.slice(5).trim();
              } else if (line === '' && dataBuffer) {
                // Dispatch the event
                try {
                  if (eventName === 'candle') {
                    const envelope = JSON.parse(dataBuffer);
                    const token    = String(envelope.instrumentToken);
                    const sym      = envelope.symbol;
                    const ev       = envelope.candle;
                    if (!ev) { dataBuffer = ''; eventName = null; continue; }

                    // Update regime display
                    if (ev.regime) setCurrentRegimeByToken(prev => ({ ...prev, [token]: ev.regime }));

                    // Accumulate live candles
                    const candleEntry = {
                      time: ev.candleTime, open: ev.open, high: ev.high,
                      low: ev.low, close: ev.close, volume: ev.volume,
                    };
                    liveCandles_Ref.current[token] = [...(liveCandles_Ref.current[token] || []), candleEntry].slice(-500);
                    setLiveCandlesByToken(prev => ({ ...prev, [token]: [...liveCandles_Ref.current[token]] }));

                    // Update strategy states (keyed by `${token}::${label}`)
                    if (ev.strategyStates) {
                      const patch = {};
                      for (const [label, state] of Object.entries(ev.strategyStates)) {
                        patch[`${token}::${label}`] = state;
                      }
                      setStratStates(prev => ({ ...prev, ...patch }));
                    }

                    // Update signals
                    if (ev.signals) {
                      const newSigs = Object.entries(ev.signals)
                        .filter(([, sig]) => sig !== 'HOLD')
                        .map(([label, sig]) => ({
                          signal: sig, price: ev.close, symbol: sym,
                          ts: ev.candleTime || new Date().toLocaleTimeString(),
                          strategyLabel: label,
                        }));
                      if (newSigs.length > 0) {
                        signalsRef.current = [...newSigs, ...signalsRef.current].slice(0, 200);
                        setSignals([...signalsRef.current]);
                      }
                    }

                    // Candle log for the activity feed
                    const logEntry = {
                      ts: ev.candleTime, open: ev.open, high: ev.high, low: ev.low,
                      close: ev.close, volume: ev.volume, regime: ev.regime,
                      signals: ev.signals || {}, actions: ev.actions || [],
                      blockedSignals: ev.blockedSignals || [],
                      combinedDetails: ev.combinedDetails || [],
                    };
                    candleLogsRef.current[token] = [...(candleLogsRef.current[token] || []), logEntry];
                    setCandleLogByToken(prev => ({ ...prev, [token]: [...candleLogsRef.current[token]] }));

                  } else if (eventName === 'restore') {
                    // Session restored from snapshot — repopulate UI state
                    try {
                      const snap = JSON.parse(dataBuffer);
                      if (snap?.instruments) {
                        const newStratStates = {};
                        const newCandleLogs  = {};
                        for (const [token, instrSnap] of Object.entries(snap.instruments)) {
                          // Strategy states → stratStates keyed by `${token}::${label}`
                          if (instrSnap.strategies) {
                            for (const [label, ss] of Object.entries(instrSnap.strategies)) {
                              newStratStates[`${token}::${label}`] = {
                                capital:      ss.capital,
                                openPosition: ss.openPosition,
                                closedTrades: ss.closedTrades || [],
                                equityPoints: ss.equityPoints || [],
                              };
                            }
                          }
                          if (instrSnap.combined) {
                            newStratStates[`${token}::${COMBINED_LABEL}`] = {
                              capital:      instrSnap.combined.capital,
                              openPosition: instrSnap.combined.openPosition,
                              closedTrades: instrSnap.combined.closedTrades || [],
                              equityPoints: instrSnap.combined.equityPoints || [],
                            };
                          }
                        }
                        // Candle logs
                        if (snap.candleLogs) {
                          for (const [token, entries] of Object.entries(snap.candleLogs)) {
                            const logs = (entries || []).map(e => ({
                              ts: e.candleTime, open: e.open, high: e.high, low: e.low,
                              close: e.close, volume: e.volume, regime: e.regime,
                              signals: e.signals || {}, actions: e.actions || [],
                              blockedSignals: e.blockedSignals || [],
                              combinedDetails: e.combinedDetails || [],
                            }));
                            candleLogsRef.current[token] = logs;
                            newCandleLogs[token] = logs;
                          }
                        }
                        setStratStates(prev => ({ ...prev, ...newStratStates }));
                        setCandleLogByToken(prev => ({ ...prev, ...newCandleLogs }));
                      }
                    } catch {}
                  } else if (eventName === 'info') {
                    // Preload done notification
                    try {
                      const info = JSON.parse(dataBuffer);
                      if (info.type === 'preload_done') {
                        const token = String(info.instrumentToken);
                        setPreloadStateByToken(prev => ({
                          ...prev,
                          [token]: { status: 'done', count: info.count || 0, error: null },
                        }));
                      }
                    } catch {}
                  } else if (eventName === 'error') {
                    setError(`Strategy Engine: ${dataBuffer}`);
                  }
                } catch {}
                dataBuffer = '';
                eventName  = null;
              }
            }
          }
        } catch (err) {
          if (err.name !== 'AbortError') {
            setError(`Live eval stream error: ${err.message}`);
            setConnected(false); setStatus('disconnected');
          }
        }
      };
      processStream(); // fire and forget — runs concurrently
    } catch (err) { setError(err.message); setStatus('idle'); cleanup(); }
  }

  async function handleDisconnect() {
    const tokens = instruments.filter(i => i.instrumentToken).map(i => parseInt(i.instrumentToken, 10));
    // Stop Strategy Engine session first
    if (liveSessionId) {
      try { await stopLiveEval(liveSessionId); } catch {}
      setLiveSessionId(null);
    }
    // Unsubscribe from Data Engine
    try { await liveUnsubscribe({ userId: session.userId, brokerName: session.brokerName, instrumentTokens: tokens }); } catch {}
    cleanup(); setConnected(false); setKiteConnected(false); setStatus('idle');
  }

  // ── Derived values (filtered to selected instrument) ──────────────────────
  const initCap = parseFloat(initialCapital) || 100000;
  const selInstrConfig = instruments.find(i => String(i.instrumentToken) === selectedInstrToken) || instruments[0] || {};
  // Keys for selected instrument
  const allStratKeys      = selectedInstrToken ? Object.keys(stratStates).filter(k => k.startsWith(selectedInstrToken + '::')) : [];
  const allStratLabels    = allStratKeys.map(k => k.split('::')[1]);
  // Exclude ⚡ Combined from aggregate metrics (it's a separate pool, not additional capital)
  const indivStratKeys    = allStratKeys.filter(k => !k.endsWith('::' + COMBINED_LABEL));
  const numActive         = indivStratKeys.length || 1;
  const totalDeployed     = initCap * numActive;
  const totalPnl          = indivStratKeys.reduce((s, k) => s + ((stratStates[k]?.capital ?? initCap) - initCap), 0);
  const totalPnlPct       = totalDeployed > 0 ? (totalPnl / totalDeployed) * 100 : 0;
  const allClosedTrades   = indivStratKeys.flatMap(k => stratStates[k]?.closedTrades || []);
  // Per-instrument selected state
  const latestTick    = selectedInstrToken ? (ticksByToken[selectedInstrToken]?.[0] ?? null) : null;
  const ticks         = selectedInstrToken ? (ticksByToken[selectedInstrToken] ?? []) : [];
  const currentCandle = selectedInstrToken ? (currentCandleByToken[selectedInstrToken] ?? null) : null;
  const currentRegime = selectedInstrToken ? (currentRegimeByToken[selectedInstrToken] ?? null) : null;
  const liveCandles   = selectedInstrToken ? (liveCandlesByToken[selectedInstrToken] ?? []) : [];
  const candleLog     = selectedInstrToken ? (candleLogByToken[selectedInstrToken] ?? []) : [];
  const candleLogRef  = { current: selectedInstrToken ? (candleLogsRef.current[selectedInstrToken] ?? []) : [] };
  // Map stratLabel → state for the selected instrument — used throughout JSX
  const instrStratStates = Object.fromEntries(allStratKeys.map(k => [k.split('::')[1], stratStates[k]]));
  // Composite key for closePaperPosition calls from manual close button
  const instrKey = lbl => selectedInstrToken ? `${selectedInstrToken}::${lbl}` : lbl;
  const changeColor   = (latestTick?.change ?? 0) >= 0 ? '#22c55e' : '#ef4444';
  const fmtRs = v => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  return (
    <div className="bt-live-layout">

      {/* ── Top row ─────────────────────────────────────────────────────── */}
      <div className="bt-live-top-row">

        {/* Instruments + connection */}
        <div className="card bt-live-conn-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 className="section-title" style={{ margin: 0 }}>Instruments & Connection</h3>
            {!connected && instruments.length < 6 && (
              <button type="button" className="btn-secondary btn-xs" onClick={addInstrument}>+ Add Instrument</button>
            )}
          </div>
          <form onSubmit={e => e.preventDefault()}>
            {/* Per-instrument rows */}
            {instruments.map((instr, idx) => {
              const isExpanded = expandedInstrs[instr.id] !== false; // default expanded
              const displayName = instr.symbol ? `${instr.symbol}${instr.exchange ? ' · ' + instr.exchange : ''}` : `Instrument ${idx + 1}`;
              return (
                <div key={instr.id} style={{ border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
                  {/* Header row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: 'var(--surface-2)', cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setExpandedInstrs(p => ({ ...p, [instr.id]: !isExpanded }))}>
                    <span style={{ fontSize: 13, fontWeight: 600, flex: 1, color: 'var(--text-primary)' }}>{displayName}</span>
                    {instr.instrumentToken && (
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>#{instr.instrumentToken}</span>
                    )}
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 2 }}>{isExpanded ? '▲' : '▼'}</span>
                    {instruments.length > 1 && !connected && (
                      <button type="button" className="btn-danger btn-xs" style={{ marginLeft: 4, padding: '1px 6px' }}
                        onClick={e => { e.stopPropagation(); removeInstrument(instr.id); }}>✕</button>
                    )}
                  </div>
                  {/* Collapsible body */}
                  {isExpanded && (
                    <div style={{ padding: '10px 10px 6px' }}>
                      <InstrumentPicker
                        session={session}
                        symbol={instr.symbol} exchange={instr.exchange} instrumentToken={instr.instrumentToken}
                        onSelect={r => { updateInstrument(instr.id, { symbol: r.tradingSymbol, exchange: r.exchange, instrumentToken: String(r.instrumentToken), instrumentType: deriveInstrumentType(r.instrumentType) }); saveRecentInstrument(r); }}
                        onChange={patch => updateInstrument(instr.id, patch)}
                        disabled={connected}
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                        <div className="form-group" style={{ flex: 1 }}>
                          <label>Candle Interval</label>
                          <select value={instr.candleInterval} onChange={e => updateInstrument(instr.id, { candleInterval: e.target.value })} disabled={connected}>
                            {INTERVALS.map(iv => <option key={iv.value} value={iv.value}>{iv.label}</option>)}
                          </select>
                        </div>
                        <div className="form-group" style={{ flex: 1 }}>
                          <label>Type</label>
                          <select value={instr.instrumentType || 'STOCK'} onChange={e => updateInstrument(instr.id, { instrumentType: e.target.value })} disabled={connected}>
                            <option value="STOCK">Stock</option>
                            <option value="OPTION">Option</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <div className="form-row">
              <div className="form-group">
                <label>Mode</label>
                <select value={mode} onChange={e => setMode(e.target.value)} disabled={connected}>
                  <option value="LTP">LTP</option>
                  <option value="QUOTE">QUOTE</option>
                  <option value="FULL">FULL</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Initial Capital (₹)</label>
                <input type="number" min="1000" value={initialCapital} onChange={e => setInitialCapital(e.target.value)} disabled={connected} />
              </div>
              <div className="form-group">
                <label>Quantity <span className="form-hint">(0 = auto)</span></label>
                <input type="number" min="0" value={quantity} onChange={e => setQuantity(e.target.value)} disabled={connected} />
              </div>
            </div>

            {/* Preload */}
            <div className="de-preload-block" style={{ marginBottom: 14 }}>
              <div className="de-preload-header">
                <label className="checkbox-label" style={{ margin: 0, fontWeight: 600 }}>
                  <input type="checkbox" checked={preload.enabled} disabled={connected}
                    onChange={e => setPreload(p => ({ ...p, enabled: e.target.checked }))} />
                  Preload past candles
                </label>
                <span className="de-preload-hint">Warms up all evaluators before going live</span>
              </div>
              {preload.enabled && (
                <div className="de-preload-fields">
                  <div className="form-group">
                    <label>Days back</label>
                    <input type="number" min="1" max="60" value={preload.daysBack} disabled={connected}
                      onChange={e => setPreload(p => ({ ...p, daysBack: e.target.value }))} style={{ width: 80 }} />
                  </div>
                  <div className="form-group">
                    <label>Interval</label>
                    <select value={preload.interval} disabled={connected} onChange={e => setPreload(p => ({ ...p, interval: e.target.value }))}>
                      {INTERVALS.map(iv => <option key={iv.value} value={iv.value}>{iv.label}</option>)}
                    </select>
                  </div>
                </div>
              )}
              {/* Per-instrument preload status */}
              {Object.entries(preloadStateByToken).map(([token, ps]) => {
                const sym = instruments.find(i => String(i.instrumentToken) === token)?.symbol || token;
                return (
                  <div key={token} className="de-preload-results">
                    {ps.status === 'loading' && <span className="de-preload-loading">{sym}: Fetching…</span>}
                    {ps.status === 'done'    && <span className="de-preload-result-item de-preload-ok">{sym}: {ps.count} candles warmed up</span>}
                    {ps.status === 'error'   && <span className="de-preload-result-item de-preload-error">{sym}: Preload failed — {ps.error}</span>}
                  </div>
                );
              })}
            </div>

            {/* Saved snapshot banner */}
            {savedSnapshot && !connected && (
              <div style={{ background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.4)', borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: '#ca8a04', fontWeight: 600, marginBottom: 4 }}>
                  💾 Saved session found — {new Date(savedSnapshot.savedAt).toLocaleString()}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  Resume to continue from your last recorded positions and trades.
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
                    <input type="checkbox" checked={resumeFromSnapshot}
                      onChange={e => setResumeFromSnapshot(e.target.checked)} />
                    Resume from saved state
                  </label>
                  <button type="button" className="btn-secondary btn-xs" style={{ marginLeft: 'auto' }}
                    onClick={() => {
                      deleteLiveSnapshot(session.userId, session.brokerName).catch(() => {});
                      setSavedSnapshot(null);
                      setResumeFromSnapshot(false);
                    }}>
                    Discard
                  </button>
                </div>
              </div>
            )}

            {error    && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
            {!isActive && <div className="error-msg" style={{ marginBottom: 12 }}>No active session.</div>}

            <div style={{ display: 'flex', gap: 8 }}>
              {!kiteConnected
                ? <button type="button" className="btn-secondary" disabled={!isActive || status === 'connecting'}
                    onClick={handleKiteConnect}>
                    {status === 'connecting' ? 'Connecting…' : '🔌 Connect Kite'}
                  </button>
                : !connected
                  ? <button type="button" className="btn-primary" disabled={!isActive || ['warming up','connecting'].includes(status)}
                      onClick={handleGoLive}>
                      {status === 'warming up' ? 'Warming up…' : status === 'connecting' ? 'Connecting…' : '▶ Go Live'}
                    </button>
                  : <button type="button" className="btn-danger" onClick={handleDisconnect}>✕ Unsubscribe</button>
              }
              {kiteConnected && !connected && (
                <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--success)' }}>● Kite connected</span>
              )}
            </div>
          </form>
        </div>

        {/* ── Center: Risk / Regime / Pattern ── */}
        <div className="bt-live-center-col">

        {/* Risk Config */}
        <div className="card bt-risk-card" style={{ marginBottom: 12 }}>
          <div className="bt-risk-toggle-row">
            <span className="bt-risk-label">Risk Management
              <span className={riskConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                {riskConfig.enabled ? 'enabled' : 'disabled'}
              </span>
            </span>
            <button type="button" disabled={connected}
              className={riskConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
              onClick={() => updateRisk('enabled', !riskConfig.enabled)}>
              {riskConfig.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {riskConfig.enabled && (
            <div className="bt-risk-fields">
              {[
                ['Stop Loss %', 'stopLossPct', '0.1', '100'],
                ['Take Profit %', 'takeProfitPct', '0.1', null],
                ['Max Risk / Trade %', 'maxRiskPerTradePct', '0.1', '100'],
                ['Daily Loss Cap %', 'dailyLossCapPct', '0.1', '100'],
                ['Cooldown Candles', 'cooldownCandles', '1', null, true],
              ].map(([lbl, key, step, max]) => (
                <div className="form-group" key={key}>
                  <label>{lbl}</label>
                  <input type="number" min="0" max={max||undefined} step={step} value={riskConfig[key]} disabled={connected}
                    onChange={e => updateRisk(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Regime Config */}
        <div className="card bt-risk-card" style={{ marginBottom: 12 }}>
          <div className="bt-risk-toggle-row">
            <span className="bt-risk-label">Market Regime Detection
              <span className={regimeConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                {regimeConfig.enabled ? 'enabled' : 'disabled'}
              </span>
            </span>
            <button type="button" disabled={connected}
              className={regimeConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
              onClick={() => updateRegime('enabled', !regimeConfig.enabled)}>
              {regimeConfig.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {regimeConfig.enabled && (
            <div className="bt-risk-fields">
              {[['ADX Period','adxPeriod'],['ATR Period','atrPeriod'],['ADX Trend Threshold','adxTrendThreshold'],
                ['ATR Volatile %','atrVolatilePct'],['ATR Compression %','atrCompressionPct']].map(([lbl, key]) => (
                <div className="form-group" key={key}>
                  <label>{lbl}</label>
                  <input type="number" min="0" step="0.5" value={regimeConfig[key]} disabled={connected}
                    onChange={e => updateRegime(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Score-Based Combined Pool */}
        <div className="card bt-risk-card" style={{ marginBottom: 12 }}>
          <div className="bt-risk-toggle-row">
            <span className="bt-risk-label">Score-Based Combined Pool
              <span className={scoreConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                {scoreConfig.enabled ? 'enabled' : 'disabled'}
              </span>
            </span>
            <button type="button" disabled={connected}
              className={scoreConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
              onClick={() => setScoreConfig(p => ({ ...p, enabled: !p.enabled }))}>
              {scoreConfig.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {scoreConfig.enabled && (
            <div className="bt-risk-fields">
              <div className="form-group">
                <label>Min Score Threshold</label>
                <input type="number" min="0" max="100" step="1" disabled={connected}
                  value={scoreConfig.minScoreThreshold}
                  onChange={e => setScoreConfig(p => ({ ...p, minScoreThreshold: e.target.value }))} />
              </div>
            </div>
          )}
        </div>

        {/* Pattern Config */}
        <div className="card bt-risk-card">
          <div className="bt-risk-toggle-row">
            <span className="bt-risk-label">Pattern Confirmation
              <span className={patternConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                {patternConfig.enabled ? 'enabled' : 'disabled'}
              </span>
            </span>
            <button type="button" disabled={connected}
              className={patternConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
              onClick={() => updatePattern('enabled', !patternConfig.enabled)}>
              {patternConfig.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {patternConfig.enabled && (
            <>
              <div className="bt-risk-fields">
                <div className="form-group"><label>Min Wick Ratio</label>
                  <input type="number" min="0" step="0.1" value={patternConfig.minWickRatio} disabled={connected} onChange={e => updatePattern('minWickRatio', e.target.value)} />
                </div>
                <div className="form-group"><label>Max Body %</label>
                  <input type="number" min="0" max="1" step="0.05" value={patternConfig.maxBodyPct} disabled={connected} onChange={e => updatePattern('maxBodyPct', e.target.value)} />
                </div>
              </div>
              <div className="bt-params-label" style={{ marginTop: 8 }}>BUY confirm patterns</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {BUY_PATTERNS.map(p => (
                  <label key={p.id} className="checkbox-label">
                    <input type="checkbox" disabled={connected} checked={patternConfig.buyConfirmPatterns.includes(p.id)}
                      onChange={() => togglePatternList('buyConfirmPatterns', p.id)} />
                    {p.label}
                  </label>
                ))}
              </div>
              <div className="bt-params-label" style={{ marginTop: 8 }}>SELL confirm patterns</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {SELL_PATTERNS.map(p => (
                  <label key={p.id} className="checkbox-label">
                    <input type="checkbox" disabled={connected} checked={patternConfig.sellConfirmPatterns.includes(p.id)}
                      onChange={() => togglePatternList('sellConfirmPatterns', p.id)} />
                    {p.label}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Trading Rules */}
        <div className="card bt-risk-card" style={{ marginTop: 12 }}>
          <div className="bt-risk-toggle-row">
            <span className="bt-risk-label">Trading Rules
              <span className={rulesConfig.enabled ? 'bt-status-badge bt-status-on' : 'bt-status-badge bt-status-off'}>
                {rulesConfig.enabled ? 'enabled' : 'disabled'}
              </span>
            </span>
            <button type="button" disabled={connected}
              className={rulesConfig.enabled ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
              onClick={() => setRulesConfig(p => ({ ...p, enabled: !p.enabled }))}>
              {rulesConfig.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {rulesConfig.enabled && (() => {
            // Show only sections relevant to configured instrument types
            const configuredTypes = instruments.map(i => resolveInstrType(i.instrumentType, i.symbol, i.exchange));
            const hasStock  = configuredTypes.some(t => t !== 'OPTION');
            const hasOption = configuredTypes.some(t => t === 'OPTION');
            return (
              <>
                {/* Stock rules — shown only when at least one STOCK instrument configured */}
                {hasStock && (
                  <>
                    <div className="bt-params-label" style={{ marginTop: 10, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, background: 'rgba(34,197,94,0.15)', color: '#22c55e', borderRadius: 4, padding: '1px 7px', fontWeight: 700 }}>STOCK</span>
                      Rules
                    </div>
                    {[
                      ['ranging_no_trade',       'No trade in RANGING regime'],
                      ['compression_short_only', 'SHORT only in COMPRESSION regime'],
                      ['no_same_candle_reversal','No same-candle reversal'],
                    ].map(([key, lbl]) => (
                      <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, paddingRight: 8 }}>{lbl}</span>
                        <button type="button" disabled={connected}
                          className={rulesConfig.stocks[key]?.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                          style={{ minWidth: 36 }}
                          onClick={() => updateRule('stocks', key, 'enabled', !rulesConfig.stocks[key]?.enabled)}>
                          {rulesConfig.stocks[key]?.enabled ? 'ON' : 'OFF'}
                        </button>
                      </div>
                    ))}
                    <div style={{ padding: '6px 0', borderBottom: hasOption ? '1px solid var(--border)' : undefined }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, paddingRight: 8 }}>LONG requires min score + no recent reversal + within VWAP</span>
                        <button type="button" disabled={connected}
                          className={rulesConfig.stocks.long_quality_gate?.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                          style={{ minWidth: 36 }}
                          onClick={() => updateRule('stocks', 'long_quality_gate', 'enabled', !rulesConfig.stocks.long_quality_gate?.enabled)}>
                          {rulesConfig.stocks.long_quality_gate?.enabled ? 'ON' : 'OFF'}
                        </button>
                      </div>
                      {rulesConfig.stocks.long_quality_gate?.enabled && (
                        <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                          <div className="form-group" style={{ flex: 1 }}>
                            <label>Min Score</label>
                            <input type="number" min="0" max="100" step="5" disabled={connected}
                              value={rulesConfig.stocks.long_quality_gate.scoreMin}
                              onChange={e => updateRule('stocks', 'long_quality_gate', 'scoreMin', parseFloat(e.target.value))} />
                          </div>
                          <div className="form-group" style={{ flex: 1 }}>
                            <label>Max VWAP Ext %</label>
                            <input type="number" min="0" step="0.1" disabled={connected}
                              value={rulesConfig.stocks.long_quality_gate.vwapMaxPct}
                              onChange={e => updateRule('stocks', 'long_quality_gate', 'vwapMaxPct', parseFloat(e.target.value))} />
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* Option rules — shown only when at least one OPTION instrument configured */}
                {hasOption && (
                  <>
                    <div className="bt-params-label" style={{ marginTop: 10, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 11, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', borderRadius: 4, padding: '1px 7px', fontWeight: 700 }}>OPTION</span>
                      Rules
                    </div>
                    {[
                      ['volatile_no_trade',       'No trade in VOLATILE regime'],
                      ['disable_sma_breakout',    'Disable SMA_CROSSOVER and BREAKOUT'],
                      ['use_only_specific',       'Use only VWAP_PULLBACK / LIQUIDITY_SWEEP / BOLLINGER_REVERSION'],
                      ['no_same_candle_reversal', 'No same-candle reversal'],
                    ].map(([key, lbl]) => (
                      <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, paddingRight: 8 }}>{lbl}</span>
                        <button type="button" disabled={connected}
                          className={rulesConfig.options[key]?.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                          style={{ minWidth: 36 }}
                          onClick={() => updateRule('options', key, 'enabled', !rulesConfig.options[key]?.enabled)}>
                          {rulesConfig.options[key]?.enabled ? 'ON' : 'OFF'}
                        </button>
                      </div>
                    ))}
                    <div style={{ padding: '6px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, paddingRight: 8 }}>Distrust scores driven by high volatility</span>
                        <button type="button" disabled={connected}
                          className={rulesConfig.options.distrust_high_vol_score?.enabled ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                          style={{ minWidth: 36 }}
                          onClick={() => updateRule('options', 'distrust_high_vol_score', 'enabled', !rulesConfig.options.distrust_high_vol_score?.enabled)}>
                          {rulesConfig.options.distrust_high_vol_score?.enabled ? 'ON' : 'OFF'}
                        </button>
                      </div>
                      {rulesConfig.options.distrust_high_vol_score?.enabled && (
                        <div className="form-group" style={{ marginTop: 6 }}>
                          <label>Max Volatility Score</label>
                          <input type="number" min="0" max="100" step="5" disabled={connected}
                            value={rulesConfig.options.distrust_high_vol_score.volScoreMax}
                            onChange={e => updateRule('options', 'distrust_high_vol_score', 'volScoreMax', parseFloat(e.target.value))} />
                        </div>
                      )}
                    </div>
                  </>
                )}
              </>
            );
          })()}
        </div>

        </div>{/* end bt-live-center-col */}

        {/* ── Feed tabs (right col) ── */}
        <div className="bt-live-feed">

        {/* Instrument selector (shown when multiple instruments) */}
        {instruments.filter(i => i.instrumentToken).length > 1 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: '6px 0 4px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
            {instruments.filter(i => i.instrumentToken).map(instr => {
              const token = String(instr.instrumentToken);
              const isSel = token === selectedInstrToken;
              const ltpVal = ticksByToken[token]?.[0]?.ltp;
              return (
                <button key={token} onClick={() => setSelectedInstrToken(token)}
                  style={{ fontSize: 11, padding: '3px 10px', borderRadius: 12, border: '1px solid',
                    background:   isSel ? 'var(--accent)' : 'transparent',
                    color:        isSel ? '#fff' : 'var(--text-secondary)',
                    borderColor:  isSel ? 'var(--accent)' : 'var(--border)',
                    cursor: 'pointer', fontWeight: isSel ? 700 : 400 }}>
                  {instr.symbol || token}
                  {ltpVal != null && <span style={{ marginLeft: 5, opacity: 0.85 }}>₹{Number(ltpVal).toFixed(2)}</span>}
                </button>
              );
            })}
          </div>
        )}

        {/* Tab bar */}
        <div className="bt-live-right-tabs">
          {[['feed','Feed'],['pnl','P&L'],['portfolio','Portfolio'],['details','Details']].map(([k,l]) => (
            <button key={k} className={`bt-live-tab-btn ${rightTab===k?'active':''}`} onClick={() => setRightTab(k)}>{l}</button>
          ))}
          {currentRegime && (
            <span className={`bt-regime-badge bt-regime-${currentRegime}`} style={{ marginLeft: 'auto', alignSelf: 'center' }}>
              {currentRegime}
            </span>
          )}
          <span className={`bt-status-pill bt-status-${status}`} style={{ marginLeft: currentRegime ? 8 : 'auto', alignSelf: 'center' }}>
            {status.toUpperCase()}
          </span>
        </div>

        {/* ── Feed tab ── */}
        {rightTab === 'feed' && (
          <>
            {/* Latest tick */}
            {latestTick && (
              <div className="card bt-feed-status" style={{ marginBottom: 10 }}>
                <div className="bt-live-ticker">
                  <span style={{ fontWeight: 700, fontSize: 18 }}>{latestTick.symbol}</span>
                  <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent)' }}>
                    {fmtRs(latestTick.ltp)}
                  </span>
                  <span style={{ fontSize: 13, color: changeColor }}>
                    {(latestTick.change??0) >= 0 ? '+' : ''}{Number(latestTick.change||0).toFixed(2)}%
                  </span>
                  {currentCandle && (
                    <div className="bt-ohlc-row" style={{ marginTop: 6 }}>
                      {[['O',currentCandle.open],['H',currentCandle.high],['L',currentCandle.low],['C',currentCandle.close]].map(([l,v])=>(
                        <span key={l}><span className="meta-label">{l}</span> {Number(v).toFixed(2)}</span>
                      ))}
                      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>forming…</span>
                    </div>
                  )}
                </div>
                {/* Candles formed */}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  {liveCandles.length} candle{liveCandles.length !== 1 ? 's' : ''} closed · {ticks.length} ticks
                  {allStratLabels.filter(lbl => instrStratStates[lbl]?.openPosition).map(lbl => {
                    const pos  = instrStratStates[lbl].openPosition;
                    const ltp  = parseFloat(latestTick?.ltp || pos.entryPrice);
                    const uPnl = pos.type === 'SHORT' ? (pos.entryPrice - ltp) * pos.qty : (ltp - pos.entryPrice) * pos.qty;
                    const uPct = (uPnl / (pos.entryPrice * pos.qty)) * 100;
                    return (
                      <span key={lbl} style={{ marginLeft: 12, color: uPnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                        {pos.type === 'SHORT' ? 'SHORT↓' : 'LONG↑'} {lbl} — {fmtRs(uPnl)} ({uPct.toFixed(2)}%)
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
            {!latestTick && (
              <div className="card bt-feed-status" style={{ marginBottom: 10 }}>
                <span className={`bt-status-pill bt-status-${status}`}>{status.toUpperCase()}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 10 }}>
                  {connected ? 'Waiting for ticks…' : 'Connect to start paper trading'}
                </span>
              </div>
            )}

            {/* Signal log */}
            {signals.length > 0 && (
              <div className="card" style={{ marginBottom: 10, padding: 0 }}>
                <div className="bt-feed-header">
                  <span className="bt-params-label" style={{ margin: 0 }}>Signals</span>
                </div>
                <div className="bt-signal-log">
                  {signals.map((s, i) => (
                    <div key={i} className={`bt-signal-row ${s.signal !== 'HOLD' ? 'bt-signal-actionable' : ''}`}>
                      <span className="mono-sm" style={{ color: 'var(--text-muted)', minWidth: 56 }}>{s.ts}</span>
                      {signalBadge(s.signal)}
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1 }}>{s.strategyLabel}</span>
                      <span style={{ fontSize: 12, color: 'var(--accent)' }}>{fmtRs(s.price)}</span>
                      {s.reason && <span className={`bt-exit-badge bt-exit-${s.reason.toLowerCase().replace('_','-')}`}>{s.reason}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tick stream */}
            <div className="card" style={{ padding: 0 }}>
              <div className="bt-feed-header">
                <span className="bt-params-label" style={{ margin: 0 }}>Tick Stream</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ticks.length} received</span>
              </div>
              <div className="bt-signal-log">
                {ticks.length === 0
                  ? <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                      Ticks will appear here when connected.
                    </div>
                  : ticks.map((t, i) => (
                    <div key={i} className="bt-signal-row">
                      <span className="mono-sm" style={{ color: 'var(--text-muted)', minWidth: 56 }}>{t.ts}</span>
                      <span style={{ fontWeight: 600, fontSize: 12, minWidth: 80 }}>{t.symbol}</span>
                      <span style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 700 }}>{fmtRs(t.ltp)}</span>
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
          </>
        )}

        {/* ── P&L tab ── */}
        {rightTab === 'pnl' && (
          <>
            {/* Aggregate summary */}
            <div className="bt-live-pnl-summary" style={{ marginBottom: 10 }}>
              {[
                ['Total P&L', fmtRs(totalPnl), totalPnl >= 0 ? '#22c55e' : '#ef4444'],
                ['Return', `${totalPnlPct.toFixed(2)}%`, totalPnlPct >= 0 ? '#22c55e' : '#ef4444'],
                ['Total Trades', String(allClosedTrades.length), null],
                ['Win Rate', allClosedTrades.length ? `${(allClosedTrades.filter(t=>t.pnl>=0).length/allClosedTrades.length*100).toFixed(1)}%` : '—', null],
                ['Strategies', String(numActive), null],
              ].map(([label, val, color]) => (
                <div key={label} className="bt-metric-cell">
                  <div className="bt-metric-label">{label}</div>
                  <div className="bt-metric-value" style={color ? { color } : {}}>{val}</div>
                </div>
              ))}
            </div>

            {/* Per-strategy comparison table */}
            {allStratLabels.length > 0 && (
              <div className="card" style={{ marginBottom: 10, padding: 0 }}>
                <div className="bt-feed-header">
                  <span className="bt-params-label" style={{ margin: 0 }}>Strategy Comparison</span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead>
                      <tr><th>Strategy</th><th>Capital</th><th>P&L</th><th>Return %</th><th>Trades</th><th>Win Rate</th></tr>
                    </thead>
                    <tbody>
                      {allStratLabels.filter(lbl => lbl !== COMBINED_LABEL).map(lbl => {
                        const st = instrStratStates[lbl];
                        const cap = st?.capital ?? initCap;
                        const pnl = cap - initCap;
                        const pct = initCap > 0 ? (pnl / initCap) * 100 : 0;
                        const trades = st?.closedTrades || [];
                        const wins = trades.filter(t => t.pnl >= 0).length;
                        return (
                          <tr key={lbl}>
                            <td style={{ fontSize: 11, fontWeight: 600 }}>{lbl}</td>
                            <td style={{ fontSize: 11 }}>{fmtRs(cap)}</td>
                            <td className={pnl >= 0 ? 'text-success' : 'text-danger'} style={{ fontWeight: 600, fontSize: 11 }}>{fmtRs(pnl)}</td>
                            <td className={pct >= 0 ? 'text-success' : 'text-danger'} style={{ fontSize: 11 }}>{pct.toFixed(2)}%</td>
                            <td style={{ fontSize: 11 }}>{trades.length}</td>
                            <td style={{ fontSize: 11 }}>{trades.length ? `${(wins/trades.length*100).toFixed(1)}%` : '—'}</td>
                          </tr>
                        );
                      })}
                      {instrStratStates[COMBINED_LABEL] && (() => {
                        const st = instrStratStates[COMBINED_LABEL];
                        const cap = st?.capital ?? initCap;
                        const pnl = cap - initCap;
                        const pct = initCap > 0 ? (pnl / initCap) * 100 : 0;
                        const trades = st?.closedTrades || [];
                        const wins = trades.filter(t => t.pnl >= 0).length;
                        return (
                          <tr style={{ borderTop: '2px solid rgba(139,92,246,0.4)', background: 'rgba(139,92,246,0.06)' }}>
                            <td style={{ fontSize: 11, fontWeight: 700 }}>
                              <span style={{ color: '#8b5cf6' }}>{COMBINED_LABEL}</span>
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 }}>score-switched</span>
                            </td>
                            <td style={{ fontSize: 11, fontWeight: 600 }}>{fmtRs(cap)}</td>
                            <td className={pnl >= 0 ? 'text-success' : 'text-danger'} style={{ fontWeight: 700, fontSize: 11 }}>{fmtRs(pnl)}</td>
                            <td className={pct >= 0 ? 'text-success' : 'text-danger'} style={{ fontSize: 11, fontWeight: 600 }}>{pct.toFixed(2)}%</td>
                            <td style={{ fontSize: 11 }}>{trades.length}</td>
                            <td style={{ fontSize: 11 }}>{trades.length ? `${(wins/trades.length*100).toFixed(1)}%` : '—'}</td>
                          </tr>
                        );
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Per-strategy detail — individual strategies first, Combined last */}
            {allStratLabels.filter(lbl => lbl !== COMBINED_LABEL).concat(instrStratStates[COMBINED_LABEL] ? [COMBINED_LABEL] : []).map(lbl => {
              const isCombined = lbl === COMBINED_LABEL;
              const st = instrStratStates[lbl];
              const trades = st?.closedTrades || [];
              return (
                <div key={lbl} style={isCombined ? { border: '1px solid rgba(139,92,246,0.3)', borderRadius: 8, marginBottom: 10, overflow: 'hidden' } : {}}>
                  {trades.length > 0 && (
                    <div className="card" style={{ marginBottom: 10, ...(isCombined ? { background: 'rgba(139,92,246,0.04)', marginBottom: 0, borderRadius: 0 } : {}) }}>
                      <div className="bt-params-label" style={{ marginBottom: 6, color: isCombined ? '#8b5cf6' : undefined }}>
                        Equity Curve — {lbl}
                        {isCombined && <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8, fontWeight: 400 }}>score-switched pool</span>}
                      </div>
                      <EquityCurve
                        trades={[...trades].reverse().map(t => ({ runningCapital: t.capitalAfter, pnl: t.pnl }))}
                      />
                    </div>
                  )}
                  <div className="card" style={{ padding: 0, marginBottom: isCombined ? 0 : 10, ...(isCombined ? { borderRadius: 0, background: 'rgba(139,92,246,0.02)' } : {}) }}>
                    <div className="bt-feed-header">
                      <span className="bt-params-label" style={{ margin: 0, color: isCombined ? '#8b5cf6' : undefined }}>Closed Trades — {lbl}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{trades.length} trade{trades.length !== 1 ? 's' : ''}</span>
                    </div>
                    {trades.length === 0
                      ? <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No closed trades yet.</div>
                      : (
                        <div style={{ overflowX: 'auto' }}>
                          <table>
                            <thead>
                              <tr>
                                <th>#</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Qty</th><th>P&L</th><th>Return %</th><th>Exit Reason</th>
                                {isCombined && <><th>Strategy</th><th>Score</th></>}
                                <th>Capital After</th>
                              </tr>
                            </thead>
                            <tbody>
                              {trades.map((t, i) => (
                                <tr key={i}>
                                  <td>{trades.length - i}</td>
                                  <td>
                                    {t.type === 'SHORT'
                                      ? <span style={{ fontSize: 10, fontWeight: 700, color: '#8b5cf6' }}>SHORT↓</span>
                                      : <span style={{ fontSize: 10, fontWeight: 700, color: '#22c55e' }}>LONG↑</span>}
                                  </td>
                                  <td><span className="mono-sm">{t.entryTime}</span><br/><span style={{ fontSize: 11 }}>{fmtRs(t.entryPrice)}</span></td>
                                  <td><span className="mono-sm">{t.exitTime}</span><br/><span style={{ fontSize: 11 }}>{fmtRs(t.exitPrice)}</span></td>
                                  <td>{t.qty}</td>
                                  <td className={t.pnl >= 0 ? 'text-success' : 'text-danger'} style={{ fontWeight: 600 }}>{fmtRs(t.pnl)}</td>
                                  <td className={t.pnlPct >= 0 ? 'text-success' : 'text-danger'}>{t.pnlPct.toFixed(2)}%</td>
                                  <td><span className={`bt-exit-badge bt-exit-${(t.exitReason||'SIGNAL').toLowerCase().replace(/_/g,'-')}`}>{t.exitReason||'SIGNAL'}</span></td>
                                  {isCombined && (
                                    <>
                                      <td style={{ fontSize: 10 }}>{t.sourceStrategy || '—'}</td>
                                      <td style={{ fontFamily: 'monospace', fontSize: 10,
                                        color: t.entryScore?.total >= 60 ? '#22c55e' : t.entryScore?.total >= 40 ? '#f59e0b' : '#ef4444' }}>
                                        {t.entryScore ? t.entryScore.total.toFixed(1) : '—'}
                                      </td>
                                    </>
                                  )}
                                  <td style={{ fontSize: 11 }}>{fmtRs(t.capitalAfter)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )
                    }
                  </div>
                </div>
              );
            })}
            {allStratLabels.length === 0 && (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                Connect live to start paper trading.
              </div>
            )}
          </>
        )}

        {/* ── Portfolio tab ── */}
        {rightTab === 'portfolio' && (
          <>
            {/* Capital breakdown per strategy */}
            <div className="card" style={{ marginBottom: 10, padding: 0 }}>
              <div className="bt-feed-header">
                <span className="bt-params-label" style={{ margin: 0 }}>Capital per Strategy</span>
              </div>
              {allStratLabels.length === 0
                ? <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Connect live to start paper trading.</div>
                : (
                  <div style={{ overflowX: 'auto' }}>
                    <table>
                      <thead>
                        <tr><th>Strategy</th><th>Initial</th><th>Current</th><th>P&L</th><th>Return %</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {allStratLabels.filter(lbl => lbl !== COMBINED_LABEL).map(lbl => {
                          const cap = instrStratStates[lbl]?.capital ?? initCap;
                          const pnl = cap - initCap;
                          const pct = initCap > 0 ? (pnl / initCap) * 100 : 0;
                          const hasOpen = !!instrStratStates[lbl]?.openPosition;
                          const halted  = dailyCapMap.current[instrKey(lbl)]?.halted || false;
                          return (
                            <tr key={lbl}>
                              <td style={{ fontSize: 11, fontWeight: 600 }}>{lbl}</td>
                              <td style={{ fontSize: 11 }}>{fmtRs(initCap)}</td>
                              <td style={{ fontSize: 11 }}>{fmtRs(cap)}</td>
                              <td className={pnl >= 0 ? 'text-success' : 'text-danger'} style={{ fontWeight: 600, fontSize: 11 }}>{fmtRs(pnl)}</td>
                              <td className={pct >= 0 ? 'text-success' : 'text-danger'} style={{ fontSize: 11 }}>{pct.toFixed(2)}%</td>
                              <td style={{ fontSize: 11 }}>
                                {halted  ? <span className="bt-exit-badge bt-exit-stop-loss">HALTED</span>
                                : hasOpen ? <span className="badge badge-success">IN POSITION</span>
                                :           <span className="badge badge-muted">IDLE</span>}
                              </td>
                            </tr>
                          );
                        })}
                        {instrStratStates[COMBINED_LABEL] && (() => {
                          const lbl = COMBINED_LABEL;
                          const cap = instrStratStates[lbl]?.capital ?? initCap;
                          const pnl = cap - initCap;
                          const pct = initCap > 0 ? (pnl / initCap) * 100 : 0;
                          const hasOpen = !!instrStratStates[lbl]?.openPosition;
                          return (
                            <tr style={{ borderTop: '2px solid rgba(139,92,246,0.4)', background: 'rgba(139,92,246,0.06)' }}>
                              <td style={{ fontSize: 11, fontWeight: 700, color: '#8b5cf6' }}>
                                {lbl}
                                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 6, fontWeight: 400 }}>score-switched</span>
                              </td>
                              <td style={{ fontSize: 11 }}>{fmtRs(initCap)}</td>
                              <td style={{ fontSize: 11, fontWeight: 600 }}>{fmtRs(cap)}</td>
                              <td className={pnl >= 0 ? 'text-success' : 'text-danger'} style={{ fontWeight: 700, fontSize: 11 }}>{fmtRs(pnl)}</td>
                              <td className={pct >= 0 ? 'text-success' : 'text-danger'} style={{ fontSize: 11, fontWeight: 600 }}>{pct.toFixed(2)}%</td>
                              <td style={{ fontSize: 11 }}>
                                {hasOpen ? <span className="badge badge-success">IN POSITION</span>
                                :          <span className="badge badge-muted">IDLE</span>}
                              </td>
                            </tr>
                          );
                        })()}
                      </tbody>
                    </table>
                  </div>
                )
              }
            </div>

            {/* Open positions — one card per strategy */}
            {allStratLabels.filter(lbl => instrStratStates[lbl]?.openPosition).length > 0 && (
              <div className="card" style={{ marginBottom: 10 }}>
                <h3 className="section-title" style={{ marginBottom: 10 }}>Open Positions</h3>
                {allStratLabels.filter(lbl => instrStratStates[lbl]?.openPosition).map(lbl => {
                  const isCombined = lbl === COMBINED_LABEL;
                  const pos  = instrStratStates[lbl].openPosition;
                  const ltp  = parseFloat(latestTick?.ltp || pos.entryPrice);
                  const uPnl = pos.type === 'SHORT' ? (pos.entryPrice - ltp) * pos.qty : (ltp - pos.entryPrice) * pos.qty;
                  const uPct = (uPnl / (pos.entryPrice * pos.qty)) * 100;
                  return (
                    <div key={lbl} className="bt-live-position-card" style={{ marginBottom: 8, ...(isCombined ? { border: '1px solid rgba(139,92,246,0.35)', background: 'rgba(139,92,246,0.06)' } : {}) }}>
                      <div className="bt-live-pos-row">
                        <span className="bt-metric-label">Strategy</span>
                        <span className="instance-type" style={isCombined ? { color: '#8b5cf6' } : {}}>{lbl}</span>
                        {isCombined && <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>score-switched</span>}
                        {pos.type === 'SHORT'
                          ? <span style={{ fontSize: 10, fontWeight: 700, color: '#8b5cf6', background: 'rgba(139,92,246,0.12)', borderRadius: 4, padding: '1px 5px', marginLeft: 4 }}>SHORT↓</span>
                          : <span style={{ fontSize: 10, fontWeight: 700, color: '#22c55e', background: 'rgba(34,197,94,0.12)', borderRadius: 4, padding: '1px 5px', marginLeft: 4 }}>LONG↑</span>}
                      </div>
                      <div className="bt-live-pos-row">
                        <span className="bt-metric-label">Entry</span>
                        <span>{fmtRs(pos.entryPrice)} × {pos.qty} @ {pos.entryTime}</span>
                      </div>
                      <div className="bt-live-pos-row">
                        <span className="bt-metric-label">LTP</span>
                        <span style={{ fontWeight: 700 }}>{latestTick ? fmtRs(ltp) : '—'}</span>
                      </div>
                      <div className="bt-live-pos-row">
                        <span className="bt-metric-label">Unrealised P&L</span>
                        <span style={{ color: uPnl >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                          {fmtRs(uPnl)} ({uPct.toFixed(2)}%)
                        </span>
                      </div>
                      {pos.slPrice && <div className="bt-live-pos-row"><span className="bt-metric-label">SL</span><span style={{ color: '#ef4444' }}>{fmtRs(pos.slPrice)}</span></div>}
                      {pos.tpPrice && <div className="bt-live-pos-row"><span className="bt-metric-label">TP</span><span style={{ color: '#22c55e' }}>{fmtRs(pos.tpPrice)}</span></div>}
                      {pos.regime && <div className="bt-live-pos-row"><span className="bt-metric-label">Regime</span><span className={`bt-regime-badge bt-regime-${pos.regime}`}>{pos.regime}</span></div>}
                      <button type="button" className="btn-danger btn-sm" style={{ marginTop: 8 }}
                        onClick={() => closePaperPosition(instrKey(lbl), ltp, 'MANUAL')}>
                        Close {lbl}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Strategy warmup status */}
            <div className="card">
              <h3 className="section-title" style={{ marginBottom: 10 }}>Strategy Warmup</h3>
              {strategies.filter(s => s.enabled).map(s => {
                const label = s.label || s.strategyType;
                const ev = evaluatorsRef.current[selectedInstrToken ? `${selectedInstrToken}::${label}` : label];
                const seen = ev?.candlesSeen || 0;
                const need = ev?.warmupNeeded || 1;
                const warmed = seen >= need;
                return (
                  <div key={label} className="bt-live-warmup-row">
                    <span className="instance-type" style={{ minWidth: 160 }}>{label}</span>
                    <div className="bt-live-warmup-bar-wrap">
                      <div className="bt-live-warmup-bar" style={{ width: `${Math.min(100, (seen/need)*100)}%`, background: warmed ? '#22c55e' : 'var(--accent)' }} />
                    </div>
                    <span style={{ fontSize: 11, color: warmed ? '#22c55e' : 'var(--text-muted)', minWidth: 80, textAlign: 'right' }}>
                      {warmed ? 'Ready' : `${seen}/${need}`}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ── Details tab ── */}
        {rightTab === 'details' && (() => {
          const stratLabels = strategies.filter(s => s.enabled).map(s => s.label || s.strategyType);

          function fmtAction(a) {
            const r = a.reason === 'STOP_LOSS'   ? 'Stop Loss hit'
                    : a.reason === 'TAKE_PROFIT' ? 'Take Profit hit'
                    : a.reason === 'SIGNAL'      ? 'Signal'
                    : a.reason || '';
            if (a.signal === 'SHORT')             return `Enter Short — ${a.strategy} @${Number(a.price).toFixed(2)}`;
            if (a.signal === 'BUY'  && !a.reason) return `Enter Long — ${a.strategy} @${Number(a.price).toFixed(2)}`;
            if (a.signal === 'BUY'  &&  a.reason) return `Exit Short — ${a.strategy} @${Number(a.price).toFixed(2)} [${r}]`;
            if (a.signal === 'SELL')               return `Exit Long — ${a.strategy} @${Number(a.price).toFixed(2)} [${r}]`;
            return `${a.signal} — ${a.strategy} @${Number(a.price).toFixed(2)}`;
          }

          function downloadCSV() {
            const q   = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
            const row = (...cols) => cols.map(q).join(',');
            const blank = '';
            const lines = [];
            const today = new Date().toISOString().slice(0, 10);

            // ── Instrument Details ─────────────────────────────────────
            lines.push(row('=== Instrument Details ==='));
            lines.push(row('Symbol','Exchange','Token','Interval','Mode','Date'));
            lines.push(row(selInstrConfig.symbol, selInstrConfig.exchange, selInstrConfig.instrumentToken, selInstrConfig.candleInterval, mode, today));
            lines.push(blank);

            // ── Strategies ────────────────────────────────────────────
            lines.push(row('=== Strategies ==='));
            lines.push(row('Name','Type','Allow Shorting'));
            strategies.filter(s => s.enabled).forEach(s => {
              lines.push(row(s.label || s.strategyType, s.strategyType, s.allowShorting ? 'Yes' : 'No'));
            });
            lines.push(blank);

            // ── Risk Management ───────────────────────────────────────
            if (riskConfig.enabled) {
              lines.push(row('=== Risk Management ==='));
              lines.push(row('Stop Loss %','Take Profit %','Max Risk Per Trade %','Cooldown Candles','Daily Loss Cap %'));
              lines.push(row(
                riskConfig.stopLossPct        || '—',
                riskConfig.takeProfitPct      || '—',
                riskConfig.maxRiskPerTradePct || '—',
                riskConfig.cooldownCandles    || '—',
                riskConfig.dailyLossCapPct    || '—',
              ));
              lines.push(blank);
            }

            // ── Market Regime Detection ───────────────────────────────
            if (regimeConfig.enabled) {
              lines.push(row('=== Market Regime Detection ==='));
              lines.push(row('ADX Period','ATR Period','ADX Trend Threshold','ATR Volatile %','ATR Compression %'));
              lines.push(row(
                regimeConfig.adxPeriod, regimeConfig.atrPeriod,
                regimeConfig.adxTrendThreshold, regimeConfig.atrVolatilePct, regimeConfig.atrCompressionPct,
              ));
              lines.push(blank);
            }

            // ── Pattern Confirmation ───────────────────────────────────
            if (patternConfig.enabled) {
              lines.push(row('=== Pattern Confirmation ==='));
              lines.push(row('Buy Confirm Patterns','Sell Confirm Patterns','Min Wick Ratio','Max Body %'));
              lines.push(row(
                (patternConfig.buyConfirmPatterns  || []).join('; ') || 'Any',
                (patternConfig.sellConfirmPatterns || []).join('; ') || 'Any',
                patternConfig.minWickRatio, patternConfig.maxBodyPct,
              ));
              lines.push(blank);
            }

            // ── Trading Rules ─────────────────────────────────────────
            if (rulesConfig.enabled) {
              const instrType = resolveInstrType(selInstrConfig.instrumentType, selInstrConfig.symbol, selInstrConfig.exchange);
              lines.push(row(`=== Trading Rules (${instrType}) ===`));
              lines.push(row('Rule','Enabled','Parameters'));
              if (instrType === 'STOCK') {
                const sr = rulesConfig.stocks;
                lines.push(row('No trade in RANGING regime',           sr.ranging_no_trade?.enabled        ? 'ON' : 'OFF', ''));
                lines.push(row('SHORT only in COMPRESSION regime',     sr.compression_short_only?.enabled  ? 'ON' : 'OFF', ''));
                lines.push(row('LONG quality gate',                    sr.long_quality_gate?.enabled       ? 'ON' : 'OFF',
                  sr.long_quality_gate?.enabled ? `Min Score: ${sr.long_quality_gate.scoreMin} | Max VWAP Ext: ${sr.long_quality_gate.vwapMaxPct}%` : ''));
                lines.push(row('No same-candle reversal',              sr.no_same_candle_reversal?.enabled ? 'ON' : 'OFF', ''));
              } else {
                const or = rulesConfig.options;
                lines.push(row('No trade in VOLATILE regime',                or.volatile_no_trade?.enabled       ? 'ON' : 'OFF', ''));
                lines.push(row('Disable SMA_CROSSOVER and BREAKOUT',         or.disable_sma_breakout?.enabled    ? 'ON' : 'OFF', ''));
                lines.push(row('Use only VWAP / LIQUIDITY / BOLLINGER',      or.use_only_specific?.enabled       ? 'ON' : 'OFF', ''));
                lines.push(row('No same-candle reversal',                    or.no_same_candle_reversal?.enabled ? 'ON' : 'OFF', ''));
                lines.push(row('Distrust scores driven by high volatility',  or.distrust_high_vol_score?.enabled ? 'ON' : 'OFF',
                  or.distrust_high_vol_score?.enabled ? `Max Vol Score: ${or.distrust_high_vol_score.volScoreMax}` : ''));
              }
              lines.push(blank);
            }

            // ── Score-Based Combined Pool ──────────────────────────────
            if (scoreConfig.enabled) {
              lines.push(row('=== Score-Based Combined Pool ==='));
              lines.push(row('Min Score Threshold'));
              lines.push(row(scoreConfig.minScoreThreshold));
              lines.push(blank);
            }

            // ── P&L Summary ───────────────────────────────────────────
            lines.push(row('=== P&L Summary ==='));
            lines.push(row('Strategy','Initial Capital','Final Capital','P&L','Return %','Total Trades','Wins','Losses','Win Rate %'));
            const liveInitCap = parseFloat(initialCapital) || 100000;
            const allLivePnlLabels = [...stratLabels, ...(instrStratStates[COMBINED_LABEL] ? [COMBINED_LABEL] : [])];
            allLivePnlLabels.forEach(lbl => {
              const st     = instrStratStates[lbl];
              const cap    = st?.capital ?? liveInitCap;
              const pnl    = cap - liveInitCap;
              const pct    = ((pnl / liveInitCap) * 100).toFixed(2);
              const trades = st?.closedTrades || [];
              const wins   = trades.filter(t => t.pnl >= 0).length;
              lines.push(row(lbl, liveInitCap.toFixed(2), cap.toFixed(2), pnl.toFixed(2), pct, trades.length, wins, trades.length - wins,
                trades.length ? ((wins / trades.length) * 100).toFixed(1) : '—'));
            });
            lines.push(blank);

            // ── Trade History ─────────────────────────────────────────
            lines.push(row('=== Trade History ==='));
            lines.push(row('Strategy','Direction','Entry Time','Exit Time','Qty',
              'Entry Price','Exit Price','P&L','P&L %','Exit Reason',
              ...(regimeConfig.enabled ? ['Regime'] : []),
              ...(scoreConfig.enabled  ? ['Selected Strategy','Entry Score'] : [])));
            allLivePnlLabels.forEach(lbl => {
              const isComb = lbl === COMBINED_LABEL;
              (instrStratStates[lbl]?.closedTrades || []).slice().reverse().forEach(t => {
                lines.push(row(
                  lbl, t.type || 'LONG', t.entryTime, t.exitTime, t.qty,
                  Number(t.entryPrice).toFixed(2), Number(t.exitPrice).toFixed(2),
                  Number(t.pnl).toFixed(2), Number(t.pnlPct ?? 0).toFixed(2),
                  t.exitReason === 'STOP_LOSS' ? 'Stop Loss hit' : t.exitReason === 'TAKE_PROFIT' ? 'Take Profit hit' : t.exitReason || 'Signal',
                  ...(regimeConfig.enabled ? [t.regime ?? ''] : []),
                  ...(scoreConfig.enabled  ? [isComb ? (t.sourceStrategy || '') : '', isComb && t.entryScore ? t.entryScore.total.toFixed(1) : ''] : []),
                ));
              });
            });
            lines.push(blank);

            // ── Candle Data ───────────────────────────────────────────
            lines.push(row('=== Candle Data ==='));
            const sigCols = stratLabels.map(l => `Signal_${l}`);
            lines.push(row('Time','Open','High','Low','Close','Volume',
              ...(regimeConfig.enabled ? ['Regime'] : []),
              ...sigCols, 'Strategy Actions', 'Blocked Signals', 'Combined Actions'));
            candleLogRef.current.forEach(r => {
              const combinedActionsStr = (r.combinedDetails || []).map(cd =>
                `${cd.action} @${Number(cd.price).toFixed(2)}` +
                (cd.sourceStrategy ? ` via ${cd.sourceStrategy}` : '') +
                (cd.regime         ? ` [${cd.regime}]`           : '') +
                ` · ${cd.reason}` +
                (cd.score ? ` · score=${cd.score.total.toFixed(1)}(trend=${cd.score.trendStrength.toFixed(0)},vol=${cd.score.volatility.toFixed(0)},mom=${cd.score.momentum.toFixed(0)},conf=${cd.score.confidence.toFixed(0)})` : '') +
                (cd.trigger ? ` · ${cd.trigger}` : '')
              ).join(' | ');
              const blockedStr = (r.blockedSignals || []).map(b =>
                `${b.strategy} ${b.signal} @${Number(b.price).toFixed(2)} — ${b.reason}`
              ).join(' | ');
              lines.push(row(
                r.ts,
                Number(r.open).toFixed(2), Number(r.high).toFixed(2),
                Number(r.low).toFixed(2), Number(r.close).toFixed(2),
                r.volume ?? '',
                ...(regimeConfig.enabled ? [r.regime ?? ''] : []),
                ...stratLabels.map(l => r.signals?.[l] ?? ''),
                r.actions.map(fmtAction).join(' | '),
                blockedStr,
                combinedActionsStr,
              ));
            });

            const csv  = lines.join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href = url; a.download = `live_${selInstrConfig.symbol || 'data'}_${today}.csv`; a.click();
            URL.revokeObjectURL(url);
          }

          // ── Feature summary cards ──────────────────────────────────
          const infoBlocks = [
            { label: 'Instrument', items: [
                `${selInstrConfig.symbol || '—'} · ${selInstrConfig.exchange || '—'}`,
                `Token: ${selInstrConfig.instrumentToken || '—'}`,
                `${selInstrConfig.candleInterval || '—'} · Mode: ${mode}`,
            ]},
            ...(riskConfig.enabled ? [{ label: 'Risk Management', items: [
                riskConfig.stopLossPct        ? `SL: ${riskConfig.stopLossPct}%`                 : null,
                riskConfig.takeProfitPct      ? `TP: ${riskConfig.takeProfitPct}%`               : null,
                riskConfig.maxRiskPerTradePct ? `Max Risk/Trade: ${riskConfig.maxRiskPerTradePct}%` : null,
                riskConfig.cooldownCandles    ? `Cooldown: ${riskConfig.cooldownCandles} candles` : null,
                riskConfig.dailyLossCapPct    ? `Daily Cap: ${riskConfig.dailyLossCapPct}%`       : null,
            ].filter(Boolean) }] : []),
            ...(regimeConfig.enabled ? [{ label: 'Regime Detection', items: [
                `ADX ${regimeConfig.adxPeriod}p · Trend ≥ ${regimeConfig.adxTrendThreshold}`,
                `ATR ${regimeConfig.atrPeriod}p · Volatile ≥ ${regimeConfig.atrVolatilePct}% · Compress ≤ ${regimeConfig.atrCompressionPct}%`,
            ] }] : []),
            ...(patternConfig.enabled ? [{ label: 'Pattern Confirmation', items: [
                `Buy: ${(patternConfig.buyConfirmPatterns||[]).join(', ') || 'Any'}`,
                `Sell: ${(patternConfig.sellConfirmPatterns||[]).join(', ') || 'Any'}`,
                `Wick ≥ ${patternConfig.minWickRatio} · Body ≤ ${patternConfig.maxBodyPct}%`,
            ] }] : []),
            ...(scoreConfig.enabled ? [{ label: 'Score-Based Pool', items: [
                `Min Score: ${scoreConfig.minScoreThreshold}`,
            ] }] : []),
            ...(rulesConfig.enabled ? (() => {
              const iType = resolveInstrType(selInstrConfig.instrumentType, selInstrConfig.symbol, selInstrConfig.exchange);
              const items = iType === 'STOCK' ? [
                rulesConfig.stocks.ranging_no_trade?.enabled        ? 'No trade in RANGING' : null,
                rulesConfig.stocks.compression_short_only?.enabled  ? 'SHORT only in COMPRESSION' : null,
                rulesConfig.stocks.long_quality_gate?.enabled       ? `LONG gate: score≥${rulesConfig.stocks.long_quality_gate.scoreMin} VWAP≤${rulesConfig.stocks.long_quality_gate.vwapMaxPct}%` : null,
                rulesConfig.stocks.no_same_candle_reversal?.enabled ? 'No same-candle reversal' : null,
              ].filter(Boolean) : [
                rulesConfig.options.volatile_no_trade?.enabled       ? 'No trade in VOLATILE' : null,
                rulesConfig.options.disable_sma_breakout?.enabled    ? 'SMA/BREAKOUT disabled' : null,
                rulesConfig.options.use_only_specific?.enabled       ? 'VWAP/LIQUIDITY/BOLLINGER only' : null,
                rulesConfig.options.no_same_candle_reversal?.enabled ? 'No same-candle reversal' : null,
                rulesConfig.options.distrust_high_vol_score?.enabled ? `Distrust vol score >${rulesConfig.options.distrust_high_vol_score.volScoreMax}` : null,
              ].filter(Boolean);
              return items.length ? [{ label: `Rules (${iType})`, items }] : [];
            })() : []),
          ];

          return (
            <div className="card" style={{ padding: 0 }}>
              <div className="bt-feed-header">
                <span className="bt-params-label" style={{ margin: 0 }}>Candle Details</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{candleLog.length} candles</span>
                  {candleLog.length > 0 && (
                    <button type="button" className="btn-secondary btn-xs" onClick={downloadCSV}>Download CSV</button>
                  )}
                </div>
              </div>

              {/* Feature summary */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                {infoBlocks.map(blk => (
                  <div key={blk.label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', minWidth: 160, flex: '1 1 160px' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>{blk.label}</div>
                    {blk.items.map((it, i) => <div key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{it}</div>)}
                  </div>
                ))}
              </div>

              {candleLog.length === 0
                ? <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Candle details will appear as candles close.</div>
                : (
                  <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead style={{ position: 'sticky', top: 0, background: 'var(--card-bg)', zIndex: 1 }}>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          {['Time','O','H','L','C','Vol',
                            ...(regimeConfig.enabled ? ['Regime'] : []),
                            ...stratLabels.map(l => l.length > 10 ? l.slice(0,10)+'…' : l),
                            'Actions'].map(h => (
                            <th key={h} style={{ padding: '5px 6px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[...candleLog].reverse().map((row, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: row.actions.length > 0 || row.combinedDetails?.length > 0 ? 'rgba(99,102,241,0.06)' : row.blockedSignals?.length > 0 ? 'rgba(245,158,11,0.04)' : undefined }}>
                            <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{row.ts}</td>
                            <td style={{ padding: '4px 6px' }}>{Number(row.open).toFixed(2)}</td>
                            <td style={{ padding: '4px 6px', color: '#22c55e' }}>{Number(row.high).toFixed(2)}</td>
                            <td style={{ padding: '4px 6px', color: '#ef4444' }}>{Number(row.low).toFixed(2)}</td>
                            <td style={{ padding: '4px 6px', fontWeight: 600 }}>{Number(row.close).toFixed(2)}</td>
                            <td style={{ padding: '4px 6px', color: 'var(--text-muted)' }}>{row.volume?.toLocaleString() ?? '—'}</td>
                            {regimeConfig.enabled && (
                              <td style={{ padding: '4px 6px' }}>
                                {row.regime
                                  ? <span className={`bt-regime-badge bt-regime-${row.regime}`}>{row.regime}</span>
                                  : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                              </td>
                            )}
                            {stratLabels.map(l => {
                              const sig = row.signals?.[l];
                              return (
                                <td key={l} style={{ padding: '4px 6px' }}>
                                  {sig === 'BUY'  ? <span style={{ color: '#22c55e', fontWeight: 700 }}>BUY</span>
                                  : sig === 'SELL' ? <span style={{ color: '#ef4444', fontWeight: 700 }}>SELL</span>
                                  : sig === 'SHORT'? <span style={{ color: '#8b5cf6', fontWeight: 700 }}>SHORT</span>
                                  : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                </td>
                              );
                            })}
                            <td style={{ padding: '4px 6px', minWidth: 260 }}>
                              {row.actions.map((a, ai) => {
                                const lbl     = fmtAction(a);
                                const isEnter = !a.reason;
                                const color   = a.signal === 'SHORT' ? '#8b5cf6' : isEnter ? '#22c55e' : '#ef4444';
                                return (
                                  <div key={ai} style={{ fontSize: 11, lineHeight: 1.6 }}>
                                    <span style={{ fontWeight: 700, color }}>{lbl.split(' —')[0]}</span>
                                    <span style={{ color: 'var(--text-muted)' }}>{' —' + lbl.split(' —').slice(1).join(' —')}</span>
                                  </div>
                                );
                              })}
                              {(row.blockedSignals || []).map((b, bi) => (
                                <div key={`b${bi}`} style={{ fontSize: 11, lineHeight: 1.6, color: '#f59e0b' }}>
                                  <span style={{ fontWeight: 700 }}>⊘ {b.strategy} {b.signal}</span>
                                  <span style={{ color: '#a16207' }}> — {b.reason}</span>
                                </div>
                              ))}
                              {(row.combinedDetails || []).map((cd, ci) => {
                                const isEnter = cd.action.startsWith('Enter');
                                const color   = cd.action.includes('Short') ? '#8b5cf6' : isEnter ? '#22c55e' : '#ef4444';
                                return (
                                  <div key={'c'+ci} style={{ fontSize: 11, lineHeight: 1.6, borderTop: ci === 0 && (row.actions.length > 0 || row.blockedSignals?.length > 0) ? '1px dashed var(--border)' : undefined, marginTop: ci === 0 && (row.actions.length > 0 || row.blockedSignals?.length > 0) ? 3 : 0, paddingTop: ci === 0 && (row.actions.length > 0 || row.blockedSignals?.length > 0) ? 3 : 0 }}>
                                    <span style={{ fontWeight: 700, color: '#8b5cf6', fontSize: 10 }}>⚡</span>
                                    {' '}<span style={{ fontWeight: 700, color }}>{cd.action}</span>
                                    {' '}<span style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                                      @{Number(cd.price).toFixed(2)}
                                      {cd.sourceStrategy ? ` · via ${cd.sourceStrategy}` : ''}
                                      {cd.regime ? ` · ${cd.regime}` : ''}
                                      {' · '}{cd.reason}
                                      {cd.score ? ` · score=${cd.score.total.toFixed(1)} (trend=${cd.score.trendStrength.toFixed(0)} vol=${cd.score.volatility.toFixed(0)} mom=${cd.score.momentum.toFixed(0)} conf=${cd.score.confidence.toFixed(0)})` : ''}
                                      {cd.trigger ? <span style={{ color: cd.trigger?.startsWith('Score') ? '#6366f1' : cd.trigger === 'Risk Management' ? '#f59e0b' : 'var(--text-muted)' }}> · {cd.trigger}</span> : null}
                                    </span>
                                  </div>
                                );
                              })}
                              {row.actions.length === 0 && !row.blockedSignals?.length && (row.combinedDetails || []).length === 0 && (
                                <span style={{ color: 'var(--text-muted)' }}>—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              }
            </div>
          );
        })()}

        </div>{/* end bt-live-feed */}
      </div>{/* end bt-live-top-row */}

      {/* ── Bottom: Strategies (full width) ──────────────────────────── */}
      <div className="card bt-live-strategies-row">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 className="section-title" style={{ margin: 0 }}>Strategies</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className={`btn-sm ${strategies.every(s => s.allowShorting) ? 'btn-secondary' : 'btn-muted'}`}
              style={{ fontSize: 11 }} onClick={toggleMasterShorting} disabled={connected}>
              Short {strategies.every(s => s.allowShorting) ? 'ON' : 'OFF'}
            </button>
            <button type="button" disabled={connected}
              onClick={() => setCombinedOnlyMode(m => !m)}
              title="When ON: individual strategies only compute signals for the ⚡ Combined pool — they don't trade independently"
              style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12, border: '1px solid', cursor: 'pointer',
                background:   combinedOnlyMode ? 'rgba(234,179,8,0.15)'  : 'transparent',
                color:        combinedOnlyMode ? '#ca8a04'               : 'var(--text-muted)',
                borderColor:  combinedOnlyMode ? 'rgba(234,179,8,0.4)'   : 'var(--border)' }}>
              {combinedOnlyMode ? '⚡ Combined Only' : 'All Strategies'}
            </button>
            {!connected && <button type="button" className="btn-secondary btn-sm" onClick={addStrategy}>+ Add</button>}
          </div>
        </div>
        <div className="bt-live-strategies-grid">
          {strategies.map((s, idx) => {
            const pdefs = PARAM_DEFS[s.strategyType] || [];
            return (
              <div key={idx} className={`bt-strategy-card ${s.enabled ? '' : 'bt-strategy-disabled'}`}>
                <div className="bt-strategy-header">
                  <label className="checkbox-label" style={{ margin: 0, fontWeight: 600 }}>
                    <input type="checkbox" checked={s.enabled} disabled={connected}
                      onChange={e => updateStrategy(idx, 'enabled', e.target.checked)} />
                    <select value={s.strategyType} disabled={connected} onChange={e => updateStrategy(idx, 'strategyType', e.target.value)}
                      className="bt-strategy-type-sel">
                      {knownTypes.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </label>
                  {strategies.length > 1 && !connected &&
                    <button type="button" className="btn-danger btn-xs" onClick={() => removeStrategy(idx)}>✕</button>}
                </div>
                {pdefs.length > 0 && s.enabled && (
                  <div className="bt-params-block" style={{ marginTop: 6 }}>
                    {pdefs.map(def => (
                      <div className="bt-param-row" key={def.key}>
                        <label className="bt-param-label">{def.label}</label>
                        <input type="number" min="1" className="bt-param-input"
                          value={s.parameters?.[def.key] || ''} disabled={connected}
                          onChange={e => updateStrategyParam(idx, def.key, e.target.value)}
                          placeholder={def.placeholder} />
                        <span className="bt-param-hint">{def.hint}</span>
                      </div>
                    ))}
                  </div>
                )}
                {s.enabled && (
                  <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <label className="checkbox-label" style={{ fontSize: 11, margin: 0 }}>
                      <input type="checkbox" checked={!!s.allowShorting} disabled={connected}
                        onChange={e => updateStrategy(idx, 'allowShorting', e.target.checked)} />
                      Allow Short
                    </label>
                    {regimeConfig.enabled && (
                      <>
                        <span className="bt-regime-auto-tag">auto</span>
                        {(STRATEGY_REGIME_MAP[s.strategyType] || []).map(r => (
                          <span key={r} className={`bt-regime-badge bt-regime-${r}`}>{r}</span>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function signalBadge(signal) {
  const s = (signal || '').toUpperCase();
  if (s === 'BUY')   return <span className="badge badge-success">BUY</span>;
  if (s === 'SELL')  return <span className="badge badge-danger">SELL</span>;
  if (s === 'SHORT') return <span className="badge" style={{ background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.3)', borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700 }}>SHORT↓</span>;
  return <span className="badge badge-muted">HOLD</span>;
}

// ─── Backtest Result Panel ────────────────────────────────────────────────────

// Convert "YYYY-MM-DDTHH:mm:ss" (IST LocalDateTime) → Unix seconds for lightweight-charts.
// lightweight-charts displays timestamps as UTC, so we parse the IST string as-if UTC
// so the chart axis shows the correct IST clock time (e.g. 09:15, not 03:45).
function toUtcSec(localDT) {
  if (!localDT) return 0;
  return Math.floor(new Date(localDT + 'Z').getTime() / 1000);
}

// ─── Equity Curve (portfolio overview) ───────────────────────────────────────

function EquityCurve({ trades, selectedTradeIdx, onSelectTrade }) {
  const W = 720, H = 180, PAD = { top: 14, right: 16, bottom: 28, left: 72 };
  const iW = W - PAD.left - PAD.right;
  const iH = H - PAD.top  - PAD.bottom;

  if (!trades || trades.length === 0) return null;

  const initCap = trades[0].runningCapital - trades[0].pnl;
  const points = [{ cap: initCap, trade: null },
    ...trades.map((t, i) => ({ cap: t.runningCapital, trade: t, idx: i }))];

  const caps = points.map(p => p.cap);
  const minC = Math.min(...caps), maxC = Math.max(...caps);
  const range = maxC - minC || 1;

  const xOf = i => PAD.left + (i / (points.length - 1)) * iW;
  const yOf = c => PAD.top  + iH - ((c - minC) / range) * iH;

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p.cap).toFixed(1)}`).join(' ');
  const fillPath = `${path} L${xOf(points.length - 1).toFixed(1)},${(PAD.top + iH).toFixed(1)} L${PAD.left.toFixed(1)},${(PAD.top + iH).toFixed(1)} Z`;

  const yTicks = 3;
  const fmtCap = v => '₹' + (v >= 1e5 ? (v / 1e5).toFixed(1) + 'L' : v.toFixed(0));

  return (
    <div className="bt-equity-wrap">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="bt-equity-svg">
        <defs>
          <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        <path d={fillPath} fill="url(#eqGrad)" />
        <line x1={PAD.left} y1={yOf(initCap).toFixed(1)} x2={PAD.left + iW} y2={yOf(initCap).toFixed(1)}
          stroke="#444" strokeWidth="1" strokeDasharray="4 3" />
        {Array.from({ length: yTicks + 1 }, (_, k) => {
          const val = minC + (range * k / yTicks);
          const y = yOf(val);
          return (
            <g key={k}>
              <line x1={PAD.left - 4} y1={y} x2={PAD.left} y2={y} stroke="#555" strokeWidth="1" />
              <text x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#888">{fmtCap(val)}</text>
            </g>
          );
        })}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
        {/* Selected highlight */}
        {selectedTradeIdx != null && (() => {
          const pi = selectedTradeIdx + 1;
          const x = xOf(pi);
          const t = trades[selectedTradeIdx];
          return (
            <g>
              <line x1={x} y1={PAD.top} x2={x} y2={PAD.top + iH}
                stroke="#fff" strokeWidth="1" strokeDasharray="3 3" strokeOpacity="0.4" />
              <circle cx={x} cy={yOf(t.runningCapital)} r={7}
                fill={t.pnl >= 0 ? 'var(--success)' : 'var(--danger)'} stroke="#fff" strokeWidth="2" />
            </g>
          );
        })()}
        {/* Trade dots */}
        {points.slice(1).map((p, i) => {
          const sel = selectedTradeIdx === i;
          return (
            <circle key={i} cx={xOf(i + 1)} cy={yOf(p.cap)} r={sel ? 0 : 3.5}
              fill={p.trade.pnl >= 0 ? 'var(--success)' : 'var(--danger)'}
              stroke="#1a1a2e" strokeWidth="1" style={{ cursor: 'pointer' }}
              onClick={() => onSelectTrade(i)} />
          );
        })}
        <text x={PAD.left + iW / 2} y={H - 4} textAnchor="middle" fontSize="10" fill="#555">← click a dot to view trade chart →</text>
      </svg>
    </div>
  );
}

// ─── OHLC Candlestick Chart (TradingView lightweight-charts) ─────────────────

function TradeChart({ candles, trades, selectedTradeIdx }) {
  const containerRef  = useRef(null);
  const chartRef      = useRef(null);
  const seriesRef     = useRef(null);
  const markersRef    = useRef(null);
  const priceLineSeriesRef = useRef([]);

  // Build markers array from all trades
  function buildMarkers(trds, selIdx) {
    const markers = [];
    trds.forEach((t, i) => {
      const sel  = i === selIdx;
      const win  = t.pnl >= 0;
      // Win trade: green markers — Loss trade: red markers
      const baseColor = win ? '#22c55e' : '#ef4444';
      const selColor  = win ? '#86efac' : '#fca5a5';
      const color = sel ? selColor : baseColor;
      const label = win ? (sel ? `W #${i + 1}` : 'W') : (sel ? `L #${i + 1}` : 'L');
      if (t.entryTime) {
        markers.push({
          time:     toUtcSec(t.entryTime),
          position: 'belowBar',
          color,
          shape:    'arrowUp',
          text:     label,
          size:     sel ? 2 : 1,
        });
      }
      if (t.exitTime) {
        markers.push({
          time:     toUtcSec(t.exitTime),
          position: 'aboveBar',
          color,
          shape:    'arrowDown',
          text:     label,
          size:     sel ? 2 : 1,
        });
      }
    });
    return markers.sort((a, b) => a.time - b.time);
  }

  // Create chart on mount
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      height: 480,
      layout: {
        background: { color: '#0d0d1a' },
        textColor:  '#9ca3af',
      },
      grid: {
        vertLines: { color: '#1a1a2e' },
        horzLines: { color: '#1a1a2e' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2d2d4e' },
      timeScale: {
        borderColor:    '#2d2d4e',
        timeVisible:    true,
        secondsVisible: false,
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor:        '#22c55e',
      downColor:      '#ef4444',
      borderUpColor:  '#22c55e',
      borderDownColor:'#ef4444',
      wickUpColor:    '#22c55e',
      wickDownColor:  '#ef4444',
    });

    chartRef.current  = chart;
    seriesRef.current = series;

    const onResize = () => {
      if (containerRef.current)
        chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); chart.remove(); };
  }, []);

  // Load candle data
  useEffect(() => {
    if (!seriesRef.current || !candles?.length) return;
    const data = candles
      .map(c => ({
        time:  toUtcSec(c.openTime),
        open:  parseFloat(c.open),
        high:  parseFloat(c.high),
        low:   parseFloat(c.low),
        close: parseFloat(c.close),
      }))
      .sort((a, b) => a.time - b.time);
    seriesRef.current.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // Update markers + price lines + scroll when trades or selection changes
  useEffect(() => {
    if (!seriesRef.current || !trades?.length) return;

    // Remove old markers
    if (markersRef.current) {
      markersRef.current.setMarkers([]);
      markersRef.current = null;
    }

    // Remove old price line series
    priceLineSeriesRef.current.forEach(s => chartRef.current?.removeSeries(s));
    priceLineSeriesRef.current = [];

    const markers = buildMarkers(trades, selectedTradeIdx);
    markersRef.current = createSeriesMarkers(seriesRef.current, markers);

    // Add short horizontal price line segments for selected trade
    if (selectedTradeIdx != null) {
      const t   = trades[selectedTradeIdx];
      const win = t.pnl >= 0;
      const color = win ? '#22c55e' : '#ef4444';

      const ivSec = candles?.length >= 2
        ? toUtcSec(candles[1].openTime) - toUtcSec(candles[0].openTime)
        : 300;
      const halfSpan = ivSec * 6; // line spans ±6 candles around the point

      function addShortLine(price, time, style, label) {
        if (price == null || time == null) return;
        const t0 = time - halfSpan;
        const t1 = time + halfSpan;
        const s = chartRef.current.addSeries(LineSeries, {
          color,
          lineWidth:              1,
          lineStyle:              style,
          priceLineVisible:       false,
          lastValueVisible:       false,
          crosshairMarkerVisible: false,
        });
        s.setData([
          { time: t0, value: parseFloat(price) },
          { time: t1, value: parseFloat(price) },
        ]);
        // Attach a price label via a price line on the segment series
        s.createPriceLine({
          price:            parseFloat(price),
          color,
          lineWidth:        0,
          lineStyle:        LineStyle.Solid,
          axisLabelVisible: true,
          title:            label,
        });
        priceLineSeriesRef.current.push(s);
      }

      addShortLine(t.entryPrice, toUtcSec(t.entryTime), LineStyle.Dashed,
        `Entry ₹${Number(t.entryPrice).toFixed(2)}`);
      addShortLine(t.exitPrice,  toUtcSec(t.exitTime),  LineStyle.Dotted,
        `Exit  ₹${Number(t.exitPrice).toFixed(2)}`);

      // Scroll to trade window
      if (t.entryTime) {
        const from = toUtcSec(t.entryTime) - ivSec * 40;
        const to   = toUtcSec(t.exitTime || t.entryTime) + ivSec * 20;
        chartRef.current?.timeScale().setVisibleRange({ from, to });
      }
    }
  }, [trades, selectedTradeIdx, candles]);

  return <div ref={containerRef} className="bt-tradechart-container" />;
}

function BacktestResultPanel({ result, session, instrumentToken }) {
  const [selectedIdx,      setSelectedIdx]      = useState(0);
  const [selectedTradeIdx, setSelectedTradeIdx] = useState(null);
  const [chartCandles,     setChartCandles]     = useState(null);
  const [chartLoading,     setChartLoading]     = useState(false);
  const [chartError,       setChartError]       = useState('');
  const selected = result.results[selectedIdx];

  // Fetch the full candle dataset for the backtest period once
  useEffect(() => {
    if (!session?.userId || !instrumentToken) return;
    let cancelled = false;
    setChartCandles(null);
    setChartError('');
    setChartLoading(true);
    fetchHistoricalData({
      userId:          session.userId,
      brokerName:      session.brokerName || 'kite',
      instrumentToken: parseInt(instrumentToken, 10),
      symbol:          result.symbol,
      exchange:        result.exchange,
      interval:        result.interval,
      fromDate:        result.fromDate,
      toDate:          result.toDate,
      persist:         false,
    })
      .then(res => { if (!cancelled) setChartCandles(res?.data || []); })
      .catch(e  => { if (!cancelled) setChartError(e.message); })
      .finally(()=> { if (!cancelled) setChartLoading(false); });
    return () => { cancelled = true; };
  }, [result]);

  function switchStrategy(i) {
    setSelectedIdx(i);
    setSelectedTradeIdx(null);
  }

  function selectTrade(i) {
    setSelectedTradeIdx(prev => prev === i ? null : i);
  }

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
                const isRegimeSwitched = r.strategyType === 'REGIME_SWITCHED';
                const isScoreSwitched  = r.strategyType === 'SCORE_SWITCHED';
                const isCombinedType   = isRegimeSwitched || isScoreSwitched;
                return (
                  <tr key={i} className={`bt-row ${i === selectedIdx ? 'bt-row-selected' : ''} ${isBest ? 'bt-row-best' : ''} ${isCombinedType ? 'bt-row-regime-switched' : ''}`}
                    onClick={() => switchStrategy(i)} style={{ cursor: 'pointer' }}>
                    <td>{isBest && <span className="best-star">★</span>}{isCombinedType && <span className="bt-regime-combined-star">{isScoreSwitched ? '🎯' : '⚡'}</span>}</td>
                    <td style={{ fontWeight: 600 }}>{r.label}</td>
                    <td>{isCombinedType
                      ? <span className="bt-regime-combined-badge">{isScoreSwitched ? 'Score Combined' : 'Combined'}</span>
                      : <span className="instance-type">{r.strategyType}</span>
                    }</td>
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
        {result.results.some(r => r.strategyType === 'REGIME_SWITCHED') && (
          <div className="bt-regime-combined-hint">
            <span className="bt-regime-combined-badge" style={{ marginRight: 6 }}>⚡ Combined</span>
            The highlighted row uses a single capital pool that switches strategies based on the detected market regime.
          </div>
        )}
        {result.results.some(r => r.strategyType === 'SCORE_SWITCHED') && (
          <div className="bt-regime-combined-hint">
            <span className="bt-regime-combined-badge" style={{ marginRight: 6 }}>🎯 Score Combined</span>
            The highlighted row uses a single capital pool — the scorer picks the highest-quality strategy per candle using quality penalties (reversal, overextension, same-color, instrument mismatch, volatile option).
          </div>
        )}
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
              ...(selected.metrics.stopLossExits > 0 || selected.metrics.takeProfitExits > 0 ? [
                ['SL Exits',       selected.metrics.stopLossExits],
                ['TP Exits',       selected.metrics.takeProfitExits],
                ['Daily Cap Halts',selected.metrics.dailyCapHalts],
              ] : []),
              ...(selected.trades?.some(t => t.regime) ? (() => {
                const counts = {};
                REGIMES.forEach(r => { counts[r] = 0; });
                selected.trades.forEach(t => { if (t.regime) counts[t.regime] = (counts[t.regime] || 0) + 1; });
                return REGIMES.filter(r => counts[r] > 0).map(r => [`Trades (${r})`, counts[r]]);
              })() : []),
            ].map(([label, val]) => (
              <div key={label} className="bt-metric-cell">
                <span className="bt-metric-label">{label}</span>
                <span className="bt-metric-val">{val}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* OHLC Chart */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="bt-chart-header">
          <h3 className="section-title" style={{ margin: 0 }}>
            Price Chart — {result.symbol} / {result.exchange}
            <span className="instance-type" style={{ marginLeft: 8 }}>{result.interval}</span>
          </h3>
          {selectedTradeIdx != null && selected?.trades?.[selectedTradeIdx] && (() => {
            const t = selected.trades[selectedTradeIdx];
            const win = t.pnl >= 0;
            return (
              <div className="bt-chart-trade-badge">
                <span>Trade #{selectedTradeIdx + 1}</span>
                <span className={win ? 'text-success' : 'text-danger'} style={{ fontWeight: 700 }}>
                  {win ? '+' : ''}₹{Number(t.pnl).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
                <span>Entry ₹{Number(t.entryPrice).toFixed(2)} → Exit ₹{Number(t.exitPrice).toFixed(2)}</span>
                <span className="bt-chart-hint">Scroll/pinch to zoom · drag to pan</span>
                <button className="bt-chart-reset-btn" onClick={() => setSelectedTradeIdx(null)}>Show all</button>
              </div>
            );
          })()}
          {selectedTradeIdx == null && (
            <span className="bt-chart-hint">Click a trade row below to zoom in</span>
          )}
        </div>

        {chartLoading && <div className="field-hint" style={{ padding: '24px 0', textAlign: 'center' }}>Fetching candle data…</div>}
        {chartError   && <div className="error-msg" style={{ margin: '12px 0' }}>{chartError}</div>}
        {!chartLoading && !chartError && chartCandles && (
          <TradeChart
            candles={chartCandles}
            trades={selected?.trades || []}
            selectedTradeIdx={selectedTradeIdx}
          />
        )}

        {/* Equity curve below chart */}
        {selected?.trades?.length > 0 && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div className="field-hint" style={{ marginBottom: 4 }}>Equity curve — click a dot to highlight trade on chart</div>
            <EquityCurve
              trades={selected.trades}
              selectedTradeIdx={selectedTradeIdx}
              onSelectTrade={selectTrade}
            />
          </div>
        )}
      </div>

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
                  <th>PnL</th><th>Return %</th><th>Exit</th><th>Regime</th>
                  {selected.strategyType === 'SCORE_SWITCHED' && <><th>Strategy</th><th>Score</th></>}
                  <th>Patterns</th><th>Capital After</th>
                </tr>
              </thead>
              <tbody>
                {selected.trades.map((t, i) => (
                  <tr key={i}
                    className={`${t.pnl >= 0 ? 'trade-win' : 'trade-loss'} ${selectedTradeIdx === i ? 'bt-trade-row-selected' : ''}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => selectTrade(i)}>
                    <td className="mono-sm">{i + 1}</td>
                    <td className="mono-sm">{t.entryTime ? new Date(t.entryTime).toLocaleString() : '—'}</td>
                    <td className="mono-sm">{t.exitTime  ? new Date(t.exitTime).toLocaleString()  : '—'}</td>
                    <td>{fmtRs(t.entryPrice)}</td>
                    <td>{fmtRs(t.exitPrice)}</td>
                    <td>{t.quantity}</td>
                    <td className={t.pnl >= 0 ? 'text-success' : 'text-danger'} style={{ fontWeight: 600 }}>{fmtRs(t.pnl)}</td>
                    <td className={t.pnlPct >= 0 ? 'text-success' : 'text-danger'}>{fmt(t.pnlPct)}%</td>
                    <td><span className={`bt-exit-badge bt-exit-${(t.exitReason || 'SIGNAL').toLowerCase().replace('_', '-')}`}>{t.exitReason || 'SIGNAL'}</span></td>
                    <td>
                      {t.regime
                        ? <span className={`bt-regime-badge bt-regime-${t.regime}`}>{t.regime}</span>
                        : <span className="bt-pattern-none">—</span>}
                    </td>
                    {selected.strategyType === 'SCORE_SWITCHED' && (
                      <>
                        <td>
                          {t.selectedStrategy
                            ? <span className="instance-type" style={{ fontSize: 10 }}>{t.selectedStrategy}</span>
                            : <span className="bt-pattern-none">—</span>}
                        </td>
                        <td>
                          {t.scoreBreakdown
                            ? <span title={`base=${fmt(t.scoreBreakdown.baseScore)} trend=${fmt(t.scoreBreakdown.trendStrength)} vol=${fmt(t.scoreBreakdown.volatilityScore)} mom=${fmt(t.scoreBreakdown.momentumScore)} pen=${fmt(t.scoreBreakdown.totalPenalty)}`}
                                style={{ cursor: 'help', fontFamily: 'monospace', fontSize: 11,
                                  color: t.scoreBreakdown.total >= 60 ? '#22c55e' : t.scoreBreakdown.total >= 40 ? '#f59e0b' : '#ef4444' }}>
                                {fmt(t.scoreBreakdown.total)}
                              </span>
                            : <span className="bt-pattern-none">—</span>}
                        </td>
                      </>
                    )}
                    <td className="bt-patterns-cell">
                      {t.entryPatterns && t.entryPatterns.length > 0
                        ? t.entryPatterns.map(p => (
                            <span key={p} className="bt-pattern-badge">{PATTERN_LABELS[p] || p}</span>
                          ))
                        : <span className="bt-pattern-none">—</span>}
                    </td>
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

// ─── Tab 4: Options Replay Test ────────────────────────────────────────────────

const EMPTY_OPTION_INST = () => ({
  id: Date.now() + Math.random(),
  symbol: '', exchange: 'NFO', instrumentToken: '',
});

const OPT_INTERVALS = [
  ['MINUTE_1','1 min'],['MINUTE_3','3 min'],['MINUTE_5','5 min'],['MINUTE_10','10 min'],
  ['MINUTE_15','15 min'],['MINUTE_30','30 min'],['MINUTE_60','60 min'],['DAY','Day'],
];

const DEFAULT_DECISION = {
  minScore: '40', minScoreGap: '8', maxRecentMove3: '1.5', maxRecentMove5: '2.5',
  maxAbsVwapDist: '1.5', minBarsSinceTrade: '3', chopFilter: true, chopLookback: '8',
  penaltyMinScore: '25',
};
const DEFAULT_SELECTION = { minPremium: '50', maxPremium: '300' };
const DEFAULT_SWITCH    = { switchConfirmationCandles: '2', maxSwitchesPerDay: '3', minScoreImprovementForSwitch: '0' };
const DEFAULT_REGIME_RULES = {
  enabled: true,
  rangingMinScore: '35',    rangingMinScoreGap: '6',
  trendingMinScore: '25',   trendingMinScoreGap: '3',
  compressionMinScore: '25', compressionMinScoreGap: '3',
};
const DEFAULT_OPTS_REGIME_CONFIG = {
  enabled: false,
  adxPeriod: 14,
  atrPeriod: 14,
  adxTrendThreshold: 25,
  atrVolatilePct: 2.0,
  atrCompressionPct: 0.5,
};
const DEFAULT_CHOP_RULES = {
  enabled: false,
  ranging:     { filterEnabled: true,  flipRatio: '0.65' },
  trending:    { filterEnabled: false, flipRatio: '0.65' },
  compression: { filterEnabled: false, flipRatio: '0.65' },
  volatile:    { filterEnabled: true,  flipRatio: '0.80' },
};
const DEFAULT_TRADING_RULES = {
  enabled: false,
  rangingNoTrade:       false,
  volatileNoTrade:      false,
  noSameCandleReversal: false,
};
const DEFAULT_REGIME_STRATEGY_RULES = {
  enabled: false,
  ranging:     { enabled: false, allowed: [] },
  trending:    { enabled: false, allowed: [] },
  compression: { enabled: false, allowed: [] },
  volatile:    { enabled: false, allowed: [] },
};
const DEFAULT_OPTS_RISK = {
  enabled: false,
  stopLossPct:        '2',
  takeProfitPct:      '4',
  maxRiskPerTradePct: '1',
  dailyLossCapPct:    '5',
  cooldownCandles:    '3',
};
const DEFAULT_RANGE_QUALITY = {
  enabled: false,
  lookbackBars:                  '10',
  minUpperTouches:               '2',
  minLowerTouches:               '2',
  bandTouchTolerancePct:         '0.15',
  minRangeWidthPct:              '0.4',
  maxRangeWidthPct:              '2.0',
  maxDirectionalDriftPctOfRange: '0.6',
  chopFlipRatioLimit:            '0.65',
  enableChopCheck:               true,
};
const DEFAULT_TRADE_QUALITY = {
  enabled: false,
  strongScoreThreshold:  '40',
  normalScoreThreshold:  '32',
  weakTradeLossCooldown: '5',
  blockWeakInRanging:    true,
  rangingConfirmCandles: '3',
  trendingConfirmCandles:'2',
};
const DEFAULT_TREND_ENTRY = {
  enabled:         false,
  breakoutLookback:'5',
  minBodyPct:      '60',
  weakBodyPct:     '30',
  ema9Period:      '9',
};
const DEFAULT_COMPRESSION_ENTRY = {
  enabled:              false,
  rangeLookback:        '10',
  longZoneMax:          '0.2',
  shortZoneMin:         '0.8',
  noTradeZoneMin:       '0.4',
  noTradeZoneMax:       '0.6',
  rejectBreakoutCandle: true,
};
const DEFAULT_HOLD = {
  enabled:             true,
  defaultMinHoldBars:  '3',
  rangingMinHoldBars:  '4',
  trendingMinHoldBars: '2',
  strongOppositeScore: '35',
  persistentExitBars:  '2',
};

function fmt2(v) { return v != null ? Number(v).toFixed(2) : '—'; }
function pnlStyle(v) { return { color: v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : undefined, fontWeight: 600 }; }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeEma(closes, period) {
  if (!closes.length || period < 1) return [];
  const k = 2 / (period + 1);
  const out = new Array(closes.length);
  out[0] = closes[0];
  for (let i = 1; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

// ─── ReplayChart component ────────────────────────────────────────────────────
//
// Plots NIFTY price data from the SSE feed with:
//   • Candlestick series
//   • EMA 9 / EMA 21 lines
//   • VWAP line (reconstructed from distanceFromVwap + close)
//   • Regime background shading via colored area bands
//   • Bias-change markers (arrow when confirmedBias switches)
//   • CE/PE trade entry ▲ / exit ▼ markers, coloured by win/loss
//   • Trade entry/exit price lines for active (selected) trade
//
function ReplayChart({ feed, closedTrades }) {
  const containerRef = useRef(null);
  const chartRef     = useRef(null);
  const candleRef    = useRef(null);
  const ema9Ref      = useRef(null);
  const ema21Ref     = useRef(null);
  const vwapRef      = useRef(null);
  const regimeBandRefs = useRef([]);
  const markersRef   = useRef(null);
  const tradeLinesRef = useRef([]);

  const [showEma9,   setShowEma9]   = useState(true);
  const [showEma21,  setShowEma21]  = useState(true);
  const [showVwap,   setShowVwap]   = useState(true);
  const [showRegime, setShowRegime] = useState(true);
  const [selectedTradeIdx, setSelectedTradeIdx] = useState(null);

  const REGIME_LINE_COLORS = {
    RANGING:     '#f59e0b',
    TRENDING:    '#22c55e',
    COMPRESSION: '#8b5cf6',
    VOLATILE:    '#ef4444',
  };

  // ── Create chart once ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      height: 520,
      layout: { background: { color: '#0d0d1a' }, textColor: '#9ca3af' },
      grid:   { vertLines: { color: '#1a1a2e' }, horzLines: { color: '#1a1a2e' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#2d2d4e' },
      timeScale: { borderColor: '#2d2d4e', timeVisible: true, secondsVisible: false },
    });

    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    });

    ema9Ref.current = chart.addSeries(LineSeries, {
      color: '#f59e0b', lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
      title: 'EMA9',
    });
    ema21Ref.current = chart.addSeries(LineSeries, {
      color: '#8b5cf6', lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
      title: 'EMA21',
    });
    vwapRef.current = chart.addSeries(LineSeries, {
      color: '#06b6d4', lineWidth: 1, lineStyle: LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: false,
      title: 'VWAP',
    });

    chartRef.current = chart;

    const onResize = () => {
      if (containerRef.current)
        chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); chart.remove(); };
  }, []);

  // ── Toggle indicator visibility ───────────────────────────────────────────
  useEffect(() => { ema9Ref.current?.applyOptions({ visible: showEma9 }); },  [showEma9]);
  useEffect(() => { ema21Ref.current?.applyOptions({ visible: showEma21 }); }, [showEma21]);
  useEffect(() => { vwapRef.current?.applyOptions({ visible: showVwap }); },   [showVwap]);

  // ── Update data when feed changes ─────────────────────────────────────────
  useEffect(() => {
    if (!candleRef.current || !feed?.length) return;
    const chart = chartRef.current;

    // ── Candles ──
    const candleData = feed.map(e => ({
      time:  toUtcSec(e.niftyTime),
      open:  e.niftyOpen,
      high:  e.niftyHigh,
      low:   e.niftyLow,
      close: e.niftyClose,
    })).filter(d => d.time > 0).sort((a, b) => a.time - b.time);
    candleRef.current.setData(candleData);

    const times  = candleData.map(d => d.time);
    const closes = candleData.map(d => d.close);

    // ── EMA 9 ──
    const ema9vals  = computeEma(closes, 9);
    ema9Ref.current.setData(times.map((t, i) => ({ time: t, value: ema9vals[i] })));

    // ── EMA 21 ──
    const ema21vals = computeEma(closes, 21);
    ema21Ref.current.setData(times.map((t, i) => ({ time: t, value: ema21vals[i] })));

    // ── VWAP (reconstruct from distanceFromVwap: dist% = (close-vwap)/vwap*100) ──
    const vwapData = feed
      .filter(e => e.distanceFromVwap != null && e.niftyClose != null && toUtcSec(e.niftyTime) > 0)
      .map(e => {
        const d = e.distanceFromVwap / 100;        // decimal fraction
        const vwap = e.niftyClose / (1 + d);       // close = vwap*(1+d)
        return { time: toUtcSec(e.niftyTime), value: vwap };
      })
      .sort((a, b) => a.time - b.time);
    vwapRef.current.setData(vwapData);

    // ── Regime bands (background shading) ─────────────────────────────────
    // Remove old bands
    regimeBandRefs.current.forEach(s => { try { chart.removeSeries(s); } catch {} });
    regimeBandRefs.current = [];

    if (showRegime && feed.length > 1) {
      // Group consecutive candles by regime → build segments
      const segments = [];
      let seg = { regime: feed[0].regime, start: 0, end: 0 };
      for (let i = 1; i < feed.length; i++) {
        if (feed[i].regime === seg.regime) {
          seg.end = i;
        } else {
          segments.push({ ...seg });
          seg = { regime: feed[i].regime, start: i, end: i };
        }
      }
      segments.push(seg);

      // For each segment paint a thin colored line at the bottom of price range
      // (using an area series is not supported per-segment; use a LineSeries at low price)
      const priceMin = Math.min(...candleData.map(d => d.low));
      const priceMax = Math.max(...candleData.map(d => d.high));
      const bandH    = (priceMax - priceMin) * 0.015; // 1.5% height strip

      segments.forEach(seg => {
        const color = REGIME_LINE_COLORS[seg.regime] || '#9ca3af';
        const s = chart.addSeries(LineSeries, {
          color,
          lineWidth: 3,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        const pts = [];
        for (let i = seg.start; i <= seg.end; i++) {
          pts.push({ time: times[i], value: priceMin - bandH });
        }
        if (pts.length) s.setData(pts);
        regimeBandRefs.current.push(s);
      });
    }

    // ── Bias + trade markers ───────────────────────────────────────────────
    if (markersRef.current) { markersRef.current.setMarkers([]); markersRef.current = null; }

    const markers = [];

    // Bias-switch markers
    let prevConfirmed = null;
    feed.forEach(e => {
      const t = toUtcSec(e.niftyTime);
      if (!t) return;
      if (e.confirmedBias !== prevConfirmed && e.switchConfirmed) {
        if (e.confirmedBias === 'BULLISH') {
          markers.push({ time: t, position: 'belowBar', color: '#22c55e', shape: 'arrowUp', text: '▲BULL', size: 1 });
        } else if (e.confirmedBias === 'BEARISH') {
          markers.push({ time: t, position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: '▼BEAR', size: 1 });
        } else {
          markers.push({ time: t, position: 'aboveBar', color: '#9ca3af', shape: 'circle', text: 'N', size: 1 });
        }
      }
      prevConfirmed = e.confirmedBias;

      // Trade action markers
      if (e.action === 'ENTERED') {
        const isCE = e.selectedOptionType === 'CE';
        markers.push({
          time: t, position: 'belowBar',
          color: isCE ? '#22c55e' : '#ef4444',
          shape: 'arrowUp',
          text: isCE ? 'CE' : 'PE',
          size: 2,
        });
      }
      if (e.action === 'EXITED' || e.action === 'FORCE_CLOSED') {
        // Look up the corresponding closed trade for P&L colour
        const trade = closedTrades.find(ct =>
          ct.exitTime && Math.abs(toUtcSec(ct.exitTime) - t) < 310
        );
        const win = trade ? trade.pnl >= 0 : null;
        const color = win === true ? '#22c55e' : win === false ? '#ef4444' : '#f59e0b';
        const pnlTxt = trade ? ` ${trade.pnl >= 0 ? '+' : ''}${Number(trade.pnl).toFixed(0)}` : '';
        markers.push({
          time: t, position: 'aboveBar',
          color,
          shape: 'arrowDown',
          text: `X${pnlTxt}`,
          size: 2,
        });
      }
    });

    markers.sort((a, b) => a.time - b.time);
    markersRef.current = createSeriesMarkers(candleRef.current, markers);

    chart.timeScale().fitContent();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed, showRegime]);

  // ── Trade price lines for selected trade ─────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    tradeLinesRef.current.forEach(s => { try { chart.removeSeries(s); } catch {} });
    tradeLinesRef.current = [];

    if (selectedTradeIdx == null || !closedTrades?.[selectedTradeIdx]) return;
    const t   = closedTrades[selectedTradeIdx];
    const win = t.pnl >= 0;
    const color = win ? '#22c55e' : '#ef4444';

    const ivSec = feed.length >= 2
      ? toUtcSec(feed[1].niftyTime) - toUtcSec(feed[0].niftyTime)
      : 300;
    const halfSpan = ivSec * 8;

    function addLine(price, timeStr, style, label) {
      if (price == null || !timeStr) return;
      const t0 = toUtcSec(timeStr) - halfSpan;
      const t1 = toUtcSec(timeStr) + halfSpan;
      const s  = chart.addSeries(LineSeries, {
        color, lineWidth: 1, lineStyle: style,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      s.setData([{ time: t0, value: parseFloat(price) }, { time: t1, value: parseFloat(price) }]);
      s.createPriceLine({ price: parseFloat(price), color, lineWidth: 0, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: label });
      tradeLinesRef.current.push(s);
    }

    addLine(t.entryPrice, t.entryTime, LineStyle.Dashed, `Entry ₹${Number(t.entryPrice).toFixed(0)}`);
    addLine(t.exitPrice,  t.exitTime,  LineStyle.Dotted, `Exit  ₹${Number(t.exitPrice).toFixed(0)}`);

    // Scroll to trade
    if (t.entryTime) {
      const from = toUtcSec(t.entryTime) - ivSec * 30;
      const to   = toUtcSec(t.exitTime || t.entryTime) + ivSec * 15;
      chart.timeScale().setVisibleRange({ from, to });
    }
  }, [selectedTradeIdx, closedTrades, feed]);

  if (!feed?.length) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 48 }}>
        Chart will appear once the replay starts.
      </div>
    );
  }

  return (
    <div>
      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        {[
          ['EMA 9',  showEma9,   setShowEma9,   '#f59e0b'],
          ['EMA 21', showEma21,  setShowEma21,  '#8b5cf6'],
          ['VWAP',   showVwap,   setShowVwap,   '#06b6d4'],
          ['Regime', showRegime, setShowRegime, '#9ca3af'],
        ].map(([label, on, setter, color]) => (
          <button key={label} type="button"
            onClick={() => setter(v => !v)}
            style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${on ? color : 'var(--border)'}`,
              background: on ? color + '22' : 'transparent',
              color: on ? color : 'var(--text-muted)',
              fontWeight: on ? 700 : 400,
            }}>
            {label}
          </button>
        ))}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
          {Object.entries(REGIME_LINE_COLORS).map(([r, c]) => (
            <span key={r} style={{ marginRight: 10 }}>
              <span style={{ display: 'inline-block', width: 10, height: 3, background: c, borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />
              {r}
            </span>
          ))}
        </div>
      </div>

      {/* ── Chart ── */}
      <div ref={containerRef} style={{ width: '100%' }} />

      {/* ── Trade list ── */}
      {closedTrades?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 600 }}>
            Click a trade to highlight on chart:
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {closedTrades.map((t, i) => {
              const win = t.pnl >= 0;
              const sel = i === selectedTradeIdx;
              return (
                <button key={i} type="button"
                  onClick={() => setSelectedTradeIdx(sel ? null : i)}
                  style={{
                    fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
                    border: `1px solid ${win ? '#22c55e' : '#ef4444'}`,
                    background: sel ? (win ? '#22c55e33' : '#ef444433') : 'transparent',
                    color: win ? '#22c55e' : '#ef4444',
                    fontWeight: sel ? 700 : 400,
                  }}>
                  #{i + 1} {t.optionType} {t.pnl >= 0 ? '+' : ''}{Number(t.pnl).toFixed(0)}
                </button>
              );
            })}
            {selectedTradeIdx != null && (
              <button type="button"
                onClick={() => setSelectedTradeIdx(null)}
                style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid var(--border)', color: 'var(--text-muted)', background: 'transparent' }}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function OptionsReplayTest() {
  const { session, isActive } = useSession();

  const ls = (key, def) => { try { const s = localStorage.getItem(key); if (!s) return def; const v = JSON.parse(s); return (Array.isArray(def) && !Array.isArray(v)) ? def : v; } catch { return def; } };

  // ── NIFTY instrument (NSE, decision source only)
  const [nifty, setNifty] = useState(() => ls('sma_opts_nifty', { symbol: '', exchange: 'NSE', instrumentToken: '' }));

  // ── Option pools
  const [cePool, setCePool] = useState(() => ls('sma_opts_ce_pool', [EMPTY_OPTION_INST()]));
  const [pePool, setPePool] = useState(() => ls('sma_opts_pe_pool', [EMPTY_OPTION_INST()]));

  // ── Replay settings
  const [interval,   setInterval]   = useState(() => ls('sma_opts_interval',   'MINUTE_5'));
  const [fromDate,   setFromDate]   = useState(() => { const v = ls('sma_opts_from', ''); const d = v.split('T')[0]; return d ? `${d}T09:15` : ''; });
  const [toDate,     setToDate]     = useState(() => { const v = ls('sma_opts_to',   ''); const d = v.split('T')[0]; return d ? `${d}T15:30` : ''; });
  const [warmupDays, setWarmupDays] = useState(() => ls('sma_opts_warmup',      '5'));
  const [speed,      setSpeed]      = useState(() => ls('sma_opts_speed',       '1'));
  const [quantity,   setQuantity]   = useState(() => ls('sma_opts_qty',         '0'));
  const [capital,    setCapital]    = useState(() => ls('sma_opts_capital',     '100000'));

  // ── Strategies (on NIFTY)
  const [strategies, setStrategies] = useState(() => ls('sma_opts_strategies', defaultStrategies()));

  // ── Config
  const [decisionCfg,  setDecisionCfg]  = useState(() => ls('sma_opts_decision',     DEFAULT_DECISION));
  const [selectionCfg, setSelectionCfg] = useState(() => ls('sma_opts_selection',    DEFAULT_SELECTION));
  const [switchCfg,    setSwitchCfg]    = useState(() => ls('sma_opts_switch',       DEFAULT_SWITCH));
  const [optsRegimeCfg,        setOptsRegimeCfg]        = useState(() => ls('sma_opts_regime_cfg',           DEFAULT_OPTS_REGIME_CONFIG));
  const [chopRules,            setChopRules]            = useState(() => ls('sma_opts_chop_rules',           DEFAULT_CHOP_RULES));
  const [tradingRules,         setTradingRules]         = useState(() => ls('sma_opts_trading_rules',        DEFAULT_TRADING_RULES));
  const [regimeRules,          setRegimeRules]          = useState(() => ls('sma_opts_regime_rules',          DEFAULT_REGIME_RULES));
  const [regimeStrategyRules,  setRegimeStrategyRules]  = useState(() => ls('sma_opts_regime_strat_rules',    DEFAULT_REGIME_STRATEGY_RULES));
  const [optsRisk,             setOptsRisk]             = useState(() => ls('sma_opts_risk',                  DEFAULT_OPTS_RISK));
  const [rangeQuality,         setRangeQuality]         = useState(() => ls('sma_opts_range_quality',          DEFAULT_RANGE_QUALITY));
  const [tradeQuality,         setTradeQuality]         = useState(() => ls('sma_opts_trade_quality',          DEFAULT_TRADE_QUALITY));
  const [trendEntry,           setTrendEntry]           = useState(() => ls('sma_opts_trend_entry',            DEFAULT_TREND_ENTRY));
  const [compressionEntry,     setCompressionEntry]     = useState(() => ls('sma_opts_compression_entry',      DEFAULT_COMPRESSION_ENTRY));
  const [holdConfig,           setHoldConfig]           = useState(() => ({ ...DEFAULT_HOLD, ...ls('sma_opts_hold_config', {}) }));

  function updateOptsRisk(key, val) { setOptsRisk(p => ({ ...p, [key]: val })); }
  function updateRangeQuality(key, val) { setRangeQuality(p => ({ ...p, [key]: val })); }
  function updateHoldConfig(key, val) { setHoldConfig(p => ({ ...p, [key]: val })); }
  function updateTradeQuality(key, val) { setTradeQuality(p => ({ ...p, [key]: val })); }
  function updateTrendEntry(key, val) { setTrendEntry(p => ({ ...p, [key]: val })); }
  function updateCompressionEntry(key, val) { setCompressionEntry(p => ({ ...p, [key]: val })); }

  // ── Persist to localStorage on change
  useEffect(() => { try { localStorage.setItem('sma_opts_nifty',      JSON.stringify(nifty));        } catch {} }, [nifty]);
  useEffect(() => { try { localStorage.setItem('sma_opts_ce_pool',    JSON.stringify(cePool));       } catch {} }, [cePool]);
  useEffect(() => { try { localStorage.setItem('sma_opts_pe_pool',    JSON.stringify(pePool));       } catch {} }, [pePool]);
  useEffect(() => { try { localStorage.setItem('sma_opts_interval',   JSON.stringify(interval));     } catch {} }, [interval]);
  useEffect(() => { try { localStorage.setItem('sma_opts_from',       JSON.stringify(fromDate));     } catch {} }, [fromDate]);
  useEffect(() => { try { localStorage.setItem('sma_opts_to',         JSON.stringify(toDate));       } catch {} }, [toDate]);
  useEffect(() => { try { localStorage.setItem('sma_opts_warmup',     JSON.stringify(warmupDays));   } catch {} }, [warmupDays]);
  useEffect(() => { try { localStorage.setItem('sma_opts_speed',      JSON.stringify(speed));        } catch {} }, [speed]);
  useEffect(() => { try { localStorage.setItem('sma_opts_qty',        JSON.stringify(quantity));     } catch {} }, [quantity]);
  useEffect(() => { try { localStorage.setItem('sma_opts_capital',    JSON.stringify(capital));      } catch {} }, [capital]);
  useEffect(() => { try { localStorage.setItem('sma_opts_strategies', JSON.stringify(strategies));   } catch {} }, [strategies]);
  useEffect(() => { try { localStorage.setItem('sma_opts_decision',   JSON.stringify(decisionCfg));  } catch {} }, [decisionCfg]);
  useEffect(() => { try { localStorage.setItem('sma_opts_selection',  JSON.stringify(selectionCfg)); } catch {} }, [selectionCfg]);
  useEffect(() => { try { localStorage.setItem('sma_opts_switch',       JSON.stringify(switchCfg));      } catch {} }, [switchCfg]);
  // ── Recent replay dates ──────────────────────────────────────────────────
  const [recentDates, setRecentDates] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sma_opts_recent_dates') || '[]'); } catch { return []; }
  });
  function saveRecentDate(dateStr) {
    if (!dateStr) return;
    setRecentDates(prev => {
      const next = [dateStr, ...prev.filter(d => d !== dateStr)].slice(0, 10);
      try { localStorage.setItem('sma_opts_recent_dates', JSON.stringify(next)); } catch {}
      return next;
    });
  }

  useEffect(() => { try { localStorage.setItem('sma_opts_regime_cfg',         JSON.stringify(optsRegimeCfg));       } catch {} }, [optsRegimeCfg]);
  useEffect(() => { try { localStorage.setItem('sma_opts_chop_rules',         JSON.stringify(chopRules));           } catch {} }, [chopRules]);
  useEffect(() => { try { localStorage.setItem('sma_opts_trading_rules',      JSON.stringify(tradingRules));        } catch {} }, [tradingRules]);
  useEffect(() => { try { localStorage.setItem('sma_opts_regime_rules',       JSON.stringify(regimeRules));         } catch {} }, [regimeRules]);
  useEffect(() => { try { localStorage.setItem('sma_opts_regime_strat_rules', JSON.stringify(regimeStrategyRules)); } catch {} }, [regimeStrategyRules]);
  useEffect(() => { try { localStorage.setItem('sma_opts_risk',               JSON.stringify(optsRisk));            } catch {} }, [optsRisk]);
  useEffect(() => { try { localStorage.setItem('sma_opts_range_quality',      JSON.stringify(rangeQuality));        } catch {} }, [rangeQuality]);
  useEffect(() => { try { localStorage.setItem('sma_opts_trade_quality',      JSON.stringify(tradeQuality));        } catch {} }, [tradeQuality]);
  useEffect(() => { try { localStorage.setItem('sma_opts_trend_entry',        JSON.stringify(trendEntry));          } catch {} }, [trendEntry]);
  useEffect(() => { try { localStorage.setItem('sma_opts_compression_entry',  JSON.stringify(compressionEntry));    } catch {} }, [compressionEntry]);
  useEffect(() => { try { localStorage.setItem('sma_opts_hold_config',        JSON.stringify(holdConfig));          } catch {} }, [holdConfig]);

  // ── Run state
  const [status,   setStatus]   = useState('idle'); // idle|running|completed|error
  const [feed,     setFeed]     = useState([]);      // OptionsReplayCandleEvent[]
  const [summary,  setSummary]  = useState(null);    // final summary event data
  const [initInfo, setInitInfo] = useState(null);    // { totalCandles, warmupCandles }
  const [error,    setError]    = useState('');
  const [rightTab, setRightTab] = useState('feed');
  const abortRef = useRef(null);
  const readerRef = useRef(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // ── Pool helpers
  function updatePoolInst(pool, setPool, id, patch) {
    setPool(p => p.map(i => i.id === id ? { ...i, ...patch } : i));
  }
  function addPoolInst(setPool) {
    setPool(p => [...p, EMPTY_OPTION_INST()]);
  }
  function removePoolInst(pool, setPool, id) {
    setPool(p => p.length > 1 ? p.filter(i => i.id !== id) : p);
  }

  function updateStrategy(idx, patch) {
    setStrategies(p => p.map((s, i) => i === idx ? { ...s, ...patch } : s));
  }
  function updateStratParam(idx, key, val) {
    setStrategies(p => p.map((s, i) => i === idx ? { ...s, parameters: { ...s.parameters, [key]: val } } : s));
  }

  function stop() {
    abortRef.current?.abort();
    try { readerRef.current?.cancel(); } catch {}
    setStatus(s => s === 'running' ? 'idle' : s);
  }

  function downloadCSV() {
    const q   = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const row = (...cols) => cols.map(q).join(',');
    const blank = '';
    const lines = [];

    // ── Run Config ──────────────────────────────────────────────────────────
    lines.push(row('=== Run Config ==='));
    lines.push(row('NIFTY Symbol', 'Exchange', 'Token', 'Interval', 'From', 'To', 'Warmup Days', 'Quantity', 'Capital'));
    lines.push(row(
      nifty.symbol || '—', nifty.exchange || '—', nifty.instrumentToken || '—',
      interval, fromDate, toDate, warmupDays, quantity, capital,
    ));
    lines.push(blank);

    // ── CE Pool ─────────────────────────────────────────────────────────────
    lines.push(row('=== CE Options Pool ==='));
    lines.push(row('Token', 'Symbol', 'Exchange'));
    cePool.filter(i => i.instrumentToken).forEach(i =>
      lines.push(row(i.instrumentToken, i.symbol, i.exchange)));
    lines.push(blank);

    // ── PE Pool ─────────────────────────────────────────────────────────────
    lines.push(row('=== PE Options Pool ==='));
    lines.push(row('Token', 'Symbol', 'Exchange'));
    pePool.filter(i => i.instrumentToken).forEach(i =>
      lines.push(row(i.instrumentToken, i.symbol, i.exchange)));
    lines.push(blank);

    // ── Strategies ──────────────────────────────────────────────────────────
    lines.push(row('=== Strategies ==='));
    lines.push(row('Strategy Type', 'Enabled', 'Parameters'));
    strategies.forEach(s =>
      lines.push(row(s.strategyType, s.enabled ? 'Yes' : 'No', JSON.stringify(s.parameters || {}))));
    lines.push(blank);

    // ── Decision Config ─────────────────────────────────────────────────────
    lines.push(row('=== Decision Config ==='));
    lines.push(row('Min Score', 'Penalty Min Score', 'Min Score Gap', 'Max Recent Move 3%', 'Max Recent Move 5%',
      'Max VWAP Dist%', 'Min Bars Since Trade', 'Chop Filter', 'Chop Lookback'));
    lines.push(row(
      decisionCfg.minScore, decisionCfg.penaltyMinScore, decisionCfg.minScoreGap,
      decisionCfg.maxRecentMove3, decisionCfg.maxRecentMove5,
      decisionCfg.maxAbsVwapDist, decisionCfg.minBarsSinceTrade,
      decisionCfg.chopFilter ? 'Yes' : 'No', decisionCfg.chopLookback,
    ));
    lines.push(blank);

    // ── Chop Filter Regime Rules ─────────────────────────────────────────────
    lines.push(row('=== Chop Filter Regime Rules ==='));
    lines.push(row('Enabled', 'Regime', 'Filter', 'Flip Ratio'));
    lines.push(row(chopRules.enabled ? 'Yes' : 'No'));
    if (chopRules.enabled) {
      [['RANGING', 'ranging'], ['TRENDING', 'trending'], ['COMPRESSION', 'compression'], ['VOLATILE', 'volatile']].forEach(([label, rk]) =>
        lines.push(row('', label, chopRules[rk].filterEnabled ? 'ON' : 'Disabled', chopRules[rk].filterEnabled ? chopRules[rk].flipRatio : '—'))
      );
    }
    lines.push(blank);

    // ── Market Regime Detection ──────────────────────────────────────────────
    lines.push(row('=== Market Regime Detection ==='));
    lines.push(row('Enabled', 'ADX Period', 'ATR Period', 'ADX Trend Threshold', 'ATR Volatile %', 'ATR Compression %'));
    lines.push(row(
      optsRegimeCfg.enabled ? 'Yes' : 'No',
      optsRegimeCfg.adxPeriod, optsRegimeCfg.atrPeriod,
      optsRegimeCfg.adxTrendThreshold, optsRegimeCfg.atrVolatilePct, optsRegimeCfg.atrCompressionPct,
    ));
    lines.push(blank);

    // ── Selection Config ────────────────────────────────────────────────────
    lines.push(row('=== Selection Config ==='));
    lines.push(row('Min Premium', 'Max Premium'));
    lines.push(row(selectionCfg.minPremium, selectionCfg.maxPremium));
    lines.push(blank);

    // ── Switch Config ───────────────────────────────────────────────────────
    lines.push(row('=== Switch Config ==='));
    lines.push(row('Switch Confirmation Candles', 'Max Switches Per Day'));
    lines.push(row(switchCfg.switchConfirmationCandles, switchCfg.maxSwitchesPerDay));
    lines.push(blank);

    // ── Trading Rules ────────────────────────────────────────────────────────
    lines.push(row('=== Trading Rules ==='));
    lines.push(row('Enabled', 'No Trade in RANGING', 'No Trade in VOLATILE', 'No Same-Candle Reversal'));
    lines.push(row(
      tradingRules.enabled ? 'Yes' : 'No',
      tradingRules.rangingNoTrade       ? 'ON' : 'OFF',
      tradingRules.volatileNoTrade      ? 'ON' : 'OFF',
      tradingRules.noSameCandleReversal ? 'ON' : 'OFF',
    ));
    lines.push(blank);

    // ── Regime Score Rules ───────────────────────────────────────────────────
    lines.push(row('=== Regime Score Rules ==='));
    lines.push(row('Enabled', 'RANGING Min Score', 'RANGING Min Score Gap', 'TRENDING Min Score', 'TRENDING Min Score Gap', 'COMPRESSION Min Score', 'COMPRESSION Min Score Gap'));
    lines.push(row(
      regimeRules.enabled ? 'Yes' : 'No',
      regimeRules.rangingMinScore,     regimeRules.rangingMinScoreGap,
      regimeRules.trendingMinScore,    regimeRules.trendingMinScoreGap,
      regimeRules.compressionMinScore, regimeRules.compressionMinScoreGap,
    ));
    lines.push(blank);

    // ── Regime Strategy Rules ────────────────────────────────────────────────
    lines.push(row('=== Regime Strategy Rules ==='));
    lines.push(row('Enabled'));
    lines.push(row(regimeStrategyRules.enabled ? 'Yes' : 'No'));
    if (regimeStrategyRules.enabled) {
      lines.push(blank);
      lines.push(row('Regime', 'Filter Enabled', 'Allowed Strategies'));
      [
        ['RANGING',     regimeStrategyRules.ranging],
        ['TRENDING',    regimeStrategyRules.trending],
        ['COMPRESSION', regimeStrategyRules.compression],
        ['VOLATILE',    regimeStrategyRules.volatile],
      ].forEach(([label, cfg]) =>
        lines.push(row(label, cfg.enabled ? 'Yes' : 'No', cfg.enabled ? (cfg.allowed.join(', ') || 'none selected') : 'all allowed'))
      );
    }
    lines.push(blank);

    // ── Range Quality Filter ─────────────────────────────────────────────────
    lines.push(row('=== Range Quality Filter (RANGING only) ==='));
    lines.push(row('Enabled', 'Lookback Bars', 'Min Upper Touches', 'Min Lower Touches',
      'Band Touch Tol%', 'Min Range Width%', 'Max Range Width%',
      'Max Drift Ratio', 'Chop Flip Limit', 'Chop Check'));
    lines.push(row(
      rangeQuality.enabled ? 'Yes' : 'No',
      rangeQuality.lookbackBars, rangeQuality.minUpperTouches, rangeQuality.minLowerTouches,
      rangeQuality.bandTouchTolerancePct, rangeQuality.minRangeWidthPct, rangeQuality.maxRangeWidthPct,
      rangeQuality.maxDirectionalDriftPctOfRange, rangeQuality.chopFlipRatioLimit,
      rangeQuality.enableChopCheck ? 'Yes' : 'No',
    ));
    lines.push(blank);

    // ── Risk Management ─────────────────────────────────────────────────────
    lines.push(row('=== Risk Management ==='));
    lines.push(row('Enabled', 'Stop Loss %', 'Take Profit %', 'Max Risk / Trade %', 'Daily Loss Cap %', 'Cooldown Candles'));
    lines.push(row(
      optsRisk.enabled ? 'Yes' : 'No',
      optsRisk.stopLossPct, optsRisk.takeProfitPct,
      optsRisk.maxRiskPerTradePct, optsRisk.dailyLossCapPct, optsRisk.cooldownCandles,
    ));
    lines.push(blank);

    // ── Trade Quality ────────────────────────────────────────────────────────
    lines.push(row('=== Trade Quality ==='));
    lines.push(row('Enabled', 'Strong Score ≥', 'Normal Score ≥', 'Weak Loss Cooldown', 'Block Weak in RANGING', 'RANGING Confirm', 'TRENDING Confirm'));
    lines.push(row(
      tradeQuality.enabled ? 'Yes' : 'No',
      tradeQuality.strongScoreThreshold, tradeQuality.normalScoreThreshold,
      tradeQuality.weakTradeLossCooldown, tradeQuality.blockWeakInRanging ? 'Yes' : 'No',
      tradeQuality.rangingConfirmCandles, tradeQuality.trendingConfirmCandles,
    ));
    lines.push(blank);

    // ── Trending Entry Structure ─────────────────────────────────────────────
    lines.push(row('=== Trending Entry Structure (TRENDING only) ==='));
    lines.push(row('Enabled', 'Breakout Lookback', 'Min Body %', 'Weak Body %', 'EMA Period'));
    lines.push(row(
      trendEntry.enabled ? 'Yes' : 'No',
      trendEntry.breakoutLookback, trendEntry.minBodyPct, trendEntry.weakBodyPct, trendEntry.ema9Period,
    ));
    lines.push(blank);

    // ── Compression Entry Structure ──────────────────────────────────────────
    lines.push(row('=== Compression Entry Structure (COMPRESSION only) ==='));
    lines.push(row('Enabled', 'Range Lookback', 'Long Zone Max', 'Short Zone Min', 'No-Trade Min', 'No-Trade Max', 'Reject Breakout'));
    lines.push(row(
      compressionEntry.enabled ? 'Yes' : 'No',
      compressionEntry.rangeLookback, compressionEntry.longZoneMax, compressionEntry.shortZoneMin,
      compressionEntry.noTradeZoneMin, compressionEntry.noTradeZoneMax,
      compressionEntry.rejectBreakoutCandle ? 'Yes' : 'No',
    ));
    lines.push(blank);

    // ── Hold Config ─────────────────────────────────────────────────────────
    lines.push(row('=== Minimum Hold Period ==='));
    lines.push(row('Enabled', 'Default Min Hold', 'RANGING Min Hold', 'TRENDING Min Hold', 'Strong Opp Score', 'Persistent Exit Bars'));
    lines.push(row(
      holdConfig.enabled ? 'Yes' : 'No',
      holdConfig.defaultMinHoldBars, holdConfig.rangingMinHoldBars, holdConfig.trendingMinHoldBars,
      holdConfig.strongOppositeScore, holdConfig.persistentExitBars,
    ));
    lines.push(blank);

    // ── Summary ─────────────────────────────────────────────────────────────
    if (summary) {
      lines.push(row('=== Summary ==='));
      lines.push(row('Total Trades', 'Realized P&L', 'Final Capital'));
      lines.push(row(summary.totalTrades, summary.realizedPnl, summary.finalCapital));
      lines.push(blank);
    }

    // ── Closed Trades ───────────────────────────────────────────────────────
    const closedTradesForCsv = lastEvt?.closedTrades || summary?.closedTrades || [];
    if (closedTradesForCsv.length > 0) {
      lines.push(row('=== Closed Trades ==='));
      lines.push(row('Entry Time', 'Exit Time', 'Type', 'Symbol', 'Strike', 'Expiry',
        'Entry Px', 'Exit Px', 'Qty', 'P&L', 'P&L %', 'Bars', 'Exit Reason', 'Capital After'));
      closedTradesForCsv.forEach(t => lines.push(row(
        (t.entryTime || '').slice(0, 16), (t.exitTime || '').slice(0, 16),
        t.optionType, t.tradingSymbol, t.strike, t.expiry,
        t.entryPrice != null ? Number(t.entryPrice).toFixed(2) : '',
        t.exitPrice  != null ? Number(t.exitPrice).toFixed(2)  : '',
        t.quantity,
        t.pnl    != null ? Number(t.pnl).toFixed(2)    : '',
        t.pnlPct != null ? Number(t.pnlPct).toFixed(2) : '',
        t.barsInTrade, t.exitReason,
        t.capitalAfter != null ? Number(t.capitalAfter).toFixed(2) : '',
      )));
      lines.push(blank);
    }

    // ── Diagnostics (if available) ───────────────────────────────────────────
    if (summary?.diagnostics) {
      const d = summary.diagnostics;
      lines.push(row('=== Replay Diagnostics ==='));
      lines.push(row('Total Candles', 'With Buy Candidate', 'With Sell Candidate',
        'With Eligible Candidate', 'Winner Selected', 'Stayed Neutral',
        'No Signals', 'Below Score', 'Score Gap Too Small',
        'Blocked RecentMove', 'Blocked VWAP', 'Blocked Chop'));
      lines.push(row(
        d.totalCandles, d.candlesWithBuyCandidate, d.candlesWithSellCandidate,
        d.candlesWithEligibleCandidate, d.candlesWithWinner, d.candlesNeutral,
        d.candlesNoSignals, d.candlesBlockedByScore, d.candlesBlockedByScoreGap,
        d.candlesBlockedByRecentMove, d.candlesBlockedByVwap, d.candlesBlockedByChop,
      ));
      if (d.neutralReasonCounts && Object.keys(d.neutralReasonCounts).length > 0) {
        lines.push(blank);
        lines.push(row('=== Neutral Reason Breakdown ==='));
        lines.push(row('Reason', 'Count'));
        Object.entries(d.neutralReasonCounts).forEach(([r, c]) => lines.push(row(r, c)));
      }
      lines.push(blank);
    }

    // ── Per-Candle Feed ─────────────────────────────────────────────────────
    if (feed.length > 0) {
      lines.push(row('=== Per-Candle Feed ==='));
      lines.push(row(
        // Progress
        'Candle #', 'Total Candles',
        // NIFTY OHLCV
        'Time', 'NIFTY Open', 'NIFTY High', 'NIFTY Low', 'NIFTY Close', 'NIFTY Volume',
        // Decision
        'Regime', 'Raw Bias', 'Prev Bias', 'Conf Bias',
        'Winner Strategy', 'Winner Score', 'Score Gap', 'Confidence',
        '2nd Strategy', '2nd Score',
        'Neutral Reason',
        'Shadow Winner', 'Shadow Score', 'Shadow Not-Taken Reason',
        'Recent Move 3%', 'Recent Move 5%', 'VWAP Dist%',
        'Entry Allowed', 'Block Reason',
        'Switch Requested', 'Switch Confirmed', 'Switch Reason', 'Switch Count Today',
        'Bars Since Trade',
        // Candidates (compact signal:score:eligible per strategy)
        'Candidates',
        // Execution
        'Position State', 'Desired Side', 'Action', 'Exit Reason',
        'Entry Regime', 'Applied Min Hold', 'Hold Active',
        'Selected Symbol', 'Option Type', 'Strike', 'Expiry',
        'Entry Price', 'Exit Price', 'Bars In Trade',
        'uPnL', 'rPnL', 'Total PnL', 'Capital',
        // Option candle OHLCV
        'Option Time', 'Option Open', 'Option High', 'Option Low', 'Option Close', 'Option Volume',
      ));
      const n2 = v => v != null ? Number(v).toFixed(2) : '';
      feed.forEach(e => lines.push(row(
        e.emitted ?? '', e.total ?? '',
        (e.niftyTime || '').slice(0, 19),
        n2(e.niftyOpen), n2(e.niftyHigh), n2(e.niftyLow), n2(e.niftyClose),
        e.niftyVolume ?? '',
        e.regime || '', e.niftyBias || '', e.previousNiftyBias || '', e.confirmedBias || '',
        e.winnerStrategy || '', n2(e.winnerScore), n2(e.scoreGap),
        e.confidenceLevel || '',
        e.secondStrategy || '', n2(e.secondScore),
        e.neutralReason || '',
        e.shadowWinner || '', n2(e.shadowWinnerScore), e.shadowWinnerReasonNotTaken || '',
        n2(e.recentMove3), n2(e.recentMove5), n2(e.distanceFromVwap),
        e.entryAllowed ? 'Yes' : 'No', e.blockReason || '',
        e.switchRequested ? 'Yes' : 'No', e.switchConfirmed ? 'Yes' : 'No',
        e.switchReason || '', e.switchCountToday ?? '',
        e.barsSinceLastTrade ?? '',
        // Candidates: strategyType|signal|score|eligible|eligibilityReason for each
        (e.candidates || []).map(c =>
          `${c.strategyType}:${c.signal}:${Number(c.score).toFixed(1)}:${c.eligible ? 'ok' : 'blocked'}${c.eligibilityReason ? '(' + c.eligibilityReason + ')' : ''}`
        ).join(' | '),
        e.positionState || '', e.desiredSide || '', e.action || '', e.exitReason || '',
        e.entryRegime || '', e.appliedMinHold ?? '', e.holdActive ? 'Yes' : 'No',
        e.selectedTradingSymbol || '', e.selectedOptionType || '',
        e.selectedStrike ?? '', e.selectedExpiry || '',
        n2(e.entryPrice), n2(e.exitPrice), e.barsInTrade ?? '',
        n2(e.unrealizedPnl), n2(e.realizedPnl), n2(e.totalPnl), n2(e.capital),
        (e.optionTime || '').slice(0, 19),
        n2(e.optionOpen), n2(e.optionHigh), n2(e.optionLow), n2(e.optionClose),
        e.optionVolume ?? '',
      )));

      // ── Per-Candidate Pipeline Breakdown (separate section per strategy) ──
      const strategyTypes = [...new Set(
        feed.flatMap(e => (e.candidates || []).map(c => c.strategyType))
      )];
      if (strategyTypes.length > 0) {
        lines.push(blank);
        lines.push(row('=== Candidate Score Pipeline Breakdown ==='));
        lines.push(row(
          'Time', 'Strategy', 'Signal',
          'Base Score', 'Trend', 'Volatility', 'Momentum', 'Confidence',
          'Pen Reversal', 'Pen Overextension', 'Pen SameColor', 'Pen Mismatch', 'Pen VolatileOpt',
          'Total Penalty', 'Final Score', 'Eligible', 'Eligibility Reason',
        ));
        feed.forEach(e => {
          (e.candidates || []).forEach(c => {
            lines.push(row(
              (e.niftyTime || '').slice(0, 19),
              c.strategyType, c.signal,
              n2(c.baseScore),
              n2(c.trendComponent), n2(c.volatilityComponent),
              n2(c.momentumComponent), n2(c.confidenceComponent),
              n2(c.penaltyReversal), n2(c.penaltyOverextension), n2(c.penaltySameColor),
              n2(c.penaltyMismatch), n2(c.penaltyVolatileOption),
              n2(c.totalPenalty), n2(c.score),
              c.eligible ? 'Yes' : 'No', c.eligibilityReason || '',
            ));
          });
        });
      }
    }

    const csv  = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `options_replay_${nifty.symbol || 'data'}_${(fromDate || '').slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (status === 'running') { stop(); return; }

    setFeed([]); setSummary(null); setInitInfo(null); setError(''); setStatus('running');

    // Save to recent dates whenever from == to (single-day replay)
    const fromDay = (fromDate || '').slice(0, 10);
    const toDay   = (toDate   || '').slice(0, 10);
    if (fromDay && fromDay === toDay) saveRecentDate(fromDay);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const enabledStrats = strategies
      .filter(s => s.enabled)
      .map(s => ({ strategyType: s.strategyType, parameters: s.parameters }));

    const payload = {
      userId:    session.userId,
      brokerName: session.brokerName,
      niftyInstrumentToken: nifty.instrumentToken ? parseInt(nifty.instrumentToken, 10) : undefined,
      niftySymbol:   nifty.symbol   || 'NIFTY 50',
      niftyExchange: nifty.exchange || 'NSE',
      interval,
      fromDate: fromDate ? `${fromDate}:00` : undefined,
      toDate:   toDate   ? `${toDate}:00`   : undefined,
      warmupDays: parseInt(warmupDays, 10) || 5,
      quantity:   parseInt(quantity,  10) || 0,
      initialCapital: parseFloat(capital) || 100000,
      ceOptions: cePool.filter(i => i.instrumentToken).map(i => ({
        instrumentToken: parseInt(i.instrumentToken, 10),
        tradingSymbol: i.symbol,
        exchange: i.exchange,
      })),
      peOptions: pePool.filter(i => i.instrumentToken).map(i => ({
        instrumentToken: parseInt(i.instrumentToken, 10),
        tradingSymbol: i.symbol,
        exchange: i.exchange,
      })),
      strategies: enabledStrats,
      decisionConfig: {
        minScore:          parseFloat(decisionCfg.minScore)          || 40,
        minScoreGap:       parseFloat(decisionCfg.minScoreGap)       || 8,
        maxRecentMove3:    parseFloat(decisionCfg.maxRecentMove3)     || 1.5,
        maxRecentMove5:    parseFloat(decisionCfg.maxRecentMove5)     || 2.5,
        maxAbsVwapDist:    parseFloat(decisionCfg.maxAbsVwapDist)     || 1.5,
        minBarsSinceTrade: parseInt(decisionCfg.minBarsSinceTrade, 10) || 3,
        chopFilter:        decisionCfg.chopFilter,
        chopLookback:      parseInt(decisionCfg.chopLookback, 10)      || 8,
        penaltyMinScore:   parseFloat(decisionCfg.penaltyMinScore)    || 25,
      },
      selectionConfig: {
        minPremium: parseFloat(selectionCfg.minPremium) || 50,
        maxPremium: parseFloat(selectionCfg.maxPremium) || 300,
      },
      switchConfig: {
        switchConfirmationCandles:   parseInt(switchCfg.switchConfirmationCandles, 10)    || 2,
        maxSwitchesPerDay:           parseInt(switchCfg.maxSwitchesPerDay, 10)            || 3,
        minScoreImprovementForSwitch:parseFloat(switchCfg.minScoreImprovementForSwitch)  || 0,
      },
      regimeConfig: optsRegimeCfg.enabled ? {
        enabled:            true,
        adxPeriod:          parseInt(optsRegimeCfg.adxPeriod, 10)         || 14,
        atrPeriod:          parseInt(optsRegimeCfg.atrPeriod, 10)         || 14,
        adxTrendThreshold:  parseFloat(optsRegimeCfg.adxTrendThreshold)   || 25,
        atrVolatilePct:     parseFloat(optsRegimeCfg.atrVolatilePct)      || 2.0,
        atrCompressionPct:  parseFloat(optsRegimeCfg.atrCompressionPct)   || 0.5,
      } : { enabled: false },
      regimeRules: {
        enabled:               regimeRules.enabled,
        rangingMinScore:       parseFloat(regimeRules.rangingMinScore)       || 35,
        rangingMinScoreGap:    parseFloat(regimeRules.rangingMinScoreGap)    || 6,
        trendingMinScore:      parseFloat(regimeRules.trendingMinScore)      || 25,
        trendingMinScoreGap:   parseFloat(regimeRules.trendingMinScoreGap)   || 3,
        compressionMinScore:   parseFloat(regimeRules.compressionMinScore)   || 25,
        compressionMinScoreGap: parseFloat(regimeRules.compressionMinScoreGap) || 3,
      },
      chopRules: {
        enabled: chopRules.enabled,
        ...Object.fromEntries(['ranging','trending','compression','volatile'].map(rk => [
          rk === 'volatile' ? 'volatileRegime' : rk,
          { filterEnabled: chopRules[rk].filterEnabled, flipRatio: parseFloat(chopRules[rk].flipRatio) || 0.65 },
        ])),
      },
      tradingRules: {
        enabled:               tradingRules.enabled,
        rangingNoTrade:        tradingRules.rangingNoTrade,
        volatileNoTrade:       tradingRules.volatileNoTrade,
        noSameCandleReversal:  tradingRules.noSameCandleReversal,
      },
      regimeStrategyRules: {
        enabled: regimeStrategyRules.enabled,
        ranging:        regimeStrategyRules.ranging.enabled     ? regimeStrategyRules.ranging.allowed     : [],
        trending:       regimeStrategyRules.trending.enabled    ? regimeStrategyRules.trending.allowed    : [],
        compression:    regimeStrategyRules.compression.enabled ? regimeStrategyRules.compression.allowed : [],
        volatileRegime: regimeStrategyRules.volatile.enabled    ? regimeStrategyRules.volatile.allowed    : [],
      },
      riskConfig: optsRisk.enabled ? {
        enabled:            true,
        stopLossPct:        parseFloat(optsRisk.stopLossPct)        || 0,
        takeProfitPct:      parseFloat(optsRisk.takeProfitPct)      || 0,
        maxRiskPerTradePct: parseFloat(optsRisk.maxRiskPerTradePct) || 0,
        dailyLossCapPct:    parseFloat(optsRisk.dailyLossCapPct)    || 0,
        cooldownCandles:    parseInt(optsRisk.cooldownCandles, 10)  || 0,
      } : { enabled: false },
      rangeQualityConfig: rangeQuality.enabled ? {
        enabled:                       true,
        lookbackBars:                  parseInt(rangeQuality.lookbackBars, 10)               || 10,
        minUpperTouches:               parseInt(rangeQuality.minUpperTouches, 10)            || 2,
        minLowerTouches:               parseInt(rangeQuality.minLowerTouches, 10)            || 2,
        bandTouchTolerancePct:         parseFloat(rangeQuality.bandTouchTolerancePct)        || 0.15,
        minRangeWidthPct:              parseFloat(rangeQuality.minRangeWidthPct)             || 0.4,
        maxRangeWidthPct:              parseFloat(rangeQuality.maxRangeWidthPct)             || 2.0,
        maxDirectionalDriftPctOfRange: parseFloat(rangeQuality.maxDirectionalDriftPctOfRange) || 0.6,
        chopFlipRatioLimit:            parseFloat(rangeQuality.chopFlipRatioLimit)           || 0.65,
        enableChopCheck:               rangeQuality.enableChopCheck,
      } : { enabled: false },
      tradeQualityConfig: tradeQuality.enabled ? {
        enabled:                true,
        strongScoreThreshold:   parseFloat(tradeQuality.strongScoreThreshold)   || 40,
        normalScoreThreshold:   parseFloat(tradeQuality.normalScoreThreshold)   || 32,
        weakTradeLossCooldown:  parseInt(tradeQuality.weakTradeLossCooldown, 10) || 5,
        blockWeakInRanging:     tradeQuality.blockWeakInRanging,
        rangingConfirmCandles:  parseInt(tradeQuality.rangingConfirmCandles, 10) || 3,
        trendingConfirmCandles: parseInt(tradeQuality.trendingConfirmCandles, 10) || 2,
      } : { enabled: false },
      trendEntryConfig: trendEntry.enabled ? {
        enabled:         true,
        breakoutLookback:parseInt(trendEntry.breakoutLookback, 10) || 5,
        minBodyPct:      parseFloat(trendEntry.minBodyPct)         || 60,
        weakBodyPct:     parseFloat(trendEntry.weakBodyPct)        || 30,
        ema9Period:      parseInt(trendEntry.ema9Period, 10)       || 9,
      } : { enabled: false },
      compressionEntryConfig: compressionEntry.enabled ? {
        enabled:              true,
        rangeLookback:        parseInt(compressionEntry.rangeLookback, 10)  || 10,
        longZoneMax:          parseFloat(compressionEntry.longZoneMax)       || 0.2,
        shortZoneMin:         parseFloat(compressionEntry.shortZoneMin)      || 0.8,
        noTradeZoneMin:       parseFloat(compressionEntry.noTradeZoneMin)    || 0.4,
        noTradeZoneMax:       parseFloat(compressionEntry.noTradeZoneMax)    || 0.6,
        rejectBreakoutCandle: compressionEntry.rejectBreakoutCandle,
      } : { enabled: false },
      holdConfig: {
        enabled:             holdConfig.enabled,
        defaultMinHoldBars:  parseInt(holdConfig.defaultMinHoldBars, 10)  || 3,
        rangingMinHoldBars:  parseInt(holdConfig.rangingMinHoldBars, 10)  || 4,
        trendingMinHoldBars: parseInt(holdConfig.trendingMinHoldBars, 10) || 2,
        strongOppositeScore: parseFloat(holdConfig.strongOppositeScore)   || 35,
        persistentExitBars:  parseInt(holdConfig.persistentExitBars, 10)  || 2,
      },
      speedMultiplier: parseInt(speed, 10) || 1,
      persist: true,
    };

    try {
      const response = await startOptionsReplayEval(payload, ctrl.signal);
      if (!response.body) throw new Error('No response body');
      const reader  = response.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          let evtName = null, data = null;
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) evtName = line.slice(6).trim();
            else if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          if (!evtName || !data) continue;
          if (evtName === 'error') {
            setError(data.replace(/^"|"$/g, ''));
            setStatus('error');
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (evtName === 'init') {
              setInitInfo(parsed);
            } else if (evtName === 'candle') {
              setFeed(prev => [...prev.slice(-499), parsed]);
            } else if (evtName === 'summary') {
              setSummary(parsed);
            }
          } catch {}
        }
      }
      setStatus('completed');
    } catch (err) {
      if (err.name === 'AbortError') { setStatus('idle'); return; }
      setError(err.message);
      setStatus('error');
    }
  }

  if (!isActive) return (
    <div className="bt-empty-state">
      <p>Activate a broker session to use Options Replay Test.</p>
    </div>
  );

  const isRunning   = status === 'running';
  const canRun      = nifty.instrumentToken &&
    (cePool.some(i => i.instrumentToken) || pePool.some(i => i.instrumentToken));
  const lastEvt     = feed[feed.length - 1];
  const closedTrades = lastEvt?.closedTrades || summary?.closedTrades || [];

  return (
    <div>
      {/* ── Results panel (always visible at top) ── */}
      <div className="card bt-opts-card" style={{ marginBottom: 16 }}>
        <div className="bt-live-right-tabs" style={{ marginBottom: 14 }}>
          {[['feed','Feed'],['chart','Chart'],['pnl','P&L'],['portfolio','Portfolio'],['details','Details']].map(([k, l]) => (
            <button key={k} className={`bt-live-tab-btn ${rightTab === k ? 'active' : ''}`} onClick={() => setRightTab(k)}>{l}</button>
          ))}
          {feed.length > 0 && (
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-secondary)' }}>
              {feed.length} candles · {closedTrades.length} trades
            </span>
          )}
        </div>

        {/* ── Persistent P&L strip (visible on all tabs) ── */}
        {(lastEvt || summary) && (() => {
          const totalPnl    = lastEvt?.totalPnl    ?? summary?.totalPnl;
          const realizedPnl = lastEvt?.realizedPnl ?? summary?.realizedPnl;
          const unrealPnl   = lastEvt?.unrealizedPnl;
          const capital     = lastEvt?.capital     ?? summary?.finalCapital;
          const trades      = closedTrades.length;
          const wins        = closedTrades.filter(t => t.pnl > 0).length;
          const losses      = closedTrades.filter(t => t.pnl < 0).length;
          const winRate     = trades > 0 ? (wins / trades * 100).toFixed(1) + '%' : '—';
          return (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', marginBottom: 12, padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 6, borderLeft: '3px solid ' + (totalPnl > 0 ? '#22c55e' : totalPnl < 0 ? '#ef4444' : 'var(--border)') }}>
              {[
                ['Total P&L',  totalPnl,    true,  true],
                ['Realized',   realizedPnl, true,  false],
                ['Unrealized', unrealPnl,   true,  false],
                ['Capital',    capital,     false, false],
                ['Trades',     trades,      false, false],
                ['W/L',        `${wins}/${losses}`, false, false],
                ['Win Rate',   winRate,     false, false],
              ].map(([lbl, val, isPnl, bold]) => (
                <div key={lbl} style={{ fontSize: 11 }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: 1 }}>{lbl}</div>
                  <div style={{ fontWeight: bold ? 800 : 700, fontSize: bold ? 13 : 11, ...(isPnl && val != null ? pnlStyle(val) : {}) }}>
                    {val != null ? (typeof val === 'number' ? fmt2(val) : val) : '—'}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}

        {/* ── Feed ── */}
        {rightTab === 'feed' && (
          <>
            {lastEvt && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginBottom: 14, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
                {[
                  ['Position', lastEvt.positionState, lastEvt.positionState === 'LONG_CALL' ? '#22c55e' : lastEvt.positionState === 'LONG_PUT' ? '#ef4444' : undefined],
                  ['Bias', lastEvt.niftyBias, lastEvt.niftyBias === 'BULLISH' ? '#22c55e' : lastEvt.niftyBias === 'BEARISH' ? '#ef4444' : undefined],
                  ['Conf Bias', lastEvt.confirmedBias, lastEvt.confirmedBias === 'BULLISH' ? '#22c55e' : lastEvt.confirmedBias === 'BEARISH' ? '#ef4444' : undefined],
                  ['Action', lastEvt.action, lastEvt.action === 'ENTERED' ? '#22c55e' : lastEvt.action === 'EXITED' || lastEvt.action === 'FORCE_CLOSED' ? '#f97316' : undefined],
                  ['Winner', lastEvt.winnerStrategy || lastEvt.shadowWinner && `(${lastEvt.shadowWinner})`, undefined],
                  ['Score', fmt2(lastEvt.winnerScore || lastEvt.shadowWinnerScore), undefined],
                  ['2nd', lastEvt.secondStrategy ? `${lastEvt.secondStrategy} ${fmt2(lastEvt.secondScore)}` : '—', undefined],
                  ['Gap', fmt2(lastEvt.scoreGap), undefined],
                  ['NeutralReason', lastEvt.neutralReason || '—', lastEvt.neutralReason ? '#f59e0b' : undefined],
                  ['Shadow', lastEvt.shadowWinner ? `${lastEvt.shadowWinner} ${fmt2(lastEvt.shadowWinnerScore)}` : '—', lastEvt.shadowWinner ? '#8b5cf6' : undefined],
                  ['uPnL', fmt2(lastEvt.unrealizedPnl), lastEvt.unrealizedPnl > 0 ? '#22c55e' : lastEvt.unrealizedPnl < 0 ? '#ef4444' : undefined],
                  ['rPnL', fmt2(lastEvt.realizedPnl), lastEvt.realizedPnl > 0 ? '#22c55e' : lastEvt.realizedPnl < 0 ? '#ef4444' : undefined],
                  ['Capital', fmt2(lastEvt.capital), undefined],
                  ['Block', lastEvt.blockReason || '—', lastEvt.blockReason ? '#ef4444' : undefined],
                ].map(([lbl, val, color]) => (
                  <div key={lbl} style={{ fontSize: 11 }}>
                    <div style={{ color: 'var(--text-secondary)' }}>{lbl}</div>
                    <div style={{ fontWeight: 700, color }}>{val || '—'}</div>
                  </div>
                ))}
              </div>
            )}
            {/* ── Active Config Summary ── */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 10 }}>
            <button type="button" className="btn-secondary btn-xs" style={{ flexShrink: 0, marginTop: 1 }}
              onClick={() => {
                // ── Config line ──
                const ceSymbols = cePool.filter(i => i.symbol).map(i => i.symbol).join(', ');
                const peSymbols = pePool.filter(i => i.symbol).map(i => i.symbol).join(', ');
                let text = `Run: ${nifty.symbol || '—'} ${interval} ${(fromDate || '').slice(0, 10)} → ${(toDate || '').slice(0, 10)}`;
                if (ceSymbols) text += ` CE=[${ceSymbols}]`;
                if (peSymbols) text += ` PE=[${peSymbols}]`;
                text += '\nConfig: ';
                text += `minScore=${decisionCfg.minScore} gap=${decisionCfg.minScoreGap} move3=${decisionCfg.maxRecentMove3}% move5=${decisionCfg.maxRecentMove5}% vwapDist=${decisionCfg.maxAbsVwapDist}% minBars=${decisionCfg.minBarsSinceTrade} chop=${decisionCfg.chopFilter ? `ON(${decisionCfg.chopLookback})` : 'OFF'} switchConf=${switchCfg.switchConfirmationCandles} maxSwitch=${switchCfg.maxSwitchesPerDay} prem=${selectionCfg.minPremium}–${selectionCfg.maxPremium}`;
                if (regimeRules.enabled) {
                  text += ` | RANGING ${regimeRules.rangingMinScore}/${regimeRules.rangingMinScoreGap} TRENDING ${regimeRules.trendingMinScore}/${regimeRules.trendingMinScoreGap} COMPRESSION ${regimeRules.compressionMinScore}/${regimeRules.compressionMinScoreGap}`;
                }
                if (tradingRules.enabled) {
                  const active = [
                    tradingRules.rangingNoTrade       && 'No RANGING',
                    tradingRules.volatileNoTrade      && 'No VOLATILE',
                    tradingRules.noSameCandleReversal && 'No Reversal',
                  ].filter(Boolean);
                  if (active.length) text += ' | Rules: ' + active.join(', ');
                }
                if (regimeStrategyRules.enabled) {
                  const parts = [
                    { key: 'ranging', label: 'RANGING' }, { key: 'trending', label: 'TRENDING' },
                    { key: 'compression', label: 'COMPRESSION' }, { key: 'volatile', label: 'VOLATILE' },
                  ].filter(({ key: rk }) => regimeStrategyRules[rk].enabled)
                   .map(({ key: rk, label }) => `${label}[${regimeStrategyRules[rk].allowed.join(',') || 'none'}]`);
                  if (parts.length) text += ' | StratRules: ' + parts.join(' ');
                }
                if (rangeQuality.enabled) {
                  text += ` | RngQ: lbk=${rangeQuality.lookbackBars} ut>=${rangeQuality.minUpperTouches} lt>=${rangeQuality.minLowerTouches} W=${rangeQuality.minRangeWidthPct}-${rangeQuality.maxRangeWidthPct}% drift<=${rangeQuality.maxDirectionalDriftPctOfRange} chop<=${rangeQuality.chopFlipRatioLimit}`;
                }
                if (optsRisk.enabled) {
                  text += ` | Risk: SL=${optsRisk.stopLossPct}% TP=${optsRisk.takeProfitPct}% MaxRisk=${optsRisk.maxRiskPerTradePct}% DailyCap=${optsRisk.dailyLossCapPct}% Cooldown=${optsRisk.cooldownCandles}`;
                }
                if (tradeQuality.enabled) {
                  text += ` | TQ: S>=${tradeQuality.strongScoreThreshold} N>=${tradeQuality.normalScoreThreshold} wkCooldown=${tradeQuality.weakTradeLossCooldown} blockWkRng=${tradeQuality.blockWeakInRanging} rngConf=${tradeQuality.rangingConfirmCandles} trdConf=${tradeQuality.trendingConfirmCandles}`;
                }
                if (trendEntry.enabled) {
                  text += ` | TrendEntry: brkLbk=${trendEntry.breakoutLookback} body>=${trendEntry.minBodyPct}% weak<${trendEntry.weakBodyPct}% EMA${trendEntry.ema9Period}`;
                }
                if (compressionEntry.enabled) {
                  text += ` | CmpEntry: lbk=${compressionEntry.rangeLookback} long<=${compressionEntry.longZoneMax} short>=${compressionEntry.shortZoneMin} noTrade=[${compressionEntry.noTradeZoneMin}-${compressionEntry.noTradeZoneMax}]`;
                }
                text += '\n\n';

                // ── Feed header ──
                const headers = ['Time','NIFTY','Regime','Bias','ConfBias','Winner','Score','PenScore','Str','2nd','Gap','Shadow','NeutralReason','State','Bars','Hold','Action','ExitRsn','Option','OptPx','uPnL','rPnL','Block'];
                text += headers.join('\t') + '\n';

                // ── Feed rows (chronological order) ──
                [...feed].reverse().forEach(evt => {
                  text += [
                    (evt.niftyTime || '').slice(0, 16),
                    evt.niftyClose != null ? Number(evt.niftyClose).toFixed(2) : '',
                    evt.regime || '',
                    evt.niftyBias || '',
                    evt.confirmedBias || '',
                    evt.winnerStrategy || '',
                    evt.winnerScore != null ? Number(evt.winnerScore).toFixed(2) : '',
                    evt.penalizedScore != null && evt.penalizedScore !== evt.winnerScore ? Number(evt.penalizedScore).toFixed(2) : '',
                    evt.tradeStrength && evt.tradeStrength !== 'NONE' ? evt.tradeStrength : '',
                    evt.secondStrategy ? `${evt.secondStrategy} ${Number(evt.secondScore).toFixed(2)}` : '',
                    evt.scoreGap != null ? Number(evt.scoreGap).toFixed(2) : '',
                    evt.shadowWinner ? `${evt.shadowWinner} ${Number(evt.shadowWinnerScore).toFixed(2)}` : '',
                    evt.neutralReason || '',
                    evt.positionState || '',
                    evt.barsInTrade ?? '',
                    evt.holdActive ? `LOCK(${evt.barsInTrade}/${evt.appliedMinHold})` : '',
                    evt.action || '',
                    evt.exitReason || '',
                    evt.selectedTradingSymbol || '',
                    evt.optionClose != null ? Number(evt.optionClose).toFixed(2) : '',
                    evt.unrealizedPnl != null ? Number(evt.unrealizedPnl).toFixed(2) : '',
                    evt.realizedPnl  != null ? Number(evt.realizedPnl).toFixed(2)  : '',
                    evt.blockReason || '',
                  ].join('\t') + '\n';
                });

                navigator.clipboard.writeText(text).catch(() => {});
              }}>
              Copy
            </button>
            <button type="button" className="btn-secondary btn-xs" style={{ flexShrink: 0, marginTop: 1 }}
              onClick={downloadCSV}>
              Download CSV
            </button>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 0', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {/* ── Instrument / Date / Interval ── */}
              <span style={{ marginRight: 10, fontWeight: 700, color: 'var(--text-primary)' }}>Run:</span>
              <span style={{ marginRight: 14 }}><b style={{ color: 'var(--text-primary)' }}>{nifty.symbol || '—'}</b></span>
              <span style={{ marginRight: 14 }}><b style={{ color: 'var(--text-primary)' }}>{interval}</b></span>
              <span style={{ marginRight: 14 }}>{(fromDate || '').slice(0, 10)}<b style={{ color: 'var(--text-muted)', margin: '0 4px' }}>→</b>{(toDate || '').slice(0, 10)}</span>
              {cePool.some(i => i.symbol) && (
                <span style={{ marginRight: 14 }}>CE=<b style={{ color: '#22c55e' }}>{cePool.filter(i => i.symbol).map(i => i.symbol).join(', ')}</b></span>
              )}
              {pePool.some(i => i.symbol) && (
                <span style={{ marginRight: 14 }}>PE=<b style={{ color: '#ef4444' }}>{pePool.filter(i => i.symbol).map(i => i.symbol).join(', ')}</b></span>
              )}
              <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
              <span style={{ marginRight: 10, fontWeight: 700, color: 'var(--text-primary)' }}>Config:</span>
              <span style={{ marginRight: 14 }}>minScore=<b style={{ color: 'var(--text-primary)' }}>{decisionCfg.minScore}</b></span>
              <span style={{ marginRight: 14 }}>penFloor=<b style={{ color: '#f59e0b' }}>{decisionCfg.penaltyMinScore}</b></span>
              <span style={{ marginRight: 14 }}>gap=<b style={{ color: 'var(--text-primary)' }}>{decisionCfg.minScoreGap}</b></span>
              <span style={{ marginRight: 14 }}>move3=<b style={{ color: 'var(--text-primary)' }}>{decisionCfg.maxRecentMove3}%</b></span>
              <span style={{ marginRight: 14 }}>move5=<b style={{ color: 'var(--text-primary)' }}>{decisionCfg.maxRecentMove5}%</b></span>
              <span style={{ marginRight: 14 }}>vwapDist=<b style={{ color: 'var(--text-primary)' }}>{decisionCfg.maxAbsVwapDist}%</b></span>
              <span style={{ marginRight: 14 }}>minBars=<b style={{ color: 'var(--text-primary)' }}>{decisionCfg.minBarsSinceTrade}</b></span>
              <span style={{ marginRight: 14 }}>chop=<b style={{ color: 'var(--text-primary)' }}>{decisionCfg.chopFilter ? `ON(${decisionCfg.chopLookback})` : 'OFF'}</b></span>
              <span style={{ marginRight: 14 }}>switchConf=<b style={{ color: 'var(--text-primary)' }}>{switchCfg.switchConfirmationCandles}</b></span>
              <span style={{ marginRight: 14 }}>maxSwitch=<b style={{ color: 'var(--text-primary)' }}>{switchCfg.maxSwitchesPerDay}</b></span>
              <span style={{ marginRight: 14 }}>prem=<b style={{ color: 'var(--text-primary)' }}>{selectionCfg.minPremium}–{selectionCfg.maxPremium}</b></span>
              {regimeRules.enabled && (
                <>
                  <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                  <span style={{ marginRight: 6, fontWeight: 700, color: '#f59e0b' }}>RANGING</span>
                  <span style={{ marginRight: 14, color: '#f59e0b' }}>{regimeRules.rangingMinScore}/{regimeRules.rangingMinScoreGap}</span>
                  <span style={{ marginRight: 6, fontWeight: 700, color: '#22c55e' }}>TRENDING</span>
                  <span style={{ marginRight: 14, color: '#22c55e' }}>{regimeRules.trendingMinScore}/{regimeRules.trendingMinScoreGap}</span>
                  <span style={{ marginRight: 6, fontWeight: 700, color: '#0ea5e9' }}>COMPRESSION</span>
                  <span style={{ color: '#0ea5e9' }}>{regimeRules.compressionMinScore}/{regimeRules.compressionMinScoreGap}</span>
                </>
              )}
              {chopRules.enabled && (() => {
                const parts = [
                  { key: 'ranging', label: 'RAN', color: '#f59e0b' },
                  { key: 'trending', label: 'TRE', color: '#22c55e' },
                  { key: 'compression', label: 'COM', color: '#0ea5e9' },
                  { key: 'volatile', label: 'VOL', color: '#ef4444' },
                ].map(({ key: rk, label, color }) => {
                  const c = chopRules[rk];
                  return (
                    <span key={rk} style={{ marginRight: 10 }}>
                      <b style={{ color }}>{label}</b>
                      <span style={{ color: 'var(--text-muted)', marginLeft: 3 }}>{c.filterEnabled ? c.flipRatio : 'OFF'}</span>
                    </span>
                  );
                });
                return (
                  <>
                    <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                    <span style={{ marginRight: 8, fontWeight: 700, color: 'var(--text-primary)' }}>Chop:</span>
                    {parts}
                  </>
                );
              })()}
              {optsRegimeCfg.enabled && (
                <>
                  <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                  <span style={{ marginRight: 6, fontWeight: 700, color: 'var(--text-primary)' }}>Regime:</span>
                  <span style={{ marginRight: 14 }}>ADX(<b style={{ color: 'var(--text-primary)' }}>{optsRegimeCfg.adxPeriod}</b>)&gt;<b style={{ color: 'var(--text-primary)' }}>{optsRegimeCfg.adxTrendThreshold}</b></span>
                  <span style={{ marginRight: 14 }}>ATR(<b style={{ color: 'var(--text-primary)' }}>{optsRegimeCfg.atrPeriod}</b>) V&gt;<b style={{ color: 'var(--text-primary)' }}>{optsRegimeCfg.atrVolatilePct}%</b> C&lt;<b style={{ color: 'var(--text-primary)' }}>{optsRegimeCfg.atrCompressionPct}%</b></span>
                </>
              )}
              {tradingRules.enabled && (() => {
                const active = [
                  tradingRules.rangingNoTrade       && 'No RANGING',
                  tradingRules.volatileNoTrade      && 'No VOLATILE',
                  tradingRules.noSameCandleReversal && 'No Reversal',
                ].filter(Boolean);
                return active.length > 0 ? (
                  <>
                    <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                    <span style={{ marginRight: 6, fontWeight: 700, color: 'var(--text-primary)' }}>Rules:</span>
                    {active.map(r => (
                      <span key={r} style={{ marginRight: 10, color: '#ef4444', fontWeight: 600 }}>{r}</span>
                    ))}
                  </>
                ) : null;
              })()}
              {regimeStrategyRules.enabled && (
                <>
                  <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                  <span style={{ marginRight: 8, fontWeight: 700, color: 'var(--text-primary)' }}>StratRules:</span>
                  {[
                    { key: 'ranging',     label: 'RANGING',     color: '#f59e0b' },
                    { key: 'trending',    label: 'TRENDING',    color: '#22c55e' },
                    { key: 'compression', label: 'COMPRESSION', color: '#0ea5e9' },
                    { key: 'volatile',    label: 'VOLATILE',    color: '#ef4444' },
                  ].map(({ key: rk, label, color }) => {
                    const cfg = regimeStrategyRules[rk];
                    if (!cfg.enabled) return null;
                    const list = cfg.allowed.length > 0 ? cfg.allowed.map(s => s.replace(/_/g, ' ')).join(', ') : 'none';
                    return (
                      <span key={rk} style={{ marginRight: 14 }}>
                        <b style={{ color }}>{label}</b>
                        <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>[{list}]</span>
                      </span>
                    );
                  })}
                </>
              )}
              {rangeQuality.enabled && (
                <>
                  <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                  <span style={{ marginRight: 6, fontWeight: 700, color: '#f59e0b' }}>RngQ:</span>
                  <span style={{ marginRight: 10 }}>lbk=<b style={{ color: 'var(--text-primary)' }}>{rangeQuality.lookbackBars}</b></span>
                  <span style={{ marginRight: 10 }}>ut≥<b style={{ color: 'var(--text-primary)' }}>{rangeQuality.minUpperTouches}</b> lt≥<b style={{ color: 'var(--text-primary)' }}>{rangeQuality.minLowerTouches}</b></span>
                  <span style={{ marginRight: 10 }}>W=<b style={{ color: 'var(--text-primary)' }}>{rangeQuality.minRangeWidthPct}–{rangeQuality.maxRangeWidthPct}%</b></span>
                  <span style={{ marginRight: 10 }}>drift≤<b style={{ color: 'var(--text-primary)' }}>{rangeQuality.maxDirectionalDriftPctOfRange}</b></span>
                  {rangeQuality.enableChopCheck && <span style={{ marginRight: 10 }}>chop≤<b style={{ color: 'var(--text-primary)' }}>{rangeQuality.chopFlipRatioLimit}</b></span>}
                </>
              )}
              {optsRisk.enabled && (
                <>
                  <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                  <span style={{ marginRight: 8, fontWeight: 700, color: 'var(--text-primary)' }}>Risk:</span>
                  {optsRisk.stopLossPct     && <span style={{ marginRight: 10 }}>SL=<b style={{ color: '#ef4444' }}>{optsRisk.stopLossPct}%</b></span>}
                  {optsRisk.takeProfitPct   && <span style={{ marginRight: 10 }}>TP=<b style={{ color: '#22c55e' }}>{optsRisk.takeProfitPct}%</b></span>}
                  {optsRisk.maxRiskPerTradePct && <span style={{ marginRight: 10 }}>MaxRisk=<b style={{ color: 'var(--text-primary)' }}>{optsRisk.maxRiskPerTradePct}%</b></span>}
                  {optsRisk.dailyLossCapPct && <span style={{ marginRight: 10 }}>DailyCap=<b style={{ color: 'var(--text-primary)' }}>{optsRisk.dailyLossCapPct}%</b></span>}
                  {optsRisk.cooldownCandles && <span style={{ marginRight: 10 }}>Cooldown=<b style={{ color: 'var(--text-primary)' }}>{optsRisk.cooldownCandles}</b></span>}
                </>
              )}
              {tradeQuality.enabled && (
                <>
                  <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                  <span style={{ marginRight: 8, fontWeight: 700, color: '#22c55e' }}>TQ:</span>
                  <span style={{ marginRight: 10 }}>S≥<b style={{ color: '#22c55e' }}>{tradeQuality.strongScoreThreshold}</b></span>
                  <span style={{ marginRight: 10 }}>N≥<b style={{ color: '#0ea5e9' }}>{tradeQuality.normalScoreThreshold}</b></span>
                  <span style={{ marginRight: 10 }}>wkCool=<b style={{ color: 'var(--text-primary)' }}>{tradeQuality.weakTradeLossCooldown}</b></span>
                  <span style={{ marginRight: 10 }}>rngConf=<b style={{ color: 'var(--text-primary)' }}>{tradeQuality.rangingConfirmCandles}</b></span>
                  <span style={{ marginRight: 10 }}>trdConf=<b style={{ color: 'var(--text-primary)' }}>{tradeQuality.trendingConfirmCandles}</b></span>
                </>
              )}
              {trendEntry.enabled && (
                <>
                  <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                  <span style={{ marginRight: 8, fontWeight: 700, color: '#0ea5e9' }}>TrendEntry:</span>
                  <span style={{ marginRight: 10 }}>brkLbk=<b style={{ color: 'var(--text-primary)' }}>{trendEntry.breakoutLookback}</b></span>
                  <span style={{ marginRight: 10 }}>body≥<b style={{ color: 'var(--text-primary)' }}>{trendEntry.minBodyPct}%</b></span>
                  <span style={{ marginRight: 10 }}>weak&lt;<b style={{ color: '#ef4444' }}>{trendEntry.weakBodyPct}%</b></span>
                  <span style={{ marginRight: 10 }}>EMA<b style={{ color: 'var(--text-primary)' }}>{trendEntry.ema9Period}</b></span>
                </>
              )}
              {compressionEntry.enabled && (
                <>
                  <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                  <span style={{ marginRight: 8, fontWeight: 700, color: '#8b5cf6' }}>CmpEntry:</span>
                  <span style={{ marginRight: 10 }}>long≤<b style={{ color: 'var(--text-primary)' }}>{compressionEntry.longZoneMax}</b></span>
                  <span style={{ marginRight: 10 }}>short≥<b style={{ color: 'var(--text-primary)' }}>{compressionEntry.shortZoneMin}</b></span>
                  <span style={{ marginRight: 10 }}>noTrade[<b style={{ color: '#f59e0b' }}>{compressionEntry.noTradeZoneMin}–{compressionEntry.noTradeZoneMax}</b>]</span>
                </>
              )}
              {holdConfig.enabled && (
                <>
                  <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                  <span style={{ marginRight: 8, fontWeight: 700, color: '#14b8a6' }}>Hold:</span>
                  <span style={{ marginRight: 10 }}>def=<b style={{ color: 'var(--text-primary)' }}>{holdConfig.defaultMinHoldBars}</b></span>
                  <span style={{ marginRight: 10 }}>rng=<b style={{ color: 'var(--text-primary)' }}>{holdConfig.rangingMinHoldBars}</b></span>
                  <span style={{ marginRight: 10 }}>trd=<b style={{ color: 'var(--text-primary)' }}>{holdConfig.trendingMinHoldBars}</b></span>
                  <span style={{ marginRight: 10 }}>persist=<b style={{ color: 'var(--text-primary)' }}>{holdConfig.persistentExitBars}</b></span>
                </>
              )}
            </div>
            </div>

            {feed.length === 0
              ? <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>Feed will appear once the replay starts.</div>
              : (
                <div className="bt-opts-feed-wrap">
                  <table className="bt-opts-feed-table">
                    <thead>
                      <tr>
                        <th>Time</th><th>NIFTY</th><th>Regime</th><th>Bias</th><th>Conf</th>
                        <th>Winner</th><th>Score</th><th>PenScore</th><th>Str</th><th>2nd</th><th>Gap</th>
                        <th>Shadow</th><th>NeutralReason</th>
                        <th>State</th><th>Bars</th><th>Hold</th><th>Action</th><th>ExitRsn</th>
                        <th>Option</th><th>Opt Px</th><th>uPnL</th><th>rPnL</th><th>Block</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...feed].reverse().map((evt, i) => (
                        <tr key={i}>
                          <td className="de-mono">{(evt.niftyTime || '').slice(0, 16)}</td>
                          <td>{fmt2(evt.niftyClose)}</td>
                          <td>{evt.regime || '—'}</td>
                          <td style={{ color: evt.niftyBias === 'BULLISH' ? '#22c55e' : evt.niftyBias === 'BEARISH' ? '#ef4444' : undefined }}>{evt.niftyBias || '—'}</td>
                          <td style={{ color: evt.confirmedBias === 'BULLISH' ? '#22c55e' : evt.confirmedBias === 'BEARISH' ? '#ef4444' : undefined }}>{evt.confirmedBias || '—'}</td>
                          <td>{evt.winnerStrategy || '—'}</td>
                          <td>{fmt2(evt.winnerScore)}</td>
                          <td style={{ color: evt.penalizedScore != null && evt.penalizedScore < evt.winnerScore ? '#f59e0b' : undefined }}>{evt.penalizedScore != null && evt.penalizedScore !== evt.winnerScore ? fmt2(evt.penalizedScore) : '—'}</td>
                          <td style={{ fontSize: 11, fontWeight: 600, color: evt.tradeStrength === 'STRONG' ? '#22c55e' : evt.tradeStrength === 'NORMAL' ? '#0ea5e9' : evt.tradeStrength === 'WEAK' ? '#f59e0b' : undefined }}>{evt.tradeStrength && evt.tradeStrength !== 'NONE' ? evt.tradeStrength : '—'}</td>
                          <td style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{evt.secondStrategy ? `${evt.secondStrategy} ${fmt2(evt.secondScore)}` : '—'}</td>
                          <td>{fmt2(evt.scoreGap)}</td>
                          <td style={{ fontSize: 10, color: '#8b5cf6' }}>{evt.shadowWinner ? `${evt.shadowWinner} ${fmt2(evt.shadowWinnerScore)}` : '—'}</td>
                          <td style={{ fontSize: 10, color: evt.neutralReason ? '#f59e0b' : undefined }}>{evt.neutralReason || '—'}</td>
                          <td style={{ fontWeight: 600 }}>{evt.positionState || '—'}</td>
                          <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{evt.positionState !== 'FLAT' ? (evt.barsInTrade ?? '—') : ''}</td>
                          <td style={{ fontSize: 11, fontWeight: 600, color: '#14b8a6' }}>{evt.holdActive ? `🔒${evt.barsInTrade}/${evt.appliedMinHold}` : ''}</td>
                          <td style={{ color: evt.action === 'ENTERED' ? '#22c55e' : evt.action === 'EXITED' || evt.action === 'FORCE_CLOSED' ? '#f97316' : undefined }}>{evt.action || '—'}</td>
                          <td style={{ fontSize: 10, color: '#f97316' }}>{evt.exitReason || ''}</td>
                          <td className="de-mono">{evt.selectedTradingSymbol || '—'}</td>
                          <td>{fmt2(evt.optionClose)}</td>
                          <td style={pnlStyle(evt.unrealizedPnl)}>{fmt2(evt.unrealizedPnl)}</td>
                          <td style={pnlStyle(evt.realizedPnl)}>{fmt2(evt.realizedPnl)}</td>
                          <td style={{ color: evt.blockReason ? '#ef4444' : undefined, fontSize: 10 }}>{evt.blockReason || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="bt-opts-feed-count">{feed.length} candles received</div>
                </div>
              )
            }
          </>
        )}

        {/* ── Chart ── */}
        {rightTab === 'chart' && (
          <ReplayChart feed={feed} closedTrades={closedTrades} />
        )}

        {/* ── P&L ── */}
        {rightTab === 'pnl' && (
          <>
            {!summary && !lastEvt
              ? <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>P&L data will appear after the replay completes.</div>
              : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px 20px', marginBottom: 20 }}>
                    {[
                      ['Total P&L', lastEvt?.totalPnl ?? summary?.totalPnl, true],
                      ['Realized P&L', lastEvt?.realizedPnl ?? summary?.realizedPnl, true],
                      ['Unrealized P&L', lastEvt?.unrealizedPnl, true],
                      ['Capital', lastEvt?.capital ?? summary?.finalCapital, false],
                      ['Trades', closedTrades.length, false],
                      ['Wins', closedTrades.filter(t => t.pnl > 0).length, false],
                      ['Losses', closedTrades.filter(t => t.pnl < 0).length, false],
                      ['Win Rate', closedTrades.length > 0 ? `${(closedTrades.filter(t => t.pnl > 0).length / closedTrades.length * 100).toFixed(1)}%` : '—', false],
                    ].map(([lbl, val, isPnl]) => (
                      <div key={lbl} style={{ padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>{lbl}</div>
                        <div style={{ fontSize: 16, fontWeight: 700, ...(isPnl && val != null ? pnlStyle(val) : {}) }}>
                          {val != null ? (typeof val === 'number' ? fmt2(val) : val) : '—'}
                        </div>
                      </div>
                    ))}
                  </div>
                  {summary?.diagnostics && (() => {
                    const d = summary.diagnostics;
                    const neutralBreakdown = d.neutralReasonCounts || {};
                    return (
                      <div style={{ marginTop: 20 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Replay Diagnostics</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '6px 16px', marginBottom: 14 }}>
                          {[
                            ['Total Candles', d.totalCandles],
                            ['With Buy Candidate', d.candlesWithBuyCandidate],
                            ['With Sell Candidate', d.candlesWithSellCandidate],
                            ['With Eligible Candidate (≥minScore)', d.candlesWithEligibleCandidate],
                            ['Winner Selected', d.candlesWithWinner],
                            ['Stayed Neutral', d.candlesNeutral],
                            ['— No Signals (all HOLD)', d.candlesNoSignals],
                            ['— Below Score Threshold', d.candlesBlockedByScore],
                            ['— Score Gap Too Small', d.candlesBlockedByScoreGap],
                            ['Blocked by Recent Move', d.candlesBlockedByRecentMove],
                            ['Blocked by VWAP Dist', d.candlesBlockedByVwap],
                            ['Blocked by Chop Filter', d.candlesBlockedByChop],
                            ['Blocked by Penalty Score', d.candlesBlockedByPenalty],
                            ['Blocked by Trend Structure', d.candlesBlockedByTrendStructure],
                            ['Blocked by Compression Structure', d.candlesBlockedByCompressionStructure],
                          ].map(([lbl, val]) => (
                            <div key={lbl} style={{ fontSize: 12, padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 5 }}>
                              <span style={{ color: 'var(--text-secondary)' }}>{lbl}: </span>
                              <span style={{ fontWeight: 700 }}>{val ?? 0}</span>
                            </div>
                          ))}
                        </div>
                        {Object.keys(neutralBreakdown).length > 0 && (
                          <>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>Neutral reason breakdown:</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                              {Object.entries(neutralBreakdown).map(([reason, count]) => (
                                <span key={reason} style={{ fontSize: 11, padding: '3px 8px', background: 'var(--bg-tertiary)', borderRadius: 4, color: '#f59e0b' }}>
                                  {reason}: <strong>{count}</strong>
                                </span>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </>
              )
            }
          </>
        )}

        {/* ── Portfolio ── */}
        {rightTab === 'portfolio' && (
          <>
            {!lastEvt
              ? <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>Position data will appear once the replay starts.</div>
              : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px 20px' }}>
                  {[
                    ['Position State', lastEvt.positionState],
                    ['Desired Side', lastEvt.desiredSide],
                    ['Selected Option', lastEvt.selectedTradingSymbol],
                    ['Option Type', lastEvt.selectedOptionType],
                    ['Strike', lastEvt.selectedStrike],
                    ['Expiry', lastEvt.selectedExpiry],
                    ['Entry Price', fmt2(lastEvt.entryPrice)],
                    ['Current Price', fmt2(lastEvt.optionClose)],
                    ['Bars in Trade', lastEvt.barsInTrade],
                    ['Unrealized P&L', fmt2(lastEvt.unrealizedPnl)],
                    ['Realized P&L', fmt2(lastEvt.realizedPnl)],
                    ['Total P&L', fmt2(lastEvt.totalPnl)],
                    ['Capital', fmt2(lastEvt.capital)],
                    ['Bars Since Trade', lastEvt.barsSinceLastTrade],
                    ['Switch Count Today', lastEvt.switchCountToday],
                    ['Regime', lastEvt.regime],
                    ['NIFTY Bias', lastEvt.niftyBias],
                    ['Confirmed Bias', lastEvt.confirmedBias],
                    ['VWAP Dist %', fmt2(lastEvt.distanceFromVwap)],
                  ].map(([lbl, val]) => (
                    <div key={lbl} style={{ padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 3 }}>{lbl}</div>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{val ?? '—'}</div>
                    </div>
                  ))}
                </div>
              )
            }
          </>
        )}

        {/* ── Details (Closed Trades) ── */}
        {rightTab === 'details' && (
          <>
            {feed.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <button type="button" className="btn-secondary btn-xs" onClick={downloadCSV}>Download CSV</button>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{closedTrades.length} trades · {feed.length} candles</span>
              </div>
            )}
            {closedTrades.length === 0
              ? <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>Closed trades will appear here as the replay runs.</div>
              : (
                <div className="bt-opts-feed-wrap">
                  <table className="bt-opts-feed-table">
                    <thead>
                      <tr>
                        <th>Entry Time</th><th>Exit Time</th><th>Type</th><th>Symbol</th>
                        <th>Strike</th><th>Expiry</th><th>Entry Px</th><th>Exit Px</th>
                        <th>Qty</th><th>P&L</th><th>P&L %</th><th>Bars</th><th>Exit Reason</th><th>Capital After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closedTrades.map((t, i) => (
                        <tr key={i}>
                          <td className="de-mono">{(t.entryTime || '').slice(0, 16)}</td>
                          <td className="de-mono">{(t.exitTime  || '').slice(0, 16)}</td>
                          <td style={{ color: t.optionType === 'CE' ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{t.optionType}</td>
                          <td className="de-mono">{t.tradingSymbol}</td>
                          <td>{t.strike}</td>
                          <td>{t.expiry}</td>
                          <td>{fmt2(t.entryPrice)}</td>
                          <td>{fmt2(t.exitPrice)}</td>
                          <td>{t.quantity}</td>
                          <td style={pnlStyle(t.pnl)}>{fmt2(t.pnl)}</td>
                          <td style={pnlStyle(t.pnlPct)}>{t.pnlPct != null ? `${Number(t.pnlPct).toFixed(1)}%` : '—'}</td>
                          <td>{t.barsInTrade}</td>
                          <td style={{ fontSize: 10 }}>{t.exitReason}</td>
                          <td>{fmt2(t.capitalAfter)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </>
        )}
      </div>

      <form onSubmit={handleSubmit}>

        {/* ── Actions ── */}
        {initInfo && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 4 }}>
            Data loaded — <strong>{initInfo.warmupCandles}</strong> warmup candles + <strong>{initInfo.totalCandles}</strong> replay candles
            {initInfo.totalCandles === 0 && <span style={{ color: '#ef4444', marginLeft: 8 }}>No replay data found for the selected date range.</span>}
          </div>
        )}
        {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="form-actions" style={{ marginBottom: 16 }}>
          <button type="submit" className="btn-primary" disabled={!canRun && !isRunning}>
            {isRunning ? 'Stop Replay' : 'Start Options Replay'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => {
            setFeed([]); setSummary(null); setError(''); setStatus('idle');
            setNifty({ symbol: '', exchange: 'NSE', instrumentToken: '' });
            setCePool([EMPTY_OPTION_INST()]); setPePool([EMPTY_OPTION_INST()]);
            setStrategies(defaultStrategies());
            setDecisionCfg(DEFAULT_DECISION); setSelectionCfg(DEFAULT_SELECTION); setSwitchCfg(DEFAULT_SWITCH);
            setOptsRegimeCfg(DEFAULT_OPTS_REGIME_CONFIG); setChopRules(DEFAULT_CHOP_RULES); setTradingRules(DEFAULT_TRADING_RULES); setRegimeRules(DEFAULT_REGIME_RULES); setRegimeStrategyRules(DEFAULT_REGIME_STRATEGY_RULES); setOptsRisk(DEFAULT_OPTS_RISK); setRangeQuality(DEFAULT_RANGE_QUALITY);
            setTradeQuality(DEFAULT_TRADE_QUALITY); setTrendEntry(DEFAULT_TREND_ENTRY); setCompressionEntry(DEFAULT_COMPRESSION_ENTRY); setHoldConfig(DEFAULT_HOLD);
            setInterval('MINUTE_5'); setFromDate(''); setToDate(''); setWarmupDays('5'); setSpeed('1'); setQuantity('0'); setCapital('100000');
            ['sma_opts_nifty','sma_opts_ce_pool','sma_opts_pe_pool','sma_opts_interval','sma_opts_from','sma_opts_to',
             'sma_opts_warmup','sma_opts_speed','sma_opts_qty','sma_opts_capital','sma_opts_strategies',
             'sma_opts_decision','sma_opts_selection','sma_opts_switch','sma_opts_regime_cfg',
             'sma_opts_chop_rules','sma_opts_trading_rules','sma_opts_regime_rules',
             'sma_opts_regime_strat_rules','sma_opts_risk','sma_opts_range_quality','sma_opts_trade_quality',
             'sma_opts_trend_entry','sma_opts_compression_entry','sma_opts_hold_config'].forEach(k => localStorage.removeItem(k));
          }} disabled={isRunning}>
            Reset
          </button>
          {status === 'completed' && <span className="badge badge-success">Completed</span>}
          {status === 'error'     && <span className="badge badge-danger">Error</span>}
          {feed.length > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 8 }}>
              {feed.length} candles · {closedTrades.length} trades
            </span>
          )}
        </div>

        {/* ── Replay Settings ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Replay Settings</span>
          <div className="bt-form-grid" style={{ marginTop: 12 }}>
            <div className="form-group">
              <label>Interval</label>
              <select value={interval} onChange={e => setInterval(e.target.value)} disabled={isRunning}>
                {OPT_INTERVALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>From Date *</label>
              <input type="date" value={fromDate.split('T')[0] || ''} required disabled={isRunning}
                onChange={e => setFromDate(`${e.target.value}T09:15`)} />
            </div>
            <div className="form-group">
              <label>To Date *</label>
              <input type="date" value={toDate.split('T')[0] || ''} required disabled={isRunning}
                onChange={e => setToDate(`${e.target.value}T15:30`)} />
            </div>
          </div>
          {recentDates.length > 0 && (
            <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 2 }}>Recent:</span>
              {recentDates.map(d => (
                <button key={d} type="button" disabled={isRunning}
                  className={fromDate.startsWith(d) && toDate.startsWith(d) ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                  onClick={() => { setFromDate(`${d}T09:15`); setToDate(`${d}T15:30`); }}>
                  {d}
                </button>
              ))}
            </div>
          )}
          <div className="bt-form-grid" style={{ marginTop: 12 }}>
            <div className="form-group">
              <label>Warmup Days</label>
              <input type="number" min="1" max="30" value={warmupDays} onChange={e => setWarmupDays(e.target.value)} disabled={isRunning} />
            </div>
            <div className="form-group">
              <label>Speed (candles/sec)</label>
              <input type="number" min="1" max="1000" value={speed} onChange={e => setSpeed(e.target.value)} disabled={isRunning} />
            </div>
            <div className="form-group">
              <label>Quantity (lots)</label>
              <input type="number" min="0" value={quantity} onChange={e => setQuantity(e.target.value)} disabled={isRunning} />
            </div>
            <div className="form-group">
              <label>Initial Capital (₹)</label>
              <input type="number" min="0" value={capital} onChange={e => setCapital(e.target.value)} disabled={isRunning} />
            </div>
          </div>
        </div>

        {/* ── NIFTY Source ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">NIFTY Instrument (Decision Source)</span>
          <p className="bt-section-sub" style={{ marginBottom: 10 }}>
            Strategies run exclusively on NIFTY candles. Options are only used for execution pricing.
          </p>
          <InstrumentPicker
            session={session}
            symbol={nifty.symbol}
            exchange={nifty.exchange}
            instrumentToken={nifty.instrumentToken}
            onSelect={r => { setNifty({ symbol: r.tradingSymbol, exchange: r.exchange, instrumentToken: String(r.instrumentToken) }); saveRecentInstrument(r); }}
            onChange={patch => setNifty(p => ({ ...p, ...patch }))}
            disabled={isRunning}
          />
        </div>

        {/* ── Option Pools ── */}
        {[
          { label: 'CE Pool', pool: cePool, setPool: setCePool, tag: 'CE' },
          { label: 'PE Pool', pool: pePool, setPool: setPePool, tag: 'PE' },
        ].map(({ label, pool, setPool, tag }) => (
          <div key={tag} className="card bt-opts-card">
            <div className="bt-opts-legs-header">
              <span className="bt-section-title">{label}</span>
              <button type="button" className="btn-secondary btn-sm" onClick={() => addPoolInst(setPool)} disabled={isRunning}>
                + Add
              </button>
            </div>
            <p className="bt-section-sub" style={{ marginBottom: 10 }}>
              Add {tag} contracts to select from. The engine picks the best-fit instrument each candle based on premium and ATM proximity.
            </p>
            {pool.map((inst) => (
              <div key={inst.id} className="bt-opts-leg-block">
                <div className="bt-opts-leg-topbar">
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>{tag}</span>
                  {pool.length > 1 && (
                    <button type="button" className="btn-danger btn-sm" onClick={() => removePoolInst(pool, setPool, inst.id)} disabled={isRunning}>✕</button>
                  )}
                </div>
                <InstrumentPicker
                  session={session}
                  symbol={inst.symbol}
                  exchange={inst.exchange}
                  instrumentToken={inst.instrumentToken}
                  onSelect={r => { updatePoolInst(pool, setPool, inst.id, { symbol: r.tradingSymbol, exchange: r.exchange, instrumentToken: String(r.instrumentToken) }); saveRecentInstrument(r); }}
                  onChange={patch => updatePoolInst(pool, setPool, inst.id, patch)}
                  disabled={isRunning}
                />
              </div>
            ))}
          </div>
        ))}

        {/* ── Decision Config ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Decision Config</span>
          <p className="bt-section-sub" style={{ marginBottom: 10 }}>
            Filters apply penalties to the winner score. Only no-signal and score&lt;15 are hard blocks. Trade allowed if penalized score ≥ Penalty Min Score.
          </p>
          <div className="bt-form-grid" style={{ marginTop: 8 }}>
            {[
              ['minScore',          'Min Score',          'Minimum winning strategy score to select a winner (0–100)'],
              ['minScoreGap',       'Min Score Gap',      'Gap between top-2 strategies required'],
              ['penaltyMinScore',   'Penalty Min Score',  'Floor after penalties applied. Trade allowed if penalized score ≥ this (move=-5, vwap=-5, chop=-8, drift=-10)'],
              ['maxRecentMove3',    'Max 3-bar Move %',   'Penalty -5 if NIFTY moved > X% in last 3 bars'],
              ['maxRecentMove5',    'Max 5-bar Move %',   'Penalty -5 if NIFTY moved > X% in last 5 bars'],
              ['maxAbsVwapDist',    'Max VWAP Dist %',    'Penalty -5 if NIFTY is > X% away from intraday VWAP'],
              ['minBarsSinceTrade', 'Min Bars Since Trade','Cooldown after last trade (bars)'],
              ['chopLookback',      'Chop Lookback',      'Bars used for chop detection (penalty -8 if choppy)'],
            ].map(([key, lbl, hint]) => (
              <div key={key} className="form-group" title={hint}>
                <label>{lbl}</label>
                <input type="number" step="any" value={decisionCfg[key]} onChange={e => setDecisionCfg(p => ({ ...p, [key]: e.target.value }))} disabled={isRunning} />
              </div>
            ))}
            <div className="form-group">
              <label>Chop Filter</label>
              <select value={decisionCfg.chopFilter ? 'on' : 'off'} onChange={e => setDecisionCfg(p => ({ ...p, chopFilter: e.target.value === 'on' }))} disabled={isRunning}>
                <option value="on">ON</option>
                <option value="off">OFF</option>
              </select>
            </div>
          </div>
        </div>

        {/* ── Chop Filter Regime Rules ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Chop Filter Regime Rules</span>
            <button type="button"
              className={`btn-sm ${chopRules.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setChopRules(p => ({ ...p, enabled: !p.enabled }))}
              disabled={isRunning}>
              {chopRules.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: chopRules.enabled ? 12 : 0 }}>
            Override the global chop filter per regime. Disable it in TRENDING (trending markets oscillate naturally), or raise the flip ratio to soften it (higher = less sensitive).
          </p>
          {chopRules.enabled && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {[
                { key: 'ranging',     label: 'RANGING',     color: '#f59e0b' },
                { key: 'trending',    label: 'TRENDING',    color: '#22c55e' },
                { key: 'compression', label: 'COMPRESSION', color: '#0ea5e9' },
                { key: 'volatile',    label: 'VOLATILE',    color: '#ef4444' },
              ].map(({ key: rk, label, color }) => (
                <div key={rk} style={{ padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 7, borderLeft: `3px solid ${color}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</span>
                    <button type="button" disabled={isRunning}
                      className={`btn-xs ${chopRules[rk].filterEnabled ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setChopRules(p => ({ ...p, [rk]: { ...p[rk], filterEnabled: !p[rk].filterEnabled } }))}>
                      {chopRules[rk].filterEnabled ? 'Filter ON' : 'Disabled'}
                    </button>
                  </div>
                  {chopRules[rk].filterEnabled && (
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Flip Ratio <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(0.5 strict · 0.65 normal · 0.8+ soft)</span></label>
                      <input type="number" min="0.1" max="1.0" step="0.05" disabled={isRunning}
                        value={chopRules[rk].flipRatio}
                        onChange={e => setChopRules(p => ({ ...p, [rk]: { ...p[rk], flipRatio: e.target.value } }))} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Market Regime Detection ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Market Regime Detection</span>
            <button type="button"
              className={`btn-sm ${optsRegimeCfg.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setOptsRegimeCfg(p => ({ ...p, enabled: !p.enabled }))}
              disabled={isRunning}>
              {optsRegimeCfg.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: optsRegimeCfg.enabled ? 12 : 0 }}>
            {optsRegimeCfg.enabled
              ? `ADX(${optsRegimeCfg.adxPeriod}) trend >${optsRegimeCfg.adxTrendThreshold} · ATR(${optsRegimeCfg.atrPeriod}) volatile >${optsRegimeCfg.atrVolatilePct}% compress <${optsRegimeCfg.atrCompressionPct}%`
              : 'OFF — every candle is RANGING. Enable to classify candles as TRENDING / VOLATILE / COMPRESSION / RANGING.'}
          </p>
          {optsRegimeCfg.enabled && (
            <>
              <div className="bt-form-grid">
                {[
                  ['adxPeriod',          'ADX Period',           2,    null, 1,    'Lookback for ADX indicator'],
                  ['atrPeriod',          'ATR Period',           2,    null, 1,    'Lookback for ATR indicator'],
                  ['adxTrendThreshold',  'ADX Trend Threshold',  1,    100,  0.5,  'ADX above this → TRENDING'],
                  ['atrVolatilePct',     'ATR Volatile %',       0,    null, 0.1,  'ATR/close% above this → VOLATILE'],
                  ['atrCompressionPct',  'ATR Compression %',    0,    null, 0.05, 'ATR/close% below this → COMPRESSION'],
                ].map(([key, lbl, min, max, step, hint]) => (
                  <div key={key} className="form-group" title={hint}>
                    <label>{lbl}</label>
                    <input type="number" min={min} max={max ?? undefined} step={step}
                      value={optsRegimeCfg[key]}
                      onChange={e => setOptsRegimeCfg(p => ({ ...p, [key]: e.target.value }))}
                      disabled={isRunning} />
                    <small className="bt-risk-hint">{hint}</small>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                <b style={{ color: 'var(--text-secondary)' }}>TRENDING</b> — strong directional move (ADX high) &nbsp;·&nbsp;
                <b style={{ color: 'var(--text-secondary)' }}>VOLATILE</b> — large swings, no clear direction (ATR% high) &nbsp;·&nbsp;
                <b style={{ color: 'var(--text-secondary)' }}>COMPRESSION</b> — tight range / squeeze (ATR% low) &nbsp;·&nbsp;
                <b style={{ color: 'var(--text-secondary)' }}>RANGING</b> — everything else
              </div>
            </>
          )}
        </div>

        {/* ── Selection Config ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Option Selection Config</span>
          <p className="bt-section-sub" style={{ marginBottom: 10 }}>
            Premium band filter applied each candle when selecting from CE/PE pool.
          </p>
          <div className="bt-form-grid" style={{ marginTop: 8 }}>
            <div className="form-group">
              <label>Min Premium (₹)</label>
              <input type="number" step="any" value={selectionCfg.minPremium} onChange={e => setSelectionCfg(p => ({ ...p, minPremium: e.target.value }))} disabled={isRunning} />
            </div>
            <div className="form-group">
              <label>Max Premium (₹)</label>
              <input type="number" step="any" value={selectionCfg.maxPremium} onChange={e => setSelectionCfg(p => ({ ...p, maxPremium: e.target.value }))} disabled={isRunning} />
            </div>
          </div>
        </div>

        {/* ── Switch Config ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Switch Config</span>
          <p className="bt-section-sub" style={{ marginBottom: 10 }}>
            Controls CE→PE or PE→CE switching. A switch requires N consecutive confirming candles.
          </p>
          <div className="bt-form-grid" style={{ marginTop: 8 }}>
            <div className="form-group">
              <label>Confirmation Candles</label>
              <input type="number" min="1" max="20" value={switchCfg.switchConfirmationCandles} onChange={e => setSwitchCfg(p => ({ ...p, switchConfirmationCandles: e.target.value }))} disabled={isRunning} />
            </div>
            <div className="form-group">
              <label>Max Switches / Day</label>
              <input type="number" min="0" max="20" value={switchCfg.maxSwitchesPerDay} onChange={e => setSwitchCfg(p => ({ ...p, maxSwitchesPerDay: e.target.value }))} disabled={isRunning} />
            </div>
            <div className="form-group">
              <label title="New winner score must exceed the score at prior confirmation by this amount. 0 = disabled.">Min Score Improvement for Switch</label>
              <input type="number" min="0" max="50" step="1" value={switchCfg.minScoreImprovementForSwitch} onChange={e => setSwitchCfg(p => ({ ...p, minScoreImprovementForSwitch: e.target.value }))} disabled={isRunning} />
            </div>
          </div>
        </div>

        {/* ── Trading Rules ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Trading Rules</span>
            <button type="button"
              className={`btn-sm ${tradingRules.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setTradingRules(p => ({ ...p, enabled: !p.enabled }))}
              disabled={isRunning}>
              {tradingRules.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: tradingRules.enabled ? 10 : 0 }}>
            Hard rules applied after the decision engine — block entries regardless of score.
          </p>
          {tradingRules.enabled && (
            <>
              {[
                ['rangingNoTrade',       'No trade in RANGING regime'],
                ['volatileNoTrade',      'No trade in VOLATILE regime'],
                ['noSameCandleReversal', 'No same-candle reversal (CE→PE or PE→CE in one bar)'],
              ].map(([key, lbl]) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, paddingRight: 12 }}>{lbl}</span>
                  <button type="button" disabled={isRunning}
                    className={tradingRules[key] ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
                    style={{ minWidth: 36 }}
                    onClick={() => setTradingRules(p => ({ ...p, [key]: !p[key] }))}>
                    {tradingRules[key] ? 'ON' : 'OFF'}
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        {/* ── Regime Score Rules ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Regime Score Rules</span>
            <button type="button"
              className={`btn-sm ${regimeRules.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setRegimeRules(p => ({ ...p, enabled: !p.enabled }))}
              disabled={isRunning}>
              {regimeRules.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: 12 }}>
            Override <code>minScore</code> and <code>minScoreGap</code> per regime. In TRENDING / COMPRESSION the engine needs less certainty to fire; in RANGING it stays slightly selective. Falls back to Decision Config values for VOLATILE.
          </p>
          {regimeRules.enabled && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
              {[
                { regime: 'RANGING',     scoreKey: 'rangingMinScore',     gapKey: 'rangingMinScoreGap',     color: '#f59e0b' },
                { regime: 'TRENDING',    scoreKey: 'trendingMinScore',    gapKey: 'trendingMinScoreGap',    color: '#22c55e' },
                { regime: 'COMPRESSION', scoreKey: 'compressionMinScore', gapKey: 'compressionMinScoreGap', color: '#0ea5e9' },
              ].map(({ regime: r, scoreKey, gapKey, color }) => (
                <div key={r} style={{ padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 7, borderLeft: `3px solid ${color}` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>{r}</div>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                      <label>Min Score</label>
                      <input type="number" step="1" min="0" max="100"
                        value={regimeRules[scoreKey]}
                        onChange={e => setRegimeRules(p => ({ ...p, [scoreKey]: e.target.value }))}
                        disabled={isRunning} />
                    </div>
                    <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                      <label>Min Score Gap</label>
                      <input type="number" step="1" min="0" max="50"
                        value={regimeRules[gapKey]}
                        onChange={e => setRegimeRules(p => ({ ...p, [gapKey]: e.target.value }))}
                        disabled={isRunning} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Regime Strategy Rules ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Regime Strategy Rules</span>
            <button type="button"
              className={`btn-sm ${regimeStrategyRules.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setRegimeStrategyRules(p => ({ ...p, enabled: !p.enabled }))}
              disabled={isRunning}>
              {regimeStrategyRules.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: 12 }}>
            Restrict which strategies can fire signals in each regime. Unchecked strategies are silenced for that regime. Disabled regime = all strategies allowed.
          </p>
          {regimeStrategyRules.enabled && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
              {[
                { key: 'ranging',     label: 'RANGING',     color: '#f59e0b' },
                { key: 'trending',    label: 'TRENDING',    color: '#22c55e' },
                { key: 'compression', label: 'COMPRESSION', color: '#0ea5e9' },
                { key: 'volatile',    label: 'VOLATILE',    color: '#ef4444' },
              ].map(({ key: rk, label, color }) => (
                <div key={rk} style={{ padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 7, borderLeft: `3px solid ${color}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</span>
                    <button type="button"
                      className={`btn-xs ${regimeStrategyRules[rk].enabled ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setRegimeStrategyRules(p => ({ ...p, [rk]: { ...p[rk], enabled: !p[rk].enabled } }))}
                      disabled={isRunning}>
                      {regimeStrategyRules[rk].enabled ? 'Filter ON' : 'All allowed'}
                    </button>
                  </div>
                  {regimeStrategyRules[rk].enabled && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {ALL_STRATEGY_TYPES.map(st => {
                        const checked = regimeStrategyRules[rk].allowed.includes(st);
                        return (
                          <label key={st} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, cursor: isRunning ? 'default' : 'pointer', color: checked ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                            <input type="checkbox" checked={checked} disabled={isRunning}
                              onChange={() => setRegimeStrategyRules(p => {
                                const prev = p[rk].allowed;
                                const next = prev.includes(st) ? prev.filter(x => x !== st) : [...prev, st];
                                return { ...p, [rk]: { ...p[rk], allowed: next } };
                              })} />
                            {st}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Range Quality Filter ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Range Quality Filter</span>
            <button type="button"
              className={`btn-sm ${rangeQuality.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateRangeQuality('enabled', !rangeQuality.enabled)}
              disabled={isRunning}>
              {rangeQuality.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>RANGING only</span>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: rangeQuality.enabled ? 12 : 0 }}>
            {rangeQuality.enabled
              ? `lbk=${rangeQuality.lookbackBars} · ut≥${rangeQuality.minUpperTouches} lt≥${rangeQuality.minLowerTouches} · W=${rangeQuality.minRangeWidthPct}–${rangeQuality.maxRangeWidthPct}% · drift≤${rangeQuality.maxDirectionalDriftPctOfRange} · chop≤${rangeQuality.chopFlipRatioLimit}`
              : 'Block RANGING entries when Bollinger bands show no clean range structure (poor touches, drift, chop, or wrong width).'}
          </p>
          {rangeQuality.enabled && (
            <>
              <div className="bt-form-grid" style={{ marginTop: 4 }}>
                {[
                  ['Lookback Bars',       'lookbackBars',                  '1',   null],
                  ['Min Upper Touches',   'minUpperTouches',               '1',   null],
                  ['Min Lower Touches',   'minLowerTouches',               '1',   null],
                  ['Band Touch Tol %',    'bandTouchTolerancePct',         '0.01','100'],
                  ['Min Range Width %',   'minRangeWidthPct',              '0.01','100'],
                  ['Max Range Width %',   'maxRangeWidthPct',              '0.01','100'],
                  ['Max Drift Ratio',     'maxDirectionalDriftPctOfRange', '0.01','1'  ],
                  ['Chop Flip Limit',     'chopFlipRatioLimit',            '0.01','1'  ],
                ].map(([label, key, step, max]) => (
                  <div className="form-group" key={key}>
                    <label>{label}</label>
                    <input type="number" min="0" max={max || undefined} step={step}
                      value={rangeQuality[key]} disabled={isRunning}
                      onChange={e => updateRangeQuality(key, e.target.value)} />
                  </div>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 8, cursor: isRunning ? 'default' : 'pointer' }}>
                <input type="checkbox" checked={rangeQuality.enableChopCheck} disabled={isRunning}
                  onChange={e => updateRangeQuality('enableChopCheck', e.target.checked)} />
                Enable chop flip check
              </label>
            </>
          )}
        </div>

        {/* ── Risk Management ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Risk Management</span>
            <button type="button"
              className={`btn-sm ${optsRisk.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateOptsRisk('enabled', !optsRisk.enabled)}
              disabled={isRunning}>
              {optsRisk.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: optsRisk.enabled ? 12 : 0 }}>
            {optsRisk.enabled
              ? `SL ${optsRisk.stopLossPct}% · TP ${optsRisk.takeProfitPct}% · max risk ${optsRisk.maxRiskPerTradePct}%/trade · daily cap ${optsRisk.dailyLossCapPct}% · cooldown ${optsRisk.cooldownCandles} bars`
              : 'Stop-loss, take-profit, position sizing, daily loss cap and cooldown after losing trades.'}
          </p>
          {optsRisk.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['Stop Loss %',         'stopLossPct',        '0.1', '100'],
                ['Take Profit %',       'takeProfitPct',      '0.1', null ],
                ['Max Risk / Trade %',  'maxRiskPerTradePct', '0.1', '100'],
                ['Daily Loss Cap %',    'dailyLossCapPct',    '0.1', '100'],
                ['Cooldown Candles',    'cooldownCandles',    '1',   null ],
              ].map(([label, key, step, max]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="0" max={max || undefined} step={step}
                    value={optsRisk[key]} disabled={isRunning}
                    onChange={e => updateOptsRisk(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Trade Quality ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Trade Quality</span>
            <button type="button"
              className={`btn-sm ${tradeQuality.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateTradeQuality('enabled', !tradeQuality.enabled)}
              disabled={isRunning}>
              {tradeQuality.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: tradeQuality.enabled ? 12 : 0 }}>
            {tradeQuality.enabled
              ? `STRONG≥${tradeQuality.strongScoreThreshold} · NORMAL≥${tradeQuality.normalScoreThreshold} · WEAK cooldown ${tradeQuality.weakTradeLossCooldown} bars · rngConf=${tradeQuality.rangingConfirmCandles} trdConf=${tradeQuality.trendingConfirmCandles}`
              : 'Score tiers (STRONG/NORMAL/WEAK), block WEAK trades after losses or in RANGING, regime-based confirmation candles.'}
          </p>
          {tradeQuality.enabled && (
            <>
              <div className="bt-form-grid" style={{ marginTop: 4 }}>
                {[
                  ['Strong Score ≥',         'strongScoreThreshold',  '1', null],
                  ['Normal Score ≥',         'normalScoreThreshold',  '1', null],
                  ['Weak Loss Cooldown',      'weakTradeLossCooldown', '1', null],
                  ['RANGING Confirm Candles', 'rangingConfirmCandles', '1', null],
                  ['TRENDING Confirm Candles','trendingConfirmCandles','1', null],
                ].map(([label, key, step]) => (
                  <div className="form-group" key={key}>
                    <label>{label}</label>
                    <input type="number" min="0" step={step}
                      value={tradeQuality[key]} disabled={isRunning}
                      onChange={e => updateTradeQuality(key, e.target.value)} />
                  </div>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 8, cursor: isRunning ? 'default' : 'pointer' }}>
                <input type="checkbox" checked={tradeQuality.blockWeakInRanging} disabled={isRunning}
                  onChange={e => updateTradeQuality('blockWeakInRanging', e.target.checked)} />
                Block WEAK trades in RANGING regime
              </label>
            </>
          )}
        </div>

        {/* ── Trending Entry Structure ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Trending Entry Structure</span>
            <button type="button"
              className={`btn-sm ${trendEntry.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateTrendEntry('enabled', !trendEntry.enabled)}
              disabled={isRunning}>
              {trendEntry.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#0ea5e9', fontWeight: 600 }}>TRENDING only</span>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: trendEntry.enabled ? 12 : 0 }}>
            {trendEntry.enabled
              ? `Breakout lbk=${trendEntry.breakoutLookback} · body≥${trendEntry.minBodyPct}% (weak<${trendEntry.weakBodyPct}%) · EMA${trendEntry.ema9Period} slope`
              : 'Block TRENDING entries without a breakout, strong candle, or momentum + EMA slope confirmation.'}
          </p>
          {trendEntry.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['Breakout Lookback',  'breakoutLookback', '1', null ],
                ['Min Body %',         'minBodyPct',       '1', '100'],
                ['Weak Body % (block)','weakBodyPct',      '1', '100'],
                ['EMA Period',         'ema9Period',       '1', null ],
              ].map(([label, key, step, max]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="0" max={max || undefined} step={step}
                    value={trendEntry[key]} disabled={isRunning}
                    onChange={e => updateTrendEntry(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Compression Entry Structure ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Compression Entry Structure</span>
            <button type="button"
              className={`btn-sm ${compressionEntry.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateCompressionEntry('enabled', !compressionEntry.enabled)}
              disabled={isRunning}>
              {compressionEntry.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#8b5cf6', fontWeight: 600 }}>COMPRESSION only</span>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: compressionEntry.enabled ? 12 : 0 }}>
            {compressionEntry.enabled
              ? `rangePos: long≤${compressionEntry.longZoneMax} short≥${compressionEntry.shortZoneMin} · no-trade [${compressionEntry.noTradeZoneMin}–${compressionEntry.noTradeZoneMax}] · lbk=${compressionEntry.rangeLookback}`
              : 'Only enter COMPRESSION trades at range extremes (mean reversion). Block mid-range and breakout candles.'}
          </p>
          {compressionEntry.enabled && (
            <>
              <div className="bt-form-grid" style={{ marginTop: 4 }}>
                {[
                  ['Range Lookback',    'rangeLookback',  '1',    null],
                  ['Long Zone Max',     'longZoneMax',    '0.05', '1' ],
                  ['Short Zone Min',    'shortZoneMin',   '0.05', '1' ],
                  ['No-Trade Zone Min', 'noTradeZoneMin', '0.05', '1' ],
                  ['No-Trade Zone Max', 'noTradeZoneMax', '0.05', '1' ],
                ].map(([label, key, step, max]) => (
                  <div className="form-group" key={key}>
                    <label>{label}</label>
                    <input type="number" min="0" max={max || undefined} step={step}
                      value={compressionEntry[key]} disabled={isRunning}
                      onChange={e => updateCompressionEntry(key, e.target.value)} />
                  </div>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 8, cursor: isRunning ? 'default' : 'pointer' }}>
                <input type="checkbox" checked={compressionEntry.rejectBreakoutCandle} disabled={isRunning}
                  onChange={e => updateCompressionEntry('rejectBreakoutCandle', e.target.checked)} />
                Reject breakout candles (price exceeds range boundaries)
              </label>
            </>
          )}
        </div>

        {/* ── Hold Config ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Minimum Hold Period</span>
            <button type="button"
              className={`btn-sm ${holdConfig.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateHoldConfig('enabled', !holdConfig.enabled)}
              disabled={isRunning}>
              {holdConfig.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: holdConfig.enabled ? 12 : 0 }}>
            {holdConfig.enabled
              ? `Default hold=${holdConfig.defaultMinHoldBars} · RANGING=${holdConfig.rangingMinHoldBars} · TRENDING=${holdConfig.trendingMinHoldBars} · persist=${holdConfig.persistentExitBars} bars · earlyExit score≥${holdConfig.strongOppositeScore}`
              : 'Prevent premature exits after entry. Ignore neutral signals during the hold window; only exit early on a strong opposite signal.'}
          </p>
          {holdConfig.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                { key: 'defaultMinHoldBars',  label: 'Default Min Hold',    step: '1' },
                { key: 'rangingMinHoldBars',  label: 'RANGING Min Hold',    step: '1' },
                { key: 'trendingMinHoldBars', label: 'TRENDING Min Hold',   step: '1' },
                { key: 'strongOppositeScore', label: 'Strong Opp Score',    step: '1' },
                { key: 'persistentExitBars',  label: 'Persistent Exit Bars',step: '1' },
              ].map(({ key, label, step }) => (
                <div key={key} className="form-group">
                  <label>{label}</label>
                  <input type="number" min="0" step={step}
                    value={holdConfig[key]} disabled={isRunning}
                    onChange={e => updateHoldConfig(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Strategy Selector ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Strategies (on NIFTY)</span>
          <p className="bt-section-sub" style={{ marginBottom: 12 }}>
            All enabled strategies compete each NIFTY candle. The highest-scoring bias wins.
          </p>
          <div className="bt-variants-grid">
            {strategies.map((s, idx) => {
              const color = STRATEGY_COLORS[s.strategyType] || '#6366f1';
              const paramDefs = PARAM_DEFS[s.strategyType] || [];
              return (
                <div key={s.strategyType} className={`bt-variant-card ${!s.enabled ? 'bt-variant-disabled' : ''}`} style={{ '--variant-color': color }}>
                  <div className="bt-variant-header">
                    <label className="bt-variant-toggle">
                      <input type="checkbox" checked={s.enabled} onChange={e => updateStrategy(idx, { enabled: e.target.checked })} disabled={isRunning} />
                      <span className="bt-variant-index" style={{ background: color }}>{s.strategyType.replace(/_/g, ' ')}</span>
                    </label>
                  </div>
                  {s.enabled && paramDefs.length > 0 && (
                    <div className="bt-params-block">
                      {paramDefs.map(def => (
                        <div key={def.key} className="bt-param-row">
                          <label className="bt-param-label" title={def.hint}>{def.label}</label>
                          <input type="number" className="bt-param-input" value={s.parameters[def.key] || ''} onChange={e => updateStratParam(idx, def.key, e.target.value)} placeholder={def.placeholder} disabled={isRunning} />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

      </form>
    </div>
  );
}

