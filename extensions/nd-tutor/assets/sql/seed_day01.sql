-- LOCAL LEARNING DB ONLY; run after you create the `todos` table.
-- Inserts three rows so you can practice filters and updates.
-- Re-running this file adds three more todos; observe the effect!
INSERT INTO todos (title, description, status)
VALUES
  ('Learn NOT NULL', 'Explain why a blank string differs from NULL', 'OPEN'),
  ('Practice SQL WHERE', NULL, 'OPEN'),
  ('Check CHECK constraint', 'Predict an invalid status insert', 'DONE');

SELECT id, title, status, created_at FROM todos ORDER BY id;
