package com.sma.strategyengine.controller;

import com.sma.strategyengine.model.request.ReplayRequest;
import com.sma.strategyengine.service.ReplayEvalService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * SSE endpoint for streaming replay evaluation.
 *
 * <pre>
 * POST /api/v1/strategy/replay/evaluate
 * Content-Type: application/json
 * Accept: text/event-stream
 * </pre>
 *
 * The request body is a {@link ReplayRequest} JSON object.
 * The response is a stream of {@code text/event-stream} events, each named {@code candle},
 * carrying a JSON-serialised {@link com.sma.strategyengine.model.response.ReplayCandleEvent}.
 *
 * <p>The evaluation runs on a dedicated background thread so the servlet thread
 * is immediately freed after returning the emitter. The emitter is kept open
 * until all candles have been streamed or the client disconnects.
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/strategy")
@RequiredArgsConstructor
public class ReplayEvalController {

    private final ReplayEvalService replayEvalService;

    /** Dedicated thread pool for replay evaluation tasks (one thread per active replay). */
    private final ExecutorService executor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "replay-eval-" + System.nanoTime());
        t.setDaemon(true);
        return t;
    });

    /**
     * Starts a streaming replay evaluation.
     *
     * @param req validated replay configuration
     * @return SSE emitter; events are named {@code candle} with JSON payload
     */
    @PostMapping(value = "/replay/evaluate", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter evaluate(@Valid @RequestBody ReplayRequest req) {
        log.info("Replay eval request: {}/{} [{}] {} to {} x{} speed, {} strategy config(s)",
                req.getSymbol(), req.getExchange(), req.getInterval(),
                req.getFromDate(), req.getToDate(),
                req.getSpeedMultiplier(),
                req.getStrategies() != null ? req.getStrategies().size() : 0);

        // Unbounded timeout — the client closes when it's done
        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE);

        executor.execute(() -> replayEvalService.run(req, emitter));

        return emitter;
    }
}
