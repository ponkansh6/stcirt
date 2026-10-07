ALTER TABLE `participant_result_settings` ADD `ever_published` integer DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE `participant_result_settings` SET `ever_published` = true;
