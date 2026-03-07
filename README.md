# SMA Trading Platform

A Java Spring Boot microservices-based algorithmic trading platform.

---

## Services

| Service | Port | Responsibility |
|---|---|---|
| SMA-Broker-Engine | 9003 | Broker auth, sessions, orders, positions, margins |
| SMA-Execution-Engine | 9004 | Execution orchestration, risk checks, order intent |
| SMA-Data-Engine | 9005 | Live ticks, historical candles, replay, feed normalization |
| SMA-Strategy-Engine | 9006 | Signal generation, strategy evaluation |

---

## Service Responsibilities

### SMA-Broker-Engine (Port 9003)
- Broker authentication and session lifecycle management
- Access token storage and renewal (encrypted at rest)
- Broker abstraction via `BrokerAdapter` interface
- Order placement, cancellation, status retrieval
- Positions, portfolio, and margin queries
- Persists all broker interactions to PostgreSQL
- Owner of all broker-side trading operations

### SMA-Execution-Engine (Port 9004)
- Receives order intents from Strategy Engine
- Applies risk checks and execution rules
- Routes validated orders to Broker Engine
- Manages execution state and fills

### SMA-Data-Engine (Port 9005)
- Connects to Kite SDK for live market data
- Streams normalized ticks internally
- Fetches and stores historical OHLCV candles
- Replay and feed normalization
- Does NOT depend on Broker Engine

### SMA-Strategy-Engine (Port 9006)
- Evaluates trading strategies against normalized data
- Generates buy/sell/hold signals
- Publishes order intents to Execution Engine

---

## Architecture Notes

- Each service is an independent Spring Boot Maven project
- Services do NOT share code libraries — no shared module
- Broker Engine is the single owner of broker credentials and auth lifecycle
- Data Engine uses Kite SDK exclusively for market data — not Broker Engine
- Broker Engine does NOT contain live market data streaming logic
- Clean package separation: controller / service / adapter / entity / repository / model / security / config

---

## Tech Stack

- Java 17
- Spring Boot
- Maven
- PostgreSQL
- Flyway (Broker Engine)
- Spring Web, Spring Data JPA
- Lombok, Actuator, Validation

---

## Local Development

Each service requires its own `.env` or environment variables for database and secrets configuration.
Refer to each service's `application.yml` for required variables.
