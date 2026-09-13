import Link from "next/link";

import { EvaluationConsole } from "@/app/admin/evaluations/evaluation-console";

export default function EvaluationsPage() {
  return (
    <main className="min-h-screen bg-[#f4f3ee] px-4 py-5 text-[#17201d] sm:px-7 sm:py-8 lg:px-10">
      <div className="mx-auto max-w-[1440px] overflow-hidden rounded-[28px] border border-[#d9d8cf] bg-[#fbfaf6] shadow-[0_30px_80px_rgba(35,45,40,0.10)]">
        <header className="flex flex-col gap-4 border-b border-[#deddd5] px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <div className="flex items-center gap-3">
            <div
              aria-hidden="true"
              className="grid size-9 place-items-center rounded-xl bg-[#173f36] text-sm font-bold text-[#f8e28e]"
            >
              E
            </div>
            <div>
              <p className="text-sm font-semibold tracking-[-0.01em]">Evaluation lab</p>
              <p className="text-xs text-[#69736f]">Golden dataset · local admin</p>
            </div>
          </div>
          <Link
            href="/"
            className="text-sm font-semibold text-[#285f52] underline decoration-[#9eb9b1] underline-offset-4 hover:text-[#173f36]"
          >
            Return to support desk
          </Link>
        </header>

        <section className="border-b border-[#deddd5] bg-[#173f36] px-6 py-9 text-white sm:px-10 sm:py-12">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#e9d983]">
            Quality gate · stories 7–8
          </p>
          <div className="mt-3 grid gap-5 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">
                Run and compare support evaluations.
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-6 text-[#c6d5d0] sm:text-base">
                This unauthenticated local-only surface makes live Anthropic and Voyage AI calls
                against PostgreSQL. It consumes provider capacity and must not be publicly exposed.
              </p>
            </div>
            <div className="rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-sm">
              <p className="font-semibold text-[#f8e28e]">golden.v2</p>
              <p className="mt-1 text-[#dce6e2]">36 synthetic cases · persisted history</p>
            </div>
          </div>
        </section>

        <EvaluationConsole />
      </div>
    </main>
  );
}
