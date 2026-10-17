import type { ComponentProps } from "react";

const iconPaths = {
  terminal: ["M4 5h16v14H4z", "m7 9 3 3-3 3", "M13 15h4"],
  models: ["m12 3 9 5-9 5-9-5 9-5Z", "m3 12 9 5 9-5", "m3 16 9 5 9-5"],
  accounts: [
    "M9 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
    "M3 21v-4a6 6 0 0 1 12 0v4",
    "M16 4a3 3 0 0 1 0 6",
    "M18 13a5 5 0 0 1 3 5v3",
  ],
  retry: [
    "M20 7a9 9 0 0 0-15-1L2 9",
    "M2 3v6h6",
    "M4 17a9 9 0 0 0 15 1l3-3",
    "M22 21v-6h-6",
  ],
  session: ["M6 3h12v18H6z", "M9 7h6", "M9 11h6", "m9 16 2 2 4-4"],
};

export function PluginIcon({
  name,
  ...props
}: ComponentProps<"svg"> & { name: keyof typeof iconPaths }) {
  return (
    <svg
      {...props}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {iconPaths[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
