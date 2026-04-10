package com.sma.brokerengine.config;

import com.sma.brokerengine.adapter.BrokerAdapterRegistry;
import com.sma.brokerengine.adapter.kite.KiteBrokerAdapter;
import com.sma.brokerengine.model.response.ApiResponse;
import com.sma.brokerengine.security.TokenEncryptionService;
import com.sma.brokerengine.service.BrokerAuthService;
import com.sma.brokerengine.service.OrderService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.stream.Collectors;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BrokerAuthService.AccountNotFoundException.class)
    public ResponseEntity<ApiResponse<Void>> handleAccountNotFound(BrokerAuthService.AccountNotFoundException ex) {
        log.warn("Account not found: {}", ex.getMessage());
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiResponse.error(ex.getMessage()));
    }

    @ExceptionHandler(BrokerAuthService.TokenNotAvailableException.class)
    public ResponseEntity<ApiResponse<Void>> handleTokenNotAvailable(BrokerAuthService.TokenNotAvailableException ex) {
        log.warn("Token not available: {}", ex.getMessage());
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(ApiResponse.error(ex.getMessage()));
    }

    @ExceptionHandler(OrderService.OrderNotFoundException.class)
    public ResponseEntity<ApiResponse<Void>> handleOrderNotFound(OrderService.OrderNotFoundException ex) {
        log.warn("Order not found: {}", ex.getMessage());
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiResponse.error(ex.getMessage()));
    }

    @ExceptionHandler(OrderService.OrderCancellationException.class)
    public ResponseEntity<ApiResponse<Void>> handleOrderCancellation(OrderService.OrderCancellationException ex) {
        log.error("Order cancellation error: {}", ex.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(ApiResponse.error(ex.getMessage()));
    }

    @ExceptionHandler(BrokerAdapterRegistry.UnsupportedBrokerException.class)
    public ResponseEntity<ApiResponse<Void>> handleUnsupportedBroker(BrokerAdapterRegistry.UnsupportedBrokerException ex) {
        log.warn("Unsupported broker: {}", ex.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(ApiResponse.error(ex.getMessage()));
    }

    @ExceptionHandler(KiteBrokerAdapter.KiteAdapterException.class)
    public ResponseEntity<ApiResponse<Void>> handleKiteError(KiteBrokerAdapter.KiteAdapterException ex) {
        log.error("Kite broker error: {}", ex.getMessage());
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(ApiResponse.error(ex.getMessage()));
    }

    @ExceptionHandler(TokenEncryptionService.EncryptionException.class)
    public ResponseEntity<ApiResponse<Void>> handleEncryption(TokenEncryptionService.EncryptionException ex) {
        log.error("Credential encryption/decryption failed: {}", ex.getMessage(), ex);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(ApiResponse.error("Credential decryption failed — the ENCRYPTION_SECRET_KEY may have changed since the account was registered. Re-authenticate the account to fix this."));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ApiResponse<Void>> handleValidation(MethodArgumentNotValidException ex) {
        String errors = ex.getBindingResult().getFieldErrors().stream()
                .map(e -> e.getField() + ": " + e.getDefaultMessage())
                .collect(Collectors.joining(", "));
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(ApiResponse.error("Validation failed: " + errors));
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<ApiResponse<Void>> handleNoResource(NoResourceFoundException ex) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiResponse.error("Not found: " + ex.getResourcePath()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResponse<Void>> handleGeneric(Exception ex) {
        log.error("Unhandled exception", ex);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(ApiResponse.error("Internal server error"));
    }
}
