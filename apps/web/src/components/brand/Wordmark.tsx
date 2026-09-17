import { cn } from "@homun/ui/lib/utils";

export function Wordmark({ className }: { className?: string }) {
  return (
    <>
      <img
        src="/wordmark-light.svg"
        alt="Homun"
        className={cn("h-6 w-auto dark:hidden", className)}
      />
      <img
        src="/wordmark-dark.svg"
        alt="Homun"
        className={cn("hidden h-6 w-auto dark:block", className)}
      />
    </>
  );
}

export function HomunMark({ className }: { className?: string }) {
  return <img src="/favicon.svg" alt="" aria-hidden className={cn("h-8 w-8 rounded-lg", className)} />;
}
