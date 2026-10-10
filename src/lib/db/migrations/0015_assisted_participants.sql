CREATE TABLE `assisted_participants` (
	`owner_participant_id` integer PRIMARY KEY NOT NULL,
	`target_participant_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`owner_participant_id`) REFERENCES `exam_participants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_participant_id`) REFERENCES `exam_participants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assisted_participants_target_participant_id_unique` ON `assisted_participants` (`target_participant_id`);