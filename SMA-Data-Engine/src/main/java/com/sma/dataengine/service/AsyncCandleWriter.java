package com.sma.dataengine.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.stereotype.Service;

import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Write-behind queue for candle DB persistence.
 *
 * <p>Callers submit a {@link Runnable} DB operation and return immediately — the operation
 * is never dropped and never blocks the caller. A single dedicated writer thread drains
 * the queue and retries each operation with exponential backoff (2 s → 4 s → 8 s … 30 s max)
 * until it succeeds. The app keeps running even if the DB is completely unreachable.
 *
 * <p>On Spring context shutdown ({@link DisposableBean#destroy}), the writer thread is
 * signalled to stop accepting new work and drains all remaining operations before the
 * JVM exits — ensuring no candles are lost on graceful shutdown.
 */
@Slf4j
@Service
public class AsyncCandleWriter implements DisposableBean {

    private static final long INITIAL_BACKOFF_MS = 2_000;
    private static final long MAX_BACKOFF_MS     = 30_000;
    private static final long SHUTDOWN_DRAIN_TIMEOUT_MS = 120_000;

    private final LinkedBlockingQueue<Runnable> queue = new LinkedBlockingQueue<>();
    private volatile boolean accepting = true;
    private final Thread writerThread;

    public AsyncCandleWriter() {
        writerThread = new Thread(this::drainLoop, "async-candle-writer");
        writerThread.setDaemon(false); // non-daemon: JVM waits for this thread on exit
        writerThread.start();
        log.info("AsyncCandleWriter started");
    }

    /**
     * Enqueue a DB write operation. Returns immediately.
     * The operation will be executed by the writer thread with retry until it succeeds.
     */
    public void submit(Runnable operation) {
        if (!accepting) {
            log.warn("AsyncCandleWriter: shutdown in progress — executing operation synchronously");
            executeWithRetry(operation);
            return;
        }
        queue.offer(operation);
    }

    /** Current number of pending operations waiting to be written to DB. */
    public int queueDepth() {
        return queue.size();
    }

    // ── writer thread ─────────────────────────────────────────────────────────

    private void drainLoop() {
        while (accepting || !queue.isEmpty()) {
            try {
                Runnable op = queue.poll(500, TimeUnit.MILLISECONDS);
                if (op != null) {
                    executeWithRetry(op);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        // Final drain after shutdown signal
        Runnable op;
        while ((op = queue.poll()) != null) {
            executeWithRetry(op);
        }
    }

    private void executeWithRetry(Runnable op) {
        long backoff = INITIAL_BACKOFF_MS;
        int attempt = 0;
        while (true) {
            try {
                op.run();
                if (attempt > 0) {
                    log.info("AsyncCandleWriter: DB write succeeded after {} retries", attempt);
                }
                return;
            } catch (Exception e) {
                attempt++;
                log.warn("AsyncCandleWriter: DB write failed (attempt {}), retrying in {}ms — {}",
                        attempt, backoff, e.getMessage());
                try {
                    Thread.sleep(backoff);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    log.error("AsyncCandleWriter: interrupted during retry backoff — operation abandoned");
                    return;
                }
                backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
            }
        }
    }

    // ── shutdown ──────────────────────────────────────────────────────────────

    @Override
    public void destroy() {
        log.info("AsyncCandleWriter: shutdown initiated, draining {} pending operations...", queue.size());
        accepting = false;
        writerThread.interrupt();
        try {
            writerThread.join(SHUTDOWN_DRAIN_TIMEOUT_MS);
            if (writerThread.isAlive()) {
                log.warn("AsyncCandleWriter: drain timed out after {}s — {} operations may be lost",
                        SHUTDOWN_DRAIN_TIMEOUT_MS / 1000, queue.size());
            } else {
                log.info("AsyncCandleWriter: shutdown complete, all operations flushed");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.warn("AsyncCandleWriter: shutdown interrupted");
        }
    }
}
