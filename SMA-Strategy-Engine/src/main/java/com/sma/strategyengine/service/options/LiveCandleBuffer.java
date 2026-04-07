package com.sma.strategyengine.service.options;

import com.sma.strategyengine.client.DataEngineClient;
import com.sma.strategyengine.client.DataEngineClient.CandleDto;
import lombok.extern.slf4j.Slf4j;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;

/**
 * Per-session buffer that accumulates closed live candles and flushes them to
 * the Data Engine ingest endpoint in batches.
 *
 * <p>Design goals:
 * <ul>
 *   <li>Zero impact on the tick-processing loop — callers just {@link #add} and return.</li>
 *   <li>Batching: flushes when batch reaches {@value #BATCH_SIZE} or every {@value #FLUSH_INTERVAL_MS} ms.</li>
 *   <li>Retry: up to {@value #MAX_RETRIES} attempts with exponential back-off before logging a warning.</li>
 *   <li>No silent data loss: failures are logged with runId + token + openTime for post-hoc recovery.</li>
 *   <li>Clean shutdown: {@link #stop()} flushes remaining candles before terminating.</li>
 * </ul>
 */
@Slf4j
public class LiveCandleBuffer {

    private static final int  BATCH_SIZE        = 30;
    private static final long FLUSH_INTERVAL_MS = 10_000L; // 10 seconds
    private static final int  MAX_RETRIES       = 3;

    private final String           runId;
    private final String           provider;
    private final DataEngineClient dataEngineClient;

    /** Pending candles waiting to be flushed. */
    private final BlockingQueue<BufferedCandle> queue = new LinkedBlockingQueue<>();

    private final ScheduledExecutorService scheduler;
    private       ScheduledFuture<?>       flushTask;
    private volatile boolean               stopped = false;

    // ── Inner record ─────────────────────────────────────────────────────────

    public record BufferedCandle(
            long          instrumentToken,
            String        symbol,
            String        exchange,
            String        interval,   // Kite interval string, e.g. "5minute"
            LocalDateTime openTime,
            double        open,
            double        high,
            double        low,
            double        close,
            long          volume
    ) {}

    // ── Constructor ──────────────────────────────────────────────────────────

    public LiveCandleBuffer(String runId, String provider, DataEngineClient dataEngineClient) {
        this.runId            = runId;
        this.provider         = provider;
        this.dataEngineClient = dataEngineClient;
        this.scheduler        = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "live-candle-buffer-" + runId.substring(0, 8));
            t.setDaemon(true);
            return t;
        });
        this.flushTask = scheduler.scheduleAtFixedRate(
                this::flushBatch, FLUSH_INTERVAL_MS, FLUSH_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Enqueues a closed candle for deferred persistence.
     * Non-blocking — returns immediately.
     */
    public void add(long instrumentToken, String symbol, String exchange,
                    String intervalKiteValue, CandleDto candle) {
        if (stopped) return;
        log.info("LiveCandleBuffer [{}]: queuing candle token={} symbol={} openTime={} close={}",
                runId.substring(0, 8), instrumentToken, symbol, candle.openTime(), candle.close());
        queue.offer(new BufferedCandle(
                instrumentToken, symbol, exchange, intervalKiteValue,
                candle.openTime(), candle.open().doubleValue(), candle.high().doubleValue(),
                candle.low().doubleValue(), candle.close().doubleValue(),
                candle.volume() != null ? candle.volume() : 0L));

        // Eager flush when batch is full
        if (queue.size() >= BATCH_SIZE) {
            scheduler.execute(this::flushBatch);
        }
    }

    /**
     * Flushes remaining candles and shuts down the background scheduler.
     * Called when the live session stops.
     */
    public void stop() {
        stopped = true;
        if (flushTask != null) flushTask.cancel(false);
        flushBatch(); // drain remaining
        scheduler.shutdownNow();
    }

    // ── Flush logic ──────────────────────────────────────────────────────────

    private synchronized void flushBatch() {
        if (queue.isEmpty()) return;

        List<BufferedCandle> batch = new ArrayList<>(BATCH_SIZE);
        queue.drainTo(batch, BATCH_SIZE);
        if (batch.isEmpty()) return;

        sendWithRetry(batch, 1);
    }

    private void sendWithRetry(List<BufferedCandle> batch, int attempt) {
        try {
            dataEngineClient.ingestLiveCandles(runId, provider, batch);
            log.info("LiveCandleBuffer: flushed {} candles to DB (runId={})", batch.size(), runId);
        } catch (Exception e) {
            if (attempt < MAX_RETRIES) {
                long delayMs = 1000L * (long) Math.pow(2, attempt - 1); // 1s, 2s, 4s
                log.warn("LiveCandleBuffer: ingest attempt {}/{} failed (runId={}), retrying in {}ms: {}",
                        attempt, MAX_RETRIES, runId, delayMs, e.getMessage());
                try { Thread.sleep(delayMs); } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    logFailure(batch);
                    return;
                }
                sendWithRetry(batch, attempt + 1);
            } else {
                logFailure(batch);
            }
        }
    }

    private void logFailure(List<BufferedCandle> batch) {
        log.error("LiveCandleBuffer: PERMANENTLY FAILED to persist {} candles after {} retries (runId={}). " +
                  "First: token={} openTime={}, Last: token={} openTime={}",
                batch.size(), MAX_RETRIES, runId,
                batch.get(0).instrumentToken(), batch.get(0).openTime(),
                batch.get(batch.size() - 1).instrumentToken(), batch.get(batch.size() - 1).openTime());
    }
}
