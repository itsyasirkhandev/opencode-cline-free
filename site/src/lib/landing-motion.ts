// Marketing-only progressive enhancement. The rendered default is always readable.
export function setupLandingMotion() {
  if (
    !("IntersectionObserver" in window) ||
    typeof Element.prototype.animate !== "function"
  ) {
    return;
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const animations = new Set<Animation>();
  const styles = getComputedStyle(document.documentElement);
  const easeOut = styles.getPropertyValue("--ease-out").trim();
  const easeInOut = styles.getPropertyValue("--ease-in-out").trim();
  let keyboardNavigation = false;

  function cancelMotion() {
    for (const animation of animations) animation.cancel();
    animations.clear();
  }

  function play(
    element: Element,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    const animation = element.animate(frames, options);
    animations.add(animation);
    animation.addEventListener("finish", () => animations.delete(animation), {
      once: true,
    });
  }

  // Keyboard navigation never starts motion, including scroll-triggered entrances.
  document.addEventListener("keydown", () => {
    keyboardNavigation = true;
    cancelMotion();
  });
  document.addEventListener("pointerdown", () => {
    keyboardNavigation = false;
  });
  document.addEventListener(
    "wheel",
    () => {
      keyboardNavigation = false;
    },
    { passive: true },
  );
  reducedMotion.addEventListener("change", cancelMotion);

  const observer = new IntersectionObserver(
    (entries) => {
      let stagger = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const element = entry.target;
        if (
          keyboardNavigation ||
          document.visibilityState === "hidden" ||
          element.contains(document.activeElement)
        ) {
          continue;
        }

        // Reduced motion keeps a brief opacity cue, with no displacement or stagger.
        if (reducedMotion.matches) {
          play(element, [{ opacity: 0.9 }, { opacity: 1 }], {
            duration: 150,
            easing: "ease",
          });
          continue;
        }

        const delay = Math.min(stagger++, 4) * 50;
        const kind = element.getAttribute("data-reveal");
        if (kind === "illustration") {
          play(
            element,
            [{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0 0)" }],
            { duration: 600, easing: easeInOut, delay },
          );
        } else if (kind === "connection") {
          for (const [index, node] of Array.from(element.children).entries()) {
            play(
              node,
              [
                { opacity: 0.9, transform: "scale(0.97)" },
                { opacity: 1, transform: "scale(1)" },
              ],
              { duration: 300, easing: easeOut, delay: index * 50 },
            );
          }
        } else {
          play(
            element,
            [
              {
                opacity: 0.9,
                transform: kind === "rise" ? "translateY(8px)" : "none",
              },
              { opacity: 1, transform: "none" },
            ],
            { duration: 300, easing: easeOut, delay },
          );
        }
      }
    },
    { threshold: 0.15 },
  );

  for (const element of document.querySelectorAll("[data-reveal]")) {
    observer.observe(element);
  }
}
