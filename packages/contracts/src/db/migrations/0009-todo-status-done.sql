-- Normalize mission todo status to the frontend/API canonical vocabulary.
UPDATE mission_todo SET status = 'done', updated_at = now() WHERE status = 'completed';

-- Historical cleanup: terminal missions must not leave an active plan cursor.
UPDATE mission_todo t SET status = 'done', updated_at = now()
WHERE t.status IN ('pending', 'in_progress')
  AND EXISTS (
    SELECT 1 FROM missions m
    WHERE m.id = t.mission_id AND m.state IN ('completed', 'failed', 'cancelled')
  );
