import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getStrategyTypes, runBacktest,
  startReplay, stopReplay, getReplayStatus,
  liveSubscribe, liveUnsubscribe, liveStatus,
  searchInstruments, fetchHistoricalData,
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
const REGIME_COLORS = {
  TRENDING:    { bg: 'rgba(99,102,241,0.15)', text: '#818cf8', border: '#4f46e5' },
  RANGING:     { bg: 'rgba(245,158,11,0.15)', text: '#fbbf24', border: '#d97706' },
  VOLATILE:    { bg: 'rgba(239,68,68,0.15)',  text: '#f87171', border: '#dc2626' },
  COMPRESSION: { bg: 'rgba(34,197,94,0.15)',  text: '#4ade80', border: '#16a34a' },
};
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
const EMPTY_REGIME_CONFIG = {
  enabled: false,
  adxPeriod: 14,
  atrPeriod: 14,
  adxTrendThreshold: 25,
  atrVolatilePct: 2.0,
  atrCompressionPct: 0.5,
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
  const [riskConfig, setRiskConfig]         = useState({ ...EMPTY_RISK });
  const [patternConfig, setPatternConfig]   = useState({ ...EMPTY_PATTERN });
  const [regimeConfig, setRegimeConfig]     = useState({ ...EMPTY_REGIME_CONFIG });
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
        <button type="button" className="btn-secondary" onClick={() => { setStrategies(defaultStrategies()); setDataCtx({ ...EMPTY_DATA_CTX }); setRiskConfig({ ...EMPTY_RISK }); setPatternConfig({ ...EMPTY_PATTERN }); setRegimeConfig({ ...EMPTY_REGIME_CONFIG }); setResult(null); setError(''); }} disabled={loading}>
          Reset
        </button>
      </div>

      {result && <BacktestResultPanel result={result} session={session} instrumentToken={dataCtx.instrumentToken} />}
    </form>
  );
}

// ─── Instrument Picker ────────────────────────────────────────────────────────
// Shared component used in all 3 tabs: search box + recent instruments list

const FO_EXCHANGES = ['NFO', 'BFO', 'MCX', 'CDS'];
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
    if (/CE$|PE$/.test(u) || /\dFUT/.test(u) || /NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY/.test(u)) {
      return 'NFO';
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
            placeholder={session?.userId ? 'Type symbol or name  (e.g. RELIANCE, NIFTY24DEC24450CE)' : 'Activate a session to search instruments'}
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
          const signal = evaluatorRef.current.next(parseFloat(candle.close), parseFloat(candle.high), parseFloat(candle.low), parseFloat(candle.volume), parseFloat(candle.open));
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
  const [preload, setPreload]         = useState({ enabled: true, daysBack: 5, interval: 'MINUTE_5' });
  const [preloadState, setPreloadState] = useState(null); // null | { status, count, error }

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
    setLatestTick(null); setPreloadState(null);
    evaluatorRef.current = buildLocalEvaluator(variant.strategyType, variant.parameters || {});

    try {
      // ── Step 1: warmup evaluator with historical candles ──────────────────
      if (preload.enabled && inst.instrumentToken) {
        setStatus('warming up');
        setPreloadState({ status: 'loading', count: 0, error: null });
        try {
          const now  = new Date();
          const from = new Date(now.getTime() - parseInt(preload.daysBack, 10) * 24 * 60 * 60 * 1000);
          from.setHours(9, 15, 0, 0);
          const pad = n => String(n).padStart(2, '0');
          const fmt  = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

          const res = await fetchHistoricalData({
            userId:          session.userId,
            brokerName:      session.brokerName,
            apiKey:          session.apiKey,
            accessToken:     session.accessToken,
            instrumentToken: parseInt(inst.instrumentToken, 10),
            symbol:          inst.symbol.toUpperCase(),
            exchange:        inst.exchange.toUpperCase(),
            interval:        preload.interval,
            fromDate:        fmt(from),
            toDate:          fmt(now),
            persist:         true,
          });
          const candles = res?.data || [];
          candles.forEach(c => evaluatorRef.current.next(parseFloat(c.close)));
          setPreloadState({ status: 'done', count: candles.length, error: null });
        } catch (err) {
          setPreloadState({ status: 'error', count: 0, error: err.message });
          // non-fatal — continue to live connection with cold evaluator
        }
      }

      // ── Step 2: subscribe to live feed ────────────────────────────────────
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
      await liveUnsubscribe({
        userId:           session.userId,
        brokerName:       session.brokerName,
        instrumentTokens: [parseInt(inst.instrumentToken, 10)],
      });
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

            {/* Preload historical candles for warmup */}
            <div className="de-preload-block" style={{ marginBottom: 14 }}>
              <div className="de-preload-header">
                <label className="checkbox-label" style={{ margin: 0, fontWeight: 600 }}>
                  <input type="checkbox" checked={preload.enabled} disabled={connected}
                    onChange={e => setPreload(p => ({ ...p, enabled: e.target.checked }))} />
                  Preload past candles
                </label>
                <span className="de-preload-hint">Warms up the strategy evaluator before going live</span>
              </div>
              {preload.enabled && (
                <div className="de-preload-fields">
                  <div className="form-group">
                    <label>Days back</label>
                    <input type="number" min="1" max="60" value={preload.daysBack} disabled={connected}
                      onChange={e => setPreload(p => ({ ...p, daysBack: e.target.value }))}
                      style={{ width: 80 }} />
                  </div>
                  <div className="form-group">
                    <label>Candle interval</label>
                    <select value={preload.interval} disabled={connected}
                      onChange={e => setPreload(p => ({ ...p, interval: e.target.value }))}>
                      {INTERVALS.map(iv => <option key={iv.value} value={iv.value}>{iv.label}</option>)}
                    </select>
                  </div>
                </div>
              )}
              {preloadState && (
                <div className="de-preload-results">
                  {preloadState.status === 'loading' && <span className="de-preload-loading">Fetching historical candles…</span>}
                  {preloadState.status === 'done'    && <span className="de-preload-result-item de-preload-ok">{preloadState.count} candles fed into evaluator</span>}
                  {preloadState.status === 'error'   && <span className="de-preload-result-item de-preload-error">Preload failed: {preloadState.error} — continuing cold</span>}
                </div>
              )}
            </div>

            {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}
            {!isActive && <div className="error-msg" style={{ marginBottom: 12 }}>No active session.</div>}

            <div style={{ display: 'flex', gap: 8 }}>
              {!connected ? (
                <button type="submit" className="btn-primary" disabled={!isActive || status === 'connecting' || status === 'warming up'}>
                  {status === 'warming up' ? 'Warming up…' : status === 'connecting' ? 'Connecting…' : '⬤ Connect Live'}
                </button>
              ) : (
                <button type="button" className="btn-danger" onClick={handleDisconnect}>✕ Unsubscribe</button>
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
                return (
                  <tr key={i} className={`bt-row ${i === selectedIdx ? 'bt-row-selected' : ''} ${isBest ? 'bt-row-best' : ''} ${isRegimeSwitched ? 'bt-row-regime-switched' : ''}`}
                    onClick={() => switchStrategy(i)} style={{ cursor: 'pointer' }}>
                    <td>{isBest && <span className="best-star">★</span>}{isRegimeSwitched && <span className="bt-regime-combined-star">⚡</span>}</td>
                    <td style={{ fontWeight: 600 }}>{r.label}</td>
                    <td>{isRegimeSwitched
                      ? <span className="bt-regime-combined-badge">Combined</span>
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
                  <th>PnL</th><th>Return %</th><th>Exit</th><th>Regime</th><th>Patterns</th><th>Capital After</th>
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
