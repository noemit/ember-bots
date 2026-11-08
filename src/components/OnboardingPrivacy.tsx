import type { MouseEvent } from 'react';

const openExternal = (event: MouseEvent<HTMLAnchorElement>) => {
  event.preventDefault();
  void window.ember.openExternal(event.currentTarget.href);
};

/** A human ending to setup; the provider caveat stays beside the privacy promise. */
export default function OnboardingPrivacy() {
  const linkClass = 'rounded-sm underline decoration-current/40 underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring';
  return (
    <section aria-labelledby="onboarding-privacy-title" className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-8 py-6 sm:py-10">
      <div className="space-y-5">
        <p className="text-sm font-medium uppercase tracking-[.18em] text-muted-foreground">Yours to use</p>
        <h3 id="onboarding-privacy-title" className="max-w-2xl text-4xl font-semibold leading-[1.12] tracking-tight sm:text-5xl lg:text-6xl">
          Free, open source, and private.
        </h3>
        <p className="max-w-xl text-lg leading-relaxed sm:text-xl">
          Ember doesn’t send us analytics, crash reports, or bug reports. That means we won’t know when something breaks unless you tell us.
        </p>
      </div>
      <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
        Your chosen AI provider receives the messages you send to it and the context your bots use, under that provider’s privacy policy. Ember also makes network requests for updates and model catalogues.
      </p>
      <div className="flex flex-col gap-3 border-t border-border/60 pt-6 text-base">
        <p>Built by <a href="https://x.com/noemititarenco" onClick={openExternal} className={linkClass}>Em</a></p>
        <p>Found an issue? <a href="mailto:em-bot@mail.grokbot.com" onClick={openExternal} className={linkClass}>Email me.</a></p>
      </div>
    </section>
  );
}
