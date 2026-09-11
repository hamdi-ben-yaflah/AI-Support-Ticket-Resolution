CREATE TABLE "resolution_run_sources" (
	"resolution_run_id" uuid NOT NULL,
	"citation_position" integer NOT NULL,
	"chunk_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"section" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "resolution_run_sources_pk" PRIMARY KEY("resolution_run_id","citation_position"),
	CONSTRAINT "resolution_run_sources_run_chunk_unique" UNIQUE("resolution_run_id","chunk_id"),
	CONSTRAINT "resolution_run_sources_position_nonnegative" CHECK ("resolution_run_sources"."citation_position" >= 0),
	CONSTRAINT "resolution_run_sources_source_id_nonempty" CHECK (length(trim("resolution_run_sources"."source_id")) > 0),
	CONSTRAINT "resolution_run_sources_title_nonempty" CHECK (length(trim("resolution_run_sources"."title")) > 0),
	CONSTRAINT "resolution_run_sources_section_nonempty" CHECK (length(trim("resolution_run_sources"."section")) > 0),
	CONSTRAINT "resolution_run_sources_content_nonempty" CHECK (length(trim("resolution_run_sources"."content")) > 0)
);
--> statement-breakpoint
CREATE TABLE "resolution_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"session_hash" text NOT NULL,
	"ticket_hash" text NOT NULL,
	"prompt_versions" jsonb NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"result_status" text NOT NULL,
	"classification" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"latency_ms" integer NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"validation_passed" boolean NOT NULL,
	"retry_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resolution_runs_trace_id_unique" UNIQUE("trace_id"),
	CONSTRAINT "resolution_runs_session_hash_sha256" CHECK ("resolution_runs"."session_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "resolution_runs_ticket_hash_sha256" CHECK ("resolution_runs"."ticket_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "resolution_runs_provider_nonempty" CHECK (length(trim("resolution_runs"."provider")) > 0),
	CONSTRAINT "resolution_runs_model_nonempty" CHECK (length(trim("resolution_runs"."model")) > 0),
	CONSTRAINT "resolution_runs_success" CHECK ("resolution_runs"."result_status" = 'success'),
	CONSTRAINT "resolution_runs_latency_nonnegative" CHECK ("resolution_runs"."latency_ms" >= 0),
	CONSTRAINT "resolution_runs_input_tokens_nonnegative" CHECK ("resolution_runs"."input_tokens" >= 0),
	CONSTRAINT "resolution_runs_output_tokens_nonnegative" CHECK ("resolution_runs"."output_tokens" >= 0),
	CONSTRAINT "resolution_runs_retry_count_nonnegative" CHECK ("resolution_runs"."retry_count" >= 0),
	CONSTRAINT "resolution_runs_validation_passed" CHECK ("resolution_runs"."validation_passed" = true)
);
--> statement-breakpoint
ALTER TABLE "resolution_run_sources" ADD CONSTRAINT "resolution_run_sources_resolution_run_id_resolution_runs_id_fk" FOREIGN KEY ("resolution_run_id") REFERENCES "public"."resolution_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resolution_run_sources_chunk_idx" ON "resolution_run_sources" USING btree ("chunk_id");--> statement-breakpoint
CREATE INDEX "resolution_runs_session_created_idx" ON "resolution_runs" USING btree ("session_hash","created_at");