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

---

## EC2 Deployment

### Prerequisites
- PEM key at `G:\AWS\sma-key.pem`
- EC2 instance at `13.63.53.146`
- Scripts `deploy.sh` and `restart.sh` in project root

### 1. Build JARs locally (Windows terminal)

```cmd
cd g:\SMA-claude-v2\SMA-Broker-Engine && mvn clean package -DskipTests
cd g:\SMA-claude-v2\SMA-Execution-Engine && mvn clean package -DskipTests
cd g:\SMA-claude-v2\SMA-Data-Engine && mvn clean package -DskipTests
cd g:\SMA-claude-v2\SMA-Strategy-Engine && mvn clean package -DskipTests
```

### 2. Upload JARs to EC2 (Git Bash)

```bash
# Upload all 4 services
bash G:/SMA-claude-v2/deploy.sh

# Upload specific services only
bash G:/SMA-claude-v2/deploy.sh data strategy
```

### 3. Upload restart script (first time only)

```bash
scp -i "G:/AWS/sma-key.pem" G:/SMA-claude-v2/restart.sh ubuntu@13.63.53.146:~/restart.sh
ssh -i "G:/AWS/sma-key.pem" ubuntu@13.63.53.146 "chmod +x ~/restart.sh"
```

### 4. Restart services on EC2

SSH into EC2, then:

```bash
# Restart all services (broker → data → execution → strategy)
~/restart.sh

# Restart specific services
~/restart.sh data strategy

# Restart a single service
~/restart.sh data
```

### 5. Check logs on EC2

```bash
tail -f ~/logs/broker.log
tail -f ~/logs/data.log
tail -f ~/logs/execution.log
tail -f ~/logs/strategy.log
```

### EC2 File Structure

```
~/
├── app/
│   ├── broker/    sma-broker-engine-0.0.1-SNAPSHOT.jar
│   ├── execution/ sma-execution-engine-0.0.1-SNAPSHOT.jar
│   ├── data/      sma-data-engine-0.0.1-SNAPSHOT.jar
│   └── strategy/  sma-strategy-engine-0.0.1-SNAPSHOT.jar
├── env/
│   ├── broker.env
│   ├── execution.env
│   ├── data.env
│   └── strategy.env
├── logs/
│   ├── broker.log
│   ├── execution.log
│   ├── data.log
│   └── strategy.log
└── restart.sh
```

---

## UI Deployment (Vercel)

The React UI (`SMA-UI/`) is deployed to [https://sma-cl-v2.vercel.app](https://sma-cl-v2.vercel.app).

- Vercel rewrites in `SMA-UI/vercel.json` proxy all `/api/*` requests to EC2 backends
- Environment variables are set in `SMA-UI/.env.production`
- Kite OAuth redirect URL must be set to `https://sma-cl-v2.vercel.app/callback` in the Kite developer console

To redeploy UI: push to `main` branch — Vercel auto-deploys.
