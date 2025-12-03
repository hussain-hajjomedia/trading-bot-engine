## 1. Product Goals & Core Value

- **Primary goal**: Help users consistently execute high-quality trades in crypto and gold using the engine, with **clear, actionable signals** and **excellent UX**.
- **Main features for v1**:
  - **Account & Auth**: Secure signup/login, email/password + optional OAuth, password reset.
  - **Signal Engine Integration**: Use existing indicators & logic to generate:
    - Entry price
    - Direction (long/short / buy/sell)
    - Stop loss
    - Multiple take profits (TP1, TP2, TP3)
    - Timeframe, instrument (e.g., BTCUSDT, XAUUSD)
    - Confidence score / risk level
  - **Real-Time Data**:
    - Crypto via **Binance** WebSocket/REST (OHLCV, orderbook snapshot if needed).
    - Gold via **TwelveData** (intraday + daily).
  - **Trade Recommendations Dashboard**:
    - Upcoming & active signals
    - Visual chart overlays (price + entries/SL/TPs)
    - PnL tracking per signal and overall performance.
  - **AI Copilot**:
    - Natural language explanation: “Why this trade?”, “What’s the risk?”, “How to size position?”
    - Q&A over **historical trades & performance** using vector search.
  - **User-Specific State**:
    - Favorite instruments, risk profile (conservative/balanced/aggressive)
    - Account currency & position sizing preferences.

- **Non-goals for first 7 days** (can be v2+):
  - Direct broker/exchange trade execution (API keys, order placement).
  - Social features (copy-trading, leaderboards).
  - Mobile app (native) – but design web to be mobile-responsive.

---

## 2. 7-Day Execution Plan

### Day 1 – Product Definition, Architecture, and Repo Setup

- **Objectives**:
  - Finalize product scope & non-negotiable features for v1.
  - Lock in tech stack & architecture.
  - Bootstrap monorepo & base tooling.

- **Tasks**:
  - **Product & trading definition**:
    - Write a short internal spec:
      - Supported instruments, timeframes, and the exact strategies to expose.
      - Risk management defaults (risk per trade, RR minimums).
    - Map the existing `api/indicators*.js`:
      - Identify what functions produce signals (input/output shape).
      - Decide which indicators/strategies are included in v1.
  - **Tech decisions**:
    - Confirm stack:
      - Next.js 15 (TypeScript, App Router)
      - Prisma + PostgreSQL (Supabase/Neon)
      - Auth.js
      - Tailwind + shadcn/ui
      - Redis (Upstash) – optional for v1, recommended.
      - OpenAI for AI.
    - Draw an architecture diagram (even rough, using Excalidraw or similar).
  - **Repo setup**:
    - Initialize Next.js app.
    - Configure:
      - TypeScript, ESLint, Prettier.
      - `env` handling (`.env.local`) with placeholders for:
        - DB URL
        - Binance API keys (if needed for private endpoints)
        - TwelveData API key
        - OpenAI API key
    - Add Prisma:
      - Initial schema with `User`, `UserProfile`, `Instrument`, `Signal`.
    - Create a `docker-compose.yaml` (optional) for local Postgres + Redis.

- **Deliverables**:
  - Updated repo with:
    - Next.js project skeleton.
    - Prisma schema (first draft).
    - Architecture & product spec documented (this file + an additional short `PRODUCT_SPEC.md` if needed).

---

### Day 2 – Auth, Database Schema, and Core Models

- **Objectives**:
  - Implement secure user authentication.
  - Define and migrate the full DB schema.
  - Set up basic user endpoints.

- **Tasks**:
  - **DB schema**:
    - Finalize Prisma models for:
      - `User`, `UserProfile`, `Instrument`, `Signal`, `SignalOutcome`, `UserTrade`, `AIExplanation`, `Embedding`.
    - Run migrations against local Postgres.
  - **Auth implementation**:
    - Integrate Auth.js / NextAuth:
      - Credentials provider (email/password).
      - (Optional) Google OAuth provider.
    - Implement:
      - Signup page & flow.
      - Login page & flow.
      - Protected routes middleware.
  - **User APIs**:
    - Implement `/api/user/me` to fetch current user & profile.
    - Implement `/api/user/profile` to update risk settings, etc.

- **Deliverables**:
  - Working signup/login/logout.
  - Database with created tables & migrations.
  - Ability for user to adjust basic profile settings.

---

### Day 3 – Market Data Integration & Signal Engine Wiring

- **Objectives**:
  - Ingest real-time & historical data from Binance & TwelveData.
  - Wrap your existing indicator engine into a callable service.
  - Store generated signals in the DB.

- **Tasks**:
  - **Binance integration**:
    - Implement a small data module:
      - REST client for historical candles (Klines).
      - WebSocket client for live ticks/candles for selected pairs.
    - Define a canonical OHLCV structure your engine expects.
  - **TwelveData integration**:
    - Implement client for gold (XAUUSD or equivalent).
    - Fetch intraday candles (e.g., 1m/5m/15m).
  - **Engine wiring**:
    - Create a `signal-engine` service (Node module) that:
      - Takes OHLCV data as input.
      - Calls your existing `indicators*.js` functions.
      - Produces one or more `Signal` objects (entry, SL, TP1–TP3, direction, etc.).
    - Add a background job (cron-like) to:
      - Periodically fetch the latest data (e.g., every minute).
      - Run the engine for:
        - Each instrument/timeframe combo you support.
      - Upsert new signals into the `signals` table.
  - **Basic verification**:
    - Seed DB with a few historical signals (from backtest or manual).

- **Deliverables**:
  - Background process that, when run, starts producing signals into DB.
  - Confirmed sample `signals` rows with realistic data.

---

### Day 4 – Signals & Dashboard UI (Core Frontend)

- **Objectives**:
  - Build a clean, modern dashboard UI.
  - Implement signal list & detail pages with charts and clear calls to action.

- **Tasks**:
  - **UI foundation**:
    - Integrate Tailwind CSS & shadcn/ui.
    - Define app-wide layout:
      - Top nav: logo, user menu.
      - Sidebar: watchlist, navigation.
      - Main content: dashboard.
  - **Signals APIs**:
    - Implement `/api/signals`:
      - Filtering: instrument, timeframe, status, pagination.
    - Implement `/api/signals/[id]`.
  - **Dashboard**:
    - “Today’s Signals” / “Active Signals” section.
    - For each signal card:
      - Instrument & timeframe.
      - Direction (visual arrow, color-coded).
      - Entry, SL, TPs, RR, confidence.
      - “Mark as taken” button -> creates `UserTrade`.
  - **Signal detail view**:
    - Chart for instrument:
      - Candles for recent period.
      - Overlays for entry, SL, TP lines.
    - Section for AI explanation (stubbed for now).

- **Deliverables**:
  - Logged-in user can:
    - See list of signals.
    - Click into a signal and view full details + chart.
    - Mark a signal as taken (creates a `UserTrade` entry).

---

### Day 5 – User Trades, Analytics, and AI Explanations

- **Objectives**:
  - Capture and display user trades and performance metrics.
  - Integrate AI for per-signal explanations.

- **Tasks**:
  - **User trades flow**:
    - Implement `/api/user-trades` (GET/POST).
    - On “Mark as taken”, ask user:
      - Entry price (pre-filled with recommended).
      - Position size (can be auto-suggested from profile).
    - Show:
      - Open trades, closed trades, PnL.
  - **PnL and outcomes**:
    - Implement basic logic to compute trade PnL from historical price data or manual input.
    - Fill `SignalOutcome` entries for completed signals:
      - Which TP/SL was hit.
  - **Stats endpoints**:
    - `/api/stats/overview`:
      - Win rate, avg RR, total PnL, number of trades.
    - `/api/stats/strategy` & `/api/stats/instrument` (can be minimal for v1).
  - **AI explanation integration**:
    - Implement `/api/ai/explain-signal`:
      - Construct prompt with:
        - Signal details (indicators, direction, RR).
        - User profile risk preference.
      - Call OpenAI / equivalent LLM.
      - Cache result in `AIExplanation`.
    - Frontend:
      - On signal detail, show explanation card:
        - 3–5 bullet points.
        - Emphasis on what to do and why.

- **Deliverables**:
  - User can:
    - Track trades they take from signals.
    - View high-level stats on their performance.
  - Each signal has an AI-generated explanation available on demand.

---

### Day 6 – Vector Search, AI Q&A, and UX Polish

- **Objectives**:
  - Enable semantic Q&A over historical trades & signals.
  - Refine UI to be extremely clear & intuitive.

- **Tasks**:
  - **Vector store setup**:
    - Enable `pgvector` in Postgres or set up external vector DB.
    - Create `embeddings` table.
  - **Embeddings pipeline**:
    - For each closed signal/trade:
      - Generate a text summary.
      - Create and store embedding.
    - Background job to keep embeddings up to date.
  - **AI Q&A API**:
    - Implement `/api/ai/qa`:
      - Embed user question.
      - Perform top-k vector search.
      - Feed retrieved items + question into LLM.
      - Return structured answer.
  - **Frontend Q&A widget**:
    - Add an “Ask the AI” widget on dashboard:
      - Example questions:
        - “How has BTC strategy performed in last 30 days?”
        - “What’s my win rate on gold trades with 2R+ targets?”
  - **UX polish**:
    - Add tooltips for SL/TP/RR.
    - Mobile responsiveness for key pages.
    - Loading/skeleton states for dashboard & charts.

- **Deliverables**:
  - Working AI Q&A over historical performance.
  - Polished, intuitive UI where a new user knows exactly what to do.

---

### Day 7 – Hardening, Compliance, and Launch Prep

- **Objectives**:
  - Harden security & privacy.
  - Add disclaimers & compliance basics.
  - Deploy to production and smoke test.

- **Tasks**:
  - **Security & privacy**:
    - Ensure:
      - Passwords are hashed (bcrypt/argon2).
      - JWT/session secrets are strong and stored in env.
      - Rate limiting on auth & AI routes.
    - Review all endpoints:
      - Ensure auth guard on user-specific routes.
  - **Compliance basics**:
    - Add **disclaimer** pages:
      - “Not financial advice”, “Past performance…”, risks of leverage.
    - Require user to accept terms on first login (store flag in DB).
  - **Monitoring & logging**:
    - Integrate Sentry for error tracking.
    - Add basic request logging (without sensitive data).
  - **Deployment**:
    - Deploy Next.js app to Vercel.
    - Deploy background worker (signal engine) to chosen provider.
    - Point production app to production DB.
  - **Smoke testing**:
    - Create 1–2 test users.
    - Walk through:
      - Register → login → set profile → view signals → mark trade taken → view stats → ask AI questions.
    - Fix any high-priority bugs.

- **Deliverables**:
  - Production deployment URL.
  - At least one full end-to-end user flow validated.
  - Ready-to-demo product.

---

## 3. High-Level Architecture & Tech Stack

- **Overall architecture**: Monorepo, TypeScript-first, with:
  - **Next.js App** (Next.js 15+ / App Router) as the **frontend + BFF** (Backend-for-Frontend).
  - **Background worker / engine service** (Node.js) to:
    - Ingest market data (Binance, TwelveData).
    - Run your indicator/strategy engine.
    - Store signals & outcomes.
  - **PostgreSQL** (preferably **Supabase** or **Neon**) with:
    - **TimescaleDB** extension for time-series (optional but recommended).
    - **pgvector** extension for vector search (or external vector DB).
  - **Vector store**:
    - Option A: `pgvector` inside PostgreSQL.
    - Option B: Managed vector DB like **Pinecone**, **Qdrant Cloud**, or **Weaviate Cloud**.
  - **Cache/message broker**:
    - **Redis** (Upstash or managed) for:
      - Pub/sub real-time updates to dashboard.
      - Caching live prices & signals.

- **Backend & APIs**:
  - **Next.js Route Handlers** (App Router) for:
    - REST-ish routes: `/api/signals`, `/api/user`, `/api/stats`, etc.
  - Optional: **tRPC** for typesafe client-server communication.

- **Auth & Security**:
  - **Auth.js / NextAuth** with:
    - Email/password + optional OAuth (Google) for frictionless signup.
    - JWT or session-based auth.
  - **RBAC** (role-based access control):
    - `user` vs `admin` roles.

- **Frontend & UI**:
  - **React 18+** with **Next.js App Router**.
  - **Tailwind CSS** + **shadcn/ui** for consistent, modern component library.
  - **Charting**:
    - **TradingView Lightweight Charts** or **Recharts** / **ECharts** for candlesticks & overlays.
  - **UX principles**:
    - “One-glance clarity” for:
      - What to trade
      - At what price
      - With which SL/TP levels
      - What action to take (buy/sell, close, move SL)

- **AI & Analytics**:
  - **LLM provider**: OpenAI (GPT-4.1 / GPT-4.1 mini or latest available) or equivalent.
  - **Use cases**:
    - Commentary & explanation for each signal.
    - Personalized risk advice based on user profile + signal history.
    - Q&A over historical trades using semantic search via vector store.

- **DevOps / Infra**:
  - **Hosting**:
    - Next.js app: **Vercel**.
    - Background worker: **Fly.io**, **Railway**, or **Render** (or a Vercel cron/function if light).
  - **Database**: Supabase / Neon / RDS.
  - **Monitoring**: Sentry (errors), Logtail/Datadog (logs).
  - **CI/CD**: GitHub Actions with:
    - Linting (ESLint)
    - Typechecking (TypeScript)
    - Basic test suite.

---

## 4. Data & Trading Logic Overview

- **Markets**:
  - **Crypto**:
    - Main pairs: BTCUSDT, ETHUSDT, plus 3–5 liquid altcoins.
    - Data: Binance REST (historical candles) + WebSocket (live ticks/candles).
  - **Gold**:
    - Symbol: XAUUSD or equivalent via TwelveData.
    - Data: TwelveData intraday (1m/5m/15m) + daily.

- **Strategies (example structure)**:
  - **Trend-following**: combine moving averages + higher timeframe confirmation.
  - **Mean reversion**: RSI, Bollinger Bands.
  - **Breakout**: price crossing key levels + volume spikes.
  - Your existing `indicators*.js` files will encapsulate the above logic.

- **Risk Management (recommended defaults)**:
  - **Risk per trade**: 0.5–2% of account equity.
  - **RR**: minimum 1.5–2.0 R per trade.
  - **Position sizing** formula:
    - Position size \( = \frac{\text{Account Equity} \times \text{Risk %}}{|\text{Entry} - \text{StopLoss}|} \)
  - These parameters become **user-configurable profile settings**.

---

## 5. Database & Data Model (Conceptual)

- **Core tables** (PostgreSQL + Prisma ORM):
  - **`users`**
    - `id`, `email`, `hashed_password`, `name`
    - `role` (`user` | `admin`)
    - `created_at`, `updated_at`
  - **`user_profiles`**
    - `user_id` (FK)
    - `risk_profile` (`conservative` | `balanced` | `aggressive`)
    - `base_currency` (`USD`, `USDT`, etc.)
    - `default_account_size` (optional, for calc)
  - **`instruments`**
    - `id`, `symbol` (e.g. `BTCUSDT`, `XAUUSD`)
    - `type` (`crypto` | `gold`)
    - `exchange` (`binance`, `twelvedata`)
  - **`signals`**
    - `id`, `instrument_id`
    - `timeframe` (e.g. `1m`, `5m`, `1h`, `4h`)
    - `direction` (`long` | `short` | `buy` | `sell`)
    - `entry_price`, `stop_loss`
    - `take_profit_1`, `take_profit_2`, `take_profit_3`
    - `confidence_score` (0–1 or 0–100)
    - `created_at`, `valid_until`
    - `engine_version`, `strategy_id`
  - **`signal_outcomes`**
    - `signal_id` (FK)
    - `tp_hit` (`0`, `1`, `2`, `3`)
    - `sl_hit` (boolean)
    - `max_favorable_excursion`, `max_adverse_excursion`
    - `closed_at`
  - **`user_trades`** (how the user interacts with signals)
    - `id`, `user_id`, `signal_id`
    - `chosen_entry_price` (can deviate from ideal)
    - `position_size`, `leverage` (if used)
    - `status` (`pending`, `open`, `closed`, `cancelled`)
    - `opened_at`, `closed_at`
    - `pnl_absolute`, `pnl_pct`
  - **`ai_explanations`** (optional, can be cached)
    - `signal_id`
    - `user_id` (optional if personalized)
    - `explanation_text`
    - `created_at`
  - **`embeddings`** (if using pgvector in Postgres)
    - `id`
    - `object_type` (`signal`, `trade_summary`, `market_note`)
    - `object_id`
    - `embedding` (vector)
    - `metadata` (JSONB)

- **Time-series OHLCV data**:
  - Option A: Store full candles in **TimescaleDB** (tables like `ohlcv_crypto`, `ohlcv_gold`).
  - Option B: Only store aggregated / sampled data you actually need (for PnL + charting).

---

## 6. API Design (Backend)

- **Auth & user**:
  - `POST /api/auth/register`
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `POST /api/auth/password-reset/request`
  - `POST /api/auth/password-reset/confirm`
  - `GET /api/user/me`
  - `PUT /api/user/profile`

- **Signals & trades**:
  - `GET /api/signals`
    - Query params: `instrument`, `timeframe`, `status` (`open`, `recent`, `all`), pagination.
  - `GET /api/signals/:id`
  - `POST /api/user-trades`
    - Body: `signal_id`, `entry_price`, `position_size`, `note`.
  - `GET /api/user-trades`
  - `GET /api/user-trades/:id`

- **Stats & analytics**:
  - `GET /api/stats/overview`
    - User-level: win rate, avg RR, total PnL.
  - `GET /api/stats/strategy`
    - Per-strategy performance.
  - `GET /api/stats/instrument`
    - Performance per symbol/timeframe.

- **AI**:
  - `POST /api/ai/explain-signal`
    - Body: `signal_id`, optional user context.
  - `POST /api/ai/qa`
    - Body: `query` (user question).

- **Market data**:
  - `GET /api/market/price?symbol=BTCUSDT`
  - `GET /api/market/chart?symbol=BTCUSDT&timeframe=1h&limit=200`

---

## 7. AI & Vector Search Design

- **Embeddings content**:
  - **Historical signals** (text summary per signal):
    - “BTCUSDT long on 1h trend-following, entry 64000, SL 63000, TP1 65000, TP2 66000, result TP2 hit, +3.2R”
  - **Aggregated trade summaries**:
    - Weekly/monthly performance per strategy, instrument, risk profile.
  - **User-specific notes**:
    - “User prefers low drawdown, cut risk from 2% to 1% after March.”

- **AI flows**:
  - **Explain signal**:
    1. Fetch signal + recent price context.
    2. Build prompt with:
       - Signal details & rationale features from the engine (indicators triggered).
       - User risk profile.
    3. Use LLM to generate a concise explanation (3–5 bullet points).
  - **Q&A over history**:
    1. Embed user query.
    2. Perform vector search over `embeddings` table.
    3. Feed top-k results to LLM to answer.

---

## 8. UX & UI Principles

- **Dashboard layout**:
  - **Top bar**: account info, risk profile toggle, quick settings.
  - **Left side**: watchlist (crypto & gold instruments).
  - **Center**: main chart with:
    - Candles
    - Entry line
    - SL/TP lines (colored, labeled)
  - **Right side**: current signal card:
    - Instrument, timeframe
    - Action: **Buy BTCUSDT at 64,250**
    - Entry, SL, TPs, RR
    - Confidence badge
    - “Execute” / “Mark as taken” button to create a `user_trade`.
  - **Bottom**: open trades & recent performance (PnL, win rate).

- **Clarity**:
  - Always answer:
    - **What to do now?** (Buy/Sell/Wait)
    - **At what price?**
    - **Where to set SL/TP?**
    - **What’s the risk & potential reward?**

---

## 9. Next Steps After the 7 Days (v1.1+)

- **Future improvements** (once v1 is stable):
  - Direct integration with exchanges/brokers for auto-execution.
  - Push notifications (email, Telegram, mobile) for new signals.
  - Strategy configuration (user chooses between different engines).
  - Multi-tenant teams, shared workspaces, and copy-trading features.
  - More advanced AI:
    - Personalized coaching.
    - Trade journal auto-analysis and mistake detection.




