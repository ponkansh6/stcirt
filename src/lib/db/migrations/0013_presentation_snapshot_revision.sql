ALTER TABLE `presentation_sessions` ADD `snapshot_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Existing non-empty snapshots and started runs were created by the legacy
-- start/publication triggers. Preserve them as an existing snapshot generation.
UPDATE `presentation_sessions`
SET `snapshot_revision` = 1
WHERE `state` <> 'not_started'
   OR EXISTS (
     SELECT 1 FROM `presentation_questions`
     WHERE `presentation_questions`.`session_id` = `presentation_sessions`.`id`
   )
   OR EXISTS (
     SELECT 1 FROM `presentation_entries`
     WHERE `presentation_entries`.`session_id` = `presentation_sessions`.`id`
   );
