import { useCallback, useEffect, useState } from "react";

export function useResponsiveDrawer(
  breakpoint = 1024,
): {
  drawerOpen: boolean;
  expandDrawer: () => void;
  toggleDrawer: () => void;
} {
  const [drawerOpen, setDrawerOpen] = useState(
    () => window.innerWidth > breakpoint,
  );

  useEffect(() => {
    function syncDrawerWithViewport() {
      setDrawerOpen(window.innerWidth > breakpoint);
    }

    syncDrawerWithViewport();
    window.addEventListener("resize", syncDrawerWithViewport);
    return () => window.removeEventListener("resize", syncDrawerWithViewport);
  }, [breakpoint]);

  const expandDrawer = useCallback(() => setDrawerOpen(true), []);
  const toggleDrawer = useCallback(
    () => setDrawerOpen((value) => !value),
    [],
  );

  return { drawerOpen, expandDrawer, toggleDrawer };
}
