package com.sma.dataengine.config;

import com.sma.dataengine.adapter.MarketDataAdapterException;
import com.sma.dataengine.model.response.ApiResponse;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.io.IOException;
import java.util.stream.Collectors;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Void>> handleValidation(MethodArgumentNotValidException ex) {
        String msg = ex.getBindingResult().getFieldErrors().stream()
                .map(e -> e.getField() + ": " + e.getDefaultMessage())
                .collect(Collectors.joining(", "));
        return ResponseEntity.badRequest().body(ApiResponse.error("Validation failed: " + msg));
    }

    @ExceptionHandler(MarketDataAdapterException.class)
    public ResponseEntity<ApiResponse<Void>> handleAdapterException(MarketDataAdapterException ex) {
        log.error("Market data adapter error: {}", ex.getMessage(), ex);
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                .body(ApiResponse.error("Broker adapter error: " + ex.getMessage()));
    }

    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<ApiResponse<Void>> handleIllegalState(IllegalStateException ex) {
        return ResponseEntity.badRequest().body(ApiResponse.error(ex.getMessage()));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<ApiResponse<Void>> handleIllegalArg(IllegalArgumentException ex) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiResponse.error(ex.getMessage()));
    }

    /**
     * Broken pipe means the SSE client (browser) closed the connection.
     * This is normal — log at DEBUG and do not attempt to write a response body
     * (the response is already committed as text/event-stream).
     */
    @ExceptionHandler(IOException.class)
    public ResponseEntity<ApiResponse<Void>> handleIo(IOException ex, HttpServletResponse response) {
        String msg = ex.getMessage();
        if (msg != null && msg.contains("Broken pipe")) {
            log.debug("SSE client disconnected (broken pipe) — ignored");
        } else {
            log.warn("IOException in Data Engine: {}", msg);
        }
        // Response is already committed as SSE stream — cannot write a JSON body
        return null;
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleGeneric(Exception ex, HttpServletResponse response) {
        // If the response is already committed (e.g. mid-SSE stream), writing a body will fail
        if (response.isCommitted()) {
            log.debug("Response already committed, skipping error body: {}", ex.getMessage());
            return null;
        }
        log.error("Unexpected error in Data Engine", ex);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(ApiResponse.error("Internal server error: " + ex.getMessage()));
    }
}
