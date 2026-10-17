"use client";

import { GradientWave } from "@/components/ui/hero-02-utils/gradient-wave";
import { Button } from "@/components/ui/button";
import {
  ClaudeAI,
  Cursor,
  Github,
  GoogleWordmark as Google,
  Grok,
  OpenAI,
} from "@aliimam/logos";
import { Marquee } from "@/components/ui/hero-02-utils/marquee";

const technologies = [
  {
    name: "Figma",
    designation: "UI/UX Design Tool",
    description: "Collaborative interface design.",
    logo: "https://cdn.21st.dev/assets/localized/74e550b9690bacf66ebd69b3516ef9c8734a44a247d4b6b6de2b86919aa367b3.jpg",
    icon: Github,
  },
  {
    name: "Adobe XD",
    designation: "Design & Prototyping",
    description: "Create wireframes, prototypes.",
    logo: "https://cdn.21st.dev/assets/localized/a68df68cdc74de1ab5e0155a13782cc0683df39a1cce61ac43bf202523a9246c.jpg",
    icon: OpenAI,
  },
  {
    name: "Sketch",
    designation: "Vector Design Tool",
    description: "Professional digital design for macOS.",
    logo: "https://cdn.21st.dev/assets/localized/87f7bec26ed746a2e43b7a6ca4d1ca5dc388d5b0e27fabb9662632b0bd8a7e02.jpg",
    icon: Cursor,
  },
  {
    name: "Canva",
    designation: "Graphic Design Platform",
    description: "Easily create social media posts.",
    logo: "https://cdn.21st.dev/assets/localized/5d2ed8a1814e41e2abad2a07aecc1853d1321ac6008170eb8c34bb0375deca51.jpg",
    icon: Google,
  },
];

const logos = [
  { name: "OpenAI", Icon: OpenAI },
  { name: "Claude", Icon: ClaudeAI },
  { name: "Cursor", Icon: Cursor },
  { name: "GitHub", Icon: Github },
  { name: "Grok", Icon: Grok },
  { name: "Google", Icon: Google },
];

export function HeroSection02() {
  return (
    <div className="design-hero relative isolate">
      <GradientWave className="absolute inset-0 -z-10" />
      <header className="design-nav page-width">
        <a href="#main" className="design-brand" aria-label="Design Code">
          <img
            src="https://cdn.21st.dev/assets/localized/2dc06bac80a527ef88f3ddd18d95f369f883692901dcc7d90bf3b45e07f7c3b7.png"
            alt=""
            width={50}
            height={50}
          />
          <span>
            Design Code<span className="brand-period">.</span>
          </span>
        </a>
        <nav aria-label="Primary">
          <Button asChild>
            <a href="#design-tools">
              Explore Designs <span aria-hidden="true">↗</span>
            </a>
          </Button>
        </nav>
      </header>
      <section className="hero-panel page-width" aria-labelledby="hero-title">
        <p className="hero-kicker">A space for your next great idea</p>
        <div className="hero-line">
          <h1 id="hero-title" tabIndex={-1}>
            Design Code
          </h1>
          <p className="hero-description">
            Discover top-notch design tools and resources that help you craft
            stunning interfaces and graphics. Learn and create with the best in
            the design industry.
          </p>
        </div>
        <div className="hero-line hero-line-tools">
          <ul className="logo-stack" aria-label="Creative technology brands">
            {logos.map(({ name, Icon }) => (
              <li key={name} aria-label={name}>
                <Icon className="brand-icon" aria-hidden="true" />
              </li>
            ))}
          </ul>
          <p className="hero-display">Creative Tools</p>
        </div>
        <div className="hero-line hero-line-action">
          <p className="hero-display hero-underlined">Learn &amp; Create</p>
          <Button asChild className="hero-cta">
            <a href="#design-tools">
              Explore Designs <span aria-hidden="true">↗</span>
            </a>
          </Button>
        </div>
      </section>
      <section
        className="tools-section page-width"
        id="design-tools"
        aria-labelledby="tools-title"
      >
        <div className="section-intro">
          <div>
            <p className="eyebrow">THE CREATIVE TOOLKIT</p>
            <h2 id="tools-title">Good ideas deserve great tools.</h2>
          </div>
          <p>Some of the top design tools used by professionals</p>
        </div>
        <Marquee>
          {technologies.map((tech) => (
            <article key={tech.name} className="tool-card">
              <img
                src={tech.logo}
                alt=""
                width={480}
                height={320}
                loading="lazy"
                className="tool-image"
              />
              <div className="tool-copy">
                <span className="tool-icon" aria-hidden="true">
                  <tech.icon className="h-6 w-6" />
                </span>
                <h3>{tech.name}</h3>
                <p className="tool-designation">{tech.designation}</p>
                <p>{tech.description}</p>
              </div>
            </article>
          ))}
        </Marquee>
      </section>
    </div>
  );
}

export default HeroSection02;
