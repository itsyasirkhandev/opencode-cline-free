import { GradientWave } from "@/components/ui/hero-02-utils/gradient-wave";
import { Button } from "@/components/ui/button";
import { Github } from "@aliimam/logos";
import { Marquee } from "@/components/ui/hero-02-utils/marquee";

const capabilities = [
  {
    name: "Free models, refreshed at startup",
    designation: "Model discovery",
    description:
      "The plugin checks Cline's free-model list when OpenCode starts. New rotations don't need a plugin update. A saved copy keeps the list available offline.",
    command: "/models",
    image: "discovery",
  },
  {
    name: "Connect your Cline account",
    designation: "Account sign-in",
    description:
      "Approve sign-in in your browser, reuse a Cline CLI login on this machine, or provide a Cline token.",
    command: "/connect",
    image: "connect",
  },
  {
    name: "Retry on a healthy account",
    designation: "Request failover",
    description:
      "When an account hits a rate limit, the plugin retries the request on the next healthy connected account. Limits stay separate for each model.",
    command: "cline_free_status",
    image: "failover",
  },
  {
    name: "Keep one account per session",
    designation: "Session pinning",
    description:
      "Each session keeps the same account for each model until that account is limited, out of credits or needs a new login.",
    command: "Per session, per model",
    image: "session",
  },
];

export function HeroSection02() {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
  return (
    <div className="design-hero relative isolate">
      <GradientWave className="absolute inset-0 -z-10" />
      <header className="design-nav page-width" data-reveal="fade">
        <a href="#hero-title" className="design-brand">
          <img src={`${base}logo.svg`} alt="" width={48} height={48} />
          <span>
            cline-free<span className="brand-period">.</span>
          </span>
        </a>
        <nav aria-label="Primary">
          <Button asChild variant="outline">
            <a href="https://github.com/itsyasirkhandev/opencode-cline-free">
              <Github className="h-6 w-6" aria-hidden="true" />
              GitHub <span aria-hidden="true">↗</span>
            </a>
          </Button>
        </nav>
      </header>
      <section className="hero-panel page-width" aria-labelledby="hero-title">
        <p className="hero-kicker" data-reveal="rise">
          OpenCode V2 · Community plugin
        </p>
        <div className="hero-line" data-reveal="rise">
          <h1 id="hero-title" tabIndex={-1}>
            Cline models.
          </h1>
          <p className="hero-description">
            Use Cline's rotating free models in OpenCode with your Cline
            account. The plugin loads the model list and routes requests across
            the accounts you connect.
          </p>
        </div>
        <div className="hero-line hero-line-tools">
          <div className="integration-pair" data-reveal="connection">
            <div className="integration-product">
              <img
                src={`${base}brands/opencode.svg`}
                alt=""
                width={32}
                height={40}
              />
              <span>OpenCode</span>
            </div>
            <span className="integration-link" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <div className="integration-product">
              <img
                src={`${base}brands/cline.svg`}
                alt=""
                width={48}
                height={48}
              />
              <span>Cline</span>
            </div>
          </div>
          <p className="hero-display" data-reveal="rise">
            Inside OpenCode.
          </p>
        </div>
        <div className="hero-line hero-line-action" data-reveal="rise">
          <p className="hero-display hero-underlined">In your terminal.</p>
          <Button asChild className="hero-cta">
            <a href="#setup">
              Install plugin <span aria-hidden="true">↓</span>
            </a>
          </Button>
        </div>
        <p className="hero-note">
          OpenCode 2.x required. Cline's daily free quota applies. Paid models
          use Cline credits.
        </p>
      </section>
      <section
        className="tools-section page-width"
        id="features"
        aria-labelledby="features-title"
      >
        <div className="section-intro" data-reveal="fade">
          <div>
            <p className="eyebrow">Model discovery and account routing</p>
            <h2 id="features-title">What the plugin handles.</h2>
          </div>
          <p>
            Cline sets the free rotation and account limits. The plugin makes
            them available in OpenCode.
          </p>
        </div>
        <Marquee>
          {capabilities.map((capability, index) => (
            <article
              key={capability.name}
              className={`tool-card${index === 0 ? " tool-card-featured" : ""}`}
              data-reveal="rise"
            >
              <div className="tool-visual" data-reveal="illustration">
                <img
                  src={`${base}illustrations/${capability.image}.svg`}
                  alt=""
                  width={500}
                  height={376}
                  loading="lazy"
                  decoding="async"
                />
              </div>
              <div className="tool-copy">
                <p className="tool-designation">{capability.designation}</p>
                <h3>{capability.name}</h3>
                <p>{capability.description}</p>
                <code className="tool-command">{capability.command}</code>
              </div>
            </article>
          ))}
        </Marquee>
      </section>
    </div>
  );
}

export default HeroSection02;
