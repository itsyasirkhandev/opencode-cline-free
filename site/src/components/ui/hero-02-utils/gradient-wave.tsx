import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function GradientWave({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      aria-hidden="true"
      className={cn("gradient-wave", className)}
    />
  );
}
