# ND Tutor

**ND Tutor** is an interactive developer coaching laboratory and curriculum runner for ND. It guides engineers through structured, hands-on programming courses with daily 30-minute lessons, diagnostic questions, exercises, escalating hints, spaced retrieval reviews, progress tracking, and integration with the ND AI chat agent.

ND Tutor is designed with an **extensible multi-track architecture**:
- **Track 1 (Shipped): Spring Boot & PostgreSQL DB Lab** — 28 days of production data engineering, schema design, PostgreSQL invariants, MyBatis, Flyway migrations, and concurrency safety for full-stack developers.
- **Future Tracks:** Next.js & Distributed DB, Go & SQLite Microservices, Docker & Kubernetes Reliability.

---

## What is Inside the Spring Boot & PostgreSQL Track?

The 28 lessons are grouped into four 1-week milestones:

1. **Week 1 (Days 1–7): Schema Design & DB Invariants**
   - What makes a row valid, types, defaults, server-side constraints
   - CRUD & safe `WHERE` clauses, `RETURNING`
   - Primary keys, surrogate vs natural keys, uniqueness
   - Foreign keys & referential integrity
   - Many-to-many relationships & `ON DELETE` actions
   - Normalization & update anomalies
   - Schema design defense & ERD

2. **Week 2 (Days 8–14): Query Mastery & Plan Inspection**
   - Filtering, `ORDER BY`, `NULL` semantics
   - `INNER` and `LEFT JOIN`s, missing relationships
   - Aggregations (`GROUP BY`, `HAVING`, `COUNT(*)`)
   - CTEs and subqueries
   - Keyset & stable pagination
   - B-tree indexes & selectivity
   - `EXPLAIN (ANALYZE, BUFFERS)` and query plans

3. **Week 3 (Days 15–21): Spring Boot, MyBatis & Flyway Migrations**
   - HikariCP pool & transaction boundaries
   - MyBatis mapper basics & parameter binding
   - API ↔ data boundary, DTO validation vs DB constraints
   - Flyway V1 versioned migrations & schema history
   - Flyway V2 safe column backfill
   - Flyway V3 relationship evolution
   - Migration incident drill & repair strategies

4. **Week 4 (Days 22–28): Concurrency, Data Safety & Capstone**
   - ACID & transaction rollback
   - Concurrency & optimistic locking (`version`)
   - Soft delete, timezone timestamps, audit trails
   - Expand/migrate/contract production deployments
   - Backup & restore verification (`pg_dump`, `pg_restore`)
   - Slow query & pool troubleshooting
   - Todo database capstone project

---

## 30-Minute Daily Rhythm

Each daily lesson is structured for focused, bite-sized learning:
- **3 min**: Spaced retrieval recall from earlier lessons
- **7 min**: Tiny demonstration of the new concept
- **15 min**: Hands-on learner task (SQL/schema/migration/test)
- **3 min**: Verification, trade-offs, and failure scenario
- **2 min**: Learning journal reflection

---

## Sandboxed Lab Environment

ND Tutor includes an isolated Docker Compose PostgreSQL sandbox (`assets/compose.yaml`):
- Binds strictly to loopback: `127.0.0.1:5433`
- Database: `todo_learning`
- User: `todo_student`
- Password: `local-dev-only`

You can launch it anytime from the UI by clicking **Docker Lab Setup** or running:
```powershell
docker compose -f assets/compose.yaml up -d
```

---

## Key Features

- **Theme Parity**: Native ND Quiet Graphite dark mode and light mode, matching the main app shell.
- **Escalating Hints**: 3 hints that guide thinking without spoiling the answer, plus optional worked solutions.
- **Spaced Retrieval Practice**: Lessons schedule review items (+1, +3, +7 days) to reinforce long-term memory.
- **Answer Scratchpad**: Built-in editor to draft SQL, schema definitions, or reasoning.
- **Open in ND Chat**: Launch an interactive coaching session in ND Chat with one click.
- **Live Teacher (Gemini 3.8 Live)**: Start a real-time voice + text coaching call routed through **ND Router** (`Google AI Studio` provider, `gemini-3.8-live` or `gemini-3.8-live-extended-thinking`). Features live captions, barge-in interruption, mic mute/meter, Socratic teacher tools (`show_hint`, `reveal_solution`, `record_score`), and one-click scratchpad sharing.
- **Khmer Mode (ភាសាខ្មែរ)**: Full dual-language toggle for Khmer explanations with English SQL identifiers.
