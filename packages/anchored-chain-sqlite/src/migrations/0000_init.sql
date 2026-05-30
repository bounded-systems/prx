CREATE TABLE `derivation_inputs` (
	`derivation_id` text NOT NULL,
	`input_name` text NOT NULL,
	`input_digest` text NOT NULL,
	PRIMARY KEY(`derivation_id`, `input_name`),
	FOREIGN KEY (`derivation_id`) REFERENCES `derivations`(`derivation_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `derivation_inputs_digest` ON `derivation_inputs` (`input_digest`);--> statement-breakpoint
CREATE TABLE `derivation_outputs` (
	`derivation_id` text NOT NULL,
	`output_name` text NOT NULL,
	`output_digest` text NOT NULL,
	PRIMARY KEY(`derivation_id`, `output_name`),
	FOREIGN KEY (`derivation_id`) REFERENCES `derivations`(`derivation_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `derivation_outputs_digest` ON `derivation_outputs` (`output_digest`);--> statement-breakpoint
CREATE TABLE `derivations` (
	`derivation_id` text PRIMARY KEY NOT NULL,
	`producer` text NOT NULL,
	`manifest_json` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ref_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`prev_digest` text,
	`new_digest` text NOT NULL,
	`reason` text NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ref_log_name_ts` ON `ref_log` (`name`,`ts`);--> statement-breakpoint
CREATE TABLE `refs` (
	`name` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`updated_at` integer NOT NULL
);
