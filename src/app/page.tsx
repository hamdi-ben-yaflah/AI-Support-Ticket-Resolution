import Link from "next/link";

import { TicketResolutionForm } from "@/app/ticket-resolution-form";

export default function Home() {
  return (
    <main className="min-h-screen bg-[#f4f3ee] px-4 py-5 text-[#17201d] sm:px-7 sm:py-8 lg:px-10">
      <div className="mx-auto max-w-[1440px] overflow-hidden rounded-[28px] border border-[#d9d8cf] bg-[#fbfaf6] shadow-[0_30px_80px_rgba(35,45,40,0.10)]">
        <header className="flex items-center justify-between border-b border-[#deddd5] px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3">
            <div
              aria-hidden="true"
              className="grid size-9 place-items-center rounded-xl bg-[#173f36] text-sm font-bold text-[#f8e28e]"
            >
              S
            </div>
            <div>
              <p className="text-sm font-semibold tracking-[-0.01em]">Support desk</p>
              <p className="text-xs text-[#69736f]">Resolution copilot</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin/evaluations"
              className="text-xs font-semibold text-[#285f52] underline decoration-[#9eb9b1] underline-offset-4 hover:text-[#173f36]"
            >
              Evaluation lab
            </Link>
            <div className="hidden items-center gap-2 rounded-full border border-[#d9d8cf] bg-white px-3 py-1.5 text-xs font-medium text-[#53605b] sm:flex">
              <span className="size-2 rounded-full bg-[#40a879]" aria-hidden="true" />
              Human-controlled
            </div>
          </div>
        </header>

        <div className="grid lg:grid-cols-[0.78fr_1.22fr]">
          <section className="flex flex-col justify-between border-b border-[#deddd5] bg-[#173f36] p-7 text-white sm:p-10 lg:min-h-[720px] lg:border-r lg:border-b-0 lg:p-12">
            <div>
              <p className="mb-8 inline-flex rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[#e9d983]">
                Grounded resolution workspace
              </p>
              <h1 className="max-w-xl text-4xl leading-[1.06] font-semibold tracking-[-0.045em] sm:text-5xl lg:text-[3.45rem]">
                Turn a new ticket into an evidence-backed first reply.
              </h1>
              <p className="mt-6 max-w-lg text-base leading-7 text-[#c6d5d0]">
                Get a structured classification and a proposed response grounded in the synthetic knowledge base.
              </p>
            </div>

            <div className="mt-12 grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
              {[
                ["01", "Paste a synthetic ticket"],
                ["02", "Review the AI proposal"],
                ["03", "Keep the final decision"],
              ].map(([number, label]) => (
                <div key={number} className="border-t border-white/20 pt-3">
                  <span className="text-xs font-semibold text-[#e9d983]">{number}</span>
                  <p className="mt-1 text-sm leading-5 text-[#dce6e2]">{label}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="p-5 sm:p-8 lg:p-10 xl:p-14">
            <TicketResolutionForm />
          </section>
        </div>
      </div>
    </main>
  );
}
