import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge delle classi Tailwind (utility cn dei componenti shadcn). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
