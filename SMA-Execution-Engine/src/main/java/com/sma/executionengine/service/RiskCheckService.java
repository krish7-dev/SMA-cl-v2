package com.sma.executionengine.service;

import com.sma.executionengine.entity.ExecutionRecord.OrderType;
import com.sma.executionengine.model.request.ExecutionRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;

/**
 * Pre-execution risk and validation checks.
 *
 * Checks run in order:
 * 1. Required field validation (price for LIMIT/SL, triggerPrice for SL/SL_M)
 * 2. Positive quantity
 * 3. Notional value cap (price * quantity <= maxNotional, when configured)
 * 4. Quantity cap (when configured)
 *
 * Throws {@link RiskViolationException} on any failure — caller should
 * mark the execution as FAILED and not proceed to broker submission.
 */
@Slf4j
@Service
public class RiskCheckService {

    private final BigDecimal globalMaxNotional;
    private final int        globalMaxQty;

    public RiskCheckService(
            @Value("${execution.risk.max-notional-per-order:0}") BigDecimal globalMaxNotional,
            @Value("${execution.risk.max-quantity-per-order:0}") int globalMaxQty) {
        this.globalMaxNotional = globalMaxNotional;
        this.globalMaxQty      = globalMaxQty;
    }

    /**
     * Validates the request and enforces risk limits.
     *
     * @throws RiskViolationException if any check fails
     */
    public void validate(ExecutionRequest request) {
        checkOrderTypeFields(request);
        checkQuantity(request);
        checkNotional(request);
        checkMaxQty(request);
        log.debug("Risk checks passed: intentId={}, symbol={}, qty={}",
                request.getIntentId(), request.getSymbol(), request.getQuantity());
    }

    // ─── Individual checks ────────────────────────────────────────────────────

    private void checkOrderTypeFields(ExecutionRequest r) {
        OrderType type = r.getOrderType();
        if ((type == OrderType.LIMIT || type == OrderType.SL) && r.getPrice() == null) {
            throw new RiskViolationException("price is required for " + type + " orders");
        }
        if ((type == OrderType.SL || type == OrderType.SL_M) && r.getTriggerPrice() == null) {
            throw new RiskViolationException("triggerPrice is required for " + type + " orders");
        }
    }

    private void checkQuantity(ExecutionRequest r) {
        if (r.getQuantity() <= 0) {
            throw new RiskViolationException("quantity must be positive, got: " + r.getQuantity());
        }
    }

    private void checkNotional(ExecutionRequest r) {
        // Per-request override takes precedence over global setting
        BigDecimal cap = r.getMaxNotional() != null ? r.getMaxNotional() : globalMaxNotional;
        if (cap == null || cap.compareTo(BigDecimal.ZERO) <= 0) return; // disabled

        BigDecimal price = r.getPrice() != null ? r.getPrice() : BigDecimal.ZERO;
        BigDecimal notional = price.multiply(BigDecimal.valueOf(r.getQuantity()));
        if (notional.compareTo(cap) > 0) {
            throw new RiskViolationException(
                    "Notional value " + notional + " exceeds limit " + cap +
                    " for intentId=" + r.getIntentId());
        }
    }

    private void checkMaxQty(ExecutionRequest r) {
        if (globalMaxQty <= 0) return; // disabled
        if (r.getQuantity() > globalMaxQty) {
            throw new RiskViolationException(
                    "Quantity " + r.getQuantity() + " exceeds limit " + globalMaxQty +
                    " for intentId=" + r.getIntentId());
        }
    }

    // ─── Exception ────────────────────────────────────────────────────────────

    public static class RiskViolationException extends RuntimeException {
        public RiskViolationException(String message) { super(message); }
    }
}
