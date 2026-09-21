ALTER TABLE "resolution_runs" RENAME COLUMN "model" TO "models";--> statement-breakpoint
ALTER TABLE "resolution_runs" DROP CONSTRAINT "resolution_runs_model_nonempty";--> statement-breakpoint
ALTER TABLE "resolution_runs" ALTER COLUMN "models" SET DATA TYPE jsonb USING jsonb_build_object('classification', "models", 'resolution', "models");--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD COLUMN "classification_model" text NOT NULL DEFAULT 'legacy';--> statement-breakpoint
UPDATE "evaluation_runs" SET "classification_model" = "generation_model";--> statement-breakpoint
ALTER TABLE "evaluation_runs" ALTER COLUMN "classification_model" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_classification_model_nonempty" CHECK (length(trim("evaluation_runs"."classification_model")) > 0);--> statement-breakpoint
ALTER TABLE "resolution_runs" ADD CONSTRAINT "resolution_runs_models_nonempty" CHECK (length(trim("resolution_runs"."models"->>'classification')) > 0 and length(trim("resolution_runs"."models"->>'resolution')) > 0);
