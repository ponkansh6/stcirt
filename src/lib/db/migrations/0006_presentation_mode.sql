ALTER TABLE `presentation_operations` ADD `mode` text;--> statement-breakpoint
ALTER TABLE `presentation_sessions` ADD `presentation_mode` text DEFAULT 'full' NOT NULL;