/**
 * Pure domain logic and curriculum catalog for ND Tutor.
 *
 * ES Module: No DOM dependencies, directly testable in Node via vitest/Node test runner
 * and importable in sandboxed web views.
 */

export const SPRINGBOOT_COURSE_ID = 'springboot-db-tutor'

export const SANDBOX_COMPOSE_YAML = `# Disposable local lab ONLY. Do not expose these credentials publicly.
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: todo_learning
      POSTGRES_USER: todo_student
      POSTGRES_PASSWORD: local-dev-only
    ports:
      - "127.0.0.1:5433:5432"
    volumes:
      - todo_learning_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U todo_student -d todo_learning"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  todo_learning_pgdata:
`

export const SANDBOX_SEED_SQL = `-- LOCAL LEARNING DB ONLY; run after you create the todos table.
INSERT INTO todos (title, description, status)
VALUES
  ('Learn NOT NULL', 'Explain why a blank string differs from NULL', 'OPEN'),
  ('Practice SQL WHERE', NULL, 'OPEN'),
  ('Check CHECK constraint', 'Predict an invalid status insert', 'DONE');

SELECT id, title, status, created_at FROM todos ORDER BY id;
`

export const QUICK_REFERENCE_SECTIONS = [
  {
    id: 'postgres-integrity',
    title: 'PostgreSQL Data Integrity',
    items: [
      'NOT NULL prevents missing values, but does NOT prevent empty strings (\'\'). Use CHECK (length(trim(title)) > 0) to enforce real text.',
      'CHECK (status IN (\'OPEN\', \'DONE\')) enforces valid states; a nullable status column still needs NOT NULL.',
      'PRIMARY KEY implies UNIQUE and NOT NULL identity.',
      'FOREIGN KEY (owner_id) REFERENCES users(id) guarantees referential integrity; it does NOT create an index automatically.',
      'TIMESTAMPTZ stores UTC instant; does not store timezone name.',
      'DEFAULT NOW() only executes on INSERT. PostgreSQL does NOT auto-update updated_at on UPDATE without an explicit column assignment or a trigger.',
    ],
  },
  {
    id: 'query-habits',
    title: 'Query & SQL Habits',
    items: [
      'Preview before mutating: run SELECT ... WHERE ... before any broad UPDATE or DELETE.',
      'Use RETURNING * or RETURNING id, updated_at to inspect mutations atomically.',
      'ORDER BY created_at DESC, id DESC provides deterministic pagination ordering; keyset pagination avoids LIMIT/OFFSET drift.',
      'EXPLAIN (ANALYZE, BUFFERS) runs the query. Caution: Running EXPLAIN ANALYZE on a DELETE or UPDATE executes the write!',
      'Foreign keys need indexes when parent rows are deleted with CASCADE or RESTRICT, or when querying children frequently by foreign key.',
    ],
  },
  {
    id: 'transactions',
    title: 'Transactions & Concurrency',
    items: [
      'Transactions group changes: BEGIN -> one or more writes -> COMMIT or ROLLBACK.',
      'PostgreSQL default isolation level is READ COMMITTED.',
      'Optimistic locking: UPDATE todos SET title = :t, version = version + 1 WHERE id = :id AND version = :v (check affected row count = 1).',
      'SELECT ... FOR UPDATE locks selected rows until transaction end; beware of deadlocks and lock contention.',
    ],
  },
  {
    id: 'flyway',
    title: 'Flyway Migrations',
    items: [
      'Migrations run in version order: V1__init.sql, V2__add_column.sql. Recorded in flyway_schema_history with checksums.',
      'NEVER edit an already-applied migration in shared or production environments. Always roll forward with a new versioned migration.',
      'Expand / Migrate / Contract pattern: add nullable column or safe default -> backfill data -> enforce NOT NULL after code deploy.',
      'Diagnose failed migrations forward: repair checksums or apply fix script, never flyway clean on valuable data.',
    ],
  },
  {
    id: 'spring-mybatis',
    title: 'Spring Boot & MyBatis',
    items: [
      'Controller: thin HTTP boundary, validation annotations (@Valid), and error response mapping.',
      'Service: transactional boundary (@Transactional), invariant orchestration.',
      'MyBatis Mapper: parameterized SQL with #{param}; never concatenate string input into SQL.',
      'HikariCP: bounded connection pool (e.g. maximumPoolSize=10). More connections do not equal faster SQL.',
      'DTO validation and DB constraints are complementary: client validation provides fast UX, DB constraints protect data safety.',
    ],
  },
  {
    id: 'backup-restore',
    title: 'Backup & Disaster Recovery',
    items: [
      'pg_dump creates logical backups. Format: plain SQL (-Fp) or custom tar/directory (-Fc).',
      'A backup is NOT verified until restored into a separate test database and validated with row count & constraint checks.',
      'Distinguish RPO (Recovery Point Objective - data loss window) and RTO (Recovery Time Objective - time to recover).',
      'Never overwrite a live database while practicing disaster recovery.',
    ],
  },
]

export const COURSES = [
  {
    id: SPRINGBOOT_COURSE_ID,
    title: 'Spring Boot & PostgreSQL DB Lab',
    tagline: 'Production Data Engineering for Frontend Engineers',
    description: 'Master backend data engineering through a real growing Todo application. Learn 80% PostgreSQL schema design, constraints, Flyway migrations, and concurrency safety, combined with 20% Spring Boot 3 & MyBatis mappers.',
    category: 'Backend & Data',
    totalDays: 28,
    active: true,
    weeks: [
      {
        week: 1,
        title: 'Schema Design & DB Invariants',
        focus: 'Build a trustworthy minimal schema; understand why constraints belong in PostgreSQL, not just React.',
        days: [1, 2, 3, 4, 5, 6, 7],
      },
      {
        week: 2,
        title: 'Query Mastery & Plan Inspection',
        focus: 'Query with confidence using JOINs, aggregations, and subqueries; inspect indexes and execution plans without guesswork.',
        days: [8, 9, 10, 11, 12, 13, 14],
      },
      {
        week: 3,
        title: 'Spring Boot, MyBatis & Migrations',
        focus: 'Connect Spring Boot to PostgreSQL, write explicit MyBatis mappers, and evolve tables safely with Flyway.',
        days: [15, 16, 17, 18, 19, 20, 21],
      },
      {
        week: 4,
        title: 'Concurrency, Data Safety & Capstone',
        focus: 'Handle transaction boundaries, optimistic locking, zero-downtime migrations, backups, and the Todo DB capstone.',
        days: [22, 23, 24, 25, 26, 27, 28],
      },
    ],
    lessons: [
      {
        day: 1,
        week: 1,
        topic: 'What makes a database row valid?',
        focus: 'Distinguish data types, NULL vs empty string, defaults, server-side invariants.',
        objective: 'Design a todos table with proper PostgreSQL types and constraints; predict invalid inserts.',
        khmerObjective: 'រចនាតារាង todos ជាមួយប្រភេទទិន្នន័យត្រឹមត្រូវ និង constraints ក្នុង PostgreSQL។',
        prerequisites: 'Basic SQL familiarity and understanding of client-side validation.',
        diagnostic: 'React validates a title before calling the API. Can the database safely assume every client follows that rule? Why?',
        khmerDiagnostic: 'React ពិនិត្យ title មុនពេលហៅ API។ តើ Database អាចសន្មតថា client ទាំងអស់អនុវត្តតាមច្បាប់នោះបានទេ? ហេតុអ្វី?',
        exercise: 'Design the todos table with columns: id (generated identity), title (mandatory text, max 200 chars), description (optional text), status (OPEN or DONE, default OPEN), created_at and updated_at (timestamps with timezone). Predict what happens if title is empty string \'\', if status is \'LATER\', and if description is omitted.',
        hints: [
          'Use bigint GENERATED ALWAYS AS IDENTITY or bigserial for the primary key.',
          'NOT NULL prevents NULL, but does NOT prevent blank strings \'\'. Consider a CHECK (length(trim(title)) > 0).',
          'Use TIMESTAMPTZ DEFAULT now() for timezone-aware timestamps.',
        ],
        solution: `CREATE TABLE todos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title varchar(200) NOT NULL CHECK (length(trim(title)) > 0),
  description text,
  status varchar(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);`,
        failureCase: 'A frontend bug submits { title: " " } with 3 spaces. Without CHECK (length(trim(title)) > 0), the database happily saves an empty invisible task.',
        rubric: 'Mastery requires choosing TIMESTAMPTZ, NOT NULL, CHECK on status, and recognizing that NOT NULL does not stop blank strings.',
        retrievalQuestions: [
          'Why does NOT NULL not prevent a blank string ""?',
          'What is the difference between TIMESTAMP and TIMESTAMPTZ in PostgreSQL?',
        ],
      },
      {
        day: 2,
        week: 1,
        topic: 'CRUD and safe WHERE clauses',
        focus: 'INSERT, SELECT, UPDATE, DELETE, predicates, and RETURNING.',
        objective: 'Perform precise mutations with RETURNING; explain the danger of WHERE-less writes.',
        khmerObjective: 'អនុវត្ត CRUD ជាមួយ RETURNING និងយល់ពីគ្រោះថ្នាក់នៃ UPDATE ដែលគ្មាន WHERE។',
        prerequisites: 'Day 1 table design.',
        diagnostic: 'What happens if you run UPDATE todos SET status = \'DONE\' without a WHERE clause in production?',
        khmerDiagnostic: 'តើមានអ្វីកើតឡើងបើ run UPDATE todos SET status = \'DONE\' ដោយគ្មាន WHERE?',
        exercise: 'Write SQL to: (1) Insert 3 todos with different statuses, (2) Update exactly one todo from OPEN to DONE and update updated_at = now() using RETURNING to inspect the changed row, (3) Select only OPEN tasks created in the last 24 hours.',
        hints: [
          'Use INSERT INTO todos (title, status) VALUES (...), (...), (...) to insert multiple rows in one query.',
          'PostgreSQL RETURNING allows you to return mutated columns immediately.',
          'PostgreSQL DEFAULT now() does NOT update updated_at automatically on UPDATE; you must assign updated_at = now() explicitly.',
        ],
        solution: `INSERT INTO todos (title, status) VALUES
  ('Setup Docker Compose', 'DONE'),
  ('Review constraints', 'OPEN'),
  ('Write MyBatis mapper', 'OPEN');

UPDATE todos
SET status = 'DONE', updated_at = now()
WHERE id = 2
RETURNING id, title, status, updated_at;

SELECT * FROM todos
WHERE status = 'OPEN' AND created_at >= now() - interval '24 hours';`,
        failureCase: 'Running an accidental UPDATE without WHERE in a shared database overwrites every user’s todo status to DONE.',
        rubric: 'Must include updated_at = now() on UPDATE and explain RETURNING benefits.',
        retrievalQuestions: [
          'Does PostgreSQL DEFAULT now() update automatically on UPDATE?',
          'How does RETURNING help avoid an extra SELECT query?',
        ],
      },
      {
        day: 3,
        week: 1,
        topic: 'Primary keys, uniqueness and identity',
        focus: 'Surrogate vs natural keys, UNIQUE constraints, and task codes.',
        objective: 'Model unique identifiers; decide whether duplicate titles should be allowed.',
        khmerObjective: 'រចនា Primary Key និង UNIQUE constraint សម្រាប់កិច្ចការ។',
        prerequisites: 'Days 1-2.',
        diagnostic: 'Should a user be allowed to have two tasks with the same title "Buy groceries"? Why or why not?',
        khmerDiagnostic: 'តើគួរអនុញ្ញាតឱ្យ user មាន title ដូចគ្នា "Buy groceries" ឬទេ? ហេតុអ្វី?',
        exercise: 'Add an external task code (e.g. TASK-101) to todos. Design a UNIQUE constraint for external_code. Explain how NULL interacts with UNIQUE in PostgreSQL.',
        hints: [
          'In PostgreSQL, multiple rows with NULL in a UNIQUE column do not violate uniqueness by default.',
          'Consider whether task codes should be case-sensitive or case-insensitive (e.g. unique index with LOWER(external_code)).',
        ],
        solution: `ALTER TABLE todos ADD COLUMN external_code varchar(32);
CREATE UNIQUE INDEX uq_todos_external_code ON todos (LOWER(external_code))
WHERE external_code IS NOT NULL;`,
        failureCase: 'Using task title as a UNIQUE constraint prevents users from ever adding recurring tasks with the same label.',
        rubric: 'Distinguishes surrogate ID from business code and explains NULL handling in UNIQUE indexes.',
        retrievalQuestions: [
          'In standard PostgreSQL, do two NULL values violate a UNIQUE constraint?',
          'Why is an auto-generated integer/UUID generally preferred as primary key over user-editable text?',
        ],
      },
      {
        day: 4,
        week: 1,
        topic: 'Users and foreign keys',
        focus: 'One-to-many relationship, referential integrity, and orphan prevention.',
        objective: 'Create users table and todos.owner_id foreign key; predict foreign key violations.',
        khmerObjective: 'បង្កើតតារាង users និង foreign key owner_id ក្នុង todos។',
        prerequisites: 'Days 1-3.',
        diagnostic: 'What prevents an application from inserting a todo assigned to a non-existent user_id 9999?',
        khmerDiagnostic: 'តើអ្វីការពារកុំឱ្យ insert todo ភ្ជាប់ទៅ user_id 9999 ដែលមិនមាន?',
        exercise: 'Create a users table (id, email, full_name, created_at). Add owner_id to todos as a FOREIGN KEY referencing users(id). Predict what happens if you insert a todo with owner_id = 999.',
        hints: [
          'FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE RESTRICT.',
          'Before making owner_id NOT NULL, what happens to existing todos that have no owner?',
        ],
        solution: `CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  full_name varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE todos ADD COLUMN owner_id bigint REFERENCES users(id) ON DELETE RESTRICT;`,
        failureCase: 'Adding NOT NULL owner_id to an existing table with rows fails immediately with null value error.',
        rubric: 'Selects ON DELETE RESTRICT or CASCADE intentionally and handles existing data compatibility.',
        retrievalQuestions: [
          'Does a PostgreSQL FOREIGN KEY automatically create an index on the child column?',
          'What is the difference between ON DELETE RESTRICT and ON DELETE CASCADE?',
        ],
      },
      {
        day: 5,
        week: 1,
        topic: 'Many-to-many relationships',
        focus: 'Tags, junction tables (todo_tags), composite keys, and delete cascades.',
        objective: 'Model many-to-many relationships cleanly with composite primary keys.',
        khmerObjective: 'រចនា many-to-many relationship ជាមួយ junction table និង composite key។',
        prerequisites: 'Day 4.',
        diagnostic: 'Can a todo have multiple tags and a tag belong to multiple todos? How is this represented in relational SQL?',
        khmerDiagnostic: 'តើ todo មួយអាចមាន tag ច្រើន ហើយ tag មួយអាចមាន todo ច្រើនបានទេ?',
        exercise: 'Design tags(id, name) and todo_tags(todo_id, tag_id). Define composite primary key and foreign key delete rules. Explain why ON DELETE CASCADE is appropriate for junction rows.',
        hints: [
          'PRIMARY KEY (todo_id, tag_id) on the junction table prevents duplicate tagging.',
          'If a todo is deleted, its junction rows in todo_tags should cascade delete.',
        ],
        solution: `CREATE TABLE tags (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(50) NOT NULL UNIQUE
);

CREATE TABLE todo_tags (
  todo_id bigint NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  tag_id bigint NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (todo_id, tag_id)
);`,
        failureCase: 'Without composite PK on todo_tags, a user can tag the same task "URGENT" ten times.',
        rubric: 'Uses composite primary key and deliberate delete cascade rules.',
        retrievalQuestions: [
          'Why is ON DELETE CASCADE usually safe on junction tables but dangerous on main entity tables?',
          'How does a composite primary key prevent duplicate link rows?',
        ],
      },
      {
        day: 6,
        week: 1,
        topic: 'Normalization and duplicate facts',
        focus: '1NF, 2NF, 3NF through real Todo schema examples; update anomalies.',
        objective: 'Detect and refactor duplicated strings (owner email, tag names) to prevent anomalies.',
        khmerObjective: 'ស្វែងយល់ពី Normalization និងកែសម្រួលទិន្នន័យស្ទួនដើម្បីការពារ update anomaly។',
        prerequisites: 'Days 1-5.',
        diagnostic: 'What anomaly happens if you store owner_email directly on every todo row instead of in a users table?',
        khmerDiagnostic: 'តើមានបញ្ហាអ្វីកើតឡើងបើទុក owner_email លើគ្រប់ row នៃ todos?',
        exercise: 'Explain what happens when a user updates their email if owner_email was stored on todos rows. Show how normalization to users(id, email) solves the update anomaly.',
        hints: [
          'Update anomaly: updating an email in one place leaves other tasks showing the old email.',
          'Deletion anomaly: deleting all todos might delete the only record of the user.',
        ],
        solution: `-- Normalized design:
-- Fact 1: User email belongs in users table only
-- Fact 2: Todo points to user by owner_id foreign key
UPDATE users SET email = 'new@example.com' WHERE id = 1;
-- All todos automatically reflect new owner email via JOIN!`,
        failureCase: 'Denormalized email requires UPDATE todos SET owner_email = ... across 10,000 rows, risking partial updates if interrupted.',
        rubric: 'Clearly articulates update, insertion, and deletion anomalies.',
        retrievalQuestions: [
          'What is an update anomaly?',
          'When is deliberate denormalization justified in production?',
        ],
      },
      {
        day: 7,
        week: 1,
        topic: 'Schema design review & defense',
        focus: 'ERD defense, data invariants checklist, and week 1 milestone.',
        objective: 'Defend the Week 1 schema against 4 invalid data test cases.',
        khmerObjective: 'ការពារ និងត្រួតពិនិត្យការរចនា Schema សប្តាហ៍ទី 1 ជាមួយករណី invalid data។',
        prerequisites: 'Days 1-6.',
        diagnostic: 'Can application code alone guarantee database integrity across concurrent background jobs, migrations, and direct SQL queries?',
        khmerDiagnostic: 'តើកូដ application តែមួយអាចធានា data integrity បានទេពេលមាន background jobs ឬ SQL ផ្ទាល់?',
        exercise: 'Review your complete Week 1 Todo ERD: users, todos, tags, todo_tags. Test your schema against 4 cases: (1) blank title, (2) invalid status, (3) orphan owner_id, (4) duplicate tag on same todo. Ensure all fail at the DB level.',
        hints: [
          'Write intentional failing INSERT statements to prove each constraint stops bad data.',
          'Verify that each failure message references the exact constraint name or violation type.',
        ],
        solution: `-- 1. Blank title -> fails CHECK
INSERT INTO todos (title) VALUES ('   ');
-- 2. Invalid status -> fails CHECK
INSERT INTO todos (title, status) VALUES ('Valid', 'ARCHIVED');
-- 3. Orphan owner -> fails FK
INSERT INTO todos (title, owner_id) VALUES ('Valid', 99999);
-- 4. Duplicate tag -> fails composite PK
INSERT INTO todo_tags (todo_id, tag_id) VALUES (1, 1), (1, 1);`,
        failureCase: 'Relying solely on frontend validation results in invalid rows whenever third-party webhooks or batch jobs write directly to the DB.',
        rubric: 'Successfully defends constraints with concrete counterexamples.',
        retrievalQuestions: [
          'Name 4 distinct PostgreSQL constraints used in Week 1.',
          'Why should constraints be verified with failing tests?',
        ],
      },
      {
        day: 8,
        week: 2,
        topic: 'Filtering, ORDER BY and NULL',
        focus: 'WHERE predicates, boolean logic, IS NULL vs = NULL, stable sorting.',
        objective: 'Write safe filtering and stable pagination sorting queries.',
        khmerObjective: 'សរសេរ Query filter និងតម្រៀបទិន្នន័យជាមួយ NULL ឱ្យបានត្រឹមត្រូវ។',
        prerequisites: 'Week 1 schema.',
        diagnostic: 'Why does SELECT * FROM todos WHERE description = NULL return 0 rows even when descriptions are NULL?',
        khmerDiagnostic: 'ហេតុអ្វី WHERE description = NULL មិនដំណើរការចំពោះ NULL?',
        exercise: 'Write a query to find all OPEN tasks for owner_id 1, ordered by due_at ASC NULLS LAST, then id ASC for stable sorting. Explain NULLS LAST.',
        hints: [
          'In SQL, NULL represents an unknown value. Comparisons with = NULL yield UNKNOWN, not TRUE. Use IS NULL or IS NOT NULL.',
          'Use NULLS FIRST or NULLS LAST to control where null dates appear.',
        ],
        solution: `SELECT id, title, status, due_at, created_at
FROM todos
WHERE owner_id = 1 AND status = 'OPEN'
ORDER BY due_at ASC NULLS LAST, id ASC;`,
        failureCase: 'Sorting by due_at alone without id tie-breaker results in unstable pagination where tasks jump between pages.',
        rubric: 'Uses IS NULL correctly and provides tie-breaker column for stable sort.',
        retrievalQuestions: [
          'Why does NULL = NULL evaluate to NULL/UNKNOWN rather than TRUE in SQL?',
          'What does NULLS LAST do in an ORDER BY clause?',
        ],
      },
      {
        day: 9,
        week: 2,
        topic: 'JOINs and missing rows',
        focus: 'INNER JOIN vs LEFT JOIN; finding users with zero tasks.',
        objective: 'Select related data without accidentally dropping empty or unassigned records.',
        khmerObjective: 'ប្រើ INNER JOIN និង LEFT JOIN ឱ្យបានត្រឹមត្រូវដោយមិនបាត់បង់ទិន្នន័យ។',
        prerequisites: 'Day 8.',
        diagnostic: 'When would an INNER JOIN drop users from your query results?',
        khmerDiagnostic: 'តើពេលណាដែល INNER JOIN ធ្វើឱ្យបាត់ user ចេញពីលទ្ធផល?',
        exercise: 'Write two queries: (1) INNER JOIN to get todos with owner email, (2) LEFT JOIN to list ALL users with their todo titles, including users who have created zero tasks.',
        hints: [
          'INNER JOIN requires a matching row on both sides.',
          'LEFT JOIN keeps all rows from the left table even when the right table has no match (fills with NULL).',
        ],
        solution: `-- 1. Todos with owners
SELECT t.id, t.title, u.email
FROM todos t
INNER JOIN users u ON t.owner_id = u.id;

-- 2. All users, even without todos
SELECT u.id, u.email, t.title AS todo_title
FROM users u
LEFT JOIN todos t ON t.owner_id = u.id;`,
        failureCase: 'A dashboard uses INNER JOIN to calculate user counts, completely hiding all newly signed-up users who have not created a task yet.',
        rubric: 'Explains the exact rows returned by INNER vs LEFT JOIN.',
        retrievalQuestions: [
          'What values appear in right-table columns when a LEFT JOIN has no match?',
          'How do you find users who have NEVER created a todo using LEFT JOIN?',
        ],
      },
      {
        day: 10,
        week: 2,
        topic: 'Aggregations, GROUP BY and COUNT',
        focus: 'GROUP BY, HAVING, and the critical difference between COUNT(*) and COUNT(col).',
        objective: 'Aggregate task statistics per user safely without miscounting zero rows.',
        khmerObjective: 'ប្រើ GROUP BY, HAVING និងយល់ពីភាពខុសគ្នារវាង COUNT(*) និង COUNT(col)។',
        prerequisites: 'Day 9.',
        diagnostic: 'What is the difference between COUNT(*) and COUNT(t.id) when using a LEFT JOIN?',
        khmerDiagnostic: 'តើ COUNT(*) និង COUNT(t.id) ខុសគ្នាយ៉ាងណាពេលប្រើ LEFT JOIN?',
        exercise: 'Write a query listing every user email and their total count of todos. Ensure users with zero todos show count 0, not 1! Add a HAVING clause to show only users with more than 5 open tasks.',
        hints: [
          'COUNT(*) counts the returned row itself (so a LEFT JOIN unmatched row counts as 1).',
          'COUNT(t.id) counts non-NULL values of t.id (unmatched yields NULL, correctly counting as 0!).',
        ],
        solution: `SELECT u.id, u.email, COUNT(t.id) AS todo_count
FROM users u
LEFT JOIN todos t ON t.owner_id = u.id
GROUP BY u.id, u.email;

SELECT u.id, u.email, COUNT(t.id) AS open_count
FROM users u
INNER JOIN todos t ON t.owner_id = u.id AND t.status = 'OPEN'
GROUP BY u.id, u.email
HAVING COUNT(t.id) > 5;`,
        failureCase: 'Dashboard reports that a new user has 1 todo because the developer wrote COUNT(*) with a LEFT JOIN.',
        rubric: 'Uses COUNT(t.id) on LEFT JOIN and explains the difference from COUNT(*).',
        retrievalQuestions: [
          'Why does COUNT(column) ignore NULL values?',
          'What is the difference between WHERE and HAVING?',
        ],
      },
      {
        day: 11,
        week: 2,
        topic: 'CTEs and subqueries',
        focus: 'WITH clause (Common Table Expressions), readability, subquery vs CTE.',
        objective: 'Write readable analytic queries using Common Table Expressions.',
        khmerObjective: 'សរសេរ Query ស្មុគស្មាញដោយប្រើ CTE (WITH clause)។',
        prerequisites: 'Day 10.',
        diagnostic: 'Why are CTEs often preferred over deeply nested subqueries for complex multi-step queries?',
        khmerDiagnostic: 'ហេតុអ្វី CTE ងាយស្រួលអានជាង nested subqueries ក្នុង SQL ស្មុគស្មាញ?',
        exercise: 'Using a CTE, find all users who have more open tasks than the average number of open tasks across all users.',
        hints: [
          'Step 1: CTE to calculate open task count per user.',
          'Step 2: CTE to calculate the average of those counts.',
          'Step 3: Main SELECT filtering where user count > average.',
        ],
        solution: `WITH user_open_counts AS (
  SELECT owner_id, COUNT(*) AS open_count
  FROM todos
  WHERE status = 'OPEN' AND owner_id IS NOT NULL
  GROUP BY owner_id
),
overall_avg AS (
  SELECT AVG(open_count) AS avg_open
  FROM user_open_counts
)
SELECT u.id, u.email, c.open_count, a.avg_open
FROM user_open_counts c
CROSS JOIN overall_avg a
INNER JOIN users u ON u.id = c.owner_id
WHERE c.open_count > a.avg_open;`,
        failureCase: 'Copying the same subquery three times into SELECT and WHERE clauses increases maintenance bugs when requirements change.',
        rubric: 'Structures CTE cleanly with clear aliases and accurate aggregation.',
        retrievalQuestions: [
          'What is the syntax for chaining multiple CTEs in a single query?',
          'Can a CTE reference an earlier CTE defined in the same WITH statement?',
        ],
      },
      {
        day: 12,
        week: 2,
        topic: 'Stable pagination and keyset',
        focus: 'OFFSET vs keyset (seek) pagination; page drift and performance.',
        objective: 'Implement keyset pagination to avoid missing or duplicate rows when items are added.',
        khmerObjective: 'អនុវត្ត Keyset Pagination ដើម្បីកុំឱ្យស្ទួនឬបាត់ទិន្នន័យពេលទំព័រផ្លាស់ប្តូរ។',
        prerequisites: 'Days 8, 11.',
        diagnostic: 'What happens in OFFSET 20 LIMIT 10 if a new task is inserted on page 1 while the user is reading?',
        khmerDiagnostic: 'តើមានអ្វីកើតឡើងចំពោះ OFFSET 20 បើមាន record ថ្មីត្រូវ insert លើ page 1?',
        exercise: 'Explain why OFFSET becomes slow on large datasets (e.g. OFFSET 1,000,000). Write a keyset pagination query using (created_at, id) < (:last_created_at, :last_id) ORDER BY created_at DESC, id DESC LIMIT 10.',
        hints: [
          'With OFFSET, the database must scan and discard all preceding rows.',
          'Keyset pagination filters directly on the last seen row using tuple comparison or indexed columns.',
        ],
        solution: `-- Fetch next page after (last_seen_created_at, last_seen_id)
SELECT id, title, created_at
FROM todos
WHERE (created_at, id) < (:last_created_at, :last_id)
ORDER BY created_at DESC, id DESC
LIMIT 10;`,
        failureCase: 'Infinite scroll using OFFSET causes users to see the exact same todo twice because an item was added at the top.',
        rubric: 'Explains offset scanning overhead and implements composite keyset comparison.',
        retrievalQuestions: [
          'Why does OFFSET N require reading N rows before returning results?',
          'Why must keyset pagination include a unique tie-breaker column like id?',
        ],
      },
      {
        day: 13,
        week: 2,
        topic: 'PostgreSQL indexes',
        focus: 'B-tree index, leftmost prefix rule, selectivity, composite indexes.',
        objective: 'Design an index for frequent filtering queries; explain index write overhead.',
        khmerObjective: 'រចនា Index សម្រាប់បង្កើនល្បឿន Query និងយល់ពី trade-off លើ Write។',
        prerequisites: 'Days 8-12.',
        diagnostic: 'Does adding an index on every single column make your database faster? What is the trade-off?',
        khmerDiagnostic: 'តើការដាក់ Index លើគ្រប់ column ធ្វើឱ្យ database លឿនឬទេ? តើមាន trade-off អ្វី?',
        exercise: 'Given the query SELECT * FROM todos WHERE owner_id = :uid AND status = :st ORDER BY created_at DESC, design the optimal composite index. Explain column ordering in the index.',
        hints: [
          'Place equality filter columns first (owner_id, status), followed by range / sort columns (created_at).',
          'Every index speeds up specific reads, but slows down INSERT, UPDATE, and DELETE and consumes disk RAM.',
        ],
        solution: `CREATE INDEX idx_todos_owner_status_created
ON todos (owner_id, status, created_at DESC);`,
        failureCase: 'Creating an index on (created_at, status, owner_id) cannot efficiently optimize a query filtering only on owner_id due to leftmost prefix rule.',
        rubric: 'Correctly orders columns in composite index (equality before sort) and notes write overhead.',
        retrievalQuestions: [
          'What is the leftmost prefix rule in B-tree indexes?',
          'Why do indexes slow down INSERT and DELETE operations?',
        ],
      },
      {
        day: 14,
        week: 2,
        topic: 'EXPLAIN and query plans',
        focus: 'EXPLAIN (ANALYZE, BUFFERS), sequential scan vs index scan, cost vs actual time.',
        objective: 'Read an execution plan before and after adding an index.',
        khmerObjective: 'អាន Query Execution Plan ជាមួយ EXPLAIN ANALYZE មុន និងក្រោយដាក់ Index។',
        prerequisites: 'Day 13.',
        diagnostic: 'Why might PostgreSQL choose a Sequential Scan even when an index exists on a tiny table with 10 rows?',
        khmerDiagnostic: 'ហេតុអ្វី PostgreSQL ជ្រើសរើស Seq Scan ទោះបីមាន Index លើតារាងតូច 10 rows?',
        exercise: 'Explain the difference between EXPLAIN and EXPLAIN ANALYZE. Why must you NEVER run EXPLAIN ANALYZE on a DELETE in production? Interpret Seq Scan vs Index Scan.',
        hints: [
          'EXPLAIN shows the planner\'s estimated cost without running the query.',
          'EXPLAIN ANALYZE actually executes the query to measure real execution time and buffer hits!',
          'On write queries (DELETE, UPDATE), EXPLAIN ANALYZE performs the write!',
        ],
        solution: `-- Safe read inspection:
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM todos WHERE owner_id = 1 AND status = 'OPEN';
-- On small tables, scanning sequential memory pages is faster than traversing B-tree root + leaf pages.`,
        failureCase: 'Developer tests EXPLAIN ANALYZE DELETE FROM users WHERE active = false in production, deleting 50,000 users while trying to "check the query plan".',
        rubric: 'Knows EXPLAIN ANALYZE executes writes and explains planner cost factors.',
        retrievalQuestions: [
          'What is the danger of running EXPLAIN ANALYZE on an UPDATE or DELETE?',
          'What is a Seq Scan versus an Index Scan?',
        ],
      },
      {
        day: 15,
        week: 3,
        topic: 'Spring PostgreSQL connection and pooling',
        focus: 'HikariCP, application.yml, datasource settings, transaction boundaries.',
        objective: 'Configure Spring Boot 3 connection pool and understand pool exhaustion.',
        khmerObjective: 'កំណត់ការតភ្ជាប់ Spring Boot ជាមួយ HikariCP និងស្វែងយល់ពី Connection Pool។',
        prerequisites: 'Week 2; basic Java/Spring understanding.',
        diagnostic: 'If 100 concurrent HTTP requests arrive and HikariCP maximumPoolSize is 10, what happens?',
        khmerDiagnostic: 'បើមាន 100 HTTP requests មកដល់ ហើយ HikariCP pool size មាន 10 តើមានអ្វីកើតឡើង?',
        exercise: 'Configure application.yml for PostgreSQL (port 5433, db todo_learning). Set maximum-pool-size: 10, connection-timeout: 30000. Explain connection leak risks when keeping long network calls inside @Transactional.',
        hints: [
          'spring.datasource.url: jdbc:postgresql://localhost:5433/todo_learning',
          'Holding a database connection open while waiting for a 3rd party HTTP API is a major pool exhaustion cause.',
        ],
        solution: `spring:
  datasource:
    url: jdbc:postgresql://localhost:5433/todo_learning
    username: todo_student
    password: local-dev-only
    hikari:
      maximum-pool-size: 10
      minimum-idle: 5
      connection-timeout: 30000
      idle-timeout: 600000`,
        failureCase: 'Calling an external payment gateway inside a @Transactional method holds a DB connection for 8 seconds, starving all other users.',
        rubric: 'Configures HikariCP properly and explains connection pool exhaustion dynamics.',
        retrievalQuestions: [
          'What is HikariCP connectionTimeout?',
          'Why should external REST API calls never be placed inside @Transactional methods?',
        ],
      },
      {
        day: 16,
        week: 3,
        topic: 'MyBatis SQL mapper basics',
        focus: 'Mapper interfaces, XML / annotations, #{param} safe binding vs \${param} injection.',
        objective: 'Write a MyBatis mapper for Todo operations with parameter binding.',
        khmerObjective: 'សរសេរ MyBatis Mapper ជាមួយ parameter binding (#{param}) ដើម្បីការពារ SQL Injection។',
        prerequisites: 'Day 15.',
        diagnostic: 'What is the critical security difference between #{title} and \${title} in MyBatis?',
        khmerDiagnostic: 'តើអ្វីជាភាពខុសគ្នាផ្នែកសុវត្ថិភាពរវាង #{title} និង \${title} ក្នុង MyBatis?',
        exercise: 'Write a Java TodoMapper interface with findById, findByOwnerId, insertTodo, updateStatus. Show why #{...} uses PreparedStatement parameter binding to eliminate SQL injection.',
        hints: [
          '#{param} binds parameters safely through JDBC PreparedStatement.',
          '\${param} performs direct string interpolation and is vulnerable to SQL injection.',
        ],
        solution: `@Mapper
public interface TodoMapper {
  @Select("SELECT * FROM todos WHERE id = #{id}")
  Optional<Todo> findById(@Param("id") Long id);

  @Insert("""
    INSERT INTO todos (title, description, status, owner_id)
    VALUES (#{title}, #{description}, #{status}, #{ownerId})
    RETURNING id
  """)
  @Options(useGeneratedKeys = true, keyProperty = "id")
  Long insert(Todo todo);

  @Update("UPDATE todos SET status = #{status}, updated_at = now() WHERE id = #{id}")
  int updateStatus(@Param("id") Long id, @Param("status") String status);
}`,
        failureCase: 'Using \${userInput} in search queries allows attackers to execute SELECT * FROM users; DROP TABLE todos; --.',
        rubric: 'Uses #{param} consistently and explains JDBC PreparedStatement protection.',
        retrievalQuestions: [
          'Why is string concatenation in SQL queries dangerous?',
          'What does useGeneratedKeys = true do in MyBatis?',
        ],
      },
      {
        day: 17,
        week: 3,
        topic: 'DTO validation and DB errors',
        focus: 'Jakarta @NotBlank vs DB constraints, DataIntegrityViolationException handling.',
        objective: 'Handle database constraint violations gracefully at the HTTP boundary.',
        khmerObjective: 'គ្រប់គ្រង Error នៅពេលបំពាន Database Constraint ក្នុង Spring Boot Controller។',
        prerequisites: 'Day 16.',
        diagnostic: 'If the frontend and backend DTO validation check title length, why do we still keep the CHECK constraint in PostgreSQL?',
        khmerDiagnostic: 'បើមាន Validation លើ DTO រួចហើយ ហេតុអ្វីនៅតែត្រូវដាក់ CHECK ក្នុង Database?',
        exercise: 'Create CreateTodoRequest DTO with validation annotations. Write an @ExceptionHandler in Spring Boot for DataIntegrityViolationException that maps foreign key or unique violations to HTTP 409 Conflict.',
        hints: [
          'Dual defense: DTO validation provides friendly 400 Bad Request responses; DB constraints provide invariant safety.',
          'Catch org.springframework.dao.DataIntegrityViolationException in @RestControllerAdvice.',
        ],
        solution: `@RestControllerAdvice
public class GlobalExceptionHandler {
  @ExceptionHandler(DataIntegrityViolationException.class)
  public ResponseEntity<ErrorResponse> handleConflict(DataIntegrityViolationException ex) {
    return ResponseEntity.status(HttpStatus.CONFLICT)
      .body(new ErrorResponse("DATA_INTEGRITY_VIOLATION", "Resource conflict or constraint violation"));
  }
}`,
        failureCase: 'Relying only on DTO validation fails when two users register the same email concurrently, producing an unhandled 500 error instead of 409.',
        rubric: 'Differentiates input validation from database invariants and handles DB exceptions gracefully.',
        retrievalQuestions: [
          'What HTTP status code should be returned on a duplicate unique key violation?',
          'Why can concurrent requests bypass application-level uniqueness checks?',
        ],
      },
      {
        day: 18,
        week: 3,
        topic: 'Flyway V1 and schema history',
        focus: 'Versioned migrations, flyway_schema_history, checksums, forward-only strategy.',
        objective: 'Create Flyway V1 migration and understand schema checksum verification.',
        khmerObjective: 'បង្កើត Flyway V1 migration និងស្វែងយល់ពី flyway_schema_history និង checksum។',
        prerequisites: 'Days 1-7, 15-17.',
        diagnostic: 'What happens if you edit an existing V1__init.sql file after it has already run on a team member\'s machine or production?',
        khmerDiagnostic: 'តើមានអ្វីកើតឡើងបើកែ V1__init.sql ក្រោយពេលវា run រួចហើយ?',
        exercise: 'Write V1__create_users_and_todos.sql. Place it in src/main/resources/db/migration/. Explain how Flyway uses checksums in flyway_schema_history to detect file tampering.',
        hints: [
          'Flyway names: V<version>__<description>.sql (two underscores!).',
          'Flyway records script name, checksum, installed_on, and success boolean.',
        ],
        solution: `-- V1__create_users_and_todos.sql
CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email varchar(255) NOT NULL UNIQUE,
  full_name varchar(100) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE todos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title varchar(200) NOT NULL CHECK (length(trim(title)) > 0),
  description text,
  status varchar(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE')),
  owner_id bigint REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);`,
        failureCase: 'Developer edits V1 to add a column; production startup crashes with Flyway checksum mismatch error.',
        rubric: 'Creates valid V1 script and explains checksum verification mechanics.',
        retrievalQuestions: [
          'Why does Flyway fail startup when a applied migration file is edited?',
          'What table does Flyway use to track applied migrations?',
        ],
      },
      {
        day: 19,
        week: 3,
        topic: 'Flyway V2 and column backfill',
        focus: 'Adding columns safely, compatible defaults, staged backfills for existing rows.',
        objective: 'Add a priority column to existing todos without failing on historical data.',
        khmerObjective: 'បន្ថែម Column ថ្មី (priority) និង backfill ទិន្នន័យចាស់ដោយសុវត្ថិភាពក្នុង Flyway V2។',
        prerequisites: 'Day 18.',
        diagnostic: 'Why does adding a NOT NULL column without a DEFAULT fail on a table that already contains 10,000 rows?',
        khmerDiagnostic: 'ហេតុអ្វី ADD COLUMN ... NOT NULL គ្មាន DEFAULT នឹង fail បើតារាងមានទិន្នន័យស្រាប់?',
        exercise: 'Write V2__add_todo_priority.sql to add priority varchar(10) with values LOW, MEDIUM, HIGH. Use compatible default or staged backfill so existing rows remain valid.',
        hints: [
          'Option A: ADD COLUMN priority varchar(10) NOT NULL DEFAULT \'MEDIUM\' CHECK (priority IN (\'LOW\', \'MEDIUM\', \'HIGH\')).',
          'In PostgreSQL 11+, ADD COLUMN with constant DEFAULT is instantaneous metadata-only change!',
        ],
        solution: `-- V2__add_todo_priority.sql
ALTER TABLE todos
ADD COLUMN priority varchar(10) NOT NULL DEFAULT 'MEDIUM'
CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH'));`,
        failureCase: 'Running ALTER TABLE todos ADD COLUMN priority varchar(10) NOT NULL; without default crashes because existing rows become null.',
        rubric: 'Uses safe default and constraint for backward compatibility.',
        retrievalQuestions: [
          'How does PostgreSQL 11+ optimize ALTER TABLE ADD COLUMN with DEFAULT?',
          'What is a backfill in database engineering?',
        ],
      },
      {
        day: 20,
        week: 3,
        topic: 'Flyway V3 and FK evolution',
        focus: 'Adding relationships, handling orphaned data before adding constraints.',
        objective: 'Add tags and todo_tags via V3; stage foreign keys safely.',
        khmerObjective: 'បន្ថែមតារាង tags និង todo_tags តាមរយៈ Flyway V3។',
        prerequisites: 'Days 5, 18-19.',
        diagnostic: 'What must you verify about existing data before adding an ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY?',
        khmerDiagnostic: 'តើត្រូវពិនិត្យអ្វីខ្លះលើទិន្នន័យចាស់ មុនពេលបន្ថែម Foreign Key constraint?',
        exercise: 'Write V3__create_tags_and_relationships.sql creating tags and todo_tags. Explain why creating new tables is generally zero-risk for existing queries.',
        hints: [
          'New tables don\'t alter existing table rows or locks.',
          'Include index on todo_tags(tag_id) to make queries by tag fast.',
        ],
        solution: `-- V3__create_tags_and_relationships.sql
CREATE TABLE tags (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(50) NOT NULL UNIQUE
);

CREATE TABLE todo_tags (
  todo_id bigint NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  tag_id bigint NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (todo_id, tag_id)
);

CREATE INDEX idx_todo_tags_tag_id ON todo_tags (tag_id);`,
        failureCase: 'Failing to index the secondary foreign key (tag_id) causes queries filtering by tag to perform full table scans.',
        rubric: 'Includes indexes on foreign keys and validates cascade rules in migration.',
        retrievalQuestions: [
          'Why should the foreign key referencing tags have an index in todo_tags?',
          'Does adding a brand-new table lock existing tables?',
        ],
      },
      {
        day: 21,
        week: 3,
        topic: 'Diagnosing failed migrations',
        focus: 'Incident handling, checksum repair, flyway_schema_history, forward-fix strategy.',
        objective: 'Diagnose and resolve a migration failure without data loss; never run flyway clean.',
        khmerObjective: 'ដោះស្រាយបញ្ហាពេល Flyway Migration ជួប Error ដោយមិនឱ្យបាត់បង់ទិន្នន័យ។',
        prerequisites: 'Days 18-20.',
        diagnostic: 'Why is running "flyway clean" forbidden in shared development and production environments?',
        khmerDiagnostic: 'ហេតុអ្វីហាមដាច់ខាតមិនឱ្យប្រើ "flyway clean" លើ Database ផលិតកម្ម ឬ Dev រួម?',
        exercise: 'Simulate a migration failure where a typo caused V4 to fail midway. Explain how to inspect flyway_schema_history (success = false), fix the SQL, and use flyway repair or manual cleanup to roll forward safely.',
        hints: [
          'flyway clean drops ALL objects in the database schemas! Never run on real data.',
          'Inspect: SELECT * FROM flyway_schema_history WHERE success = false.',
        ],
        solution: `-- Diagnostic steps:
SELECT installed_rank, version, description, success FROM flyway_schema_history;
-- If failed, roll forward:
-- 1. Undo any partial DDL if not in a transaction
-- 2. DELETE FROM flyway_schema_history WHERE version = '4' AND success = false;
-- 3. Fix the migration script typo
-- 4. Re-run migration cleanly`,
        failureCase: 'Panicked developer runs flyway clean on staging, wiping weeks of testing data and seed datasets.',
        rubric: 'Rejects flyway clean, inspects schema history table, and explains forward repair steps.',
        retrievalQuestions: [
          'What happens when flyway clean is executed?',
          'How do transactional DDL databases (like PostgreSQL) help during failed migrations?',
        ],
      },
      {
        day: 22,
        week: 4,
        topic: 'ACID and rollback',
        focus: 'Atomicity, Consistency, Isolation, Durability; @Transactional rollback boundaries.',
        objective: 'Write atomic multi-step mutations; prove rollback on failure.',
        khmerObjective: 'យល់ច្បាស់ពី ACID និងធានា Rollback ពេលប្រតិបត្តិការបរាជ័យ។',
        prerequisites: 'Week 3.',
        diagnostic: 'If Step 1 updates a task and Step 2 inserts an audit log that throws an exception, what happens without @Transactional?',
        khmerDiagnostic: 'បើជំហាន 1 update task ហើយជំហាន 2 insert audit log បរាជ័យ តើមានអ្វីកើតឡើងបើគ្មាន @Transactional?',
        exercise: 'Write a Spring service method that transfers a todo to a new project and inserts a task_events log in the same transaction. Show that if an unchecked exception occurs, both steps roll back completely.',
        hints: [
          'By default in Spring, @Transactional rolls back on unchecked (RuntimeException / Error), not checked exceptions.',
          'Atomicity guarantees all changes commit together or none do.',
        ],
        solution: `@Service
public class TodoService {
  @Transactional
  public void transferTodo(Long todoId, Long targetProjectId) {
    todoMapper.updateProject(todoId, targetProjectId);
    eventMapper.insertEvent(new TaskEvent(todoId, "TRANSFERRED", targetProjectId));
    // If anything fails here, PostgreSQL rolls back BOTH writes!
  }
}`,
        failureCase: 'Without transactions, task is moved to new project but audit log fails, leaving permanent inconsistency in financial or audit logs.',
        rubric: 'Explains each letter of ACID and Spring @Transactional rollback rules.',
        retrievalQuestions: [
          'What does Atomicity mean in ACID?',
          'Which exception types trigger @Transactional rollback by default in Spring?',
        ],
      },
      {
        day: 23,
        week: 4,
        topic: 'Concurrency and optimistic locking',
        focus: 'Lost update problem, version column, optimistic lock pattern, SELECT FOR UPDATE.',
        objective: 'Prevent silent overwrites when two users edit the same task concurrently.',
        khmerObjective: 'ការពារ Lost Update ដោយប្រើ Optimistic Locking (version column)។',
        prerequisites: 'Day 22.',
        diagnostic: 'User A and User B open the same task. User A edits title; User B edits description. User B saves 1 second after User A. What happens without concurrency controls?',
        khmerDiagnostic: 'User A និង B បើក task ដូចគ្នា។ A កែ title ហើយ B កែ description រួច save ក្រោយ A។ តើមានអ្វីកើតឡើង?',
        exercise: 'Add a version int NOT NULL DEFAULT 0 column to todos. Write an UPDATE query that increments version and verifies version = :expectedVersion. Check affected row count in MyBatis/Spring.',
        hints: [
          'UPDATE todos SET title = :t, version = version + 1 WHERE id = :id AND version = :v;',
          'If affected rows == 0, another user modified the row first! Throw OptimisticLockingFailureException.',
        ],
        solution: `ALTER TABLE todos ADD COLUMN version int NOT NULL DEFAULT 0;

-- MyBatis mapper:
-- UPDATE todos SET title = #{title}, version = version + 1 WHERE id = #{id} AND version = #{version}

if (updatedRows == 0) {
  throw new OptimisticLockException("Task was modified by another user. Please refresh.");
}`,
        failureCase: 'Lost update: User B\'s save silently wipes out User A\'s edits without any warning.',
        rubric: 'Explains lost update problem and checks affected row count = 1.',
        retrievalQuestions: [
          'What is the lost update problem?',
          'How does checking the affected row count detect a concurrent modification?',
        ],
      },
      {
        day: 24,
        week: 4,
        topic: 'Soft delete, timestamps and audit trails',
        focus: 'Hard vs soft delete, deleted_at, immutable audit logs, timezone safety.',
        objective: 'Design data retention and soft delete policies with audit trail.',
        khmerObjective: 'រចនា Soft Delete (deleted_at) និង Audit Log សម្រាប់រក្សាប្រវត្តិទិន្នន័យ។',
        prerequisites: 'Days 22-23.',
        diagnostic: 'Why does soft delete complicate UNIQUE constraints (e.g. unique external_code or email)?',
        khmerDiagnostic: 'ហេតុអ្វី Soft Delete ធ្វើឱ្យពិបាកគ្រប់គ្រង UNIQUE constraints?',
        exercise: 'Add deleted_at timestamptz to todos. Update UNIQUE constraint so only non-deleted tasks must have unique external_code using a partial index (WHERE deleted_at IS NULL).',
        hints: [
          'Partial index: CREATE UNIQUE INDEX uq_todos_code_active ON todos (external_code) WHERE deleted_at IS NULL;',
          'A soft-deleted task can be restored or reused without violating active uniqueness.',
        ],
        solution: `ALTER TABLE todos ADD COLUMN deleted_at timestamptz;

-- Partial unique index:
CREATE UNIQUE INDEX uq_todos_external_code_active
ON todos (external_code)
WHERE deleted_at IS NULL AND external_code IS NOT NULL;`,
        failureCase: 'Standard UNIQUE constraint prevents user from re-creating a task with the same code after soft-deleting the old one.',
        rubric: 'Uses partial index for soft delete uniqueness and explains trade-offs.',
        retrievalQuestions: [
          'What is a partial index in PostgreSQL?',
          'Why is soft delete often preferred over DELETE in business applications?',
        ],
      },
      {
        day: 25,
        week: 4,
        topic: 'Expand/migrate/contract production changes',
        focus: 'Zero-downtime database migrations, deployment ordering, backward compatibility.',
        objective: 'Execute a non-breaking column migration across multi-instance rolling deploys.',
        khmerObjective: 'អនុវត្ត Zero-Downtime Migration តាមក្បួន Expand, Migrate, Contract។',
        prerequisites: 'Days 18-21, 24.',
        diagnostic: 'During a rolling deployment, both old App V1 and new App V2 run simultaneously for 15 minutes. What happens if you drop or rename a column in the database?',
        khmerDiagnostic: 'ពេល Deploy មាន App V1 និង V2 run ដំណាលគ្នា។ តើមានអ្វីកើតឡើងបើ rename column ភ្លាមៗ?',
        exercise: 'Outline the 3-phase Expand, Migrate, Contract process to rename a column or change a column from nullable to NOT NULL without any downtime.',
        hints: [
          'Phase 1 (Expand): Add new column, make nullable, deploy app code that reads new/old and writes to both.',
          'Phase 2 (Migrate): Backfill historical rows in background batch.',
          'Phase 3 (Contract): Make column NOT NULL, remove old column reference from code, drop old column.',
        ],
        solution: `Phase 1 (Expand):
  - DB: Add new_col (nullable)
  - App: Write to both old_col and new_col; read from new_col (fallback old_col)
Phase 2 (Migrate):
  - DB: UPDATE table SET new_col = old_col WHERE new_col IS NULL;
Phase 3 (Contract):
  - DB: Add NOT NULL to new_col
  - App: Remove references to old_col
  - DB: Drop old_col`,
        failureCase: 'Renaming a column directly in V4 immediately breaks all active old instances of the application during deployment.',
        rubric: 'Clearly defines Expand, Migrate, Contract phases and deployment sequence.',
        retrievalQuestions: [
          'Why must new columns be nullable or have safe defaults during rolling deployments?',
          'What is the risk of dropping a column before all application instances are updated?',
        ],
      },
      {
        day: 26,
        week: 4,
        topic: 'Backup and restore verification',
        focus: 'pg_dump, pg_restore, disaster recovery, RPO vs RTO.',
        objective: 'Perform and verify a database backup in an isolated test database.',
        khmerObjective: 'អនុវត្ត Backup និង Restore ជាមួយ pg_dump និងផ្ទៀងផ្ទាត់ទិន្នន័យ។',
        prerequisites: 'Days 1-25.',
        diagnostic: 'Why is an unverified backup considered "no backup at all"?',
        khmerDiagnostic: 'ហេតុអ្វី Backup ដែលមិនបានសាក Restore ត្រូវចាត់ទុកថាគ្មានតម្លៃ?',
        exercise: 'Write pg_dump command to back up todo_learning in custom format (-Fc). Write pg_restore command to restore to a separate test database todo_test. Verify row counts.',
        hints: [
          'pg_dump -U todo_student -h 127.0.0.1 -p 5433 -Fc -d todo_learning -f backup.dump',
          'pg_restore -U todo_student -h 127.0.0.1 -p 5433 -d todo_test backup.dump',
          'Never restore over an existing database to test a backup!',
        ],
        solution: `# 1. Dump to custom archive
pg_dump -h 127.0.0.1 -p 5433 -U todo_student -Fc todo_learning -f todo_backup.dump

# 2. Restore to isolated test db
createdb -h 127.0.0.1 -p 5433 -U todo_student todo_test
pg_restore -h 127.0.0.1 -p 5433 -U todo_student -d todo_test todo_backup.dump

# 3. Verification query
SELECT count(*) FROM todo_test.public.todos;`,
        failureCase: 'Company discovered their automated backups were corrupted for 6 months only after production hardware failure occurred.',
        rubric: 'Uses custom format (-Fc) and restores to a separate test DB for verification.',
        retrievalQuestions: [
          'What is RPO (Recovery Point Objective)?',
          'What is RTO (Recovery Time Objective)?',
        ],
      },
      {
        day: 27,
        week: 4,
        topic: 'Slow query and pool troubleshooting',
        focus: 'Query triage, pg_stat_activity, lock contention, pool sizing.',
        objective: 'Diagnose a slow endpoint using database statistics and query plans.',
        khmerObjective: 'ដោះស្រាយបញ្ហា Query យឺត និង Connection Pool ជាប់គាំង (Lock / Starvation)។',
        prerequisites: 'Days 13-15, 23, 26.',
        diagnostic: 'How do you check what queries are currently running and which ones are blocked in PostgreSQL?',
        khmerDiagnostic: 'តើធ្វើដូចម្តេចដើម្បីពិនិត្យ Query ដែលកំពុង run ឬជាប់គាំង (Lock) ក្នុង PostgreSQL?',
        exercise: 'Write a query using pg_stat_activity to find queries running for longer than 5 seconds. Identify queries waiting on locks (wait_event_type).',
        hints: [
          'Query pg_stat_activity WHERE state != \'idle\' AND now() - query_start > interval \'5 seconds\'.',
          'Check wait_event_type = \'Lock\' to identify queries waiting on transaction table/row locks.',
        ],
        solution: `SELECT pid, now() - query_start AS duration, query, state, wait_event_type, wait_event
FROM pg_stat_activity
WHERE state != 'idle'
  AND now() - query_start > interval '5 seconds'
ORDER BY duration DESC;`,
        failureCase: 'A forgotten transaction left open with BEGIN holds row locks forever, causing the entire API to hang until pool exhaustion.',
        rubric: 'Uses pg_stat_activity effectively and identifies lock wait states.',
        retrievalQuestions: [
          'What does wait_event_type = "Lock" mean in pg_stat_activity?',
          'How can an uncommitted transaction exhaust connection pools?',
        ],
      },
      {
        day: 28,
        week: 4,
        topic: 'Todo database capstone',
        focus: 'Capstone synthesis: multi-user schema, migrations, queries, and defense.',
        objective: 'Deliver an integrated Todo database design with Flyway migrations, safe indexes, and test proof.',
        khmerObjective: 'បញ្ចប់គម្រោង Capstone៖ រចនា Schema, Migrations, Indexes និងការពារទិន្នន័យ។',
        prerequisites: 'Days 1-27.',
        diagnostic: 'What are the 3 most critical rules you learned for production database reliability?',
        khmerDiagnostic: 'តើអ្វីជាគោលការណ៍សំខាន់បំផុត 3 ដែលអ្នកបានរៀនសម្រាប់ Production Database?',
        exercise: 'Complete the Capstone Todo DB Lab: (1) Finalize users, projects, todos, tags, task_events schema, (2) Ensure all constraints and indexes are in Flyway migrations, (3) Document backup & restore verification, (4) Defend your design against concurrent updates and rollback scenarios.',
        hints: [
          'Synthesize all four weeks into a clean, reproducible setup.',
          'Review the checklist: schema constraints, Flyway versioning, MyBatis parameter binding, optimistic locking, and backup verification.',
        ],
        solution: `-- Capstone complete!
-- 1. Trustworthy schema with check constraints & foreign keys
-- 2. Versioned Flyway migrations
-- 3. MyBatis parameterized mappers
-- 4. Optimistic locking with version column
-- 5. Verified disaster recovery backup`,
        failureCase: 'Shipping backend code without schema constraints or migrations results in data corruption that takes weeks of manual recovery.',
        rubric: 'Comprehensive defense across schema, constraints, migrations, transactions, and backups.',
        retrievalQuestions: [
          'Explain why database constraints provide the ultimate boundary of data truth.',
          'How does the Expand/Contract pattern enable zero-downtime releases?',
        ],
      },
    ],
  },
  {
    id: 'nextjs-fullstack-db',
    title: 'Next.js & Distributed Database Lab',
    tagline: 'Fullstack PostgreSQL, Prisma, Drizzle & Row-Level Security',
    description: 'Upcoming track: Server Components, connection pooling with Neon/Supabase, Row-Level Security (RLS) policies, and migrations.',
    category: 'Fullstack & Web',
    totalDays: 21,
    active: false,
    weeks: [],
    lessons: [],
  },
  {
    id: 'go-sqlite-microservices',
    title: 'Go & SQLite Embedded Services',
    tagline: 'High-Performance Embedded Storage with Go',
    description: 'Upcoming track: WAL mode, concurrent goroutine access, sqlc code generation, and microservice persistence.',
    category: 'Systems & Microservices',
    totalDays: 14,
    active: false,
    weeks: [],
    lessons: [],
  },
]

export function getCourse(courseId) {
  return COURSES.find((c) => c.id === courseId) ?? COURSES[0]
}

export function getLesson(courseId, day) {
  const course = getCourse(courseId)
  if (!course) return undefined
  return course.lessons.find((l) => l.day === day)
}

export function calculateStats(courseId, progress) {
  const course = getCourse(courseId)
  const total = course?.totalDays ?? 28
  const days = progress?.days ?? {}
  let completedCount = 0
  let totalScore = 0
  let scoredCount = 0

  for (let d = 1; d <= total; d++) {
    const entry = days[String(d)]
    if (entry && entry.status === 'completed') {
      completedCount++
      if (typeof entry.score === 'number') {
        totalScore += entry.score
        scoredCount++
      }
    }
  }

  const percent = Math.round((completedCount / total) * 100)
  const avgScore = scoredCount > 0 ? Math.round(totalScore / scoredCount) : 0

  return {
    totalDays: total,
    completedDays: completedCount,
    percent,
    avgScore,
  }
}

export function getDueReviews(reviews, forDateStr) {
  if (!Array.isArray(reviews)) return []
  const targetDate = forDateStr ?? new Date().toISOString().slice(0, 10)
  return reviews.filter((r) => r.status === 'pending' && r.due <= targetDate)
}

export function getNextDay(courseId, progress) {
  const course = getCourse(courseId)
  const total = course?.totalDays ?? 28
  const days = progress?.days ?? {}
  for (let d = 1; d <= total; d++) {
    const entry = days[String(d)]
    if (!entry || entry.status !== 'completed') {
      return d
    }
  }
  return total
}

export const LIVE_TEACHER_TOOLS = [
  {
    name: 'show_hint',
    description: 'Reveal one escalating hint (level 1, 2, or 3) in the learner UI when the learner needs guidance.',
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'integer',
          description: 'Escalating hint level: 1 (direction), 2 (SQL structure), or 3 (near-complete syntax).',
        },
      },
      required: ['level'],
    },
  },
  {
    name: 'reveal_solution',
    description: 'Open the worked reference solution in the learner UI after all 3 escalating hints have been explored.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'record_score',
    description: 'Populate the suggested mastery score (0-100) and feedback note in the learner UI after evaluating their attempt.',
    parameters: {
      type: 'object',
      properties: {
        score: {
          type: 'integer',
          description: 'Score from 0 to 100 based on the lesson rubric.',
        },
        note: {
          type: 'string',
          description: 'Short summary of strengths or remaining issues.',
        },
      },
      required: ['score'],
    },
  },
]

export function buildLiveLessonContext({
  courseId,
  day,
  lang = 'en',
  scratchpad = '',
  dueReviewsCount = 0,
}) {
  const course = getCourse(courseId)
  const lesson = getLesson(courseId, day)
  if (!lesson) return ''

  const objective = lang === 'km' && lesson.khmerObjective ? lesson.khmerObjective : lesson.objective
  const diagnostic = lang === 'km' && lesson.khmerDiagnostic ? lesson.khmerDiagnostic : lesson.diagnostic
  const hints = (lesson.hints || []).map((hint, idx) => `Hint ${idx + 1} (teacher-only): ${hint}`).join('\n')
  const trimmedScratchpad = String(scratchpad || '').trim().slice(0, 2000)

  const lines = [
    `Course: ${course?.title || courseId}`,
    `Day: ${lesson.day} / ${course?.totalDays || 28} (Week ${lesson.week})`,
    `Language Mode: ${lang === 'km' ? 'Khmer (km) with English SQL' : 'English (en)'}`,
    `Due Spaced Reviews: ${dueReviewsCount}`,
    `Topic: ${lesson.topic}`,
    `Objective: ${objective}`,
    `Prerequisites: ${lesson.prerequisites}`,
    `Diagnostic Question: ${diagnostic}`,
    `Hands-on Exercise: ${lesson.exercise}`,
    `Production Failure Case: ${lesson.failureCase}`,
    `Rubric (teacher-only): ${lesson.rubric}`,
    hints,
    `Worked Solution (TEACHER-ONLY — do not disclose before 3 hints): ${lesson.solution}`,
    `Learner Scratchpad:\n${trimmedScratchpad || '(empty)'}`,
  ]

  return lines.join('\n\n').slice(0, 6500)
}
