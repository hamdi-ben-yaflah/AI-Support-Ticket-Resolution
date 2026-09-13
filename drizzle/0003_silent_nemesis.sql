CREATE TABLE "action_audit" (
	"proposal_id" uuid PRIMARY KEY NOT NULL,
	"resolution_run_id" uuid NOT NULL,
	"proposed_arguments" jsonb NOT NULL,
	"state" text NOT NULL,
	"trace_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "action_audit_resolution_run_id_unique" UNIQUE("resolution_run_id"),
	CONSTRAINT "action_audit_state_valid" CHECK ("action_audit"."state" in ('pending_confirmation', 'executed')),
	CONSTRAINT "action_audit_state_fields_valid" CHECK ((
        "action_audit"."state" = 'pending_confirmation'
        and "action_audit"."confirmed_at" is null
        and "action_audit"."executed_at" is null
        and "action_audit"."result" is null
      ) or (
        "action_audit"."state" = 'executed'
        and "action_audit"."confirmed_at" is not null
        and "action_audit"."executed_at" is not null
        and "action_audit"."result" is not null
      )),
	CONSTRAINT "action_audit_execution_order_valid" CHECK ("action_audit"."executed_at" is null or "action_audit"."confirmed_at" <= "action_audit"."executed_at")
);
--> statement-breakpoint
ALTER TABLE "action_audit" ADD CONSTRAINT "action_audit_resolution_run_id_resolution_runs_id_fk" FOREIGN KEY ("resolution_run_id") REFERENCES "public"."resolution_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_audit_resolution_run_idx" ON "action_audit" USING btree ("resolution_run_id");