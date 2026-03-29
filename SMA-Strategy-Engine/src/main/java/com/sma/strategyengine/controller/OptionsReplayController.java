package com.sma.strategyengine.controller;

import com.sma.strategyengine.model.request.OptionsReplayRequest;
import com.sma.strategyengine.service.options.OptionsReplayService;
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
 * SSE endpoint for NIFTY-driven options replay evaluation.
 *
 * POST /api/v1/strategy/options-replay/evaluate
 * Content-Type: application/json
 * Accept: text/event-stream
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/strategy")
@RequiredArgsConstructor
public class OptionsReplayController {

    private final OptionsReplayService optionsReplayService;

    private final ExecutorService executor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "opts-replay-" + System.nanoTime());
        t.setDaemon(true);
        return t;
    });

    @PostMapping(value = "/options-replay/evaluate", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter evaluate(@RequestBody OptionsReplayRequest req) {
        log.info("Options replay request: NIFTY/{} {} -> {} x{} speed, {} strategies, CE={}, PE={}",
                req.getInterval(), req.getFromDate(), req.getToDate(),
                req.getSpeedMultiplier(),
                req.getStrategies() != null ? req.getStrategies().size() : 0,
                req.getCeOptions() != null ? req.getCeOptions().size() : 0,
                req.getPeOptions() != null ? req.getPeOptions().size() : 0);

        SseEmitter emitter = new SseEmitter(Long.MAX_VALUE);
        executor.execute(() -> optionsReplayService.run(req, emitter));
        return emitter;
    }
}
