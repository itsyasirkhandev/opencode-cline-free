"use client";

import { GradientWave } from "@/components/ui/hero-02-utils/gradient-wave";
import { Button } from "@/components/ui/button";
import { Github } from "@aliimam/logos";
import { Marquee } from "@/components/ui/hero-02-utils/marquee";
import { PluginIcon } from "@/components/ui/hero-02-utils/plugin-icon";
import type { ComponentProps } from "react";

const capabilities = [
  {
    name: "Live model discovery",
    designation: "FOLLOWS CLINE’S FREE ROTATION",
    description:
      "The plugin fetches Cline’s free-model list at startup. New rotations don’t need a plugin update.",
    command: "/models",
    icon: "models",
  },
  {
    name: "Your Cline account",
    designation: "THREE WAYS TO CONNECT",
    description:
      "Sign in through your browser, reuse your Cline CLI login, or connect with a token.",
    command: "/connect",
    icon: "accounts",
  },
  {
    name: "Automatic failover",
    designation: "PER-ACCOUNT, PER-MODEL LIMITS",
    description:
      "When an account hits a model’s limit, retry the request on the next healthy connected account.",
    command: "cline_free_status",
    icon: "retry",
  },
  {
    name: "Sessions that stick",
    designation: "KEEP YOUR PROMPT CACHE WARM",
    description:
      "Each session stays on one account per model. It moves when that account is limited or needs attention.",
    command: "Session → account → model",
    icon: "session",
  },
] satisfies Array<{
  name: string;
  designation: string;
  description: string;
  command: string;
  icon: ComponentProps<typeof PluginIcon>["name"];
}>;

const workflowIcons = [
  { name: "OpenCode workflow", icon: "terminal" },
  { name: "Free-model discovery", icon: "models" },
  { name: "Connected Cline accounts", icon: "accounts" },
  { name: "Automatic failover", icon: "retry" },
] satisfies Array<{
  name: string;
  icon: ComponentProps<typeof PluginIcon>["name"];
}>;

export function HeroSection02() {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
  return (
    <div className="design-hero relative isolate">
      <GradientWave className="absolute inset-0 -z-10" />
      <header className="design-nav page-width">
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
        <p className="hero-kicker">OPENCODE V2 · COMMUNITY PLUGIN</p>
        <div className="hero-line">
          <h1 id="hero-title" tabIndex={-1}>
            Cline models.
          </h1>
          <p className="hero-description">
            Use Cline’s rotating free models inside OpenCode. Connect your
            account, choose a model, and keep working in the terminal you
            already use.
          </p>
        </div>
        <div className="hero-line hero-line-tools">
          <ul className="logo-stack" aria-label="Plugin capabilities">
            {workflowIcons.map(({ name, icon }) => (
              <li key={name}>
                <PluginIcon name={icon} className="brand-icon" />
                <span className="sr-only">{name}</span>
              </li>
            ))}
          </ul>
          <p className="hero-display">Your workflow.</p>
        </div>
        <div className="hero-line hero-line-action">
          <p className="hero-display hero-underlined">Keep coding.</p>
          <Button asChild className="hero-cta">
            <a href="#setup">
              Install plugin <span aria-hidden="true">↓</span>
            </a>
          </Button>
        </div>
        <p className="hero-note">
          OpenCode 2.x required. Cline’s daily free quota applies. Paid models
          use Cline credits.
        </p>
      </section>
      <section
        className="tools-section page-width"
        id="features"
        aria-labelledby="features-title"
      >
        <div className="section-intro">
          <div>
            <p className="eyebrow">BUILT FOR YOUR OPENCODE WORKFLOW</p>
            <h2 id="features-title">One plugin. Less setup.</h2>
          </div>
          <p>
            Live discovery, flexible sign-in, and account failover—without
            leaving OpenCode.
          </p>
        </div>
        <Marquee>
          {capabilities.map((capability) => (
            <article key={capability.name} className="tool-card">
              <div className="tool-visual">
                <PluginIcon
                  name={capability.icon}
                  className="capability-icon"
                />
                <code>{capability.command}</code>
              </div>
              <div className="tool-copy">
                <h3>{capability.name}</h3>
                <p className="tool-designation">{capability.designation}</p>
                <p>{capability.description}</p>
              </div>
            </article>
          ))}
        </Marquee>
      </section>
    </div>
  );
}

export default HeroSection02;
