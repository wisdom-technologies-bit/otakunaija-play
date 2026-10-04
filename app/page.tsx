import {
  ArrowRight,
  Check,
  Database,
  GitBranch,
  Globe2,
  Layers3,
  Radio,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react'

const stages = [
  {
    number: '01',
    icon: Globe2,
    title: 'Discover new episodes',
    description: 'AniList airing schedules are checked within the active 48-hour window, then deduplicated against the queue.',
    detail: 'AniList → pending_sync',
  },
  {
    number: '02',
    icon: Database,
    title: 'Enrich the catalogue',
    description: 'Queued titles are enriched with Jikan metadata and AniList artwork before becoming playable episode records.',
    detail: 'Jikan + AniList → episodes',
  },
  {
    number: '03',
    icon: Radio,
    title: 'Resolve a stream',
    description: 'The watch route checks providers in order, validates the response, and remembers the first working resolution.',
    detail: 'Providers → resolved stream',
  },
  {
    number: '04',
    icon: RefreshCw,
    title: 'Recover automatically',
    description: 'Failed resolutions are flagged for resync. Provider lists can be refreshed without creating duplicate episodes.',
    detail: 'Resync → fresh providers',
  },
]

const capabilities = [
  ['Built for OtakuNaija Play', 'A focused service layer for episode discovery, metadata, playback, and export.'],
  ['Provider-aware playback', 'Fallback logic keeps playback resilient when one upstream source is unavailable.'],
  ['Fresh artwork', 'Poster and banner images remain separate from the legacy cover field for compatibility.'],
  ['Signed media access', 'Protected upstream manifests, segments, and subtitles are proxied with short-lived URLs.'],
]

export default function HomePage() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#071014] text-[#effaf4]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_75%_0%,rgba(67,193,128,0.17),transparent_32%),radial-gradient(circle_at_0%_35%,rgba(30,113,105,0.16),transparent_28%)]" />
      <div className="relative mx-auto max-w-7xl px-6 py-6 sm:px-10 lg:px-14">
        <header className="flex items-center justify-between border-b border-white/10 pb-6">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-[#b7f36b] text-[#071014] shadow-[0_0_30px_rgba(183,243,107,0.22)]">
              <Sparkles aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-[0.2em] text-[#b7f36b]">OTAKUNAIJA</p>
              <p className="text-xs text-white/45">PLAY SERVICE</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/55 sm:flex">
            <span className="size-1.5 rounded-full bg-[#b7f36b] shadow-[0_0_10px_#b7f36b]" />
            Service layer online
          </div>
        </header>

        <section className="grid gap-14 pb-24 pt-20 lg:grid-cols-[1.15fr_0.85fr] lg:items-end lg:pt-28">
          <div>
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#b7f36b]/25 bg-[#b7f36b]/8 px-3 py-1.5 text-xs font-medium text-[#b7f36b]">
              <Zap aria-hidden="true" data-icon="inline-start" />
              Reliable anime delivery, end to end
            </div>
            <h1 className="max-w-4xl text-5xl font-semibold leading-[0.95] tracking-[-0.06em] text-balance sm:text-7xl lg:text-8xl">
              From airing schedule to <span className="text-[#b7f36b]">playback.</span>
            </h1>
            <p className="mt-8 max-w-2xl text-lg leading-8 text-white/60 sm:text-xl">
              OtakuNaija Play keeps the path from a newly aired episode to a dependable stream clear, observable, and ready for the OtakuNaija experience.
            </p>
            <div className="mt-10 flex flex-wrap gap-3 text-sm text-white/70">
              {['AniList discovery', 'Provider fallback', 'Signed media proxy'].map((item) => (
                <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2" key={item}>
                  <Check aria-hidden="true" className="text-[#b7f36b]" data-icon="inline-start" />
                  {item}
                </span>
              ))}
            </div>
          </div>

          <div className="relative rounded-[2rem] border border-white/10 bg-white/[0.045] p-6 shadow-2xl shadow-black/20 backdrop-blur-sm sm:p-8">
            <div className="absolute -right-12 -top-12 size-32 rounded-full bg-[#b7f36b]/10 blur-3xl" />
            <div className="relative flex items-center justify-between border-b border-white/10 pb-5">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-white/40">System view</p>
                <h2 className="mt-2 text-xl font-medium">A calm path to watch</h2>
              </div>
              <Layers3 className="text-[#b7f36b]" aria-hidden="true" />
            </div>
            <div className="relative mt-6 flex flex-col gap-3">
              {['Schedule found', 'Metadata ready', 'Stream resolved'].map((label, index) => (
                <div className="flex items-center gap-4 rounded-2xl border border-white/8 bg-[#0c1a1c] p-4" key={label}>
                  <div className="grid size-9 shrink-0 place-items-center rounded-full bg-[#b7f36b]/12 text-sm font-semibold text-[#b7f36b]">0{index + 1}</div>
                  <div className="flex-1">
                    <p className="text-sm font-medium">{label}</p>
                    <p className="mt-1 text-xs text-white/40">{index === 0 ? 'Airing window monitored' : index === 1 ? 'Images and episode data attached' : 'Best available provider selected'}</p>
                  </div>
                  <Check className="text-[#b7f36b]" aria-hidden="true" />
                </div>
              ))}
            </div>
            <div className="relative mt-6 flex items-center gap-3 border-t border-white/10 pt-5 text-xs text-white/45">
              <ShieldCheck className="text-[#b7f36b]" aria-hidden="true" />
              Signed URLs keep upstream requirements server-side.
            </div>
          </div>
        </section>

        <section className="border-t border-white/10 py-20" id="workflow">
          <div className="mb-12 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#b7f36b]">The workflow</p>
              <h2 className="mt-3 max-w-xl text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">Four quiet systems behind every watch.</h2>
            </div>
            <p className="max-w-sm text-sm leading-6 text-white/45">Each stage has a clear responsibility, so new episodes can move forward without coupling discovery to playback.</p>
          </div>
          <div className="grid gap-px overflow-hidden rounded-3xl border border-white/10 bg-white/10 md:grid-cols-2 lg:grid-cols-4">
            {stages.map(({ number, icon: Icon, title, description, detail }) => (
              <article className="bg-[#0a1719] p-6 transition-colors hover:bg-[#0f2221]" key={number}>
                <div className="flex items-center justify-between text-xs text-white/35"><span>{number}</span><Icon className="text-[#b7f36b]" aria-hidden="true" /></div>
                <h3 className="mt-14 text-lg font-medium">{title}</h3>
                <p className="mt-3 min-h-20 text-sm leading-6 text-white/50">{description}</p>
                <p className="mt-8 text-xs font-medium text-[#b7f36b]">{detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="grid gap-10 border-t border-white/10 py-20 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#b7f36b]">Why it exists</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">The infrastructure should feel invisible.</h2>
            <p className="mt-6 max-w-md leading-7 text-white/50">OtakuNaija Play handles the moving parts quietly: scheduled data, resilient provider resolution, media access, and recovery when upstream sources change.</p>
            <a className="mt-8 inline-flex items-center gap-2 text-sm font-medium text-[#b7f36b] transition-colors hover:text-white" href="#workflow">Explore the workflow <ArrowRight aria-hidden="true" /></a>
          </div>
          <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
            {capabilities.map(([title, description]) => (
              <div className="border-t border-white/10 pt-5" key={title}>
                <h3 className="font-medium">{title}</h3>
                <p className="mt-2 text-sm leading-6 text-white/45">{description}</p>
              </div>
            ))}
          </div>
        </section>

        <footer className="flex flex-col gap-4 border-t border-white/10 py-8 text-xs text-white/35 sm:flex-row sm:items-center sm:justify-between">
          <p>OtakuNaija Play · Internal service overview</p>
          <p>Discover clearly. Resolve reliably. Play confidently.</p>
        </footer>
      </div>
    </main>
  )
}
