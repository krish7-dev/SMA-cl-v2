package com.sma.dataengine.adapter.kite;

import com.sma.dataengine.adapter.MarketDataAdapter;
import com.sma.dataengine.adapter.MarketDataAdapterException;
import com.sma.dataengine.model.CandleData;
import com.sma.dataengine.model.Interval;
import com.sma.dataengine.model.SubscriptionMode;
import com.sma.dataengine.model.TickData;
import com.sma.dataengine.model.request.HistoricalDataRequest;
import com.zerodhatech.kiteconnect.KiteConnect;
import com.zerodhatech.kiteconnect.kitehttp.exceptions.KiteException;
import com.zerodhatech.models.HistoricalData;
import com.zerodhatech.ticker.KiteTicker;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
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
 * The apiKey and accessToken are passed in at connect-time by the caller
 * (supplied from SMA-Broker-Engine's authenticated session).
 *
 * ─── Kite SDK field notes (SDK 3.1.1) ────────────────────────────────────────
 * HistoricalData.HistoricalDataBean fields: timeStamp (Date), open/high/low/close
 *   (double), volume (long), oi (long).
 * Tick fields: instrumentToken (long), lastTradedPrice (double),
 *   lastTradedQuantity (int), averageTradedPrice (double), volumeTradedToday (long),
 *   totalBuyQuantity (double), totalSellQuantity (double),
 *   ohlc.open/high/low/close (double), change (double), openInterest (long).
 * If compilation errors occur on Tick fields, decompile com.zerodhatech.models.Tick
 * from the SDK jar to verify exact field names for this SDK version.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Slf4j
@Component
public class KiteMarketDataAdapter implements MarketDataAdapter {

    private static final String PROVIDER = "kite";
    private static final DateTimeFormatter KITE_DATE_FORMAT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final ZoneId IST = ZoneId.of("Asia/Kolkata");

    // ─── State ────────────────────────────────────────────────────────────────

    private KiteTicker       ticker;
    private KiteConnect      kiteConnect;
    private final AtomicBoolean connected = new AtomicBoolean(false);

    /** Registered by LiveMarketDataService before connect() is called. */
    private Consumer<List<TickData>> tickListener;

    // ─── MarketDataAdapter ────────────────────────────────────────────────────

    @Override
    public String getProviderName() {
        return PROVIDER;
    }

    @Override
    public void connect(String apiKey, String accessToken) {
        if (connected.get()) {
            log.debug("KiteMarketDataAdapter already connected — skipping reconnect");
            return;
        }

        log.info("Connecting KiteTicker (apiKey={}…)", maskKey(apiKey));
        try {
            // KiteConnect instance — used for historical REST calls
            kiteConnect = new KiteConnect(apiKey);
            kiteConnect.setAccessToken(accessToken);

            // KiteTicker — WebSocket for live ticks
            // TODO: plug in real Kite ticker integration here
            ticker = new KiteTicker(accessToken, apiKey);

            ticker.setOnConnectedListener(() -> {
                connected.set(true);
                log.info("KiteTicker connected successfully");
            });

            ticker.setOnDisconnectedListener(() -> {
                connected.set(false);
                log.warn("KiteTicker disconnected");
            });

            ticker.setOnErrorListener((ex, response, code) -> {
                log.error("KiteTicker error: code={}, response={}", code, response, ex);
            });

            ticker.setOnTickerArrivalListener(ticks -> {
                if (tickListener == null || ticks == null || ticks.isEmpty()) return;
                try {
                    List<TickData> normalized = new ArrayList<>(ticks.size());
                    for (com.zerodhatech.models.Tick t : ticks) {
                        normalized.add(normalizeTick(t));
                    }
                    tickListener.accept(normalized);
                } catch (Exception e) {
                    log.error("Error normalizing ticks from Kite", e);
                }
            });

            ticker.setTryReconnection(true);
            ticker.setMaximumRetries(10);
            ticker.setMaximumRetryInterval(30);

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
    public void setTickListener(Consumer<List<TickData>> listener) {
        this.tickListener = listener;
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

    @Override
    public List<CandleData> getHistoricalData(HistoricalDataRequest request) {
        // Build a fresh KiteConnect with the caller-supplied credentials.
        // Data Engine does not cache or own access tokens — each call is explicit.
        KiteConnect api = new KiteConnect(request.getApiKey());
        api.setAccessToken(request.getAccessToken());

        HashMap<String, Object> params = new HashMap<>();
        params.put("instrument_token", String.valueOf(request.getInstrumentToken()));
        params.put("from", request.getFromDate().format(KITE_DATE_FORMAT));
        params.put("to",   request.getToDate().format(KITE_DATE_FORMAT));
        params.put("interval", request.getInterval().getKiteValue());
        params.put("continuous", String.valueOf(request.isContinuous()));

        log.info("Fetching historical data: token={}, interval={}, from={}, to={}",
                request.getInstrumentToken(), request.getInterval().getKiteValue(),
                request.getFromDate(), request.getToDate());

        try {
            HistoricalData response = api.getHistoricalData(params, request.isContinuous());

            if (response == null || response.dataArrayList == null) {
                log.warn("Kite returned null historical data for token={}", request.getInstrumentToken());
                return List.of();
            }

            List<CandleData> candles = new ArrayList<>(response.dataArrayList.size());
            for (HistoricalData.HistoricalDataBean bean : response.dataArrayList) {
                candles.add(normalizeCandle(bean, request));
            }

            log.info("Fetched {} candles for token={}", candles.size(), request.getInstrumentToken());
            return candles;

        } catch (KiteException e) {
            throw new MarketDataAdapterException(
                    "Kite API error fetching historical data: [" + e.code + "] " + e.getMessage(), e);
        } catch (Exception e) {
            throw new MarketDataAdapterException(
                    "Unexpected error fetching historical data from Kite: " + e.getMessage(), e);
        }
    }

    // ─── Normalization ────────────────────────────────────────────────────────

    /**
     * Converts a Kite SDK Tick to a normalized TickData.
     * Field names are based on Kite Connect Java SDK 3.1.1 decompiled source.
     * Verify against: com.zerodhatech.models.Tick in the SDK jar.
     */
    private TickData normalizeTick(com.zerodhatech.models.Tick t) {
        TickData.TickDataBuilder builder = TickData.builder()
                .provider(PROVIDER)
                .instrumentToken(t.instrumentToken)
                .lastTradedPrice(safeDecimal(t.lastTradedPrice))
                .lastTradedQuantity((long) t.lastTradedQuantity)
                .averageTradedPrice(safeDecimal(t.averageTradedPrice))
                .volumeTradedToday(t.volumeTradedToday)
                .totalBuyQuantity(safeDecimal(t.totalBuyQuantity))
                .totalSellQuantity(safeDecimal(t.totalSellQuantity))
                .change(safeDecimal(t.change))
                .openInterest(t.openInterest)
                .timestamp(Instant.now());

        // OHLC is populated in QUOTE and FULL modes
        if (t.ohlc != null) {
            builder.openPrice(safeDecimal(t.ohlc.open))
                   .highPrice(safeDecimal(t.ohlc.high))
                   .lowPrice(safeDecimal(t.ohlc.low))
                   .closePrice(safeDecimal(t.ohlc.close));
        }

        return builder.build();
    }

    /**
     * Converts a Kite SDK HistoricalDataBean to a normalized CandleData.
     */
    private CandleData normalizeCandle(HistoricalData.HistoricalDataBean bean,
                                       HistoricalDataRequest request) {
        LocalDateTime openTime = bean.timeStamp != null
                ? bean.timeStamp.toInstant().atZone(IST).toLocalDateTime()
                : null;

        return CandleData.builder()
                .instrumentToken(request.getInstrumentToken())
                .symbol(request.getSymbol())
                .exchange(request.getExchange())
                .interval(request.getInterval())
                .openTime(openTime)
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

    private static String toKiteMode(SubscriptionMode mode) {
        return switch (mode) {
            case LTP   -> KiteTicker.modeLTP;
            case QUOTE -> KiteTicker.modeQuote;
            case FULL  -> KiteTicker.modeFull;
        };
    }

    private static BigDecimal safeDecimal(double value) {
        return BigDecimal.valueOf(value);
    }

    private static String maskKey(String key) {
        if (key == null || key.length() < 8) return "***";
        return key.substring(0, 4) + "****" + key.substring(key.length() - 4);
    }
}
