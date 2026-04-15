package com.sma.strategyengine.config;

import com.sma.strategyengine.client.DataEngineClient.DataEngineException;
import com.sma.strategyengine.model.response.ApiResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.ConstraintViolationException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.io.IOException;
import java.util.stream.Collectors;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<?> handleValidation(MethodArgumentNotValidException ex,
                                              HttpServletRequest request) {
        String message = ex.getBindingResult().getFieldErrors().stream()
                .map(fe -> fe.getField() + ": " + fe.getDefaultMessage())
                .collect(Collectors.joining("; "));
        return respond(HttpStatus.BAD_REQUEST, "Validation failed: " + message, request);
    }

    @ExceptionHandler(ConstraintViolationException.class)
    public ResponseEntity<?> handleConstraint(ConstraintViolationException ex,
                                              HttpServletRequest request) {
        return respond(HttpStatus.BAD_REQUEST, "Validation failed: " + ex.getMessage(), request);
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<?> handleIllegalArgument(IllegalArgumentException ex,
                                                   HttpServletRequest request) {
        return respond(HttpStatus.NOT_FOUND, ex.getMessage(), request);
    }

    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<?> handleIllegalState(IllegalStateException ex,
                                                HttpServletRequest request) {
        return respond(HttpStatus.CONFLICT, ex.getMessage(), request);
    }

    @ExceptionHandler(DataEngineException.class)
    public ResponseEntity<?> handleDataEngine(DataEngineException ex,
                                              HttpServletRequest request) {
        log.error("Data Engine error: {}", ex.getMessage());
        return respond(HttpStatus.BAD_GATEWAY, ex.getMessage(), request);
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<?> handleNoResource(NoResourceFoundException ex, HttpServletRequest request) {
        return respond(HttpStatus.NOT_FOUND, "Not found: " + ex.getResourcePath(), request);
    }

    @ExceptionHandler(IOException.class)
    public ResponseEntity<?> handleIo(IOException ex, HttpServletRequest request) {
        String msg = ex.getMessage();
        if (msg != null && (msg.contains("Broken pipe") || msg.contains("Connection reset"))) {
            log.debug("Client disconnected from SSE stream: {}", msg);
            return ResponseEntity.status(HttpStatus.OK).build();
        }
        log.error("Unhandled IO exception: {}", msg, ex);
        return respond(HttpStatus.INTERNAL_SERVER_ERROR, "Internal server error: " + msg, request);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<?> handleGeneral(Exception ex, HttpServletRequest request) {
        log.error("Unhandled exception: {}", ex.getMessage(), ex);
        return respond(HttpStatus.INTERNAL_SERVER_ERROR,
                "Internal server error: " + ex.getMessage(), request);
    }

    /**
     * For SSE endpoints (Accept: text/event-stream) returning a JSON body would cause
     * HttpMediaTypeNotAcceptableException. Return a bodyless response instead so the
     * SSE emitter can cleanWithError on its own.
     */
    private ResponseEntity<?> respond(HttpStatus status, String message, HttpServletRequest request) {
        String accept = request.getHeader("Accept");
        if (accept != null && accept.contains(MediaType.TEXT_EVENT_STREAM_VALUE)) {
            return ResponseEntity.status(status).build();
        }
        return ResponseEntity.status(status).body(ApiResponse.error(message));
    }
}
