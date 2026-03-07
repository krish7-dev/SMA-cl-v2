package com.sma.brokerengine.controller;

import com.sma.brokerengine.model.request.CancelOrderRequest;
import com.sma.brokerengine.model.request.PlaceOrderRequest;
import com.sma.brokerengine.model.response.ApiResponse;
import com.sma.brokerengine.model.response.OrderResponse;
import com.sma.brokerengine.service.OrderService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/v1/broker/orders")
@RequiredArgsConstructor
public class OrderController {

    private final OrderService orderService;

    /**
     * Places an order with the broker.
     * Idempotent — duplicate clientOrderId returns the existing order.
     *
     * POST /api/v1/broker/orders
     */
    @PostMapping
    public ResponseEntity<ApiResponse<OrderResponse>> placeOrder(
            @Valid @RequestBody PlaceOrderRequest request) {
        OrderResponse response = orderService.placeOrder(request);
        return ResponseEntity.ok(ApiResponse.ok(response, "Order processed"));
    }

    /**
     * Cancels an open order by clientOrderId.
     *
     * DELETE /api/v1/broker/orders
     */
    @DeleteMapping
    public ResponseEntity<ApiResponse<OrderResponse>> cancelOrder(
            @Valid @RequestBody CancelOrderRequest request) {
        OrderResponse response = orderService.cancelOrder(request);
        return ResponseEntity.ok(ApiResponse.ok(response, "Order cancellation submitted"));
    }

    /**
     * Returns the status of a single order by clientOrderId.
     *
     * GET /api/v1/broker/orders/{clientOrderId}
     */
    @GetMapping("/{clientOrderId}")
    public ResponseEntity<ApiResponse<OrderResponse>> getOrder(
            @PathVariable String clientOrderId) {
        OrderResponse response = orderService.getOrder(clientOrderId);
        return ResponseEntity.ok(ApiResponse.ok(response));
    }

    /**
     * Returns all orders for a given broker account.
     *
     * GET /api/v1/broker/orders?userId=&brokerName=
     */
    @GetMapping
    public ResponseEntity<ApiResponse<List<OrderResponse>>> getOrders(
            @RequestParam String userId,
            @RequestParam String brokerName) {
        List<OrderResponse> responses = orderService.getOrdersForAccount(userId, brokerName);
        return ResponseEntity.ok(ApiResponse.ok(responses));
    }
}
