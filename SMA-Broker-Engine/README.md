# SMA-Broker-Engine

**Port:** 9003
**Base package:** `com.sma.brokerengine`

## Responsibility

This service is the sole owner of all broker-facing trading operations:

- Broker authentication and session lifecycle (login / logout)
- Encrypted storage of API keys, API secrets, and access tokens (AES/GCM)
- Order placement, cancellation, and status retrieval
- Positions, portfolio, and margin queries
- Broker abstraction via `BrokerAdapter` interface — supports multiple brokers
- Kite (Zerodha) adapter implementation

## Boundaries (strict)

- Does NOT contain live market data or tick streaming — that is Data Engine
- Does NOT evaluate strategies or generate signals — that is Strategy Engine
- No other service should hold or manage broker credentials

## Package Structure

```
com.sma.brokerengine
  ├── adapter/              BrokerAdapter interface + BrokerAdapterRegistry
  │   └── kite/            KiteBrokerAdapter (only Kite SDK here)
  ├── config/              AppConfig, EncryptionConfig, GlobalExceptionHandler
  ├── controller/          BrokerAuthController, OrderController, PortfolioController, HealthController
  ├── entity/              BrokerAccount, OrderRecord
  ├── model/
  │   ├── request/         BrokerAuthRequest, PlaceOrderRequest, CancelOrderRequest
  │   └── response/        ApiResponse, BrokerAuthResponse, OrderResponse, PositionResponse, MarginResponse
  ├── repository/          BrokerAccountRepository, OrderRecordRepository
  ├── security/            TokenEncryptionService
  └── service/             BrokerAuthService, OrderService, PortfolioService
```

## Key Design Decisions

- `clientOrderId` enforces idempotency — the same ID never places two orders
- Order state is persisted as `PENDING` before the broker call, then updated after
- All sensitive fields encrypted before DB write, decrypted only at call time
- `BrokerAdapter` abstraction allows adding AngelOne, Fyers, etc. with no service changes
- Kite SDK types must not leak outside the `adapter/kite/` package

## Database

- PostgreSQL via Flyway migrations
- Tables: `broker_account`, `order_record`
- Required env vars: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `ENCRYPTION_SECRET_KEY`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/broker/auth/login | Exchange request token for access token |
| POST | /api/v1/broker/auth/logout | Invalidate stored token |
| POST | /api/v1/broker/orders | Place order (idempotent) |
| DELETE | /api/v1/broker/orders | Cancel order |
| GET | /api/v1/broker/orders/{clientOrderId} | Get order status |
| GET | /api/v1/broker/orders?userId=&brokerName= | List orders for account |
| GET | /api/v1/broker/portfolio/positions | Get open positions |
| GET | /api/v1/broker/portfolio/margins | Get margin data |
| GET | /api/v1/broker/health | Health check |
