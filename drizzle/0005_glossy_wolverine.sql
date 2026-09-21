ALTER TABLE "evaluation_results" ADD COLUMN "classification_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD COLUMN "classification_output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD COLUMN "classification_cached_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD COLUMN "classification_cache_write_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD COLUMN "resolution_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD COLUMN "resolution_output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD COLUMN "resolution_cached_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_results" ADD COLUMN "resolution_cache_write_tokens" integer DEFAULT 0 NOT NULL;