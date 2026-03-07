package com.sma.brokerengine.adapter.kite;

import com.sma.brokerengine.adapter.BrokerAdapter;
import com.sma.brokerengine.model.response.MarginResponse;
import com.sma.brokerengine.model.response.PositionResponse;
import com.zerodhatech.kiteconnect.KiteConnect;
import com.zerodhatech.kiteconnect.kitehttp.exceptions.KiteException;
import com.zerodhatech.models.Margin;
import com.zerodhatech.models.Order;
import com.zerodhatech.models.OrderParams;
import com.zerodhatech.models.Position;
import com.zerodhatech.models.User;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Kite (Zerodha) broker adapter.
 *
 * This is the only class in the platform that imports or uses Kite SDK types.
 * No Kite types leak beyond this class or this package.
 *
 * SDK: com.zerodhatech.kiteconnect:kiteconnect:3.1.1
 * Kite Connect API Docs: https://kite.trade/docs/connect/v3/
 */
@Slf4j
@Component
public class KiteBrokerAdapter implements BrokerAdapter {

    private static final String BROKER_NAME = "kite";
    private static final String VARIETY_REGULAR = "regular";

    @Override
    public String getBrokerName() {
        return BROKER_NAME;
    }

    @Override
    public String generateAccessToken(String apiKey, String apiSecret, String requestToken) {
        log.info("Generating Kite access token for apiKey={}", maskKey(apiKey));
        try {
            KiteConnect kite = new KiteConnect(apiKey);
            User user = kite.generateSession(requestToken, apiSecret);
            log.info("Kite session generated successfully for user={}", user.userName);
            return user.accessToken;
        } catch (KiteException e) {
            throw new KiteAdapterException("Kite session generation failed: " + e.message, e);
        } catch (IOException e) {
            throw new KiteAdapterException("Network error during Kite session generation", e);
        }
    }

    @Override
    public String placeOrder(String accessToken, String apiKey, Map<String, Object> params) {
        log.info("Placing Kite order: symbol={}, type={}, qty={}",
                params.get("symbol"), params.get("orderType"), params.get("quantity"));
        try {
            KiteConnect kite = buildKiteConnect(apiKey, accessToken);
            OrderParams orderParams = mapToOrderParams(params);
            Order order = kite.placeOrder(orderParams, VARIETY_REGULAR);
            log.info("Kite order placed successfully: brokerOrderId={}", order.orderId);
            return order.orderId;
        } catch (KiteException e) {
            throw new KiteAdapterException("Kite order placement failed: " + e.message, e);
        } catch (IOException e) {
            throw new KiteAdapterException("Network error during Kite order placement", e);
        }
    }

    @Override
    public void cancelOrder(String accessToken, String apiKey, String brokerOrderId, String variety) {
        log.info("Cancelling Kite order: brokerOrderId={}", brokerOrderId);
        try {
            KiteConnect kite = buildKiteConnect(apiKey, accessToken);
            String effectiveVariety = (variety != null && !variety.isBlank()) ? variety : VARIETY_REGULAR;
            kite.cancelOrder(brokerOrderId, effectiveVariety);
            log.info("Kite order cancelled: brokerOrderId={}", brokerOrderId);
        } catch (KiteException e) {
            throw new KiteAdapterException("Kite order cancellation failed: " + e.message, e);
        } catch (IOException e) {
            throw new KiteAdapterException("Network error during Kite order cancellation", e);
        }
    }

    @Override
    public Map<String, Object> getOrderStatus(String accessToken, String apiKey, String brokerOrderId) {
        log.info("Fetching Kite order status: brokerOrderId={}", brokerOrderId);
        try {
            KiteConnect kite = buildKiteConnect(apiKey, accessToken);
            // getOrderHistory returns the full audit trail; the last entry is the current state
            List<Order> history = kite.getOrderHistory(brokerOrderId);
            if (history == null || history.isEmpty()) {
                return Collections.emptyMap();
            }
            Order latest = history.get(history.size() - 1);
            return mapOrderToStatusMap(latest);
        } catch (KiteException e) {
            throw new KiteAdapterException("Kite order status fetch failed: " + e.message, e);
        } catch (IOException e) {
            throw new KiteAdapterException("Network error fetching Kite order status", e);
        }
    }

    @Override
    public List<PositionResponse> getPositions(String accessToken, String apiKey) {
        log.info("Fetching Kite net positions");
        try {
            KiteConnect kite = buildKiteConnect(apiKey, accessToken);
            Map<String, List<Position>> positionMap = kite.getPositions();
            List<Position> netPositions = positionMap.getOrDefault("net", Collections.emptyList());
            return netPositions.stream()
                    .map(this::mapPosition)
                    .collect(Collectors.toList());
        } catch (KiteException e) {
            throw new KiteAdapterException("Kite positions fetch failed: " + e.message, e);
        } catch (IOException e) {
            throw new KiteAdapterException("Network error fetching Kite positions", e);
        }
    }

    @Override
    public List<MarginResponse> getMargins(String accessToken, String apiKey) {
        log.info("Fetching Kite margins");
        try {
            KiteConnect kite = buildKiteConnect(apiKey, accessToken);
            List<MarginResponse> result = new ArrayList<>();

            Margin equity = kite.getMargins("equity");
            if (equity != null) {
                result.add(mapMargin(equity, "equity"));
            }

            Margin commodity = kite.getMargins("commodity");
            if (commodity != null) {
                result.add(mapMargin(commodity, "commodity"));
            }

            return result;
        } catch (KiteException e) {
            throw new KiteAdapterException("Kite margins fetch failed: " + e.message, e);
        } catch (IOException e) {
            throw new KiteAdapterException("Network error fetching Kite margins", e);
        }
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

    private KiteConnect buildKiteConnect(String apiKey, String accessToken) {
        KiteConnect kite = new KiteConnect(apiKey);
        kite.setAccessToken(accessToken);
        return kite;
    }

    private OrderParams mapToOrderParams(Map<String, Object> params) {
        OrderParams op = new OrderParams();
        op.tradingsymbol   = (String) params.get("symbol");
        op.exchange        = (String) params.get("exchange");
        op.transactionType = (String) params.get("transactionType");    // "BUY" / "SELL"
        op.orderType       = mapOrderType((String) params.get("orderType"));
        op.product         = (String) params.get("product");            // "CNC" / "MIS" / "NRML"
        op.quantity        = (Integer) params.get("quantity");

        if (params.get("price") instanceof BigDecimal bd) {
            op.price = bd.doubleValue();
        }
        if (params.get("triggerPrice") instanceof BigDecimal bd) {
            op.triggerPrice = bd.doubleValue();
        }

        op.validity = params.get("validity") != null ? (String) params.get("validity") : "DAY";
        op.tag      = (String) params.get("tag");
        return op;
    }

    /**
     * Maps platform order type to Kite's expected string values.
     * Kite uses "SL-M" (with hyphen), while our enum uses SL_M (underscore).
     */
    private String mapOrderType(String orderType) {
        if (orderType == null) return "MARKET";
        return switch (orderType.toUpperCase()) {
            case "SL_M" -> "SL-M";
            default     -> orderType.toUpperCase();
        };
    }

    private Map<String, Object> mapOrderToStatusMap(Order order) {
        Map<String, Object> map = new HashMap<>();
        map.put("orderId",         order.orderId);
        map.put("status",          order.status);
        map.put("statusMessage",   order.statusMessage);
        map.put("filledQuantity",  order.filledQuantity);
        map.put("averagePrice",    order.averagePrice);
        map.put("tradingsymbol",   order.tradingSymbol);
        map.put("exchange",        order.exchange);
        map.put("transactionType", order.transactionType);
        map.put("orderType",       order.orderType);
        map.put("product",         order.product);
        map.put("quantity",        order.quantity);
        map.put("price",           order.price);
        return map;
    }

    private PositionResponse mapPosition(Position p) {
        // SDK 3.1.1 Position has no average_price field — buyPrice used as best approximation
        return PositionResponse.builder()
                .symbol(p.tradingSymbol)
                .exchange(p.exchange)
                .product(p.product)
                .quantity(p.netQuantity)
                .overnightQuantity(p.overnightQuantity)
                .averagePrice(safeDecimal(p.buyPrice))
                .lastPrice(safeDecimal(p.lastPrice))
                .pnl(safeDecimal(p.pnl))
                .unrealisedPnl(safeDecimal(p.unrealised))
                .realisedPnl(safeDecimal(p.realised))
                .value(toBigDecimal(p.value))
                .buyPrice(safeDecimal(p.buyPrice))
                .sellPrice(safeDecimal(p.sellPrice))
                .buyQuantity(p.buyQuantity)
                .sellQuantity(p.sellQuantity)
                .build();
    }

    private MarginResponse mapMargin(Margin m, String segment) {
        // All Margin fields in SDK 3.1.1 are Strings — parsed safely below
        BigDecimal cash     = parseString(m.available != null ? m.available.cash          : null);
        BigDecimal payin    = parseString(m.available != null ? m.available.intradayPayin : null);
        BigDecimal debits   = parseString(m.utilised  != null ? m.utilised.debits         : null);
        BigDecimal net      = parseString(m.net);

        return MarginResponse.builder()
                .segment(segment)
                .available(cash)
                .payin(payin)
                .utilised(debits)
                .net(net)
                .liveBalance(BigDecimal.ZERO)    // not present in SDK 3.1.1
                .openingBalance(BigDecimal.ZERO) // not present in SDK 3.1.1
                .payout(BigDecimal.ZERO)         // not present in SDK 3.1.1
                .build();
    }

    private BigDecimal toBigDecimal(double value) {
        return BigDecimal.valueOf(value);
    }

    /** Safely converts a nullable Double (as returned by SDK 3.1.1 Position fields) to BigDecimal. */
    private BigDecimal safeDecimal(Double value) {
        return value != null ? BigDecimal.valueOf(value) : BigDecimal.ZERO;
    }

    /** Safely parses a nullable String (as returned by SDK 3.1.1 Margin fields) to BigDecimal. */
    private BigDecimal parseString(String value) {
        if (value == null || value.isBlank()) return BigDecimal.ZERO;
        try {
            return new BigDecimal(value);
        } catch (NumberFormatException e) {
            return BigDecimal.ZERO;
        }
    }

    private String maskKey(String key) {
        if (key == null || key.length() < 8) return "***";
        return key.substring(0, 4) + "****" + key.substring(key.length() - 4);
    }

    // ------------------------------------------------------------------
    // Exception
    // ------------------------------------------------------------------

    public static class KiteAdapterException extends RuntimeException {
        public KiteAdapterException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}
