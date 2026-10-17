import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Keep every card readable without automatic movement or duplicated content.
export function Marquee({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn("tool-collection", className)} />;
}
