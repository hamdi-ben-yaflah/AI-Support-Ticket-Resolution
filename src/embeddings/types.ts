export type EmbeddingRequestMetadata = {
  traceId: string;
  operation: "ingestion" | "retrieval";
  inputType: "document" | "query";
};

export type EmbeddingResult = {
  vectors: number[][];
  model: string;
  usage: { inputTokens: number };
  latencyMs: number;
  retryCount: number;
};

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], metadata: EmbeddingRequestMetadata): Promise<EmbeddingResult>;
}
