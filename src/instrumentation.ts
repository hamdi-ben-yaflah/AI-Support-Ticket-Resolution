export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { initializeObservability } = await import("@/observability/instrumentation-node");
  await initializeObservability();
}
