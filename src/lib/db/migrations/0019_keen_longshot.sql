CREATE TABLE `assisted_result_shares` (
	`owner_participant_id` integer PRIMARY KEY NOT NULL,
	`target_participant_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`owner_participant_id`) REFERENCES `exam_participants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_participant_id`) REFERENCES `exam_participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assisted_result_shares_target_participant_id_unique` ON `assisted_result_shares` (`target_participant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `assisted_result_shares_token_hash_unique` ON `assisted_result_shares` (`token_hash`);