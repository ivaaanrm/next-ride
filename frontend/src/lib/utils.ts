import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Une clases de Tailwind resolviendo las que se pisan. Lo usa `components/ui`. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
