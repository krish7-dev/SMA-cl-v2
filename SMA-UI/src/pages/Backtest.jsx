import { useState, useEffect, useRef, useMemo } from 'react';
import {
  getStrategyTypes, runBacktest,
  liveSubscribe, liveUnsubscribe, liveConnect, liveStatus,
  getLiveSnapshot, deleteLiveSnapshot,
  searchInstruments, fetchHistoricalData,
  startReplayEval,
  startLiveEval, stopLiveEval,
  startOptionsReplayEval,
  listTickSessions, startTickReplayEval, streamTickReplayEval, stopTickReplayEval,
  startOptionsLiveEval, streamOptionsLiveEval, stopOptionsLiveEval, getActiveOptionsLiveSession,
  getOptionsLiveFeed, getTickReplayFeed,
  saveSessionResult, listSessionResults, getSessionResult, deleteSessionResult, finalizeSessionResult,
  querySessionTicksForCompare,
  getAiReviews, getAiAdvisories,
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
          ['tick-replay',     'Tick Replay Test'],
          ['options-live',    'Options Live Test'],
          ['compare',         'Compare'],
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
      {tab === 'tick-replay'    && <TickReplayTest />}
      {tab === 'options-live'   && <OptionsLiveTest />}
      {tab === 'compare'        && <SessionCompare />}
    </div>
  );
}

// ─── Tab 5: Options Live Test ─────────────────────────────────────────────────

function OptionsLiveTest() {
  const { session, isActive } = useSession();

  const ls = (key, def) => { try { const s = localStorage.getItem(key); if (!s) return def; const v = JSON.parse(s); return (Array.isArray(def) && !Array.isArray(v)) ? def : v; } catch { return def; } };

  // ── NIFTY instrument
  const [nifty, setNifty] = useState(() => ls('sma_live_opts_nifty', { symbol: '', exchange: 'NSE', instrumentToken: '' }));

  // ── Option pools
  const [cePool, setCePool] = useState(() => ls('sma_live_opts_ce_pool', [EMPTY_OPTION_INST()]));
  const [pePool, setPePool] = useState(() => ls('sma_live_opts_pe_pool', [EMPTY_OPTION_INST()]));

  // ── Live settings (no fromDate/toDate/speed)
  const [interval,      setInterval]      = useState(() => ls('sma_live_opts_interval',   'MINUTE_5'));
  const [warmupDays,    setWarmupDays]    = useState(() => ls('sma_live_opts_warmup',      '5'));
  const [quantity,      setQuantity]      = useState(() => ls('sma_live_opts_qty',         '0'));
  const [capital,       setCapital]       = useState(() => ls('sma_live_opts_capital',     '100000'));
  const [recordCandles,       setRecordCandles]       = useState(() => ls('sma_live_opts_record_candles', true));
  const [recordTicks,         setRecordTicks]         = useState(() => ls('sma_live_opts_record_ticks',   true));
  const [tradingHoursEnabled, setTradingHoursEnabled] = useState(() => ls('sma_live_opts_trading_hours_on', true));
  const [closeoutMins,        setCloseoutMins]        = useState(() => ls('sma_live_opts_closeout_mins', '15'));

  // ── Strategies
  const [strategies, setStrategies] = useState(() => ls('sma_live_opts_strategies', defaultStrategies()));

  // ── Config (all same as replay)
  const [decisionCfg,         setDecisionCfg]         = useState(() => ls('sma_live_opts_decision',           DEFAULT_DECISION));
  const [selectionCfg,        setSelectionCfg]        = useState(() => ls('sma_live_opts_selection',          DEFAULT_SELECTION));
  const [switchCfg,           setSwitchCfg]           = useState(() => ls('sma_live_opts_switch',             DEFAULT_SWITCH));
  const [optsRegimeCfg,       setOptsRegimeCfg]       = useState(() => ls('sma_live_opts_regime_cfg',         DEFAULT_OPTS_REGIME_CONFIG));
  const [chopRules,           setChopRules]           = useState(() => ls('sma_live_opts_chop_rules',         DEFAULT_CHOP_RULES));
  const [tradingRules,        setTradingRules]        = useState(() => ls('sma_live_opts_trading_rules',      DEFAULT_TRADING_RULES));
  const [regimeRules,         setRegimeRules]         = useState(() => ls('sma_live_opts_regime_rules',       DEFAULT_REGIME_RULES));
  const [regimeStrategyRules, setRegimeStrategyRules] = useState(() => ls('sma_live_opts_regime_strat_rules', DEFAULT_REGIME_STRATEGY_RULES));
  const [optsRisk,            setOptsRisk]            = useState(() => ls('sma_live_opts_risk',               DEFAULT_OPTS_RISK));
  const [rangeQuality,        setRangeQuality]        = useState(() => ls('sma_live_opts_range_quality',      DEFAULT_RANGE_QUALITY));
  const [tradeQuality,        setTradeQuality]        = useState(() => ls('sma_live_opts_trade_quality',      DEFAULT_TRADE_QUALITY));
  const [trendEntry,          setTrendEntry]          = useState(() => ls('sma_live_opts_trend_entry',        DEFAULT_TREND_ENTRY));
  const [compressionEntry,    setCompressionEntry]    = useState(() => ls('sma_live_opts_compression_entry',  DEFAULT_COMPRESSION_ENTRY));
  const [holdConfig,          setHoldConfig]          = useState(() => ({ ...DEFAULT_HOLD,           ...ls('sma_live_opts_hold_config',    {}) }));
  const [exitConfig,          setExitConfig]          = useState(() => ({ ...DEFAULT_EXIT_CONFIG,    ...ls('sma_live_opts_exit_config',    {}) }));
  const [penaltyConfig,       setPenaltyConfig]       = useState(() => ({ ...DEFAULT_PENALTY_CONFIG, ...ls('sma_live_opts_penalty_config',  {}) }));
  const [minMovementFilter,              setMinMovementFilter]              = useState(() => ls('sma_live_opts_min_movement_filter',              DEFAULT_MIN_MOVEMENT_FILTER));
  const [directionalConsistencyFilter,   setDirectionalConsistencyFilter]   = useState(() => ls('sma_live_opts_directional_consistency_filter',   DEFAULT_DIRECTIONAL_CONSISTENCY_FILTER));
  const [candleStrengthFilter,           setCandleStrengthFilter]           = useState(() => ls('sma_live_opts_candle_strength_filter',           DEFAULT_CANDLE_STRENGTH_FILTER));
  const [cascadeProtection,              setCascadeProtection]              = useState(() => ls('sma_live_opts_cascade_protection',              DEFAULT_CASCADE_PROTECTION));
  const [realTrendConfig,                setRealTrendConfig]                = useState(() => ls('sma_live_opts_real_trend_config',                DEFAULT_REAL_TREND_CONFIG));

  function updateOptsRisk(key, val)                    { setOptsRisk(p                      => ({ ...p, [key]: val })); }
  function updateRangeQuality(key, val)                { setRangeQuality(p                  => ({ ...p, [key]: val })); }
  function updateHoldConfig(key, val)                  { setHoldConfig(p                    => ({ ...p, [key]: val })); }
  function updateExitConfig(key, val)                  { setExitConfig(p                    => ({ ...p, [key]: val })); }
  function updatePenaltyConfig(key, val)               { setPenaltyConfig(p                 => ({ ...p, [key]: val })); }
  function updateTradeQuality(key, val)                { setTradeQuality(p                  => ({ ...p, [key]: val })); }
  function updateTrendEntry(key, val)                  { setTrendEntry(p                    => ({ ...p, [key]: val })); }
  function updateCompressionEntry(key, val)            { setCompressionEntry(p              => ({ ...p, [key]: val })); }
  function updateCascadeProtection(key, val)           { setCascadeProtection(p             => ({ ...p, [key]: val })); }
  function updateMinMovementFilter(key, val)           { setMinMovementFilter(p             => ({ ...p, [key]: val })); }
  function updateDirectionalConsistencyFilter(key, val){ setDirectionalConsistencyFilter(p  => ({ ...p, [key]: val })); }
  function updateCandleStrengthFilter(key, val)        { setCandleStrengthFilter(p          => ({ ...p, [key]: val })); }

  // ── Config presets (shared with Options Replay — same sma_opts_presets key) ──
  const [presets, setPresets] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sma_opts_presets') || '[]'); } catch { return []; }
  });
  const [presetName,        setPresetName]        = useState('');
  const [presetDescription, setPresetDescription] = useState('');
  const [showPresetSave,    setShowPresetSave]    = useState(false);

  function capturePresetConfig() {
    return {
      interval, warmupDays, quantity, capital,
      strategies,
      decisionCfg, selectionCfg, switchCfg,
      optsRegimeCfg, chopRules, tradingRules, regimeRules, regimeStrategyRules,
      optsRisk, rangeQuality, tradeQuality, trendEntry, compressionEntry,
      holdConfig, exitConfig, penaltyConfig, minMovementFilter, directionalConsistencyFilter, candleStrengthFilter,
      cascadeProtection, realTrendConfig,
    };
  }

  const selectedPresetId = (() => {
    const { nifty: _n, cePool: _ce, pePool: _pe, ...currentCmp } = capturePresetConfig();
    const current = JSON.stringify(currentCmp);
    return presets.find(p => {
      const { nifty: _n2, cePool: _ce2, pePool: _pe2, ...presetCmp } = p.config;
      return JSON.stringify(presetCmp) === current;
    })?.id ?? null;
  })();

  function savePreset() {
    if (!presetName.trim()) return;
    const preset = {
      id:          Date.now().toString(),
      name:        presetName.trim(),
      description: presetDescription.trim(),
      createdAt:   new Date().toISOString(),
      config:      capturePresetConfig(),
    };
    const next = [preset, ...presets];
    setPresets(next);
    try { localStorage.setItem('sma_opts_presets', JSON.stringify(next)); } catch {}
    setPresetName(''); setPresetDescription(''); setShowPresetSave(false);
  }

  function applyPreset(preset) {
    const c = preset.config;
    if (c.interval     !== undefined) setInterval(c.interval);
    if (c.warmupDays   !== undefined) setWarmupDays(c.warmupDays);
    if (c.quantity     !== undefined) setQuantity(c.quantity);
    if (c.capital      !== undefined) setCapital(c.capital);
    if (c.strategies   !== undefined) setStrategies(c.strategies);
    if (c.decisionCfg  !== undefined) setDecisionCfg(c.decisionCfg);
    if (c.selectionCfg !== undefined) setSelectionCfg(c.selectionCfg);
    if (c.switchCfg    !== undefined) setSwitchCfg(c.switchCfg);
    if (c.optsRegimeCfg        !== undefined) setOptsRegimeCfg(c.optsRegimeCfg);
    if (c.chopRules            !== undefined) setChopRules(c.chopRules);
    if (c.tradingRules         !== undefined) setTradingRules(c.tradingRules);
    if (c.regimeRules          !== undefined) setRegimeRules(c.regimeRules);
    if (c.regimeStrategyRules  !== undefined) setRegimeStrategyRules(c.regimeStrategyRules);
    if (c.optsRisk             !== undefined) setOptsRisk(c.optsRisk);
    if (c.rangeQuality         !== undefined) setRangeQuality(c.rangeQuality);
    if (c.tradeQuality         !== undefined) setTradeQuality(c.tradeQuality);
    setTrendEntry({ ...DEFAULT_TREND_ENTRY, ...(c.trendEntry ?? {}) });
    if (c.compressionEntry     !== undefined) setCompressionEntry(c.compressionEntry);
    setHoldConfig({ ...DEFAULT_HOLD, ...(c.holdConfig ?? {}) });
    setExitConfig({ ...DEFAULT_EXIT_CONFIG, ...(c.exitConfig ?? {}) });
    setPenaltyConfig({ ...DEFAULT_PENALTY_CONFIG, ...(c.penaltyConfig ?? {}) });
    setMinMovementFilter(c.minMovementFilter ?? DEFAULT_MIN_MOVEMENT_FILTER);
    setDirectionalConsistencyFilter(c.directionalConsistencyFilter ?? DEFAULT_DIRECTIONAL_CONSISTENCY_FILTER);
    setCandleStrengthFilter(c.candleStrengthFilter ?? DEFAULT_CANDLE_STRENGTH_FILTER);
    setCascadeProtection(c.cascadeProtection ?? DEFAULT_CASCADE_PROTECTION);
    setRealTrendConfig({ ...DEFAULT_REAL_TREND_CONFIG, ...(c.realTrendConfig ?? {}) });
  }

  function deletePreset(id) {
    const preset = presets.find(p => p.id === id);
    if (!window.confirm(`Delete preset "${preset?.name}"?`)) return;
    const next = presets.filter(p => p.id !== id);
    setPresets(next);
    try { localStorage.setItem('sma_opts_presets', JSON.stringify(next)); } catch {}
  }

  function downloadPreset(preset) {
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `preset-${preset.name.replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadAllPresets() {
    const blob = new Blob([JSON.stringify(presets, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'sma_opts_presets.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function uploadPresets(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target.result);
        // Accept a single preset object or an array of presets
        const incoming = Array.isArray(parsed) ? parsed : [parsed];
        if (!incoming.every(p => p.id && p.name && p.config)) {
          alert('Invalid preset file — each preset must have id, name, and config fields.');
          return;
        }
        // Merge: keep existing presets, add uploaded ones (skip duplicates by id)
        const existingIds = new Set(presets.map(p => p.id));
        const toAdd = incoming.filter(p => !existingIds.has(p.id));
        const next  = [...toAdd, ...presets];
        setPresets(next);
        try { localStorage.setItem('sma_opts_presets', JSON.stringify(next)); } catch {}
      } catch { alert('Failed to parse preset file — must be valid JSON.'); }
    };
    reader.readAsText(file);
    e.target.value = ''; // reset so same file can be uploaded again
  }

  // ── Persist to localStorage
  useEffect(() => { try { localStorage.setItem('sma_live_opts_nifty',              JSON.stringify(nifty));               } catch {} }, [nifty]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_ce_pool',            JSON.stringify(cePool));              } catch {} }, [cePool]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_pe_pool',            JSON.stringify(pePool));              } catch {} }, [pePool]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_interval',           JSON.stringify(interval));            } catch {} }, [interval]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_record_candles',     JSON.stringify(recordCandles));        } catch {} }, [recordCandles]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_record_ticks',       JSON.stringify(recordTicks));          } catch {} }, [recordTicks]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_trading_hours_on',   JSON.stringify(tradingHoursEnabled));  } catch {} }, [tradingHoursEnabled]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_closeout_mins',      JSON.stringify(closeoutMins));         } catch {} }, [closeoutMins]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_warmup',             JSON.stringify(warmupDays));          } catch {} }, [warmupDays]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_qty',                JSON.stringify(quantity));            } catch {} }, [quantity]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_capital',            JSON.stringify(capital));             } catch {} }, [capital]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_strategies',         JSON.stringify(strategies));          } catch {} }, [strategies]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_decision',           JSON.stringify(decisionCfg));         } catch {} }, [decisionCfg]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_selection',          JSON.stringify(selectionCfg));        } catch {} }, [selectionCfg]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_switch',             JSON.stringify(switchCfg));           } catch {} }, [switchCfg]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_regime_cfg',         JSON.stringify(optsRegimeCfg));       } catch {} }, [optsRegimeCfg]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_chop_rules',         JSON.stringify(chopRules));           } catch {} }, [chopRules]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_trading_rules',      JSON.stringify(tradingRules));        } catch {} }, [tradingRules]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_regime_rules',       JSON.stringify(regimeRules));         } catch {} }, [regimeRules]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_regime_strat_rules', JSON.stringify(regimeStrategyRules)); } catch {} }, [regimeStrategyRules]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_risk',               JSON.stringify(optsRisk));            } catch {} }, [optsRisk]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_range_quality',      JSON.stringify(rangeQuality));        } catch {} }, [rangeQuality]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_trade_quality',      JSON.stringify(tradeQuality));        } catch {} }, [tradeQuality]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_trend_entry',        JSON.stringify(trendEntry));          } catch {} }, [trendEntry]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_compression_entry',      JSON.stringify(compressionEntry));    } catch {} }, [compressionEntry]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_hold_config',            JSON.stringify(holdConfig));          } catch {} }, [holdConfig]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_exit_config',            JSON.stringify(exitConfig));          } catch {} }, [exitConfig]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_penalty_config',         JSON.stringify(penaltyConfig));       } catch {} }, [penaltyConfig]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_min_movement_filter',              JSON.stringify(minMovementFilter));             } catch {} }, [minMovementFilter]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_directional_consistency_filter',   JSON.stringify(directionalConsistencyFilter));  } catch {} }, [directionalConsistencyFilter]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_candle_strength_filter',           JSON.stringify(candleStrengthFilter));          } catch {} }, [candleStrengthFilter]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_cascade_protection',            JSON.stringify(cascadeProtection));             } catch {} }, [cascadeProtection]);
  useEffect(() => { try { localStorage.setItem('sma_live_opts_real_trend_config',             JSON.stringify(realTrendConfig));               } catch {} }, [realTrendConfig]);

  // ── Session / run state
  const [status,    setStatus]    = useState('idle'); // idle|running|error
  const [sessionId, setSessionId] = useState(null);
  const [feed,      setFeed]      = useState([]);
  const [initInfo,  setInitInfo]  = useState(null);
  const [warnings,  setWarnings]  = useState([]);
  const [error,     setError]     = useState('');
  const [rightTab,  setRightTab]  = useState('feed');
  const [liveTicks, setLiveTicks] = useState({});   // token -> {ltp, isNifty, fOpen, fHigh, fLow, fClose, timeMs}
  const abortRef      = useRef(null);
  const readerRef     = useRef(null);
  const sessionIdRef  = useRef(null);
  // Preserved across stop/complete — cleared only after a successful save. Used by save pipeline.
  const lastSaveSessionIdRef = useRef(null);
  const lastRunPcRef  = useRef(null);
  const lastPayloadRef = useRef(null);
  // Accumulates raw tick events for post-session comparison. Capped at 10 000 to limit payload size.
  const ticksRef        = useRef([]);
  const sessionStartRef = useRef(null);
  const lastTickTimeRef = useRef(null); // ms timestamp of last received tick, uncapped

  // ── Save to Compare state
  const [showSavePanel, setShowSavePanel] = useState(false);
  const [saveLabel,     setSaveLabel]     = useState('');
  const [saveStatus,    setSaveStatus]    = useState('idle'); // idle|saving|saved|error
  const [saveError,     setSaveError]     = useState('');
  const [canSave,       setCanSave]       = useState(false);
  const [syncInfo,      setSyncInfo]      = useState(null);  // {flushedAt, totalCandles}
  const skipConfirmRef     = useRef(false);
  const [showStartConfirm, setShowStartConfirm] = useState(false);
  const [startConfirmText, setStartConfirmText] = useState('');
  const [showStopConfirm,  setShowStopConfirm]  = useState(false);
  const [stopConfirmText,  setStopConfirmText]  = useState('');

  // On mount: check if a session is already running for this user and auto-reconnect to it.
  useEffect(() => {
    if (!session?.userId) return;
    getActiveOptionsLiveSession(session.userId).then(sid => {
      if (sid) {
        sessionIdRef.current = sid;
        lastSaveSessionIdRef.current = sid;  // preserved past stop for save pipeline
        setSessionId(sid);
        setCanSave(true);
        // Auto-attach SSE so the feed starts populating immediately
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setStatus('running');
        streamOptionsLiveEval(sid, ctrl.signal).then(async response => {
          if (!response?.body) return;
          const reader = response.body.getReader();
          readerRef.current = reader;
          const decoder = new TextDecoder();
          let buffer = '';
          try {
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
                if (evtName === 'error') { setError(data.replace(/^"|"$/g, '')); setStatus('error'); return; }
                if (evtName === 'warning') { setWarnings(prev => [...prev, data.replace(/^"|"$/g, '')]); continue; }
                try {
                  const parsed = JSON.parse(data);
                  if (evtName === 'init')        setInitInfo(parsed);
                  else if (evtName === 'candle') setFeed(prev => [...prev.slice(-499), parsed]);
                  else if (evtName === 'tick')   setLiveTicks(prev => ({ ...prev, [parsed.token]: parsed }));
                  else if (evtName === 'sync')   setSyncInfo(parsed);
                } catch {}
              }
            }
          } catch (err) {
            if (err.name !== 'AbortError') { setError(err.message); setStatus('error'); }
            else setStatus('idle');
            return;
          }
          // Stream ended cleanly (server stopped the session)
          sessionIdRef.current = null; setSessionId(null); setStatus('idle');
        }).catch(() => { setStatus('idle'); });
      }
    }).catch(() => {});

    // On unmount: only abort the SSE stream — do NOT stop the backend session.
    return () => { abortRef.current?.abort(); };
  }, [session?.userId]);

  // ── Pool helpers
  function updatePoolInst(pool, setPool, id, patch) { setPool(p => p.map(i => i.id === id ? { ...i, ...patch } : i)); }
  function addPoolInst(setPool)                      { setPool(p => [...p, EMPTY_OPTION_INST()]); }
  function removePoolInst(pool, setPool, id)         { setPool(p => p.length > 1 ? p.filter(i => i.id !== id) : p); }

  function updateStrategy(idx, patch)        { setStrategies(p => p.map((s, i) => i === idx ? { ...s, ...patch } : s)); }
  function updateStratParam(idx, key, val)   { setStrategies(p => p.map((s, i) => i === idx ? { ...s, parameters: { ...s.parameters, [key]: val } } : s)); }

  async function handleStop() {
    // Abort the local SSE reader first so the stream loop exits
    abortRef.current?.abort();
    try { readerRef.current?.cancel(); } catch {}
    // Explicitly stop the backend session — this is the ONLY action that terminates it
    const sid = sessionIdRef.current;
    if (sid) {
      try { await stopOptionsLiveEval(sid); } catch {}
      sessionIdRef.current = null;
      setSessionId(null);
    }
    setStatus('idle');
  }

  async function handleStart(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (status === 'running') {
      if (feed.length > 0 && !skipConfirmRef.current) {
        setShowStopConfirm(true);
        setStopConfirmText('');
        return;
      }
      skipConfirmRef.current = false;
      handleStop();
      return;
    }
    if (lastSaveSessionIdRef.current && saveStatus !== 'saved' && canSave && !skipConfirmRef.current) {
      setShowStartConfirm(true);
      setStartConfirmText('');
      return;
    }
    skipConfirmRef.current = false;

    if (!canRun) {
      setError('Select a NIFTY instrument and at least one CE or PE option before starting.');
      return;
    }

    lastRunPcRef.current = { ...penaltyConfig };
    setFeed([]); setInitInfo(null); setWarnings([]); setError(''); setStatus('running'); setLiveTicks({});
    setShowSavePanel(false); setSaveStatus('idle');

    const enabledStrats = strategies
      .filter(s => s.enabled)
      .map(s => ({ strategyType: s.strategyType, parameters: s.parameters }));

    const payload = {
      userId:      session.userId,
      brokerName:  session.brokerName,
      apiKey:      session.apiKey      || undefined,
      accessToken: session.accessToken || undefined,
      niftyInstrumentToken: nifty.instrumentToken ? parseInt(nifty.instrumentToken, 10) : undefined,
      niftySymbol:   nifty.symbol   || 'NIFTY 50',
      niftyExchange: nifty.exchange  || 'NSE',
      interval,
      warmupDays:    parseInt(warmupDays, 10) || 5,
      quantity:      parseInt(quantity,   10) || 0,
      initialCapital: parseFloat(capital) || 100000,
      recordCandles,
      recordTicks,
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
        minScore:                    parseFloat(decisionCfg.minScore)                    || 40,
        minScoreGap:                 parseFloat(decisionCfg.minScoreGap)                 || 8,
        maxRecentMove3:              parseFloat(decisionCfg.maxRecentMove3)               || 1.5,
        maxRecentMove5:              parseFloat(decisionCfg.maxRecentMove5)               || 2.5,
        maxAbsVwapDist:              parseFloat(decisionCfg.maxAbsVwapDist)               || 1.5,
        minBarsSinceTrade:           parseInt(decisionCfg.minBarsSinceTrade, 10)           || 3,
        chopFilter:                  decisionCfg.chopFilter,
        chopLookback:                parseInt(decisionCfg.chopLookback, 10)               || 8,
        penaltyMinScore:             parseFloat(decisionCfg.penaltyMinScore)              || parseFloat(decisionCfg.minScore) || 0,
        scoreFloorTrigger:           parseFloat(decisionCfg.scoreFloorTrigger)            || 35,
        scoreFloorMin:               parseFloat(decisionCfg.scoreFloorMin)                || 25,
        bollingerBonusThreshold:     parseFloat(decisionCfg.bollingerBonusThreshold)      || 35,
        bollingerBonus:              parseFloat(decisionCfg.bollingerBonus)               || 0,
        earlyEntryRisingBars:        parseInt(decisionCfg.earlyEntryRisingBars, 10)       || 0,
        rawScoreBypassThreshold:     parseFloat(decisionCfg.rawScoreBypassThreshold)      || 0,
        rawScoreBypassGap:           parseFloat(decisionCfg.rawScoreBypassGap)            || 3,
        bollingerEarlyEntryMinScore: parseFloat(decisionCfg.bollingerEarlyEntryMinScore)  || 0,
      },
      selectionConfig: {
        minPremium:        parseFloat(selectionCfg.minPremium) || 50,
        maxPremium:        parseFloat(selectionCfg.maxPremium) || 300,
        strictPremiumBand: selectionCfg.strictPremiumBand ?? true,
      },
      switchConfig: {
        switchConfirmationCandles:    parseInt(switchCfg.switchConfirmationCandles, 10)    || 2,
        maxSwitchesPerDay:            parseInt(switchCfg.maxSwitchesPerDay, 10)            || 3,
        minScoreImprovementForSwitch: parseFloat(switchCfg.minScoreImprovementForSwitch)  || 0,
      },
      regimeConfig: optsRegimeCfg.enabled ? {
        enabled: true,
        adxPeriod:         parseInt(optsRegimeCfg.adxPeriod, 10)        || 14,
        atrPeriod:         parseInt(optsRegimeCfg.atrPeriod, 10)        || 14,
        adxTrendThreshold: parseFloat(optsRegimeCfg.adxTrendThreshold)  || 25,
        atrVolatilePct:    parseFloat(optsRegimeCfg.atrVolatilePct)     || 2.0,
        atrCompressionPct: parseFloat(optsRegimeCfg.atrCompressionPct)  || 0.5,
      } : { enabled: false },
      regimeRules: {
        enabled:                regimeRules.enabled,
        rangingMinScore:        parseFloat(regimeRules.rangingMinScore)        || 35,
        rangingMinScoreGap:     parseFloat(regimeRules.rangingMinScoreGap)     || 6,
        trendingMinScore:       parseFloat(regimeRules.trendingMinScore)       || 25,
        trendingMinScoreGap:    parseFloat(regimeRules.trendingMinScoreGap)    || 3,
        compressionMinScore:    parseFloat(regimeRules.compressionMinScore)    || 25,
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
        enabled:              tradingRules.enabled,
        rangingNoTrade:       tradingRules.rangingNoTrade,
        volatileNoTrade:      tradingRules.volatileNoTrade,
        compressionNoTrade:   tradingRules.compressionNoTrade,
        noSameCandleReversal: tradingRules.noSameCandleReversal,
      },
      regimeStrategyRules: {
        enabled:        regimeStrategyRules.enabled,
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
        minRangeWidthPct:              parseFloat(rangeQuality.minRangeWidthPct)             || 0.3,
        maxRangeWidthPct:              parseFloat(rangeQuality.maxRangeWidthPct)             || 3.0,
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
        weakRangingMinScore:    parseFloat(tradeQuality.weakRangingMinScore)    || 28,
        weakRangingMinGap:      parseFloat(tradeQuality.weakRangingMinGap)      || 3,
        rangingConfirmCandles:  parseInt(tradeQuality.rangingConfirmCandles, 10) || 2,
        trendingConfirmCandles: parseInt(tradeQuality.trendingConfirmCandles, 10) || 1,
      } : { enabled: false },
      trendEntryConfig: trendEntry.enabled ? {
        enabled:                      true,
        breakoutLookback:             parseInt(trendEntry.breakoutLookback, 10)              || 5,
        minBodyPct:                   parseFloat(trendEntry.minBodyPct)                      || 45,
        weakBodyPct:                  parseFloat(trendEntry.weakBodyPct)                     || 20,
        ema9Period:                   parseInt(trendEntry.ema9Period, 10)                    || 9,
        scoreBypassWeakBody:          trendEntry.scoreBypassWeakBody,
        scoreBypassWeakBodyThreshold: parseFloat(trendEntry.scoreBypassWeakBodyThreshold)   || 25,
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
        defaultMinHoldBars:  parseInt(holdConfig.defaultMinHoldBars,  10) || 3,
        rangingMinHoldBars:  parseInt(holdConfig.rangingMinHoldBars,  10) || 4,
        trendingMinHoldBars: parseInt(holdConfig.trendingMinHoldBars, 10) || 2,
        strongOppositeScore: parseFloat(holdConfig.strongOppositeScore)   || 35,
        persistentExitBars:  parseInt(holdConfig.persistentExitBars,  10) || 2,
      },
      exitConfig: {
        enabled:                     exitConfig.enabled,
        hardStopPct:                 parseFloat(exitConfig.hardStopPct)                 || 7,
        holdZonePct:                 parseFloat(exitConfig.holdZonePct)                 || 5,
        lock1TriggerPct:             parseFloat(exitConfig.lock1TriggerPct)             || 5,
        lock1FloorPct:               parseFloat(exitConfig.lock1FloorPct)               || 2,
        lock2TriggerPct:             parseFloat(exitConfig.lock2TriggerPct)             || 10,
        lock2FloorPct:               parseFloat(exitConfig.lock2FloorPct)               || 5,
        trailTriggerPct:             parseFloat(exitConfig.trailTriggerPct)             || 15,
        trailFactor:                 parseFloat(exitConfig.trailFactor)                 || 0.4,
        firstMoveBars:               parseInt(exitConfig.firstMoveBars,  10)            || 0,
        firstMoveLockPct:            parseFloat(exitConfig.firstMoveLockPct)            || 0.5,
        structureLookback:           parseInt(exitConfig.structureLookback, 10)         || 5,
        scoreDropFactor:             parseFloat(exitConfig.scoreDropFactor)             || 0,
        scoreAbsoluteMin:            parseFloat(exitConfig.scoreAbsoluteMin)            || 0,
        biasExitEnabled:             exitConfig.biasExitEnabled,
        strongExitScore:             parseFloat(exitConfig.strongExitScore)             || 40,
        trendStrongModeThresholdPct: parseFloat(exitConfig.trendStrongModeThresholdPct) || 5,
        maxBarsNoImprovement:        parseInt(exitConfig.maxBarsNoImprovement, 10)      || 3,
        stagnationBars:              parseInt(exitConfig.stagnationBars, 10)            || 2,
        maxBarsRanging:              parseInt(exitConfig.maxBarsRanging, 10)            || 6,
        maxBarsDeadTrade:            parseInt(exitConfig.maxBarsDeadTrade, 10)          || 10,
        deadTradePnlPct:             parseFloat(exitConfig.deadTradePnlPct)             || 2,
        noHopeThresholdPct:          parseFloat(exitConfig.noHopeThresholdPct)          || 1.5,
        noHopeBars:                  parseInt(exitConfig.noHopeBars, 10)               || 2,
        breakevenProtectionEnabled:  exitConfig.breakevenProtectionEnabled,
        breakevenTriggerPct:         parseFloat(exitConfig.breakevenTriggerPct)        || 2,
        breakevenOffsetPct:          parseFloat(exitConfig.breakevenOffsetPct)         || 0,
      },
      penaltyConfig: {
        enabled:                   penaltyConfig.enabled,
        reversalEnabled:           penaltyConfig.reversalEnabled,
        reversalMax:               parseFloat(penaltyConfig.reversalMax)               || 25,
        overextensionEnabled:      penaltyConfig.overextensionEnabled,
        overextensionMax:          parseFloat(penaltyConfig.overextensionMax)          || 30,
        sameColorEnabled:          penaltyConfig.sameColorEnabled,
        sameColorMax:              parseFloat(penaltyConfig.sameColorMax)              || 30,
        mismatchEnabled:           penaltyConfig.mismatchEnabled,
        mismatchScale:             parseFloat(penaltyConfig.mismatchScale)             || 1.0,
        volatileOptionEnabled:     penaltyConfig.volatileOptionEnabled,
        volatileOptionPenalty:     parseFloat(penaltyConfig.volatileOptionPenalty)     || 35,
        movePenaltyEnabled:        penaltyConfig.movePenaltyEnabled,
        movePenalty:               parseFloat(penaltyConfig.movePenalty)               || 3,
        vwapPenaltyEnabled:        penaltyConfig.vwapPenaltyEnabled,
        vwapPenalty:               parseFloat(penaltyConfig.vwapPenalty)               || 5,
        chopPenaltyEnabled:        penaltyConfig.chopPenaltyEnabled,
        chopPenalty:               parseFloat(penaltyConfig.chopPenalty)               || 2,
        rangeDriftingEnabled:      penaltyConfig.rangeDriftingEnabled,
        rangeDriftingPenalty:      parseFloat(penaltyConfig.rangeDriftingPenalty)      || 3,
        rangePoorStructureEnabled: penaltyConfig.rangePoorStructureEnabled,
        rangePoorStructurePenalty: parseFloat(penaltyConfig.rangePoorStructurePenalty) || 4,
        rangeChoppyEnabled:        penaltyConfig.rangeChoppyEnabled,
        rangeChoppyPenalty:        parseFloat(penaltyConfig.rangeChoppyPenalty)        || 2,
        rangeSizeEnabled:          penaltyConfig.rangeSizeEnabled,
        rangeSizePenalty:          parseFloat(penaltyConfig.rangeSizePenalty)          || 2,
      },
      minMovementFilterConfig: minMovementFilter.enabled ? {
        enabled:                     true,
        minMovementLookbackCandles:  parseInt(minMovementFilter.minMovementLookbackCandles,  10) || 3,
        minMovementThresholdPercent: parseFloat(minMovementFilter.minMovementThresholdPercent) || 1.0,
      } : { enabled: false },
      directionalConsistencyFilterConfig: directionalConsistencyFilter.enabled ? {
        enabled:                               true,
        directionalConsistencyLookbackCandles: parseInt(directionalConsistencyFilter.directionalConsistencyLookbackCandles, 10) || 3,
        minSameDirectionCandles:               parseInt(directionalConsistencyFilter.minSameDirectionCandles,               10) || 2,
      } : { enabled: false },
      candleStrengthFilterConfig: candleStrengthFilter.enabled ? {
        enabled:                      true,
        candleStrengthLookbackCandles: parseInt(candleStrengthFilter.candleStrengthLookbackCandles, 10) || 3,
        minAverageBodyRatio:           parseFloat(candleStrengthFilter.minAverageBodyRatio)           || 0.50,
        minStrongCandlesRequired:      parseInt(candleStrengthFilter.minStrongCandlesRequired,   10)  || 2,
      } : { enabled: false },
      stopLossCascadeProtectionConfig: cascadeProtection.enabled ? {
        enabled:               true,
        cascadeStopLossCount:  parseInt(cascadeProtection.cascadeStopLossCount,  10) || 2,
        cascadeWindowMinutes:  parseInt(cascadeProtection.cascadeWindowMinutes,  10) || 30,
        cascadePauseMinutes:   parseInt(cascadeProtection.cascadePauseMinutes,   10) || 30,
        cascadeExitReasons:    ['HARD_STOP_LOSS'],
        cascadeApplyPerSymbol: cascadeProtection.cascadeApplyPerSymbol,
        cascadeApplyPerSide:   cascadeProtection.cascadeApplyPerSide,
      } : { enabled: false },
      realTrendConfig: realTrendConfig.enabled ? {
        enabled:            true,
        maxOverlapRatio:    parseFloat(realTrendConfig.maxOverlapRatio)    || 0.6,
        minAvgBodyRatio:    parseFloat(realTrendConfig.minAvgBodyRatio)    || 0.5,
        minStrongBodyRatio: parseFloat(realTrendConfig.minStrongBodyRatio) || 0.6,
        minStrongBodies:    parseInt(realTrendConfig.minStrongBodies,  10) || 2,
        minRangeExpansion:  parseFloat(realTrendConfig.minRangeExpansion)  || 1.2,
        minPersistBars:     parseInt(realTrendConfig.minPersistBars,   10) || 2,
      } : { enabled: false },
      tradingHoursConfig: {
        enabled: tradingHoursEnabled,
        noNewEntriesMinutesBeforeClose: parseInt(closeoutMins, 10) || 15,
      },
    };
    lastPayloadRef.current = payload;
    ticksRef.current = [];
    sessionStartRef.current = new Date().toISOString();
    lastTickTimeRef.current = null;

    try {
      // Step 1: start session
      const startRes = await startOptionsLiveEval(payload);
      const sid = startRes?.data?.sessionId;
      if (!sid) throw new Error('No sessionId returned');
      sessionIdRef.current = sid;
      lastSaveSessionIdRef.current = sid;  // preserved past stop for save pipeline
      setSessionId(sid);
      setCanSave(true); setSyncInfo(null);

      // Step 2: attach SSE listener (session already running in backend)
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const response = await streamOptionsLiveEval(sid, ctrl.signal);
      if (!response.body) throw new Error('No response body');
      const reader = response.body.getReader();
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
          if (evtName === 'warning') { setWarnings(prev => [...prev, data.replace(/^"|"$/g, '')]); continue; }
          try {
            const parsed = JSON.parse(data);
            if (evtName === 'init')   setInitInfo(parsed);
            else if (evtName === 'candle') setFeed(prev => [...prev.slice(-499), parsed]);
            else if (evtName === 'tick') {
              setLiveTicks(prev => ({ ...prev, [parsed.token]: parsed }));
              if (parsed.timeMs) lastTickTimeRef.current = parsed.timeMs;
            }
          } catch {}
        }
      }
      // SSE stream ended — session was stopped by server (explicit DELETE)
      sessionIdRef.current = null;
      setSessionId(null);
      setStatus('idle');
    } catch (err) {
      if (err.name === 'AbortError') { setStatus('idle'); return; }
      setError(err.message);
      setStatus('error');
      // Don't null sessionId here — the backend session may still be running.
      // The user can reconnect via handleReconnect or stop it via handleStop.
    }
  }

  // Reconnect SSE to an already-running backend session without restarting it
  async function handleReconnect() {
    const sid = sessionIdRef.current;
    if (!sid) return;
    setError(''); setStatus('running');
    try {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const response = await streamOptionsLiveEval(sid, ctrl.signal);
      if (!response.body) throw new Error('No response body');
      const reader = response.body.getReader();
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
          if (evtName === 'error') { setError(data.replace(/^"|"$/g, '')); setStatus('error'); return; }
          if (evtName === 'warning') { setWarnings(prev => [...prev, data.replace(/^"|"$/g, '')]); continue; }
          try {
            const parsed = JSON.parse(data);
            if (evtName === 'init')        setInitInfo(parsed);
            else if (evtName === 'candle') setFeed(prev => [...prev.slice(-499), parsed]);
            else if (evtName === 'tick')   setLiveTicks(prev => ({ ...prev, [parsed.token]: parsed }));
            else if (evtName === 'sync')   setSyncInfo(parsed);
          } catch {}
        }
      }
      sessionIdRef.current = null; setSessionId(null); setStatus('idle');
    } catch (err) {
      if (err.name === 'AbortError') { setStatus('idle'); return; }
      setError(err.message); setStatus('error');
    }
  }

  function handleConfirmedStart() {
    setShowStartConfirm(false);
    setStartConfirmText('');
    skipConfirmRef.current = true;
    handleStart(null);
  }

  function handleConfirmedStop() {
    setShowStopConfirm(false);
    setStopConfirmText('');
    skipConfirmRef.current = true;
    handleStart(null);
  }

  async function handleSaveToCompare() {
    setSaveStatus('saving'); setSaveError('');
    try {
      // Use the preserved session ID — never null out lastSaveSessionIdRef on stop.
      const sid = lastSaveSessionIdRef.current;
      if (!sid) {
        console.warn('[LIVE save] blocked: no session ID available');
        throw new Error('No completed live session to save. Please run a session first.');
      }
      console.log('[LIVE save] session ID:', sid);

      // Fetch the auto-saved draft record from DB (written by server on session stop).
      // This is the authoritative source — avoids empty client-side SSE state.
      let record;
      try {
        const res = await getSessionResult(sid);
        record = res?.data;
      } catch (e) {
        console.warn('[LIVE save] DB fetch failed:', e.message);
      }

      if (!record) throw new Error('Session record not found on server. Cannot save for compare.');

      const serverTrades  = record?.closedTradesJson ? JSON.parse(record.closedTradesJson) : [];
      const serverSummary = record?.summaryJson      ? JSON.parse(record.summaryJson)       : {};
      const wins = serverTrades.filter(t => t.pnl > 0).length;

      console.log('[LIVE save] server trades:', serverTrades?.length ?? 0, '| dataEngineSessionId:', sid);

      // Finalize server-side: update label + summary only — feed stays in session_feed_chunk
      await finalizeSessionResult(sid, {
        label: saveLabel || new Date().toISOString().slice(0, 10),
        closedTrades: serverTrades,
        summary: {
          trades:              serverTrades.length,
          realizedPnl:         serverSummary.realizedPnl  ?? 0,
          winRate:             serverTrades.length > 0 ? wins / serverTrades.length : 0,
          finalCapital:        serverSummary.finalCapital ?? parseFloat(capital) ?? 100000,
          sessionStart:        sessionStartRef.current    || serverSummary.sessionStart  || undefined,
          sessionEnd:          serverSummary.sessionEnd   || new Date().toISOString(),
          lastTickTime:        lastTickTimeRef.current    || undefined,
          dataEngineSessionId: sid,
        },
      });
      console.log('[LIVE save] finalized: sessionId=', sid, 'trades=', serverTrades.length);
      setSaveStatus('saved');
      setShowSavePanel(false);
      setSaveLabel('');
    } catch (e) {
      console.error('[LIVE save] failed:', e.message);
      setSaveStatus('error');
      setSaveError(e.message);
    }
  }

  function downloadCSV() {
    const q   = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const row = (...cols) => cols.map(q).join(',');
    const blank = '';
    const lines = [];

    lines.push(row('=== Run Config ==='));
    lines.push(row('NIFTY Symbol', 'Exchange', 'Token', 'Interval', 'Warmup Days', 'Quantity', 'Capital'));
    lines.push(row(nifty.symbol || '—', nifty.exchange || '—', nifty.instrumentToken || '—', interval, warmupDays, quantity, capital));
    lines.push(blank);

    lines.push(row('=== CE Options Pool ==='));
    lines.push(row('Token', 'Symbol', 'Exchange'));
    cePool.filter(i => i.instrumentToken).forEach(i => lines.push(row(i.instrumentToken, i.symbol, i.exchange)));
    lines.push(blank);

    lines.push(row('=== PE Options Pool ==='));
    lines.push(row('Token', 'Symbol', 'Exchange'));
    pePool.filter(i => i.instrumentToken).forEach(i => lines.push(row(i.instrumentToken, i.symbol, i.exchange)));
    lines.push(blank);

    lines.push(row('=== Strategies ==='));
    lines.push(row('Strategy Type', 'Enabled', 'Parameters'));
    strategies.forEach(s => lines.push(row(s.strategyType, s.enabled ? 'Yes' : 'No', JSON.stringify(s.parameters || {}))));
    lines.push(blank);

    lines.push(row('=== Decision Config ==='));
    lines.push(row('Min Score', 'Penalty Min Score', 'Min Score Gap', 'Max Recent Move 3%', 'Max Recent Move 5%', 'Max VWAP Dist%', 'Min Bars Since Trade', 'Chop Filter', 'Chop Lookback'));
    lines.push(row(decisionCfg.minScore, decisionCfg.penaltyMinScore, decisionCfg.minScoreGap, decisionCfg.maxRecentMove3, decisionCfg.maxRecentMove5, decisionCfg.maxAbsVwapDist, decisionCfg.minBarsSinceTrade, decisionCfg.chopFilter ? 'Yes' : 'No', decisionCfg.chopLookback));
    lines.push(blank);

    const csvPc = lastRunPcRef.current || penaltyConfig;
    lines.push(row('=== Penalty Config (as used in last run) ==='));
    lines.push(row('Master', csvPc.enabled ? 'ON' : 'OFF'));
    if (csvPc.enabled) {
      lines.push(row('Signal Penalty', 'Enabled', 'Value'));
      lines.push(row('Reversal',        csvPc.reversalEnabled        ? 'ON' : 'OFF', `Max=${csvPc.reversalMax}`));
      lines.push(row('Overextension',   csvPc.overextensionEnabled   ? 'ON' : 'OFF', `Max=${csvPc.overextensionMax}`));
      lines.push(row('Same Color',      csvPc.sameColorEnabled       ? 'ON' : 'OFF', `Max=${csvPc.sameColorMax}`));
      lines.push(row('Mismatch',        csvPc.mismatchEnabled        ? 'ON' : 'OFF', `Scale=${csvPc.mismatchScale}`));
      lines.push(row('Volatile Option', csvPc.volatileOptionEnabled  ? 'ON' : 'OFF', `Penalty=${csvPc.volatileOptionPenalty}`));
      lines.push(row('Entry Penalty', 'Enabled', 'Value'));
      lines.push(row('Move',           csvPc.movePenaltyEnabled         ? 'ON' : 'OFF', csvPc.movePenalty));
      lines.push(row('VWAP',           csvPc.vwapPenaltyEnabled         ? 'ON' : 'OFF', csvPc.vwapPenalty));
      lines.push(row('Chop',           csvPc.chopPenaltyEnabled         ? 'ON' : 'OFF', csvPc.chopPenalty));
      lines.push(row('Range Drifting', csvPc.rangeDriftingEnabled       ? 'ON' : 'OFF', csvPc.rangeDriftingPenalty));
      lines.push(row('Range Poor Str', csvPc.rangePoorStructureEnabled  ? 'ON' : 'OFF', csvPc.rangePoorStructurePenalty));
      lines.push(row('Range Choppy',   csvPc.rangeChoppyEnabled         ? 'ON' : 'OFF', csvPc.rangeChoppyPenalty));
      lines.push(row('Range Size',     csvPc.rangeSizeEnabled           ? 'ON' : 'OFF', csvPc.rangeSizePenalty));
    }
    lines.push(blank);

    const closedTradesForCsv = feed[feed.length - 1]?.closedTrades || [];
    if (closedTradesForCsv.length > 0) {
      lines.push(row('=== Closed Trades ==='));
      lines.push(row('Entry Time', 'Exit Time', 'Type', 'Symbol', 'Strike', 'Expiry', 'Entry Px', 'Exit Px', 'Qty', 'P&L', 'P&L %', 'Bars', 'Exit Reason', 'Capital After', 'Entry Regime', 'Exit Regime'));
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
        t.entryRegime || '', t.exitRegime || '',
      )));
      lines.push(blank);
    }

    if (feed.length > 0) {
      const n2 = v => v != null ? Number(v).toFixed(2) : '';
      lines.push(row('=== Per-Candle Feed ==='));
      lines.push(row('Time', 'Phase', 'Tradable', 'NIFTY Close', 'Regime', 'Raw Bias', 'Conf Bias', 'Winner', 'Score', 'Gap', '2nd', '2nd Score', 'Neutral Reason', 'State', 'Action', 'Exit Reason', 'Hold Active', 'uPnL', 'rPnL', 'Capital', 'Option', 'Opt Close', 'Block', 'Exec Wait'));
      feed.forEach(e => lines.push(row(
        (e.niftyTime || '').slice(0, 19),
        e.marketPhase || 'TRADING', e.tradable !== false ? 'Yes' : 'No',
        n2(e.niftyClose), e.regime || '', e.niftyBias || '', e.confirmedBias || '',
        e.winnerStrategy || '', n2(e.winnerScore), n2(e.scoreGap),
        e.secondStrategy || '', n2(e.secondScore),
        e.neutralReason || '', e.positionState || '', e.action || '', e.exitReason || '',
        e.holdActive ? 'Yes' : 'No',
        n2(e.unrealizedPnl), n2(e.realizedPnl), n2(e.capital),
        e.selectedTradingSymbol || '', n2(e.optionClose),
        e.blockReason || '', e.execWaitReason || '',
      )));
      lines.push(blank);
    }

    const csv  = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `options_live_${nifty.symbol || 'data'}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const [copied, setCopied] = useState(false);
  function copyFeed() {
    if (!feed.length) return;
    const n2 = v => v != null ? Number(v).toFixed(2) : '';
    const tab = (...cols) => cols.map(v => String(v ?? '')).join('\t');
    const lines = [];
    lines.push(tab('Time','NIFTY Close','Regime','Raw Bias','Conf Bias','Winner','Score','PenScore','Strength','2nd','2nd Score','Gap','Shadow','ShadowScore','NeutralReason','CnfCount','CnfReq','State','Bars','Hold','Action','ExitRsn','PeakPnL%','LockFloor%','Zone','TrendMode','Option','OptClose','uPnL','rPnL','Capital','Block','ExecWait'));
    feed.forEach(e => lines.push(tab(
      (e.niftyTime || '').slice(0, 19),
      n2(e.niftyClose), e.regime || '', e.niftyBias || '', e.confirmedBias || '',
      e.winnerStrategy || '', n2(e.winnerScore), n2(e.penalizedScore),
      e.tradeStrength || '', e.secondStrategy || '', n2(e.secondScore), n2(e.scoreGap),
      e.shadowWinner || '', n2(e.shadowWinnerScore), e.neutralReason || '',
      e.confirmCount ?? '', e.confirmRequired ?? '',
      e.positionState || '', e.barsInTrade ?? '', e.holdActive ? 'Yes' : 'No',
      e.action || '', e.exitReason || '',
      e.positionState !== 'FLAT' && e.peakPnlPct != null ? n2(e.peakPnlPct) : '',
      e.positionState !== 'FLAT' && e.profitLockFloor != null ? n2(e.profitLockFloor) : '',
      e.inHoldZone ? 'ZONE' : '', e.inStrongTrendMode ? 'TREND' : '',
      e.selectedTradingSymbol || '', n2(e.optionClose),
      n2(e.unrealizedPnl), n2(e.realizedPnl), n2(e.capital),
      e.blockReason || '', e.execWaitReason || '',
    )));
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (!isActive) return (
    <div className="bt-empty-state">
      <p>Activate a broker session to use Options Live Test.</p>
    </div>
  );

  const isRunning    = status === 'running';
  const canRun       = nifty.instrumentToken &&
    (cePool.some(i => i.instrumentToken) || pePool.some(i => i.instrumentToken));
  const lastEvt      = feed[feed.length - 1];
  const closedTrades = lastEvt?.closedTrades || [];

  return (
    <div>
      {/* ── Results panel ── */}
      <div className="card bt-opts-card" style={{ marginBottom: 16 }}>
        <div className="bt-live-right-tabs" style={{ marginBottom: 14 }}>
          {[['feed','Feed'],['chart','Chart'],['pnl','P&L'],['portfolio','Portfolio'],['details','Details']].map(([k, l]) => (
            <button key={k} className={`bt-live-tab-btn ${rightTab === k ? 'active' : ''}`} onClick={() => setRightTab(k)}>{l}</button>
          ))}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            {feed.length > 0 && (
              <>
                <button type="button" className="btn-secondary btn-xs" onClick={copyFeed}>
                  {copied ? 'Copied!' : 'Copy Feed'}
                </button>
                <button type="button" className="btn-secondary btn-xs" onClick={downloadCSV}>Download CSV</button>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {feed.length} candles · {closedTrades.length} trades
                </span>
              </>
            )}
            {canSave && (
              <button type="button" className="btn-secondary btn-xs"
                onClick={() => { setShowSavePanel(s => !s); setSaveLabel('Live ' + new Date().toISOString().slice(0, 10)); setSaveStatus('idle'); setSaveError(''); }}>
                {showSavePanel ? 'Cancel' : saveStatus === 'saved' ? 'Update Label' : 'Save to Compare'}
              </button>
            )}
            {syncInfo && !showSavePanel && saveStatus !== 'saved' && (
              <span style={{ fontSize: 11, color: '#22c55e' }} title="Data is being auto-saved to DB every ~15s">
                ✓ Synced {syncInfo.totalCandles} candles · {new Date(syncInfo.flushedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
              </span>
            )}
            {saveStatus === 'saved' && !showSavePanel && (
              <span style={{ fontSize: 11, color: '#22c55e' }}>Saved!</span>
            )}
          </div>
        </div>

        {showSavePanel && canSave && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
            <div className="form-group" style={{ flex: '1 1 200px', marginBottom: 0 }}>
              <label style={{ fontSize: 11 }}>Label</label>
              <input type="text" value={saveLabel} onChange={e => setSaveLabel(e.target.value)}
                placeholder="e.g. Live Apr 10" maxLength={80} style={{ fontSize: 12 }} />
            </div>
            <button type="button" className="btn-primary btn-xs" style={{ flexShrink: 0, alignSelf: 'flex-end', marginBottom: 1 }}
              onClick={handleSaveToCompare} disabled={saveStatus === 'saving'}>
              {saveStatus === 'saving' ? 'Saving...' : 'Save'}
            </button>
            <button type="button" className="btn-secondary btn-xs" style={{ alignSelf: 'flex-end', marginBottom: 1 }}
              onClick={() => setShowSavePanel(false)}>Cancel</button>
            {saveStatus === 'error' && <span style={{ fontSize: 11, color: '#ef4444' }}>{saveError}</span>}
          </div>
        )}

        {/* P&L strip */}
        {lastEvt && (() => {
          const totalPnl    = lastEvt.totalPnl;
          const realizedPnl = lastEvt.realizedPnl;
          const unrealPnl   = lastEvt.unrealizedPnl;
          const cap         = lastEvt.capital;
          const wins        = closedTrades.filter(t => t.pnl > 0).length;
          const losses      = closedTrades.filter(t => t.pnl < 0).length;
          const winRate     = closedTrades.length > 0 ? (wins / closedTrades.length * 100).toFixed(1) + '%' : '—';
          return (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', marginBottom: 12, padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 6, borderLeft: '3px solid ' + (totalPnl > 0 ? '#22c55e' : totalPnl < 0 ? '#ef4444' : 'var(--border)') }}>
              {[
                ['Total P&L',  totalPnl,    true,  true],
                ['Realized',   realizedPnl, true,  false],
                ['Unrealized', unrealPnl,   true,  false],
                ['Capital',    cap,         false, false],
                ['Trades',     closedTrades.length, false, false],
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

        {/* Feed tab */}
        {rightTab === 'feed' && (
          <>
            {lastEvt && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginBottom: 14, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
                {[
                  ['Position', lastEvt.positionState, lastEvt.positionState === 'LONG_CALL' ? '#22c55e' : lastEvt.positionState === 'LONG_PUT' ? '#ef4444' : undefined],
                  ['Bias', lastEvt.niftyBias, lastEvt.niftyBias === 'BULLISH' ? '#22c55e' : lastEvt.niftyBias === 'BEARISH' ? '#ef4444' : undefined],
                  ['Conf Bias', lastEvt.confirmedBias, lastEvt.confirmedBias === 'BULLISH' ? '#22c55e' : lastEvt.confirmedBias === 'BEARISH' ? '#ef4444' : undefined],
                  ['Action', lastEvt.action, lastEvt.action === 'ENTERED' ? '#22c55e' : lastEvt.action === 'EXITED' || lastEvt.action === 'FORCE_CLOSED' ? '#f97316' : undefined],
                  ['Winner', lastEvt.winnerStrategy || (lastEvt.shadowWinner && `(${lastEvt.shadowWinner})`), undefined],
                  ['Score', fmt2(lastEvt.winnerScore || lastEvt.shadowWinnerScore), undefined],
                  ['2nd', lastEvt.secondStrategy ? `${lastEvt.secondStrategy} ${fmt2(lastEvt.secondScore)}` : '—', undefined],
                  ['Gap', fmt2(lastEvt.scoreGap), undefined],
                  ['NeutralReason', lastEvt.neutralReason || '—', lastEvt.neutralReason ? '#f59e0b' : undefined],
                  ['Shadow', lastEvt.shadowWinner ? `${lastEvt.shadowWinner} ${fmt2(lastEvt.shadowWinnerScore)}` : '—', lastEvt.shadowWinner ? '#8b5cf6' : undefined],
                  ['uPnL', fmt2(lastEvt.unrealizedPnl), lastEvt.unrealizedPnl > 0 ? '#22c55e' : lastEvt.unrealizedPnl < 0 ? '#ef4444' : undefined],
                  ['rPnL', fmt2(lastEvt.realizedPnl), lastEvt.realizedPnl > 0 ? '#22c55e' : lastEvt.realizedPnl < 0 ? '#ef4444' : undefined],
                  ['Capital', fmt2(lastEvt.capital), undefined],
                  ['Block', lastEvt.blockReason || '—', lastEvt.blockReason ? '#ef4444' : undefined],
                  ['Exec', lastEvt.execWaitReason || '—', lastEvt.execWaitReason ? '#f59e0b' : undefined],
                ].map(([lbl, val, color]) => (
                  <div key={lbl} style={{ fontSize: 11 }}>
                    <div style={{ color: 'var(--text-secondary)' }}>{lbl}</div>
                    <div style={{ fontWeight: 700, color }}>{val || '—'}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Config summary */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 0', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 10 }}>
              <span style={{ marginRight: 10, fontWeight: 700, color: 'var(--text-primary)' }}>Live:</span>
              <span style={{ marginRight: 14 }}><b style={{ color: 'var(--text-primary)' }}>{nifty.symbol || '—'}</b></span>
              <span style={{ marginRight: 14 }}><b style={{ color: 'var(--text-primary)' }}>{interval}</b></span>
              {cePool.some(i => i.symbol) && <span style={{ marginRight: 14 }}>CE=<b style={{ color: '#22c55e' }}>{cePool.filter(i => i.symbol).map(i => i.symbol).join(', ')}</b></span>}
              {pePool.some(i => i.symbol) && <span style={{ marginRight: 14 }}>PE=<b style={{ color: '#ef4444' }}>{pePool.filter(i => i.symbol).map(i => i.symbol).join(', ')}</b></span>}
              <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
              <span style={{ marginRight: 14 }}>minScore=<b style={{ color: 'var(--text-primary)' }}>{decisionCfg.minScore}</b></span>
              <span style={{ marginRight: 14 }}>gap=<b style={{ color: 'var(--text-primary)' }}>{decisionCfg.minScoreGap}</b></span>
              <span style={{ marginRight: 14 }}>prem=<b style={{ color: 'var(--text-primary)' }}>{selectionCfg.minPremium}–{selectionCfg.maxPremium}</b></span>
              <span style={{ marginRight: 14 }}>switchConf=<b style={{ color: 'var(--text-primary)' }}>{switchCfg.switchConfirmationCandles}</b></span>
              {penaltyConfig.enabled && (
                <>
                  <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                  <span style={{ marginRight: 8, fontWeight: 700, color: '#6366f1' }}>Pen:</span>
                  {penaltyConfig.reversalEnabled       && <span style={{ marginRight: 8 }}>rev≤<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.reversalMax}</b></span>}
                  {penaltyConfig.overextensionEnabled  && <span style={{ marginRight: 8 }}>ext≤<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.overextensionMax}</b></span>}
                  {penaltyConfig.sameColorEnabled      && <span style={{ marginRight: 8 }}>col≤<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.sameColorMax}</b></span>}
                  {penaltyConfig.mismatchEnabled       && <span style={{ marginRight: 8 }}>mis×<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.mismatchScale}</b></span>}
                  {penaltyConfig.volatileOptionEnabled && <span style={{ marginRight: 8 }}>vol=<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.volatileOptionPenalty}</b></span>}
                  {penaltyConfig.movePenaltyEnabled    && <span style={{ marginRight: 8 }}>mv=<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.movePenalty}</b></span>}
                  {penaltyConfig.vwapPenaltyEnabled    && <span style={{ marginRight: 8 }}>vw=<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.vwapPenalty}</b></span>}
                  {penaltyConfig.chopPenaltyEnabled    && <span style={{ marginRight: 8 }}>chp=<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.chopPenalty}</b></span>}
                </>
              )}
              {sessionId && <span style={{ marginLeft: 8, color: '#22c55e', fontWeight: 700 }}>● LIVE sid={sessionId.slice(0, 8)}</span>}
            </div>

            {/* Live ticker strip — shows latest LTP per token */}
            {Object.keys(liveTicks).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10, padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 6, border: '1px solid var(--border-color)' }}>
                {Object.values(liveTicks)
                  .sort((a, b) => (b.isNifty ? 1 : 0) - (a.isNifty ? 1 : 0))
                  .map(t => {
                    const sym = t.isNifty
                      ? (nifty.symbol || 'NIFTY')
                      : ([...cePool, ...pePool].find(c => c.instrumentToken && parseInt(c.instrumentToken,10) === t.token)?.symbol || t.token);
                    const isCe = !t.isNifty && cePool.some(c => c.instrumentToken && parseInt(c.instrumentToken,10) === t.token);
                    const isPe = !t.isNifty && pePool.some(c => c.instrumentToken && parseInt(c.instrumentToken,10) === t.token);
                    const color = t.isNifty ? '#e2e8f0' : isCe ? '#22c55e' : isPe ? '#ef4444' : '#94a3b8';
                    return (
                      <div key={t.token} style={{ fontSize: 11, minWidth: 120, padding: '4px 8px', background: 'var(--bg-primary)', borderRadius: 4, border: `1px solid ${color}33` }}>
                        <div style={{ fontWeight: 700, color, marginBottom: 2 }}>{sym}</div>
                        <div style={{ fontSize: 13, fontWeight: 800, color }}>₹{Number(t.ltp).toFixed(2)}</div>
                        {t.fOpen != null && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                            O:{Number(t.fOpen).toFixed(1)} H:{Number(t.fHigh).toFixed(1)} L:{Number(t.fLow).toFixed(1)}
                          </div>
                        )}
                        <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{new Date(t.timeMs).toLocaleTimeString('en-IN')}</div>
                      </div>
                    );
                  })}
              </div>
            )}

            {feed.length === 0
              ? <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
                  {status === 'running' ? 'Receiving ticks — waiting for first candle close…' : 'Feed will appear once the live session starts.'}
                </div>
              : (
                <div className="bt-opts-feed-wrap">
                  <table className="bt-opts-feed-table">
                    <thead>
                      <tr>
                        <th>Time</th><th>Phase</th><th>NIFTY</th><th>Regime</th><th>Bias</th><th>Conf</th>
                        <th>Winner</th><th>Score</th><th>PenScore</th><th>Str</th><th>2nd</th><th>Gap</th>
                        <th>Shadow</th><th>NeutralReason</th>
                        <th title="Consecutive candles seen">Cnf</th><th title="Candles required">Req</th>
                        <th>State</th><th>Bars</th><th>Hold</th><th>Action</th><th>ExitRsn</th>
                        <th>PeakPnL%</th><th>LockFloor%</th><th>Zone</th><th>TrendMode</th>
                        <th>Option</th><th>Opt Px</th><th>uPnL</th><th>rPnL</th><th>Block</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...feed].reverse().map((evt, i) => (
                        <tr key={i} style={{
                          background:
                            evt.marketPhase === 'PRE_MARKET' ? 'rgba(148,163,184,0.06)' :
                            evt.marketPhase === 'CLOSING'    ? 'rgba(249,115,22,0.06)'  :
                            evt.marketPhase === 'CLOSED'     ? 'rgba(239,68,68,0.06)'   :
                            evt.action === 'ENTERED'         ? 'rgba(34,197,94,0.06)'   :
                            evt.action === 'EXITED'          ? 'rgba(249,115,22,0.06)'  : undefined
                        }}>
                          <td className="de-mono">{(evt.niftyTime || '').slice(0, 16)}</td>
                          <td style={{ fontSize: 10, color:
                            evt.marketPhase === 'PRE_MARKET' ? '#94a3b8' :
                            evt.marketPhase === 'CLOSING'    ? '#f97316' :
                            evt.marketPhase === 'CLOSED'     ? '#ef4444' : undefined
                          }}>{evt.marketPhase || 'TRADING'}</td>
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
                          <td style={{ fontSize: 11, fontWeight: 600, color: evt.confirmCount > 0 && evt.confirmCount < evt.confirmRequired ? '#f59e0b' : evt.confirmCount >= evt.confirmRequired && evt.confirmRequired > 0 ? '#22c55e' : undefined }}>{evt.confirmCount > 0 ? evt.confirmCount : ''}</td>
                          <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{evt.confirmRequired > 0 ? evt.confirmRequired : ''}</td>
                          <td style={{ fontWeight: 600 }}>{evt.positionState || '—'}</td>
                          <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{evt.positionState !== 'FLAT' ? (evt.barsInTrade ?? '—') : ''}</td>
                          <td style={{ fontSize: 11, fontWeight: 600, color: '#14b8a6' }}>{evt.holdActive ? `🔒${evt.barsInTrade}/${evt.appliedMinHold}` : ''}</td>
                          <td style={{ color: evt.action === 'ENTERED' ? '#22c55e' : evt.action === 'EXITED' || evt.action === 'FORCE_CLOSED' ? '#f97316' : undefined }}>{evt.action || '—'}</td>
                          <td style={{ fontSize: 10, color: '#f97316' }}>{evt.exitReason || ''}</td>
                          <td style={{ fontSize: 11, color: evt.peakPnlPct > 0 ? '#22c55e' : undefined }}>{evt.positionState !== 'FLAT' && evt.peakPnlPct != null ? fmt2(evt.peakPnlPct) : ''}</td>
                          <td style={{ fontSize: 11, color: '#14b8a6' }}>{evt.positionState !== 'FLAT' && evt.profitLockFloor != null && evt.profitLockFloor > -1e10 ? fmt2(evt.profitLockFloor) : ''}</td>
                          <td style={{ fontSize: 10, fontWeight: 600, color: '#f59e0b' }}>{evt.inHoldZone ? 'ZONE' : ''}</td>
                          <td style={{ fontSize: 10, fontWeight: 600, color: '#22c55e' }}>{evt.inStrongTrendMode ? '⚡TREND' : ''}</td>
                          <td className="de-mono">{evt.selectedTradingSymbol || '—'}</td>
                          <td>{fmt2(evt.optionClose)}</td>
                          <td style={pnlStyle(evt.unrealizedPnl)}>{fmt2(evt.unrealizedPnl)}</td>
                          <td style={pnlStyle(evt.realizedPnl)}>{fmt2(evt.realizedPnl)}</td>
                          <td style={{ color: evt.blockReason ? '#ef4444' : evt.execWaitReason ? '#f59e0b' : undefined, fontSize: 10 }}>
                            {evt.blockReason || (evt.execWaitReason ? '⚠ ' + evt.execWaitReason : '')}
                          </td>
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

        {/* Chart tab */}
        {rightTab === 'chart' && <ReplayChart feed={feed} closedTrades={closedTrades} />}

        {/* P&L tab */}
        {rightTab === 'pnl' && (
          <>
            {!lastEvt
              ? <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>P&L data will appear as the live session runs.</div>
              : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px 20px' }}>
                  {[
                    ['Total P&L',    lastEvt.totalPnl,    true],
                    ['Realized P&L', lastEvt.realizedPnl, true],
                    ['Unrealized',   lastEvt.unrealizedPnl, true],
                    ['Capital',      lastEvt.capital,     false],
                    ['Trades',       closedTrades.length, false],
                    ['Wins',         closedTrades.filter(t => t.pnl > 0).length, false],
                    ['Losses',       closedTrades.filter(t => t.pnl < 0).length, false],
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
              )
            }
          </>
        )}

        {/* Portfolio tab */}
        {rightTab === 'portfolio' && (
          <>
            {!lastEvt
              ? <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>Position data will appear once the live session starts.</div>
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

        {/* Details tab (closed trades) */}
        {rightTab === 'details' && (
          <>
            {closedTrades.length === 0
              ? <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>Closed trades will appear here as the session runs.</div>
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

      <form onSubmit={handleStart}>
        {/* ── Actions ── */}
        {initInfo && (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, padding: '6px 10px', background: 'var(--bg-secondary)', borderRadius: 4 }}>
            Session started — <strong>{initInfo.warmupCandles}</strong> warmup candles, <strong>{initInfo.ceOptions}</strong> CE + <strong>{initInfo.peOptions}</strong> PE options subscribed
          </div>
        )}
        {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
        {warnings.length > 0 && warnings.map((w, i) => (
          <div key={i} style={{ marginBottom: 8, padding: '8px 12px', background: 'rgba(245,158,11,0.12)', border: '1px solid #f59e0b', borderRadius: 6, fontSize: 12, color: '#f59e0b' }}>
            ⚠ {w}
          </div>
        ))}
        <div className="form-actions" style={{ marginBottom: 16 }}>
          <button type="submit" className="btn-primary" disabled={false}>
            {isRunning ? 'Stop Live Session' : 'Start Options Live'}
          </button>
          {/* Reconnect re-attaches the SSE listener to the running backend session without restarting it */}
          {!isRunning && sessionId && (
            <button type="button" className="btn-secondary" onClick={handleReconnect}>
              Reconnect
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={() => {
            setFeed([]); setInitInfo(null); setWarnings([]); setError(''); setStatus('idle');
            setCanSave(false); setSyncInfo(null);
            setNifty({ symbol: '', exchange: 'NSE', instrumentToken: '' });
            setCePool([EMPTY_OPTION_INST()]); setPePool([EMPTY_OPTION_INST()]);
            setStrategies(defaultStrategies());
            setDecisionCfg(DEFAULT_DECISION); setSelectionCfg(DEFAULT_SELECTION); setSwitchCfg(DEFAULT_SWITCH);
            setOptsRegimeCfg(DEFAULT_OPTS_REGIME_CONFIG); setChopRules(DEFAULT_CHOP_RULES); setTradingRules(DEFAULT_TRADING_RULES);
            setRegimeRules(DEFAULT_REGIME_RULES); setRegimeStrategyRules(DEFAULT_REGIME_STRATEGY_RULES);
            setOptsRisk(DEFAULT_OPTS_RISK); setRangeQuality(DEFAULT_RANGE_QUALITY);
            setTradeQuality(DEFAULT_TRADE_QUALITY); setTrendEntry(DEFAULT_TREND_ENTRY);
            setCompressionEntry(DEFAULT_COMPRESSION_ENTRY); setHoldConfig(DEFAULT_HOLD); setExitConfig(DEFAULT_EXIT_CONFIG);
            setPenaltyConfig(DEFAULT_PENALTY_CONFIG);
            setInterval('MINUTE_5'); setWarmupDays('5'); setQuantity('0'); setCapital('100000');
            setTradingHoursEnabled(true); setCloseoutMins('15');
            ['sma_live_opts_nifty','sma_live_opts_ce_pool','sma_live_opts_pe_pool','sma_live_opts_interval',
             'sma_live_opts_warmup','sma_live_opts_qty','sma_live_opts_capital','sma_live_opts_strategies',
             'sma_live_opts_decision','sma_live_opts_selection','sma_live_opts_switch','sma_live_opts_regime_cfg',
             'sma_live_opts_chop_rules','sma_live_opts_trading_rules','sma_live_opts_regime_rules',
             'sma_live_opts_regime_strat_rules','sma_live_opts_risk','sma_live_opts_range_quality',
             'sma_live_opts_trade_quality','sma_live_opts_trend_entry','sma_live_opts_compression_entry',
             'sma_live_opts_hold_config','sma_live_opts_exit_config','sma_live_opts_penalty_config',
             'sma_live_opts_trading_hours_on','sma_live_opts_closeout_mins'].forEach(k => localStorage.removeItem(k));
          }} disabled={isRunning}>Reset</button>
          {status === 'error' && <span className="badge badge-danger">Error</span>}
          {feed.length > 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 8 }}>
              {feed.length} candles · {closedTrades.length} trades
            </span>
          )}
        </div>

        {/* ── Presets ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: presets.length > 0 || showPresetSave ? 12 : 0, flexWrap: 'wrap' }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Config Presets</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              {presets.length > 0 && (
                <button type="button" className="btn-secondary btn-xs" onClick={downloadAllPresets} title="Export all presets as JSON">
                  Export All
                </button>
              )}
              <label className="btn-secondary btn-xs" style={{ cursor: 'pointer', marginBottom: 0 }} title="Import presets from JSON file">
                Import
                <input type="file" accept=".json" style={{ display: 'none' }} onChange={uploadPresets} />
              </label>
              <button type="button" className="btn-secondary btn-xs"
                onClick={() => setShowPresetSave(s => !s)} disabled={isRunning}>
                {showPresetSave ? 'Cancel' : '+ Save Current'}
              </button>
            </div>
          </div>

          {showPresetSave && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 14, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
              <div className="form-group" style={{ flex: '1 1 160px', marginBottom: 0 }}>
                <label style={{ fontSize: 11 }}>Preset Name *</label>
                <input
                  type="text"
                  value={presetName}
                  onChange={e => setPresetName(e.target.value)}
                  placeholder="e.g. Conservative RANGING"
                  maxLength={60}
                  style={{ fontSize: 12 }}
                />
              </div>
              <div className="form-group" style={{ flex: '2 1 240px', marginBottom: 0 }}>
                <label style={{ fontSize: 11 }}>Description (optional)</label>
                <input
                  type="text"
                  value={presetDescription}
                  onChange={e => setPresetDescription(e.target.value)}
                  placeholder="e.g. High score threshold, no RANGING trades"
                  maxLength={160}
                  style={{ fontSize: 12 }}
                />
              </div>
              <button type="button" className="btn-primary btn-xs" style={{ flexShrink: 0, marginBottom: 1 }}
                onClick={savePreset} disabled={!presetName.trim()}>
                Save
              </button>
            </div>
          )}

          {presets.length === 0 && !showPresetSave && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              No presets saved yet. Click <b>+ Save Current</b> to save your active configuration as a preset.
            </p>
          )}

          {presets.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {presets.map(preset => (
                <div key={preset.id} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  padding: '8px 10px',
                  background: selectedPresetId === preset.id ? 'rgba(99,102,241,0.12)' : 'var(--bg-secondary)',
                  borderRadius: 6,
                  border: selectedPresetId === preset.id ? '1px solid #6366f1' : '1px solid var(--border)',
                  maxWidth: 320, minWidth: 180,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, color: selectedPresetId === preset.id ? '#818cf8' : 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {selectedPresetId === preset.id && <span style={{ marginRight: 4 }}>●</span>}{preset.name}
                    </div>
                    {preset.description && (
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {preset.description}
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                      {new Date(preset.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                    <button type="button" className="btn-primary btn-xs"
                      onClick={() => applyPreset(preset)} disabled={isRunning}
                      title="Apply this preset to current config">
                      Apply
                    </button>
                    <button type="button" className="btn-secondary btn-xs"
                      onClick={() => downloadPreset(preset)}
                      title="Download this preset as JSON"
                      style={{ fontSize: 10 }}>
                      Export
                    </button>
                    <button type="button" className="btn-secondary btn-xs"
                      onClick={() => deletePreset(preset.id)}
                      title="Delete preset"
                      style={{ fontSize: 10 }}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Live Settings ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Live Settings</span>
          <div className="bt-form-grid" style={{ marginTop: 12 }}>
            <div className="form-group">
              <label>Interval</label>
              <select value={interval} onChange={e => setInterval(e.target.value)} disabled={isRunning}>
                {OPT_INTERVALS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Warmup Days</label>
              <input type="number" min="0" max="30" value={warmupDays} onChange={e => setWarmupDays(e.target.value)} disabled={isRunning} />
            </div>
            <div className="form-group">
              <label>Quantity (lots)</label>
              <input type="number" min="0" value={quantity} onChange={e => setQuantity(e.target.value)} disabled={isRunning} />
            </div>
            <div className="form-group">
              <label>Initial Capital (₹)</label>
              <input type="number" min="0" value={capital} onChange={e => setCapital(e.target.value)} disabled={isRunning} />
            </div>
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" id="liveRecordCandles" checked={recordCandles}
                onChange={e => setRecordCandles(e.target.checked)} disabled={isRunning} />
              <label htmlFor="liveRecordCandles" style={{ marginBottom: 0, cursor: 'pointer' }}>
                Record candles to DB
                <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>
                  Saves all closed candles (NIFTY + options) for later replay
                </span>
              </label>
            </div>
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" id="liveRecordTicks" checked={recordTicks}
                onChange={e => setRecordTicks(e.target.checked)} disabled={isRunning} />
              <label htmlFor="liveRecordTicks" style={{ marginBottom: 0, cursor: 'pointer' }}>
                Record raw ticks to DB
                <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', fontWeight: 400 }}>
                  Saves every LTP update (NIFTY + options) for sub-candle analysis
                </span>
              </label>
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ marginBottom: 0 }}>Trading Hours Filter</label>
                <button type="button" className={`btn-sm ${tradingHoursEnabled ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setTradingHoursEnabled(v => !v)} disabled={isRunning}>
                  {tradingHoursEnabled ? 'ON' : 'OFF'}
                </button>
                {tradingHoursEnabled && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    PRE_MARKET &lt;9:15 → no entries &nbsp;|&nbsp; TRADING 9:15–{
                      (() => {
                        const m = parseInt(closeoutMins, 10) || 0;
                        if (m <= 0) return '15:30';
                        const total = 15 * 60 + 30 - m;
                        return `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
                      })()
                    } &nbsp;|&nbsp; CLOSING → manage only &nbsp;|&nbsp; CLOSED 15:30 → force-close
                  </span>
                )}
              </div>
              {tradingHoursEnabled && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <label style={{ marginBottom: 0, whiteSpace: 'nowrap', fontSize: 12 }} title="Stop new entries this many minutes before 15:30 (0 = no closing window)">
                    Closeout Window (min before 15:30)
                  </label>
                  <input type="number" min="0" max="60" value={closeoutMins}
                    onChange={e => setCloseoutMins(e.target.value)} disabled={isRunning}
                    style={{ width: 70 }} />
                </div>
              )}
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
              <button type="button" className="btn-secondary btn-sm" onClick={() => addPoolInst(setPool)} disabled={isRunning}>+ Add</button>
            </div>
            <p className="bt-section-sub" style={{ marginBottom: 10 }}>
              Add {tag} contracts. The engine picks the best-fit instrument each candle based on premium and ATM proximity.
            </p>
            {pool.map(inst => (
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
            Filters applied to the winner score. Only no-signal and score&lt;15 are hard blocks. Trade allowed if penalized score ≥ Penalty Min Score.
          </p>
          <div className="bt-form-grid" style={{ marginTop: 8 }}>
            {[
              ['minScore',                    'Min Score',                ''],
              ['minScoreGap',                 'Min Score Gap',            ''],
              ['penaltyMinScore',             'Penalty Min Score',        ''],
              ['maxRecentMove3',              'Max 3-bar Move %',         ''],
              ['maxRecentMove5',              'Max 5-bar Move %',         ''],
              ['maxAbsVwapDist',              'Max VWAP Dist %',          ''],
              ['minBarsSinceTrade',           'Min Bars Since Trade',     ''],
              ['chopLookback',                'Chop Lookback',            ''],
              ['scoreFloorTrigger',           'Score Floor Trigger',      ''],
              ['scoreFloorMin',               'Score Floor Min',          ''],
              ['bollingerBonusThreshold',     'BOLLINGER Bonus Trigger',  ''],
              ['bollingerBonus',              'BOLLINGER Bonus Pts',      ''],
              ['earlyEntryRisingBars',        'Early Entry Rising Bars',  ''],
              ['rawScoreBypassThreshold',     'Raw Score Bypass Threshold',''],
              ['rawScoreBypassGap',           'Raw Score Bypass Gap',     ''],
              ['bollingerEarlyEntryMinScore', 'BOLLINGER Early Entry Score',''],
            ].map(([key, lbl]) => (
              <div key={key} className="form-group">
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
            <button type="button" className={`btn-sm ${chopRules.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setChopRules(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>
              {chopRules.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {chopRules.enabled && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
              {[
                { key: 'ranging', label: 'RANGING', color: '#f59e0b' },
                { key: 'trending', label: 'TRENDING', color: '#22c55e' },
                { key: 'compression', label: 'COMPRESSION', color: '#0ea5e9' },
                { key: 'volatile', label: 'VOLATILE', color: '#ef4444' },
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
                      <label>Flip Ratio</label>
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
            <button type="button" className={`btn-sm ${optsRegimeCfg.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setOptsRegimeCfg(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>
              {optsRegimeCfg.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: optsRegimeCfg.enabled ? 12 : 0 }}>
            {optsRegimeCfg.enabled
              ? `ADX(${optsRegimeCfg.adxPeriod}) trend >${optsRegimeCfg.adxTrendThreshold} · ATR(${optsRegimeCfg.atrPeriod}) volatile >${optsRegimeCfg.atrVolatilePct}% compress <${optsRegimeCfg.atrCompressionPct}%`
              : 'OFF — every candle is RANGING. Enable to classify as TRENDING / VOLATILE / COMPRESSION / RANGING.'}
          </p>
          {optsRegimeCfg.enabled && (
            <div className="bt-form-grid">
              {[
                ['adxPeriod', 'ADX Period', 2, null, 1],
                ['atrPeriod', 'ATR Period', 2, null, 1],
                ['adxTrendThreshold', 'ADX Trend Threshold', 1, 100, 0.5],
                ['atrVolatilePct', 'ATR Volatile %', 0, null, 0.1],
                ['atrCompressionPct', 'ATR Compression %', 0, null, 0.05],
              ].map(([key, lbl, min, max, step]) => (
                <div key={key} className="form-group">
                  <label>{lbl}</label>
                  <input type="number" min={min} max={max ?? undefined} step={step}
                    value={optsRegimeCfg[key]} onChange={e => setOptsRegimeCfg(p => ({ ...p, [key]: e.target.value }))} disabled={isRunning} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Selection Config ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Option Selection Config</span>
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
          <div style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={selectionCfg.strictPremiumBand ?? true} onChange={e => setSelectionCfg(p => ({ ...p, strictPremiumBand: e.target.checked }))} disabled={isRunning} />
              Strict Premium Band (skip entry if no candidate in range)
            </label>
          </div>
        </div>

        {/* ── Switch Config ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Switch Config</span>
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
              <label>Min Score Improvement for Switch</label>
              <input type="number" min="0" max="50" step="1" value={switchCfg.minScoreImprovementForSwitch} onChange={e => setSwitchCfg(p => ({ ...p, minScoreImprovementForSwitch: e.target.value }))} disabled={isRunning} />
            </div>
          </div>
        </div>

        {/* ── Trading Rules ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Trading Rules</span>
            <button type="button" className={`btn-sm ${tradingRules.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setTradingRules(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>
              {tradingRules.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {tradingRules.enabled && (
            <>
              {[
                ['rangingNoTrade',       'No trade in RANGING regime'],
                ['volatileNoTrade',      'No trade in VOLATILE regime'],
                ['compressionNoTrade',   'No trade in COMPRESSION regime'],
                ['noSameCandleReversal', 'No same-candle reversal'],
              ].map(([key, lbl]) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, paddingRight: 12 }}>{lbl}</span>
                  <button type="button" disabled={isRunning}
                    className={tradingRules[key] ? 'btn-primary btn-xs' : 'btn-secondary btn-xs'}
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
            <button type="button" className={`btn-sm ${regimeRules.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setRegimeRules(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>
              {regimeRules.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {regimeRules.enabled && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
              {[
                { regime: 'RANGING', scoreKey: 'rangingMinScore', gapKey: 'rangingMinScoreGap', color: '#f59e0b' },
                { regime: 'TRENDING', scoreKey: 'trendingMinScore', gapKey: 'trendingMinScoreGap', color: '#22c55e' },
                { regime: 'COMPRESSION', scoreKey: 'compressionMinScore', gapKey: 'compressionMinScoreGap', color: '#0ea5e9' },
              ].map(({ regime: r, scoreKey, gapKey, color }) => (
                <div key={r} style={{ padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 7, borderLeft: `3px solid ${color}` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>{r}</div>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                      <label>Min Score</label>
                      <input type="number" step="1" min="0" max="100" value={regimeRules[scoreKey]}
                        onChange={e => setRegimeRules(p => ({ ...p, [scoreKey]: e.target.value }))} disabled={isRunning} />
                    </div>
                    <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                      <label>Min Score Gap</label>
                      <input type="number" step="1" min="0" max="50" value={regimeRules[gapKey]}
                        onChange={e => setRegimeRules(p => ({ ...p, [gapKey]: e.target.value }))} disabled={isRunning} />
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
            <button type="button" className={`btn-sm ${regimeStrategyRules.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setRegimeStrategyRules(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>
              {regimeStrategyRules.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {regimeStrategyRules.enabled && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
              {[
                { key: 'ranging', label: 'RANGING', color: '#f59e0b' },
                { key: 'trending', label: 'TRENDING', color: '#22c55e' },
                { key: 'compression', label: 'COMPRESSION', color: '#0ea5e9' },
                { key: 'volatile', label: 'VOLATILE', color: '#ef4444' },
              ].map(({ key: rk, label, color }) => (
                <div key={rk} style={{ padding: '10px 14px', background: 'var(--bg-secondary)', borderRadius: 7, borderLeft: `3px solid ${color}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</span>
                    <button type="button"
                      className={`btn-xs ${regimeStrategyRules[rk].enabled ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setRegimeStrategyRules(p => ({ ...p, [rk]: { ...p[rk], enabled: !p[rk].enabled } }))} disabled={isRunning}>
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
            <button type="button" className={`btn-sm ${rangeQuality.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateRangeQuality('enabled', !rangeQuality.enabled)} disabled={isRunning}>
              {rangeQuality.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>RANGING only</span>
          </div>
          {rangeQuality.enabled && (
            <>
              <div className="bt-form-grid" style={{ marginTop: 4 }}>
                {[
                  ['Lookback Bars', 'lookbackBars', '1', null],
                  ['Min Upper Touches', 'minUpperTouches', '1', null],
                  ['Min Lower Touches', 'minLowerTouches', '1', null],
                  ['Band Touch Tol %', 'bandTouchTolerancePct', '0.01', '100'],
                  ['Min Range Width %', 'minRangeWidthPct', '0.01', '100'],
                  ['Max Range Width %', 'maxRangeWidthPct', '0.01', '100'],
                  ['Max Drift Ratio', 'maxDirectionalDriftPctOfRange', '0.01', '1'],
                  ['Chop Flip Limit', 'chopFlipRatioLimit', '0.01', '1'],
                ].map(([label, key, step, max]) => (
                  <div className="form-group" key={key}>
                    <label>{label}</label>
                    <input type="number" min="0" max={max || undefined} step={step}
                      value={rangeQuality[key]} disabled={isRunning} onChange={e => updateRangeQuality(key, e.target.value)} />
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
            <button type="button" className={`btn-sm ${optsRisk.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateOptsRisk('enabled', !optsRisk.enabled)} disabled={isRunning}>
              {optsRisk.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {optsRisk.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['Stop Loss %', 'stopLossPct', '0.1', '100'],
                ['Take Profit %', 'takeProfitPct', '0.1', null],
                ['Max Risk / Trade %', 'maxRiskPerTradePct', '0.1', '100'],
                ['Daily Loss Cap %', 'dailyLossCapPct', '0.1', '100'],
                ['Cooldown Candles', 'cooldownCandles', '1', null],
              ].map(([label, key, step, max]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="0" max={max || undefined} step={step}
                    value={optsRisk[key]} disabled={isRunning} onChange={e => updateOptsRisk(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Trade Quality ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Trade Quality</span>
            <button type="button" className={`btn-sm ${tradeQuality.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateTradeQuality('enabled', !tradeQuality.enabled)} disabled={isRunning}>
              {tradeQuality.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {tradeQuality.enabled && (
            <>
              <div className="bt-form-grid" style={{ marginTop: 4 }}>
                {[
                  ['Strong Score ≥', 'strongScoreThreshold', '1'],
                  ['Normal Score ≥', 'normalScoreThreshold', '1'],
                  ['Weak Loss Cooldown', 'weakTradeLossCooldown', '1'],
                  ['RANGING Weak Min Score', 'weakRangingMinScore', '0.5'],
                  ['RANGING Weak Min Gap', 'weakRangingMinGap', '0.5'],
                  ['RANGING Confirm Candles', 'rangingConfirmCandles', '1'],
                  ['TRENDING Confirm Candles', 'trendingConfirmCandles', '1'],
                ].map(([label, key, step]) => (
                  <div className="form-group" key={key}>
                    <label>{label}</label>
                    <input type="number" min="0" step={step} value={tradeQuality[key]} disabled={isRunning}
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
            <button type="button" className={`btn-sm ${trendEntry.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateTrendEntry('enabled', !trendEntry.enabled)} disabled={isRunning}>
              {trendEntry.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#0ea5e9', fontWeight: 600 }}>TRENDING only</span>
          </div>
          {trendEntry.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['Breakout Lookback', 'breakoutLookback', '1', null],
                ['Min Body %', 'minBodyPct', '1', '100'],
                ['Weak Body % (block)', 'weakBodyPct', '1', '100'],
                ['EMA Period', 'ema9Period', '1', null],
              ].map(([label, key, step, max]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="0" max={max || undefined} step={step}
                    value={trendEntry[key]} disabled={isRunning} onChange={e => updateTrendEntry(key, e.target.value)} />
                </div>
              ))}
              <div className="form-group">
                <label>Score Bypass Weak Body</label>
                <button type="button" className={`btn-sm ${trendEntry.scoreBypassWeakBody ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => updateTrendEntry('scoreBypassWeakBody', !trendEntry.scoreBypassWeakBody)} disabled={isRunning}>
                  {trendEntry.scoreBypassWeakBody ? 'ON' : 'OFF'}
                </button>
              </div>
              <div className="form-group">
                <label>Bypass Score Threshold</label>
                <input type="number" min="0" step="1" value={trendEntry.scoreBypassWeakBodyThreshold} disabled={isRunning}
                  onChange={e => updateTrendEntry('scoreBypassWeakBodyThreshold', e.target.value)} />
              </div>
            </div>
          )}
        </div>

        {/* ── Compression Entry Structure ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Compression Entry Structure</span>
            <button type="button" className={`btn-sm ${compressionEntry.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateCompressionEntry('enabled', !compressionEntry.enabled)} disabled={isRunning}>
              {compressionEntry.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#8b5cf6', fontWeight: 600 }}>COMPRESSION only</span>
          </div>
          {compressionEntry.enabled && (
            <>
              <div className="bt-form-grid" style={{ marginTop: 4 }}>
                {[
                  ['Range Lookback', 'rangeLookback', '1', null],
                  ['Long Zone Max', 'longZoneMax', '0.05', '1'],
                  ['Short Zone Min', 'shortZoneMin', '0.05', '1'],
                  ['No-Trade Zone Min', 'noTradeZoneMin', '0.05', '1'],
                  ['No-Trade Zone Max', 'noTradeZoneMax', '0.05', '1'],
                ].map(([label, key, step, max]) => (
                  <div className="form-group" key={key}>
                    <label>{label}</label>
                    <input type="number" min="0" max={max || undefined} step={step}
                      value={compressionEntry[key]} disabled={isRunning} onChange={e => updateCompressionEntry(key, e.target.value)} />
                  </div>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 8, cursor: isRunning ? 'default' : 'pointer' }}>
                <input type="checkbox" checked={compressionEntry.rejectBreakoutCandle} disabled={isRunning}
                  onChange={e => updateCompressionEntry('rejectBreakoutCandle', e.target.checked)} />
                Reject breakout candles
              </label>
            </>
          )}
        </div>

        {/* ── Min Movement Filter ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Min Movement Filter</span>
            <button type="button" className={`btn-sm ${minMovementFilter.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateMinMovementFilter('enabled', !minMovementFilter.enabled)} disabled={isRunning}>
              {minMovementFilter.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 600 }}>pre-trade filter</span>
          </div>
          {minMovementFilter.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['Lookback Candles', 'minMovementLookbackCandles', '1', null],
                ['Min Movement %',   'minMovementThresholdPercent', '0.01', null],
              ].map(([label, key, step, max]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="0" max={max || undefined} step={step}
                    value={minMovementFilter[key]} disabled={isRunning}
                    onChange={e => updateMinMovementFilter(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Directional Consistency Filter ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Directional Consistency Filter</span>
            <button type="button" className={`btn-sm ${directionalConsistencyFilter.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateDirectionalConsistencyFilter('enabled', !directionalConsistencyFilter.enabled)} disabled={isRunning}>
              {directionalConsistencyFilter.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 600 }}>pre-trade filter</span>
          </div>
          {directionalConsistencyFilter.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['Lookback Candles',       'directionalConsistencyLookbackCandles', '1', null],
                ['Min Same Direction',     'minSameDirectionCandles',               '1', null],
              ].map(([label, key, step, max]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="1" max={max || undefined} step={step}
                    value={directionalConsistencyFilter[key]} disabled={isRunning}
                    onChange={e => updateDirectionalConsistencyFilter(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Candle Strength Filter ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Candle Strength Filter</span>
            <button type="button" className={`btn-sm ${candleStrengthFilter.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateCandleStrengthFilter('enabled', !candleStrengthFilter.enabled)} disabled={isRunning}>
              {candleStrengthFilter.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 600 }}>pre-trade filter</span>
          </div>
          {candleStrengthFilter.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['Lookback Candles',        'candleStrengthLookbackCandles', '1',    null],
                ['Min Avg Body Ratio',      'minAverageBodyRatio',           '0.01',  null],
                ['Min Strong Candles',      'minStrongCandlesRequired',      '1',    null],
              ].map(([label, key, step, max]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="0" max={max || undefined} step={step}
                    value={candleStrengthFilter[key]} disabled={isRunning}
                    onChange={e => updateCandleStrengthFilter(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Stop Loss Cascade Protection ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>SL Cascade Protection</span>
            <button type="button" className={`btn-sm ${cascadeProtection.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateCascadeProtection('enabled', !cascadeProtection.enabled)} disabled={isRunning}>
              {cascadeProtection.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 600 }}>risk control</span>
          </div>
          {cascadeProtection.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['SL Count',        'cascadeStopLossCount',  '1', null],
                ['Window (min)',     'cascadeWindowMinutes',  '1', null],
                ['Pause (min)',      'cascadePauseMinutes',   '1', null],
              ].map(([label, key, step]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="1" step={step}
                    value={cascadeProtection[key]} disabled={isRunning}
                    onChange={e => updateCascadeProtection(key, e.target.value)} />
                </div>
              ))}
              <div className="form-group">
                <label>Per Symbol</label>
                <button type="button" className={`btn-sm ${cascadeProtection.cascadeApplyPerSymbol ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => updateCascadeProtection('cascadeApplyPerSymbol', !cascadeProtection.cascadeApplyPerSymbol)} disabled={isRunning}>
                  {cascadeProtection.cascadeApplyPerSymbol ? 'ON' : 'OFF'}
                </button>
              </div>
              <div className="form-group">
                <label>Per Side</label>
                <button type="button" className={`btn-sm ${cascadeProtection.cascadeApplyPerSide ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => updateCascadeProtection('cascadeApplyPerSide', !cascadeProtection.cascadeApplyPerSide)} disabled={isRunning}>
                  {cascadeProtection.cascadeApplyPerSide ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Real Trend Validation ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Real Trend Validation</span>
            <button type="button" className={`btn-sm ${realTrendConfig.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setRealTrendConfig(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>
              {realTrendConfig.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>fake trend filter</span>
          </div>
          {realTrendConfig.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['Max Overlap Ratio', 'maxOverlapRatio',    '0.01'],
                ['Min Avg Body',      'minAvgBodyRatio',     '0.01'],
                ['Min Body Ratio',    'minStrongBodyRatio',  '0.01'],
                ['Strong Bodies',     'minStrongBodies',     '1'],
                ['Range Expansion',   'minRangeExpansion',   '0.01'],
                ['Persist Bars',      'minPersistBars',      '1'],
              ].map(([label, key, step]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="0" step={step}
                    value={realTrendConfig[key]} disabled={isRunning}
                    onChange={e => setRealTrendConfig(p => ({ ...p, [key]: e.target.value }))} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Hold Config ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Minimum Hold Period</span>
            <button type="button" className={`btn-sm ${holdConfig.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateHoldConfig('enabled', !holdConfig.enabled)} disabled={isRunning}>
              {holdConfig.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {holdConfig.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                { key: 'defaultMinHoldBars',  label: 'Default Min Hold',     step: '1' },
                { key: 'rangingMinHoldBars',  label: 'RANGING Min Hold',     step: '1' },
                { key: 'trendingMinHoldBars', label: 'TRENDING Min Hold',    step: '1' },
                { key: 'strongOppositeScore', label: 'Strong Opp Score',     step: '1' },
                { key: 'persistentExitBars',  label: 'Persistent Exit Bars', step: '1' },
              ].map(({ key, label, step }) => (
                <div key={key} className="form-group">
                  <label>{label}</label>
                  <input type="number" min="0" step={step} value={holdConfig[key]} disabled={isRunning}
                    onChange={e => updateHoldConfig(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Smart Exit System ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Smart Exit System</span>
            <button type="button" className={`btn-sm ${exitConfig.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateExitConfig('enabled', !exitConfig.enabled)} disabled={isRunning}>
              {exitConfig.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {exitConfig.enabled && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#ef4444', marginBottom: 6, marginTop: 4 }}>P1 — Hard Stop Loss</div>
              <div className="bt-form-grid" style={{ marginBottom: 12 }}>
                <div className="form-group">
                  <label>Hard Stop %</label>
                  <input type="number" min="0" step="0.5" value={exitConfig.hardStopPct} disabled={isRunning}
                    onChange={e => updateExitConfig('hardStopPct', e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Hold Zone % (profit threshold)</label>
                  <input type="number" min="0" step="0.5" value={exitConfig.holdZonePct} disabled={isRunning}
                    onChange={e => updateExitConfig('holdZonePct', e.target.value)} />
                </div>
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', marginBottom: 6 }}>P2 — Profit Lock / Trailing</div>
              <div className="bt-form-grid" style={{ marginBottom: 12 }}>
                {[
                  { key: 'lock1TriggerPct', label: 'Lock1 Trigger %', step: '0.5' },
                  { key: 'lock1FloorPct',   label: 'Lock1 Floor %',   step: '0.5' },
                  { key: 'lock2TriggerPct', label: 'Lock2 Trigger %', step: '0.5' },
                  { key: 'lock2FloorPct',   label: 'Lock2 Floor %',   step: '0.5' },
                  { key: 'trailTriggerPct', label: 'Trail Trigger %', step: '0.5' },
                  { key: 'trailFactor',     label: 'Trail Factor',    step: '0.05' },
                ].map(({ key, label, step }) => (
                  <div key={key} className="form-group">
                    <label>{label}</label>
                    <input type="number" min="0" step={step} value={exitConfig[key]} disabled={isRunning}
                      onChange={e => updateExitConfig(key, e.target.value)} />
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#0ea5e9', marginBottom: 6 }}>P4 — Structure Failure</div>
              <div className="bt-form-grid" style={{ marginBottom: 12 }}>
                <div className="form-group">
                  <label>Structure Lookback</label>
                  <input type="number" min="2" step="1" value={exitConfig.structureLookback} disabled={isRunning}
                    onChange={e => updateExitConfig('structureLookback', e.target.value)} />
                </div>
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#8b5cf6', marginBottom: 6 }}>P5c — Bias Reversal</div>
              <div className="bt-form-grid" style={{ marginBottom: 8 }}>
                {[
                  { key: 'strongExitScore',            label: 'Strong Exit Score',           step: '1' },
                  { key: 'trendStrongModeThresholdPct', label: 'Strong Trend Mode Threshold %', step: '1' },
                ].map(({ key, label, step }) => (
                  <div key={key} className="form-group">
                    <label>{label}</label>
                    <input type="number" min="0" step={step} value={exitConfig[key]} disabled={isRunning}
                      onChange={e => updateExitConfig(key, e.target.value)} />
                  </div>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 12, cursor: isRunning ? 'default' : 'pointer' }}>
                <input type="checkbox" checked={exitConfig.biasExitEnabled} disabled={isRunning}
                  onChange={e => updateExitConfig('biasExitEnabled', e.target.checked)} />
                Bias reversal exit enabled
              </label>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#06b6d4', marginBottom: 6 }}>P6 — Time Exits · Dead Trade Kill</div>
              <div className="bt-form-grid" style={{ marginBottom: 12 }}>
                {[
                  { key: 'maxBarsNoImprovement', label: 'Max Bars No Improvement', step: '1' },
                  { key: 'stagnationBars',       label: 'Stagnation Bars',         step: '1' },
                  { key: 'maxBarsRanging',       label: 'Max Bars RANGING',        step: '1' },
                  { key: 'maxBarsDeadTrade',     label: 'Dead Trade Max Bars',     step: '1' },
                  { key: 'deadTradePnlPct',      label: 'Dead Trade PnL %',        step: '0.5' },
                ].map(({ key, label, step }) => (
                  <div key={key} className="form-group">
                    <label>{label}</label>
                    <input type="number" min="0" step={step} value={exitConfig[key]} disabled={isRunning}
                      onChange={e => updateExitConfig(key, e.target.value)} />
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#ec4899', marginBottom: 6 }}>P7 — No-Hope</div>
              <div className="bt-form-grid">
                {[
                  { key: 'noHopeThresholdPct', label: 'No-Hope Threshold %', step: '0.5' },
                  { key: 'noHopeBars',         label: 'No-Hope Bars',        step: '1'   },
                ].map(({ key, label, step }) => (
                  <div key={key} className="form-group">
                    <label>{label}</label>
                    <input type="number" min="0" step={step} value={exitConfig[key]} disabled={isRunning}
                      onChange={e => updateExitConfig(key, e.target.value)} />
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#10b981', marginBottom: 6, marginTop: 8 }}>Breakeven Protection</div>
              <div className="bt-form-grid">
                <div className="form-group">
                  <label>Enabled</label>
                  <button type="button" className={`btn-sm ${exitConfig.breakevenProtectionEnabled ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => updateExitConfig('breakevenProtectionEnabled', !exitConfig.breakevenProtectionEnabled)} disabled={isRunning}>
                    {exitConfig.breakevenProtectionEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>
                {[
                  { key: 'breakevenTriggerPct', label: 'Trigger %', step: '0.5' },
                  { key: 'breakevenOffsetPct',  label: 'Offset %',  step: '0.1' },
                ].map(({ key, label, step }) => (
                  <div key={key} className="form-group">
                    <label>{label}</label>
                    <input type="number" min="0" step={step} value={exitConfig[key]} disabled={isRunning}
                      onChange={e => updateExitConfig(key, e.target.value)} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── Penalty Config ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Penalty Config</span>
            <button type="button" className={`btn-sm ${penaltyConfig.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updatePenaltyConfig('enabled', !penaltyConfig.enabled)} disabled={isRunning}>
              {penaltyConfig.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {penaltyConfig.enabled && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6366f1', marginTop: 12, marginBottom: 6 }}>Signal Penalties</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[
                  { label: 'Reversal',        enabledKey: 'reversalEnabled',        valueKey: 'reversalMax',           valueLabel: 'Max',    step: '1'   },
                  { label: 'Overextension',   enabledKey: 'overextensionEnabled',   valueKey: 'overextensionMax',      valueLabel: 'Max',    step: '1'   },
                  { label: 'Same Color',      enabledKey: 'sameColorEnabled',       valueKey: 'sameColorMax',          valueLabel: 'Max',    step: '1'   },
                  { label: 'Mismatch',        enabledKey: 'mismatchEnabled',        valueKey: 'mismatchScale',         valueLabel: 'Scale',  step: '0.1' },
                  { label: 'Volatile Option', enabledKey: 'volatileOptionEnabled',  valueKey: 'volatileOptionPenalty', valueLabel: 'Penalty',step: '1'   },
                ].map(({ label, enabledKey, valueKey, valueLabel, step }) => (
                  <div key={enabledKey} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                    <button type="button" className={`btn-sm ${penaltyConfig[enabledKey] ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ minWidth: 36 }}
                      onClick={() => updatePenaltyConfig(enabledKey, !penaltyConfig[enabledKey])} disabled={isRunning}>
                      {penaltyConfig[enabledKey] ? 'ON' : 'OFF'}
                    </button>
                    <span style={{ fontSize: 12, width: 130, color: penaltyConfig[enabledKey] ? 'var(--text-primary)' : 'var(--text-muted)' }}>{label}</span>
                    <label style={{ fontSize: 11, margin: 0, minWidth: 36, color: 'var(--text-secondary)' }}>{valueLabel}</label>
                    <input type="number" min="0" step={step} value={penaltyConfig[valueKey]}
                      disabled={isRunning || !penaltyConfig[enabledKey]} style={{ width: 64 }}
                      onChange={e => updatePenaltyConfig(valueKey, e.target.value)} />
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6366f1', marginTop: 12, marginBottom: 6 }}>Entry Penalties</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[
                  { label: 'Move',               enabledKey: 'movePenaltyEnabled',           valueKey: 'movePenalty',               step: '0.5' },
                  { label: 'VWAP',               enabledKey: 'vwapPenaltyEnabled',           valueKey: 'vwapPenalty',               step: '0.5' },
                  { label: 'Chop',               enabledKey: 'chopPenaltyEnabled',           valueKey: 'chopPenalty',               step: '0.5' },
                  { label: 'Range: Drifting',    enabledKey: 'rangeDriftingEnabled',         valueKey: 'rangeDriftingPenalty',      step: '0.5' },
                  { label: 'Range: Poor Struct', enabledKey: 'rangePoorStructureEnabled',    valueKey: 'rangePoorStructurePenalty', step: '0.5' },
                  { label: 'Range: Choppy',      enabledKey: 'rangeChoppyEnabled',           valueKey: 'rangeChoppyPenalty',        step: '0.5' },
                  { label: 'Range: Size',        enabledKey: 'rangeSizeEnabled',             valueKey: 'rangeSizePenalty',          step: '0.5' },
                ].map(({ label, enabledKey, valueKey, step }) => (
                  <div key={enabledKey} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                    <button type="button" className={`btn-sm ${penaltyConfig[enabledKey] ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ minWidth: 36 }}
                      onClick={() => updatePenaltyConfig(enabledKey, !penaltyConfig[enabledKey])} disabled={isRunning}>
                      {penaltyConfig[enabledKey] ? 'ON' : 'OFF'}
                    </button>
                    <span style={{ fontSize: 12, width: 130, color: penaltyConfig[enabledKey] ? 'var(--text-primary)' : 'var(--text-muted)' }}>{label}</span>
                    <label style={{ fontSize: 11, margin: 0, minWidth: 36, color: 'var(--text-secondary)' }}>Penalty</label>
                    <input type="number" min="0" step={step} value={penaltyConfig[valueKey]}
                      disabled={isRunning || !penaltyConfig[enabledKey]} style={{ width: 64 }}
                      onChange={e => updatePenaltyConfig(valueKey, e.target.value)} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── Strategies ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Strategies (on NIFTY)</span>
          <p className="bt-section-sub" style={{ marginBottom: 12 }}>
            All enabled strategies compete each NIFTY candle. The highest-scoring bias wins.
          </p>
          <div className="bt-variants-grid">
            {strategies.map((s, idx) => {
              const color     = STRATEGY_COLORS[s.strategyType] || '#6366f1';
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

      {showStartConfirm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)',
            display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
          <div style={{ background:'#1e1e2e', border:'1px solid #f38ba8', borderRadius:10,
              padding:'28px 32px', maxWidth:420, width:'90%', textAlign:'center' }}>
            <div style={{ fontSize:22, marginBottom:12 }}>⚠️</div>
            <div style={{ fontWeight:700, fontSize:16, marginBottom:8, color:'#f38ba8' }}>
              Unsaved Session Data
            </div>
            <div style={{ color:'#cdd6f4', marginBottom:20, fontSize:14, lineHeight:1.5 }}>
              The previous session has data pending save to compare.
              Starting a new session will make it harder to recover.<br /><br />
              Type <strong>yes</strong> to confirm and start anyway.
            </div>
            <input autoFocus value={startConfirmText}
              onChange={e => setStartConfirmText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && startConfirmText.toLowerCase() === 'yes') handleConfirmedStart();
                if (e.key === 'Escape') { setShowStartConfirm(false); setStartConfirmText(''); }
              }}
              placeholder="Type yes to confirm"
              style={{ width:'100%', padding:'8px 12px', borderRadius:6, marginBottom:16,
                border:'1px solid #45475a', background:'#181825', color:'#cdd6f4',
                fontSize:14, textAlign:'center', boxSizing:'border-box' }} />
            <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
              <button className="btn-secondary"
                onClick={() => { setShowStartConfirm(false); setStartConfirmText(''); }}>
                Cancel
              </button>
              <button className="btn-primary"
                disabled={startConfirmText.toLowerCase() !== 'yes'}
                onClick={handleConfirmedStart}>
                Start Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {showStopConfirm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.55)',
            display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000 }}>
          <div style={{ background:'#1e1e2e', border:'1px solid #f38ba8', borderRadius:10,
              padding:'28px 32px', maxWidth:420, width:'90%', textAlign:'center' }}>
            <div style={{ fontSize:22, marginBottom:12 }}>⚠️</div>
            <div style={{ fontWeight:700, fontSize:16, marginBottom:8, color:'#f38ba8' }}>
              Stop Live Session?
            </div>
            <div style={{ color:'#cdd6f4', marginBottom:20, fontSize:14, lineHeight:1.5 }}>
              The session has live data that hasn't been saved to compare yet.
              Stopping will end the session — make sure to save before starting a new one.<br /><br />
              Type <strong>yes</strong> to confirm and stop.
            </div>
            <input autoFocus value={stopConfirmText}
              onChange={e => setStopConfirmText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && stopConfirmText.toLowerCase() === 'yes') handleConfirmedStop();
                if (e.key === 'Escape') { setShowStopConfirm(false); setStopConfirmText(''); }
              }}
              placeholder="Type yes to confirm"
              style={{ width:'100%', padding:'8px 12px', borderRadius:6, marginBottom:16,
                border:'1px solid #45475a', background:'#181825', color:'#cdd6f4',
                fontSize:14, textAlign:'center', boxSizing:'border-box' }} />
            <div style={{ display:'flex', gap:10, justifyContent:'center' }}>
              <button className="btn-secondary"
                onClick={() => { setShowStopConfirm(false); setStopConfirmText(''); }}>
                Cancel
              </button>
              <button className="btn-primary"
                disabled={stopConfirmText.toLowerCase() !== 'yes'}
                onClick={handleConfirmedStop}>
                Stop Session
              </button>
            </div>
          </div>
        </div>
      )}
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
  scoreFloorTrigger: '35', scoreFloorMin: '25',
  bollingerBonusThreshold: '35', bollingerBonus: '5',
  earlyEntryRisingBars: '2',
  rawScoreBypassThreshold: '30', rawScoreBypassGap: '3',
  bollingerEarlyEntryMinScore: '28',
};
const DEFAULT_SELECTION = { minPremium: '50', maxPremium: '300', strictPremiumBand: true };
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
  compressionNoTrade:   false,
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
  minRangeWidthPct:              '0.3',
  maxRangeWidthPct:              '3.0',
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
  weakRangingMinScore:   '28',
  weakRangingMinGap:     '3',
  rangingConfirmCandles: '2',
  trendingConfirmCandles:'1',
};
const DEFAULT_TREND_ENTRY = {
  enabled:         false,
  breakoutLookback:'5',
  minBodyPct:      '45',
  weakBodyPct:     '20',
  ema9Period:      '9',
  scoreBypassWeakBody:          false,
  scoreBypassWeakBodyThreshold: '25',
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
const DEFAULT_EXIT_CONFIG = {
  enabled:                      true,
  // P1 — Hard Stop Loss (always; fires from inside hold zone)
  hardStopPct:                  '7',
  // Hold Zone — no exit below this profit (except SL + dead trade kill)
  holdZonePct:                  '5',
  // P2 — Profit Lock tiers (only arm once profit clears holdZonePct)
  lock1TriggerPct:              '5',    // +5%  → floor 2%
  lock1FloorPct:                '2',
  lock2TriggerPct:              '10',   // +10% → floor 5%
  lock2FloorPct:                '5',
  trailTriggerPct:              '15',   // +15% → trail 40% of peak
  trailFactor:                  '0.4',
  // P3 — First-move protection (disabled; hold zone supersedes it)
  firstMoveBars:                '0',
  firstMoveLockPct:             '0.5',
  // P4 — Structure failure (skipped in RANGING)
  structureLookback:            '5',
  // P5a/P5b — Score exits: DISABLED (score must NOT trigger exit)
  scoreDropFactor:              '0',
  scoreAbsoluteMin:             '0',
  // P5c — Bias exit
  biasExitEnabled:              true,
  strongExitScore:              '40',   // TRENDING: requires this score to exit
  // Strong Trend Mode — TRENDING + peak > this → only P1/P2/strong-bias exits
  trendStrongModeThresholdPct:  '5',
  // P6a/P6b — Time exit (non-TRENDING only)
  maxBarsNoImprovement:         '3',
  stagnationBars:               '2',
  // P6c — RANGING time limit
  maxBarsRanging:               '6',
  // P6d — Dead Trade kill (any regime; fires from inside hold zone)
  maxBarsDeadTrade:             '10',
  deadTradePnlPct:              '2',
  // P7 — No-hope (non-TRENDING only)
  noHopeThresholdPct:           '1.5',
  noHopeBars:                   '2',
  // Breakeven Protection — floor exit at entry once favorable move >= trigger
  breakevenProtectionEnabled:   true,
  breakevenTriggerPct:          '2',
  breakevenOffsetPct:           '0',
};

const DEFAULT_PENALTY_CONFIG = {
  enabled: true,
  // Signal-level
  reversalEnabled:           true,  reversalMax:              '25',
  overextensionEnabled:      true,  overextensionMax:         '30',
  sameColorEnabled:          true,  sameColorMax:             '30',
  mismatchEnabled:           true,  mismatchScale:            '1.0',
  volatileOptionEnabled:     true,  volatileOptionPenalty:    '35',
  // Entry-level
  movePenaltyEnabled:        true,  movePenalty:              '3',
  vwapPenaltyEnabled:        true,  vwapPenalty:              '5',
  chopPenaltyEnabled:        true,  chopPenalty:              '2',
  rangeDriftingEnabled:      true,  rangeDriftingPenalty:     '3',
  rangePoorStructureEnabled: true,  rangePoorStructurePenalty:'4',
  rangeChoppyEnabled:        true,  rangeChoppyPenalty:       '2',
  rangeSizeEnabled:          true,  rangeSizePenalty:         '2',
};
const DEFAULT_MIN_MOVEMENT_FILTER = {
  enabled:                    false,
  minMovementLookbackCandles: 3,
  minMovementThresholdPercent:'1.0',
};

const DEFAULT_DIRECTIONAL_CONSISTENCY_FILTER = {
  enabled:                              false,
  directionalConsistencyLookbackCandles: 3,
  minSameDirectionCandles:               2,
};

const DEFAULT_CANDLE_STRENGTH_FILTER = {
  enabled:                    false,
  candleStrengthLookbackCandles: 3,
  minAverageBodyRatio:           '0.50',
  minStrongCandlesRequired:      2,
};
const DEFAULT_NO_NEW_TRADES_AFTER_TIME = {
  enabled:               false,
  noNewTradesAfterTime:  '14:45',
};
const DEFAULT_CASCADE_PROTECTION = {
  enabled:               false,
  cascadeStopLossCount:  2,
  cascadeWindowMinutes:  30,
  cascadePauseMinutes:   30,
  cascadeApplyPerSymbol: false,
  cascadeApplyPerSide:   false,
};
const DEFAULT_REAL_TREND_CONFIG = {
  enabled:            false,
  maxOverlapRatio:    '0.6',
  minAvgBodyRatio:    '0.5',
  minStrongBodyRatio: '0.6',
  minStrongBodies:    2,
  minRangeExpansion:  '1.2',
  minPersistBars:     2,
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

    // Deduplicate feed by niftyTime: tick-level (TICK_EVAL) events share a bucket start
    // time with subsequent tick updates and the eventual closed-candle event.
    // Keep only the last entry per timestamp so the chart always shows the freshest state.
    const feedMap = new Map();
    feed.forEach(e => { if (e.niftyTime) feedMap.set(e.niftyTime, e); });
    const feedDeduped = [...feedMap.values()].sort(
      (a, b) => toUtcSec(a.niftyTime) - toUtcSec(b.niftyTime)
    );

    // ── Candles ──
    const candleData = feedDeduped.map(e => ({
      time:  toUtcSec(e.niftyTime),
      open:  e.niftyOpen,
      high:  e.niftyHigh,
      low:   e.niftyLow,
      close: e.niftyClose,
    })).filter(d => d.time > 0);
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
    const vwapData = feedDeduped
      .filter(e => e.distanceFromVwap != null && e.niftyClose != null && toUtcSec(e.niftyTime) > 0)
      .map(e => {
        const d = e.distanceFromVwap / 100;        // decimal fraction
        const vwap = e.niftyClose / (1 + d);       // close = vwap*(1+d)
        return { time: toUtcSec(e.niftyTime), value: vwap };
      });
    vwapRef.current.setData(vwapData);

    // ── Regime bands (background shading) ─────────────────────────────────
    // Remove old bands
    regimeBandRefs.current.forEach(s => { try { chart.removeSeries(s); } catch {} });
    regimeBandRefs.current = [];

    if (showRegime && feedDeduped.length > 1) {
      // Group consecutive candles by regime → build segments
      const segments = [];
      let seg = { regime: feedDeduped[0].regime, start: 0, end: 0 };
      for (let i = 1; i < feedDeduped.length; i++) {
        if (feedDeduped[i].regime === seg.regime) {
          seg.end = i;
        } else {
          segments.push({ ...seg });
          seg = { regime: feedDeduped[i].regime, start: i, end: i };
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
    feedDeduped.forEach(e => {
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
  const [holdConfig,           setHoldConfig]           = useState(() => ({ ...DEFAULT_HOLD,           ...ls('sma_opts_hold_config',    {}) }));
  const [exitConfig,           setExitConfig]           = useState(() => ({ ...DEFAULT_EXIT_CONFIG,    ...ls('sma_opts_exit_config',    {}) }));
  const [penaltyConfig,        setPenaltyConfig]        = useState(() => ({ ...DEFAULT_PENALTY_CONFIG, ...ls('sma_opts_penalty_config',  {}) }));
  const [minMovementFilter,              setMinMovementFilter]              = useState(() => ls('sma_opts_min_movement_filter',                      DEFAULT_MIN_MOVEMENT_FILTER));
  const [directionalConsistencyFilter,   setDirectionalConsistencyFilter]   = useState(() => ls('sma_opts_directional_consistency_filter',             DEFAULT_DIRECTIONAL_CONSISTENCY_FILTER));
  const [candleStrengthFilter,           setCandleStrengthFilter]           = useState(() => ls('sma_opts_candle_strength_filter',                   DEFAULT_CANDLE_STRENGTH_FILTER));
  const [cascadeProtection,              setCascadeProtection]              = useState(() => ls('sma_opts_cascade_protection',              DEFAULT_CASCADE_PROTECTION));
  const [realTrendConfig,                setRealTrendConfig]                = useState(() => ls('sma_opts_real_trend_config',                DEFAULT_REAL_TREND_CONFIG));

  function updateOptsRisk(key, val)                    { setOptsRisk(p                      => ({ ...p, [key]: val })); }
  function updateRangeQuality(key, val)                { setRangeQuality(p                  => ({ ...p, [key]: val })); }
  function updateHoldConfig(key, val)                  { setHoldConfig(p                    => ({ ...p, [key]: val })); }
  function updateExitConfig(key, val)                  { setExitConfig(p                    => ({ ...p, [key]: val })); }
  function updatePenaltyConfig(key, val)               { setPenaltyConfig(p                 => ({ ...p, [key]: val })); }
  function updateTradeQuality(key, val)                { setTradeQuality(p                  => ({ ...p, [key]: val })); }
  function updateTrendEntry(key, val)                  { setTrendEntry(p                    => ({ ...p, [key]: val })); }
  function updateCompressionEntry(key, val)            { setCompressionEntry(p              => ({ ...p, [key]: val })); }
  function updateMinMovementFilter(key, val)           { setMinMovementFilter(p             => ({ ...p, [key]: val })); }
  function updateDirectionalConsistencyFilter(key, val){ setDirectionalConsistencyFilter(p  => ({ ...p, [key]: val })); }
  function updateCandleStrengthFilter(key, val)        { setCandleStrengthFilter(p          => ({ ...p, [key]: val })); }

  function updateCascadeProtection(key, val)           { setCascadeProtection(p             => ({ ...p, [key]: val })); }
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
  // ── Config presets ────────────────────────────────────────────────────────
  const [presets, setPresets] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sma_opts_presets') || '[]'); } catch { return []; }
  });
  const [presetName,        setPresetName]        = useState('');
  const [presetDescription, setPresetDescription] = useState('');
  const [showPresetSave,    setShowPresetSave]    = useState(false);

  function capturePresetConfig() {
    return {
      interval, warmupDays, quantity, capital,
      strategies,
      decisionCfg, selectionCfg, switchCfg,
      optsRegimeCfg, chopRules, tradingRules, regimeRules, regimeStrategyRules,
      optsRisk, rangeQuality, tradeQuality, trendEntry, compressionEntry,
      holdConfig, exitConfig, penaltyConfig, minMovementFilter, directionalConsistencyFilter, candleStrengthFilter,
      cascadeProtection, realTrendConfig,
    };
  }

  const selectedPresetId = (() => {
    const { nifty: _n, cePool: _ce, pePool: _pe, ...currentCmp } = capturePresetConfig();
    const current = JSON.stringify(currentCmp);
    return presets.find(p => {
      const { nifty: _n2, cePool: _ce2, pePool: _pe2, ...presetCmp } = p.config;
      return JSON.stringify(presetCmp) === current;
    })?.id ?? null;
  })();

  function savePreset() {
    if (!presetName.trim()) return;
    const preset = {
      id:          Date.now().toString(),
      name:        presetName.trim(),
      description: presetDescription.trim(),
      createdAt:   new Date().toISOString(),
      config:      capturePresetConfig(),
    };
    const next = [preset, ...presets];
    setPresets(next);
    try { localStorage.setItem('sma_opts_presets', JSON.stringify(next)); } catch {}
    setPresetName(''); setPresetDescription(''); setShowPresetSave(false);
  }

  function applyPreset(preset) {
    const c = preset.config;
    if (c.interval     !== undefined) setInterval(c.interval);
    if (c.warmupDays   !== undefined) setWarmupDays(c.warmupDays);
    if (c.quantity     !== undefined) setQuantity(c.quantity);
    if (c.capital      !== undefined) setCapital(c.capital);
    if (c.strategies   !== undefined) setStrategies(c.strategies);
    if (c.decisionCfg  !== undefined) setDecisionCfg(c.decisionCfg);
    if (c.selectionCfg !== undefined) setSelectionCfg(c.selectionCfg);
    if (c.switchCfg    !== undefined) setSwitchCfg(c.switchCfg);
    if (c.optsRegimeCfg        !== undefined) setOptsRegimeCfg(c.optsRegimeCfg);
    if (c.chopRules            !== undefined) setChopRules(c.chopRules);
    if (c.tradingRules         !== undefined) setTradingRules(c.tradingRules);
    if (c.regimeRules          !== undefined) setRegimeRules(c.regimeRules);
    if (c.regimeStrategyRules  !== undefined) setRegimeStrategyRules(c.regimeStrategyRules);
    if (c.optsRisk             !== undefined) setOptsRisk(c.optsRisk);
    if (c.rangeQuality         !== undefined) setRangeQuality(c.rangeQuality);
    if (c.tradeQuality         !== undefined) setTradeQuality(c.tradeQuality);
    setTrendEntry({ ...DEFAULT_TREND_ENTRY, ...(c.trendEntry ?? {}) });
    if (c.compressionEntry     !== undefined) setCompressionEntry(c.compressionEntry);
    setHoldConfig({ ...DEFAULT_HOLD, ...(c.holdConfig ?? {}) });
    setExitConfig({ ...DEFAULT_EXIT_CONFIG, ...(c.exitConfig ?? {}) });
    setPenaltyConfig({ ...DEFAULT_PENALTY_CONFIG, ...(c.penaltyConfig ?? {}) });
    setMinMovementFilter(c.minMovementFilter ?? DEFAULT_MIN_MOVEMENT_FILTER);
    setDirectionalConsistencyFilter(c.directionalConsistencyFilter ?? DEFAULT_DIRECTIONAL_CONSISTENCY_FILTER);
    setCandleStrengthFilter(c.candleStrengthFilter ?? DEFAULT_CANDLE_STRENGTH_FILTER);
    setCascadeProtection(c.cascadeProtection ?? DEFAULT_CASCADE_PROTECTION);
    setRealTrendConfig({ ...DEFAULT_REAL_TREND_CONFIG, ...(c.realTrendConfig ?? {}) });
  }

  function deletePreset(id) {
    const preset = presets.find(p => p.id === id);
    if (!window.confirm(`Delete preset "${preset?.name}"?`)) return;
    const next = presets.filter(p => p.id !== id);
    setPresets(next);
    try { localStorage.setItem('sma_opts_presets', JSON.stringify(next)); } catch {}
  }

  function downloadPreset(preset) {
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `preset-${preset.name.replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadAllPresets() {
    const blob = new Blob([JSON.stringify(presets, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'sma_opts_presets.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function uploadPresets(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target.result);
        const incoming = Array.isArray(parsed) ? parsed : [parsed];
        if (!incoming.every(p => p.id && p.name && p.config)) {
          alert('Invalid preset file — each preset must have id, name, and config fields.');
          return;
        }
        const existingIds = new Set(presets.map(p => p.id));
        const toAdd = incoming.filter(p => !existingIds.has(p.id));
        const next  = [...toAdd, ...presets];
        setPresets(next);
        try { localStorage.setItem('sma_opts_presets', JSON.stringify(next)); } catch {}
      } catch { alert('Failed to parse preset file — must be valid JSON.'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

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
  useEffect(() => { try { localStorage.setItem('sma_opts_exit_config',            JSON.stringify(exitConfig));          } catch {} }, [exitConfig]);
  useEffect(() => { try { localStorage.setItem('sma_opts_penalty_config',         JSON.stringify(penaltyConfig));       } catch {} }, [penaltyConfig]);
  useEffect(() => { try { localStorage.setItem('sma_opts_min_movement_filter',              JSON.stringify(minMovementFilter));             } catch {} }, [minMovementFilter]);
  useEffect(() => { try { localStorage.setItem('sma_opts_directional_consistency_filter',   JSON.stringify(directionalConsistencyFilter));  } catch {} }, [directionalConsistencyFilter]);
  useEffect(() => { try { localStorage.setItem('sma_opts_candle_strength_filter',           JSON.stringify(candleStrengthFilter));          } catch {} }, [candleStrengthFilter]);
  useEffect(() => { try { localStorage.setItem('sma_opts_cascade_protection',            JSON.stringify(cascadeProtection));             } catch {} }, [cascadeProtection]);
  useEffect(() => { try { localStorage.setItem('sma_opts_real_trend_config',             JSON.stringify(realTrendConfig));               } catch {} }, [realTrendConfig]);

  // ── Run state
  const [status,   setStatus]   = useState('idle'); // idle|running|completed|error
  const [feed,     setFeed]     = useState([]);      // OptionsReplayCandleEvent[]
  const [summary,  setSummary]  = useState(null);    // final summary event data
  const [initInfo, setInitInfo] = useState(null);    // { totalCandles, warmupCandles }
  const [error,    setError]    = useState('');
  const [rightTab, setRightTab] = useState('feed');
  const abortRef     = useRef(null);
  const readerRef    = useRef(null);
  const lastRunPcRef = useRef(null);

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
    lines.push(row('Min Premium', 'Max Premium', 'Strict Premium Band'));
    lines.push(row(selectionCfg.minPremium, selectionCfg.maxPremium, selectionCfg.strictPremiumBand ? 'ON' : 'OFF'));
    lines.push(blank);

    // ── Switch Config ───────────────────────────────────────────────────────
    lines.push(row('=== Switch Config ==='));
    lines.push(row('Switch Confirmation Candles', 'Max Switches Per Day'));
    lines.push(row(switchCfg.switchConfirmationCandles, switchCfg.maxSwitchesPerDay));
    lines.push(blank);

    // ── Trading Rules ────────────────────────────────────────────────────────
    lines.push(row('=== Trading Rules ==='));
    lines.push(row('Enabled', 'No Trade in RANGING', 'No Trade in VOLATILE', 'No Trade in COMPRESSION', 'No Same-Candle Reversal'));
    lines.push(row(
      tradingRules.enabled ? 'Yes' : 'No',
      tradingRules.rangingNoTrade       ? 'ON' : 'OFF',
      tradingRules.volatileNoTrade      ? 'ON' : 'OFF',
      tradingRules.compressionNoTrade   ? 'ON' : 'OFF',
      tradingRules.noSameCandleReversal ? 'ON' : 'OFF',
    ));
    lines.push(blank);

    // ── Min Movement Filter ──────────────────────────────────────────────────
    lines.push(row('=== Min Movement Filter ==='));
    lines.push(row('Enabled', 'Lookback Candles', 'Threshold %'));
    lines.push(row(
      minMovementFilter.enabled ? 'ON' : 'OFF',
      minMovementFilter.minMovementLookbackCandles,
      minMovementFilter.minMovementThresholdPercent,
    ));
    lines.push(blank);

    // ── Directional Consistency Filter ──────────────────────────────────────
    lines.push(row('=== Directional Consistency Filter ==='));
    lines.push(row('Enabled', 'Lookback Candles', 'Min Same Direction Candles'));
    lines.push(row(
      directionalConsistencyFilter.enabled ? 'ON' : 'OFF',
      directionalConsistencyFilter.directionalConsistencyLookbackCandles,
      directionalConsistencyFilter.minSameDirectionCandles,
    ));
    lines.push(blank);

    // ── Candle Strength Filter ───────────────────────────────────────────────
    lines.push(row('=== Candle Strength Filter ==='));
    lines.push(row('Enabled', 'Lookback Candles', 'Min Avg Body Ratio', 'Min Strong Candles'));
    lines.push(row(
      candleStrengthFilter.enabled ? 'ON' : 'OFF',
      candleStrengthFilter.candleStrengthLookbackCandles,
      candleStrengthFilter.minAverageBodyRatio,
      candleStrengthFilter.minStrongCandlesRequired,
    ));
    lines.push(blank);

    // ── SL Cascade Protection ────────────────────────────────────────────────
    lines.push(row('=== SL Cascade Protection ==='));
    lines.push(row('Enabled', 'SL Count', 'Window (min)', 'Pause (min)', 'Per Symbol', 'Per Side'));
    lines.push(row(
      cascadeProtection.enabled ? 'ON' : 'OFF',
      cascadeProtection.cascadeStopLossCount,
      cascadeProtection.cascadeWindowMinutes,
      cascadeProtection.cascadePauseMinutes,
      cascadeProtection.cascadeApplyPerSymbol ? 'ON' : 'OFF',
      cascadeProtection.cascadeApplyPerSide ? 'ON' : 'OFF',
    ));
    lines.push(blank);

    // ── Real Trend Validation ────────────────────────────────────────────────
    lines.push(row('=== Real Trend Validation ==='));
    lines.push(row('Enabled', 'Max Overlap Ratio', 'Min Avg Body', 'Min Body Ratio', 'Strong Bodies', 'Range Expansion', 'Persist Bars'));
    lines.push(row(
      realTrendConfig.enabled ? 'ON' : 'OFF',
      realTrendConfig.maxOverlapRatio,
      realTrendConfig.minAvgBodyRatio,
      realTrendConfig.minStrongBodyRatio,
      realTrendConfig.minStrongBodies,
      realTrendConfig.minRangeExpansion,
      realTrendConfig.minPersistBars,
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
    lines.push(row('Enabled', 'Breakout Lookback', 'Min Body %', 'Weak Body %', 'EMA Period', 'Score Bypass Weak Body', 'Bypass Score Threshold'));
    lines.push(row(
      trendEntry.enabled ? 'Yes' : 'No',
      trendEntry.breakoutLookback, trendEntry.minBodyPct, trendEntry.weakBodyPct, trendEntry.ema9Period,
      trendEntry.scoreBypassWeakBody ? 'ON' : 'OFF', trendEntry.scoreBypassWeakBodyThreshold,
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

    // ── Exit System ──────────────────────────────────────────────────────────
    lines.push(row('=== Exit System ==='));
    lines.push(row('Enabled', 'Hard Stop %', 'Hold Zone %',
      'Lock1 Trigger %', 'Lock1 Floor %', 'Lock2 Trigger %', 'Lock2 Floor %',
      'Trail Trigger %', 'Trail Factor',
      'Structure Lookback',
      'Score Abs Min', 'Bias Exit', 'Strong Exit Score',
      'Trend Strong Mode Threshold %',
      'Max Bars No Improvement', 'Stagnation Bars', 'Max Bars RANGING',
      'Max Bars Dead Trade', 'Dead Trade PnL %',
      'No-Hope Threshold %', 'No-Hope Bars', 'Breakeven Protection', 'Breakeven Trigger %', 'Breakeven Offset %'));
    lines.push(row(
      exitConfig.enabled ? 'Yes' : 'No',
      exitConfig.hardStopPct, exitConfig.holdZonePct,
      exitConfig.lock1TriggerPct, exitConfig.lock1FloorPct,
      exitConfig.lock2TriggerPct, exitConfig.lock2FloorPct,
      exitConfig.trailTriggerPct, exitConfig.trailFactor,
      exitConfig.structureLookback,
      exitConfig.scoreAbsoluteMin,
      exitConfig.biasExitEnabled ? 'Yes' : 'No', exitConfig.strongExitScore,
      exitConfig.trendStrongModeThresholdPct,
      exitConfig.maxBarsNoImprovement, exitConfig.stagnationBars, exitConfig.maxBarsRanging,
      exitConfig.maxBarsDeadTrade, exitConfig.deadTradePnlPct,
      exitConfig.noHopeThresholdPct, exitConfig.noHopeBars,
      exitConfig.breakevenProtectionEnabled ? 'ON' : 'OFF',
      exitConfig.breakevenTriggerPct, exitConfig.breakevenOffsetPct,
    ));
    lines.push(blank);

    // ── Penalty Config ───────────────────────────────────────────────────────
    const csvPc = lastRunPcRef.current || penaltyConfig;
    lines.push(row('=== Penalty Config (as used in this run) ==='));
    lines.push(row('Master', csvPc.enabled ? 'ON' : 'OFF'));
    if (csvPc.enabled) {
      lines.push(row('Signal Penalty', 'Enabled', 'Value'));
      lines.push(row('Reversal',        csvPc.reversalEnabled        ? 'ON' : 'OFF', `Max=${csvPc.reversalMax}`));
      lines.push(row('Overextension',   csvPc.overextensionEnabled   ? 'ON' : 'OFF', `Max=${csvPc.overextensionMax}`));
      lines.push(row('Same Color',      csvPc.sameColorEnabled       ? 'ON' : 'OFF', `Max=${csvPc.sameColorMax}`));
      lines.push(row('Mismatch',        csvPc.mismatchEnabled        ? 'ON' : 'OFF', `Scale=${csvPc.mismatchScale}`));
      lines.push(row('Volatile Option', csvPc.volatileOptionEnabled  ? 'ON' : 'OFF', `Penalty=${csvPc.volatileOptionPenalty}`));
      lines.push(row('Entry Penalty', 'Enabled', 'Value'));
      lines.push(row('Move',           csvPc.movePenaltyEnabled         ? 'ON' : 'OFF', csvPc.movePenalty));
      lines.push(row('VWAP',           csvPc.vwapPenaltyEnabled         ? 'ON' : 'OFF', csvPc.vwapPenalty));
      lines.push(row('Chop',           csvPc.chopPenaltyEnabled         ? 'ON' : 'OFF', csvPc.chopPenalty));
      lines.push(row('Range Drifting', csvPc.rangeDriftingEnabled       ? 'ON' : 'OFF', csvPc.rangeDriftingPenalty));
      lines.push(row('Range Poor Str', csvPc.rangePoorStructureEnabled  ? 'ON' : 'OFF', csvPc.rangePoorStructurePenalty));
      lines.push(row('Range Choppy',   csvPc.rangeChoppyEnabled         ? 'ON' : 'OFF', csvPc.rangeChoppyPenalty));
      lines.push(row('Range Size',     csvPc.rangeSizeEnabled           ? 'ON' : 'OFF', csvPc.rangeSizePenalty));
    }
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
        'Entry Px', 'Exit Px', 'Qty', 'P&L', 'P&L %', 'Bars', 'Exit Reason', 'Capital After', 'Entry Regime', 'Exit Regime'));
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
        t.entryRegime || '', t.exitRegime || '',
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
        'Entry Allowed', 'Block Reason', 'Exec Wait Reason',
        'Switch Requested', 'Switch Confirmed', 'Switch Reason', 'Switch Count Today', 'Confirm Count', 'Confirm Required',
        'Bars Since Trade',
        // Candidates (compact signal:score:eligible per strategy)
        'Candidates',
        // Execution
        'Position State', 'Desired Side', 'Action', 'Exit Reason',
        'Entry Regime', 'Applied Min Hold', 'Hold Active',
        'Peak PnL %', 'Profit Lock Floor %', 'In Hold Zone', 'In Strong Trend Mode',
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
        e.entryAllowed ? 'Yes' : 'No', e.blockReason || '', e.execWaitReason || '',
        e.switchRequested ? 'Yes' : 'No', e.switchConfirmed ? 'Yes' : 'No',
        e.switchReason || '', e.switchCountToday ?? '', e.confirmCount ?? '', e.confirmRequired ?? '',
        e.barsSinceLastTrade ?? '',
        // Candidates: strategyType|signal|score|eligible|eligibilityReason for each
        (e.candidates || []).map(c =>
          `${c.strategyType}:${c.signal}:${Number(c.score).toFixed(1)}:${c.eligible ? 'ok' : 'blocked'}${c.eligibilityReason ? '(' + c.eligibilityReason + ')' : ''}`
        ).join(' | '),
        e.positionState || '', e.desiredSide || '', e.action || '', e.exitReason || '',
        e.entryRegime || '', e.appliedMinHold ?? '', e.holdActive ? 'Yes' : 'No',
        n2(e.peakPnlPct), n2(e.profitLockFloor),
        e.inHoldZone ? 'Yes' : 'No', e.inStrongTrendMode ? 'Yes' : 'No',
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

    lastRunPcRef.current = { ...penaltyConfig };
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
      userId:      session.userId,
      brokerName:  session.brokerName,
      apiKey:      session.apiKey      || undefined,
      accessToken: session.accessToken || undefined,
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
        chopFilter:              decisionCfg.chopFilter,
        chopLookback:            parseInt(decisionCfg.chopLookback, 10)           || 8,
        penaltyMinScore:         parseFloat(decisionCfg.penaltyMinScore)          || parseFloat(decisionCfg.minScore) || 0,
        scoreFloorTrigger:          parseFloat(decisionCfg.scoreFloorTrigger)          || 35,
        scoreFloorMin:              parseFloat(decisionCfg.scoreFloorMin)              || 25,
        bollingerBonusThreshold:    parseFloat(decisionCfg.bollingerBonusThreshold)    || 35,
        bollingerBonus:             parseFloat(decisionCfg.bollingerBonus)             || 0,
        earlyEntryRisingBars:       parseInt(decisionCfg.earlyEntryRisingBars, 10)     || 0,
        rawScoreBypassThreshold:    parseFloat(decisionCfg.rawScoreBypassThreshold)    || 0,
        rawScoreBypassGap:          parseFloat(decisionCfg.rawScoreBypassGap)          || 3,
        bollingerEarlyEntryMinScore:parseFloat(decisionCfg.bollingerEarlyEntryMinScore)|| 0,
      },
      selectionConfig: {
        minPremium:        parseFloat(selectionCfg.minPremium) || 50,
        maxPremium:        parseFloat(selectionCfg.maxPremium) || 300,
        strictPremiumBand: selectionCfg.strictPremiumBand ?? true,
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
        compressionNoTrade:    tradingRules.compressionNoTrade,
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
        minRangeWidthPct:              parseFloat(rangeQuality.minRangeWidthPct)             || 0.3,
        maxRangeWidthPct:              parseFloat(rangeQuality.maxRangeWidthPct)             || 3.0,
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
        weakRangingMinScore:    parseFloat(tradeQuality.weakRangingMinScore)      || 28,
        weakRangingMinGap:      parseFloat(tradeQuality.weakRangingMinGap)        || 3,
        rangingConfirmCandles:  parseInt(tradeQuality.rangingConfirmCandles, 10)  || 2,
        trendingConfirmCandles: parseInt(tradeQuality.trendingConfirmCandles, 10) || 1,
      } : { enabled: false },
      trendEntryConfig: trendEntry.enabled ? {
        enabled:                      true,
        breakoutLookback:             parseInt(trendEntry.breakoutLookback, 10)              || 5,
        minBodyPct:                   parseFloat(trendEntry.minBodyPct)                      || 45,
        weakBodyPct:                  parseFloat(trendEntry.weakBodyPct)                     || 20,
        ema9Period:                   parseInt(trendEntry.ema9Period, 10)                    || 9,
        scoreBypassWeakBody:          trendEntry.scoreBypassWeakBody,
        scoreBypassWeakBodyThreshold: parseFloat(trendEntry.scoreBypassWeakBodyThreshold)   || 25,
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
      exitConfig: {
        enabled:                      exitConfig.enabled,
        hardStopPct:                  parseFloat(exitConfig.hardStopPct)                  || 7,
        holdZonePct:                  parseFloat(exitConfig.holdZonePct)                  || 5,
        lock1TriggerPct:              parseFloat(exitConfig.lock1TriggerPct)              || 5,
        lock1FloorPct:                parseFloat(exitConfig.lock1FloorPct)                || 2,
        lock2TriggerPct:              parseFloat(exitConfig.lock2TriggerPct)              || 10,
        lock2FloorPct:                parseFloat(exitConfig.lock2FloorPct)                || 5,
        trailTriggerPct:              parseFloat(exitConfig.trailTriggerPct)              || 15,
        trailFactor:                  parseFloat(exitConfig.trailFactor)                  || 0.4,
        firstMoveBars:                parseInt(exitConfig.firstMoveBars, 10)              || 0,
        firstMoveLockPct:             parseFloat(exitConfig.firstMoveLockPct)             || 0.5,
        structureLookback:            parseInt(exitConfig.structureLookback, 10)          || 5,
        scoreDropFactor:              parseFloat(exitConfig.scoreDropFactor)              || 0,
        scoreAbsoluteMin:             parseFloat(exitConfig.scoreAbsoluteMin)             || 0,
        biasExitEnabled:              exitConfig.biasExitEnabled,
        strongExitScore:              parseFloat(exitConfig.strongExitScore)              || 40,
        trendStrongModeThresholdPct:  parseFloat(exitConfig.trendStrongModeThresholdPct) || 5,
        maxBarsNoImprovement:         parseInt(exitConfig.maxBarsNoImprovement, 10)       || 3,
        stagnationBars:               parseInt(exitConfig.stagnationBars, 10)             || 2,
        maxBarsRanging:               parseInt(exitConfig.maxBarsRanging, 10)             || 6,
        maxBarsDeadTrade:             parseInt(exitConfig.maxBarsDeadTrade, 10)           || 10,
        deadTradePnlPct:              parseFloat(exitConfig.deadTradePnlPct)              || 2,
        noHopeThresholdPct:           parseFloat(exitConfig.noHopeThresholdPct)           || 1.5,
        noHopeBars:                   parseInt(exitConfig.noHopeBars, 10)                 || 2,
        breakevenProtectionEnabled:   exitConfig.breakevenProtectionEnabled,
        breakevenTriggerPct:          parseFloat(exitConfig.breakevenTriggerPct)          || 2,
        breakevenOffsetPct:           parseFloat(exitConfig.breakevenOffsetPct)           || 0,
      },
      penaltyConfig: {
        enabled:                   penaltyConfig.enabled,
        reversalEnabled:           penaltyConfig.reversalEnabled,
        reversalMax:               parseFloat(penaltyConfig.reversalMax)               || 25,
        overextensionEnabled:      penaltyConfig.overextensionEnabled,
        overextensionMax:          parseFloat(penaltyConfig.overextensionMax)          || 30,
        sameColorEnabled:          penaltyConfig.sameColorEnabled,
        sameColorMax:              parseFloat(penaltyConfig.sameColorMax)              || 30,
        mismatchEnabled:           penaltyConfig.mismatchEnabled,
        mismatchScale:             parseFloat(penaltyConfig.mismatchScale)             || 1.0,
        volatileOptionEnabled:     penaltyConfig.volatileOptionEnabled,
        volatileOptionPenalty:     parseFloat(penaltyConfig.volatileOptionPenalty)     || 35,
        movePenaltyEnabled:        penaltyConfig.movePenaltyEnabled,
        movePenalty:               parseFloat(penaltyConfig.movePenalty)               || 3,
        vwapPenaltyEnabled:        penaltyConfig.vwapPenaltyEnabled,
        vwapPenalty:               parseFloat(penaltyConfig.vwapPenalty)               || 5,
        chopPenaltyEnabled:        penaltyConfig.chopPenaltyEnabled,
        chopPenalty:               parseFloat(penaltyConfig.chopPenalty)               || 2,
        rangeDriftingEnabled:      penaltyConfig.rangeDriftingEnabled,
        rangeDriftingPenalty:      parseFloat(penaltyConfig.rangeDriftingPenalty)      || 3,
        rangePoorStructureEnabled: penaltyConfig.rangePoorStructureEnabled,
        rangePoorStructurePenalty: parseFloat(penaltyConfig.rangePoorStructurePenalty) || 4,
        rangeChoppyEnabled:        penaltyConfig.rangeChoppyEnabled,
        rangeChoppyPenalty:        parseFloat(penaltyConfig.rangeChoppyPenalty)        || 2,
        rangeSizeEnabled:          penaltyConfig.rangeSizeEnabled,
        rangeSizePenalty:          parseFloat(penaltyConfig.rangeSizePenalty)          || 2,
      },
      minMovementFilterConfig: minMovementFilter.enabled ? {
        enabled:                     true,
        minMovementLookbackCandles:  parseInt(minMovementFilter.minMovementLookbackCandles,  10) || 3,
        minMovementThresholdPercent: parseFloat(minMovementFilter.minMovementThresholdPercent) || 1.0,
      } : { enabled: false },
      directionalConsistencyFilterConfig: directionalConsistencyFilter.enabled ? {
        enabled:                               true,
        directionalConsistencyLookbackCandles: parseInt(directionalConsistencyFilter.directionalConsistencyLookbackCandles, 10) || 3,
        minSameDirectionCandles:               parseInt(directionalConsistencyFilter.minSameDirectionCandles,               10) || 2,
      } : { enabled: false },
      candleStrengthFilterConfig: candleStrengthFilter.enabled ? {
        enabled:                      true,
        candleStrengthLookbackCandles: parseInt(candleStrengthFilter.candleStrengthLookbackCandles, 10) || 3,
        minAverageBodyRatio:           parseFloat(candleStrengthFilter.minAverageBodyRatio)           || 0.50,
        minStrongCandlesRequired:      parseInt(candleStrengthFilter.minStrongCandlesRequired,   10)  || 2,
      } : { enabled: false },
      stopLossCascadeProtectionConfig: cascadeProtection.enabled ? {
        enabled:               true,
        cascadeStopLossCount:  parseInt(cascadeProtection.cascadeStopLossCount,  10) || 2,
        cascadeWindowMinutes:  parseInt(cascadeProtection.cascadeWindowMinutes,  10) || 30,
        cascadePauseMinutes:   parseInt(cascadeProtection.cascadePauseMinutes,   10) || 30,
        cascadeExitReasons:    ['HARD_STOP_LOSS'],
        cascadeApplyPerSymbol: cascadeProtection.cascadeApplyPerSymbol,
        cascadeApplyPerSide:   cascadeProtection.cascadeApplyPerSide,
      } : { enabled: false },
      realTrendConfig: realTrendConfig.enabled ? {
        enabled:            true,
        maxOverlapRatio:    parseFloat(realTrendConfig.maxOverlapRatio)    || 0.6,
        minAvgBodyRatio:    parseFloat(realTrendConfig.minAvgBodyRatio)    || 0.5,
        minStrongBodyRatio: parseFloat(realTrendConfig.minStrongBodyRatio) || 0.6,
        minStrongBodies:    parseInt(realTrendConfig.minStrongBodies,  10) || 2,
        minRangeExpansion:  parseFloat(realTrendConfig.minRangeExpansion)  || 1.2,
        minPersistBars:     parseInt(realTrendConfig.minPersistBars,   10) || 2,
      } : { enabled: false },
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
                  ['Exec', lastEvt.execWaitReason || '—', lastEvt.execWaitReason ? '#f59e0b' : undefined],
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
                    tradingRules.compressionNoTrade   && 'No COMPRESSION',
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
                  text += ` | TQ: S>=${tradeQuality.strongScoreThreshold} N>=${tradeQuality.normalScoreThreshold} wkCooldown=${tradeQuality.weakTradeLossCooldown} blockWkRng=${tradeQuality.blockWeakInRanging} wkRngMin=${tradeQuality.weakRangingMinScore}/gap${tradeQuality.weakRangingMinGap} rngConf=${tradeQuality.rangingConfirmCandles} trdConf=${tradeQuality.trendingConfirmCandles}`;
                }
                if (trendEntry.enabled) {
                  text += ` | TrendEntry: brkLbk=${trendEntry.breakoutLookback} body>=${trendEntry.minBodyPct}% weak<${trendEntry.weakBodyPct}% EMA${trendEntry.ema9Period}`;
                }
                if (compressionEntry.enabled) {
                  text += ` | CmpEntry: lbk=${compressionEntry.rangeLookback} long<=${compressionEntry.longZoneMax} short>=${compressionEntry.shortZoneMin} noTrade=[${compressionEntry.noTradeZoneMin}-${compressionEntry.noTradeZoneMax}]`;
                }
                text += '\n\n';

                // ── Feed header ──
                const headers = ['Time','NIFTY','Regime','Bias','ConfBias','Winner','Score','PenScore','Str','2nd','Gap','Shadow','NeutralReason','State','Bars','Hold','Action','ExitRsn','PeakPnL%','LockFloor%','Zone','TrendMode','Option','OptPx','uPnL','rPnL','Block'];
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
                    evt.positionState !== 'FLAT' && evt.peakPnlPct != null ? Number(evt.peakPnlPct).toFixed(2) : '',
                    evt.positionState !== 'FLAT' && evt.profitLockFloor != null && evt.profitLockFloor > -1e10 ? Number(evt.profitLockFloor).toFixed(2) : '',
                    evt.inHoldZone ? 'ZONE' : '',
                    evt.inStrongTrendMode ? 'STRONG_TREND' : '',
                    evt.selectedTradingSymbol || '',
                    evt.optionClose != null ? Number(evt.optionClose).toFixed(2) : '',
                    evt.unrealizedPnl != null ? Number(evt.unrealizedPnl).toFixed(2) : '',
                    evt.realizedPnl  != null ? Number(evt.realizedPnl).toFixed(2)  : '',
                    evt.blockReason || (evt.execWaitReason ? '⚠ ' + evt.execWaitReason : ''),
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
                  tradingRules.compressionNoTrade   && 'No COMPRESSION',
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
              {exitConfig.enabled && (
                <>
                  <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                  <span style={{ marginRight: 8, fontWeight: 700, color: '#f97316' }}>Exit:</span>
                  <span style={{ marginRight: 10 }}>SL=<b style={{ color: '#ef4444' }}>{exitConfig.hardStopPct}%</b></span>
                  <span style={{ marginRight: 10 }}>zone=<b style={{ color: '#f59e0b' }}>{exitConfig.holdZonePct}%</b></span>
                  <span style={{ marginRight: 10 }}>lock1=<b style={{ color: '#22c55e' }}>{exitConfig.lock1TriggerPct}%→{exitConfig.lock1FloorPct}%</b></span>
                  <span style={{ marginRight: 10 }}>trail=<b style={{ color: '#22c55e' }}>{exitConfig.trailTriggerPct}%@{exitConfig.trailFactor}</b></span>
                  <span style={{ marginRight: 10 }}>dead=<b style={{ color: 'var(--text-primary)' }}>{exitConfig.maxBarsDeadTrade}bars</b></span>
                </>
              )}
              {penaltyConfig.enabled && (
                <>
                  <span style={{ margin: '0 10px 0 4px', color: 'var(--text-muted)' }}>|</span>
                  <span style={{ marginRight: 8, fontWeight: 700, color: '#6366f1' }}>Pen:</span>
                  {penaltyConfig.reversalEnabled       && <span style={{ marginRight: 8 }}>rev≤<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.reversalMax}</b></span>}
                  {penaltyConfig.overextensionEnabled  && <span style={{ marginRight: 8 }}>ext≤<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.overextensionMax}</b></span>}
                  {penaltyConfig.sameColorEnabled      && <span style={{ marginRight: 8 }}>col≤<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.sameColorMax}</b></span>}
                  {penaltyConfig.mismatchEnabled       && <span style={{ marginRight: 8 }}>mis×<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.mismatchScale}</b></span>}
                  {penaltyConfig.volatileOptionEnabled && <span style={{ marginRight: 8 }}>vol=<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.volatileOptionPenalty}</b></span>}
                  {penaltyConfig.movePenaltyEnabled    && <span style={{ marginRight: 8 }}>mv=<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.movePenalty}</b></span>}
                  {penaltyConfig.vwapPenaltyEnabled    && <span style={{ marginRight: 8 }}>vw=<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.vwapPenalty}</b></span>}
                  {penaltyConfig.chopPenaltyEnabled    && <span style={{ marginRight: 8 }}>chp=<b style={{ color: 'var(--text-primary)' }}>{penaltyConfig.chopPenalty}</b></span>}
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
                        <th title="Consecutive candles seen for pending bias">Cnf</th><th title="Candles required to confirm">Req</th>
                        <th>State</th><th>Bars</th><th>Hold</th><th>Action</th><th>ExitRsn</th>
                        <th>PeakPnL%</th><th>LockFloor%</th><th>Zone</th><th>TrendMode</th>
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
                          <td style={{ fontSize: 11, fontWeight: 600, color: evt.confirmCount > 0 && evt.confirmCount < evt.confirmRequired ? '#f59e0b' : evt.confirmCount >= evt.confirmRequired && evt.confirmRequired > 0 ? '#22c55e' : undefined }}>{evt.confirmCount != null && evt.confirmCount > 0 ? evt.confirmCount : ''}</td>
                          <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{evt.confirmRequired != null && evt.confirmRequired > 0 ? evt.confirmRequired : ''}</td>
                          <td style={{ fontWeight: 600 }}>{evt.positionState || '—'}</td>
                          <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{evt.positionState !== 'FLAT' ? (evt.barsInTrade ?? '—') : ''}</td>
                          <td style={{ fontSize: 11, fontWeight: 600, color: '#14b8a6' }}>{evt.holdActive ? `🔒${evt.barsInTrade}/${evt.appliedMinHold}` : ''}</td>
                          <td style={{ color: evt.action === 'ENTERED' ? '#22c55e' : evt.action === 'EXITED' || evt.action === 'FORCE_CLOSED' ? '#f97316' : undefined }}>{evt.action || '—'}</td>
                          <td style={{ fontSize: 10, color: '#f97316' }}>{evt.exitReason || ''}</td>
                          <td style={{ fontSize: 11, color: evt.peakPnlPct > 0 ? '#22c55e' : undefined }}>{evt.positionState !== 'FLAT' && evt.peakPnlPct != null ? fmt2(evt.peakPnlPct) : ''}</td>
                          <td style={{ fontSize: 11, color: '#14b8a6' }}>{evt.positionState !== 'FLAT' && evt.profitLockFloor != null && evt.profitLockFloor > -1e10 ? fmt2(evt.profitLockFloor) : ''}</td>
                          <td style={{ fontSize: 10, fontWeight: 600, color: '#f59e0b' }}>{evt.inHoldZone ? 'ZONE' : ''}</td>
                          <td style={{ fontSize: 10, fontWeight: 600, color: '#22c55e' }}>{evt.inStrongTrendMode ? '⚡TREND' : ''}</td>
                          <td className="de-mono">{evt.selectedTradingSymbol || '—'}</td>
                          <td>{fmt2(evt.optionClose)}</td>
                          <td style={pnlStyle(evt.unrealizedPnl)}>{fmt2(evt.unrealizedPnl)}</td>
                          <td style={pnlStyle(evt.realizedPnl)}>{fmt2(evt.realizedPnl)}</td>
                          <td style={{ color: evt.blockReason ? '#ef4444' : evt.execWaitReason ? '#f59e0b' : undefined, fontSize: 10 }}>
                            {evt.blockReason || (evt.execWaitReason ? '⚠ ' + evt.execWaitReason : '')}
                          </td>
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
            setTradeQuality(DEFAULT_TRADE_QUALITY); setTrendEntry(DEFAULT_TREND_ENTRY); setCompressionEntry(DEFAULT_COMPRESSION_ENTRY); setHoldConfig(DEFAULT_HOLD); setExitConfig(DEFAULT_EXIT_CONFIG);
            setPenaltyConfig(DEFAULT_PENALTY_CONFIG);
            setInterval('MINUTE_5'); setFromDate(''); setToDate(''); setWarmupDays('5'); setSpeed('1'); setQuantity('0'); setCapital('100000');
            ['sma_opts_nifty','sma_opts_ce_pool','sma_opts_pe_pool','sma_opts_interval','sma_opts_from','sma_opts_to',
             'sma_opts_warmup','sma_opts_speed','sma_opts_qty','sma_opts_capital','sma_opts_strategies',
             'sma_opts_decision','sma_opts_selection','sma_opts_switch','sma_opts_regime_cfg',
             'sma_opts_chop_rules','sma_opts_trading_rules','sma_opts_regime_rules',
             'sma_opts_regime_strat_rules','sma_opts_risk','sma_opts_range_quality','sma_opts_trade_quality',
             'sma_opts_trend_entry','sma_opts_compression_entry','sma_opts_hold_config','sma_opts_exit_config',
             'sma_opts_penalty_config','sma_opts_min_movement_filter','sma_opts_directional_consistency_filter',
             'sma_opts_candle_strength_filter'].forEach(k => localStorage.removeItem(k));
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

        {/* ── Presets ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: presets.length > 0 || showPresetSave ? 12 : 0, flexWrap: 'wrap' }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Config Presets</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              {presets.length > 0 && (
                <button type="button" className="btn-secondary btn-xs" onClick={downloadAllPresets} title="Export all presets as JSON">
                  Export All
                </button>
              )}
              <label className="btn-secondary btn-xs" style={{ cursor: 'pointer', marginBottom: 0 }} title="Import presets from JSON file">
                Import
                <input type="file" accept=".json" style={{ display: 'none' }} onChange={uploadPresets} />
              </label>
              <button type="button" className="btn-secondary btn-xs"
                onClick={() => setShowPresetSave(s => !s)} disabled={isRunning}>
                {showPresetSave ? 'Cancel' : '+ Save Current'}
              </button>
            </div>
          </div>

          {showPresetSave && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 14, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
              <div className="form-group" style={{ flex: '1 1 160px', marginBottom: 0 }}>
                <label style={{ fontSize: 11 }}>Preset Name *</label>
                <input
                  type="text"
                  value={presetName}
                  onChange={e => setPresetName(e.target.value)}
                  placeholder="e.g. Conservative RANGING"
                  maxLength={60}
                  style={{ fontSize: 12 }}
                />
              </div>
              <div className="form-group" style={{ flex: '2 1 240px', marginBottom: 0 }}>
                <label style={{ fontSize: 11 }}>Description (optional)</label>
                <input
                  type="text"
                  value={presetDescription}
                  onChange={e => setPresetDescription(e.target.value)}
                  placeholder="e.g. High score threshold, no RANGING trades"
                  maxLength={160}
                  style={{ fontSize: 12 }}
                />
              </div>
              <button type="button" className="btn-primary btn-xs" style={{ flexShrink: 0, marginBottom: 1 }}
                onClick={savePreset} disabled={!presetName.trim()}>
                Save
              </button>
            </div>
          )}

          {presets.length === 0 && !showPresetSave && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
              No presets saved yet. Click <b>+ Save Current</b> to save your active configuration as a preset.
            </p>
          )}

          {presets.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {presets.map(preset => (
                <div key={preset.id} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  padding: '8px 10px',
                  background: selectedPresetId === preset.id ? 'rgba(99,102,241,0.12)' : 'var(--bg-secondary)',
                  borderRadius: 6,
                  border: selectedPresetId === preset.id ? '1px solid #6366f1' : '1px solid var(--border)',
                  maxWidth: 320, minWidth: 180,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, color: selectedPresetId === preset.id ? '#818cf8' : 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {selectedPresetId === preset.id && <span style={{ marginRight: 4 }}>●</span>}{preset.name}
                    </div>
                    {preset.description && (
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {preset.description}
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                      {new Date(preset.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                    <button type="button" className="btn-primary btn-xs"
                      onClick={() => applyPreset(preset)} disabled={isRunning}
                      title="Apply this preset to current config">
                      Apply
                    </button>
                    <button type="button" className="btn-secondary btn-xs"
                      onClick={() => downloadPreset(preset)}
                      title="Download this preset as JSON"
                      style={{ fontSize: 10 }}>
                      Export
                    </button>
                    <button type="button" className="btn-secondary btn-xs"
                      onClick={() => deletePreset(preset.id)}
                      title="Delete preset"
                      style={{ fontSize: 10 }}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
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
              ['minScore',                'Min Score',               'Minimum winning strategy score to select a winner (0–100)'],
              ['minScoreGap',             'Min Score Gap',           'Gap between top-2 strategies required'],
              ['penaltyMinScore',         'Penalty Min Score',       'Floor after penalties. Trade allowed if max(raw,penalized) ≥ this. Penalties: move=-3, vwap=-5, chop=-2(off in RANGING), drift=-3, too_wide=-2. Cap=40% of raw.'],
              ['maxRecentMove3',          'Max 3-bar Move %',        'Penalty -5 if NIFTY moved > X% in last 3 bars'],
              ['maxRecentMove5',          'Max 5-bar Move %',        'Penalty -5 if NIFTY moved > X% in last 5 bars'],
              ['maxAbsVwapDist',          'Max VWAP Dist %',         'Penalty -5 if NIFTY is > X% away from intraday VWAP'],
              ['minBarsSinceTrade',       'Min Bars Since Trade',    'Cooldown after last trade (bars)'],
              ['chopLookback',            'Chop Lookback',           'Bars used for chop detection (penalty -4 if choppy)'],
              ['scoreFloorTrigger',       'Score Floor Trigger',     'If raw score ≥ this, penalties cannot reduce below Score Floor Min'],
              ['scoreFloorMin',           'Score Floor Min',         'Minimum penalized score when floor trigger is met. 0 = disabled'],
              ['bollingerBonusThreshold',    'BOLLINGER Bonus Trigger',    'BOLLINGER_REVERSION: add bonus if raw score ≥ this'],
              ['bollingerBonus',             'BOLLINGER Bonus Pts',         'Points added to penalized score for BOLLINGER bonus. 0 = disabled'],
              ['earlyEntryRisingBars',       'Early Entry Rising Bars',     'Allow entry if score has risen for N consecutive candles, even below penaltyMinScore. 0 = disabled'],
              ['rawScoreBypassThreshold',    'Raw Score Bypass Threshold',  'Allow entry if raw score ≥ this AND gap ≥ Raw Score Bypass Gap, ignoring penalized score. 0 = disabled'],
              ['rawScoreBypassGap',          'Raw Score Bypass Gap',        'Min score gap required for raw score bypass'],
              ['bollingerEarlyEntryMinScore','BOLLINGER Early Entry Score',  'BOLLINGER_REVERSION: if score ≥ this, override confirmRequired to 1 (1-candle early reversal). 0 = disabled'],
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
          <div style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={selectionCfg.strictPremiumBand ?? true} onChange={e => setSelectionCfg(p => ({ ...p, strictPremiumBand: e.target.checked }))} disabled={isRunning} />
              Strict Premium Band (skip entry if no candidate in range)
            </label>
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
                ['compressionNoTrade',   'No trade in COMPRESSION regime'],
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
                  ['RANGING Weak Min Score',  'weakRangingMinScore',   '0.5', null],
                  ['RANGING Weak Min Gap',    'weakRangingMinGap',     '0.5', null],
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
              <div className="form-group">
                <label>Score Bypass Weak Body</label>
                <button type="button" className={`btn-sm ${trendEntry.scoreBypassWeakBody ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => updateTrendEntry('scoreBypassWeakBody', !trendEntry.scoreBypassWeakBody)} disabled={isRunning}>
                  {trendEntry.scoreBypassWeakBody ? 'ON' : 'OFF'}
                </button>
              </div>
              <div className="form-group">
                <label>Bypass Score Threshold</label>
                <input type="number" min="0" step="1" value={trendEntry.scoreBypassWeakBodyThreshold} disabled={isRunning}
                  onChange={e => updateTrendEntry('scoreBypassWeakBodyThreshold', e.target.value)} />
              </div>
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

        {/* ── Min Movement Filter ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Min Movement Filter</span>
            <button type="button"
              className={`btn-sm ${minMovementFilter.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateMinMovementFilter('enabled', !minMovementFilter.enabled)}
              disabled={isRunning}>
              {minMovementFilter.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 600 }}>pre-trade filter</span>
          </div>
          {minMovementFilter.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['Lookback Candles', 'minMovementLookbackCandles',  '1',   null],
                ['Min Movement %',   'minMovementThresholdPercent', '0.01', null],
              ].map(([label, key, step, max]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="0" max={max || undefined} step={step}
                    value={minMovementFilter[key]} disabled={isRunning}
                    onChange={e => updateMinMovementFilter(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Directional Consistency Filter ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Directional Consistency Filter</span>
            <button type="button"
              className={`btn-sm ${directionalConsistencyFilter.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateDirectionalConsistencyFilter('enabled', !directionalConsistencyFilter.enabled)}
              disabled={isRunning}>
              {directionalConsistencyFilter.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 600 }}>pre-trade filter</span>
          </div>
          {directionalConsistencyFilter.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['Lookback Candles',   'directionalConsistencyLookbackCandles', '1', null],
                ['Min Same Direction', 'minSameDirectionCandles',               '1', null],
              ].map(([label, key, step, max]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="1" max={max || undefined} step={step}
                    value={directionalConsistencyFilter[key]} disabled={isRunning}
                    onChange={e => updateDirectionalConsistencyFilter(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Candle Strength Filter ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Candle Strength Filter</span>
            <button type="button"
              className={`btn-sm ${candleStrengthFilter.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateCandleStrengthFilter('enabled', !candleStrengthFilter.enabled)}
              disabled={isRunning}>
              {candleStrengthFilter.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#6366f1', fontWeight: 600 }}>pre-trade filter</span>
          </div>
          {candleStrengthFilter.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['Lookback Candles',   'candleStrengthLookbackCandles', '1',    null],
                ['Min Avg Body Ratio', 'minAverageBodyRatio',           '0.01', null],
                ['Min Strong Candles', 'minStrongCandlesRequired',      '1',    null],
              ].map(([label, key, step, max]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="0" max={max || undefined} step={step}
                    value={candleStrengthFilter[key]} disabled={isRunning}
                    onChange={e => updateCandleStrengthFilter(key, e.target.value)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── SL Cascade Protection ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>SL Cascade Protection</span>
            <button type="button" className={`btn-sm ${cascadeProtection.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateCascadeProtection('enabled', !cascadeProtection.enabled)} disabled={isRunning}>
              {cascadeProtection.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 600 }}>risk control</span>
          </div>
          {cascadeProtection.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['SL Count',     'cascadeStopLossCount', '1'],
                ['Window (min)', 'cascadeWindowMinutes',  '1'],
                ['Pause (min)',  'cascadePauseMinutes',   '1'],
              ].map(([label, key, step]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="1" step={step} value={cascadeProtection[key]} disabled={isRunning}
                    onChange={e => updateCascadeProtection(key, e.target.value)} />
                </div>
              ))}
              <div className="form-group"><label>Per Symbol</label>
                <button type="button" className={`btn-sm ${cascadeProtection.cascadeApplyPerSymbol ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => updateCascadeProtection('cascadeApplyPerSymbol', !cascadeProtection.cascadeApplyPerSymbol)} disabled={isRunning}>
                  {cascadeProtection.cascadeApplyPerSymbol ? 'ON' : 'OFF'}</button>
              </div>
              <div className="form-group"><label>Per Side</label>
                <button type="button" className={`btn-sm ${cascadeProtection.cascadeApplyPerSide ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => updateCascadeProtection('cascadeApplyPerSide', !cascadeProtection.cascadeApplyPerSide)} disabled={isRunning}>
                  {cascadeProtection.cascadeApplyPerSide ? 'ON' : 'OFF'}</button>
              </div>
            </div>
          )}
        </div>

        {/* ── Real Trend Validation ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Real Trend Validation</span>
            <button type="button" className={`btn-sm ${realTrendConfig.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setRealTrendConfig(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>
              {realTrendConfig.enabled ? 'ON' : 'OFF'}
            </button>
            <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600 }}>fake trend filter</span>
          </div>
          {realTrendConfig.enabled && (
            <div className="bt-form-grid" style={{ marginTop: 4 }}>
              {[
                ['Max Overlap Ratio', 'maxOverlapRatio',    '0.01'],
                ['Min Avg Body',      'minAvgBodyRatio',     '0.01'],
                ['Min Body Ratio',    'minStrongBodyRatio',  '0.01'],
                ['Strong Bodies',     'minStrongBodies',     '1'],
                ['Range Expansion',   'minRangeExpansion',   '0.01'],
                ['Persist Bars',      'minPersistBars',      '1'],
              ].map(([label, key, step]) => (
                <div className="form-group" key={key}>
                  <label>{label}</label>
                  <input type="number" min="0" step={step}
                    value={realTrendConfig[key]} disabled={isRunning}
                    onChange={e => setRealTrendConfig(p => ({ ...p, [key]: e.target.value }))} />
                </div>
              ))}
            </div>
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

        {/* ── Exit System ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Smart Exit System</span>
            <button type="button"
              className={`btn-sm ${exitConfig.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updateExitConfig('enabled', !exitConfig.enabled)}
              disabled={isRunning}>
              {exitConfig.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          <p className="bt-section-sub" style={{ marginBottom: exitConfig.enabled ? 12 : 0 }}>
            {exitConfig.enabled
              ? `SL=${exitConfig.hardStopPct}% · HoldZone<${exitConfig.holdZonePct}% · Lock1=${exitConfig.lock1TriggerPct}%→${exitConfig.lock1FloorPct}% · Lock2=${exitConfig.lock2TriggerPct}%→${exitConfig.lock2FloorPct}% · Trail≥${exitConfig.trailTriggerPct}%@${exitConfig.trailFactor} · StrongTrend≥${exitConfig.trendStrongModeThresholdPct}% · DeadTrade>${exitConfig.maxBarsDeadTrade}bars<${exitConfig.deadTradePnlPct}%`
              : 'Hold Zone → only SL until +5% profit; Strong Trend Mode holds through pullbacks; Dead Trade kill after 10 bars.'}
          </p>
          {exitConfig.enabled && (
            <>
              {/* P1 Hard Stop */}
              <div style={{ fontSize: 11, fontWeight: 700, color: '#ef4444', marginBottom: 6, marginTop: 4 }}>P1 — Hard Stop Loss (always fires)</div>
              <div className="bt-form-grid" style={{ marginBottom: 12 }}>
                <div className="form-group">
                  <label>Hard Stop %</label>
                  <input type="number" min="0" step="0.5"
                    value={exitConfig.hardStopPct} disabled={isRunning}
                    onChange={e => updateExitConfig('hardStopPct', e.target.value)} />
                </div>
              </div>

              {/* Hold Zone */}
              <div style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', marginBottom: 6 }}>Hold Zone — no exit below this profit (except SL + dead trade)</div>
              <div className="bt-form-grid" style={{ marginBottom: 12 }}>
                <div className="form-group">
                  <label>Hold Zone % (profit threshold)</label>
                  <input type="number" min="0" step="0.5"
                    value={exitConfig.holdZonePct} disabled={isRunning}
                    onChange={e => updateExitConfig('holdZonePct', e.target.value)} />
                </div>
              </div>

              {/* P2 Profit Lock */}
              <div style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', marginBottom: 6 }}>P2 — Profit Lock / Trailing (only arms after hold zone cleared)</div>
              <div className="bt-form-grid" style={{ marginBottom: 12 }}>
                {[
                  { key: 'lock1TriggerPct', label: 'Lock1 Trigger %',  step: '0.5' },
                  { key: 'lock1FloorPct',   label: 'Lock1 Floor %',    step: '0.5' },
                  { key: 'lock2TriggerPct', label: 'Lock2 Trigger %',  step: '0.5' },
                  { key: 'lock2FloorPct',   label: 'Lock2 Floor %',    step: '0.5' },
                  { key: 'trailTriggerPct', label: 'Trail Trigger %',  step: '0.5' },
                  { key: 'trailFactor',     label: 'Trail Factor',     step: '0.05' },
                ].map(({ key, label, step }) => (
                  <div key={key} className="form-group">
                    <label>{label}</label>
                    <input type="number" min="0" step={step}
                      value={exitConfig[key]} disabled={isRunning}
                      onChange={e => updateExitConfig(key, e.target.value)} />
                  </div>
                ))}
              </div>

              {/* P4 Structure */}
              <div style={{ fontSize: 11, fontWeight: 700, color: '#0ea5e9', marginBottom: 6 }}>P4 — Structure Failure (NIFTY high/low, skipped in RANGING)</div>
              <div className="bt-form-grid" style={{ marginBottom: 12 }}>
                <div className="form-group">
                  <label>Structure Lookback</label>
                  <input type="number" min="2" step="1"
                    value={exitConfig.structureLookback} disabled={isRunning}
                    onChange={e => updateExitConfig('structureLookback', e.target.value)} />
                </div>
              </div>

              {/* P5 Bias Reversal (score exits removed) */}
              <div style={{ fontSize: 11, fontWeight: 700, color: '#8b5cf6', marginBottom: 4 }}>P5c — Bias Reversal</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                Score-based exits (P5a/P5b) are permanently disabled — score must not trigger exit.
                RANGING: exit on any confirmed bias flip. TRENDING: requires score ≥ Strong Exit Score.
              </div>
              <div className="bt-form-grid" style={{ marginBottom: 8 }}>
                {[
                  { key: 'strongExitScore',            label: 'Strong Exit Score (TRENDING + Strong Trend Mode)', step: '1' },
                  { key: 'trendStrongModeThresholdPct',label: 'Strong Trend Mode Threshold % (peak > this)',      step: '1' },
                ].map(({ key, label, step }) => (
                  <div key={key} className="form-group">
                    <label>{label}</label>
                    <input type="number" min="0" step={step}
                      value={exitConfig[key]} disabled={isRunning}
                      onChange={e => updateExitConfig(key, e.target.value)} />
                  </div>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 12, cursor: isRunning ? 'default' : 'pointer' }}>
                <input type="checkbox" checked={exitConfig.biasExitEnabled} disabled={isRunning}
                  onChange={e => updateExitConfig('biasExitEnabled', e.target.checked)} />
                Bias reversal exit — RANGING: any confirmed flip · TRENDING: score ≥ strong exit score
              </label>

              {/* P6 Time + Dead Trade */}
              <div style={{ fontSize: 11, fontWeight: 700, color: '#06b6d4', marginBottom: 6 }}>P6 — Time Exits · Dead Trade Kill (safety)</div>
              <div className="bt-form-grid" style={{ marginBottom: 12 }}>
                {[
                  { key: 'maxBarsNoImprovement', label: 'Max Bars No Improvement (non-TRENDING)', step: '1' },
                  { key: 'stagnationBars',       label: 'Stagnation Bars (non-TRENDING)',        step: '1' },
                  { key: 'maxBarsRanging',       label: 'Max Bars RANGING',                      step: '1' },
                  { key: 'maxBarsDeadTrade',     label: 'Dead Trade Max Bars',                   step: '1' },
                  { key: 'deadTradePnlPct',      label: 'Dead Trade PnL % (below = exit)',       step: '0.5' },
                ].map(({ key, label, step }) => (
                  <div key={key} className="form-group">
                    <label>{label}</label>
                    <input type="number" min="0" step={step}
                      value={exitConfig[key]} disabled={isRunning}
                      onChange={e => updateExitConfig(key, e.target.value)} />
                  </div>
                ))}
              </div>

              {/* P7 No-Hope */}
              <div style={{ fontSize: 11, fontWeight: 700, color: '#ec4899', marginBottom: 6 }}>P7 — No-Hope (sustained loss, non-TRENDING)</div>
              <div className="bt-form-grid">
                {[
                  { key: 'noHopeThresholdPct', label: 'No-Hope Threshold %', step: '0.5' },
                  { key: 'noHopeBars',         label: 'No-Hope Bars',        step: '1'   },
                ].map(({ key, label, step }) => (
                  <div key={key} className="form-group">
                    <label>{label}</label>
                    <input type="number" min="0" step={step}
                      value={exitConfig[key]} disabled={isRunning}
                      onChange={e => updateExitConfig(key, e.target.value)} />
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#10b981', marginBottom: 6, marginTop: 8 }}>Breakeven Protection</div>
              <div className="bt-form-grid">
                <div className="form-group">
                  <label>Enabled</label>
                  <button type="button" className={`btn-sm ${exitConfig.breakevenProtectionEnabled ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => updateExitConfig('breakevenProtectionEnabled', !exitConfig.breakevenProtectionEnabled)} disabled={isRunning}>
                    {exitConfig.breakevenProtectionEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>
                {[
                  { key: 'breakevenTriggerPct', label: 'Trigger %', step: '0.5' },
                  { key: 'breakevenOffsetPct',  label: 'Offset %',  step: '0.1' },
                ].map(({ key, label, step }) => (
                  <div key={key} className="form-group">
                    <label>{label}</label>
                    <input type="number" min="0" step={step}
                      value={exitConfig[key]} disabled={isRunning}
                      onChange={e => updateExitConfig(key, e.target.value)} />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── Penalty Config ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Penalty Config</span>
            <button type="button" className={`btn-sm ${penaltyConfig.enabled ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => updatePenaltyConfig('enabled', !penaltyConfig.enabled)} disabled={isRunning}>
              {penaltyConfig.enabled ? 'ON' : 'OFF'}
            </button>
          </div>
          {penaltyConfig.enabled && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6366f1', marginTop: 12, marginBottom: 6 }}>Signal Penalties</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[
                  { label: 'Reversal',        enabledKey: 'reversalEnabled',        valueKey: 'reversalMax',           valueLabel: 'Max',    step: '1'   },
                  { label: 'Overextension',   enabledKey: 'overextensionEnabled',   valueKey: 'overextensionMax',      valueLabel: 'Max',    step: '1'   },
                  { label: 'Same Color',      enabledKey: 'sameColorEnabled',       valueKey: 'sameColorMax',          valueLabel: 'Max',    step: '1'   },
                  { label: 'Mismatch',        enabledKey: 'mismatchEnabled',        valueKey: 'mismatchScale',         valueLabel: 'Scale',  step: '0.1' },
                  { label: 'Volatile Option', enabledKey: 'volatileOptionEnabled',  valueKey: 'volatileOptionPenalty', valueLabel: 'Penalty',step: '1'   },
                ].map(({ label, enabledKey, valueKey, valueLabel, step }) => (
                  <div key={enabledKey} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                    <button type="button" className={`btn-sm ${penaltyConfig[enabledKey] ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ minWidth: 36 }}
                      onClick={() => updatePenaltyConfig(enabledKey, !penaltyConfig[enabledKey])} disabled={isRunning}>
                      {penaltyConfig[enabledKey] ? 'ON' : 'OFF'}
                    </button>
                    <span style={{ fontSize: 12, width: 130, color: penaltyConfig[enabledKey] ? 'var(--text-primary)' : 'var(--text-muted)' }}>{label}</span>
                    <label style={{ fontSize: 11, margin: 0, minWidth: 36, color: 'var(--text-secondary)' }}>{valueLabel}</label>
                    <input type="number" min="0" step={step} value={penaltyConfig[valueKey]}
                      disabled={isRunning || !penaltyConfig[enabledKey]} style={{ width: 64 }}
                      onChange={e => updatePenaltyConfig(valueKey, e.target.value)} />
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6366f1', marginTop: 12, marginBottom: 6 }}>Entry Penalties</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[
                  { label: 'Move',               enabledKey: 'movePenaltyEnabled',           valueKey: 'movePenalty',               step: '0.5' },
                  { label: 'VWAP',               enabledKey: 'vwapPenaltyEnabled',           valueKey: 'vwapPenalty',               step: '0.5' },
                  { label: 'Chop',               enabledKey: 'chopPenaltyEnabled',           valueKey: 'chopPenalty',               step: '0.5' },
                  { label: 'Range: Drifting',    enabledKey: 'rangeDriftingEnabled',         valueKey: 'rangeDriftingPenalty',      step: '0.5' },
                  { label: 'Range: Poor Struct', enabledKey: 'rangePoorStructureEnabled',    valueKey: 'rangePoorStructurePenalty', step: '0.5' },
                  { label: 'Range: Choppy',      enabledKey: 'rangeChoppyEnabled',           valueKey: 'rangeChoppyPenalty',        step: '0.5' },
                  { label: 'Range: Size',        enabledKey: 'rangeSizeEnabled',             valueKey: 'rangeSizePenalty',          step: '0.5' },
                ].map(({ label, enabledKey, valueKey, step }) => (
                  <div key={enabledKey} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                    <button type="button" className={`btn-sm ${penaltyConfig[enabledKey] ? 'btn-primary' : 'btn-secondary'}`}
                      style={{ minWidth: 36 }}
                      onClick={() => updatePenaltyConfig(enabledKey, !penaltyConfig[enabledKey])} disabled={isRunning}>
                      {penaltyConfig[enabledKey] ? 'ON' : 'OFF'}
                    </button>
                    <span style={{ fontSize: 12, width: 130, color: penaltyConfig[enabledKey] ? 'var(--text-primary)' : 'var(--text-muted)' }}>{label}</span>
                    <label style={{ fontSize: 11, margin: 0, minWidth: 36, color: 'var(--text-secondary)' }}>Penalty</label>
                    <input type="number" min="0" step={step} value={penaltyConfig[valueKey]}
                      disabled={isRunning || !penaltyConfig[enabledKey]} style={{ width: 64 }}
                      onChange={e => updatePenaltyConfig(valueKey, e.target.value)} />
                  </div>
                ))}
              </div>
            </>
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


function TickReplayTest() {
  const ls = (key, def) => { try { const s = localStorage.getItem(key); if (!s) return def; const v = JSON.parse(s); return (Array.isArray(def) && !Array.isArray(v)) ? def : v; } catch { return def; } };
  const { session } = useSession();

  const [sessions,        setSessions]        = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError,   setSessionsError]   = useState('');
  const [sessionId,       setSessionId]       = useState(() => ls('sma_tick_session_id', ''));
  const userId = session.userId;
  const [brokerName,      setBrokerName]      = useState(() => ls('sma_tick_broker',     'kite'));
  const [warmupDays,      setWarmupDays]      = useState(() => ls('sma_tick_warmup_days','5'));
  const [niftyToken,    setNiftyToken]    = useState(() => ls('sma_tick_nifty_token',    ''));
  const [niftySymbol,   setNiftySymbol]   = useState(() => ls('sma_tick_nifty_symbol',   'NIFTY 50'));
  const [niftyExchange, setNiftyExchange] = useState(() => ls('sma_tick_nifty_exchange', 'NSE'));
  const [cePool, setCePool] = useState(() => ls('sma_tick_ce_pool', [EMPTY_OPTION_INST()]));
  const [pePool, setPePool] = useState(() => ls('sma_tick_pe_pool', [EMPTY_OPTION_INST()]));
  const [interval, setInterval] = useState(() => ls('sma_tick_interval', 'MINUTE_5'));
  const [fromDate, setFromDate] = useState(() => ls('sma_tick_from',     ''));
  const [toDate,   setToDate]   = useState(() => ls('sma_tick_to',       ''));
  const [speed,              setSpeed]              = useState(() => ls('sma_tick_speed',              '0'));
  const [saveForCompare,     setSaveForCompare]     = useState(() => ls('sma_tick_save_for_compare',   false));
  const [aiEnabled,          setAiEnabled]          = useState(() => ls('sma_tick_ai_enabled',          true));
  const [tradingHoursEnabled, setTradingHoursEnabled] = useState(() => ls('sma_tick_trading_hours_on',  true));
  const [closeoutMins,        setCloseoutMins]        = useState(() => ls('sma_tick_closeout_mins',     '15'));
  const [quantity, setQuantity] = useState(() => ls('sma_tick_qty',      '0'));
  const [capital,  setCapital]  = useState(() => ls('sma_tick_capital',  '100000'));
  const [strategies, setStrategies] = useState(() => ls('sma_tick_strategies', defaultStrategies()));
  const [decisionCfg,         setDecisionCfg]         = useState(() => ls('sma_tick_decision',            DEFAULT_DECISION));
  const [selectionCfg,        setSelectionCfg]        = useState(() => ls('sma_tick_selection',           DEFAULT_SELECTION));
  const [switchCfg,           setSwitchCfg]           = useState(() => ls('sma_tick_switch',              DEFAULT_SWITCH));
  const [optsRegimeCfg,       setOptsRegimeCfg]       = useState(() => ls('sma_tick_regime_cfg',          DEFAULT_OPTS_REGIME_CONFIG));
  const [chopRules,           setChopRules]           = useState(() => ls('sma_tick_chop_rules',          DEFAULT_CHOP_RULES));
  const [tradingRules,        setTradingRules]        = useState(() => ls('sma_tick_trading_rules',       DEFAULT_TRADING_RULES));
  const [regimeRules,         setRegimeRules]         = useState(() => ls('sma_tick_regime_rules',        DEFAULT_REGIME_RULES));
  const [regimeStrategyRules, setRegimeStrategyRules] = useState(() => ls('sma_tick_regime_strat_rules',  DEFAULT_REGIME_STRATEGY_RULES));
  const [optsRisk,            setOptsRisk]            = useState(() => ls('sma_tick_risk',                DEFAULT_OPTS_RISK));
  const [rangeQuality,        setRangeQuality]        = useState(() => ls('sma_tick_range_quality',       DEFAULT_RANGE_QUALITY));
  const [tradeQuality,        setTradeQuality]        = useState(() => ls('sma_tick_trade_quality',       DEFAULT_TRADE_QUALITY));
  const [trendEntry,          setTrendEntry]          = useState(() => ls('sma_tick_trend_entry',         DEFAULT_TREND_ENTRY));
  const [compressionEntry,    setCompressionEntry]    = useState(() => ls('sma_tick_compression_entry',   DEFAULT_COMPRESSION_ENTRY));
  const [holdConfig,          setHoldConfig]          = useState(() => ({ ...DEFAULT_HOLD,           ...ls('sma_tick_hold_config',    {}) }));
  const [exitConfig,          setExitConfig]          = useState(() => ({ ...DEFAULT_EXIT_CONFIG,    ...ls('sma_tick_exit_config',    {}) }));
  const [penaltyConfig,       setPenaltyConfig]       = useState(() => ({ ...DEFAULT_PENALTY_CONFIG, ...ls('sma_tick_penalty_config',  {}) }));
  const [minMovementFilter,              setMinMovementFilter]              = useState(() => ls('sma_tick_min_movement_filter',                      DEFAULT_MIN_MOVEMENT_FILTER));
  const [directionalConsistencyFilter,   setDirectionalConsistencyFilter]   = useState(() => ls('sma_tick_directional_consistency_filter',             DEFAULT_DIRECTIONAL_CONSISTENCY_FILTER));
  const [candleStrengthFilter,           setCandleStrengthFilter]           = useState(() => ls('sma_tick_candle_strength_filter',                   DEFAULT_CANDLE_STRENGTH_FILTER));
  const [noNewTradesAfterTime,           setNoNewTradesAfterTime]           = useState(() => ls('sma_tick_no_new_trades_after_time',                   DEFAULT_NO_NEW_TRADES_AFTER_TIME));
  const [cascadeProtection,              setCascadeProtection]              = useState(() => ls('sma_tick_cascade_protection',              DEFAULT_CASCADE_PROTECTION));
  const [realTrendConfig,                setRealTrendConfig]                = useState(() => ls('sma_tick_real_trend_config',                DEFAULT_REAL_TREND_CONFIG));

  function updateOptsRisk(key, val)                    { setOptsRisk(p                      => ({ ...p, [key]: val })); }
  function updateRangeQuality(key, val)                { setRangeQuality(p                  => ({ ...p, [key]: val })); }
  function updateHoldConfig(key, val)                  { setHoldConfig(p                    => ({ ...p, [key]: val })); }
  function updateExitConfig(key, val)                  { setExitConfig(p                    => ({ ...p, [key]: val })); }
  function updatePenaltyConfig(key, val)               { setPenaltyConfig(p                 => ({ ...p, [key]: val })); }
  function updateTradeQuality(key, val)                { setTradeQuality(p                  => ({ ...p, [key]: val })); }
  function updateTrendEntry(key, val)                  { setTrendEntry(p                    => ({ ...p, [key]: val })); }
  function updateCompressionEntry(key, val)            { setCompressionEntry(p              => ({ ...p, [key]: val })); }
  function updateMinMovementFilter(key, val)           { setMinMovementFilter(p             => ({ ...p, [key]: val })); }
  function updateDirectionalConsistencyFilter(key, val){ setDirectionalConsistencyFilter(p  => ({ ...p, [key]: val })); }
  function updateCandleStrengthFilter(key, val)        { setCandleStrengthFilter(p          => ({ ...p, [key]: val })); }
  function updateNoNewTradesAfterTime(key, val)        { setNoNewTradesAfterTime(p          => ({ ...p, [key]: val })); }
  function updateCascadeProtection(key, val)           { setCascadeProtection(p             => ({ ...p, [key]: val })); }

  useEffect(() => { try { localStorage.setItem('sma_tick_session_id',        JSON.stringify(sessionId));          } catch {} }, [sessionId]);

  useEffect(() => { try { localStorage.setItem('sma_tick_broker',            JSON.stringify(brokerName));         } catch {} }, [brokerName]);
  useEffect(() => { try { localStorage.setItem('sma_tick_warmup_days',       JSON.stringify(warmupDays));         } catch {} }, [warmupDays]);
  useEffect(() => { try { localStorage.setItem('sma_tick_nifty_token',       JSON.stringify(niftyToken));         } catch {} }, [niftyToken]);
  useEffect(() => { try { localStorage.setItem('sma_tick_nifty_symbol',      JSON.stringify(niftySymbol));        } catch {} }, [niftySymbol]);
  useEffect(() => { try { localStorage.setItem('sma_tick_nifty_exchange',    JSON.stringify(niftyExchange));      } catch {} }, [niftyExchange]);
  useEffect(() => { try { localStorage.setItem('sma_tick_ce_pool',           JSON.stringify(cePool));             } catch {} }, [cePool]);
  useEffect(() => { try { localStorage.setItem('sma_tick_pe_pool',           JSON.stringify(pePool));             } catch {} }, [pePool]);
  useEffect(() => { try { localStorage.setItem('sma_tick_interval',          JSON.stringify(interval));           } catch {} }, [interval]);
  useEffect(() => { try { localStorage.setItem('sma_tick_from',              JSON.stringify(fromDate));           } catch {} }, [fromDate]);
  useEffect(() => { try { localStorage.setItem('sma_tick_to',                JSON.stringify(toDate));             } catch {} }, [toDate]);
  useEffect(() => { try { localStorage.setItem('sma_tick_speed',             JSON.stringify(speed));                  } catch {} }, [speed]);
  useEffect(() => { try { localStorage.setItem('sma_tick_save_for_compare',  JSON.stringify(saveForCompare));         } catch {} }, [saveForCompare]);
  useEffect(() => { try { localStorage.setItem('sma_tick_ai_enabled',        JSON.stringify(aiEnabled));               } catch {} }, [aiEnabled]);
  useEffect(() => { try { localStorage.setItem('sma_tick_trading_hours_on',  JSON.stringify(tradingHoursEnabled));    } catch {} }, [tradingHoursEnabled]);
  useEffect(() => { try { localStorage.setItem('sma_tick_closeout_mins',     JSON.stringify(closeoutMins));           } catch {} }, [closeoutMins]);
  useEffect(() => { try { localStorage.setItem('sma_tick_qty',               JSON.stringify(quantity));           } catch {} }, [quantity]);
  useEffect(() => { try { localStorage.setItem('sma_tick_capital',           JSON.stringify(capital));            } catch {} }, [capital]);
  useEffect(() => { try { localStorage.setItem('sma_tick_strategies',        JSON.stringify(strategies));         } catch {} }, [strategies]);
  useEffect(() => { try { localStorage.setItem('sma_tick_decision',          JSON.stringify(decisionCfg));        } catch {} }, [decisionCfg]);
  useEffect(() => { try { localStorage.setItem('sma_tick_selection',         JSON.stringify(selectionCfg));       } catch {} }, [selectionCfg]);
  useEffect(() => { try { localStorage.setItem('sma_tick_switch',            JSON.stringify(switchCfg));          } catch {} }, [switchCfg]);
  useEffect(() => { try { localStorage.setItem('sma_tick_regime_cfg',        JSON.stringify(optsRegimeCfg));      } catch {} }, [optsRegimeCfg]);
  useEffect(() => { try { localStorage.setItem('sma_tick_chop_rules',        JSON.stringify(chopRules));          } catch {} }, [chopRules]);
  useEffect(() => { try { localStorage.setItem('sma_tick_trading_rules',     JSON.stringify(tradingRules));       } catch {} }, [tradingRules]);
  useEffect(() => { try { localStorage.setItem('sma_tick_regime_rules',      JSON.stringify(regimeRules));        } catch {} }, [regimeRules]);
  useEffect(() => { try { localStorage.setItem('sma_tick_regime_strat_rules',JSON.stringify(regimeStrategyRules));} catch {} }, [regimeStrategyRules]);
  useEffect(() => { try { localStorage.setItem('sma_tick_risk',              JSON.stringify(optsRisk));           } catch {} }, [optsRisk]);
  useEffect(() => { try { localStorage.setItem('sma_tick_range_quality',     JSON.stringify(rangeQuality));       } catch {} }, [rangeQuality]);
  useEffect(() => { try { localStorage.setItem('sma_tick_trade_quality',     JSON.stringify(tradeQuality));       } catch {} }, [tradeQuality]);
  useEffect(() => { try { localStorage.setItem('sma_tick_trend_entry',       JSON.stringify(trendEntry));         } catch {} }, [trendEntry]);
  useEffect(() => { try { localStorage.setItem('sma_tick_compression_entry', JSON.stringify(compressionEntry));   } catch {} }, [compressionEntry]);
  useEffect(() => { try { localStorage.setItem('sma_tick_hold_config',       JSON.stringify(holdConfig));         } catch {} }, [holdConfig]);
  useEffect(() => { try { localStorage.setItem('sma_tick_exit_config',           JSON.stringify(exitConfig));         } catch {} }, [exitConfig]);
  useEffect(() => { try { localStorage.setItem('sma_tick_penalty_config',        JSON.stringify(penaltyConfig));      } catch {} }, [penaltyConfig]);
  useEffect(() => { try { localStorage.setItem('sma_tick_min_movement_filter',              JSON.stringify(minMovementFilter));             } catch {} }, [minMovementFilter]);
  useEffect(() => { try { localStorage.setItem('sma_tick_directional_consistency_filter',   JSON.stringify(directionalConsistencyFilter));  } catch {} }, [directionalConsistencyFilter]);
  useEffect(() => { try { localStorage.setItem('sma_tick_candle_strength_filter',           JSON.stringify(candleStrengthFilter));          } catch {} }, [candleStrengthFilter]);
  useEffect(() => { try { localStorage.setItem('sma_tick_no_new_trades_after_time',         JSON.stringify(noNewTradesAfterTime));           } catch {} }, [noNewTradesAfterTime]);
  useEffect(() => { try { localStorage.setItem('sma_tick_cascade_protection',            JSON.stringify(cascadeProtection));             } catch {} }, [cascadeProtection]);
  useEffect(() => { try { localStorage.setItem('sma_tick_real_trend_config',             JSON.stringify(realTrendConfig));               } catch {} }, [realTrendConfig]);

  // ── Config presets (shared sma_opts_presets key — same presets across Live/Replay/Tick) ──
  const [presets,           setPresets]           = useState(() => { try { return JSON.parse(localStorage.getItem('sma_opts_presets') || '[]'); } catch { return []; } });
  const [presetName,        setPresetName]        = useState('');
  const [presetDescription, setPresetDescription] = useState('');
  const [showPresetSave,    setShowPresetSave]    = useState(false);

  function capturePresetConfig() {
    return {
      interval, quantity, capital,
      strategies,
      decisionCfg, selectionCfg, switchCfg,
      optsRegimeCfg, chopRules, tradingRules, regimeRules, regimeStrategyRules,
      optsRisk, rangeQuality, tradeQuality, trendEntry, compressionEntry,
      holdConfig, exitConfig, penaltyConfig, minMovementFilter, directionalConsistencyFilter, candleStrengthFilter,
      noNewTradesAfterTime,
      cascadeProtection, realTrendConfig,
    };
  }

  const selectedPresetId = (() => {
    const current = JSON.stringify(capturePresetConfig());
    return presets.find(p => {
      const { nifty: _n, cePool: _ce, pePool: _pe, warmupDays: _w, ...presetCmp } = p.config;
      return JSON.stringify(presetCmp) === current;
    })?.id ?? null;
  })();

  function savePreset() {
    if (!presetName.trim()) return;
    const preset = { id: Date.now().toString(), name: presetName.trim(), description: presetDescription.trim(), createdAt: new Date().toISOString(), config: capturePresetConfig() };
    const next = [preset, ...presets];
    setPresets(next);
    try { localStorage.setItem('sma_opts_presets', JSON.stringify(next)); } catch {}
    setPresetName(''); setPresetDescription(''); setShowPresetSave(false);
  }

  function applyPreset(preset) {
    const c = preset.config;
    if (c.interval            !== undefined) setInterval(c.interval);
    if (c.quantity            !== undefined) setQuantity(c.quantity);
    if (c.capital             !== undefined) setCapital(c.capital);
    if (c.strategies          !== undefined) setStrategies(c.strategies);
    if (c.decisionCfg         !== undefined) setDecisionCfg(c.decisionCfg);
    if (c.selectionCfg        !== undefined) setSelectionCfg(c.selectionCfg);
    if (c.switchCfg           !== undefined) setSwitchCfg(c.switchCfg);
    if (c.optsRegimeCfg       !== undefined) setOptsRegimeCfg(c.optsRegimeCfg);
    if (c.chopRules           !== undefined) setChopRules(c.chopRules);
    if (c.tradingRules        !== undefined) setTradingRules(c.tradingRules);
    if (c.regimeRules         !== undefined) setRegimeRules(c.regimeRules);
    if (c.regimeStrategyRules !== undefined) setRegimeStrategyRules(c.regimeStrategyRules);
    if (c.optsRisk            !== undefined) setOptsRisk(c.optsRisk);
    if (c.rangeQuality        !== undefined) setRangeQuality(c.rangeQuality);
    if (c.tradeQuality        !== undefined) setTradeQuality(c.tradeQuality);
    setTrendEntry({ ...DEFAULT_TREND_ENTRY, ...(c.trendEntry ?? {}) });
    if (c.compressionEntry    !== undefined) setCompressionEntry(c.compressionEntry);
    setHoldConfig({ ...DEFAULT_HOLD, ...(c.holdConfig ?? {}) });
    setExitConfig({ ...DEFAULT_EXIT_CONFIG, ...(c.exitConfig ?? {}) });
    setPenaltyConfig({ ...DEFAULT_PENALTY_CONFIG, ...(c.penaltyConfig ?? {}) });
    setMinMovementFilter(c.minMovementFilter ?? DEFAULT_MIN_MOVEMENT_FILTER);
    setDirectionalConsistencyFilter(c.directionalConsistencyFilter ?? DEFAULT_DIRECTIONAL_CONSISTENCY_FILTER);
    setCandleStrengthFilter(c.candleStrengthFilter ?? DEFAULT_CANDLE_STRENGTH_FILTER);
    setNoNewTradesAfterTime(c.noNewTradesAfterTime ?? DEFAULT_NO_NEW_TRADES_AFTER_TIME);
    setCascadeProtection(c.cascadeProtection ?? DEFAULT_CASCADE_PROTECTION);
    setRealTrendConfig({ ...DEFAULT_REAL_TREND_CONFIG, ...(c.realTrendConfig ?? {}) });
  }

  function deletePreset(id) {
    const preset = presets.find(p => p.id === id);
    if (!window.confirm(`Delete preset "${preset?.name}"?`)) return;
    const next = presets.filter(p => p.id !== id);
    setPresets(next);
    try { localStorage.setItem('sma_opts_presets', JSON.stringify(next)); } catch {}
  }

  function downloadPreset(preset) {
    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `preset-${preset.name.replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  function downloadAllPresets() {
    const blob = new Blob([JSON.stringify(presets, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = 'sma_opts_presets.json';
    a.click(); URL.revokeObjectURL(url);
  }

  function uploadPresets(e) {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target.result);
        const incoming = Array.isArray(parsed) ? parsed : [parsed];
        if (!incoming.every(p => p.id && p.name && p.config)) { alert('Invalid preset file — each preset must have id, name, and config fields.'); return; }
        const existingIds = new Set(presets.map(p => p.id));
        const next = [...incoming.filter(p => !existingIds.has(p.id)), ...presets];
        setPresets(next);
        try { localStorage.setItem('sma_opts_presets', JSON.stringify(next)); } catch {}
      } catch { alert('Failed to parse preset file — must be valid JSON.'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  const [status,          setStatus]          = useState('idle'); // idle|running|completed|error
  const [feed,            setFeed]            = useState([]);
  const [summary,         setSummary]         = useState(null);
  const [initInfo,        setInitInfo]        = useState(null);
  const [error,           setError]           = useState('');
  const [warnings,        setWarnings]        = useState([]);
  const [rightTab,        setRightTab]        = useState('feed');
  const [aiReviews,       setAiReviews]       = useState([]);
  const [aiAdvisories,    setAiAdvisories]    = useState([]);
  const [feedExpanded,    setFeedExpanded]    = useState(false);
  const [liveTicks,       setLiveTicks]       = useState({});
  const [replaySessionId, setReplaySessionId] = useState(null);
  const abortRef              = useRef(null);
  const readerRef             = useRef(null);
  const replaySessionRef      = useRef(null);
  // Preserved across completion — cleared only after a successful save. Used by save pipeline.
  const lastSaveReplaySessionIdRef = useRef(null);
  const lastPayloadRef        = useRef(null);
  // Accumulates raw tick events for post-session comparison. Capped at 10 000 to limit payload size.
  const ticksRef         = useRef([]);

  // ── Save to Compare state
  const [showSavePanel, setShowSavePanel] = useState(false);
  const [saveLabel,     setSaveLabel]     = useState('');
  const [saveStatus,    setSaveStatus]    = useState('idle'); // idle|saving|saved|error
  const [saveError,     setSaveError]     = useState('');

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  useEffect(() => {
    setSessionsLoading(true);
    setSessionsError('');
    listTickSessions()
      .then(res => { const list = res?.data ?? res ?? []; setSessions(Array.isArray(list) ? list : []); })
      .catch(e => setSessionsError(e.message))
      .finally(() => setSessionsLoading(false));
  }, []);

  // Fetch AI reviews + advisories after replay completes (only if AI was enabled and session is set)
  useEffect(() => {
    if (status !== 'completed' || !aiEnabled || !sessionId) return;
    getAiReviews(sessionId)
      .then(res => setAiReviews(res?.data ?? []))
      .catch(() => {});
    getAiAdvisories(sessionId)
      .then(res => setAiAdvisories(res?.data ?? []))
      .catch(() => {});
  }, [status]);

  function updatePoolInst(pool, setPool, id, patch) { setPool(p => p.map(i => i.id === id ? { ...i, ...patch } : i)); }
  function addPoolInst(setPool)              { setPool(p => [...p, EMPTY_OPTION_INST()]); }
  function removePoolInst(pool, setPool, id) { setPool(p => p.length > 1 ? p.filter(i => i.id !== id) : p); }
  function updateStrategy(idx, patch)        { setStrategies(p => p.map((s, i) => i === idx ? { ...s, ...patch } : s)); }
  function updateStratParam(idx, key, val)   { setStrategies(p => p.map((s, i) => i === idx ? { ...s, parameters: { ...s.parameters, [key]: val } } : s)); }

  async function handleStop() {
    abortRef.current?.abort();
    try { readerRef.current?.cancel(); } catch {}
    const sid = replaySessionRef.current;
    if (sid) {
      try { await stopTickReplayEval(sid); } catch {}
      replaySessionRef.current = null;
      setReplaySessionId(null);
    }
    setStatus('idle');
  }

  function downloadCSV(mode = 'csv') {
    const q    = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const row  = mode === 'txt'
      ? (...cols) => cols.map(v => String(v ?? '')).join('\t')
      : (...cols) => cols.map(q).join(',');
    const blank = '';
    const lines = [];
    const n2    = v => v != null ? Number(v).toFixed(2) : '';

    // ── Run Config ──────────────────────────────────────────────────────────
    lines.push(row('=== Run Config ==='));
    lines.push(row('Session ID', 'NIFTY Token', 'NIFTY Symbol', 'Exchange', 'Interval', 'From', 'To', 'Speed', 'Quantity', 'Capital'));
    lines.push(row(sessionId, niftyToken, niftySymbol, niftyExchange, interval, fromDate || '—', toDate || '—', speed, quantity, capital));
    lines.push(blank);

    // ── CE Pool ─────────────────────────────────────────────────────────────
    lines.push(row('=== CE Options Pool ==='));
    lines.push(row('Token', 'Symbol', 'Exchange'));
    cePool.filter(i => i.instrumentToken).forEach(i => lines.push(row(i.instrumentToken, i.symbol, i.exchange)));
    lines.push(blank);

    // ── PE Pool ─────────────────────────────────────────────────────────────
    lines.push(row('=== PE Options Pool ==='));
    lines.push(row('Token', 'Symbol', 'Exchange'));
    pePool.filter(i => i.instrumentToken).forEach(i => lines.push(row(i.instrumentToken, i.symbol, i.exchange)));
    lines.push(blank);

    // ── Strategies ──────────────────────────────────────────────────────────
    lines.push(row('=== Strategies ==='));
    lines.push(row('Strategy Type', 'Enabled', 'Parameters'));
    strategies.forEach(s => lines.push(row(s.strategyType, s.enabled ? 'Yes' : 'No', JSON.stringify(s.parameters || {}))));
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
    lines.push(row('Min Premium', 'Max Premium', 'Strict Premium Band'));
    lines.push(row(selectionCfg.minPremium, selectionCfg.maxPremium, selectionCfg.strictPremiumBand ? 'ON' : 'OFF'));
    lines.push(blank);

    // ── Switch Config ───────────────────────────────────────────────────────
    lines.push(row('=== Switch Config ==='));
    lines.push(row('Switch Confirmation Candles', 'Max Switches Per Day'));
    lines.push(row(switchCfg.switchConfirmationCandles, switchCfg.maxSwitchesPerDay));
    lines.push(blank);

    // ── Trading Rules ────────────────────────────────────────────────────────
    lines.push(row('=== Trading Rules ==='));
    lines.push(row('Enabled', 'No Trade in RANGING', 'No Trade in VOLATILE', 'No Trade in COMPRESSION', 'No Same-Candle Reversal'));
    lines.push(row(
      tradingRules.enabled ? 'Yes' : 'No',
      tradingRules.rangingNoTrade       ? 'ON' : 'OFF',
      tradingRules.volatileNoTrade      ? 'ON' : 'OFF',
      tradingRules.compressionNoTrade   ? 'ON' : 'OFF',
      tradingRules.noSameCandleReversal ? 'ON' : 'OFF',
    ));
    lines.push(blank);

    // ── Min Movement Filter ──────────────────────────────────────────────────
    lines.push(row('=== Min Movement Filter ==='));
    lines.push(row('Enabled', 'Lookback Candles', 'Threshold %'));
    lines.push(row(
      minMovementFilter.enabled ? 'ON' : 'OFF',
      minMovementFilter.minMovementLookbackCandles,
      minMovementFilter.minMovementThresholdPercent,
    ));
    lines.push(blank);

    // ── Directional Consistency Filter ──────────────────────────────────────
    lines.push(row('=== Directional Consistency Filter ==='));
    lines.push(row('Enabled', 'Lookback Candles', 'Min Same Direction Candles'));
    lines.push(row(
      directionalConsistencyFilter.enabled ? 'ON' : 'OFF',
      directionalConsistencyFilter.directionalConsistencyLookbackCandles,
      directionalConsistencyFilter.minSameDirectionCandles,
    ));
    lines.push(blank);

    // ── Candle Strength Filter ───────────────────────────────────────────────
    lines.push(row('=== Candle Strength Filter ==='));
    lines.push(row('Enabled', 'Lookback Candles', 'Min Avg Body Ratio', 'Min Strong Candles'));
    lines.push(row(
      candleStrengthFilter.enabled ? 'ON' : 'OFF',
      candleStrengthFilter.candleStrengthLookbackCandles,
      candleStrengthFilter.minAverageBodyRatio,
      candleStrengthFilter.minStrongCandlesRequired,
    ));
    lines.push(blank);


    // ── No New Trades After Time ──────────────────────────────────────────────────────
    lines.push(row('=== No New Trades After ==='));
    lines.push(row('Enabled', 'Time'));
    lines.push(row(
      noNewTradesAfterTime.enabled ? 'ON' : 'OFF',
      noNewTradesAfterTime.noNewTradesAfterTime,
    ));
    lines.push(blank);

    // ── SL Cascade Protection ────────────────────────────────────────────────
    lines.push(row('=== SL Cascade Protection ==='));
    lines.push(row('Enabled', 'SL Count', 'Window (min)', 'Pause (min)', 'Per Symbol', 'Per Side'));
    lines.push(row(
      cascadeProtection.enabled ? 'ON' : 'OFF',
      cascadeProtection.cascadeStopLossCount,
      cascadeProtection.cascadeWindowMinutes,
      cascadeProtection.cascadePauseMinutes,
      cascadeProtection.cascadeApplyPerSymbol ? 'ON' : 'OFF',
      cascadeProtection.cascadeApplyPerSide ? 'ON' : 'OFF',
    ));
    lines.push(blank);

    // ── Real Trend Validation ────────────────────────────────────────────────
    lines.push(row('=== Real Trend Validation ==='));
    lines.push(row('Enabled', 'Max Overlap Ratio', 'Min Avg Body', 'Min Body Ratio', 'Strong Bodies', 'Range Expansion', 'Persist Bars'));
    lines.push(row(
      realTrendConfig.enabled ? 'ON' : 'OFF',
      realTrendConfig.maxOverlapRatio,
      realTrendConfig.minAvgBodyRatio,
      realTrendConfig.minStrongBodyRatio,
      realTrendConfig.minStrongBodies,
      realTrendConfig.minRangeExpansion,
      realTrendConfig.minPersistBars,
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
    lines.push(row('Enabled', 'Breakout Lookback', 'Min Body %', 'Weak Body %', 'EMA Period', 'Score Bypass Weak Body', 'Bypass Score Threshold'));
    lines.push(row(
      trendEntry.enabled ? 'Yes' : 'No',
      trendEntry.breakoutLookback, trendEntry.minBodyPct, trendEntry.weakBodyPct, trendEntry.ema9Period,
      trendEntry.scoreBypassWeakBody ? 'ON' : 'OFF', trendEntry.scoreBypassWeakBodyThreshold,
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

    // ── Exit System ──────────────────────────────────────────────────────────
    lines.push(row('=== Exit System ==='));
    lines.push(row('Enabled', 'Hard Stop %', 'Hold Zone %',
      'Lock1 Trigger %', 'Lock1 Floor %', 'Lock2 Trigger %', 'Lock2 Floor %',
      'Trail Trigger %', 'Trail Factor',
      'Structure Lookback',
      'Score Abs Min', 'Bias Exit', 'Strong Exit Score',
      'Trend Strong Mode Threshold %',
      'Max Bars No Improvement', 'Stagnation Bars', 'Max Bars RANGING',
      'Max Bars Dead Trade', 'Dead Trade PnL %',
      'No-Hope Threshold %', 'No-Hope Bars', 'Breakeven Protection', 'Breakeven Trigger %', 'Breakeven Offset %'));
    lines.push(row(
      exitConfig.enabled ? 'Yes' : 'No',
      exitConfig.hardStopPct, exitConfig.holdZonePct,
      exitConfig.lock1TriggerPct, exitConfig.lock1FloorPct,
      exitConfig.lock2TriggerPct, exitConfig.lock2FloorPct,
      exitConfig.trailTriggerPct, exitConfig.trailFactor,
      exitConfig.structureLookback,
      exitConfig.scoreAbsoluteMin,
      exitConfig.biasExitEnabled ? 'Yes' : 'No', exitConfig.strongExitScore,
      exitConfig.trendStrongModeThresholdPct,
      exitConfig.maxBarsNoImprovement, exitConfig.stagnationBars, exitConfig.maxBarsRanging,
      exitConfig.maxBarsDeadTrade, exitConfig.deadTradePnlPct,
      exitConfig.noHopeThresholdPct, exitConfig.noHopeBars,
      exitConfig.breakevenProtectionEnabled ? 'ON' : 'OFF',
      exitConfig.breakevenTriggerPct, exitConfig.breakevenOffsetPct,
    ));
    lines.push(blank);

    // ── Penalty Config ───────────────────────────────────────────────────────
    lines.push(row('=== Penalty Config ==='));
    lines.push(row('Master', penaltyConfig.enabled ? 'ON' : 'OFF'));
    if (penaltyConfig.enabled) {
      lines.push(row('Signal Penalty', 'Enabled', 'Value'));
      lines.push(row('Reversal',        penaltyConfig.reversalEnabled        ? 'ON' : 'OFF', `Max=${penaltyConfig.reversalMax}`));
      lines.push(row('Overextension',   penaltyConfig.overextensionEnabled   ? 'ON' : 'OFF', `Max=${penaltyConfig.overextensionMax}`));
      lines.push(row('Same Color',      penaltyConfig.sameColorEnabled       ? 'ON' : 'OFF', `Max=${penaltyConfig.sameColorMax}`));
      lines.push(row('Mismatch',        penaltyConfig.mismatchEnabled        ? 'ON' : 'OFF', `Scale=${penaltyConfig.mismatchScale}`));
      lines.push(row('Volatile Option', penaltyConfig.volatileOptionEnabled  ? 'ON' : 'OFF', `Penalty=${penaltyConfig.volatileOptionPenalty}`));
      lines.push(row('Entry Penalty', 'Enabled', 'Value'));
      lines.push(row('Move',           penaltyConfig.movePenaltyEnabled         ? 'ON' : 'OFF', penaltyConfig.movePenalty));
      lines.push(row('VWAP',           penaltyConfig.vwapPenaltyEnabled         ? 'ON' : 'OFF', penaltyConfig.vwapPenalty));
      lines.push(row('Chop',           penaltyConfig.chopPenaltyEnabled         ? 'ON' : 'OFF', penaltyConfig.chopPenalty));
      lines.push(row('Range Drifting', penaltyConfig.rangeDriftingEnabled       ? 'ON' : 'OFF', penaltyConfig.rangeDriftingPenalty));
      lines.push(row('Range Poor Str', penaltyConfig.rangePoorStructureEnabled  ? 'ON' : 'OFF', penaltyConfig.rangePoorStructurePenalty));
      lines.push(row('Range Choppy',   penaltyConfig.rangeChoppyEnabled         ? 'ON' : 'OFF', penaltyConfig.rangeChoppyPenalty));
      lines.push(row('Range Size',     penaltyConfig.rangeSizeEnabled           ? 'ON' : 'OFF', penaltyConfig.rangeSizePenalty));
    }
    lines.push(blank);

    // ── Summary ─────────────────────────────────────────────────────────────
    if (summary) {
      lines.push(row('=== Summary ==='));
      lines.push(row('Total Trades', 'Realized P&L', 'Final Capital'));
      lines.push(row(summary.totalTrades, summary.realizedPnl, summary.finalCapital));
      lines.push(blank);
    }

    // ── Closed Trades ───────────────────────────────────────────────────────
    const ct = feed[feed.length - 1]?.closedTrades || summary?.closedTrades || [];
    if (ct.length > 0) {
      lines.push(row('=== Closed Trades ==='));
      lines.push(row('Entry Time', 'Exit Time', 'Type', 'Symbol', 'Strike', 'Expiry',
        'Entry Px', 'Exit Px', 'Qty', 'P&L', 'P&L %', 'Bars', 'Exit Reason', 'Capital After', 'Entry Regime', 'Exit Regime'));
      ct.forEach(t => lines.push(row(
        (t.entryTime || '').slice(0, 16), (t.exitTime || '').slice(0, 16),
        t.optionType, t.tradingSymbol, t.strike, t.expiry,
        t.entryPrice != null ? Number(t.entryPrice).toFixed(2) : '',
        t.exitPrice  != null ? Number(t.exitPrice).toFixed(2)  : '',
        t.quantity,
        t.pnl    != null ? Number(t.pnl).toFixed(2)    : '',
        t.pnlPct != null ? Number(t.pnlPct).toFixed(2) : '',
        t.barsInTrade, t.exitReason,
        t.capitalAfter != null ? Number(t.capitalAfter).toFixed(2) : '',
        t.entryRegime || '', t.exitRegime || '',
      )));
      lines.push(blank);
    }

    // ── Per-Candle Feed ─────────────────────────────────────────────────────
    if (feed.length > 0) {
      lines.push(row('=== Per-Candle Feed ==='));
      lines.push(row(
        'Candle #', 'Total Candles',
        'Time', 'Phase', 'Tradable',
        'NIFTY Open', 'NIFTY High', 'NIFTY Low', 'NIFTY Close', 'NIFTY Volume',
        'Regime', 'Raw Bias', 'Prev Bias', 'Conf Bias',
        'Winner Strategy', 'Winner Score', 'Score Gap', 'Confidence',
        '2nd Strategy', '2nd Score',
        'Neutral Reason',
        'Shadow Winner', 'Shadow Score', 'Shadow Not-Taken Reason',
        'Recent Move 3%', 'Recent Move 5%', 'VWAP Dist%',
        'Entry Allowed', 'Block Reason', 'Exec Wait Reason',
        'Switch Requested', 'Switch Confirmed', 'Switch Reason', 'Switch Count Today', 'Confirm Count', 'Confirm Required',
        'Bars Since Trade',
        'Candidates',
        'Position State', 'Desired Side', 'Action', 'Exit Reason',
        'Entry Regime', 'Applied Min Hold', 'Hold Active',
        'Peak PnL %', 'Profit Lock Floor %', 'In Hold Zone', 'In Strong Trend Mode',
        'Selected Symbol', 'Option Type', 'Strike', 'Expiry',
        'Entry Price', 'Exit Price', 'Bars In Trade',
        'uPnL', 'rPnL', 'Total PnL', 'Capital',
        'Option Time', 'Option Open', 'Option High', 'Option Low', 'Option Close', 'Option Volume',
      ));
      feed.forEach(e => lines.push(row(
        e.emitted ?? '', e.total ?? '',
        (e.niftyTime || '').slice(0, 19),
        e.marketPhase || 'TRADING', e.tradable ? 'Yes' : 'No',
        n2(e.niftyOpen), n2(e.niftyHigh), n2(e.niftyLow), n2(e.niftyClose),
        e.niftyVolume ?? '',
        e.regime || '', e.niftyBias || '', e.previousNiftyBias || '', e.confirmedBias || '',
        e.winnerStrategy || '', n2(e.winnerScore), n2(e.scoreGap),
        e.confidenceLevel || '',
        e.secondStrategy || '', n2(e.secondScore),
        e.neutralReason || '',
        e.shadowWinner || '', n2(e.shadowWinnerScore), e.shadowWinnerReasonNotTaken || '',
        n2(e.recentMove3), n2(e.recentMove5), n2(e.distanceFromVwap),
        e.entryAllowed ? 'Yes' : 'No', e.blockReason || '', e.execWaitReason || '',
        e.switchRequested ? 'Yes' : 'No', e.switchConfirmed ? 'Yes' : 'No',
        e.switchReason || '', e.switchCountToday ?? '', e.confirmCount ?? '', e.confirmRequired ?? '',
        e.barsSinceLastTrade ?? '',
        (e.candidates || []).map(c =>
          `${c.strategyType}:${c.signal}:${Number(c.score).toFixed(1)}:${c.eligible ? 'ok' : 'blocked'}${c.eligibilityReason ? '(' + c.eligibilityReason + ')' : ''}`
        ).join(' | '),
        e.positionState || '', e.desiredSide || '', e.action || '', e.exitReason || '',
        e.entryRegime || '', e.appliedMinHold ?? '', e.holdActive ? 'Yes' : 'No',
        n2(e.peakPnlPct), n2(e.profitLockFloor),
        e.inHoldZone ? 'Yes' : 'No', e.inStrongTrendMode ? 'Yes' : 'No',
        e.selectedTradingSymbol || '', e.selectedOptionType || '',
        e.selectedStrike ?? '', e.selectedExpiry || '',
        n2(e.entryPrice), n2(e.exitPrice), e.barsInTrade ?? '',
        n2(e.unrealizedPnl), n2(e.realizedPnl), n2(e.totalPnl), n2(e.capital),
        (e.optionTime || '').slice(0, 19),
        n2(e.optionOpen), n2(e.optionHigh), n2(e.optionLow), n2(e.optionClose),
        e.optionVolume ?? '',
      )));

      // ── Per-Candidate Pipeline Breakdown ────────────────────────────────
      const strategyTypes = [...new Set(feed.flatMap(e => (e.candidates || []).map(c => c.strategyType)))];
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

    const content = lines.join('\n');
    const blob = new Blob([content], { type: mode === 'txt' ? 'text/plain' : 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `tick_replay_${sessionId || 'data'}.${mode}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleSaveToCompare() {
    setSaveStatus('saving'); setSaveError('');
    try {
      // Use the preserved replay session ID — never null out lastSaveReplaySessionIdRef on completion.
      const replaySid = lastSaveReplaySessionIdRef.current;
      if (!replaySid) {
        console.warn('[REPLAY save] blocked: no session ID available');
        throw new Error('No completed replay session to save. Please run a tick replay first.');
      }
      console.log('[REPLAY save] session ID:', replaySid);

      // Fetch the auto-saved draft record from DB (written by server on session completion).
      // This is the authoritative source — survives server restarts and client state resets.
      let record;
      try {
        const res = await getSessionResult(replaySid);
        record = res?.data;
      } catch (e) {
        console.warn('[REPLAY save] DB fetch failed:', e.message);
      }

      if (!record) throw new Error('Session record not found on server. Cannot save for compare.');

      const serverTrades  = record?.closedTradesJson ? JSON.parse(record.closedTradesJson) : [];
      const serverSummary = record?.summaryJson      ? JSON.parse(record.summaryJson)       : {};
      const wins = serverTrades.filter(t => t.pnl > 0).length;
      const replayDate = fromDate || new Date().toISOString().slice(0, 10);

      console.log('[REPLAY save] server trades:', serverTrades?.length ?? 0,
                  '| dataEngineSessionId:', serverSummary.dataEngineSessionId ?? selectedSession?.sessionId);

      // Finalize server-side: update label + summary only — feed stays in session_feed_chunk
      await finalizeSessionResult(replaySid, {
        label:        saveLabel || replayDate,
        closedTrades: serverTrades,
        summary: {
          trades:              serverTrades.length,
          realizedPnl:         serverSummary.realizedPnl  ?? 0,
          winRate:             serverTrades.length > 0 ? wins / serverTrades.length : 0,
          finalCapital:        serverSummary.finalCapital ?? parseFloat(capital) ?? 100000,
          fromDate:            fromDate                   || serverSummary.fromDate   || undefined,
          toDate:              toDate                     || serverSummary.toDate     || undefined,
          replayFirstTick:     selectedSession?.firstTick || undefined,
          replayLastTick:      selectedSession?.lastTick  || undefined,
          dataEngineSessionId: selectedSession?.sessionId || serverSummary.dataEngineSessionId || undefined,
        },
      });
      console.log('[REPLAY save] finalized: sessionId=', replaySid, 'trades=', serverTrades.length);
      lastSaveReplaySessionIdRef.current = null;  // clear only after successful save
      setSaveStatus('saved');
      setShowSavePanel(false);
      setSaveLabel('');
    } catch (e) {
      console.error('[REPLAY save] failed:', e.message);
      setSaveStatus('error');
      setSaveError(e.message);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (status === 'running') { handleStop(); return; }
    setFeed([]); setSummary(null); setInitInfo(null); setError(''); setWarnings([]); setLiveTicks({});
    setStatus('running');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const enabledStrats = strategies.filter(s => s.enabled).map(s => ({ strategyType: s.strategyType, parameters: s.parameters }));
    const payload = {
      sessionId, interval,
      userId:     userId     || undefined,
      brokerName: brokerName || undefined,
      warmupDays: parseInt(warmupDays, 10) || 0,
      fromDate: fromDate || undefined,
      toDate:   toDate   || undefined,
      niftyInstrumentToken: niftyToken ? parseInt(niftyToken, 10) : undefined,
      niftySymbol: niftySymbol || 'NIFTY 50', niftyExchange: niftyExchange || 'NSE',
      quantity: parseInt(quantity, 10) || 0, initialCapital: parseFloat(capital) || 100000, speedMultiplier: parseFloat(speed) || 0,
      saveForCompare,
      aiEnabled,
      ceOptions: cePool.filter(i => i.instrumentToken).map(i => ({ instrumentToken: parseInt(i.instrumentToken, 10), tradingSymbol: i.symbol, exchange: i.exchange })),
      peOptions: pePool.filter(i => i.instrumentToken).map(i => ({ instrumentToken: parseInt(i.instrumentToken, 10), tradingSymbol: i.symbol, exchange: i.exchange })),
      strategies: enabledStrats,
      decisionConfig: {
        minScore: parseFloat(decisionCfg.minScore)||40, minScoreGap: parseFloat(decisionCfg.minScoreGap)||8,
        maxRecentMove3: parseFloat(decisionCfg.maxRecentMove3)||1.5, maxRecentMove5: parseFloat(decisionCfg.maxRecentMove5)||2.5,
        maxAbsVwapDist: parseFloat(decisionCfg.maxAbsVwapDist)||1.5, minBarsSinceTrade: parseInt(decisionCfg.minBarsSinceTrade,10)||3,
        chopFilter: decisionCfg.chopFilter, chopLookback: parseInt(decisionCfg.chopLookback,10)||8,
        penaltyMinScore: parseFloat(decisionCfg.penaltyMinScore)||parseFloat(decisionCfg.minScore)||0,
        scoreFloorTrigger: parseFloat(decisionCfg.scoreFloorTrigger)||35, scoreFloorMin: parseFloat(decisionCfg.scoreFloorMin)||25,
        bollingerBonusThreshold: parseFloat(decisionCfg.bollingerBonusThreshold)||35, bollingerBonus: parseFloat(decisionCfg.bollingerBonus)||0,
        earlyEntryRisingBars: parseInt(decisionCfg.earlyEntryRisingBars,10)||0,
        rawScoreBypassThreshold: parseFloat(decisionCfg.rawScoreBypassThreshold)||0, rawScoreBypassGap: parseFloat(decisionCfg.rawScoreBypassGap)||3,
        bollingerEarlyEntryMinScore: parseFloat(decisionCfg.bollingerEarlyEntryMinScore)||0,
      },
      selectionConfig: { minPremium: parseFloat(selectionCfg.minPremium)||50, maxPremium: parseFloat(selectionCfg.maxPremium)||300, strictPremiumBand: !!selectionCfg.strictPremiumBand },
      switchConfig: { switchConfirmationCandles: parseInt(switchCfg.switchConfirmationCandles,10)||2, maxSwitchesPerDay: parseInt(switchCfg.maxSwitchesPerDay,10)||3, minScoreImprovementForSwitch: parseFloat(switchCfg.minScoreImprovementForSwitch)||0 },
      regimeConfig: optsRegimeCfg.enabled ? { enabled:true, adxPeriod: parseInt(optsRegimeCfg.adxPeriod,10)||14, atrPeriod: parseInt(optsRegimeCfg.atrPeriod,10)||14, adxTrendThreshold: parseFloat(optsRegimeCfg.adxTrendThreshold)||25, atrVolatilePct: parseFloat(optsRegimeCfg.atrVolatilePct)||2.0, atrCompressionPct: parseFloat(optsRegimeCfg.atrCompressionPct)||0.5 } : { enabled: false },
      regimeRules: { enabled: regimeRules.enabled, rangingMinScore: parseFloat(regimeRules.rangingMinScore)||35, rangingMinScoreGap: parseFloat(regimeRules.rangingMinScoreGap)||6, trendingMinScore: parseFloat(regimeRules.trendingMinScore)||25, trendingMinScoreGap: parseFloat(regimeRules.trendingMinScoreGap)||3, compressionMinScore: parseFloat(regimeRules.compressionMinScore)||25, compressionMinScoreGap: parseFloat(regimeRules.compressionMinScoreGap)||3 },
      chopRules: { enabled: chopRules.enabled, ...Object.fromEntries(['ranging','trending','compression','volatile'].map(rk => [rk==='volatile'?'volatileRegime':rk, { filterEnabled: chopRules[rk].filterEnabled, flipRatio: parseFloat(chopRules[rk].flipRatio)||0.65 }])) },
      tradingRules: { enabled: tradingRules.enabled, rangingNoTrade: tradingRules.rangingNoTrade, volatileNoTrade: tradingRules.volatileNoTrade, compressionNoTrade: tradingRules.compressionNoTrade, noSameCandleReversal: tradingRules.noSameCandleReversal },
      regimeStrategyRules: { enabled: regimeStrategyRules.enabled, ranging: regimeStrategyRules.ranging.enabled?regimeStrategyRules.ranging.allowed:[], trending: regimeStrategyRules.trending.enabled?regimeStrategyRules.trending.allowed:[], compression: regimeStrategyRules.compression.enabled?regimeStrategyRules.compression.allowed:[], volatileRegime: regimeStrategyRules.volatile.enabled?regimeStrategyRules.volatile.allowed:[] },
      riskConfig: optsRisk.enabled ? { enabled:true, stopLossPct: parseFloat(optsRisk.stopLossPct)||0, takeProfitPct: parseFloat(optsRisk.takeProfitPct)||0, maxRiskPerTradePct: parseFloat(optsRisk.maxRiskPerTradePct)||0, dailyLossCapPct: parseFloat(optsRisk.dailyLossCapPct)||0, cooldownCandles: parseInt(optsRisk.cooldownCandles,10)||0 } : { enabled: false },
      rangeQualityConfig: rangeQuality.enabled ? { enabled:true, lookbackBars: parseInt(rangeQuality.lookbackBars,10)||10, minUpperTouches: parseInt(rangeQuality.minUpperTouches,10)||2, minLowerTouches: parseInt(rangeQuality.minLowerTouches,10)||2, bandTouchTolerancePct: parseFloat(rangeQuality.bandTouchTolerancePct)||0.15, minRangeWidthPct: parseFloat(rangeQuality.minRangeWidthPct)||0.3, maxRangeWidthPct: parseFloat(rangeQuality.maxRangeWidthPct)||3.0, maxDirectionalDriftPctOfRange: parseFloat(rangeQuality.maxDirectionalDriftPctOfRange)||0.6, chopFlipRatioLimit: parseFloat(rangeQuality.chopFlipRatioLimit)||0.65, enableChopCheck: rangeQuality.enableChopCheck } : { enabled: false },
      tradeQualityConfig: tradeQuality.enabled ? { enabled:true, strongScoreThreshold: parseFloat(tradeQuality.strongScoreThreshold)||40, normalScoreThreshold: parseFloat(tradeQuality.normalScoreThreshold)||32, weakTradeLossCooldown: parseInt(tradeQuality.weakTradeLossCooldown,10)||5, blockWeakInRanging: tradeQuality.blockWeakInRanging, weakRangingMinScore: parseFloat(tradeQuality.weakRangingMinScore)||28, weakRangingMinGap: parseFloat(tradeQuality.weakRangingMinGap)||3, rangingConfirmCandles: parseInt(tradeQuality.rangingConfirmCandles,10)||2, trendingConfirmCandles: parseInt(tradeQuality.trendingConfirmCandles,10)||1 } : { enabled: false },
      trendEntryConfig: trendEntry.enabled ? { enabled:true, breakoutLookback: parseInt(trendEntry.breakoutLookback,10)||5, minBodyPct: parseFloat(trendEntry.minBodyPct)||45, weakBodyPct: parseFloat(trendEntry.weakBodyPct)||20, ema9Period: parseInt(trendEntry.ema9Period,10)||9, scoreBypassWeakBody: trendEntry.scoreBypassWeakBody, scoreBypassWeakBodyThreshold: parseFloat(trendEntry.scoreBypassWeakBodyThreshold)||25 } : { enabled: false },
      compressionEntryConfig: compressionEntry.enabled ? { enabled:true, rangeLookback: parseInt(compressionEntry.rangeLookback,10)||10, longZoneMax: parseFloat(compressionEntry.longZoneMax)||0.2, shortZoneMin: parseFloat(compressionEntry.shortZoneMin)||0.8, noTradeZoneMin: parseFloat(compressionEntry.noTradeZoneMin)||0.4, noTradeZoneMax: parseFloat(compressionEntry.noTradeZoneMax)||0.6, rejectBreakoutCandle: compressionEntry.rejectBreakoutCandle } : { enabled: false },
      holdConfig: { enabled: holdConfig.enabled, defaultMinHoldBars: parseInt(holdConfig.defaultMinHoldBars,10)||3, rangingMinHoldBars: parseInt(holdConfig.rangingMinHoldBars,10)||4, trendingMinHoldBars: parseInt(holdConfig.trendingMinHoldBars,10)||2, strongOppositeScore: parseFloat(holdConfig.strongOppositeScore)||35, persistentExitBars: parseInt(holdConfig.persistentExitBars,10)||2 },
      exitConfig: { enabled: exitConfig.enabled, hardStopPct: parseFloat(exitConfig.hardStopPct)||7, holdZonePct: parseFloat(exitConfig.holdZonePct)||5, lock1TriggerPct: parseFloat(exitConfig.lock1TriggerPct)||5, lock1FloorPct: parseFloat(exitConfig.lock1FloorPct)||2, lock2TriggerPct: parseFloat(exitConfig.lock2TriggerPct)||10, lock2FloorPct: parseFloat(exitConfig.lock2FloorPct)||5, trailTriggerPct: parseFloat(exitConfig.trailTriggerPct)||15, trailFactor: parseFloat(exitConfig.trailFactor)||0.4, firstMoveBars: parseInt(exitConfig.firstMoveBars,10)||0, firstMoveLockPct: parseFloat(exitConfig.firstMoveLockPct)||0.5, structureLookback: parseInt(exitConfig.structureLookback,10)||5, scoreDropFactor: parseFloat(exitConfig.scoreDropFactor)||0, scoreAbsoluteMin: parseFloat(exitConfig.scoreAbsoluteMin)||0, biasExitEnabled: exitConfig.biasExitEnabled, strongExitScore: parseFloat(exitConfig.strongExitScore)||40, trendStrongModeThresholdPct: parseFloat(exitConfig.trendStrongModeThresholdPct)||5, maxBarsNoImprovement: parseInt(exitConfig.maxBarsNoImprovement,10)||3, stagnationBars: parseInt(exitConfig.stagnationBars,10)||2, maxBarsRanging: parseInt(exitConfig.maxBarsRanging,10)||6, maxBarsDeadTrade: parseInt(exitConfig.maxBarsDeadTrade,10)||10, deadTradePnlPct: parseFloat(exitConfig.deadTradePnlPct)||2, noHopeThresholdPct: parseFloat(exitConfig.noHopeThresholdPct)||1.5, noHopeBars: parseInt(exitConfig.noHopeBars,10)||2, breakevenProtectionEnabled: exitConfig.breakevenProtectionEnabled, breakevenTriggerPct: parseFloat(exitConfig.breakevenTriggerPct)||2, breakevenOffsetPct: parseFloat(exitConfig.breakevenOffsetPct)||0 },
      penaltyConfig: { enabled: penaltyConfig.enabled, reversalEnabled: penaltyConfig.reversalEnabled, reversalMax: parseFloat(penaltyConfig.reversalMax)||25, overextensionEnabled: penaltyConfig.overextensionEnabled, overextensionMax: parseFloat(penaltyConfig.overextensionMax)||30, sameColorEnabled: penaltyConfig.sameColorEnabled, sameColorMax: parseFloat(penaltyConfig.sameColorMax)||30, mismatchEnabled: penaltyConfig.mismatchEnabled, mismatchScale: parseFloat(penaltyConfig.mismatchScale)||1.0, volatileOptionEnabled: penaltyConfig.volatileOptionEnabled, volatileOptionPenalty: parseFloat(penaltyConfig.volatileOptionPenalty)||35, movePenaltyEnabled: penaltyConfig.movePenaltyEnabled, movePenalty: parseFloat(penaltyConfig.movePenalty)||3, vwapPenaltyEnabled: penaltyConfig.vwapPenaltyEnabled, vwapPenalty: parseFloat(penaltyConfig.vwapPenalty)||5, chopPenaltyEnabled: penaltyConfig.chopPenaltyEnabled, chopPenalty: parseFloat(penaltyConfig.chopPenalty)||2, rangeDriftingEnabled: penaltyConfig.rangeDriftingEnabled, rangeDriftingPenalty: parseFloat(penaltyConfig.rangeDriftingPenalty)||3, rangePoorStructureEnabled: penaltyConfig.rangePoorStructureEnabled, rangePoorStructurePenalty: parseFloat(penaltyConfig.rangePoorStructurePenalty)||4, rangeChoppyEnabled: penaltyConfig.rangeChoppyEnabled, rangeChoppyPenalty: parseFloat(penaltyConfig.rangeChoppyPenalty)||2, rangeSizeEnabled: penaltyConfig.rangeSizeEnabled, rangeSizePenalty: parseFloat(penaltyConfig.rangeSizePenalty)||2 },
      minMovementFilterConfig: minMovementFilter.enabled ? { enabled: true, minMovementLookbackCandles: parseInt(minMovementFilter.minMovementLookbackCandles, 10)||3, minMovementThresholdPercent: parseFloat(minMovementFilter.minMovementThresholdPercent)||1.0 } : { enabled: false },
      directionalConsistencyFilterConfig: directionalConsistencyFilter.enabled ? { enabled: true, directionalConsistencyLookbackCandles: parseInt(directionalConsistencyFilter.directionalConsistencyLookbackCandles, 10)||3, minSameDirectionCandles: parseInt(directionalConsistencyFilter.minSameDirectionCandles, 10)||2 } : { enabled: false },
      candleStrengthFilterConfig: candleStrengthFilter.enabled ? { enabled: true, candleStrengthLookbackCandles: parseInt(candleStrengthFilter.candleStrengthLookbackCandles, 10)||3, minAverageBodyRatio: parseFloat(candleStrengthFilter.minAverageBodyRatio)||0.50, minStrongCandlesRequired: parseInt(candleStrengthFilter.minStrongCandlesRequired, 10)||2 } : { enabled: false },
      noNewTradesAfterTimeConfig: noNewTradesAfterTime.enabled ? { enabled: true, noNewTradesAfterTime: noNewTradesAfterTime.noNewTradesAfterTime || '14:45' } : { enabled: false },
      stopLossCascadeProtectionConfig: cascadeProtection.enabled ? { enabled: true, cascadeStopLossCount: parseInt(cascadeProtection.cascadeStopLossCount,10)||2, cascadeWindowMinutes: parseInt(cascadeProtection.cascadeWindowMinutes,10)||30, cascadePauseMinutes: parseInt(cascadeProtection.cascadePauseMinutes,10)||30, cascadeExitReasons: ['HARD_STOP_LOSS'], cascadeApplyPerSymbol: cascadeProtection.cascadeApplyPerSymbol, cascadeApplyPerSide: cascadeProtection.cascadeApplyPerSide } : { enabled: false },
      realTrendConfig: realTrendConfig.enabled ? { enabled: true, maxOverlapRatio: parseFloat(realTrendConfig.maxOverlapRatio)||0.6, minAvgBodyRatio: parseFloat(realTrendConfig.minAvgBodyRatio)||0.5, minStrongBodyRatio: parseFloat(realTrendConfig.minStrongBodyRatio)||0.6, minStrongBodies: parseInt(realTrendConfig.minStrongBodies,10)||2, minRangeExpansion: parseFloat(realTrendConfig.minRangeExpansion)||1.2, minPersistBars: parseInt(realTrendConfig.minPersistBars,10)||2 } : { enabled: false },
      tradingHoursConfig: { enabled: tradingHoursEnabled, noNewEntriesMinutesBeforeClose: parseInt(closeoutMins, 10) || 15 },
    };
    lastPayloadRef.current = payload;
    ticksRef.current = [];
    setShowSavePanel(false); setSaveStatus('idle');
    try {
      // Step 1: start the background session
      const res = await startTickReplayEval(payload);
      const sid = res?.data?.sessionId;
      if (!sid) throw new Error('No sessionId returned from server');
      replaySessionRef.current = sid;
      lastSaveReplaySessionIdRef.current = sid;  // preserved past completion for save pipeline
      setReplaySessionId(sid);

      // Step 2: attach SSE stream
      const response = await streamTickReplayEval(sid, ctrl.signal);
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
          if (evtName === 'error')   { setError(data.replace(/^"|"$/g, '')); setStatus('error'); return; }
          if (evtName === 'warning') { setWarnings(prev => [...prev, data.replace(/^"|"$/g, '')]); continue; }
          try {
            const parsed = JSON.parse(data);
            if      (evtName === 'init')    setInitInfo(parsed);
            else if (evtName === 'tick') {
              setLiveTicks(prev => ({ ...prev, [parsed.token]: parsed }));
            }
            else if (evtName === 'candle')  setFeed(prev => [...prev.slice(-499), parsed]);
            else if (evtName === 'summary') setSummary(parsed);
          } catch {}
        }
      }
      replaySessionRef.current = null;
      setReplaySessionId(null);
      setStatus('completed');
    } catch (err) {
      if (err.name === 'AbortError') { setStatus('idle'); return; }
      setError(err.message); setStatus('error');
    }
  }

  const isRunning    = status === 'running';
  const lastEvt      = feed[feed.length - 1];
  const closedTrades = lastEvt?.closedTrades || summary?.closedTrades || [];
  const selectedSession = sessions.find(s => s.sessionId === sessionId);

  // Warn if any configured token is not present in the selected session's tick data
  const sessionTokenSet = new Set(
    (selectedSession?.instrumentTokens || []).map(t => String(t))
  );
  const missingTokens = (() => {
    if (!selectedSession) return [];
    const missing = [];
    if (niftyToken && !sessionTokenSet.has(String(niftyToken)))
      missing.push({ label: 'NIFTY', token: niftyToken });
    cePool.filter(i => i.instrumentToken).forEach(i => {
      if (!sessionTokenSet.has(String(i.instrumentToken)))
        missing.push({ label: `CE ${i.symbol || i.instrumentToken}`, token: i.instrumentToken });
    });
    pePool.filter(i => i.instrumentToken).forEach(i => {
      if (!sessionTokenSet.has(String(i.instrumentToken)))
        missing.push({ label: `PE ${i.symbol || i.instrumentToken}`, token: i.instrumentToken });
    });
    return missing;
  })();

  const canRun = !!sessionId && !!niftyToken &&
    (cePool.some(i => i.instrumentToken) || pePool.some(i => i.instrumentToken)) &&
    missingTokens.length === 0;

  return (
    <div>
      <div className="card bt-opts-card" style={{ marginBottom: 16 }}>
        <div className="bt-live-right-tabs" style={{ marginBottom: 14 }}>
          {[['feed','Feed'],['pnl','P&L'],['portfolio','Portfolio'],['ai','AI Insights']].map(([k, l]) => (
            <button key={k} className={`bt-live-tab-btn ${rightTab === k ? 'active' : ''}`} onClick={() => setRightTab(k)}>{l}</button>
          ))}
          {feed.length > 0 && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-secondary)' }}>{feed.length} candles · {closedTrades.length} trades</span>}
        </div>

        {(lastEvt || summary) && (() => {
          const totalPnl = lastEvt?.totalPnl ?? summary?.totalPnl;
          const realizedPnl = lastEvt?.realizedPnl ?? summary?.realizedPnl;
          const unrealPnl = lastEvt?.unrealizedPnl;
          const cap = lastEvt?.capital ?? summary?.finalCapital;
          const trades = closedTrades.length;
          const wins = closedTrades.filter(t => t.pnl > 0).length;
          const losses = closedTrades.filter(t => t.pnl < 0).length;
          const winRate = trades > 0 ? (wins / trades * 100).toFixed(1) + '%' : '—';
          return (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', marginBottom: 12, padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 6, borderLeft: '3px solid ' + (totalPnl > 0 ? '#22c55e' : totalPnl < 0 ? '#ef4444' : 'var(--border)') }}>
              {[['Total P&L',totalPnl,true,true],['Realized',realizedPnl,true,false],['Unrealized',unrealPnl,true,false],['Capital',cap,false,false],['Trades',trades,false,false],['W/L',`${wins}/${losses}`,false,false],['Win Rate',winRate,false,false]].map(([lbl,val,isPnl,bold]) => (
                <div key={lbl} style={{ fontSize: 11 }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: 1 }}>{lbl}</div>
                  <div style={{ fontWeight: bold?800:700, fontSize: bold?13:11, ...(isPnl && val!=null ? pnlStyle(val) : {}) }}>{val!=null ? (typeof val==='number' ? fmt2(val) : val) : '—'}</div>
                </div>
              ))}
            </div>
          );
        })()}

        {rightTab === 'feed' && (
          <>
            {lastEvt && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginBottom: 14, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
                {[
                  ['Position',lastEvt.positionState, lastEvt.positionState==='LONG_CALL'?'#22c55e':lastEvt.positionState==='LONG_PUT'?'#ef4444':undefined],
                  ['Bias',lastEvt.niftyBias, lastEvt.niftyBias==='BULLISH'?'#22c55e':lastEvt.niftyBias==='BEARISH'?'#ef4444':undefined],
                  ['ConfBias',lastEvt.confirmedBias, lastEvt.confirmedBias==='BULLISH'?'#22c55e':lastEvt.confirmedBias==='BEARISH'?'#ef4444':undefined],
                  ['Action',lastEvt.action, lastEvt.action==='ENTERED'?'#22c55e':lastEvt.action==='EXITED'||lastEvt.action==='FORCE_CLOSED'?'#f97316':undefined],
                  ['Winner',lastEvt.winnerStrategy||(lastEvt.shadowWinner&&`(${lastEvt.shadowWinner})`),undefined],
                  ['Score',fmt2(lastEvt.winnerScore||lastEvt.shadowWinnerScore),undefined],
                  ['Gap',fmt2(lastEvt.scoreGap),undefined],
                  ['Neutral',lastEvt.neutralReason||'—',lastEvt.neutralReason?'#f59e0b':undefined],
                  ['uPnL',fmt2(lastEvt.unrealizedPnl),lastEvt.unrealizedPnl>0?'#22c55e':lastEvt.unrealizedPnl<0?'#ef4444':undefined],
                  ['rPnL',fmt2(lastEvt.realizedPnl),lastEvt.realizedPnl>0?'#22c55e':lastEvt.realizedPnl<0?'#ef4444':undefined],
                  ['Capital',fmt2(lastEvt.capital),undefined],
                  ['Block',lastEvt.blockReason||'—',lastEvt.blockReason?'#ef4444':undefined],
                ].map(([lbl,val,color]) => (
                  <div key={lbl} style={{ fontSize: 11 }}><div style={{ color: 'var(--text-secondary)' }}>{lbl}</div><div style={{ fontWeight: 700, color }}>{val||'—'}</div></div>
                ))}
              </div>
            )}
            {/* Live ticker strip — shows latest LTP per token during replay */}
            {Object.keys(liveTicks).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10, padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 6, border: '1px solid var(--border-color)' }}>
                {Object.values(liveTicks)
                  .sort((a, b) => (b.isNifty ? 1 : 0) - (a.isNifty ? 1 : 0))
                  .map(t => {
                    const sym = t.isNifty
                      ? (niftySymbol || 'NIFTY')
                      : ([...cePool, ...pePool].find(c => c.instrumentToken && parseInt(c.instrumentToken, 10) === t.token)?.symbol || t.token);
                    const isCe = !t.isNifty && cePool.some(c => c.instrumentToken && parseInt(c.instrumentToken, 10) === t.token);
                    const isPe = !t.isNifty && pePool.some(c => c.instrumentToken && parseInt(c.instrumentToken, 10) === t.token);
                    const color = t.isNifty ? '#e2e8f0' : isCe ? '#22c55e' : isPe ? '#ef4444' : '#94a3b8';
                    return (
                      <div key={t.token} style={{ fontSize: 11, minWidth: 120, padding: '4px 8px', background: 'var(--bg-primary)', borderRadius: 4, border: `1px solid ${color}33` }}>
                        <div style={{ fontWeight: 700, color, marginBottom: 2 }}>{sym}</div>
                        <div style={{ fontSize: 13, fontWeight: 800, color }}>₹{Number(t.ltp).toFixed(2)}</div>
                        {t.fOpen != null && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                            O:{Number(t.fOpen).toFixed(1)} H:{Number(t.fHigh).toFixed(1)} L:{Number(t.fLow).toFixed(1)}
                          </div>
                        )}
                        <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{new Date(t.timeMs).toLocaleTimeString('en-IN')}</div>
                      </div>
                    );
                  })}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <button type="button" className="btn-secondary btn-xs" onClick={() => downloadCSV('csv')}>Download CSV</button>
              <button type="button" className="btn-secondary btn-xs" onClick={() => downloadCSV('txt')}>Download Text</button>
              {feed.length > 0 && (
                <button type="button" className="btn-secondary btn-xs" onClick={() => setFeedExpanded(x => !x)}>
                  {feedExpanded ? 'Collapse' : 'Expand'}
                </button>
              )}
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                Session: <b style={{ color: 'var(--text-primary)' }}>{sessionId||'—'}</b>{' · '}<b style={{ color: 'var(--text-primary)' }}>{interval}</b>{niftyToken && <span> · NIFTY={niftyToken}</span>}
                {replaySessionId && <span style={{ marginLeft: 8, color: '#22c55e', fontWeight: 700 }}>● REPLAY sid={replaySessionId.slice(0, 8)}</span>}
              </span>
            </div>
            {feed.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table className="bt-table">
                  <thead><tr><th>#</th><th>Time</th><th>Phase</th><th>NIFTY</th><th>Regime</th><th>Bias</th><th>ConfBias</th><th>Winner</th><th>Score</th><th>Gap</th><th>NeutralRsn</th><th>State</th><th>Action</th><th>ExitRsn</th><th>Option</th><th>OptPx</th><th>uPnL</th><th>rPnL</th><th>Capital</th></tr></thead>
                  <tbody>
                    {(feedExpanded ? [...feed].reverse() : [...feed].reverse().slice(0, 5)).map((e, i) => (
                      <tr key={i} style={{ background:
                        e.marketPhase === 'PRE_MARKET' ? 'rgba(148,163,184,0.06)' :
                        e.marketPhase === 'CLOSING'    ? 'rgba(249,115,22,0.06)'  :
                        e.marketPhase === 'CLOSED'     ? 'rgba(239,68,68,0.06)'   :
                        e.action === 'ENTERED'         ? 'rgba(34,197,94,0.06)'   :
                        e.action === 'EXITED' || e.action === 'FORCE_CLOSED' ? 'rgba(249,115,22,0.06)' : undefined }}>
                        <td style={{ fontSize:10, color:'var(--text-muted)' }}>{e.emitted}</td>
                        <td style={{ fontSize:11, whiteSpace:'nowrap' }}>{(e.niftyTime||'').slice(11,16)}</td>
                        <td style={{ fontSize:10, color: e.marketPhase==='PRE_MARKET'?'#94a3b8':e.marketPhase==='CLOSING'?'#f97316':e.marketPhase==='CLOSED'?'#ef4444':undefined }}>{e.marketPhase||'TRADING'}</td>
                        <td>{e.niftyClose!=null?Number(e.niftyClose).toFixed(0):'—'}</td>
                        <td style={{ fontSize:10 }}>{e.regime}</td>
                        <td style={{ color:e.niftyBias==='BULLISH'?'#22c55e':e.niftyBias==='BEARISH'?'#ef4444':undefined }}>{e.niftyBias||'—'}</td>
                        <td style={{ color:e.confirmedBias==='BULLISH'?'#22c55e':e.confirmedBias==='BEARISH'?'#ef4444':undefined }}>{e.confirmedBias||'—'}</td>
                        <td style={{ fontSize:10 }}>{e.winnerStrategy||(e.shadowWinner?`(${e.shadowWinner})`:'—')}</td>
                        <td>{e.winnerScore!=null?Number(e.winnerScore).toFixed(1):'—'}</td>
                        <td>{e.scoreGap!=null?Number(e.scoreGap).toFixed(1):'—'}</td>
                        <td style={{ fontSize:10, color:'#f59e0b' }}>{e.neutralReason||'—'}</td>
                        <td style={{ fontSize:10 }}>{e.positionState}</td>
                        <td style={{ fontSize:10, color:e.action==='ENTERED'?'#22c55e':e.action==='EXITED'||e.action==='FORCE_CLOSED'?'#f97316':undefined }}>{e.action||'—'}</td>
                        <td style={{ fontSize:10 }}>{e.exitReason||'—'}</td>
                        <td style={{ fontSize:10 }}>{e.selectedTradingSymbol||'—'}</td>
                        <td>{e.optionClose!=null?Number(e.optionClose).toFixed(2):'—'}</td>
                        <td style={e.unrealizedPnl!=null?pnlStyle(e.unrealizedPnl):{}}>{fmt2(e.unrealizedPnl)}</td>
                        <td style={e.realizedPnl!=null?pnlStyle(e.realizedPnl):{}}>{fmt2(e.realizedPnl)}</td>
                        <td>{e.capital!=null?Number(e.capital).toFixed(0):'—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {feed.length===0 && !isRunning && <p style={{ fontSize:12, color:'var(--text-muted)', textAlign:'center', padding:'24px 0' }}>No data yet. Select a session and start the replay.</p>}
          </>
        )}

        {rightTab === 'pnl' && (
          summary ? (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:12 }}>
              {[['Total Trades',summary.totalTrades,false],['Realized P&L',summary.realizedPnl,true],['Final Capital',summary.finalCapital,false]].map(([lbl,val,isPnl]) => (
                <div key={lbl} style={{ padding:'12px 14px', background:'var(--bg-secondary)', borderRadius:6 }}>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:4 }}>{lbl}</div>
                  <div style={{ fontSize:18, fontWeight:800, ...(isPnl&&val!=null?pnlStyle(val):{}) }}>{val!=null?(typeof val==='number'?fmt2(val):val):'—'}</div>
                </div>
              ))}
            </div>
          ) : <p style={{ fontSize:12, color:'var(--text-muted)', textAlign:'center', padding:'24px 0' }}>Summary available after replay completes.</p>
        )}

        {rightTab === 'portfolio' && (
          closedTrades.length > 0 ? (
            <div style={{ overflowX:'auto' }}>
              <table className="bt-table">
                <thead><tr><th>Entry</th><th>Exit</th><th>Type</th><th>Symbol</th><th>Strike</th><th>Expiry</th><th>Entry Px</th><th>Exit Px</th><th>Qty</th><th>P&L</th><th>P&L%</th><th>Bars</th><th>Exit Reason</th><th>Capital After</th></tr></thead>
                <tbody>
                  {closedTrades.map((t,i) => (
                    <tr key={i}>
                      <td style={{ fontSize:11 }}>{(t.entryTime||'').slice(11,16)}</td>
                      <td style={{ fontSize:11 }}>{(t.exitTime||'').slice(11,16)}</td>
                      <td style={{ color:t.optionType==='CE'?'#22c55e':'#ef4444', fontWeight:700 }}>{t.optionType}</td>
                      <td style={{ fontSize:10 }}>{t.tradingSymbol}</td>
                      <td>{t.strike}</td><td style={{ fontSize:10 }}>{t.expiry}</td>
                      <td>{fmt2(t.entryPrice)}</td><td>{fmt2(t.exitPrice)}</td><td>{t.quantity}</td>
                      <td style={pnlStyle(t.pnl)}>{fmt2(t.pnl)}</td>
                      <td style={pnlStyle(t.pnlPct)}>{t.pnlPct!=null?`${Number(t.pnlPct).toFixed(1)}%`:'—'}</td>
                      <td>{t.barsInTrade}</td><td style={{ fontSize:10 }}>{t.exitReason}</td><td>{fmt2(t.capitalAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p style={{ fontSize:12, color:'var(--text-muted)', textAlign:'center', padding:'24px 0' }}>No closed trades yet.</p>
        )}

        {rightTab === 'ai' && (() => {
          if (!aiEnabled) return (
            <p style={{ fontSize:12, color:'var(--text-muted)', textAlign:'center', padding:'24px 0' }}>
              AI Engine is OFF for this replay. Toggle it ON in Session Settings and re-run.
            </p>
          );
          if (status !== 'completed' && aiReviews.length === 0) return (
            <p style={{ fontSize:12, color:'var(--text-muted)', textAlign:'center', padding:'24px 0' }}>
              {isRunning ? 'AI results will appear after replay completes.' : 'Run a replay with AI Engine ON to see insights.'}
            </p>
          );
          const qualColor = q => q === 'GOOD' ? '#22c55e' : q === 'BAD' ? '#ef4444' : q === 'AVERAGE' ? '#f59e0b' : '#94a3b8';
          const actColor  = a => a === 'ALLOW' ? '#22c55e' : a === 'AVOID' ? '#ef4444' : a === 'CAUTION' ? '#f59e0b' : '#94a3b8';
          return (
            <div>
              {aiReviews.length > 0 && (
                <>
                  <div style={{ fontSize:11, fontWeight:700, color:'var(--text-secondary)', marginBottom:6 }}>
                    Trade Reviews ({aiReviews.length})
                  </div>
                  <div style={{ overflowX:'auto', marginBottom:16 }}>
                    <table className="bt-table">
                      <thead>
                        <tr><th>#</th><th>Symbol</th><th>Quality</th><th>Mistake</th><th>Avoidable</th><th>P&L</th><th>Exit</th><th>Source</th><th>Summary</th></tr>
                      </thead>
                      <tbody>
                        {aiReviews.map((r, i) => (
                          <tr key={r.id ?? i}>
                            <td style={{ fontSize:10, color:'var(--text-muted)' }}>{i+1}</td>
                            <td style={{ fontSize:10 }}>{r.symbol}</td>
                            <td style={{ fontWeight:700, color:qualColor(r.quality) }}>{r.quality}</td>
                            <td style={{ fontSize:10 }}>{r.mistakeType || '—'}</td>
                            <td style={{ fontSize:11, color: r.avoidable ? '#ef4444' : '#22c55e' }}>{r.avoidable ? 'Yes' : 'No'}</td>
                            <td style={r.pnl != null ? pnlStyle(r.pnl) : {}}>{r.pnl != null ? fmt2(r.pnl) : '—'}</td>
                            <td style={{ fontSize:10 }}>{r.exitReason || '—'}</td>
                            <td style={{ fontSize:10, color:'var(--text-muted)' }}>{r.source}</td>
                            <td style={{ fontSize:10, maxWidth:220, whiteSpace:'normal', color:'var(--text-secondary)' }}>{r.summary || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {aiAdvisories.length > 0 && (
                <>
                  <div style={{ fontSize:11, fontWeight:700, color:'var(--text-secondary)', marginBottom:6 }}>
                    Entry Advisories ({aiAdvisories.length})
                  </div>
                  <div style={{ overflowX:'auto' }}>
                    <table className="bt-table">
                      <thead>
                        <tr><th>#</th><th>Symbol</th><th>Action</th><th>Risk</th><th>Confidence</th><th>Regime</th><th>Source</th><th>Summary</th></tr>
                      </thead>
                      <tbody>
                        {aiAdvisories.map((a, i) => (
                          <tr key={a.id ?? i}>
                            <td style={{ fontSize:10, color:'var(--text-muted)' }}>{i+1}</td>
                            <td style={{ fontSize:10 }}>{a.symbol}</td>
                            <td style={{ fontWeight:700, color:actColor(a.action) }}>{a.action}</td>
                            <td style={{ fontSize:10, color: a.riskLevel === 'HIGH' ? '#ef4444' : a.riskLevel === 'MEDIUM' ? '#f59e0b' : '#22c55e' }}>{a.riskLevel}</td>
                            <td style={{ fontSize:11 }}>{a.confidence != null ? `${(a.confidence*100).toFixed(0)}%` : '—'}</td>
                            <td style={{ fontSize:10 }}>{a.regime || '—'}</td>
                            <td style={{ fontSize:10, color:'var(--text-muted)' }}>{a.source}</td>
                            <td style={{ fontSize:10, maxWidth:220, whiteSpace:'normal', color:'var(--text-secondary)' }}>{a.summary || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {aiReviews.length === 0 && aiAdvisories.length === 0 && (
                <p style={{ fontSize:12, color:'var(--text-muted)', textAlign:'center', padding:'24px 0' }}>
                  No AI records found. Ensure AI Engine is running on port 9007 and re-run the replay.
                </p>
              )}
            </div>
          );
        })()}
      </div>

      <form onSubmit={handleSubmit}>
        {missingTokens.length > 0 && (
          <div style={{ marginBottom:12, padding:'8px 12px', background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.4)', borderRadius:6, fontSize:12, color:'#ef4444' }}>
            <strong>Token mismatch</strong> — the following tokens are not in the selected session and will return no data:
            <ul style={{ margin:'4px 0 0 16px', padding:0 }}>
              {missingTokens.map(({ label, token }) => (
                <li key={token}>{label} ({token})</li>
              ))}
            </ul>
            Select tokens that appear in the session's instrument list above.
          </div>
        )}
        {initInfo && (
          <div style={{ fontSize:12, color:'var(--text-secondary)', marginBottom:8, padding:'6px 10px', background:'var(--bg-secondary)', borderRadius:4 }}>
            Session loaded — <strong>{initInfo.totalTicks??'?'}</strong> ticks
            {initInfo.warmupCandles > 0 && <span> · <strong style={{ color:'#22c55e' }}>{initInfo.warmupCandles}</strong> warmup candles</span>}
            {initInfo.warmupCandles === 0 && parseInt(warmupDays,10) > 0 && <span style={{ color:'#f59e0b' }}> · warmup: cold start</span>}
          </div>
        )}
        {warnings.length > 0 && warnings.map((w, i) => (
          <div key={i} style={{ fontSize:12, color:'#f59e0b', marginBottom:6, padding:'6px 10px', background:'rgba(245,158,11,0.08)', border:'1px solid rgba(245,158,11,0.3)', borderRadius:4 }}>
            ⚠ {w}
          </div>
        ))}
        {error && <div className="error-msg" style={{ marginBottom:12 }}>{error}</div>}
        <div className="form-actions" style={{ marginBottom:16 }}>
          <button type="submit" className="btn-primary" disabled={!canRun && !isRunning}>{isRunning ? 'Stop Replay' : 'Start Tick Replay'}</button>
          <button type="button" className="btn-secondary" disabled={isRunning} onClick={() => {
            setFeed([]); setSummary(null); setError(''); setWarnings([]); setStatus('idle');
            setSessionId(''); setNiftyToken(''); setNiftySymbol('NIFTY 50'); setNiftyExchange('NSE');
            setCePool([EMPTY_OPTION_INST()]); setPePool([EMPTY_OPTION_INST()]); setStrategies(defaultStrategies());
            setDecisionCfg(DEFAULT_DECISION); setSelectionCfg(DEFAULT_SELECTION); setSwitchCfg(DEFAULT_SWITCH);
            setOptsRegimeCfg(DEFAULT_OPTS_REGIME_CONFIG); setChopRules(DEFAULT_CHOP_RULES); setTradingRules(DEFAULT_TRADING_RULES);
            setRegimeRules(DEFAULT_REGIME_RULES); setRegimeStrategyRules(DEFAULT_REGIME_STRATEGY_RULES);
            setOptsRisk(DEFAULT_OPTS_RISK); setRangeQuality(DEFAULT_RANGE_QUALITY); setTradeQuality(DEFAULT_TRADE_QUALITY);
            setTrendEntry(DEFAULT_TREND_ENTRY); setCompressionEntry(DEFAULT_COMPRESSION_ENTRY);
            setHoldConfig(DEFAULT_HOLD); setExitConfig(DEFAULT_EXIT_CONFIG); setPenaltyConfig(DEFAULT_PENALTY_CONFIG);
            setInterval('MINUTE_5'); setFromDate(''); setToDate(''); setSpeed('0'); setTradingHoursEnabled(true); setCloseoutMins('15'); setWarmupDays('5'); setBrokerName('kite'); setQuantity('0'); setCapital('100000');
            ['sma_tick_session_id','sma_tick_broker','sma_tick_warmup_days','sma_tick_nifty_token','sma_tick_nifty_symbol','sma_tick_nifty_exchange','sma_tick_ce_pool','sma_tick_pe_pool','sma_tick_interval','sma_tick_from','sma_tick_to','sma_tick_speed','sma_tick_trading_hours_on','sma_tick_closeout_mins','sma_tick_qty','sma_tick_capital','sma_tick_strategies','sma_tick_decision','sma_tick_selection','sma_tick_switch','sma_tick_regime_cfg','sma_tick_chop_rules','sma_tick_trading_rules','sma_tick_regime_rules','sma_tick_regime_strat_rules','sma_tick_risk','sma_tick_range_quality','sma_tick_trade_quality','sma_tick_trend_entry','sma_tick_compression_entry','sma_tick_hold_config','sma_tick_exit_config','sma_tick_penalty_config'].forEach(k => localStorage.removeItem(k));
          }}>Reset</button>
          {status==='completed' && <span className="badge badge-success">Completed</span>}
          {status==='error'     && <span className="badge badge-danger">Error</span>}
          {(status === 'completed' || (status === 'idle' && feed.length > 0)) && (
            <button type="button" className="btn-secondary btn-xs" style={{ marginLeft: 8 }}
              onClick={() => { setShowSavePanel(s => !s); setSaveLabel('Replay ' + (fromDate || new Date().toISOString().slice(0, 10))); setSaveStatus('idle'); setSaveError(''); }}>
              {showSavePanel ? 'Cancel Save' : 'Save to Compare'}
            </button>
          )}
          {saveStatus === 'saved' && !showSavePanel && (
            <span style={{ fontSize: 11, color: '#22c55e', marginLeft: 8 }}>Saved!</span>
          )}
        </div>

        {showSavePanel && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
            <div className="form-group" style={{ flex: '1 1 200px', marginBottom: 0 }}>
              <label style={{ fontSize: 11 }}>Label</label>
              <input type="text" value={saveLabel} onChange={e => setSaveLabel(e.target.value)}
                placeholder="e.g. Tick Replay Jan 15" maxLength={80} style={{ fontSize: 12 }} />
            </div>
            <button type="button" className="btn-primary btn-xs" style={{ flexShrink: 0, alignSelf: 'flex-end', marginBottom: 1 }}
              onClick={handleSaveToCompare} disabled={saveStatus === 'saving'}>
              {saveStatus === 'saving' ? 'Saving...' : 'Save'}
            </button>
            {saveStatus === 'error' && <span style={{ fontSize: 11, color: '#ef4444' }}>{saveError}</span>}
          </div>
        )}

        {/* ── Presets ── */}
        <div className="card bt-opts-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: presets.length > 0 || showPresetSave ? 12 : 0, flexWrap: 'wrap' }}>
            <span className="bt-section-title" style={{ marginBottom: 0 }}>Config Presets</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              {presets.length > 0 && (
                <button type="button" className="btn-secondary btn-xs" onClick={downloadAllPresets} title="Export all presets as JSON">Export All</button>
              )}
              <label className="btn-secondary btn-xs" style={{ cursor: 'pointer', marginBottom: 0 }} title="Import presets from JSON file">
                Import
                <input type="file" accept=".json" style={{ display: 'none' }} onChange={uploadPresets} />
              </label>
              <button type="button" className="btn-secondary btn-xs" onClick={() => setShowPresetSave(s => !s)} disabled={isRunning}>
                {showPresetSave ? 'Cancel' : '+ Save Current'}
              </button>
            </div>
          </div>
          {showPresetSave && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 14, padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
              <div className="form-group" style={{ flex: '1 1 160px', marginBottom: 0 }}>
                <label style={{ fontSize: 11 }}>Preset Name *</label>
                <input type="text" value={presetName} onChange={e => setPresetName(e.target.value)} placeholder="e.g. Conservative RANGING" maxLength={60} style={{ fontSize: 12 }} />
              </div>
              <div className="form-group" style={{ flex: '2 1 240px', marginBottom: 0 }}>
                <label style={{ fontSize: 11 }}>Description (optional)</label>
                <input type="text" value={presetDescription} onChange={e => setPresetDescription(e.target.value)} placeholder="e.g. High score threshold, no RANGING trades" maxLength={160} style={{ fontSize: 12 }} />
              </div>
              <button type="button" className="btn-primary btn-xs" style={{ flexShrink: 0, marginBottom: 1 }} onClick={savePreset} disabled={!presetName.trim()}>Save</button>
            </div>
          )}
          {presets.length === 0 && !showPresetSave && (
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>No presets saved yet. Click <b>+ Save Current</b> to save your active configuration as a preset.</p>
          )}
          {presets.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {presets.map(preset => (
                <div key={preset.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', background: selectedPresetId === preset.id ? 'rgba(99,102,241,0.12)' : 'var(--bg-secondary)', borderRadius: 6, border: selectedPresetId === preset.id ? '1px solid #6366f1' : '1px solid var(--border)', maxWidth: 320, minWidth: 180 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, color: selectedPresetId === preset.id ? '#818cf8' : 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {selectedPresetId === preset.id && <span style={{ marginRight: 4 }}>●</span>}{preset.name}
                    </div>
                    {preset.description && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{preset.description}</div>}
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>{new Date(preset.createdAt).toLocaleDateString()}</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
                    <button type="button" className="btn-primary btn-xs" onClick={() => applyPreset(preset)} disabled={isRunning} title="Apply this preset">Apply</button>
                    <button type="button" className="btn-secondary btn-xs" onClick={() => downloadPreset(preset)} title="Download as JSON" style={{ fontSize: 10 }}>Export</button>
                    <button type="button" className="btn-secondary btn-xs" onClick={() => deletePreset(preset.id)} title="Delete preset" style={{ fontSize: 10 }}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Session Picker ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Tick Session</span>
          <p className="bt-section-sub" style={{ marginBottom:10 }}>Select a recorded live tick session to replay through the strategy pipeline.</p>
          {sessionsLoading && <p style={{ fontSize:12, color:'var(--text-muted)' }}>Loading sessions…</p>}
          {sessionsError   && <p style={{ fontSize:12, color:'#ef4444' }}>Failed to load sessions: {sessionsError}</p>}
          {!sessionsLoading && sessions.length===0 && !sessionsError && <p style={{ fontSize:12, color:'var(--text-muted)' }}>No tick sessions found. Run a live options session first.</p>}
          {sessions.length > 0 && (
            <div className="form-group" style={{ maxWidth:560 }}>
              <label>Session</label>
              <select value={sessionId} onChange={e => setSessionId(e.target.value)} disabled={isRunning}>
                <option value="">— Select a session —</option>
                {sessions.map(s => (
                  <option key={s.sessionId} value={s.sessionId}>
                    {s.sessionId} · {s.firstTick?s.firstTick.slice(0,16).replace('T',' '):'?'} → {s.lastTick?s.lastTick.slice(0,16).replace('T',' '):'?'} · {s.tickCount?.toLocaleString()} ticks
                  </option>
                ))}
              </select>
            </div>
          )}
          {selectedSession && (
            <div style={{ marginTop:8, padding:'8px 12px', background:'var(--bg-secondary)', borderRadius:6, fontSize:11 }}>
              <div style={{ marginBottom:4 }}><b style={{ color:'var(--text-primary)' }}>Tokens in session:</b> <span style={{ color:'var(--text-secondary)' }}>{(selectedSession.instrumentTokens||[]).join(', ')||'—'}</span></div>
              <div style={{ color:'var(--text-muted)' }}>Enter the NIFTY token (e.g. 256265) and CE/PE option tokens from this list below.</div>
            </div>
          )}
        </div>

        {/* ── Session Settings ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Session Settings</span>
          <div className="bt-form-grid">
            <div className="form-group"><label>Interval</label><select value={interval} onChange={e => setInterval(e.target.value)} disabled={isRunning}>{OPT_INTERVALS.map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div className="form-group"><label title="0 = max speed, 1 = real-time, 2 = 2× faster than real time">Speed Multiplier</label><input type="number" min="0" step="0.1" value={speed} onChange={e => setSpeed(e.target.value)} disabled={isRunning} /></div>
            <div className="form-group">
              <label title="Persist candle feed to DB during replay — required if you want to save this session for Compare tab. Leave off for fast preview runs.">Save for Compare</label>
              <button type="button" className={`btn-sm ${saveForCompare ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setSaveForCompare(v => !v)} disabled={isRunning}>
                {saveForCompare ? 'ON' : 'OFF'}
              </button>
              {saveForCompare && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>Feed will be persisted — replay may be slower</span>}
            </div>
            <div className="form-group">
              <label title="Send advisory and review calls to AI Engine during replay. AI Engine must be running on port 9007.">AI Engine</label>
              <button type="button" className={`btn-sm ${aiEnabled ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setAiEnabled(v => !v)} disabled={isRunning}>
                {aiEnabled ? 'ON' : 'OFF'}
              </button>
              {aiEnabled && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>Advisory + review records saved to DB</span>}
            </div>
            <div className="form-group"><label title="Days of NIFTY candles to load before the session — primes indicators and regime (0 = cold start)">Warmup Days</label><input type="number" min="0" max="30" value={warmupDays} onChange={e => setWarmupDays(e.target.value)} disabled={isRunning} /></div>

            <div className="form-group"><label title="Broker name for warmup candle fetch">Broker (warmup)</label><select value={brokerName} onChange={e => setBrokerName(e.target.value)} disabled={isRunning}><option value="kite">Kite</option><option value="">Auto</option></select></div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ marginBottom: 0 }}>Trading Hours Filter</label>
                <button type="button" className={`btn-sm ${tradingHoursEnabled ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setTradingHoursEnabled(v => !v)} disabled={isRunning}>
                  {tradingHoursEnabled ? 'ON' : 'OFF'}
                </button>
                {tradingHoursEnabled && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    PRE_MARKET &lt;9:15 → no entries &nbsp;|&nbsp; TRADING 9:15–{
                      (() => {
                        const m = parseInt(closeoutMins, 10) || 0;
                        if (m <= 0) return '15:30';
                        const total = 15 * 60 + 30 - m;
                        return `${String(Math.floor(total / 60)).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
                      })()
                    } &nbsp;|&nbsp; CLOSING → manage only &nbsp;|&nbsp; CLOSED 15:30 → force-close
                  </span>
                )}
              </div>
              {tradingHoursEnabled && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <label style={{ marginBottom: 0, whiteSpace: 'nowrap', fontSize: 12 }} title="Stop new entries this many minutes before 15:30 (0 = no closing window)">
                    Closeout Window (min before 15:30)
                  </label>
                  <input type="number" min="0" max="60" value={closeoutMins}
                    onChange={e => setCloseoutMins(e.target.value)} disabled={isRunning}
                    style={{ width: 70 }} />
                </div>
              )}
            </div>
            <div className="form-group"><label>Quantity (lots)</label><input type="number" min="0" value={quantity} onChange={e => setQuantity(e.target.value)} disabled={isRunning} /></div>
            <div className="form-group"><label>Initial Capital (₹)</label><input type="number" min="0" value={capital} onChange={e => setCapital(e.target.value)} disabled={isRunning} /></div>
            <div className="form-group"><label title="Optional — replay only ticks from this time (IST)">From (optional)</label><input type="datetime-local" value={fromDate} onChange={e => setFromDate(e.target.value)} disabled={isRunning} /></div>
            <div className="form-group"><label title="Optional — replay only ticks up to this time (IST)">To (optional)</label><input type="datetime-local" value={toDate} onChange={e => setToDate(e.target.value)} disabled={isRunning} /></div>
          </div>
        </div>

        {/* ── Instrument Assignment ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Instrument Assignment</span>
          <p className="bt-section-sub" style={{ marginBottom: 12 }}>
            Click a token to assign it as NIFTY, CE, or PE. Tokens from the selected session are listed below.
          </p>

          {/* ── Available tokens from session ── */}
          {selectedSession && (selectedSession.instrumentTokens || []).length > 0 ? (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>Available tokens — click to assign:</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(selectedSession.instrumentTokens || []).map(tok => {
                  const tokStr   = String(tok);
                  const symName  = selectedSession.tokenSymbols?.[tok] || selectedSession.tokenSymbols?.[tokStr];
                  const isNifty  = niftyToken === tokStr;
                  const inCe     = cePool.some(i => i.instrumentToken === tokStr);
                  const inPe     = pePool.some(i => i.instrumentToken === tokStr);
                  const roleTag  = isNifty ? 'NIFTY' : inCe ? 'CE' : inPe ? 'PE' : null;
                  const color    = isNifty ? '#6366f1' : inCe ? '#22c55e' : inPe ? '#ef4444' : undefined;
                  return (
                    <div key={tok} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6, background: color ? `${color}1a` : 'var(--bg-secondary)', border: `1px solid ${color || 'var(--border)'}`, fontSize: 12 }}>
                      <div>
                        {symName && <div style={{ fontWeight: 700, color: color || 'var(--text-primary)', fontSize: 12, lineHeight: 1.2 }}>{symName}</div>}
                        <div style={{ fontSize: 10, color: color ? `${color}cc` : 'var(--text-muted)', lineHeight: 1.2 }}>{tokStr}</div>
                      </div>
                      {roleTag && <span style={{ fontSize: 10, color, fontWeight: 700, marginLeft: 2 }}>{roleTag}</span>}
                      {!isRunning && (
                        <div style={{ display: 'flex', gap: 3, marginLeft: 4 }}>
                          <button type="button" title="Set as NIFTY"
                            style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, border: '1px solid #6366f1', background: isNifty ? '#6366f1' : 'transparent', color: isNifty ? '#fff' : '#6366f1', cursor: 'pointer' }}
                            onClick={() => { if (isNifty) { setNiftyToken(''); } else { setNiftyToken(tokStr); if (symName) setNiftySymbol(symName); } }}>
                            {isNifty ? '✓ NIFTY' : 'NIFTY'}
                          </button>
                          <button type="button" title="Add to CE pool"
                            style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, border: '1px solid #22c55e', background: inCe ? '#22c55e' : 'transparent', color: inCe ? '#fff' : '#22c55e', cursor: 'pointer' }}
                            onClick={() => {
                              if (inCe) { setCePool(p => p.filter(i => i.instrumentToken !== tokStr)); }
                              else { setCePool(p => { const empty = p.find(i => !i.instrumentToken); return empty ? p.map(i => i.id === empty.id ? { ...i, instrumentToken: tokStr, symbol: symName || '', exchange: 'NFO' } : i) : [...p, { ...EMPTY_OPTION_INST(), instrumentToken: tokStr, symbol: symName || '', exchange: 'NFO' }]; }); }
                            }}>
                            {inCe ? '✓ CE' : '+ CE'}
                          </button>
                          <button type="button" title="Add to PE pool"
                            style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, border: '1px solid #ef4444', background: inPe ? '#ef4444' : 'transparent', color: inPe ? '#fff' : '#ef4444', cursor: 'pointer' }}
                            onClick={() => {
                              if (inPe) { setPePool(p => p.filter(i => i.instrumentToken !== tokStr)); }
                              else { setPePool(p => { const empty = p.find(i => !i.instrumentToken); return empty ? p.map(i => i.id === empty.id ? { ...i, instrumentToken: tokStr, symbol: symName || '', exchange: 'NFO' } : i) : [...p, { ...EMPTY_OPTION_INST(), instrumentToken: tokStr, symbol: symName || '', exchange: 'NFO' }]; }); }
                            }}>
                            {inPe ? '✓ PE' : '+ PE'}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            !selectedSession && <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Select a session above to see available tokens.</p>
          )}

          {/* ── NIFTY assignment summary ── */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>NIFTY (Decision Source)</div>
            {niftyToken ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(99,102,241,0.08)', border: '1px solid #6366f1', borderRadius: 6, fontSize: 12 }}>
                <span style={{ fontWeight: 700, color: '#818cf8' }}>Token {niftyToken}</span>
                <input type="text" value={niftySymbol} onChange={e => setNiftySymbol(e.target.value)} disabled={isRunning}
                  placeholder="Symbol (e.g. NIFTY 50)" style={{ fontSize: 11, padding: '2px 6px', flex: 1, maxWidth: 160, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }} />
                <input type="text" value={niftyExchange} onChange={e => setNiftyExchange(e.target.value)} disabled={isRunning}
                  placeholder="NSE" style={{ fontSize: 11, padding: '2px 6px', width: 60, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }} />
                {!isRunning && <button type="button" onClick={() => setNiftyToken('')} style={{ fontSize: 11, color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}>✕</button>}
              </div>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>Not assigned — click NIFTY on a token above.</p>
            )}
          </div>

          {/* ── CE pool summary ── */}
          {[{ label: 'CE Pool', pool: cePool, setPool: setCePool, color: '#22c55e' }, { label: 'PE Pool', pool: pePool, setPool: setPePool, color: '#ef4444' }].map(({ label, pool, setPool, color }) => (
            <div key={label} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
              {pool.filter(i => i.instrumentToken).length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>None assigned — click + {label.split(' ')[0]} on tokens above.</p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {pool.filter(i => i.instrumentToken).map(inst => (
                    <div key={inst.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 6, background: `${color}1a`, border: `1px solid ${color}`, fontSize: 12 }}>
                      <span style={{ fontWeight: 700, color }}>{inst.instrumentToken}</span>
                      <input type="text" value={inst.symbol} onChange={e => updatePoolInst(pool, setPool, inst.id, { symbol: e.target.value })} disabled={isRunning}
                        placeholder="Symbol" style={{ fontSize: 11, padding: '1px 5px', width: 130, borderRadius: 3, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }} />
                      {!isRunning && <button type="button" onClick={() => setPool(p => p.filter(i => i.id !== inst.id))} style={{ fontSize: 11, color: '#ef4444', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}>✕</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ── Decision Config ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Decision Config</span>
          <div className="bt-form-grid" style={{ marginTop:8 }}>
            {[['minScore','Min Score',''],['minScoreGap','Min Score Gap',''],['penaltyMinScore','Penalty Min Score',''],['maxRecentMove3','Max 3-bar Move %',''],['maxRecentMove5','Max 5-bar Move %',''],['maxAbsVwapDist','Max VWAP Dist %',''],['minBarsSinceTrade','Min Bars Since Trade',''],['chopLookback','Chop Lookback',''],['scoreFloorTrigger','Score Floor Trigger',''],['scoreFloorMin','Score Floor Min',''],['bollingerBonusThreshold','BOLLINGER Bonus Trigger',''],['bollingerBonus','BOLLINGER Bonus Pts',''],['earlyEntryRisingBars','Early Entry Rising Bars',''],['rawScoreBypassThreshold','Raw Score Bypass Threshold',''],['rawScoreBypassGap','Raw Score Bypass Gap',''],['bollingerEarlyEntryMinScore','BOLLINGER Early Entry Score','']].map(([key,lbl,hint]) => (
              <div key={key} className="form-group" title={hint}><label>{lbl}</label><input type="number" step="any" value={decisionCfg[key]} onChange={e => setDecisionCfg(p => ({ ...p, [key]: e.target.value }))} disabled={isRunning} /></div>
            ))}
            <div className="form-group"><label>Chop Filter</label><select value={decisionCfg.chopFilter?'on':'off'} onChange={e => setDecisionCfg(p => ({ ...p, chopFilter: e.target.value==='on' }))} disabled={isRunning}><option value="on">ON</option><option value="off">OFF</option></select></div>
          </div>
        </div>

        {/* ── Chop Filter Regime Rules ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Chop Filter Regime Rules</span>
            <button type="button" className={`btn-sm ${chopRules.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setChopRules(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{chopRules.enabled?'ON':'OFF'}</button>
          </div>
          {chopRules.enabled && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))', gap:12 }}>
              {[{key:'ranging',label:'RANGING',color:'#f59e0b'},{key:'trending',label:'TRENDING',color:'#22c55e'},{key:'compression',label:'COMPRESSION',color:'#0ea5e9'},{key:'volatile',label:'VOLATILE',color:'#ef4444'}].map(({ key:rk, label, color }) => (
                <div key={rk} style={{ padding:'10px 14px', background:'var(--bg-secondary)', borderRadius:7, borderLeft:`3px solid ${color}` }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                    <span style={{ fontSize:11, fontWeight:700, color }}>{label}</span>
                    <button type="button" disabled={isRunning} className={`btn-xs ${chopRules[rk].filterEnabled?'btn-primary':'btn-secondary'}`} onClick={() => setChopRules(p => ({ ...p, [rk]: { ...p[rk], filterEnabled: !p[rk].filterEnabled } }))}>{chopRules[rk].filterEnabled?'ON':'OFF'}</button>
                  </div>
                  {chopRules[rk].filterEnabled && <div className="form-group" style={{ marginBottom:0 }}><label>Flip Ratio</label><input type="number" min="0.1" max="1.0" step="0.05" disabled={isRunning} value={chopRules[rk].flipRatio} onChange={e => setChopRules(p => ({ ...p, [rk]: { ...p[rk], flipRatio: e.target.value } }))} /></div>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Market Regime Detection ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Market Regime Detection</span>
            <button type="button" className={`btn-sm ${optsRegimeCfg.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setOptsRegimeCfg(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{optsRegimeCfg.enabled?'ON':'OFF'}</button>
          </div>
          {optsRegimeCfg.enabled && (
            <div className="bt-form-grid">
              {[['adxPeriod','ADX Period',2,null,1],['atrPeriod','ATR Period',2,null,1],['adxTrendThreshold','ADX Trend Threshold',1,100,0.5],['atrVolatilePct','ATR Volatile %',0,null,0.1],['atrCompressionPct','ATR Compression %',0,null,0.05]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} max={max??undefined} step={step} value={optsRegimeCfg[key]} onChange={e => setOptsRegimeCfg(p => ({ ...p, [key]: e.target.value }))} disabled={isRunning} /></div>
              ))}
            </div>
          )}
        </div>

        {/* ── Selection Config ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Selection Config</span>
          <div className="bt-form-grid" style={{ marginTop:8 }}>
            <div className="form-group"><label>Min Premium (₹)</label><input type="number" step="any" value={selectionCfg.minPremium} onChange={e => setSelectionCfg(p => ({ ...p, minPremium: e.target.value }))} disabled={isRunning} /></div>
            <div className="form-group"><label>Max Premium (₹)</label><input type="number" step="any" value={selectionCfg.maxPremium} onChange={e => setSelectionCfg(p => ({ ...p, maxPremium: e.target.value }))} disabled={isRunning} /></div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={selectionCfg.strictPremiumBand ?? true} onChange={e => setSelectionCfg(p => ({ ...p, strictPremiumBand: e.target.checked }))} disabled={isRunning} />
              Strict Premium Band (skip entry if no candidate in range)
            </label>
          </div>
        </div>

        {/* ── Switch Config ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Switch Config</span>
          <div className="bt-form-grid" style={{ marginTop:8 }}>
            <div className="form-group"><label>Switch Confirmation Candles</label><input type="number" min="0" value={switchCfg.switchConfirmationCandles} onChange={e => setSwitchCfg(p => ({ ...p, switchConfirmationCandles: e.target.value }))} disabled={isRunning} /></div>
            <div className="form-group"><label>Max Switches Per Day</label><input type="number" min="0" value={switchCfg.maxSwitchesPerDay} onChange={e => setSwitchCfg(p => ({ ...p, maxSwitchesPerDay: e.target.value }))} disabled={isRunning} /></div>
            <div className="form-group"><label>Min Score Improvement</label><input type="number" step="any" value={switchCfg.minScoreImprovementForSwitch} onChange={e => setSwitchCfg(p => ({ ...p, minScoreImprovementForSwitch: e.target.value }))} disabled={isRunning} /></div>
          </div>
        </div>

        {/* ── Trading Rules ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Trading Rules</span>
            <button type="button" className={`btn-sm ${tradingRules.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setTradingRules(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{tradingRules.enabled?'ON':'OFF'}</button>
          </div>
          {tradingRules.enabled && (
            <div style={{ display:'flex', flexWrap:'wrap', gap:12 }}>
              {[['rangingNoTrade','No Trade in RANGING'],['volatileNoTrade','No Trade in VOLATILE'],['compressionNoTrade','No Trade in COMPRESSION'],['noSameCandleReversal','No Same-Candle Reversal']].map(([key,lbl]) => (
                <label key={key} style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, cursor:'pointer' }}><input type="checkbox" checked={!!tradingRules[key]} onChange={e => setTradingRules(p => ({ ...p, [key]: e.target.checked }))} disabled={isRunning} />{lbl}</label>
              ))}
            </div>
          )}
        </div>

        {/* ── Regime Score Rules ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Regime Score Rules</span>
            <button type="button" className={`btn-sm ${regimeRules.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setRegimeRules(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{regimeRules.enabled?'ON':'OFF'}</button>
          </div>
          {regimeRules.enabled && (
            <div className="bt-form-grid">
              {[['rangingMinScore','RANGING Min Score','#f59e0b'],['rangingMinScoreGap','RANGING Min Gap','#f59e0b'],['trendingMinScore','TRENDING Min Score','#22c55e'],['trendingMinScoreGap','TRENDING Min Gap','#22c55e'],['compressionMinScore','COMPRESSION Min Score','#0ea5e9'],['compressionMinScoreGap','COMPRESSION Min Gap','#0ea5e9']].map(([key,lbl,color]) => (
                <div key={key} className="form-group"><label style={{ color }}>{lbl}</label><input type="number" step="any" value={regimeRules[key]} onChange={e => setRegimeRules(p => ({ ...p, [key]: e.target.value }))} disabled={isRunning} /></div>
              ))}
            </div>
          )}
        </div>

        {/* ── Regime Strategy Rules ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Regime Strategy Rules</span>
            <button type="button" className={`btn-sm ${regimeStrategyRules.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setRegimeStrategyRules(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{regimeStrategyRules.enabled?'ON':'OFF'}</button>
          </div>
          {regimeStrategyRules.enabled && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))', gap:12 }}>
              {[{key:'ranging',label:'RANGING',color:'#f59e0b'},{key:'trending',label:'TRENDING',color:'#22c55e'},{key:'compression',label:'COMPRESSION',color:'#0ea5e9'},{key:'volatile',label:'VOLATILE',color:'#ef4444'}].map(({ key:rk, label, color }) => (
                <div key={rk} style={{ padding:'10px 14px', background:'var(--bg-secondary)', borderRadius:7, borderLeft:`3px solid ${color}` }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                    <span style={{ fontSize:11, fontWeight:700, color }}>{label}</span>
                    <button type="button" disabled={isRunning} className={`btn-xs ${regimeStrategyRules[rk].enabled?'btn-primary':'btn-secondary'}`} onClick={() => setRegimeStrategyRules(p => ({ ...p, [rk]: { ...p[rk], enabled: !p[rk].enabled } }))}>{regimeStrategyRules[rk].enabled?'Filter ON':'All Allowed'}</button>
                  </div>
                  {regimeStrategyRules[rk].enabled && (
                    <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                      {strategies.filter(s => s.enabled).map(s => (
                        <label key={s.strategyType} style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, cursor:'pointer' }}>
                          <input type="checkbox" checked={regimeStrategyRules[rk].allowed.includes(s.strategyType)} onChange={e => { const next = e.target.checked ? [...regimeStrategyRules[rk].allowed, s.strategyType] : regimeStrategyRules[rk].allowed.filter(x => x!==s.strategyType); setRegimeStrategyRules(p => ({ ...p, [rk]: { ...p[rk], allowed: next } })); }} disabled={isRunning} />
                          {s.strategyType.replace(/_/g,' ')}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Risk Management ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Risk Management</span>
            <button type="button" className={`btn-sm ${optsRisk.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setOptsRisk(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{optsRisk.enabled?'ON':'OFF'}</button>
          </div>
          {optsRisk.enabled && (
            <div className="bt-form-grid">
              {[['stopLossPct','Stop Loss %',0,null,0.1],['takeProfitPct','Take Profit %',0,null,0.1],['maxRiskPerTradePct','Max Risk / Trade %',0,null,0.1],['dailyLossCapPct','Daily Loss Cap %',0,null,0.1],['cooldownCandles','Cooldown Candles',0,null,1]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} step={step} value={optsRisk[key]} onChange={e => updateOptsRisk(key, e.target.value)} disabled={isRunning} /></div>
              ))}
            </div>
          )}
        </div>

        {/* ── Range Quality Filter ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Range Quality Filter</span>
            <button type="button" className={`btn-sm ${rangeQuality.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setRangeQuality(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{rangeQuality.enabled?'ON':'OFF'}</button>
          </div>
          {rangeQuality.enabled && (
            <div className="bt-form-grid">
              {[['lookbackBars','Lookback Bars',1,null,1],['minUpperTouches','Min Upper Touches',0,null,1],['minLowerTouches','Min Lower Touches',0,null,1],['bandTouchTolerancePct','Band Touch Tol %',0,null,0.01],['minRangeWidthPct','Min Range Width %',0,null,0.01],['maxRangeWidthPct','Max Range Width %',0,null,0.1],['maxDirectionalDriftPctOfRange','Max Drift Ratio',0,1,0.01],['chopFlipRatioLimit','Chop Flip Limit',0,1,0.01]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} max={max??undefined} step={step} value={rangeQuality[key]} onChange={e => updateRangeQuality(key, e.target.value)} disabled={isRunning} /></div>
              ))}
              <div className="form-group"><label>Chop Check</label><select value={rangeQuality.enableChopCheck?'on':'off'} onChange={e => setRangeQuality(p => ({ ...p, enableChopCheck: e.target.value==='on' }))} disabled={isRunning}><option value="on">ON</option><option value="off">OFF</option></select></div>
            </div>
          )}
        </div>

        {/* ── Trade Quality ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Trade Quality Filter</span>
            <button type="button" className={`btn-sm ${tradeQuality.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setTradeQuality(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{tradeQuality.enabled?'ON':'OFF'}</button>
          </div>
          {tradeQuality.enabled && (
            <div className="bt-form-grid">
              {[['strongScoreThreshold','Strong Score ≥',0,null,0.5],['normalScoreThreshold','Normal Score ≥',0,null,0.5],['weakTradeLossCooldown','Weak Loss Cooldown',0,null,1],['weakRangingMinScore','Weak RANGING Min Score',0,null,0.5],['weakRangingMinGap','Weak RANGING Min Gap',0,null,0.5],['rangingConfirmCandles','RANGING Confirm Candles',0,null,1],['trendingConfirmCandles','TRENDING Confirm Candles',0,null,1]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} step={step} value={tradeQuality[key]} onChange={e => updateTradeQuality(key, e.target.value)} disabled={isRunning} /></div>
              ))}
              <div className="form-group"><label>Block Weak in RANGING</label><select value={tradeQuality.blockWeakInRanging?'on':'off'} onChange={e => setTradeQuality(p => ({ ...p, blockWeakInRanging: e.target.value==='on' }))} disabled={isRunning}><option value="on">ON</option><option value="off">OFF</option></select></div>
            </div>
          )}
        </div>

        {/* ── Trending Entry Structure ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Trending Entry Structure</span>
            <button type="button" className={`btn-sm ${trendEntry.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setTrendEntry(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{trendEntry.enabled?'ON':'OFF'}</button>
          </div>
          {trendEntry.enabled && (
            <div className="bt-form-grid">
              {[['breakoutLookback','Breakout Lookback',1,null,1],['minBodyPct','Min Body %',0,100,1],['weakBodyPct','Weak Body %',0,100,1],['ema9Period','EMA Period',1,null,1]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} max={max??undefined} step={step} value={trendEntry[key]} onChange={e => updateTrendEntry(key, e.target.value)} disabled={isRunning} /></div>
              ))}
              <div className="form-group"><label>Score Bypass Weak Body</label><button type="button" className={`btn-sm ${trendEntry.scoreBypassWeakBody?'btn-primary':'btn-secondary'}`} onClick={() => updateTrendEntry('scoreBypassWeakBody', !trendEntry.scoreBypassWeakBody)} disabled={isRunning}>{trendEntry.scoreBypassWeakBody?'ON':'OFF'}</button></div>
              <div className="form-group"><label>Bypass Score Threshold</label><input type="number" min="0" step="1" value={trendEntry.scoreBypassWeakBodyThreshold} onChange={e => updateTrendEntry('scoreBypassWeakBodyThreshold', e.target.value)} disabled={isRunning} /></div>
            </div>
          )}
        </div>

        {/* ── Compression Entry Structure ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Compression Entry Structure</span>
            <button type="button" className={`btn-sm ${compressionEntry.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setCompressionEntry(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{compressionEntry.enabled?'ON':'OFF'}</button>
          </div>
          {compressionEntry.enabled && (
            <div className="bt-form-grid">
              {[['rangeLookback','Range Lookback',1,null,1],['longZoneMax','Long Zone Max',0,1,0.01],['shortZoneMin','Short Zone Min',0,1,0.01],['noTradeZoneMin','No-Trade Min',0,1,0.01],['noTradeZoneMax','No-Trade Max',0,1,0.01]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} max={max??undefined} step={step} value={compressionEntry[key]} onChange={e => updateCompressionEntry(key, e.target.value)} disabled={isRunning} /></div>
              ))}
              <div className="form-group"><label>Reject Breakout Candle</label><select value={compressionEntry.rejectBreakoutCandle?'on':'off'} onChange={e => setCompressionEntry(p => ({ ...p, rejectBreakoutCandle: e.target.value==='on' }))} disabled={isRunning}><option value="on">ON</option><option value="off">OFF</option></select></div>
            </div>
          )}
        </div>

        {/* ── Min Movement Filter ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Min Movement Filter</span>
            <button type="button" className={`btn-sm ${minMovementFilter.enabled?'btn-primary':'btn-secondary'}`} onClick={() => updateMinMovementFilter('enabled', !minMovementFilter.enabled)} disabled={isRunning}>{minMovementFilter.enabled?'ON':'OFF'}</button>
            <span style={{ fontSize:11, color:'#6366f1', fontWeight:600 }}>pre-trade filter</span>
          </div>
          {minMovementFilter.enabled && (
            <div className="bt-form-grid">
              {[['minMovementLookbackCandles','Lookback Candles',1,null,1],['minMovementThresholdPercent','Min Movement %',0,null,0.01]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} max={max??undefined} step={step} value={minMovementFilter[key]} onChange={e => updateMinMovementFilter(key, e.target.value)} disabled={isRunning} /></div>
              ))}
            </div>
          )}
        </div>

        {/* ── Directional Consistency Filter ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Directional Consistency Filter</span>
            <button type="button" className={`btn-sm ${directionalConsistencyFilter.enabled?'btn-primary':'btn-secondary'}`} onClick={() => updateDirectionalConsistencyFilter('enabled', !directionalConsistencyFilter.enabled)} disabled={isRunning}>{directionalConsistencyFilter.enabled?'ON':'OFF'}</button>
            <span style={{ fontSize:11, color:'#6366f1', fontWeight:600 }}>pre-trade filter</span>
          </div>
          {directionalConsistencyFilter.enabled && (
            <div className="bt-form-grid">
              {[['directionalConsistencyLookbackCandles','Lookback Candles',1,null,1],['minSameDirectionCandles','Min Same Direction',1,null,1]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} max={max??undefined} step={step} value={directionalConsistencyFilter[key]} onChange={e => updateDirectionalConsistencyFilter(key, e.target.value)} disabled={isRunning} /></div>
              ))}
            </div>
          )}
        </div>

        {/* ── Candle Strength Filter ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Candle Strength Filter</span>
            <button type="button" className={`btn-sm ${candleStrengthFilter.enabled?'btn-primary':'btn-secondary'}`} onClick={() => updateCandleStrengthFilter('enabled', !candleStrengthFilter.enabled)} disabled={isRunning}>{candleStrengthFilter.enabled?'ON':'OFF'}</button>
            <span style={{ fontSize:11, color:'#6366f1', fontWeight:600 }}>pre-trade filter</span>
          </div>
          {candleStrengthFilter.enabled && (
            <div className="bt-form-grid">
              {[['candleStrengthLookbackCandles','Lookback Candles',1,null,1],['minAverageBodyRatio','Min Avg Body Ratio',0,null,0.01],['minStrongCandlesRequired','Min Strong Candles',1,null,1]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} max={max??undefined} step={step} value={candleStrengthFilter[key]} onChange={e => updateCandleStrengthFilter(key, e.target.value)} disabled={isRunning} /></div>
              ))}
            </div>
          )}
        </div>

        {/* ── No New Trades After Time ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>No New Trades After</span>
            <button type="button" className={`btn-sm ${noNewTradesAfterTime.enabled?'btn-primary':'btn-secondary'}`} onClick={() => updateNoNewTradesAfterTime('enabled', !noNewTradesAfterTime.enabled)} disabled={isRunning}>{noNewTradesAfterTime.enabled?'ON':'OFF'}</button>
            <span style={{ fontSize:11, color:'#6366f1', fontWeight:600 }}>pre-trade filter</span>
          </div>
          {noNewTradesAfterTime.enabled && (
            <div className="bt-form-grid">
              <div className="form-group"><label>Time (HH:MM)</label><input type="time" value={noNewTradesAfterTime.noNewTradesAfterTime} onChange={e => updateNoNewTradesAfterTime('noNewTradesAfterTime', e.target.value)} disabled={isRunning} /></div>
            </div>
          )}
        </div>
        {/* -- SL Cascade Protection -- */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>SL Cascade Protection</span>
            <button type="button" className={`btn-sm ${cascadeProtection.enabled ? 'btn-primary' : 'btn-secondary'}`} onClick={() => updateCascadeProtection('enabled', !cascadeProtection.enabled)} disabled={isRunning}>{cascadeProtection.enabled?'ON':'OFF'}</button>
            <span style={{ fontSize:11, color:'#ef4444', fontWeight:600 }}>risk control</span>
          </div>
          {cascadeProtection.enabled && (
            <div className="bt-form-grid">
              {[['cascadeStopLossCount','SL Count',1,null,1],['cascadeWindowMinutes','Window (min)',1,null,1],['cascadePauseMinutes','Pause (min)',1,null,1]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} max={max??undefined} step={step} value={cascadeProtection[key]} onChange={e => updateCascadeProtection(key, e.target.value)} disabled={isRunning} /></div>
              ))}
              <div className="form-group"><label>Per Symbol</label><button type="button" className={`btn-sm ${cascadeProtection.cascadeApplyPerSymbol ? 'btn-primary' : 'btn-secondary'}`} onClick={() => updateCascadeProtection('cascadeApplyPerSymbol', !cascadeProtection.cascadeApplyPerSymbol)} disabled={isRunning}>{cascadeProtection.cascadeApplyPerSymbol?'ON':'OFF'}</button></div>
              <div className="form-group"><label>Per Side</label><button type="button" className={`btn-sm ${cascadeProtection.cascadeApplyPerSide ? 'btn-primary' : 'btn-secondary'}`} onClick={() => updateCascadeProtection('cascadeApplyPerSide', !cascadeProtection.cascadeApplyPerSide)} disabled={isRunning}>{cascadeProtection.cascadeApplyPerSide?'ON':'OFF'}</button></div>
            </div>
          )}
        </div>

        {/* ── Real Trend Validation ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Real Trend Validation</span>
            <button type="button" className={`btn-sm ${realTrendConfig.enabled ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setRealTrendConfig(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{realTrendConfig.enabled?'ON':'OFF'}</button>
            <span style={{ fontSize:11, color:'#f59e0b', fontWeight:600 }}>fake trend filter</span>
          </div>
          {realTrendConfig.enabled && (
            <div className="bt-form-grid">
              {[['maxOverlapRatio','Max Overlap Ratio',0,null,0.01],['minAvgBodyRatio','Min Avg Body',0,null,0.01],['minStrongBodyRatio','Min Body Ratio',0,null,0.01],['minStrongBodies','Strong Bodies',1,null,1],['minRangeExpansion','Range Expansion',0,null,0.01],['minPersistBars','Persist Bars',1,null,1]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} max={max??undefined} step={step} value={realTrendConfig[key]} onChange={e => setRealTrendConfig(p => ({ ...p, [key]: e.target.value }))} disabled={isRunning} /></div>
              ))}
            </div>
          )}
        </div>

        {/* ── Hold Config ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Minimum Hold Period</span>
            <button type="button" className={`btn-sm ${holdConfig.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setHoldConfig(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{holdConfig.enabled?'ON':'OFF'}</button>
          </div>
          {holdConfig.enabled && (
            <div className="bt-form-grid">
              {[['defaultMinHoldBars','Default Min Hold',0,null,1],['rangingMinHoldBars','RANGING Min Hold',0,null,1],['trendingMinHoldBars','TRENDING Min Hold',0,null,1],['strongOppositeScore','Strong Opp Score',0,null,0.5],['persistentExitBars','Persistent Exit Bars',0,null,1]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} step={step} value={holdConfig[key]} onChange={e => updateHoldConfig(key, e.target.value)} disabled={isRunning} /></div>
              ))}
            </div>
          )}
        </div>

        {/* ── Exit System ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Exit System</span>
            <button type="button" className={`btn-sm ${exitConfig.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setExitConfig(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{exitConfig.enabled?'ON':'OFF'}</button>
          </div>
          {exitConfig.enabled && (
            <div className="bt-form-grid">
              {[['hardStopPct','Hard Stop %',0,null,0.1],['holdZonePct','Hold Zone %',0,null,0.1],['lock1TriggerPct','Lock1 Trigger %',0,null,0.1],['lock1FloorPct','Lock1 Floor %',0,null,0.1],['lock2TriggerPct','Lock2 Trigger %',0,null,0.1],['lock2FloorPct','Lock2 Floor %',0,null,0.1],['trailTriggerPct','Trail Trigger %',0,null,0.1],['trailFactor','Trail Factor',0,1,0.05],['firstMoveBars','First Move Bars',0,null,1],['firstMoveLockPct','First Move Lock %',0,null,0.1],['structureLookback','Structure Lookback',1,null,1],['scoreDropFactor','Score Drop Factor',0,null,0.1],['scoreAbsoluteMin','Score Abs Min',0,null,0.5],['strongExitScore','Strong Exit Score',0,null,0.5],['trendStrongModeThresholdPct','Trend Strong Mode %',0,null,0.1],['maxBarsNoImprovement','Max Bars No Improvement',0,null,1],['stagnationBars','Stagnation Bars',0,null,1],['maxBarsRanging','Max Bars RANGING',0,null,1],['maxBarsDeadTrade','Max Bars Dead Trade',0,null,1],['deadTradePnlPct','Dead Trade PnL %',0,null,0.1],['noHopeThresholdPct','No-Hope Threshold %',0,null,0.1],['noHopeBars','No-Hope Bars',0,null,1],['breakevenTriggerPct','Breakeven Trigger %',0,null,0.1],['breakevenOffsetPct','Breakeven Offset %',0,null,0.1]].map(([key,lbl,min,max,step]) => (
                <div key={key} className="form-group"><label>{lbl}</label><input type="number" min={min} max={max??undefined} step={step} value={exitConfig[key]} onChange={e => updateExitConfig(key, e.target.value)} disabled={isRunning} /></div>
              ))}
              <div className="form-group"><label>Bias Exit</label><select value={exitConfig.biasExitEnabled?'on':'off'} onChange={e => setExitConfig(p => ({ ...p, biasExitEnabled: e.target.value==='on' }))} disabled={isRunning}><option value="on">ON</option><option value="off">OFF</option></select></div>
              <div className="form-group"><label>Breakeven</label><select value={exitConfig.breakevenProtectionEnabled?'on':'off'} onChange={e => setExitConfig(p => ({ ...p, breakevenProtectionEnabled: e.target.value==='on' }))} disabled={isRunning}><option value="on">ON</option><option value="off">OFF</option></select></div>
            </div>
          )}
        </div>

        {/* ── Penalty Config ── */}
        <div className="card bt-opts-card">
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:6 }}>
            <span className="bt-section-title" style={{ marginBottom:0 }}>Penalty Config</span>
            <button type="button" className={`btn-sm ${penaltyConfig.enabled?'btn-primary':'btn-secondary'}`} onClick={() => setPenaltyConfig(p => ({ ...p, enabled: !p.enabled }))} disabled={isRunning}>{penaltyConfig.enabled?'ON':'OFF'}</button>
          </div>
          {penaltyConfig.enabled && (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(240px, 1fr))', gap:10 }}>
              {[{key:'reversalEnabled',maxKey:'reversalMax',label:'Reversal',type:'max'},{key:'overextensionEnabled',maxKey:'overextensionMax',label:'Overextension',type:'max'},{key:'sameColorEnabled',maxKey:'sameColorMax',label:'Same Color',type:'max'},{key:'mismatchEnabled',maxKey:'mismatchScale',label:'Mismatch',type:'scale'},{key:'volatileOptionEnabled',maxKey:'volatileOptionPenalty',label:'Volatile Option',type:'penalty'},{key:'movePenaltyEnabled',maxKey:'movePenalty',label:'Move',type:'penalty'},{key:'vwapPenaltyEnabled',maxKey:'vwapPenalty',label:'VWAP',type:'penalty'},{key:'chopPenaltyEnabled',maxKey:'chopPenalty',label:'Chop',type:'penalty'},{key:'rangeDriftingEnabled',maxKey:'rangeDriftingPenalty',label:'Range Drifting',type:'penalty'},{key:'rangePoorStructureEnabled',maxKey:'rangePoorStructurePenalty',label:'Range Poor Str',type:'penalty'},{key:'rangeChoppyEnabled',maxKey:'rangeChoppyPenalty',label:'Range Choppy',type:'penalty'},{key:'rangeSizeEnabled',maxKey:'rangeSizePenalty',label:'Range Size',type:'penalty'}].map(({ key, maxKey, label, type }) => (
                <div key={key} style={{ padding:'8px 12px', background:'var(--bg-secondary)', borderRadius:6 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                    <button type="button" disabled={isRunning} className={`btn-xs ${penaltyConfig[key]?'btn-primary':'btn-secondary'}`} onClick={() => updatePenaltyConfig(key, !penaltyConfig[key])}>{penaltyConfig[key]?'ON':'OFF'}</button>
                    <span style={{ fontSize:12, fontWeight:700 }}>{label}</span>
                  </div>
                  {penaltyConfig[key] && <div className="form-group" style={{ marginBottom:0 }}><label style={{ fontSize:11 }}>{type==='max'?'Max':type==='scale'?'Scale':'Penalty'}</label><input type="number" step="any" value={penaltyConfig[maxKey]} onChange={e => updatePenaltyConfig(maxKey, e.target.value)} disabled={isRunning} /></div>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Strategies ── */}
        <div className="card bt-opts-card">
          <span className="bt-section-title">Strategies</span>
          <div className="bt-variants-grid">
            {strategies.map((s, idx) => {
              const color = STRATEGY_COLORS[s.strategyType] || '#6366f1';
              const paramDefs = PARAM_DEFS[s.strategyType] || [];
              return (
                <div key={s.strategyType} className={`bt-variant-card ${!s.enabled?'bt-variant-disabled':''}`} style={{ '--variant-color': color }}>
                  <div className="bt-variant-header">
                    <label className="bt-variant-toggle">
                      <input type="checkbox" checked={s.enabled} onChange={e => updateStrategy(idx, { enabled: e.target.checked })} disabled={isRunning} />
                      <span className="bt-variant-index" style={{ background: color }}>{s.strategyType.replace(/_/g,' ')}</span>
                    </label>
                  </div>
                  {s.enabled && paramDefs.length > 0 && (
                    <div className="bt-params-block">
                      {paramDefs.map(def => (
                        <div key={def.key} className="bt-param-row">
                          <label className="bt-param-label" title={def.hint}>{def.label}</label>
                          <input type="number" className="bt-param-input" value={s.parameters[def.key]||''} onChange={e => updateStratParam(idx, def.key, e.target.value)} placeholder={def.placeholder} disabled={isRunning} />
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

// ─── Tab: Session Compare ─────────────────────────────────────────────────────

function SessionCompare() {
  const [sessions,     setSessions]     = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [loadError,    setLoadError]    = useState('');
  const [filterType,   setFilterType]   = useState('');
  const [filterUserId, setFilterUserId] = useState('');
  const [selA,         setSelA]         = useState(null);
  const [selB,         setSelB]         = useState(null);
  const [resultA,      setResultA]      = useState(null);
  const [resultB,      setResultB]      = useState(null);
  const [comparing,    setComparing]    = useState(false);
  const [compareErr,   setCompareErr]   = useState('');
  const [deleting,     setDeleting]     = useState(null);
  const [ticksA,           setTicksA]           = useState([]);
  const [ticksB,           setTicksB]           = useState([]);
  const [ticksLoading,     setTicksLoading]     = useState(false);
  const [compareTab,       setCompareTab]       = useState('summary');
  const [skipPartialBucket, setSkipPartialBucket] = useState(true);
  const [ticksMeta,        setTicksMeta]        = useState({ truncatedA: false, truncatedB: false, totalA: 0, totalB: 0 });

  // ── Session management ────────────────────────────────────────────────────
  function loadSessions(userId, type) {
    setLoading(true); setLoadError('');
    listSessionResults(userId || undefined, type || undefined)
      .then(res => setSessions(res?.data ?? []))
      .catch(e => setLoadError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => { loadSessions(filterUserId, filterType); }, []);

  async function handleCompare() {
    if (!selA || !selB) return;
    setComparing(true); setCompareErr(''); setResultA(null); setResultB(null);
    setTicksA([]); setTicksB([]);
    try {
      const [rA, rB] = await Promise.all([getSessionResult(selA), getSessionResult(selB)]);
      const dA = rA?.data ?? null;
      const dB = rB?.data ?? null;
      setResultA(dA);
      setResultB(dB);

      // Fetch ticks from Data Engine using stored dataEngineSessionId
      const smA = (() => { try { return dA?.summaryJson ? JSON.parse(dA.summaryJson) : null; } catch { return null; } })();
      const smB = (() => { try { return dB?.summaryJson ? JSON.parse(dB.summaryJson) : null; } catch { return null; } })();
      const sidA = smA?.dataEngineSessionId;
      const sidB = smB?.dataEngineSessionId;
      console.log('[compare] A sessionId:', selA, '| dataEngineSessionId:', sidA, '| summaryKeys:', smA ? Object.keys(smA) : null);
      console.log('[compare] B sessionId:', selB, '| dataEngineSessionId:', sidB, '| summaryKeys:', smB ? Object.keys(smB) : null);
      if (sidA || sidB) {
        setTicksLoading(true);
        setTicksMeta({ truncatedA: false, truncatedB: false, totalA: 0, totalB: 0 });
        const fetchTicks = (sid) => sid
          ? querySessionTicksForCompare(sid, null, null, null)
              .then(r => {
                const page = r?.data ?? { ticks: [], truncated: false, returnedCount: 0, totalCount: 0 };
                console.log(`[compare] ${sid}: returned=${page.returnedCount} total=${page.totalCount} truncated=${page.truncated}`);
                return page;
              })
              .catch(e => { console.warn(`[compare] ticks fetch failed for ${sid}:`, e.message); return { ticks: [], truncated: false, returnedCount: 0, totalCount: 0 }; })
          : Promise.resolve({ ticks: [], truncated: false, returnedCount: 0, totalCount: 0 });

        const [pageA, pageB] = await Promise.all([fetchTicks(sidA), fetchTicks(sidB)]);
        console.log('[compare] ticksA count:', pageA.ticks.length, '| ticksB count:', pageB.ticks.length);
        // Normalise to { token, ltp, timeMs } format the comparison logic expects
        setTicksA(pageA.ticks.map(t => ({ token: String(t.instrumentToken), ltp: t.ltp, timeMs: t.tickTimeMs })));
        setTicksB(pageB.ticks.map(t => ({ token: String(t.instrumentToken), ltp: t.ltp, timeMs: t.tickTimeMs })));
        setTicksMeta({ truncatedA: pageA.truncated, truncatedB: pageB.truncated, totalA: pageA.totalCount, totalB: pageB.totalCount });
        setTicksLoading(false);
      } else {
        console.warn('[compare] no dataEngineSessionId in either session — tick comparison skipped');
      }
    } catch (e) { setCompareErr(e.message); }
    finally { setComparing(false); }
  }

  async function handleDelete(sid) {
    setDeleting(sid);
    try {
      await deleteSessionResult(sid);
      setSessions(prev => prev.filter(s => s.sessionId !== sid));
      if (selA === sid) setSelA(null);
      if (selB === sid) setSelB(null);
      if (resultA?.sessionId === sid) setResultA(null);
      if (resultB?.sessionId === sid) setResultB(null);
    } catch {}
    setDeleting(null);
  }

  // ── Parse stored JSON blobs (memoized — avoid re-parsing on every tab switch) ─
  const feedA   = useMemo(() => { try { return resultA?.feedJson         ? JSON.parse(resultA.feedJson)         : []; } catch { return []; } }, [resultA]);
  const feedB   = useMemo(() => { try { return resultB?.feedJson         ? JSON.parse(resultB.feedJson)         : []; } catch { return []; } }, [resultB]);
  const tradesA = useMemo(() => { try { return resultA?.closedTradesJson ? JSON.parse(resultA.closedTradesJson) : []; } catch { return []; } }, [resultA]);
  const tradesB = useMemo(() => { try { return resultB?.closedTradesJson ? JSON.parse(resultB.closedTradesJson) : []; } catch { return []; } }, [resultB]);
  const sumA    = useMemo(() => { try { return resultA?.summaryJson      ? JSON.parse(resultA.summaryJson)      : null; } catch { return null; } }, [resultA]);
  const sumB    = useMemo(() => { try { return resultB?.summaryJson      ? JSON.parse(resultB.summaryJson)      : null; } catch { return null; } }, [resultB]);
  const cfgA    = useMemo(() => { try { return resultA?.configJson       ? JSON.parse(resultA.configJson)       : null; } catch { return null; } }, [resultA]);
  const cfgB    = useMemo(() => { try { return resultB?.configJson       ? JSON.parse(resultB.configJson)       : null; } catch { return null; } }, [resultB]);
  // ticksA / ticksB are state, fetched in handleCompare from Data Engine

  // ── Comparison tolerances — tune to adjust matching sensitivity ───────────
  const TICK_TOL_MS    = 2000;          // ±2 s  : network/replay jitter
  const TRADE_TOL_MS   = 60 * 1000;    // ±1 min: tight — replay/live entries should be near-identical
  const OHLC_TOL       = 0.05;         // 5 paise: price rounding noise
  const SCORE_TOL      = 0.5;          // 0.5 pt: floating-point noise in scores

  // ── 1. Tick comparison ───────────────────────────────────────────────────
  // Strategy: group by token, sort by timeMs, greedy nearest-neighbour match
  // within TICK_TOL_MS. Each tick is consumed at most once.
  const tickComparison = useMemo(() => {
    if (!ticksA.length && !ticksB.length) return { rows: [], stats: {}, matchPct: null };
    const groupA = new Map(), groupB = new Map();
    for (const t of ticksA) { if (!groupA.has(t.token)) groupA.set(t.token, []); groupA.get(t.token).push(t); }
    for (const t of ticksB) { if (!groupB.has(t.token)) groupB.set(t.token, []); groupB.get(t.token).push(t); }
    const allTokens = new Set([...groupA.keys(), ...groupB.keys()]);
    const rows = [], stats = {};
    let totalMatched = 0;
    for (const token of allTokens) {
      const as = [...(groupA.get(token) || [])].sort((x,y) => x.timeMs - y.timeMs);
      const bs = [...(groupB.get(token) || [])].sort((x,y) => x.timeMs - y.timeMs);
      const usedB = new Set();
      const tokenRows = [];
      for (const ta of as) {
        let bestBi = -1, bestDiff = Infinity;
        for (let bi = 0; bi < bs.length; bi++) {
          if (usedB.has(bi)) continue;
          const diff = Math.abs(bs[bi].timeMs - ta.timeMs);
          if (diff <= TICK_TOL_MS && diff < bestDiff) { bestDiff = diff; bestBi = bi; }
          if (bs[bi].timeMs > ta.timeMs + TICK_TOL_MS) break;
        }
        if (bestBi >= 0) {
          usedB.add(bestBi);
          const tb = bs[bestBi];
          const priceDiff = tb.ltp - ta.ltp;
          tokenRows.push({ matchType: Math.abs(priceDiff) > OHLC_TOL ? 'PRICE_MISMATCH' : 'MATCHED',
            token, a: ta, b: tb, timeDiffMs: tb.timeMs - ta.timeMs, priceDiff });
          totalMatched++;
        } else {
          tokenRows.push({ matchType: 'A_ONLY', token, a: ta, b: null, timeDiffMs: null, priceDiff: null });
        }
      }
      for (let bi = 0; bi < bs.length; bi++) {
        if (!usedB.has(bi)) tokenRows.push({ matchType: 'B_ONLY', token, a: null, b: bs[bi], timeDiffMs: null, priceDiff: null });
      }
      stats[token] = {
        token,
        aCount: as.length, bCount: bs.length,
        matched:      tokenRows.filter(r => r.matchType === 'MATCHED').length,
        priceMismatch:tokenRows.filter(r => r.matchType === 'PRICE_MISMATCH').length,
        aOnly:        tokenRows.filter(r => r.matchType === 'A_ONLY').length,
        bOnly:        tokenRows.filter(r => r.matchType === 'B_ONLY').length,
      };
      rows.push(...tokenRows);
    }
    rows.sort((x,y) => (x.a?.timeMs || x.b?.timeMs || 0) - (y.a?.timeMs || y.b?.timeMs || 0));
    const tot = ticksA.length + ticksB.length;
    const matchPct = tot > 0 ? (totalMatched * 2 / tot * 100).toFixed(1) : null;
    return { rows, stats, matchPct };
  }, [ticksA, ticksB]);

  // ── 2. Candle comparison ─────────────────────────────────────────────────
  // Strategy: exact lookup by niftyTime ISO string. OHLC compared with OHLC_TOL.
  // Partial start buckets: first candle of A or B that the other session doesn't have
  // (caused by LIVE attaching mid-bucket). Marked PARTIAL_START_BUCKET for optional exclusion.
  const candleComparison = useMemo(() => {
    if (!feedA.length && !feedB.length) return { rows: [], stats: null, partialBuckets: new Set() };
    const mapA = new Map(feedA.map(e => [e.niftyTime, e]));
    const mapB = new Map(feedB.map(e => [e.niftyTime, e]));
    const allTimes = [...new Set([...feedA.map(e => e.niftyTime), ...feedB.map(e => e.niftyTime)])].sort();
    // Detect partial start buckets: first candle in A not in B, or vice versa
    const partialBuckets = new Set();
    const firstA = feedA.length ? feedA[0].niftyTime : null;
    const firstB = feedB.length ? feedB[0].niftyTime : null;
    if (firstA && !mapB.has(firstA)) partialBuckets.add(firstA);
    if (firstB && !mapA.has(firstB) && firstB !== firstA) partialBuckets.add(firstB);
    const rows = allTimes.map(t => {
      const a = mapA.get(t) || null, b = mapB.get(t) || null;
      if (!a) return { time: t, a: null, b, matchType: partialBuckets.has(t) ? 'PARTIAL_START_BUCKET' : 'B_ONLY', divergedFields: [] };
      if (!b) return { time: t, a, b: null, matchType: partialBuckets.has(t) ? 'PARTIAL_START_BUCKET' : 'A_ONLY', divergedFields: [] };
      const df = [];
      if (Math.abs((a.niftyOpen  ||0)-(b.niftyOpen  ||0)) > OHLC_TOL) df.push('open');
      if (Math.abs((a.niftyHigh  ||0)-(b.niftyHigh  ||0)) > OHLC_TOL) df.push('high');
      if (Math.abs((a.niftyLow   ||0)-(b.niftyLow   ||0)) > OHLC_TOL) df.push('low');
      if (Math.abs((a.niftyClose ||0)-(b.niftyClose ||0)) > OHLC_TOL) df.push('close');
      if ((a.niftyVolume||0) !== (b.niftyVolume||0))                   df.push('volume');
      return { time: t, a, b, matchType: df.length === 0 ? 'EXACT' : 'OHLC_MISMATCH', divergedFields: df };
    });
    // Stats computed over rows that are not excluded by skipPartialBucket filter
    const scored = skipPartialBucket ? rows.filter(r => r.matchType !== 'PARTIAL_START_BUCKET') : rows;
    const exact      = scored.filter(r => r.matchType === 'EXACT').length;
    const mismatch   = scored.filter(r => r.matchType === 'OHLC_MISMATCH').length;
    const aOnly      = scored.filter(r => r.matchType === 'A_ONLY').length;
    const bOnly      = scored.filter(r => r.matchType === 'B_ONLY').length;
    const partial    = rows.filter(r => r.matchType === 'PARTIAL_START_BUCKET').length;
    const total = scored.length;
    // aCount/bCount = unique niftyTime buckets per feed (not raw feed entry count)
    return { rows, scored, partialBuckets, stats: { total, exact, mismatch, aOnly, bOnly, partial, aCount: mapA.size, bCount: mapB.size, matchPct: total > 0 ? (exact/total*100).toFixed(1) : null } };
  }, [feedA, feedB, skipPartialBucket]);

  // ── 3. Signal comparison ─────────────────────────────────────────────────
  // Strategy: same time-key as candle comparison. Compares decision-layer fields.
  const signalComparison = useMemo(() => {
    if (!feedA.length && !feedB.length) return { rows: [], stats: null };
    const mapA = new Map(feedA.map(e => [e.niftyTime, e]));
    const mapB = new Map(feedB.map(e => [e.niftyTime, e]));
    const allTimes = [...new Set([...feedA.map(e => e.niftyTime), ...feedB.map(e => e.niftyTime)])].sort();
    const { partialBuckets } = candleComparison;
    const rows = allTimes.map(t => {
      const a = mapA.get(t) || null, b = mapB.get(t) || null;
      if (!a) return { time: t, a: null, b, matchType: partialBuckets.has(t) ? 'PARTIAL_START_BUCKET' : 'B_ONLY', divergedFields: [] };
      if (!b) return { time: t, a, b: null, matchType: partialBuckets.has(t) ? 'PARTIAL_START_BUCKET' : 'A_ONLY', divergedFields: [] };
      const df = [];
      if (a.regime         !== b.regime)         df.push('regime');
      if (a.confirmedBias  !== b.confirmedBias)  df.push('confirmedBias');
      if (a.winnerStrategy !== b.winnerStrategy) df.push('winnerStrategy');
      if (Math.abs((a.winnerScore||0)-(b.winnerScore||0)) > SCORE_TOL) df.push('winnerScore');
      if (a.action         !== b.action)         df.push('action');
      if (a.positionState  !== b.positionState)  df.push('positionState');
      if (a.exitReason     !== b.exitReason)     df.push('exitReason');
      return { time: t, a, b, matchType: df.length === 0 ? 'MATCHED' : 'SIGNAL_MISMATCH', divergedFields: df };
    });
    const scored  = skipPartialBucket ? rows.filter(r => r.matchType !== 'PARTIAL_START_BUCKET') : rows;
    const matched    = scored.filter(r => r.matchType === 'MATCHED').length;
    const mismatch   = scored.filter(r => r.matchType === 'SIGNAL_MISMATCH').length;
    const aOnly      = scored.filter(r => r.matchType === 'A_ONLY').length;
    const bOnly      = scored.filter(r => r.matchType === 'B_ONLY').length;
    const total = scored.length;
    return { rows, scored, stats: { total, matched, mismatch, aOnly, bOnly, aCount: mapA.size, bCount: mapB.size, matchPct: total > 0 ? (matched/total*100).toFixed(1) : null } };
  }, [feedA, feedB, candleComparison.partialBuckets, skipPartialBucket]);

  // ── 4. Trade comparison ──────────────────────────────────────────────────
  // Strategy: greedy nearest entryTime match within TRADE_TOL_MS. Each trade consumed once.
  // Flags entryPriceMismatch / exitPriceMismatch / exitReasonMismatch on BOTH rows.
  const tradeComparison = useMemo(() => {
    if (!tradesA.length && !tradesB.length) return { rows: [], stats: null };
    const usedB = new Set();
    const rows = [];
    for (const ta of tradesA) {
      const taMs = new Date(ta.entryTime).getTime();
      let bestIdx = -1, bestDiff = Infinity;
      tradesB.forEach((tb, i) => {
        if (usedB.has(i)) return;
        const diff = Math.abs(new Date(tb.entryTime).getTime() - taMs);
        if (diff <= TRADE_TOL_MS && diff < bestDiff) { bestDiff = diff; bestIdx = i; }
      });
      if (bestIdx >= 0) {
        usedB.add(bestIdx);
        const tb = tradesB[bestIdx];
        const entryPriceMismatch = Math.abs((ta.entryPrice||0) - (tb.entryPrice||0)) > 0.5;
        const exitPriceMismatch  = ta.exitPrice != null && tb.exitPrice != null
                                    && Math.abs(ta.exitPrice - tb.exitPrice) > 0.5;
        const exitReasonMismatch = ta.exitReason !== tb.exitReason;
        const pnlDiff            = (tb.pnl||0) - (ta.pnl||0);
        rows.push({ matchType: 'BOTH', a: ta, b: tb,
                    entryPriceMismatch, exitPriceMismatch, exitReasonMismatch, pnlDiff });
      } else {
        rows.push({ matchType: 'A_ONLY', a: ta, b: null });
      }
    }
    tradesB.forEach((tb, i) => { if (!usedB.has(i)) rows.push({ matchType: 'B_ONLY', a: null, b: tb }); });
    rows.sort((x,y) => ((x.a?.entryTime||x.b?.entryTime||'') > (y.a?.entryTime||y.b?.entryTime||'')) ? 1 : -1);
    const both         = rows.filter(r => r.matchType === 'BOTH').length;
    const aOnly        = rows.filter(r => r.matchType === 'A_ONLY').length;
    const bOnly        = rows.filter(r => r.matchType === 'B_ONLY').length;
    const priceMismatch = rows.filter(r => r.matchType === 'BOTH' && (r.entryPriceMismatch || r.exitPriceMismatch)).length;
    const tot = tradesA.length + tradesB.length;
    return { rows, stats: { total: rows.length, both, aOnly, bOnly, priceMismatch,
                            matchPct: tot > 0 ? (both*2/tot*100).toFixed(1) : null } };
  }, [tradesA, tradesB]);

  // ── 5. Config diff ───────────────────────────────────────────────────────
  const configDiff = useMemo(() => {
    if (!cfgA || !cfgB) return [];
    function flat(obj, prefix) {
      return Object.entries(obj || {}).flatMap(([k, v]) => {
        const key = prefix ? `${prefix}.${k}` : k;
        return (v && typeof v === 'object' && !Array.isArray(v)) ? flat(v, key) : [{ key, val: v }];
      });
    }
    const mA = Object.fromEntries(flat(cfgA, '').map(e => [e.key, e.val]));
    const mB = Object.fromEntries(flat(cfgB, '').map(e => [e.key, e.val]));
    return [...new Set([...Object.keys(mA), ...Object.keys(mB)])]
      .filter(k => String(mA[k] ?? '') !== String(mB[k] ?? ''))
      .map(k => ({ key: k, valA: mA[k], valB: mB[k] }))
      .sort((x,y) => x.key.localeCompare(y.key));
  }, [cfgA, cfgB]);

  // ── 6. Divergence trace ──────────────────────────────────────────────────
  // Walks the comparison chain (TICK → CANDLE → SIGNAL → TRADE) and reports
  // the first point of divergence at each stage that was detected.
  // Partial-start buckets are excluded when skipPartialBucket is on.
  const divergenceTrace = useMemo(() => {
    const stages = [];
    const firstTickDiv = tickComparison.rows.find(r => r.matchType !== 'MATCHED');
    if (firstTickDiv) stages.push({
      stage: 'TICK', seqNo: 1,
      time: new Date(firstTickDiv.a?.timeMs || firstTickDiv.b?.timeMs || 0).toISOString(),
      matchType: firstTickDiv.matchType, token: String(firstTickDiv.token),
      explanation: firstTickDiv.matchType === 'A_ONLY'        ? 'Session A received a tick that session B did not have' :
                   firstTickDiv.matchType === 'B_ONLY'        ? 'Session B had a tick not seen in session A' :
                   `LTP diverged by ${Number(firstTickDiv.priceDiff||0).toFixed(2)}`,
    });
    // Candle: skip partial-start buckets in trace when toggle is on
    const candleRows = skipPartialBucket
      ? candleComparison.rows.filter(r => r.matchType !== 'PARTIAL_START_BUCKET')
      : candleComparison.rows;
    const firstCandleDiv = candleRows.find(r => r.matchType !== 'EXACT');
    if (firstCandleDiv) stages.push({
      stage: 'CANDLE', seqNo: 2, time: firstCandleDiv.time,
      matchType: firstCandleDiv.matchType, token: 'NIFTY',
      explanation: firstCandleDiv.matchType === 'A_ONLY'             ? 'Candle exists only in session A feed' :
                   firstCandleDiv.matchType === 'B_ONLY'             ? 'Candle exists only in session B feed' :
                   firstCandleDiv.matchType === 'PARTIAL_START_BUCKET' ? 'Startup alignment gap — one session missed the partial first bucket' :
                   `OHLC fields differ: ${firstCandleDiv.divergedFields.join(', ')}`,
    });
    const signalRows = skipPartialBucket
      ? signalComparison.rows.filter(r => r.matchType !== 'PARTIAL_START_BUCKET')
      : signalComparison.rows;
    const firstSignalDiv = signalRows.find(r => r.matchType !== 'MATCHED');
    if (firstSignalDiv) stages.push({
      stage: 'SIGNAL', seqNo: 3, time: firstSignalDiv.time,
      matchType: firstSignalDiv.matchType, token: 'NIFTY',
      explanation: firstSignalDiv.matchType === 'A_ONLY'             ? 'Signal exists only in session A' :
                   firstSignalDiv.matchType === 'B_ONLY'             ? 'Signal exists only in session B' :
                   firstSignalDiv.matchType === 'PARTIAL_START_BUCKET' ? 'Startup alignment gap in signal layer' :
                   `Decision fields differ: ${firstSignalDiv.divergedFields.join(', ')}`,
    });
    const firstTradeDiv = tradeComparison.rows.find(r => r.matchType !== 'BOTH');
    if (firstTradeDiv) stages.push({
      stage: 'TRADE', seqNo: 4,
      time: firstTradeDiv.a?.entryTime || firstTradeDiv.b?.entryTime || '—',
      matchType: firstTradeDiv.matchType,
      token: firstTradeDiv.a?.tradingSymbol || firstTradeDiv.b?.tradingSymbol || '—',
      explanation: firstTradeDiv.matchType === 'A_ONLY' ? 'Trade taken in session A but not in session B'
                                                        : 'Trade taken in session B but not in session A',
    });
    stages.sort((x,y) => x.seqNo - y.seqNo);
    return { stages, firstStage: stages[0] || null };
  }, [tickComparison, candleComparison, signalComparison, tradeComparison, skipPartialBucket]);

  const hasResults = resultA && resultB;
  const labelA = resultA?.label || resultA?.sessionDate || 'A';
  const labelB = resultB?.label || resultB?.sessionDate || 'B';

  // ── CSV generation ────────────────────────────────────────────────────────
  const q2  = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const row2 = (...cols) => cols.map(q2).join(',');
  const n2c  = v => v != null ? Number(v).toFixed(2) : '';

  function triggerDownload(filename, csv) {
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function slug() {
    return `${(resultA?.label||resultA?.sessionDate||'A').replace(/[^a-z0-9]/gi,'_')}_vs_${(resultB?.label||resultB?.sessionDate||'B').replace(/[^a-z0-9]/gi,'_')}`;
  }

  function csvSummary() {
    const lines = [
      row2('Metric', `A — ${labelA}`, `B — ${labelB}`, 'Diff (B-A)'),
      row2('Date',          resultA.sessionDate,  resultB.sessionDate,  ''),
      row2('Type',          resultA.type,         resultB.type,         ''),
      row2('Trades',        sumA?.trades??'',     sumB?.trades??'',     sumA?.trades!=null&&sumB?.trades!=null?sumB.trades-sumA.trades:''),
      row2('Realized P&L',  n2c(sumA?.realizedPnl), n2c(sumB?.realizedPnl), sumA?.realizedPnl!=null&&sumB?.realizedPnl!=null?n2c(sumB.realizedPnl-sumA.realizedPnl):''),
      row2('Win Rate',      sumA?.winRate!=null?`${(sumA.winRate*100).toFixed(1)}%`:'', sumB?.winRate!=null?`${(sumB.winRate*100).toFixed(1)}%`:'', sumA?.winRate!=null&&sumB?.winRate!=null?`${((sumB.winRate-sumA.winRate)*100).toFixed(1)}%`:''),
      row2('Final Capital', n2c(sumA?.finalCapital), n2c(sumB?.finalCapital), sumA?.finalCapital!=null&&sumB?.finalCapital!=null?n2c(sumB.finalCapital-sumA.finalCapital):''),
      '',
      row2('Tick Match %',   tickComparison.matchPct!=null?`${tickComparison.matchPct}%`:'N/A — no ticks captured','',''),
      row2('Candle Match %', candleComparison.stats?.matchPct!=null?`${candleComparison.stats.matchPct}%`:'','',''),
      row2('Signal Match %', signalComparison.stats?.matchPct!=null?`${signalComparison.stats.matchPct}%`:'','',''),
      row2('Trade Match %',  tradeComparison.stats?.matchPct!=null?`${tradeComparison.stats.matchPct}%`:'','',''),
      '',
      row2('First Divergence Stage',       divergenceTrace.firstStage?.stage??'NONE','',''),
      row2('First Divergence Time',        divergenceTrace.firstStage?.time??'—','',''),
      row2('First Divergence Instrument',  divergenceTrace.firstStage?.token??'—','',''),
      row2('First Divergence Explanation', divergenceTrace.firstStage?.explanation??'—','',''),
    ];
    return lines.join('\n');
  }

  function csvTicks() {
    if (!tickComparison.rows.length) return row2('No tick data — enable tick capture before starting session');
    const lines = [row2('Match Type','Token','A Time (ms)','A LTP','A Volume','B Time (ms)','B LTP','B Volume','Time Diff ms','Price Diff')];
    for (const r of tickComparison.rows)
      lines.push(row2(r.matchType, r.token, r.a?.timeMs??'', r.a?.ltp??'', r.a?.volume??'', r.b?.timeMs??'', r.b?.ltp??'', r.b?.volume??'', r.timeDiffMs??'', r.priceDiff!=null?n2c(r.priceDiff):''));
    return lines.join('\n');
  }

  function csvCandles() {
    if (!candleComparison.rows.length) return row2('No candle data');
    const lines = [row2('Match Type','Diverged Fields','Time','A Open','A High','A Low','A Close','A Volume','B Open','B High','B Low','B Close','B Volume','Delta Close')];
    for (const r of candleComparison.rows)
      lines.push(row2(r.matchType, r.divergedFields.join('|'), (r.time||'').slice(0,19),
        r.a?.niftyOpen??'', r.a?.niftyHigh??'', r.a?.niftyLow??'', r.a?.niftyClose??'', r.a?.niftyVolume??'',
        r.b?.niftyOpen??'', r.b?.niftyHigh??'', r.b?.niftyLow??'', r.b?.niftyClose??'', r.b?.niftyVolume??'',
        r.a&&r.b?n2c((r.b.niftyClose||0)-(r.a.niftyClose||0)):''));
    return lines.join('\n');
  }

  function csvSignals() {
    if (!signalComparison.rows.length) return row2('No signal data');
    const lines = [row2('Match Type','Diverged Fields','Time','A Regime','A Bias','A Winner','A Score','A Action','A State','B Regime','B Bias','B Winner','B Score','B Action','B State','Delta Score')];
    for (const r of signalComparison.rows)
      lines.push(row2(r.matchType, r.divergedFields.join('|'), (r.time||'').slice(0,19),
        r.a?.regime??'', r.a?.confirmedBias??'', r.a?.winnerStrategy??'', r.a?.winnerScore!=null?n2c(r.a.winnerScore):'', r.a?.action??'', r.a?.positionState??'',
        r.b?.regime??'', r.b?.confirmedBias??'', r.b?.winnerStrategy??'', r.b?.winnerScore!=null?n2c(r.b.winnerScore):'', r.b?.action??'', r.b?.positionState??'',
        r.a&&r.b?n2c((r.b.winnerScore||0)-(r.a.winnerScore||0)):''));
    return lines.join('\n');
  }

  function csvTrades() {
    if (!tradeComparison.rows.length) return row2('No trade data');
    const lines = [row2('Match Type','A Entry','A Exit','A Type','A Symbol','A EntPx','A ExtPx','A PnL','A ExitReason','A Bars','B Entry','B Exit','B Type','B Symbol','B EntPx','B ExtPx','B PnL','B ExitReason','B Bars','Delta PnL','EntPx?','ExtPx?','ExitRsn?')];
    for (const r of tradeComparison.rows) {
      const diff = r.matchType==='BOTH' ? n2c(r.pnlDiff??0) : '';
      lines.push(row2(r.matchType,
        (r.a?.entryTime||'').slice(0,19),(r.a?.exitTime||'').slice(0,19),
        r.a?.optionType??'',r.a?.tradingSymbol??'',r.a?.entryPrice!=null?n2c(r.a.entryPrice):'',r.a?.exitPrice!=null?n2c(r.a.exitPrice):'',r.a?.pnl!=null?n2c(r.a.pnl):'',r.a?.exitReason??'',r.a?.barsInTrade??'',
        (r.b?.entryTime||'').slice(0,19),(r.b?.exitTime||'').slice(0,19),
        r.b?.optionType??'',r.b?.tradingSymbol??'',r.b?.entryPrice!=null?n2c(r.b.entryPrice):'',r.b?.exitPrice!=null?n2c(r.b.exitPrice):'',r.b?.pnl!=null?n2c(r.b.pnl):'',r.b?.exitReason??'',r.b?.barsInTrade??'',
        diff,
        r.matchType==='BOTH'?(r.entryPriceMismatch?'MISMATCH':'ok'):'',
        r.matchType==='BOTH'?(r.exitPriceMismatch?'MISMATCH':'ok'):'',
        r.matchType==='BOTH'?(r.exitReasonMismatch?'MISMATCH':'ok'):''));
    }
    return lines.join('\n');
  }

  function csvDivergence() {
    if (!divergenceTrace.stages.length) return row2('No divergence detected — sessions appear identical');
    const lines = [row2('Stage','Sequence','First Divergence Time','Instrument','Match Type','Explanation')];
    for (const s of divergenceTrace.stages)
      lines.push(row2(s.stage, s.seqNo, s.time, s.token, s.matchType, s.explanation));
    return lines.join('\n');
  }

  function csvConfig() {
    if (!configDiff.length) return row2('Configs are identical');
    const lines = [row2('Field', `A — ${labelA}`, `B — ${labelB}`)];
    configDiff.forEach(({ key, valA, valB }) => lines.push(row2(key, String(valA??''), String(valB??''))));
    return lines.join('\n');
  }

  function downloadSection(key) {
    const map = {
      summary:    ['session_summary',    csvSummary()],
      ticks:      ['tick_comparison',    csvTicks()],
      candles:    ['candle_comparison',  csvCandles()],
      signals:    ['signal_comparison',  csvSignals()],
      trades:     ['trade_comparison',   csvTrades()],
      divergence: ['divergence_summary', csvDivergence()],
      config:     ['config_diff',        csvConfig()],
    };
    const [name, csv] = map[key] || [];
    if (name) triggerDownload(`${name}_${slug()}.csv`, csv);
  }

  function downloadAll() {
    ['summary','ticks','candles','signals','trades','divergence','config']
      .forEach((k, i) => setTimeout(() => downloadSection(k), i * 250));
  }

  // ── Badge helper ──────────────────────────────────────────────────────────
  function mtColor(type) {
    return {
      MATCHED:'#22c55e', EXACT:'#22c55e', BOTH:'#22c55e',
      PRICE_MISMATCH:'#f59e0b', OHLC_MISMATCH:'#f59e0b', SIGNAL_MISMATCH:'#f59e0b',
      A_ONLY:'#6366f1', B_ONLY:'#10b981',
      PARTIAL_START_BUCKET:'#94a3b8',
    }[type] || 'var(--text-muted)';
  }
  function Badge({ type, label }) {
    return <span style={{ fontWeight:700, fontSize:10, color: mtColor(type) }}>{label ?? type}</span>;
  }

  const COMPARE_TABS = [['summary','Summary'],['divergence','Divergence'],['ticks','Ticks'],['candles','Candles'],['signals','Signals'],['trades','Trades'],['config','Config']];

  return (
    <div>
      {/* Session selector ─────────────────────────────────────────────────── */}
      <div className="card bt-opts-card" style={{ marginBottom: 16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12, flexWrap:'wrap' }}>
          <span className="bt-section-title" style={{ marginBottom:0 }}>Saved Sessions</span>
          <input type="text" value={filterUserId} onChange={e => setFilterUserId(e.target.value)}
            placeholder="User ID filter" style={{ fontSize:12, width:140 }} />
          <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ fontSize:12 }}>
            <option value="">All types</option>
            <option value="LIVE">Live</option>
            <option value="TICK_REPLAY">Tick Replay</option>
          </select>
          <button type="button" className="btn-secondary btn-xs" onClick={() => loadSessions(filterUserId, filterType)}>Refresh</button>
          {loading   && <span style={{ fontSize:11, color:'var(--text-muted)' }}>Loading…</span>}
          {loadError && <span style={{ fontSize:11, color:'#ef4444' }}>{loadError}</span>}
        </div>

        {sessions.length === 0 && !loading && (
          <p style={{ fontSize:12, color:'var(--text-muted)', margin:0 }}>No saved sessions. Use "Save to Compare" in Options Live Test or Tick Replay Test.</p>
        )}
        {sessions.length > 0 && (
          <div style={{ overflowX:'auto' }}>
            <table className="bt-table" style={{ fontSize:11 }}>
              <thead><tr><th>Saved</th><th>Time Range</th><th>Type</th><th>Label</th><th>User</th><th>Ticks</th><th>Trades</th><th>P&L</th><th>Win%</th><th>Capital</th><th>A</th><th>B</th><th></th></tr></thead>
              <tbody>
                {(() => {
                  // ── Pair matching ──────────────────────────────────────────
                  // Kite tick timestamps have no tz info but are IST (UTC+5:30)
                  const toUtcMs = iso => {
                    if (!iso) return null;
                    if (iso.endsWith('Z') || /[+-]\d\d:\d\d$/.test(iso)) return new Date(iso).getTime();
                    return new Date(iso + '+05:30').getTime();
                  };
                  const PAIR_THRESHOLD = 5 * 60 * 1000; // 5 min (tight when using lastTickTime)
                  const PAIR_COLORS = ['#f59e0b','#06b6d4','#a78bfa','#f472b6','#34d399','#fb923c'];
                  const pairMap   = new Map(); // sessionId → { partnerId, colorIdx }
                  const liveSess  = sessions.filter(s => s.type === 'LIVE');
                  const tickSess  = sessions.filter(s => s.type === 'TICK_REPLAY');
                  const paired    = new Set();
                  let   colorIdx  = 0;
                  for (const live of liveSess) {
                    const lsm = (() => { try { return live.summaryJson ? JSON.parse(live.summaryJson) : null; } catch { return null; } })();
                    // Prefer lastTickTime (ms, independent of save delay) over savedAt
                    const liveEndMs = lsm?.lastTickTime
                      ? lsm.lastTickTime
                      : new Date(live.savedAt).getTime();
                    let best = null, bestDiff = Infinity;
                    for (const tick of tickSess) {
                      if (tick.userId !== live.userId || tick.sessionDate !== live.sessionDate) continue;
                      if (paired.has(tick.sessionId)) continue;
                      const tsm = (() => { try { return tick.summaryJson ? JSON.parse(tick.summaryJson) : null; } catch { return null; } })();
                      const replayEndMs = toUtcMs(tsm?.replayLastTick);
                      if (!replayEndMs) continue;
                      const diff = Math.abs(liveEndMs - replayEndMs);
                      if (diff < PAIR_THRESHOLD && diff < bestDiff) { bestDiff = diff; best = tick; }
                    }
                    if (best) {
                      const ci = colorIdx++ % PAIR_COLORS.length;
                      pairMap.set(live.sessionId, { partnerId: best.sessionId, colorIdx: ci });
                      pairMap.set(best.sessionId, { partnerId: live.sessionId, colorIdx: ci });
                      paired.add(best.sessionId);
                    }
                  }
                  // ──────────────────────────────────────────────────────────
                  const rows = [];
                  let lastDate = null;
                  sessions.forEach(s => {
                    if (s.sessionDate !== lastDate) {
                      lastDate = s.sessionDate;
                      rows.push(
                        <tr key={`hdr-${s.sessionDate}`}>
                          <td colSpan={13} style={{ background:'var(--bg-secondary,#1e1e2e)', color:'var(--text-muted)', fontWeight:700, fontSize:10, letterSpacing:'0.05em', padding:'4px 8px', borderTop:'1px solid var(--border-color,#333)' }}>
                            {s.sessionDate}
                          </td>
                        </tr>
                      );
                    }
                    const sm   = (() => { try { return s.summaryJson ? JSON.parse(s.summaryJson) : null; } catch { return null; } })();
                    const pair = pairMap.get(s.sessionId);
                    const isA  = selA === s.sessionId, isB = selB === s.sessionId;
                    rows.push(
                      <tr key={s.sessionId} style={{ background: isA?'rgba(99,102,241,0.1)':isB?'rgba(16,185,129,0.1)':undefined }}>
                        <td style={{ whiteSpace:'nowrap', color:'var(--text-muted)' }}>
                          {s.savedAt ? new Date(s.savedAt).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kolkata', hour12:false }) : '—'}
                        </td>
                        <td style={{ whiteSpace:'nowrap', color:'var(--text-muted)' }}>
                          {s.type === 'TICK_REPLAY' && sm?.replayFirstTick && sm?.replayLastTick
                            ? `${sm.replayFirstTick.slice(11,16)} → ${sm.replayLastTick.slice(11,16)}`
                            : s.type === 'LIVE' && sm?.sessionStart && sm?.sessionEnd
                            ? `${new Date(sm.sessionStart).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata',hour12:false})} → ${new Date(sm.sessionEnd).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata',hour12:false})}`
                            : '—'}
                        </td>
                        <td style={{ whiteSpace:'nowrap' }}>
                          {pair && <span title={`Paired with ${pair.partnerId}`} style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:PAIR_COLORS[pair.colorIdx], marginRight:5, verticalAlign:'middle' }} />}
                          <span style={{ color:s.type==='LIVE'?'#22c55e':'#6366f1', fontWeight:700 }}>{s.type==='LIVE'?'LIVE':'TICK'}</span>
                        </td>
                        <td style={{ maxWidth:220, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.label||'—'}</td>
                        <td style={{ maxWidth:80, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--text-muted)', fontSize:10 }} title={s.userId||''}>{s.userId ? s.userId.split('@')[0] : '—'}</td>
                        <td>{s.tickCount!=null?s.tickCount.toLocaleString():'—'}</td>
                        <td>{sm?.trades??'—'}</td>
                        <td style={sm?.realizedPnl!=null?pnlStyle(sm.realizedPnl):{}}>{sm?.realizedPnl!=null?fmt2(sm.realizedPnl):'—'}</td>
                        <td>{sm?.winRate!=null?`${(sm.winRate*100).toFixed(1)}%`:'—'}</td>
                        <td>{sm?.finalCapital!=null?fmt2(sm.finalCapital):'—'}</td>
                        <td><button type="button" className={`btn-xs ${isA?'btn-primary':'btn-secondary'}`} onClick={() => setSelA(isA?null:s.sessionId)}>{isA?'A ✓':'A'}</button></td>
                        <td><button type="button" className={`btn-xs ${isB?'btn-primary':'btn-secondary'}`} style={isB?{background:'#10b981',borderColor:'#10b981'}:{}} onClick={() => setSelB(isB?null:s.sessionId)}>{isB?'B ✓':'B'}</button></td>
                        <td><button type="button" className="btn-xs btn-danger" disabled={deleting===s.sessionId} onClick={() => handleDelete(s.sessionId)}>✕</button></td>
                      </tr>
                    );
                  });
                  return rows;
                })()}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ marginTop:14, display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          <button type="button" className="btn-primary" onClick={handleCompare}
            disabled={!selA || !selB || comparing || selA === selB}>
            {comparing ? 'Loading…' : 'Compare A vs B'}
          </button>
          <label style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, cursor:'pointer', userSelect:'none' }}
            title="Exclude partial first candle from divergence counts — occurs when one session attached to the tick stream mid-bucket">
            <input type="checkbox" checked={skipPartialBucket} onChange={e => setSkipPartialBucket(e.target.checked)} />
            Skip startup bucket
          </label>
          {selA && <span style={{ fontSize:11 }}>A: <b style={{ color:'#6366f1' }}>{sessions.find(s=>s.sessionId===selA)?.label||selA}</b></span>}
          {selB && <span style={{ fontSize:11 }}>B: <b style={{ color:'#10b981' }}>{sessions.find(s=>s.sessionId===selB)?.label||selB}</b></span>}
          {compareErr && <span style={{ fontSize:11, color:'#ef4444' }}>{compareErr}</span>}
        </div>
      </div>

      {hasResults && (
        <>
          {/* Results toolbar ─────────────────────────────────────────────── */}
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12, flexWrap:'wrap' }}>
            <div className="bt-live-right-tabs" style={{ flex:1, flexWrap:'wrap' }}>
              {COMPARE_TABS.map(([k,l]) => (
                <button key={k} className={`bt-live-tab-btn ${compareTab===k?'active':''}`} onClick={() => setCompareTab(k)}>{l}</button>
              ))}
            </div>
            <button type="button" className="btn-secondary btn-xs" onClick={() => downloadSection(compareTab)} title="Download current tab as CSV">⬇ CSV</button>
            <button type="button" className="btn-secondary btn-xs" onClick={downloadAll} title="Download all 7 CSVs">⬇ All CSVs</button>
          </div>

          {/* ── Summary ──────────────────────────────────────────────────── */}
          {compareTab === 'summary' && (
            <div className="card bt-opts-card" style={{ marginBottom:16 }}>
              <span className="bt-section-title">Session Summary</span>
              <table className="bt-table" style={{ fontSize:12 }}>
                <thead><tr><th>Metric</th><th style={{ color:'#6366f1' }}>A — {labelA}</th><th style={{ color:'#10b981' }}>B — {labelB}</th><th>Diff (B−A)</th></tr></thead>
                <tbody>
                  {[['Date', resultA.sessionDate, resultB.sessionDate, null, 'str'],
                    ['Type', resultA.type,        resultB.type,        null, 'str'],
                    ['Trades', sumA?.trades, sumB?.trades, sumA?.trades!=null&&sumB?.trades!=null?sumB.trades-sumA.trades:null, 'int'],
                    ['Realized P&L', sumA?.realizedPnl, sumB?.realizedPnl, sumA?.realizedPnl!=null&&sumB?.realizedPnl!=null?sumB.realizedPnl-sumA.realizedPnl:null, 'pnl'],
                    ['Win Rate', sumA?.winRate!=null?`${(sumA.winRate*100).toFixed(1)}%`:null, sumB?.winRate!=null?`${(sumB.winRate*100).toFixed(1)}%`:null, sumA?.winRate!=null&&sumB?.winRate!=null?`${((sumB.winRate-sumA.winRate)*100).toFixed(1)}%`:null, 'str'],
                    ['Final Capital', sumA?.finalCapital, sumB?.finalCapital, sumA?.finalCapital!=null&&sumB?.finalCapital!=null?sumB.finalCapital-sumA.finalCapital:null, 'pnl'],
                  ].map(([lbl,vA,vB,diff,fmt]) => {
                    const fmtVal = (v) => fmt==='int' ? String(v) : fmt2(v);
                    const fmtDiff = (d) => fmt==='int' ? (d>0?'+':'')+d : (d>0?'+':'')+fmt2(d);
                    return (
                    <tr key={lbl}>
                      <td style={{ fontWeight:700 }}>{lbl}</td>
                      <td style={fmt==='pnl'&&typeof vA==='number'?pnlStyle(vA):{}}>{typeof vA==='number'?fmtVal(vA):(vA??'—')}</td>
                      <td style={fmt==='pnl'&&typeof vB==='number'?pnlStyle(vB):{}}>{typeof vB==='number'?fmtVal(vB):(vB??'—')}</td>
                      <td style={fmt==='pnl'&&typeof diff==='number'?pnlStyle(diff):{}}>{diff!=null?(typeof diff==='number'?fmtDiff(diff):diff):'—'}</td>
                    </tr>
                  )})}
                </tbody>
              </table>

              <div style={{ marginTop:16 }}>
                <span className="bt-section-title" style={{ fontSize:12 }}>Match Rates by Stage</span>
                <table className="bt-table" style={{ fontSize:11, marginTop:6 }}>
                  <thead><tr><th>Stage</th><th>A Count</th><th>B Count</th><th>Matched</th><th>Mismatch</th><th>A-only</th><th>B-only</th><th>Match %</th></tr></thead>
                  <tbody>
                    {[
                      ['Ticks',   ticksA.length||0,                    ticksB.length||0,                    tickComparison.rows.filter(r=>r.matchType==='MATCHED').length,  tickComparison.rows.filter(r=>r.matchType==='PRICE_MISMATCH').length, tickComparison.rows.filter(r=>r.matchType==='A_ONLY').length,  tickComparison.rows.filter(r=>r.matchType==='B_ONLY').length,  tickComparison.matchPct],
                      ['Candles', candleComparison.stats?.aCount??feedA.length, candleComparison.stats?.bCount??feedB.length, candleComparison.stats?.exact??0,  candleComparison.stats?.mismatch??0,  candleComparison.stats?.aOnly??0,  candleComparison.stats?.bOnly??0,  candleComparison.stats?.matchPct],
                      ['Signals', signalComparison.stats?.aCount??feedA.length, signalComparison.stats?.bCount??feedB.length, signalComparison.stats?.matched??0, signalComparison.stats?.mismatch??0,  signalComparison.stats?.aOnly??0,  signalComparison.stats?.bOnly??0, signalComparison.stats?.matchPct],
                      ['Trades',  tradesA.length,                      tradesB.length,                      tradeComparison.stats?.both??0,    tradeComparison.stats?.priceMismatch??0,  tradeComparison.stats?.aOnly??0,   tradeComparison.stats?.bOnly??0,  tradeComparison.stats?.matchPct],
                    ].map(([lbl,ac,bc,matched,mism,ao,bo,pct]) => (
                      <tr key={lbl}>
                        <td style={{ fontWeight:700 }}>{lbl}</td>
                        <td>{ac}</td><td>{bc}</td><td>{matched}</td>
                        <td style={{ color: mism>0?'#f59e0b':undefined }}>{mism??'—'}</td>
                        <td style={{ color: ao>0?'#6366f1':undefined }}>{ao}</td>
                        <td style={{ color: bo>0?'#10b981':undefined }}>{bo}</td>
                        <td style={{ fontWeight:700, color: pct==null?'var(--text-muted)':parseFloat(pct)>=99?'#22c55e':parseFloat(pct)>=90?'#f59e0b':'#ef4444' }}>
                          {pct!=null?`${pct}%`:<span style={{ color:'var(--text-muted)',fontSize:10 }}>N/A</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Divergence ───────────────────────────────────────────────── */}
          {compareTab === 'divergence' && (
            <div className="card bt-opts-card" style={{ marginBottom:16 }}>
              <span className="bt-section-title">Divergence Trace — chain: Tick → Candle → Signal → Trade</span>
              {divergenceTrace.stages.length === 0
                ? <p style={{ fontSize:12, color:'#22c55e', margin:0 }}>No divergence detected across all stages. Sessions appear identical.</p>
                : <>
                  {divergenceTrace.firstStage && (
                    <div style={{ padding:'10px 14px', background:'rgba(245,158,11,0.1)', borderLeft:'3px solid #f59e0b', borderRadius:4, marginBottom:14, fontSize:12 }}>
                      <b>First divergence: {divergenceTrace.firstStage.stage}</b> at{' '}
                      <b>{(divergenceTrace.firstStage.time||'').slice(0,19)}</b> on{' '}
                      <b>{divergenceTrace.firstStage.token}</b> — {divergenceTrace.firstStage.explanation}
                    </div>
                  )}
                  <table className="bt-table" style={{ fontSize:12 }}>
                    <thead><tr><th>#</th><th>Stage</th><th>First Divergence Time</th><th>Instrument</th><th>Type</th><th>Explanation</th></tr></thead>
                    <tbody>
                      {divergenceTrace.stages.map(s => (
                        <tr key={s.stage}>
                          <td>{s.seqNo}</td>
                          <td style={{ fontWeight:700 }}>{s.stage}</td>
                          <td style={{ fontFamily:'monospace', fontSize:11 }}>{(s.time||'').slice(0,19)}</td>
                          <td>{s.token}</td>
                          <td><Badge type={s.matchType} /></td>
                          <td style={{ fontSize:11 }}>{s.explanation}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              }
            </div>
          )}

          {/* ── Ticks ────────────────────────────────────────────────────── */}
          {compareTab === 'ticks' && (
            <div className="card bt-opts-card" style={{ marginBottom:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
                <span className="bt-section-title" style={{ marginBottom:0 }}>Tick Comparison</span>
                <span style={{ fontSize:11, color:'var(--text-muted)' }}>Matching: per-instrument, nearest timestamp ±{TICK_TOL_MS/1000}s tolerance</span>
              </div>
              {(ticksMeta.truncatedA || ticksMeta.truncatedB) && (
                <div style={{ padding:'8px 12px', background:'rgba(245,158,11,0.12)', border:'1px solid rgba(245,158,11,0.4)', borderRadius:4, marginBottom:10, fontSize:11 }}>
                  Tick data was truncated to 50,000 rows per session.
                  {ticksMeta.truncatedA && <span> A: {(ticksMeta.totalA).toLocaleString()} total.</span>}
                  {ticksMeta.truncatedB && <span> B: {(ticksMeta.totalB).toLocaleString()} total.</span>}
                  {' '}Comparison stats reflect only returned rows. Narrow the time range for a full comparison.
                </div>
              )}
              {ticksLoading
                ? <p style={{ fontSize:12, color:'var(--text-muted)', margin:0 }}>Loading ticks from Data Engine…</p>
                : tickComparison.rows.length === 0
                ? <p style={{ fontSize:12, color:'var(--text-muted)', margin:0 }}>No tick data available. Sessions must have a dataEngineSessionId saved to enable tick comparison.</p>
                : <>
                  <div style={{ overflowX:'auto', marginBottom:12 }}>
                    <table className="bt-table" style={{ fontSize:11 }}>
                      <thead><tr><th>Token</th><th>A Ticks</th><th>B Ticks</th><th>Matched</th><th>Price Mismatch</th><th>A-only</th><th>B-only</th><th>Match %</th></tr></thead>
                      <tbody>
                        {Object.values(tickComparison.stats).map(s => (
                          <tr key={s.token}>
                            <td style={{ fontFamily:'monospace' }}>{s.token}</td>
                            <td>{s.aCount}</td><td>{s.bCount}</td><td>{s.matched}</td>
                            <td style={{ color:s.priceMismatch>0?'#f59e0b':undefined }}>{s.priceMismatch}</td>
                            <td style={{ color:s.aOnly>0?'#6366f1':undefined }}>{s.aOnly}</td>
                            <td style={{ color:s.bOnly>0?'#10b981':undefined }}>{s.bOnly}</td>
                            <td style={{ fontWeight:700 }}>{Math.max(s.aCount,s.bCount)>0?(s.matched/Math.max(s.aCount,s.bCount)*100).toFixed(1)+'%':'—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ overflowX:'auto', maxHeight:380, overflowY:'auto' }}>
                    <table className="bt-table" style={{ fontSize:10 }}>
                      <thead><tr><th>Match</th><th>Token</th><th>A Time</th><th>A LTP</th><th>B Time</th><th>B LTP</th><th>Δt ms</th><th>ΔLTP</th></tr></thead>
                      <tbody>
                        {tickComparison.rows.slice(0, 1000).map((r, i) => (
                          <tr key={i} style={{ background:r.matchType==='PRICE_MISMATCH'?'rgba(245,158,11,0.08)':r.matchType!=='MATCHED'?'rgba(99,102,241,0.06)':undefined }}>
                            <td><Badge type={r.matchType} label={r.matchType==='MATCHED'?'✓':r.matchType==='PRICE_MISMATCH'?'PRICE':r.matchType==='A_ONLY'?'A-only':'B-only'} /></td>
                            <td style={{ fontFamily:'monospace', fontSize:9 }}>{r.token}</td>
                            <td style={{ fontFamily:'monospace', fontSize:9 }}>{r.a?new Date(r.a.timeMs).toISOString().slice(11,23):'—'}</td>
                            <td>{r.a?.ltp!=null?n2c(r.a.ltp):'—'}</td>
                            <td style={{ fontFamily:'monospace', fontSize:9 }}>{r.b?new Date(r.b.timeMs).toISOString().slice(11,23):'—'}</td>
                            <td>{r.b?.ltp!=null?n2c(r.b.ltp):'—'}</td>
                            <td style={{ color:Math.abs(r.timeDiffMs||0)>500?'#f59e0b':undefined }}>{r.timeDiffMs??'—'}</td>
                            <td style={{ color:Math.abs(r.priceDiff||0)>OHLC_TOL?'#f59e0b':undefined }}>{r.priceDiff!=null?n2c(r.priceDiff):'—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {tickComparison.rows.length > 1000 && (
                    <p style={{ fontSize:11, color:'var(--text-muted)', margin:'6px 0 0' }}>Showing first 1 000 of {tickComparison.rows.length} rows — download CSV for full data.</p>
                  )}
                </>
              }
            </div>
          )}

          {/* ── Candles ───────────────────────────────────────────────────── */}
          {compareTab === 'candles' && (
            <div className="card bt-opts-card" style={{ marginBottom:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
                <span className="bt-section-title" style={{ marginBottom:0 }}>Candle Comparison — NIFTY OHLCV</span>
                {candleComparison.stats && (
                  <span style={{ fontSize:11, color:'var(--text-muted)' }}>
                    {candleComparison.stats.total} candles · {candleComparison.stats.exact} exact · {candleComparison.stats.mismatch} OHLC mismatch · {candleComparison.stats.aOnly} A-only · {candleComparison.stats.bOnly} B-only{candleComparison.stats.partial > 0 ? ` · ${candleComparison.stats.partial} startup gap${skipPartialBucket ? ' (excluded)' : ''}` : ''}
                  </span>
                )}
              </div>
              <div style={{ overflowX:'auto', maxHeight:480, overflowY:'auto' }}>
                <table className="bt-table" style={{ fontSize:10 }}>
                  <thead>
                    <tr><th>Match</th><th>Diverged</th><th>Time</th>
                      <th style={{ color:'#6366f1' }}>AO</th><th style={{ color:'#6366f1' }}>AH</th><th style={{ color:'#6366f1' }}>AL</th><th style={{ color:'#6366f1' }}>AC</th><th style={{ color:'#6366f1' }}>AV</th>
                      <th style={{ color:'#10b981' }}>BO</th><th style={{ color:'#10b981' }}>BH</th><th style={{ color:'#10b981' }}>BL</th><th style={{ color:'#10b981' }}>BC</th><th style={{ color:'#10b981' }}>BV</th>
                      <th>ΔClose</th></tr>
                  </thead>
                  <tbody>
                    {candleComparison.rows.map((r, i) => (
                      <tr key={i} style={{ background:r.matchType==='OHLC_MISMATCH'?'rgba(245,158,11,0.1)':r.matchType!=='EXACT'?'rgba(99,102,241,0.06)':undefined }}>
                        <td><Badge type={r.matchType} label={r.matchType==='EXACT'?'✓':r.matchType==='OHLC_MISMATCH'?'OHLC':r.matchType==='PARTIAL_START_BUCKET'?'STARTUP':r.matchType==='A_ONLY'?'A-only':'B-only'} /></td>
                        <td style={{ color:'#f59e0b', fontSize:9 }}>{r.divergedFields.join(',')}</td>
                        <td style={{ fontFamily:'monospace', fontSize:9 }}>{(r.time||'').slice(11,16)}</td>
                        <td>{r.a?.niftyOpen!=null?n2c(r.a.niftyOpen):'—'}</td>
                        <td>{r.a?.niftyHigh!=null?n2c(r.a.niftyHigh):'—'}</td>
                        <td>{r.a?.niftyLow!=null?n2c(r.a.niftyLow):'—'}</td>
                        <td>{r.a?.niftyClose!=null?n2c(r.a.niftyClose):'—'}</td>
                        <td style={{ fontSize:9 }}>{r.a?.niftyVolume??'—'}</td>
                        <td>{r.b?.niftyOpen!=null?n2c(r.b.niftyOpen):'—'}</td>
                        <td>{r.b?.niftyHigh!=null?n2c(r.b.niftyHigh):'—'}</td>
                        <td>{r.b?.niftyLow!=null?n2c(r.b.niftyLow):'—'}</td>
                        <td>{r.b?.niftyClose!=null?n2c(r.b.niftyClose):'—'}</td>
                        <td style={{ fontSize:9 }}>{r.b?.niftyVolume??'—'}</td>
                        <td style={{ color:r.a&&r.b&&Math.abs((r.b.niftyClose||0)-(r.a.niftyClose||0))>OHLC_TOL?'#f59e0b':undefined }}>
                          {r.a&&r.b?n2c((r.b.niftyClose||0)-(r.a.niftyClose||0)):'—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Signals ──────────────────────────────────────────────────── */}
          {compareTab === 'signals' && (
            <div className="card bt-opts-card" style={{ marginBottom:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
                <span className="bt-section-title" style={{ marginBottom:0 }}>Signal Comparison — regime · bias · winner · action</span>
                {signalComparison.stats && (
                  <span style={{ fontSize:11, color:'var(--text-muted)' }}>
                    {signalComparison.stats.total} evals · {signalComparison.stats.matched} matched · {signalComparison.stats.mismatch} mismatched
                  </span>
                )}
              </div>
              <div style={{ overflowX:'auto', maxHeight:480, overflowY:'auto' }}>
                <table className="bt-table" style={{ fontSize:10 }}>
                  <thead>
                    <tr><th>Match</th><th>Diverged</th><th>Time</th>
                      <th style={{ color:'#6366f1' }}>A Regime</th><th style={{ color:'#6366f1' }}>A Bias</th><th style={{ color:'#6366f1' }}>A Winner</th><th style={{ color:'#6366f1' }}>A Score</th><th style={{ color:'#6366f1' }}>A Action</th><th style={{ color:'#6366f1' }}>A State</th>
                      <th style={{ color:'#10b981' }}>B Regime</th><th style={{ color:'#10b981' }}>B Bias</th><th style={{ color:'#10b981' }}>B Winner</th><th style={{ color:'#10b981' }}>B Score</th><th style={{ color:'#10b981' }}>B Action</th><th style={{ color:'#10b981' }}>B State</th>
                      <th>ΔScore</th></tr>
                  </thead>
                  <tbody>
                    {signalComparison.rows.map((r, i) => (
                      <tr key={i} style={{ background:r.matchType==='SIGNAL_MISMATCH'?'rgba(245,158,11,0.1)':r.matchType!=='MATCHED'?'rgba(99,102,241,0.06)':undefined }}>
                        <td><Badge type={r.matchType} label={r.matchType==='MATCHED'?'✓':r.matchType==='SIGNAL_MISMATCH'?'⚡':'—'} /></td>
                        <td style={{ color:'#f59e0b', fontSize:9 }}>{r.divergedFields.join(',')}</td>
                        <td style={{ fontFamily:'monospace', fontSize:9 }}>{(r.time||'').slice(11,16)}</td>
                        <td>{r.a?.regime||'—'}</td>
                        <td style={{ color:r.a?.confirmedBias==='BULLISH'?'#22c55e':r.a?.confirmedBias==='BEARISH'?'#ef4444':undefined }}>{r.a?.confirmedBias||'—'}</td>
                        <td>{r.a?.winnerStrategy||'—'}</td>
                        <td>{r.a?.winnerScore!=null?Number(r.a.winnerScore).toFixed(1):'—'}</td>
                        <td style={{ color:r.a?.action==='ENTERED'?'#22c55e':r.a?.action?.includes('EXIT')||r.a?.action?.includes('CLOSE')?'#f97316':undefined }}>{r.a?.action||'—'}</td>
                        <td>{r.a?.positionState||'—'}</td>
                        <td>{r.b?.regime||'—'}</td>
                        <td style={{ color:r.b?.confirmedBias==='BULLISH'?'#22c55e':r.b?.confirmedBias==='BEARISH'?'#ef4444':undefined }}>{r.b?.confirmedBias||'—'}</td>
                        <td>{r.b?.winnerStrategy||'—'}</td>
                        <td>{r.b?.winnerScore!=null?Number(r.b.winnerScore).toFixed(1):'—'}</td>
                        <td style={{ color:r.b?.action==='ENTERED'?'#22c55e':r.b?.action?.includes('EXIT')||r.b?.action?.includes('CLOSE')?'#f97316':undefined }}>{r.b?.action||'—'}</td>
                        <td>{r.b?.positionState||'—'}</td>
                        <td style={{ color:r.a&&r.b&&Math.abs((r.b.winnerScore||0)-(r.a.winnerScore||0))>SCORE_TOL?'#f59e0b':undefined }}>
                          {r.a&&r.b?n2c((r.b.winnerScore||0)-(r.a.winnerScore||0)):'—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Trades ───────────────────────────────────────────────────── */}
          {compareTab === 'trades' && (
            <div className="card bt-opts-card" style={{ marginBottom:16 }}>
              <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:10 }}>
                <span className="bt-section-title" style={{ marginBottom:0 }}>Trade Comparison</span>
                {tradeComparison.stats && (
                  <span style={{ fontSize:11, color:'var(--text-muted)' }}>
                    {tradeComparison.stats.both} both · {tradeComparison.stats.aOnly} A-only · {tradeComparison.stats.bOnly} B-only
                    {tradeComparison.stats.priceMismatch > 0 && (
                      <span style={{ color:'#f59e0b', marginLeft:6 }}>· {tradeComparison.stats.priceMismatch} price mismatch</span>
                    )}
                  </span>
                )}
              </div>
              {tradeComparison.rows.length === 0
                ? <p style={{ fontSize:12, color:'var(--text-muted)', margin:0 }}>No trades in either session.</p>
                : <div style={{ overflowX:'auto' }}>
                  <table className="bt-table" style={{ fontSize:11 }}>
                    <thead>
                      <tr><th>Match</th>
                        <th style={{ color:'#6366f1' }}>A Entry</th><th style={{ color:'#6366f1' }}>A Type</th><th style={{ color:'#6366f1' }}>A Symbol</th><th style={{ color:'#6366f1' }}>A EntPx</th><th style={{ color:'#6366f1' }}>A ExtPx</th><th style={{ color:'#6366f1' }}>A P&L</th><th style={{ color:'#6366f1' }}>A Exit</th><th style={{ color:'#6366f1' }}>A Bars</th>
                        <th style={{ color:'#10b981' }}>B Entry</th><th style={{ color:'#10b981' }}>B Type</th><th style={{ color:'#10b981' }}>B Symbol</th><th style={{ color:'#10b981' }}>B EntPx</th><th style={{ color:'#10b981' }}>B ExtPx</th><th style={{ color:'#10b981' }}>B P&L</th><th style={{ color:'#10b981' }}>B Exit</th><th style={{ color:'#10b981' }}>B Bars</th>
                        <th>ΔP&L</th><th title="Entry price mismatch |A−B|>0.5">EntPx?</th><th title="Exit price mismatch |A−B|>0.5">ExtPx?</th><th title="Exit reason mismatch">ExitRsn?</th></tr>
                    </thead>
                    <tbody>
                      {tradeComparison.rows.map((r, i) => {
                        const pnlDiff = r.matchType==='BOTH' ? (r.pnlDiff??null) : null;
                        const MISMATCH_BG = 'rgba(245,158,11,0.18)';
                        return (
                          <tr key={i} style={{ background:r.matchType==='A_ONLY'?'rgba(99,102,241,0.07)':r.matchType==='B_ONLY'?'rgba(16,185,129,0.07)':undefined }}>
                            <td><Badge type={r.matchType} label={r.matchType==='BOTH'?'✓ BOTH':r.matchType==='A_ONLY'?'A ONLY':'B ONLY'} /></td>
                            <td style={{ fontFamily:'monospace', fontSize:10 }}>{(r.a?.entryTime||'').slice(11,16)||'—'}</td>
                            <td>{r.a?.optionType||'—'}</td>
                            <td style={{ fontSize:10 }}>{r.a?.tradingSymbol||'—'}</td>
                            <td style={r.entryPriceMismatch?{background:MISMATCH_BG}:{}}>{r.a?.entryPrice!=null?n2c(r.a.entryPrice):'—'}</td>
                            <td style={r.exitPriceMismatch?{background:MISMATCH_BG}:{}}>{r.a?.exitPrice!=null?n2c(r.a.exitPrice):'—'}</td>
                            <td style={r.a?.pnl!=null?pnlStyle(r.a.pnl):{}}>{r.a?.pnl!=null?fmt2(r.a.pnl):'—'}</td>
                            <td style={{ fontSize:10, ...(r.exitReasonMismatch?{background:MISMATCH_BG}:{}) }}>{r.a?.exitReason||'—'}</td>
                            <td>{r.a?.barsInTrade??'—'}</td>
                            <td style={{ fontFamily:'monospace', fontSize:10 }}>{(r.b?.entryTime||'').slice(11,16)||'—'}</td>
                            <td>{r.b?.optionType||'—'}</td>
                            <td style={{ fontSize:10 }}>{r.b?.tradingSymbol||'—'}</td>
                            <td style={r.entryPriceMismatch?{background:MISMATCH_BG}:{}}>{r.b?.entryPrice!=null?n2c(r.b.entryPrice):'—'}</td>
                            <td style={r.exitPriceMismatch?{background:MISMATCH_BG}:{}}>{r.b?.exitPrice!=null?n2c(r.b.exitPrice):'—'}</td>
                            <td style={r.b?.pnl!=null?pnlStyle(r.b.pnl):{}}>{r.b?.pnl!=null?fmt2(r.b.pnl):'—'}</td>
                            <td style={{ fontSize:10, ...(r.exitReasonMismatch?{background:MISMATCH_BG}:{}) }}>{r.b?.exitReason||'—'}</td>
                            <td>{r.b?.barsInTrade??'—'}</td>
                            <td style={pnlDiff!=null?pnlStyle(pnlDiff):{}}>{pnlDiff!=null?(pnlDiff>0?'+':'')+fmt2(pnlDiff):'—'}</td>
                            <td style={{ textAlign:'center' }}>{r.matchType==='BOTH'?(r.entryPriceMismatch?<span style={{ color:'#f59e0b' }}>✗</span>:'✓'):'—'}</td>
                            <td style={{ textAlign:'center' }}>{r.matchType==='BOTH'?(r.exitPriceMismatch?<span style={{ color:'#f59e0b' }}>✗</span>:'✓'):'—'}</td>
                            <td style={{ textAlign:'center' }}>{r.matchType==='BOTH'?(r.exitReasonMismatch?<span style={{ color:'#f59e0b' }}>✗</span>:'✓'):'—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              }
            </div>
          )}

          {/* ── Config ───────────────────────────────────────────────────── */}
          {compareTab === 'config' && (
            <div className="card bt-opts-card" style={{ marginBottom:16 }}>
              <span className="bt-section-title">Config Differences {configDiff.length>0?`(${configDiff.length})`:''}</span>
              {configDiff.length === 0
                ? <p style={{ fontSize:12, color:'#22c55e', margin:0 }}>Configs are identical.</p>
                : <div style={{ overflowX:'auto' }}>
                  <table className="bt-table" style={{ fontSize:11 }}>
                    <thead><tr><th>Field</th><th style={{ color:'#6366f1' }}>A — {labelA}</th><th style={{ color:'#10b981' }}>B — {labelB}</th></tr></thead>
                    <tbody>
                      {configDiff.map(({ key, valA, valB }) => (
                        <tr key={key} style={{ background:'rgba(245,158,11,0.08)' }}>
                          <td style={{ fontFamily:'monospace', fontSize:10 }}>{key}</td>
                          <td>{String(valA??'—')}</td>
                          <td>{String(valB??'—')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              }
            </div>
          )}
        </>
      )}
    </div>
  );
}

