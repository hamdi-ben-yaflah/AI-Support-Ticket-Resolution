CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"section" text NOT NULL,
	"content" text NOT NULL,
	"token_count" integer NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"metadata" jsonb NOT NULL,
	CONSTRAINT "document_chunks_document_index_unique" UNIQUE("document_id","chunk_index"),
	CONSTRAINT "document_chunks_index_nonnegative" CHECK ("document_chunks"."chunk_index" >= 0),
	CONSTRAINT "document_chunks_section_nonempty" CHECK (length(trim("document_chunks"."section")) > 0),
	CONSTRAINT "document_chunks_content_nonempty" CHECK (length(trim("document_chunks"."content")) > 0),
	CONSTRAINT "document_chunks_token_count_positive" CHECK ("document_chunks"."token_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"content_hash" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_source_id_unique" UNIQUE("source_id"),
	CONSTRAINT "documents_title_nonempty" CHECK (length(trim("documents"."title")) > 0),
	CONSTRAINT "documents_content_hash_sha256" CHECK ("documents"."content_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
