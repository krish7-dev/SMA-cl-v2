package com.sma.dataengine.adapter.kite;

import com.sma.dataengine.adapter.MarketDataAdapter;
import com.sma.dataengine.adapter.MarketDataAdapterException;
import com.sma.dataengine.model.CandleData;
import com.sma.dataengine.model.InstrumentInfo;
import com.sma.dataengine.model.Interval;
import com.sma.dataengine.model.SubscriptionMode;
import com.sma.dataengine.model.TickData;
import com.sma.dataengine.model.request.HistoricalDataRequest;
import com.zerodhatech.models.Instrument;
import com.zerodhatech.kiteconnect.KiteConnect;
import com.zerodhatech.kiteconnect.kitehttp.exceptions.KiteException;
import com.zerodhatech.kiteconnect.kitehttp.exceptions.TokenException;
import com.zerodhatech.models.HistoricalData;
import com.zerodhatech.models.Tick;
import com.zerodhatech.ticker.KiteTicker;
import com.zerodhatech.ticker.OnError;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * Kite Connect market data adapter.
 *
 * Responsibilities (MARKET DATA ONLY):
 * - Live tick streaming via KiteTicker WebSocket
 * - Historical OHLCV candles via KiteConnect REST API
 *
 * NOT responsible for:
 * - Broker auth, login, or token generation (SMA-Broker-Engine owns this)
 * - Order placement, cancellation, portfolio, or margins
 *
 * ─── Kite SDK 3.1.1 field reference (verified from decompiled source) ─────────
 * Tick: all fields are private — use getters:
 *   getInstrumentToken() → long
 *   getLastTradedPrice(), getHighPrice(), getLowPrice(), getOpenPrice(), getClosePrice() → double
 *   getLastTradedQuantity(), getAverageTradePrice(), getVolumeTradedToday() → double
 *   getTotalBuyQuantity(), getTotalSellQuantity(), getChange(), getOi() → double
 *   getTickTimestamp() → Date
 *   NOTE: OHLC are FLAT fields on Tick — there is NO nested ohlc object in SDK 3.1.1
 *
 * HistoricalData: no inner HistoricalDataBean — each candle IS a HistoricalData.
 *   dataArrayList: List<HistoricalData>
 *   timeStamp: String (ISO 8601, e.g. "2023-01-02T09:15:00+0530")
 *   open, high, low, close: double  |  volume, oi: long
 *
 * KiteConnect.getHistoricalData(Date from, Date to, String token, String interval,
 *                                boolean continuous, boolean oi)
 *
 * KiteTicker.OnError: 3-overload interface — NOT a functional interface, use anonymous class.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Slf4j
@Component
public class KiteMarketDataAdapter implements MarketDataAdapter {

    private static final String          PROVIDER = "kite";
    private static final ZoneId          IST      = ZoneId.of("Asia/Kolkata");

    // Kite returns "+0530" (no colon). ISO_OFFSET_DATE_TIME requires "+05:30".
    // This formatter handles both forms via the BasicIso offset pattern.
    private static final DateTimeFormatter KITE_DT_FMT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssZ");

    // ─── State ────────────────────────────────────────────────────────────────

    private KiteTicker          ticker;
    private KiteConnect         kiteConnect;
    private final AtomicBoolean connected = new AtomicBoolean(false);

    /** Registered by LiveMarketDataService before connect() is called. */
    private Consumer<List<TickData>> tickListener;

    // ─── MarketDataAdapter ────────────────────────────────────────────────────

    @Override
    public String getProviderName() {
        return PROVIDER;
    }

    @Override
    public void setTickListener(Consumer<List<TickData>> listener) {
        this.tickListener = listener;
    }

    @Override
    public void connect(String apiKey, String accessToken) {
        if (connected.get()) {
            log.debug("KiteMarketDataAdapter already connected — skipping reconnect");
            return;
        }

        log.info("Connecting KiteTicker (apiKey={})", maskKey(apiKey));
        try {
            // KiteConnect instance — used for historical REST calls
            kiteConnect = new KiteConnect(apiKey);
            kiteConnect.setAccessToken(accessToken);

            // KiteTicker — WebSocket for live ticks
            ticker = new KiteTicker(accessToken, apiKey);

            ticker.setOnConnectedListener(() -> {
                connected.set(true);
                log.info("KiteTicker connected successfully");
            });

            ticker.setOnDisconnectedListener(() -> {
                connected.set(false);
                log.warn("KiteTicker disconnected");
            });

            // OnError has 3 overloads — not a @FunctionalInterface, requires anonymous class
            ticker.setOnErrorListener(new OnError() {
                @Override
                public void onError(Exception e) {
                    log.error("KiteTicker error (Exception): {}", e.getMessage(), e);
                }

                @Override
                public void onError(KiteException e) {
                    log.error("KiteTicker error (KiteException): [{}] {}", e.code, e.message != null ? e.message : e.getMessage());
                }

                @Override
                public void onError(String errorMessage) {
                    log.error("KiteTicker error (String): {}", errorMessage);
                }
            });

            ticker.setOnTickerArrivalListener((ArrayList<Tick> ticks) -> {
                if (tickListener == null || ticks == null || ticks.isEmpty()) return;
                try {
                    List<TickData> normalized = new ArrayList<>(ticks.size());
                    for (Tick t : ticks) {
                        normalized.add(normalizeTick(t));
                    }
                    tickListener.accept(normalized);
                } catch (Exception e) {
                    log.error("Error normalizing ticks from Kite", e);
                }
            });

            ticker.setTryReconnection(true);
            // setMaximumRetries / setMaximumRetryInterval declare throws KiteException
            try { ticker.setMaximumRetries(10); }
            catch (KiteException e) { log.warn("Could not set max retries: {}", e.getMessage()); }
            try { ticker.setMaximumRetryInterval(30); }
            catch (KiteException e) { log.warn("Could not set retry interval: {}", e.getMessage()); }

            ticker.connect();

        } catch (Exception e) {
            connected.set(false);
            throw new MarketDataAdapterException("Failed to connect KiteTicker: " + e.getMessage(), e);
        }
    }

    @Override
    public void disconnect() {
        if (ticker != null) {
            try {
                ticker.disconnect();
            } catch (Exception e) {
                log.warn("Error during KiteTicker disconnect: {}", e.getMessage());
            } finally {
                connected.set(false);
                ticker = null;
                kiteConnect = null;
                log.info("KiteMarketDataAdapter disconnected");
            }
        }
    }

    @Override
    public boolean isConnected() {
        return connected.get() && ticker != null;
    }

    @Override
    public void subscribe(List<Long> instrumentTokens, SubscriptionMode mode) {
        if (!isConnected()) {
            throw new MarketDataAdapterException("Cannot subscribe — KiteTicker is not connected");
        }
        ArrayList<Long> tokens = new ArrayList<>(instrumentTokens);
        ticker.subscribe(tokens);
        ticker.setMode(tokens, toKiteMode(mode));
        log.info("Subscribed to {} instruments in {} mode", tokens.size(), mode);
    }

    @Override
    public void unsubscribe(List<Long> instrumentTokens) {
        if (ticker != null) {
            ticker.unsubscribe(new ArrayList<>(instrumentTokens));
            log.info("Unsubscribed from {} instruments", instrumentTokens.size());
        }
    }

    /**
     * Kite API maximum days per request per interval.
     * Requests spanning more than this are automatically chunked.
     */
    private static int kiteMaxDays(Interval interval) {
        return switch (interval) {
            case MINUTE_1  -> 60;
            case MINUTE_3  -> 60;
            case MINUTE_5  -> 60;
            case MINUTE_10 -> 60;
            case MINUTE_15 -> 60;
            case MINUTE_30 -> 60;
            case MINUTE_60 -> 400;
            case DAY, WEEK, MONTH -> 2000;
        };
    }

    @Override
    public List<CandleData> getHistoricalData(HistoricalDataRequest request) {
        // Build a fresh KiteConnect with caller-supplied credentials.
        // Data Engine does not cache or own access tokens — each call is explicit.
        KiteConnect api = new KiteConnect(request.getApiKey());
        api.setAccessToken(request.getAccessToken());

        Interval interval   = request.getInterval();
        int      chunkDays  = kiteMaxDays(interval);
        String   kiteInterval = interval.getKiteValue();
        String   token        = String.valueOf(request.getInstrumentToken());

        // Split the full date range into chunks that fit within Kite's per-request limit
        List<CandleData> allCandles = new ArrayList<>();
        LocalDateTime chunkStart = request.getFromDate();
        LocalDateTime rangeEnd   = request.getToDate();
        int chunkIndex = 0;

        while (!chunkStart.isAfter(rangeEnd)) {
            LocalDateTime chunkEnd = chunkStart.plusDays(chunkDays).minusSeconds(1);
            if (chunkEnd.isAfter(rangeEnd)) chunkEnd = rangeEnd;

            log.info("Fetching historical data chunk {}: token={}, interval={}, from={}, to={}",
                    ++chunkIndex, token, kiteInterval, chunkStart, chunkEnd);

            try {
                HistoricalData response = api.getHistoricalData(
                        toDate(chunkStart),
                        toDate(chunkEnd),
                        token,
                        kiteInterval,
                        request.isContinuous(),
                        false  // oi flag — set true if open interest is needed
                );

                if (response != null && response.dataArrayList != null) {
                    for (HistoricalData bean : response.dataArrayList) {
                        CandleData c = normalizeCandle(bean, request);
                        if (c.getOpenTime() != null) {
                            allCandles.add(c);
                        } else {
                            log.debug("Skipping candle with unparseable timestamp: {}", bean.timeStamp);
                        }
                    }
                    log.info("Chunk {} returned {} candles (running total: {})",
                            chunkIndex, response.dataArrayList.size(), allCandles.size());
                } else {
                    log.warn("Kite returned null for chunk {}: token={}, from={}, to={}",
                            chunkIndex, token, chunkStart, chunkEnd);
                }

            } catch (KiteException e) {
                String kiteMsg = e.message != null ? e.message : ("code=" + e.code);
                if (e instanceof TokenException) {
                    throw new MarketDataAdapterException(
                            "Kite access token is expired or invalid. " +
                            "Please re-authenticate: go to the Session page and log in to your Kite account again.", e);
                }
                if (kiteMsg.toLowerCase().contains("invalid token")) {
                    // InputException with "invalid token" = instrument token not found (expired/delisted contract)
                    throw new MarketDataAdapterException(
                            "Kite rejected instrument token " + token + " — the options contract may have expired " +
                            "or the token is no longer valid. Historical data unavailable for this instrument.", e);
                }
                throw new MarketDataAdapterException(
                        "Kite API error fetching historical data (chunk " + chunkIndex + "): [" + e.code + "] " + kiteMsg, e);
            } catch (Exception e) {
                throw new MarketDataAdapterException(
                        "Unexpected error fetching historical data from Kite (chunk " + chunkIndex + "): " + e.getMessage(), e);
            }

            chunkStart = chunkEnd.plusSeconds(1);
        }

        log.info("Fetched {} total candles for token={} across {} chunk(s)",
                allCandles.size(), token, chunkIndex);
        return allCandles;
    }

    // ─── Normalization ────────────────────────────────────────────────────────

    /**
     * Converts a Kite SDK Tick to a normalized TickData.
     *
     * SDK 3.1.1 verified:
     * - All fields private — getters required
     * - OHLC are FLAT fields (getOpenPrice etc.) — no nested ohlc object
     * - getAverageTradePrice() — "Trade" not "Traded"
     * - getOi() for open interest — not getOpenInterest()
     * - quantity/volume fields return double; cast to long where needed
     */
    private TickData normalizeTick(Tick t) {
        Instant timestamp = t.getTickTimestamp() != null
                ? t.getTickTimestamp().toInstant()
                : Instant.now();

        return TickData.builder()
                .provider(PROVIDER)
                .instrumentToken(t.getInstrumentToken())
                .lastTradedPrice(bd(t.getLastTradedPrice()))
                .lastTradedQuantity((long) t.getLastTradedQuantity())
                .averageTradedPrice(bd(t.getAverageTradePrice()))          // "Trade" not "Traded"
                .volumeTradedToday((long) t.getVolumeTradedToday())
                .totalBuyQuantity(bd(t.getTotalBuyQuantity()))
                .totalSellQuantity(bd(t.getTotalSellQuantity()))
                .change(bd(t.getChange()))
                .openInterest((long) t.getOi())                            // getOi(), not getOpenInterest()
                // OHLC: flat on Tick in SDK 3.1.1 — no nested object
                .openPrice(bd(t.getOpenPrice()))
                .highPrice(bd(t.getHighPrice()))
                .lowPrice(bd(t.getLowPrice()))
                .closePrice(bd(t.getClosePrice()))
                .timestamp(timestamp)
                .build();
    }

    /**
     * Converts a Kite SDK HistoricalData candle to a normalized CandleData.
     *
     * SDK 3.1.1 verified:
     * - No inner HistoricalDataBean class — each list element IS a HistoricalData
     * - timeStamp is a String (ISO 8601, e.g. "2023-01-02T09:15:00+0530")
     *   Daily candles may be date-only: "2023-01-02"
     */
    private CandleData normalizeCandle(HistoricalData bean, HistoricalDataRequest request) {
        return CandleData.builder()
                .instrumentToken(request.getInstrumentToken())
                .symbol(request.getSymbol())
                .exchange(request.getExchange())
                .interval(request.getInterval())
                .openTime(parseTimestamp(bean.timeStamp))
                .open(BigDecimal.valueOf(bean.open))
                .high(BigDecimal.valueOf(bean.high))
                .low(BigDecimal.valueOf(bean.low))
                .close(BigDecimal.valueOf(bean.close))
                .volume(bean.volume)
                .openInterest(bean.oi)
                .provider(PROVIDER)
                .build();
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /**
     * Parses Kite's historical timestamp string.
     * Standard: ISO 8601 with offset "2023-01-02T09:15:00+0530"
     * Daily fallback: date-only "2023-01-02"
     */
    private LocalDateTime parseTimestamp(String ts) {
        if (ts == null || ts.isBlank()) return null;
        // Try "+0530" form first (Kite's actual format), then ISO "+05:30", then date-only
        try {
            return OffsetDateTime.parse(ts, KITE_DT_FMT).atZoneSameInstant(IST).toLocalDateTime();
        } catch (Exception ignored) {}
        try {
            return OffsetDateTime.parse(ts).atZoneSameInstant(IST).toLocalDateTime();
        } catch (Exception ignored) {}
        try {
            return LocalDate.parse(ts).atStartOfDay();
        } catch (Exception e) {
            log.warn("Could not parse historical timestamp '{}' — returning null", ts);
            return null;
        }
    }

    private Date toDate(LocalDateTime ldt) {
        return Date.from(ldt.atZone(IST).toInstant());
    }

    private static String toKiteMode(SubscriptionMode mode) {
        return switch (mode) {
            case LTP   -> KiteTicker.modeLTP;
            case QUOTE -> KiteTicker.modeQuote;
            case FULL  -> KiteTicker.modeFull;
        };
    }

    private static BigDecimal bd(double value) {
        return BigDecimal.valueOf(value);
    }

    /**
     * Fetches ALL instruments for a given exchange from Kite REST API.
     * Creates a one-off KiteConnect instance — does not affect the live WebSocket connection.
     * Returns the full list (unfiltered, no limit) for caller-side caching and search.
     */
    public List<InstrumentInfo> fetchAllInstruments(String apiKey, String accessToken, String exchange) {
        try {
            KiteConnect kc = new KiteConnect(apiKey);
            kc.setAccessToken(accessToken);
            List<Instrument> all = (exchange != null && !exchange.isBlank())
                    ? kc.getInstruments(exchange.toUpperCase())
                    : kc.getInstruments();

            return all.stream()
                    .map(this::toInstrumentInfo)
                    .toList();
        } catch (KiteException e) {
            String msg = e.message != null ? e.message : "code=" + e.code;
            throw new MarketDataAdapterException("Kite instrument fetch failed: " + msg, e);
        } catch (IOException e) {
            throw new MarketDataAdapterException("Network error during instrument fetch", e);
        }
    }

    private InstrumentInfo toInstrumentInfo(Instrument i) {
        String expiry = null;
        if (i.expiry != null) {
            expiry = new java.text.SimpleDateFormat("yyyy-MM-dd").format(i.expiry);
        }
        return InstrumentInfo.builder()
                .instrumentToken(i.instrument_token)
                .tradingSymbol(i.tradingsymbol)
                .name(i.name)
                .exchange(i.exchange)
                .instrumentType(i.instrument_type)
                .segment(i.segment)
                .lotSize(i.lot_size)
                .expiry(expiry)
                .strike(parseStrike(i.strike))
                .build();
    }

    private static double parseStrike(Object strike) {
        if (strike == null) return 0.0;
        try { return Double.parseDouble(strike.toString().trim()); }
        catch (NumberFormatException e) { return 0.0; }
    }

    private static String maskKey(String key) {
        if (key == null || key.length() < 8) return "***";
        return key.substring(0, 4) + "****" + key.substring(key.length() - 4);
    }
}
